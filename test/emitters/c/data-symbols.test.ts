import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../../src/core/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { recoverDataAddress } from '../../../src/analysis/strings/source-data.js';
import { integer, type SSAForm } from '../../../src/ir/index.js';
import type { SourceAddress } from '../../../src/reconstruction/source-model.js';
import { navigationBytes } from '../../analysis/navigation-fixture.js';
import { builder, register } from '../../ir/support.js';
import { emit } from './support.js';

const languages = ['c-like', 'python-like'] as const;
const rdi = () => register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');

/** Data image at VA 0x2000 holding `bytes`; a table symbol `lookup` at 0x2000. */
function tableFixture(
  bytes: Buffer,
  options: {
    size?: bigint | null;
    mutable?: boolean;
    next?: bigint;
    mask?: bigint;
    bits?: 8 | 16 | 32;
    guard?: bigint;
  } = {},
) {
  const image = navigationBytes(Uint8Array.of(0xc3), bytes);
  const start = { image_id: image.id, space: 'va' as const, value: 0x2000n };
  const permissions = options.mutable ? (['read', 'write'] as const) : (['read'] as const);
  const symbol = (id: string, address: bigint, size: bigint | null, name: string) => ({
    id,
    kind: 'object' as const,
    address: { ...start, value: address },
    size,
    binding: 'local' as const,
    original_name: name,
    display_name: null,
    evidence_ids: [`${id}-symbol`],
  });
  const loaded = {
    ...image,
    mappings: image.mappings.map((mapping) => ({ ...mapping, permissions })),
    sections: image.sections.map((section) => ({ ...section, permissions })),
    symbols: [
      symbol('table', 0x2000n, options.size === undefined ? null : options.size, '_lookup'),
      ...(options.next === undefined ? [] : [symbol('next', options.next, null, '_other')]),
    ],
  };
  const recovered = recoverDataAddress(loaded, start, createOperationContext())!;
  const bits = options.bits ?? 8;
  const b = builder(`table-${bytes.length}`),
    entry = b.block('entry');
  const argument = entry.readRegister(rdi());
  const masked = entry.int('and', argument, entry.constant(integer(64), options.mask ?? 0xffn));
  const scaled =
    bits === 8 ? masked : entry.int('mul', masked, entry.constant(integer(64), BigInt(bits / 8)));
  const loaded8 = entry.load(integer(bits), entry.int('add', entry.address(start), scaled), {
    endian: 'little',
    alignment: 1,
    volatile: false,
  });
  entry.return([loaded8]);
  const ssa = constructSSA(b.finish(entry, [integer(bits)])).value as SSAForm;
  return { ssa, recovered, image: loaded, bytes };
}
const sourceOf = (addresses: readonly SourceAddress[]) => ({
  source: { abi: sysvAMD64Abi, callees: [], addresses },
});

test('span_bound: the distance to the next symbol, never past it, only for read-only bytes', () => {
  const bytes = Buffer.alloc(64, 7);
  const bounded = tableFixture(bytes, { next: 0x2018n });
  assert.equal(bounded.recovered.object?.span_bound, 0x18n);
  assert.equal(bounded.recovered.object?.byte_length, null);
  // A symbol size is the extent; no bound is added.
  assert.equal(tableFixture(bytes, { size: 32n }).recovered.object?.span_bound, undefined);
  // Writable storage has neither bound nor bytes.
  assert.equal(tableFixture(bytes, { mutable: true }).recovered.object?.span_bound, undefined);
  // Section end bounds an unnamed neighbourhood.
  const open = tableFixture(bytes).recovered.object?.span_bound;
  assert.ok(open !== undefined && open <= 64n);
});

for (const language of languages)
  test(`${language} read-only table prints its contents once, sized by the accessed range`, () => {
    const bytes = Buffer.from(Array.from({ length: 64 }, (_, index) => index * 3));
    const f = tableFixture(bytes, { size: 64n, mask: 0x1fn });
    const emission = emit(
      f.ssa,
      sourceOf([{ ...f.recovered, source_name: 'lookup', object_bytes: [...bytes] }]),
      language,
    ).emission;
    const first = Array.from({ length: 32 }, (_, index) => index * 3);
    if (language === 'c-like') {
      assert.match(emission.text, /static const uint8_t lookup\[32\] = \{/);
      assert.ok(emission.text.includes(first.slice(0, 16).join(', ')), emission.text);
      assert.ok(emission.text.includes(first.slice(16).join(', ')), emission.text);
      assert.doesNotMatch(emission.text, /extern const uint8_t lookup/);
    } else {
      assert.match(emission.text, /lookup = \(/);
      assert.ok(emission.text.includes(first.join(', ')) || emission.text.includes('93'));
    }
    assert.ok(emission.text.includes('lookup[') || emission.text.includes('lookup['));
  });

test('table elements use the accessed width and decimal below 2^32', () => {
  const bytes = Buffer.alloc(32);
  for (let index = 0; index < 8; index++) bytes.writeUInt32LE(1000 * (index + 1), index * 4);
  const f = tableFixture(bytes, { size: 32n, mask: 0x7n, bits: 32 });
  const text = emit(f.ssa, sourceOf([{ ...f.recovered, object_bytes: [...bytes] }])).emission.text;
  assert.match(text, /static const uint32_t \w+\[8\] = \{/);
  assert.ok(text.includes('1000, 2000, 3000, 4000'), text);
});

test('large tables show a bounded prefix with an explicit remainder', () => {
  const bytes = Buffer.from(Array.from({ length: 1024 }, (_, index) => index & 255));
  const f = tableFixture(bytes, { size: 1024n, mask: 0x3ffn });
  const text = emit(
    f.ssa,
    sourceOf([{ ...f.recovered, object_bytes: [...bytes.subarray(0, 512)] }]),
  ).emission.text;
  assert.match(text, /static const uint8_t \w+\[1024\] = \{/);
  assert.match(text, /\/\* \.\.\. 768 more \*\//);
  assert.doesNotMatch(text, /255, 0, 1/);
});

test('a table of unestablished extent shows only its first elements', () => {
  const bytes = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
  // No symbol size, no next symbol bound, index not bounded by the access: the
  // object carries no extent facts at all.
  const f = tableFixture(bytes, { mask: 0xffffffffn });
  const { span_bound: _bound, ...object } = f.recovered.object!;
  const text = emit(f.ssa, sourceOf([{ ...f.recovered, object, object_bytes: [...bytes] }]))
    .emission.text;
  assert.match(text, /static const uint8_t \w+\[\] = \{/);
  assert.match(text, /further elements not shown/);
  assert.match(text, /first 16 elements \(extent not established\)/);
});

for (const gate of ['mutable', 'no-bytes'] as const)
  test(`table contents are refused: ${gate}`, () => {
    const bytes = Buffer.alloc(64, 9);
    const f = tableFixture(bytes, { size: 64n, mutable: gate === 'mutable' });
    const text = emit(
      f.ssa,
      sourceOf([{ ...f.recovered, ...(gate === 'no-bytes' ? {} : { object_bytes: [...bytes] }) }]),
    ).emission.text;
    assert.doesNotMatch(text, /static const/);
    assert.match(text, /extern (const )?uint8_t \w+\[\];/);
  });

/** `*dst = <constant>`: a pointer-width constant stored to memory. */
function constantStore(value: bigint) {
  const b = builder(`store-${value}`),
    entry = b.block('entry');
  entry.store(entry.readRegister(rdi()), entry.constant(integer(64), value));
  entry.return([]);
  return constructSSA(b.finish(entry, [])).value as SSAForm;
}

for (const language of languages)
  test(`${language} a constant equal to a function entry names the function`, () => {
    const image = navigationBytes(Uint8Array.of(0xc3), Buffer.alloc(16));
    const address = { image_id: image.id, space: 'va' as const, value: 0x1000n };
    const item: SourceAddress = {
      address,
      name: '_handler',
      source_name: 'handler',
      function_entry: { self: false },
    };
    const text = emit(constantStore(0x1000n), sourceOf([item]), language).emission.text;
    if (language === 'c-like') {
      assert.match(text, /= \(uintptr_t\)handler;/);
      assert.match(text, /^extern void handler\(\);/m);
      assert.doesNotMatch(text, /0x1000/);
    } else {
      assert.match(text, /function_address\("handler"\)/);
    }
    const checked = emit(constantStore(0x1000n), sourceOf([item]), language, 'checked');
    assert.doesNotMatch(checked.emission.text, /\(uintptr_t\)handler|function_address/);
  });

test('an unnamed function entry prints as sub_<VA>; an unrelated constant stays a number', () => {
  const image = navigationBytes(Uint8Array.of(0xc3), Buffer.alloc(16));
  const address = { image_id: image.id, space: 'va' as const, value: 0x1000n };
  const item: SourceAddress = { address, function_entry: { self: false } };
  assert.match(
    emit(constantStore(0x1000n), sourceOf([item])).emission.text,
    /= \(uintptr_t\)sub_1000;/,
  );
  assert.match(emit(constantStore(0x1234n), sourceOf([item])).emission.text, /= 0x1234;/);
});

test('a named data object constant prints as its address; an unnamed one stays a number', () => {
  const bytes = Buffer.alloc(64, 1);
  const f = tableFixture(bytes, { size: 64n });
  const named = { ...f.recovered, name: '_lookup', source_name: 'lookup' };
  const store = constantStore(0x2000n);
  assert.match(emit(store, sourceOf([named])).emission.text, /= \(uintptr_t\)lookup;/);
  const { name: _name, ...unnamed } = f.recovered;
  assert.match(emit(store, sourceOf([unnamed])).emission.text, /= 0x2000;/);
});

for (const language of languages)
  test(`${language} a dominating unsigned comparison bounds the accessed range of a table`, () => {
    const bytes = Buffer.from(Array.from({ length: 64 }, (_, index) => index + 100));
    const image = navigationBytes(Uint8Array.of(0xc3), bytes);
    const start = { image_id: image.id, space: 'va' as const, value: 0x2000n };
    const loaded = {
      ...image,
      mappings: image.mappings.map((mapping) => ({ ...mapping, permissions: ['read' as const] })),
      sections: image.sections.map((section) => ({ ...section, permissions: ['read' as const] })),
    };
    const recovered = recoverDataAddress(loaded, start, createOperationContext())!;
    const b = builder(`guard-${language}`),
      entry = b.block('entry'),
      inside = b.block('inside'),
      outside = b.block('outside');
    const index = entry.cast('truncate', integer(32), entry.readRegister(rdi()));
    entry.branch(
      entry.compare('ule', index, entry.constant(integer(32), 5n)),
      entry.edge(inside),
      entry.edge(outside),
    );
    const extended = inside.cast('zero_extend', integer(64), index);
    const value = inside.load(integer(8), inside.int('add', inside.address(start), extended), {
      endian: 'little',
      alignment: 1,
      volatile: false,
    });
    inside.return([value]);
    outside.return([outside.constant(integer(8), 0n)]);
    const ssa = constructSSA(b.finish(entry, [integer(8)])).value as SSAForm;
    const text = emit(ssa, sourceOf([{ ...recovered, object_bytes: [...bytes] }]), language)
      .emission.text;
    const six = [100, 101, 102, 103, 104, 105].join(', ');
    assert.ok(text.includes(six), text);
    assert.ok(!text.includes('106'), text);
    if (language === 'c-like') assert.match(text, /\[6\] = \{/);
  });

for (const language of languages)
  test(`${language} an immutable string plus a variable offset in a load address shows the string`, () => {
    const bytes = Buffer.from('create\0');
    const image = navigationBytes(Uint8Array.of(0xc3), bytes);
    const start = { image_id: image.id, space: 'va' as const, value: 0x2000n };
    const loaded = {
      ...image,
      mappings: image.mappings.map((mapping) => ({ ...mapping, permissions: ['read' as const] })),
      sections: image.sections.map((section) => ({ ...section, permissions: ['read' as const] })),
    };
    const recovered = recoverDataAddress(loaded, start, createOperationContext())!;
    assert.equal(recovered.string, 'create');
    const b = builder(`keyword-${language}`),
      entry = b.block('entry');
    const offset = entry.readRegister(rdi());
    const value = entry.load(integer(8), entry.int('add', entry.address(start), offset), {
      endian: 'little',
      alignment: 1,
      volatile: false,
    });
    entry.return([value]);
    const ssa = constructSSA(b.finish(entry, [integer(8)])).value as SSAForm;
    const text = emit(ssa, sourceOf([recovered]), language).emission.text;
    if (language === 'c-like') assert.match(text, /\(uintptr_t\)"create" \+ /);
    else assert.match(text, /string_address\("create"\) \+ /);
    assert.doesNotMatch(text, /0x2000/);
  });
