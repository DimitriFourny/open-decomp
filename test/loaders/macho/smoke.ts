import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  contentHash,
  createOperationContext,
  imageIdentity,
  ImmutableBytes,
  type Loader,
} from '../../../src/core/index.js';
import { MachOLoader } from '../../../src/loaders/macho/index.js';

// Run from the repository root: node --import tsx test/loaders/macho/smoke.ts
// This reads trusted fixture bytes; it never starts a target process.
const loader: Loader = new MachOLoader();
for (const path of [
  'macho-arm64-symbols',
  'macho-arm64-stripped',
  'libcorpus-arm64-symbols.dylib',
  'libcorpus-arm64-stripped.dylib',
  'macho-universal',
]) {
  const input = readFileSync(new URL(`../../../fixtures/bin/${path}`, import.meta.url));
  const sha256 = contentHash(input),
    image_id = imageIdentity(sha256),
    bytes = new ImmutableBytes(input);
  const inspection = loader.inspect(bytes, image_id, createOperationContext());
  const selected = inspection.slices.find((slice) => slice.supported);
  assert.ok(selected);
  const loaded = loader.load(
    { image_id, sha256, bytes, slice_id: selected.id },
    createOperationContext(),
  );
  assert.ok(loaded.hints.some((record) => record.kind === 'unwind'));
  assert.ok(loaded.relocations.some((record) => record.kind === 'chained_fixup'));
  if (!path.endsWith('.dylib')) {
    assert.ok(loaded.imports.some((record) => record.original_name === '_puts'));
    assert.equal(loaded.entry_points[0]?.value, 0x100000a8cn);
    assert.equal(
      loaded.address_map.translate({ image_id, space: 'va', value: 0x100000574n }, 'file').address
        .value,
      selected.offset + 1396n,
    );
    assert.equal(
      loaded.address_map.translate({ image_id, space: 'va', value: 0x100008008n }, 'file').kind,
      'zero_fill',
    );
  }
  console.log(
    JSON.stringify({
      path,
      slice: selected.id,
      container_offset: `0x${selected.offset.toString(16)}`,
      image_base: `0x${loaded.image_base.toString(16)}`,
      entries: loaded.entry_points.map((entry) => `0x${entry.value.toString(16)}`),
      symbols: loaded.symbols.length,
      imports: loaded.imports.length,
      exports: loaded.exports.length,
      relocations: loaded.relocations.length,
      hints: loaded.hints.length,
      diagnostics: loaded.diagnostics.map((diagnostic) => diagnostic.message),
    }),
  );
}
