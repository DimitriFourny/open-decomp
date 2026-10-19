import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../../src/core/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { recoverDataAddress } from '../../../src/analysis/strings/source-data.js';
import { integer, type SSAForm } from '../../../src/ir/index.js';
import { navigationBytes } from '../../analysis/navigation-fixture.js';
import { builder, register } from '../../ir/support.js';
import { emit, execute, emittedFormals } from './support.js';

for (const language of ['c-like', 'python-like'] as const)
  for (const scenario of [
    'named',
    'neutral',
    'interior',
    'stride',
    'mutable',
    'wrong-scale',
    'wrap',
    'mask',
    'wide-mask',
    'volatile',
    'big-endian',
  ] as const)
    test(`${language} indexed data: ${scenario}`, () => {
      const prefix = Buffer.alloc(32);
      prefix.write('expand 32-byte k\0');
      const bytes = Buffer.concat([prefix, Buffer.alloc(64, 0x35)]);
      const image = navigationBytes(Uint8Array.of(0xc3), bytes);
      const start = { image_id: image.id, space: 'va' as const, value: 0x2020n };
      const mutable = scenario === 'mutable';
      const bits = scenario === 'stride' || scenario === 'wrong-scale' ? 16 : 8;
      const offset = scenario === 'interior' ? 3n : 0n;
      const input = {
        ...image,
        mappings: image.mappings.map((mapping) => ({
          ...mapping,
          permissions: mutable ? (['read', 'write'] as const) : (['read'] as const),
        })),
        sections: image.sections.map((section) => ({
          ...section,
          permissions: mutable ? (['read', 'write'] as const) : (['read'] as const),
        })),
        symbols:
          scenario === 'neutral'
            ? []
            : [
                {
                  id: 'table',
                  kind: 'object' as const,
                  address: start,
                  size: 64n,
                  binding: 'local' as const,
                  original_name: '_lookup',
                  display_name: null,
                  evidence_ids: ['table-symbol'],
                },
              ],
      };
      const address = recoverDataAddress(
        input,
        { ...start, value: start.value + offset },
        createOperationContext(),
      )!;
      assert.ok(address.object);
      const b = builder(`indexed-${language}-${scenario}`),
        block = b.block('entry');
      const argument = block.readRegister(register('rdi', 64, 0, 'replace_root', 'x86_64:rdi'));
      const index =
        scenario === 'wrap'
          ? argument
          : scenario === 'mask' || scenario === 'wide-mask'
            ? block.int(
                'and',
                argument,
                block.constant(integer(64), scenario === 'mask' ? 0xffn : 0xffffffffffffff00n),
              )
            : block.cast('zero_extend', integer(64), block.cast('truncate', integer(16), argument));
      const scaled =
        scenario === 'stride' ? block.int('mul', index, block.constant(integer(64), 4n)) : index;
      const pointer = block.int('add', block.address(address.address), scaled);
      const loaded = block.load(integer(bits), pointer, {
        endian: scenario === 'big-endian' ? 'big' : 'little',
        alignment: 1,
        volatile: scenario === 'volatile',
      });
      block.return([loaded]);
      const ssa = constructSSA(b.finish(block, [integer(bits)])).value as SSAForm;
      const extra = {
        source: {
          abi: sysvAMD64Abi,
          callees: [],
          addresses: [{ ...address, ...(scenario === 'neutral' ? {} : { source_name: 'lookup' }) }],
        },
      };
      const output = emit(ssa, extra, language);
      const applied = !['wrong-scale', 'wrap', 'wide-mask', 'volatile', 'big-endian'].includes(
        scenario,
      );
      assert.equal(
        output.emission.local_validation?.some(
          (record) => record.kind === 'presentation' && record.rule === 'indexed_data_load',
        ),
        applied,
      );
      if (applied) {
        const name = scenario === 'neutral' ? 'data_2020' : 'lookup';
        assert.match(output.emission.text, new RegExp(`${name}\\[`));
        assert.doesNotMatch(output.emission.text, /expand 32-byte k/);
        if (language === 'c-like')
          assert.ok(
            output.emission.text.includes(
              `extern ${mutable ? '' : 'const '}uint${bits}_t ${name}[];`,
            ),
          );
        else assert.match(output.emission.text, / = memory_view\(0x2020,/);
        if (scenario === 'interior') assert.match(output.emission.text, /lookup\[3 \+/);
        if (scenario === 'stride') assert.match(output.emission.text, /\* 2\]/);
      }
      const checked = emit(ssa, extra, language, 'checked');
      assert.doesNotMatch(checked.emission.text, /extern |memory_view\(/);
      // The C oracle does not implement the explicit big-endian lvalue helper.
      if (language === 'c-like' && scenario === 'big-endian') return;
      const formal = emittedFormals(output.emission)[0]!;
      for (const index of [0n, 5n, 64n]) {
        const memory = new Map([...bytes].map((byte, i) => [0x2000n + BigInt(i), byte]));
        const actual = execute(
          output.emission,
          new Map(formal.semantic_ids.map((id) => [id, index])),
          memory,
        );
        // The wide mask clears every low index bit.
        const faults = index === 64n && scenario !== 'wide-mask';
        assert.equal(actual.exit, faults ? 'fault' : 'machine_return');
        if (!faults) assert.deepEqual(actual.values, [bits === 8 ? 0x35n : 0x3535n]);
      }
    });
