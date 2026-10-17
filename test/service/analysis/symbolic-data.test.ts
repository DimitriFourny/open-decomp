import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AddressMap,
  createOperationContext,
  expandEmission,
  type LoadedImage,
} from '../../../src/core/index.js';
import { recoverDataAddress } from '../../../src/analysis/strings/source-data.js';
import { navigationBytes } from '../../analysis/navigation-fixture.js';
import { execute } from '../../emitters/c/support.js';
import { project } from './support.js';

const text = 'open-decomp trusted fixture v1';
for (const fixture of [
  'macho-arm64-symbols',
  'libcorpus-arm64-symbols.dylib',
  'corpus-symbols.dll',
])
  test(`public ${fixture} string return has exact content and pointer source type in both dialects`, async (t) => {
    const p = await project(t, fixture);
    const fn = p.functions.find((row) => row.original_name?.replace(/^_/, '') === 'fixture_string');
    assert.ok(fn);
    for (const emitter of ['c-like', 'python-like'] as const) {
      const result = await p.decompile(fn.id, { options: { emitter } });
      assert.ok('data' in result.result);
      const full = p.payload(result.result).result;
      assert.ok('data' in full);
      assert.match(
        full.data.emission.text,
        emitter === 'c-like' ? /char\s*\*\s+fixture_string\(/ : /-> pointer\[char\]:/,
      );
      assert.equal(execute(full.data.emission).string_result, text);
      assert.ok(
        expandEmission(full.data.emission).mappings.some((mapping) => mapping.semantic_ids.length),
      );
    }
  });

function image(bytes: Uint8Array, mutable = false): LoadedImage {
  const base = navigationBytes(Uint8Array.of(0xc3), bytes);
  const mappings = base.mappings.map((mapping) =>
    mapping.id === 'data'
      ? { ...mapping, permissions: mutable ? (['read', 'write'] as const) : (['read'] as const) }
      : mapping,
  );
  return {
    ...base,
    mappings,
    address_map: new AddressMap({
      image_id: base.id,
      image_base: base.image_base,
      byte_length: BigInt(base.bytes.length),
      slice_offset: 0n,
      slice_size: BigInt(base.bytes.length),
      mappings,
    }),
    sections: base.sections.map((section) => ({
      ...section,
      permissions: mutable ? ['read', 'write'] : ['read'],
    })),
  };
}
function recover(input: LoadedImage, offset = 0n) {
  return recoverDataAddress(
    input,
    { image_id: input.id, space: 'va', value: 0x2000n + offset },
    createOperationContext(),
  );
}

test('data evidence respects terminators, exact bounds, UTF encodings and writable storage', () => {
  const input = image(Buffer.from('alpha\0beta\0'));
  assert.equal(recover(input)?.string, 'alpha');
  const relative = recoverDataAddress(
    input,
    { image_id: input.id, space: 'rva', value: 0x1000n },
    createOperationContext(),
  );
  assert.equal(relative?.string, 'alpha');
  assert.equal(relative?.address.space, 'rva', 'retain the observed coordinate provenance');
  assert.equal(
    recoverDataAddress(
      input,
      { image_id: 'another-image', space: 'va', value: 0x2000n },
      createOperationContext(),
    ),
    undefined,
  );
  assert.equal(recover(input, 2n)?.string, 'pha');
  assert.equal(recover(input, 6n)?.string, 'beta');
  assert.equal(recover(input, 5n)?.string, '');
  assert.equal(recover(input, 11n), undefined);
  assert.equal(recover(image(Buffer.from('unterminated')))?.string, undefined);
  assert.equal(recover(image(Buffer.from('mutable\0'), true))?.string, undefined);
  const utf8 = image(Buffer.from('éclair\0'));
  assert.equal(recover(utf8)?.string, 'éclair');
  assert.equal(recover(utf8, 1n)?.string, undefined);
  assert.equal(recover(image(Uint8Array.of(0xc0, 0xaf, 0)))?.string, undefined);
  const wide = image(Buffer.from('wide\0', 'utf16le'));
  assert.equal(
    recover(wide)?.string,
    undefined,
    'UTF-16 bytes must not become a one-byte C string',
  );
  assert.equal(
    recover(wide, 1n)?.string,
    undefined,
    'wide high-byte interior is not an empty byte string',
  );
  assert.equal(
    recover(wide, 6n)?.string,
    undefined,
    'wide final character retains encoding evidence',
  );
});

test('global, pool, jump-table and relocated pointer slots keep their own exact identities', () => {
  const input = image(Buffer.from('expand 32-byte k\0abcdefghijklmnop\0'));
  const address = { image_id: input.id, space: 'va' as const, value: 0x2011n };
  for (const encoding of ['jump_table', 'literal_pool'] as const) {
    const table: LoadedImage = {
      ...input,
      hints: [
        {
          kind: 'data',
          range: { start: address, size: 16n },
          encoding,
          evidence_ids: ['table-evidence'],
        },
      ],
    };
    const recovered = recover(table, 18n);
    assert.equal(recovered?.string, undefined);
    assert.equal(recovered?.object?.address.value, address.value);
    assert.equal(recovered?.object?.byte_length, 16n);
    assert.equal(recovered?.object?.kind, encoding);
    assert.equal(recovered?.object?.offset, 1n);
    assert.deepEqual(recovered?.object?.evidence_ids, ['table-evidence']);
    assert.notEqual(
      recover(table, 33n)?.object?.kind,
      encoding,
      'one-past table is not a table interior',
    );
  }
  const relocated: LoadedImage = {
    ...input,
    relocations: [
      {
        id: 'pointer-reloc',
        address,
        kind: 'relocation',
        target: { ...address, value: 0x2000n },
        addend: 0n,
        width_bits: 64,
        authenticated: false,
        symbol_id: null,
        encoding: 'absolute',
        evidence_ids: [],
      },
    ],
  };
  assert.equal(
    recover(relocated, 17n)?.string,
    undefined,
    'relocation storage is not target string bytes',
  );
  assert.equal(recover(relocated)?.string, 'expand 32-byte k');
});

test('symbol extents, aliases and zero-fill do not manufacture string bytes', () => {
  const input = image(Buffer.from('abc\0tail\0'));
  const start = { image_id: input.id, space: 'va' as const, value: 0x2000n };
  const symbol = {
    id: 'global-data',
    kind: 'object' as const,
    address: start,
    size: 3n,
    binding: 'global' as const,
    original_name: 'global_bytes',
    display_name: null,
    evidence_ids: ['global-origin'],
  };
  const bounded: LoadedImage = { ...input, symbols: [symbol] };
  assert.equal(recover(bounded)?.name, 'global_bytes');
  assert.equal(recover(bounded)?.string, undefined, 'terminator lies outside the object');
  assert.equal(recover(bounded, 2n)?.object?.offset, 2n);
  assert.equal(recover(bounded, 2n)?.object?.byte_length, 3n);
  const terminated: LoadedImage = { ...input, symbols: [{ ...symbol, size: 4n }] };
  assert.equal(recover(terminated)?.string, 'abc');
  assert.equal(recover(terminated, 1n)?.string, 'bc');
  const stringTable: LoadedImage = { ...input, symbols: [{ ...symbol, size: 9n }] };
  assert.equal(
    recover(stringTable)?.string,
    undefined,
    'whole string table is not its first literal',
  );
  const sectionOwned: LoadedImage = {
    ...input,
    hints: [
      {
        kind: 'data',
        encoding: 'bytes',
        range: input.sections[0]!.virtual_range,
        evidence_ids: [],
      },
    ],
  };
  assert.equal(recover(sectionOwned, 4n)?.string, 'tail');
  assert.equal(
    recover(sectionOwned, 4n)?.object?.address.value,
    0x2004n,
    'whole-section ownership does not rebase a distinct literal to the first one',
  );
  const conflicting: LoadedImage = {
    ...input,
    symbols: [symbol, { ...symbol, id: 'other', size: 8n }],
  };
  assert.equal(recover(conflicting)?.string, undefined);
  assert.equal(recover(conflicting)?.object?.byte_length, null);
  const zeroFill: LoadedImage = {
    ...input,
    sections: input.sections.map((section) => ({
      ...section,
      virtual_range: { ...section.virtual_range, size: section.virtual_range.size + 32n },
    })),
  };
  assert.equal(recover(zeroFill, 9n)?.string, undefined);
});
