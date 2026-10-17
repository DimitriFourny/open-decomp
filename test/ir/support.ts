import assert from 'node:assert/strict';
import { entityIdentity, imageIdentity, sliceIdentity } from '../../src/core/index.js';
import type { RegisterDescriptor } from '../../src/core/index.js';
import { IRBuilder, syntheticProvenance } from '../../src/ir/index.js';
import type { EvaluationResult } from '../../src/ir/index.js';

export const image = imageIdentity('a'.repeat(64));
export const slice = sliceIdentity(image, 0n, 4096n, 'x86_64');
export const provenance = syntheticProvenance(
  'Trusted semantic fixture constructed independently of decoding',
);
export function builder(name: string): IRBuilder {
  return new IRBuilder(slice, entityIdentity(slice, 'function', name), provenance);
}
export function returned(result: EvaluationResult): bigint[] {
  assert.equal(result.status, 'returned', result.reason ?? 'Expected normal return');
  return result.values.map((value) => {
    assert.equal(value.kind, 'bits');
    if (value.kind !== 'bits') throw new TypeError('Unknown result');
    return value.bits;
  });
}
export function register(
  id: string,
  width: number,
  offset = 0,
  rule: RegisterDescriptor['write_rule'] = 'preserve_other_bits',
  root = 'x86_64:rax',
  rootWidth = 64,
): RegisterDescriptor {
  return {
    id,
    bank: 'integer',
    root,
    offset_bits: offset,
    width_bits: width,
    root_width_bits: rootWidth,
    role: 'general',
    write_rule: rule,
  };
}
