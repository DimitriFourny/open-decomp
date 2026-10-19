import assert from 'node:assert/strict';
import test from 'node:test';
import { AddressMap, createOperationContext, expandEmission } from '../../../src/core/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { recoverDataAddress } from '../../../src/analysis/strings/source-data.js';
import { integer, type SSAForm } from '../../../src/ir/index.js';
import { navigationBytes } from '../../analysis/navigation-fixture.js';
import { builder, register } from '../../ir/support.js';
import { emit, execute, emittedFormals } from './support.js';

const i8 = integer(8);
for (const language of ['c-like', 'python-like'] as const)
  for (const mutable of [false, true])
    for (const kind of ['bytes', 'literal_pool', 'jump_table'] as const)
      test(`${language} ${mutable ? 'mutable' : 'immutable'} ${kind} retains exact table address rather than nearby text`, () => {
        const bytes = Buffer.concat([
          Buffer.from('expand 32-byte k\0'),
          Uint8Array.from({ length: 256 }, (_, index) => (index * 37 + 11) & 255),
        ]);
        const baseImage = navigationBytes(Uint8Array.of(0xc3), bytes);
        const start = { image_id: baseImage.id, space: 'va' as const, value: 0x2011n };
        const mappings = baseImage.mappings.map((mapping) =>
          mapping.id === 'data'
            ? {
                ...mapping,
                permissions: mutable ? (['read', 'write'] as const) : (['read'] as const),
              }
            : mapping,
        );
        const input = {
          ...baseImage,
          mappings,
          address_map: new AddressMap({
            image_id: baseImage.id,
            image_base: baseImage.image_base,
            byte_length: BigInt(baseImage.bytes.length),
            slice_offset: 0n,
            slice_size: BigInt(baseImage.bytes.length),
            mappings,
          }),
          sections: baseImage.sections.map((section) => ({
            ...section,
            permissions: mutable ? (['read', 'write'] as const) : (['read'] as const),
          })),
          symbols: [
            {
              id: 'lookup-symbol',
              kind: 'object' as const,
              address: start,
              size: 256n,
              binding: 'global' as const,
              original_name: `lookup_${kind}`,
              display_name: null,
              evidence_ids: ['lookup-symbol-origin'],
            },
          ],
          hints: [
            {
              kind: 'data' as const,
              range: { start, size: 256n },
              encoding: kind,
              evidence_ids: ['data-table-origin'],
            },
          ],
        };
        const address = recoverDataAddress(input, start, createOperationContext());
        assert.ok(address);
        assert.equal(address.object?.mutable, mutable);
        const b = builder(`source-table-${kind}-${mutable}`),
          block = b.block('entry');
        const index = block.readRegister(register('rdi', 64, 0, 'replace_root', 'x86_64:rdi'));
        const pointer = block.int('add', block.address(start), index);
        if (mutable) block.store(pointer, block.constant(i8, 0xa5n));
        const loaded = block.load(i8, pointer);
        block.return([loaded]);
        const ssa = constructSSA(b.finish(block, [i8])).value;
        assert.equal(ssa.form, 'ssa');
        const output = emit(
          ssa as SSAForm,
          {
            source: { abi: sysvAMD64Abi, callees: [], addresses: [address] },
          },
          language,
        );
        assert.match(output.emission.text, new RegExp(`\\blookup_${kind}\\b`));
        assert.doesNotMatch(output.emission.text, /data_address/);
        assert.doesNotMatch(output.emission.text, /expand 32-byte k/);
        assert.ok(
          expandEmission(output.emission).mappings.some((mapping) =>
            mapping.evidence_ids.includes('data-table-origin'),
          ),
        );
        for (const offset of [0n, 15n, 127n, 255n, 256n]) {
          const memory = new Map<bigint, number>();
          for (let index = 0; index < bytes.length; index++)
            memory.set(0x2000n + BigInt(index), bytes[index]!);
          const parameter = emittedFormals(output.emission)[0];
          assert.ok(parameter);
          const inputs = new Map(parameter.semantic_ids.map((id) => [id, offset]));
          const observed = execute(output.emission, inputs, memory);
          if (offset === 256n) {
            assert.equal(observed.exit, 'fault', 'one-past storage access must still fault');
            continue;
          }
          assert.deepEqual(observed.values, [
            mutable ? 0xa5n : BigInt((Number(offset) * 37 + 11) & 255),
          ]);
          assert.equal(
            observed.memory.get(start.value + offset),
            mutable ? 0xa5 : (Number(offset) * 37 + 11) & 255,
          );
        }
      });

for (const language of ['c-like', 'python-like'] as const)
  test(`${language} relocated string-table storage remains an ordered pointer load`, () => {
    const bytes = Buffer.alloc(32);
    bytes.write('alpha\0beta\0');
    bytes.writeBigUInt64LE(0x2000n, 16);
    bytes.writeBigUInt64LE(0x2006n, 24);
    const base = navigationBytes(Uint8Array.of(0xc3), bytes);
    const start = { image_id: base.id, space: 'va' as const, value: 0x2010n };
    const mappings = base.mappings.map((mapping) =>
      mapping.id === 'data' ? { ...mapping, permissions: ['read'] as const } : mapping,
    );
    const input = {
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
      sections: base.sections.map((section) => ({ ...section, permissions: ['read'] as const })),
      symbols: [
        {
          id: 'messages-symbol',
          kind: 'object' as const,
          address: start,
          size: 16n,
          binding: 'global' as const,
          original_name: 'messages',
          display_name: null,
          evidence_ids: ['messages-origin'],
        },
      ],
      relocations: [0n, 8n].map((offset, index) => ({
        id: `message-reloc-${index}`,
        address: { ...start, value: start.value + offset },
        kind: 'relocation' as const,
        encoding: 'absolute',
        width_bits: 64,
        target: { ...start, value: index === 0 ? 0x2000n : 0x2006n },
        symbol_id: null,
        addend: 0n,
        authenticated: false,
        evidence_ids: ['messages-origin'],
      })),
    };
    const addresses = [0x2000n, 0x2006n, 0x2010n].map((value) =>
      recoverDataAddress(input, { ...start, value }, createOperationContext())!,
    );
    assert.equal(addresses[2]!.string, undefined);
    const b = builder('relocated-string-table'),
      block = b.block('entry');
    const offset = block.readRegister(register('rdi', 64, 0, 'replace_root', 'x86_64:rdi'));
    const slot = block.int('add', block.address(start), offset);
    const pointer = block.load(integer(64), slot);
    const character = block.load(i8, pointer);
    block.return([character]);
    const ssa = constructSSA(b.finish(block, [i8])).value;
    assert.equal(ssa.form, 'ssa');
    const output = emit(
      ssa as SSAForm,
      { source: { abi: sysvAMD64Abi, callees: [], addresses } },
      language,
    );
    assert.match(output.emission.text, /\bmessages\b/);
    assert.doesNotMatch(output.emission.text, /data_address/);
    const parameter = emittedFormals(output.emission)[0];
    assert.ok(parameter);
    for (const [offset, expected] of [
      [0n, 97n],
      [8n, 98n],
    ] as const) {
      const memory = new Map([...bytes].map((byte, index) => [0x2000n + BigInt(index), byte]));
      const result = execute(
        output.emission,
        new Map(parameter.semantic_ids.map((id) => [id, offset])),
        memory,
      );
      assert.deepEqual(result.values, [expected]);
      assert.deepEqual(result.events, ['load', 'load']);
    }
  });
