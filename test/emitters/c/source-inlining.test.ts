import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { entityIdentity } from '../../../src/core/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { IRBuilder, integer, type SSAForm, type Value } from '../../../src/ir/index.js';
import type { EmissionResult } from '../../../src/emitters/model.js';
import { image, provenance, slice } from '../../ir/support.js';
import { emit, execute } from './support.js';

const i1 = integer(1),
  i8 = integer(8),
  i32 = integer(32),
  i64 = integer(64);
const program = (name: string): IRBuilder<'ssa'> =>
  new IRBuilder(slice, entityIdentity(slice, 'function', name), provenance, 'ssa');
const source = { abi: new DarwinArm64Abi(), callees: [], addresses: [] };
const named = (output: EmissionResult, value: Value): boolean =>
  output.identifiers.some((row) => row.entity_id === value.id);
const memory = (): Map<bigint, number> =>
  new Map([
    [0x1000n, 3],
    [0x1001n, 0],
    [0x1002n, 0],
    [0x1003n, 0],
    [0x1004n, 9],
    [0x1005n, 0],
    [0x1006n, 0],
    [0x1007n, 0],
    [0x1103n, 231],
  ]);

for (const language of ['c-like', 'python-like'] as const)
  describe(`single-use ${language}`, () => {
    const render = (input: SSAForm, view: 'source' | 'checked' = 'source'): EmissionResult =>
      emit(input, { source }, language, view);
    test('dependent loads nest once at their use, preserving faults and original mappings', () => {
      const b = program('single-use-dependent'),
        entry = b.block('entry');
      const index = entry.load(i8, entry.constant(i64, 0x1000n));
      const address = entry.int(
        'add',
        entry.constant(i64, 0x1100n),
        entry.cast('zero_extend', i64, index),
      );
      const value = entry.load(i8, address);
      entry.return([entry.cast('zero_extend', i32, value)]);
      const input = b.finish(entry, [i32]),
        output = render(input);
      assert.ok(!named(output, index), output.emission.text);
      assert.ok(!named(output, value), output.emission.text);
      assert.ok(
        output.emission.local_validation?.some((record) => record.rule === 'single_use_inlining'),
      );
      for (const result of [output, render(input, 'checked')]) {
        const observed = execute(result.emission, new Map(), memory());
        assert.deepEqual(observed.values, [231n]);
        assert.deepEqual(observed.events, ['load', 'load']);
        const invalid = memory();
        invalid.delete(0x1103n);
        const fault = execute(result.emission, new Map(), invalid);
        assert.equal(fault.exit, 'fault');
        assert.deepEqual(fault.events, ['load', 'load']);
      }
      for (const node of input.blocks[0]!.instructions.filter((node) => node.kind === 'load')) {
        const id = output.emission.ids.indexOf(node.id);
        assert.ok(
          output.emission.mappings.some(
            (mapping) =>
              mapping.semantic_refs[0] === id &&
              output.emission.text.slice(mapping.start, mapping.end).includes('return'),
          ),
        );
      }
    });

    test('symbolic table indices keep a narrow load shared with a retained widening', () => {
      const b = program('single-use-table-alias'),
        entry = b.block('entry');
      const byte = entry.load(i8, entry.constant(i64, 0x1000n));
      const wide = entry.cast('zero_extend', i32, byte);
      entry.store(
        entry.constant(i64, 0x1000n),
        entry.cast('truncate', i8, entry.int('add', wide, entry.constant(i32, 1n))),
      );
      const address = { image_id: image, space: 'va' as const, value: 0x1100n };
      const pointer = entry.int(
        'add',
        entry.address(address),
        entry.cast('zero_extend', i64, wide),
      );
      entry.return([entry.cast('zero_extend', i32, entry.load(i8, pointer))]);
      const input = b.finish(entry, [i32]);
      const output = emit(
        input,
        {
          source: {
            ...source,
            addresses: [
              {
                address,
                name: 'lookup',
                object: {
                  address,
                  byte_length: 256n,
                  offset: 0n,
                  mutable: false,
                  kind: 'bytes',
                  evidence_ids: [],
                },
              },
            ],
          },
        },
        language,
      );
      assert.match(output.emission.text, /lookup\[/);
      assert.ok(named(output, byte), output.emission.text);
      const observed = execute(output.emission, new Map(), memory());
      assert.deepEqual(observed.values, [231n]);
      assert.deepEqual(observed.events, ['load', 'store', 'load']);
      assert.equal(observed.memory.get(0x1000n), 4);
    });

    test('intervening stores, independent loads, fences and volatile reads keep load temporaries', () => {
      for (const barrier of ['store', 'load', 'fence', 'volatile'] as const) {
        const b = program(`single-use-${barrier}`),
          entry = b.block('entry');
        const loaded = entry.load(i8, entry.constant(i64, 0x1000n), {
          endian: 'little',
          alignment: 1,
          volatile: barrier === 'volatile',
        });
        if (barrier === 'store') entry.store(entry.constant(i64, 0x1000n), entry.constant(i8, 77n));
        if (barrier === 'load') entry.load(i8, entry.constant(i64, 0x1004n));
        if (barrier === 'fence') entry.memoryFence();
        entry.return([entry.cast('zero_extend', i32, loaded)]);
        const input = b.finish(entry, [i32]),
          output = render(input);
        assert.ok(named(output, loaded), `${barrier}\n${output.emission.text}`);
        const actual = execute(output.emission, new Map(), memory());
        const expected = execute(render(input, 'checked').emission, new Map(), memory());
        assert.deepEqual(actual.values, [3n]);
        assert.deepEqual(actual.events, expected.events);
        assert.deepEqual(actual.memory, expected.memory);
      }
    });

    test('a call between a load and its single use keeps the load a statement before the call', () => {
      const b = program('single-use-call'),
        entry = b.block('entry');
      const loaded = entry.load(i8, entry.constant(i64, 0x1000n));
      entry.call(
        { kind: 'direct', address: { image_id: image, space: 'va', value: 0x4000n } },
        [],
        [],
        { registers: [], flags: [], memory: 'unknown_read_write' },
      );
      entry.return([entry.cast('zero_extend', i32, loaded)]);
      const output = render(b.finish(entry, [i32]));
      assert.ok(named(output, loaded), output.emission.text);
      const text = output.emission.text,
        variable = output.identifiers.find((row) => row.entity_id === loaded.id)!.identifier;
      assert.ok(text.indexOf(`${variable} = `) < text.search(/sub_4000\(/), text);
    });

    test('a cheap operation read twice by one statement repeats there; read by two statements it stays a variable', () => {
      for (const split of [false, true]) {
        const b = program(`repeated-${split}`),
          entry = b.block('entry', [i1, i32]);
        const [condition, x] = entry.parameters as [Value, Value];
        const half = entry.int('lshr', x, entry.constant(i32, 1n));
        const mixed = entry.int('xor', half, entry.constant(i32, 0xedb88320n));
        const selected = entry.select(condition, mixed, half);
        if (split) entry.store(entry.constant(i64, 0x1000n), half);
        entry.return([selected]);
        const input = b.finish(entry, [i32]),
          output = render(input);
        const rules = (output.emission.local_validation ?? []).map((record) => record.rule);
        assert.equal(named(output, half), split, output.emission.text);
        assert.equal(rules.includes('repeated_operation'), !split, output.emission.text);
        for (const [c, value] of [
          [0n, 0x80000003n],
          [1n, 0x80000003n],
          [1n, 0xffffffffn],
        ] as const) {
          const inputs = new Map([
            [condition.id, c],
            [x.id, value],
          ]);
          const actual = execute(output.emission, inputs, memory());
          const expected = execute(render(input, 'checked').emission, inputs, memory());
          assert.deepEqual(actual.values, expected.values);
          assert.deepEqual(actual.memory, expected.memory);
          assert.deepEqual(actual.values, [c ? (value >> 1n) ^ 0xedb88320n : value >> 1n]);
        }
      }
    });

    test('a load used by a lazy select stays unconditional', () => {
      const b = program('single-use-lazy'),
        entry = b.block('entry', [i1]);
      const condition = entry.parameters[0]!;
      const loaded = entry.load(i8, entry.constant(i64, 0x1000n));
      entry.return([
        entry.cast('zero_extend', i32, entry.select(condition, loaded, entry.constant(i8, 0n))),
      ]);
      const input = b.finish(entry, [i32]),
        output = render(input);
      assert.ok(named(output, loaded), output.emission.text);
      for (const selected of [0n, 1n]) {
        const observed = execute(output.emission, new Map([[condition.id, selected]]), memory());
        assert.deepEqual(observed.values, [selected ? 3n : 0n]);
        assert.deepEqual(observed.events, ['load']);
        assert.equal(
          execute(output.emission, new Map([[condition.id, selected]]), new Map()).exit,
          'fault',
        );
      }
    });

    test('two independent loads never become unsequenced arithmetic operands', () => {
      const b = program('single-use-independent'),
        entry = b.block('entry');
      const first = entry.load(i8, entry.constant(i64, 0x1000n));
      const second = entry.load(i8, entry.constant(i64, 0x1004n));
      entry.return([
        entry.int(
          'sub',
          entry.cast('zero_extend', i32, first),
          entry.cast('zero_extend', i32, second),
        ),
      ]);
      const input = b.finish(entry, [i32]),
        output = render(input);
      assert.ok(named(output, first), output.emission.text);
      assert.ok(!named(output, second), output.emission.text);
      const observed = execute(output.emission, new Map(), memory());
      assert.equal(
        BigInt.asUintN(32, observed.values[0]!),
        BigInt.asUintN(32, -6n),
        output.emission.text,
      );
      assert.deepEqual(observed.events, ['load', 'load']);
      assert.deepEqual(execute(output.emission, new Map(), new Map()).events, ['load']);
    });

    test('single-use tests fold into expression-only short-circuit conditions; stores refuse folding', () => {
      for (const store of [false, true]) {
        const b = program(`single-use-chain-${store}`);
        const entry = b.block('entry', [i32]),
          head = b.block('head', [i32]);
        const second = b.block('second'),
          body = b.block('body');
        const exhausted = b.block('exhausted'),
          done = b.block('done');
        const count = entry.parameters[0]!;
        entry.jump(head, [count]);
        const left = head.load(i8, head.constant(i64, 0x1000n));
        if (store) head.store(head.constant(i64, 0x1002n), head.constant(i8, 1n));
        head.branch(
          head.compare('ne', left, head.constant(i8, 0n)),
          head.edge(second),
          head.edge(done),
        );
        const right = second.load(i8, second.constant(i64, 0x1004n));
        second.branch(
          second.compare('ne', right, second.constant(i8, 0n)),
          second.edge(body),
          second.edge(done),
        );
        const remaining = head.parameters[0]!;
        body.branch(
          body.compare('ule', remaining, body.constant(i32, 1n)),
          body.edge(exhausted),
          body.edge(head, [body.int('sub', remaining, body.constant(i32, 1n))]),
        );
        exhausted.return([exhausted.constant(i32, 99n)]);
        done.return([done.constant(i32, 7n)]);
        const input = b.finish(entry, [i32]),
          output = render(input);
        const header = output.emission.text
          .split('\n')
          .find((line) => line.trim().startsWith('while '));
        assert.ok(header, output.emission.text);
        assert.ok(
          !header.includes(' = ') && !header.includes(',') && !header.includes('?'),
          header,
        );
        if (store) assert.ok(!header.includes(language === 'c-like' ? '&&' : ' and '), header);
        else
          assert.ok(header.includes(language === 'c-like' ? '&&' : ' and '), output.emission.text);
        for (const [left, right, countValue, result, loads] of [
          [0, 9, 2, 7, 1],
          [3, 0, 2, 7, 2],
          [3, 9, 2, 99, 4],
        ] as const) {
          const bytes = memory();
          bytes.set(0x1000n, left);
          bytes.set(0x1004n, right);
          const observed = execute(
            output.emission,
            new Map([[count.id, BigInt(countValue)]]),
            bytes,
          );
          assert.deepEqual(observed.values, [BigInt(result)]);
          assert.equal(observed.events.filter((event) => event === 'load').length, loads);
        }
      }
    });
  });
