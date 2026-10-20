/**
 * Precision harness for the `likely` inference mode (TODO.md R5).
 *
 * Each heuristic that closes an open argument list records a `guess` inference. This script
 * decompiles functions of binaries whose sources we hold, in `likely` mode, joins every `guess`
 * record with source-derived ground truth (a DWARF dump of the compiler's own output for the
 * same sources, never of the analyzed binary), and reports precision and coverage per
 * heuristic. A heuristic prints in `likely` mode only if it passes the gate (`LIKELY_GATE` in
 * `src/service/analysis/likely-arity.ts`); this script decides that from measurement.
 *
 *   node --import tsx scripts/bench/likely-precision.ts --label NAME [--only ID,ID] [--sample N]
 *     [--out DIR] [--work DIR]
 *
 * Targets: `matrix` (the dev-loop matrix, symbol-bearing cells, scripts/bench/quality-matrix-corpus.c),
 * `fixtures` (Mach-O fixture executables, fixtures/source), `sqlite` (SQLite 3.54.0 executable
 * of the LLM-task benchmark and its amalgamation) and `brotli` (Homebrew brotli 1.2.0 CLI and
 * its tools/brotli.c). Targets whose inputs are absent are reported as skipped. Needs a built
 * `dist/` or tsx (it imports the API from source), clang and `dwarfdump` (macOS).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { expandEmission, openBinary } from '../../src/api/index.js';
import type { BinarySession } from '../../src/api/index.js';
import {
  DwarfReader,
  HEURISTICS,
  cName,
  gate,
  guessableSites,
  scoreArity,
  tally,
} from './likely-precision-score.js';
import type {
  CallRow,
  GuessRow,
  Heuristic,
  Tally,
  Truth,
  Verdict,
} from './likely-precision-score.js';

const ROOT = resolve(import.meta.dirname, '../..');
const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

interface Source {
  readonly file: string;
  readonly includes?: readonly string[];
}
interface Target {
  readonly id: string;
  readonly binaries: readonly { readonly id: string; readonly path: string }[];
  readonly sources: readonly Source[];
  /** Decompile at most this many functions of each binary (deterministic by name hash). */
  readonly sample: number;
  /** Prepares sources that are not in the repository (pinned downloads); may throw. */
  readonly prepare?: (work: string) => Promise<void>;
}

const BROTLI_TAG = 'https://raw.githubusercontent.com/google/brotli/v1.2.0/c';
const BROTLI_FILES: Readonly<Record<string, string>> = {
  'tools/brotli.c': 'cb6c8ca6668d324d50cd085fc3ddb3f202afe34fb562b5b583c0d7b0cceccd0c',
  'common/constants.h': 'c9c898542360e811dc44aa9be270d21ce0d18f3ecf45310f3d9f285f3692a59e',
  'common/platform.h': '63d47925374e1015e35eaac73d9d9dfc79b7f0585fe73c19d1ccde7a36aaa407',
  'common/version.h': '792d03d8feff8168edf639899f72b71a37e9cbd9f178e3be397ccef29d3346b0',
};
const SQLITE_SOURCE = '.local/quality-coordinator-reviewed/reference/sqlite3.c';
const SQLITE_SHA256 = '2da161e310ef0aba3465f22a4d12b8a43723236f0942fa76e8aac523c3317243';
const SQLITE_BINARY = '.local/quality-coordinator-reviewed/inputs/sqlite3-arm64';
const BROTLI_BINARY = '/opt/homebrew/bin/brotli';
const MATRIX = '.local/performance/quality-matrix-reviewed';

async function matrixBinaries(): Promise<Target['binaries']> {
  const manifest = JSON.parse(await readFile(join(ROOT, MATRIX, 'build-manifest.json'), 'utf8')) as {
    root: string;
    cells: { id: string; input: { path: string } }[];
  };
  // Symbol-bearing cells only: stripped cells have no names to join with the truth, and the
  // matrix builds carry no debug info, so no signature is ever proven from DWARF.
  return manifest.cells
    .filter((cell) => cell.id.endsWith('symbol-bearing'))
    .map((cell) => ({
      id: cell.id,
      path: join(ROOT, MATRIX, relative(manifest.root, cell.input.path)),
    }));
}

async function targets(): Promise<readonly Target[]> {
  return [
    {
      id: 'matrix',
      binaries: await matrixBinaries().catch(() => []),
      sources: [{ file: 'scripts/bench/quality-matrix-corpus.c' }],
      sample: 100,
    },
    {
      id: 'fixtures',
      binaries: [
        { id: 'macho-arm64-symbols', path: join(ROOT, 'fixtures/bin/macho-arm64-symbols') },
        {
          id: 'libcorpus-arm64-symbols',
          path: join(ROOT, 'fixtures/bin/libcorpus-arm64-symbols.dylib'),
        },
      ],
      sources: [
        { file: 'fixtures/source/corpus.c', includes: ['fixtures/source'] },
        { file: 'fixtures/source/check.c', includes: ['fixtures/source'] },
      ],
      sample: 100,
    },
    {
      id: 'sqlite',
      binaries: [{ id: 'sqlite3-arm64', path: join(ROOT, SQLITE_BINARY) }],
      sources: [{ file: SQLITE_SOURCE }],
      sample: 250,
    },
    {
      id: 'brotli',
      binaries: [{ id: 'brotli', path: BROTLI_BINARY }],
      sources: [
        {
          file: '<work>/brotli/tools/brotli.c',
          includes: ['/opt/homebrew/include'],
        },
      ],
      sample: 80,
      prepare: async (work) => {
        for (const [path, digest] of Object.entries(BROTLI_FILES)) {
          const target = join(work, 'brotli', path);
          if (existsSync(target) && sha256(await readFile(target)) === digest) continue;
          const response = await fetch(`${BROTLI_TAG}/${path}`);
          if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (sha256(bytes) !== digest) throw new Error(`${path}: SHA-256 differs from the pin`);
          await mkdir(join(target, '..'), { recursive: true });
          await writeFile(target, bytes);
        }
      },
    },
  ];
}

/** Compile each source with the host clang (-O1 -g: called externals get declarations too)
 * and merge the DWARF truth. Cached by source hash. */
async function groundTruth(target: Target, work: string): Promise<Truth> {
  const files = target.sources.map((source) => ({
    ...source,
    path: resolve(source.file.replace('<work>', work).replace(/^(?!\/)/, `${ROOT}/`)),
  }));
  const key = sha256(
    JSON.stringify(
      await Promise.all(files.map(async (f) => [f.path, sha256(await readFile(f.path))])),
    ),
  );
  const cache = join(work, 'truth', `${target.id}-${key.slice(0, 16)}.json`);
  if (existsSync(cache)) return JSON.parse(await readFile(cache, 'utf8')) as Truth;
  const merged: Record<string, Truth[string]> = {};
  const scratch = join(work, 'tmp');
  await mkdir(scratch, { recursive: true });
  for (const file of files) {
    const object = join(scratch, `${target.id}-${basename(file.path)}.o`);
    const include = (file.includes ?? []).map((dir) =>
      dir.startsWith('/') ? `-I${dir}` : `-I${join(ROOT, dir)}`,
    );
    const compiled = spawnSync(
      'clang',
      [
        '-g',
        '-O1',
        '-gdwarf-5',
        '-w',
        '-c',
        ...include,
        file.path,
        '-o',
        object,
      ],
      { encoding: 'utf8', maxBuffer: 1 << 28 },
    );
    if (compiled.status !== 0)
      throw new Error(`clang failed on ${file.path}: ${compiled.stderr.slice(0, 2000)}`);
    // The dump of SQLite is far larger than a string can be: read it line by line.
    const dump = spawn('dwarfdump', ['--debug-info', object], { stdio: ['ignore', 'pipe', 'inherit'] });
    const reader = new DwarfReader();
    const exited = new Promise<number | null>((done) => dump.on('close', done));
    for await (const line of createInterface({ input: dump.stdout })) reader.feed(line);
    if ((await exited) !== 0) throw new Error(`dwarfdump failed on ${object}`);
    for (const [name, fact] of Object.entries(reader.truth())) merged[name] ??= fact;
  }
  await mkdir(join(work, 'truth'), { recursive: true });
  await writeFile(cache, JSON.stringify(merged));
  return merged;
}

interface FunctionRow {
  readonly id: string;
  readonly address: string;
  readonly name: string | null;
  readonly import_stub: boolean;
}

async function listFunctions(session: BinarySession): Promise<FunctionRow[]> {
  const rows: FunctionRow[] = [];
  let cursor: string | undefined;
  do {
    const result = await session.findFunctions({
      page: { limit: 1000, ...(cursor ? { cursor } : {}) },
    });
    if (!('data' in result) || result.data === undefined) throw new Error('functions_find failed');
    for (const item of result.data.items)
      rows.push({
        id: item.id,
        address: BigInt(item.entry.value).toString(),
        name: item.display_name ?? item.original_name ?? null,
        import_stub: item.kind === 'import_stub',
      });
    cursor = result.data.page.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return rows;
}

interface BinaryReport {
  readonly id: string;
  readonly functions: number;
  readonly decompiled: number;
  readonly failed: number;
  readonly calls: number;
  readonly open_known: number;
  readonly tallies: Record<Heuristic | 'any', Tally>;
  readonly guessed_sites: number;
  readonly applied_sites: number;
  readonly rows: readonly (GuessRow & Verdict)[];
}

async function runBinary(
  target: Target,
  binary: Target['binaries'][number],
  truth: Truth,
  work: string,
  sample: number,
): Promise<BinaryReport | { readonly id: string; readonly skipped: string }> {
  if (!existsSync(binary.path)) return { id: binary.id, skipped: `${binary.path} is absent` };
  const session = await openBinary(binary.path, {
    cachePath: join(work, 'cache', `${target.id}-${binary.id}`),
  });
  try {
    const functions = await listFunctions(session);
    const names = new Map(functions.map((fn) => [fn.address, fn.name === null ? null : cName(fn.name)]));
    // Callers: defined functions of the sources, in a deterministic order.
    const candidates = functions
      .filter((fn) => !fn.import_stub && fn.name !== null && truth[cName(fn.name)] !== undefined)
      .sort((a, b) => sha256(a.name!).localeCompare(sha256(b.name!)))
      .slice(0, sample);
    const guesses: GuessRow[] = [];
    const calls: CallRow[] = [];
    let decompiled = 0,
      failed = 0;
    for (const fn of candidates) {
      const result = await session.decompileFunction(fn.id, { inference: 'likely' });
      if (!('data' in result) || result.data.delivery !== 'inline') {
        failed++;
        continue;
      }
      decompiled++;
      const caller = cName(fn.name!);
      for (const inference of expandEmission(result.data.emission).inferences ?? []) {
        const details = inference.details;
        if (details.kind === 'call') {
          const address =
            details.target.kind === 'direct' ? details.target.identity.address : null;
          calls.push({
            caller,
            call_id: details.call_id,
            target_address: address,
            target_name: address === null ? null : (names.get(address) ?? null),
            arity_complete: details.arity_complete,
          });
        } else if (details.kind === 'guess' && details.target.kind === 'direct') {
          const address = details.target.identity.address;
          guesses.push({
            caller,
            call_id: details.call_id,
            target_address: address,
            target_name: names.get(address) ?? null,
            heuristics: details.heuristics,
            applied: details.applied,
            arity: details.arity,
            sites: details.sites,
          });
        }
      }
    }
    const tallies = tally(guesses, truth);
    return {
      id: binary.id,
      functions: functions.length,
      decompiled,
      failed,
      calls: calls.length,
      open_known: guessableSites(calls, truth),
      tallies,
      guessed_sites: guesses.length,
      applied_sites: guesses.filter((guess) => guess.applied).length,
      rows: guesses.map((guess) => ({ ...guess, ...scoreArity(guess, truth) })),
    };
  } finally {
    await session.close();
  }
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const pct = (value: number | null): string => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);

async function main(): Promise<void> {
  const label = flag('--label');
  if (!label) throw new Error('--label is required');
  const only = flag('--only')?.split(',');
  const work = resolve(flag('--work') ?? join(ROOT, '.local/r5-likely'));
  const out = resolve(flag('--out') ?? join(work, 'runs', label));
  const sampleOverride = flag('--sample');
  await mkdir(out, { recursive: true });
  const reports: Record<string, unknown> = {};
  // Pool of every scored guess, for the pooled gate decision.
  const pooled: { guesses: GuessRow[]; truth: Truth[] } = { guesses: [], truth: [] };
  const merged: Record<string, Truth[string]> = {};
  const markdown: string[] = [`# Likely-mode precision (${label})`, ''];
  for (const target of await targets()) {
    if (only && !only.includes(target.id)) continue;
    try {
      await target.prepare?.(work);
      const truth = await groundTruth(target, work);
      Object.assign(merged, Object.fromEntries(Object.entries(truth).map(([k, v]) => [`${target.id}:${k}`, v])));
      const perBinary = [];
      for (const binary of target.binaries) {
        const report = await runBinary(
          target,
          binary,
          truth,
          work,
          sampleOverride ? Number(sampleOverride) : target.sample,
        );
        perBinary.push(report);
        if ('skipped' in report) {
          markdown.push(`- ${target.id}/${report.id}: skipped (${report.skipped})`);
          continue;
        }
        for (const row of report.rows)
          pooled.guesses.push({
            ...row,
            target_name: row.target_name === null ? null : `${target.id}:${row.target_name}`,
          });
        const line = (name: Heuristic | 'any'): string => {
          const t = report.tallies[name];
          return `${name}: ${t.correct}/${t.sites} sites (${pct(t.precision_sites)}), ${t.callees_correct}/${t.callees} callees (${pct(t.precision_callees)}), over ${t.over} under ${t.under} variadic ${t.variadic} unscored ${t.unscored}`;
        };
        markdown.push(
          `## ${target.id}/${report.id}`,
          `${report.decompiled}/${report.decompiled + report.failed} sampled functions decompiled; ${report.calls} call records; ${report.open_known} open direct sites with a scorable source arity; ${report.guessed_sites} guesses (${report.applied_sites} applied)`,
          ...[...HEURISTICS, 'any' as const].map((name) => `- ${line(name)}`),
          '',
        );
      }
      reports[target.id] = perBinary;
    } catch (error) {
      reports[target.id] = { error: String(error) };
      markdown.push(`- ${target.id}: failed (${String(error)})`);
    }
  }
  // Pooled gate: guesses of all targets against the union of their truths, keyed per target
  // so equal names in different programs never alias.
  const pooledTruth: Truth = merged;
  const pooledTallies = tally(pooled.guesses, pooledTruth);
  markdown.push('## Pooled gate', '');
  for (const verdict of gate(pooledTallies))
    markdown.push(
      `- ${verdict.heuristic}: ${verdict.sites} scored sites, precision ${pct(verdict.precision_sites)} (sites) / ${pct(verdict.precision_callees)} (callees): ${verdict.passes ? 'PASSES' : 'FAILS'} the 95% gate`,
    );
  await writeFile(
    join(out, 'report.json'),
    JSON.stringify({ label, reports, pooled: pooledTallies, gate: gate(pooledTallies) }, null, 1),
  );
  await writeFile(join(out, 'report.md'), `${markdown.join('\n')}\n`);
  process.stdout.write(`${markdown.join('\n')}\nreport: ${out}\n`);
}

await main();
