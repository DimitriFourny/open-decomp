import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { contentHash, createOperationContext, imageIdentity, ImmutableBytes } from '../../../src/core/index.js';
import { MachOLoader } from '../../../src/loaders/macho/index.js';
import { Arm64Decoder } from '../../../src/decoders/arm64/index.js';

for (const subtype of [0, 2]) test(`loader target profile preserves pointer authentication for ARM64 subtype ${subtype}`, () => {
  const raw = readFileSync(new URL('../../../fixtures/bin/macho-arm64-symbols', import.meta.url));
  raw.writeUInt32LE(subtype, 8);
  raw.writeUInt32LE(0xd503233f, 1396); // PACIASP at the fixture arithmetic entry.
  const sha256 = contentHash(raw);
  const image = new MachOLoader().load({ image_id: imageIdentity(sha256), sha256, bytes: new ImmutableBytes(raw), slice_id: null }, createOperationContext());
  const decoder = new Arm64Decoder();
  try {
    const result = decoder.decode({ image, mode: 'a64', features: image.target.features, regions: [{ start: { image_id: image.id, space: 'va', value: 0x100000574n }, size: 4n }] }, createOperationContext());
    assert.equal(result.instructions[0]?.validity, subtype === 2 ? 'valid' : 'feature_disabled');
    const payload = result.instructions[0]?.payload;
    assert.ok(payload?.architecture === 'arm64');
    assert.equal(payload.behavior, subtype === 2 ? 'instruction' : 'nop');
  } finally { decoder.dispose(); }
});
