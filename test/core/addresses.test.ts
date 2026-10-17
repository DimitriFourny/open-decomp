import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  AddressMap,
  ImmutableBytes,
  checkedEnd,
  checkedIndex,
  encodeAddress,
  decodeAddress,
  encodeRange,
  decodeRange,
  encodeSigned,
  decodeSigned,
  type MappingContext,
  type Address,
} from '../../src/core/addresses.js';
import { addressSchema, rangeSchema } from '../../src/core/primitives.js';
import { addressCodec, hexU64Codec } from '../../src/core/codecs.js';

const image = `image_${'a'.repeat(64)}`;
const base = 0x20000000000001n;
const context: MappingContext = {
  image_id: image,
  image_base: base,
  byte_length: 0x1000n,
  slice_offset: 0x100n,
  slice_size: 0x800n,
  mappings: [
    {
      id: 'text',
      va: base + 0x1000n,
      memory_size: 0x30n,
      file_offset: 0x200n,
      file_size: 0x20n,
      permissions: ['read', 'execute'],
    },
  ],
};
const va: Address = { image_id: image, space: 'va', value: base + 0x1003n };

test('address codecs preserve full width and distinguish all three spaces', () => {
  for (const space of ['va', 'rva', 'file'] as const) {
    const wire = addressSchema.parse({ image_id: image, space, value: '0xffffffffffffffff' });
    assert.equal(decodeAddress(wire).value, (1n << 64n) - 1n);
    assert.deepEqual(encodeAddress(decodeAddress(wire)), wire);
    assert.equal(z.decode(addressCodec, wire).space, space);
  }
  assert.equal(z.decode(hexU64Codec, '0x20000000000001'), base);
  assert.equal(z.encode(hexU64Codec, base), '0x20000000000001');
  const range = { start: va, size: 0x10n };
  assert.deepEqual(decodeRange(encodeRange(range)), range);
  assert.deepEqual(decodeSigned(encodeSigned(-0xffffffffffffffffn)), -0xffffffffffffffffn);
  assert.throws(() => decodeSigned({ negative: true, magnitude: '0x0' }));
});

test('wire addresses reject numbers, malformed hex, foreign spaces and overflowing ranges', () => {
  for (const value of [
    1,
    9007199254740992,
    '-0x1',
    '42',
    '0x',
    '0x10000000000000000',
    '0x1z',
    ' 0x1',
  ]) {
    assert.equal(addressSchema.safeParse({ image_id: image, space: 'va', value }).success, false);
  }
  assert.equal(
    addressSchema.safeParse({ image_id: image, space: 'runtime', value: '0x1' }).success,
    false,
  );
  assert.equal(
    rangeSchema.safeParse({ start: { image_id: image, space: 'va', value: 'bad' }, size: 'bad' })
      .success,
    false,
  );
  assert.equal(
    rangeSchema.safeParse({
      start: { image_id: image, space: 'va', value: '0xffffffffffffffff' },
      size: '0x2',
    }).success,
    false,
  );
  assert.equal(checkedEnd((1n << 64n) - 1n, 1n), 1n << 64n);
  assert.throws(() => checkedEnd((1n << 64n) - 1n, 2n));
  assert.throws(() => checkedIndex(9007199254740993n, 1024));
  assert.throws(() => checkedIndex(1 as never, 1024));
});

test('VA/RVA/container-file translations retain slice offsets and never round through Number', () => {
  const map = new AddressMap(context);
  assert.deepEqual(map.translate(va, 'file'), {
    kind: 'mapped',
    address: { image_id: image, space: 'file', value: 0x203n },
    mapping_id: 'text',
  });
  assert.deepEqual(map.translate(va, 'rva'), {
    kind: 'mapped',
    address: { image_id: image, space: 'rva', value: 0x1003n },
    mapping_id: 'text',
  });
  assert.deepEqual(map.translate({ image_id: image, space: 'file', value: 0x203n }, 'va'), {
    kind: 'mapped',
    address: va,
    mapping_id: 'text',
  });
  assert.deepEqual(map.translate({ image_id: image, space: 'rva', value: 0x1003n }, 'va'), {
    kind: 'mapped',
    address: va,
    mapping_id: 'text',
  });
  assert.equal(map.translate({ ...va, value: base + 0x1020n }, 'file').kind, 'zero_fill');
  assert.equal(map.translate({ ...va, value: base + 0x1030n }, 'file').kind, 'unmapped');
  assert.equal(map.translate({ ...va, space: 'file', value: 0x900n }, 'file').kind, 'unmapped');
  assert.throws(() => map.translate({ ...va, image_id: `image_${'b'.repeat(64)}` }, 'file'));
  assert.throws(() => map.translate({ ...va, space: 'rva', value: (1n << 64n) - 1n }, 'va'));
  const belowBase = new AddressMap({ ...context, mappings: [{ ...context.mappings[0]!, va: 0n }] });
  assert.throws(() => belowBase.translate({ ...va, value: 1n }, 'rva'));
});

test('range partition distinguishes real bytes, virtual zeros and holes', () => {
  const map = new AddressMap(context);
  const spans = map.spans({ ...va, value: base + 0x101cn }, 0x18n);
  assert.deepEqual(
    spans.map((span) => [span.kind, span.range.size, span.file_offset]),
    [
      ['mapped', 4n, 0x21cn],
      ['zero_fill', 0x10n, null],
      ['unmapped', 4n, null],
    ],
  );
  assert.deepEqual(
    map
      .spans({ ...va, space: 'file', value: 0xfen }, 4n)
      .map((span) => [span.kind, span.range.size]),
    [
      ['unmapped', 2n],
      ['mapped', 2n],
    ],
  );
  assert.deepEqual(map.spans(va, 0n), []);
  assert.throws(() => map.spans({ ...va, value: (1n << 64n) - 1n }, 2n));
});

test('invalid and ambiguous mappings are rejected before translation', () => {
  const mapping = context.mappings[0]!;
  for (const mappings of [
    [mapping, { ...mapping, id: 'overlap', file_offset: 0x300n }],
    [mapping, { ...mapping, id: 'file-alias', va: base + 0x2000n }],
    [{ ...mapping, file_size: 0x31n }],
    [{ ...mapping, va: (1n << 64n) - 1n }],
    [{ ...mapping, file_offset: 0x8ffn }],
  ])
    assert.throws(() => new AddressMap({ ...context, mappings }));
  assert.throws(() => new AddressMap({ ...context, slice_size: 0x1000n }));
});

test('immutable byte view does not leak ownership or permit out-of-bounds reads', () => {
  const input = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const bytes = new ImmutableBytes(input);
  input[0] = 99;
  assert.equal(bytes.at(0), 1);
  const copy = bytes.read(0n, 4);
  copy[1] = 99;
  assert.equal(bytes.at(1), 2);
  assert.equal(bytes.u32(0n), 0x04030201);
  assert.equal(bytes.u64(0n), 0x0807060504030201n);
  assert.throws(() => bytes.at(-1));
  assert.throws(() => bytes.read(7n, 2));
  assert.throws(() => bytes.u64(1n));
});
