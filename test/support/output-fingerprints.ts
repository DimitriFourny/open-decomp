import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expandEmission, openBinary } from '../../src/api/index.js';
import { pipelineVersions } from '../../src/service/analysis/versions.js';

/** Recorded fingerprints; regenerate with `bun run fingerprints`. */
export const FINGERPRINT_FILE = resolve('test/service/fixtures/output-fingerprints.json');

export const FINGERPRINT_DIALECTS = ['c-like', 'python-like'] as const;
export const FINGERPRINT_FIXTURES = [
  {
    file: 'macho-arm64-symbols',
    functions: ['fixture_arithmetic', 'fixture_loop', 'fixture_direct', 'fixture_float'],
  },
  {
    file: 'corpus-symbols.dll',
    functions: ['fixture_arithmetic', 'fixture_loop', 'fixture_direct', 'fixture_float'],
  },
  {
    file: 'elf-x86_64-symbols',
    functions: ['fixture_arithmetic', 'fixture_loop', 'fixture_direct', 'fixture_float'],
  },
] as const;

export interface FingerprintRecord {
  /** Canonical JSON of the cache-identity versions (loader, decoder, lifter, analysis, ABI, emitter). */
  readonly identity: string;
  /** Function name -> `state:sha256` of the canonical expanded emission. */
  readonly functions: Readonly<Record<string, string>>;
}
export interface Fingerprints {
  readonly schema: 1;
  /** Keyed by `fixture|dialect`. */
  readonly records: Readonly<Record<string, FingerprintRecord>>;
}

/**
 * Canonical JSON: sorted keys, hex bigints. Proof identities and the type-evidence scope of
 * call contexts are derived from per-project state, so they differ between otherwise identical
 * runs; they are replaced by their first-appearance index, which still pins the evidence graph shape.
 */
function canonicalJson(value: unknown): string {
  const proofs = new Map<string, number>();
  return JSON.stringify(value, (key, item: unknown) => {
    if (typeof item === 'bigint') return `0x${item.toString(16)}`;
    if (typeof item === 'string') {
      if (key === 'type_evidence_scope') return '<type-evidence-scope>';
      if (/^evidence_[0-9a-f]{64}$/.test(item)) {
        if (!proofs.has(item)) proofs.set(item, proofs.size);
        return `<evidence ${proofs.get(item)}>`;
      }
      return item;
    }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).sort(([x], [y]) =>
        x < y ? -1 : x > y ? 1 : 0,
      ),
    );
  });
}

/** Decompile the fixed fixture/function/dialect set through the public API and fingerprint it. */
export async function computeFingerprints(): Promise<Fingerprints> {
  const records: Record<string, FingerprintRecord> = {};
  const root = await mkdtemp(join(tmpdir(), 'open-decomp-fingerprints-'));
  try {
    for (const fixture of FINGERPRINT_FIXTURES) {
      const session = await openBinary(resolve('fixtures/bin', fixture.file), {
        cachePath: join(root, fixture.file),
      });
      try {
        for (const emitter of FINGERPRINT_DIALECTS) {
          const functions: Record<string, string> = {};
          for (const name of fixture.functions) {
            const result = await session.decompile({ name }, { emitter });
            if (!('data' in result) || result.data.delivery !== 'inline')
              throw new Error(
                `${fixture.file} ${name} ${emitter}: no inline emission (${result.state})`,
              );
            const hash = createHash('sha256')
              .update(canonicalJson(expandEmission(result.data.emission)))
              .digest('hex');
            functions[name] = `${result.state}:${hash}`;
          }
          records[`${fixture.file}|${emitter}`] = {
            identity: canonicalJson(pipelineVersions(session.image.target, emitter)),
            functions,
          };
        }
      } finally {
        await session.close();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return { schema: 1, records };
}
