import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contentHash, fingerprint } from '../../src/core/index.js';
import type { Address, Evidence, LoadedImage } from '../../src/core/index.js';
import { loadBytes } from '../metadata/fixture.js';

/** Trusted source oracle: unsigned selected(void) { return 42; }
 * Unrelated source bodies each return zero. Derive their exact ARM64 words in
 * verified zero padding of the checked-in source-built Mach-O; retain the real
 * header/load commands/debug input. Explicit analysis evidence owns the added
 * roots, rather than pretending the original loader published those functions. */
export function sourceBuiltSelectedImage(unrelated: number): {
  readonly image: LoadedImage;
  readonly entry: Address;
} {
  const original = readFileSync(new URL('../../fixtures/bin/macho-arm64-symbols', import.meta.url));
  const manifest = JSON.parse(
    readFileSync(new URL('../../fixtures/manifest.json', import.meta.url), 'utf8'),
  ) as {
    images: { path: string; sha256: string }[];
  };
  const parent = manifest.images.find((image) => image.path === 'fixtures/bin/macho-arm64-symbols');
  assert.ok(parent);
  assert.equal(
    contentHash(original),
    parent.sha256,
    'Fixture must match its reviewed source/build manifest',
  );
  const offset = 0x3000,
    size = (unrelated + 1) * 8;
  assert.ok(
    original.subarray(offset, offset + size).every((byte) => byte === 0),
    'Derivation may only replace verified unused zero padding',
  );
  const bytes = Buffer.from(original);
  for (let index = 0; index <= unrelated; index++) {
    bytes.writeUInt32LE(index === unrelated ? 0x52800540 : 0x52800000, offset + index * 8);
    bytes.writeUInt32LE(0xd65f03c0, offset + index * 8 + 4);
  }
  const loaded = loadBytes(bytes);
  const start = loaded.address_map.translate(
    { image_id: loaded.id, space: 'file', value: BigInt(offset) },
    'va',
  );
  assert.equal(start.kind, 'mapped');
  assert.ok(
    loaded.mappings.some(
      (mapping) =>
        mapping.permissions.includes('execute') &&
        start.address.value >= mapping.va &&
        start.address.value + BigInt(size) <= mapping.va + mapping.file_size,
    ),
  );
  const proof: Evidence = {
    id: `evidence_${fingerprint([loaded.selected_slice_id, 'selected-work-test/1', parent.sha256, offset, size])}`,
    origin: {
      kind: 'analysis',
      analyzer: 'open-decomp/test-selected-work-fixture',
      version: '1',
      rule: 'source-built Mach-O zero-padding derivation',
    },
    claim: `Derived from reviewed source-built Mach-O SHA-256 ${parent.sha256}: file bytes 0x${offset.toString(16)}..0x${(offset + size).toString(16)} contain ${unrelated} independent mov-w0-zero/ret bodies and one mov-w0-42/ret source-oracle body`,
    derived_from: [],
    conflicts_with: [],
    revision: 0,
  };
  const roots = Array.from({ length: unrelated + 1 }, (_, index) => ({
    kind: 'function' as const,
    address: { ...start.address, value: start.address.value + BigInt(index * 8) },
    size: null,
    evidence_ids: [proof.id],
  }));
  return {
    image: { ...loaded, hints: [...loaded.hints, ...roots], evidence: [...loaded.evidence, proof] },
    entry: roots[unrelated]!.address,
  };
}
