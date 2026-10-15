import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contentHash, createOperationContext, imageIdentity, ImmutableBytes } from '../../../src/core/index.js';
import { MachOLoader } from '../../../src/loaders/macho/index.js';
import { Arm64Decoder } from '../../../src/decoders/arm64/index.js';

const bytes = readFileSync('fixtures/bin/macho-arm64-symbols');
const sha256 = contentHash(bytes);
const context = createOperationContext();
const image = new MachOLoader().load({ image_id: imageIdentity(sha256), sha256, bytes: new ImmutableBytes(bytes), slice_id: null }, context);
const decoder = new Arm64Decoder();
try {
  const result = decoder.decode({ image, mode: 'a64', features: ['FEAT_FP', 'FEAT_AdvSIMD'], regions: [{ start: { image_id: image.id, space: 'va', value: 0x100000574n }, size: 20n }] }, context);
  assert.equal(result.coverage.state, 'complete');
  assert.equal(result.instructions.length, 5);
  assert.equal(result.gaps.length, 0);
  const logical = result.instructions[3]!.payload;
  assert.ok(logical?.architecture === 'arm64');
  assert.equal(logical.canonical_encoding, 'EOR_32_log_shift');
  assert.equal(logical.fields.Rn, 8n); assert.equal(logical.fields.Rm, 9n);
  assert.equal(result.instructions[4]!.flow.kind, 'return');
  console.log(JSON.stringify({ decoder: decoder.name, version: decoder.version, instructions: result.instructions.length, logical: logical.canonical_encoding, byteOffset: result.instructions[0]!.bytes.start.value.toString(16) }));
} finally { decoder.dispose(); }
