// SPDX-License-Identifier: MIT
// Run from the repository root: node --import tsx test/loaders/pe/smoke.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ImmutableBytes, contentHash, createOperationContext, imageIdentity } from '../../../src/core/index.js';
import { peLoader } from '../../../src/loaders/pe/index.js';

for (const name of ['corpus-symbols.dll', 'pe-x86_64-symbols.exe']) {
  const raw = readFileSync(new URL(`../../../fixtures/bin/${name}`, import.meta.url));
  const sha256 = contentHash(raw);
  const image = peLoader.load({ image_id: imageIdentity(sha256), sha256, bytes: new ImmutableBytes(raw), slice_id: null }, createOperationContext());
  assert.ok(image.hints.some(h => h.kind === 'unwind'));
  if (name.endsWith('.dll')) {
    assert.equal(image.exports.find(e => e.original_name === 'fixture_stack')?.address?.value, 0x180001000n);
    assert.equal(image.address_map.translate({ image_id: image.id, space: 'rva', value: 0x3200n }, 'file').kind, 'zero_fill');
    assert.ok(image.relocations.some(r => r.address.value === 0x180003000n));
  } else {
    assert.equal(image.entry_points[0]?.value, 0x140001000n);
    assert.ok(image.imports.some(i => i.original_name === 'ExitProcess'));
  }
  console.log(JSON.stringify({ image: name, image_base: `0x${image.image_base.toString(16)}`, sections: image.sections.length, imports: image.imports.length, exports: image.exports.length, relocations: image.relocations.length, unwind: image.hints.filter(h => h.kind === 'unwind').length, diagnostics: image.diagnostics.map(d => d.message) }));
}
