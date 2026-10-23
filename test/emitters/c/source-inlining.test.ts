import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { createOperationContext, entityIdentity } from '../../../src/core/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { recoverTypes, type TypeRecoveryResult } from '../../../src/analysis/types/index.js';
import { IRBuilder, integer, type SSAForm, type Value } from '../../../src/ir/index.js';
import type { EmissionResult } from '../../../src/emitters/model.js';
import { builder, image, provenance, register, slice } from '../../ir/support.js';
import { emit, emittedFormals, execute } from './support.js';

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

const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi'),
  rsi = register('rsi', 64, 0, 'replace_root', 'x86_64:rsi'),
  rdx = register('rdx', 64, 0, 'replace_root', 'x86_64:rdx');
interface DisplacedFields {
  readonly ssa: SSAForm;
  readonly types: TypeRecoveryResult;
  /** The displaced address `node + 0x190`. */
  readonly fields: Value;
}
/** A list walk from `*rdi`: each node gets `node + 0x190` stored at +0 and +8
 * in two statements, its successor read in between, and the walked variable
 * reassigned to that successor. With `escaped`, the displaced address is also
 * stored as a value. */
function displacedFields(escaped: boolean): DisplacedFields {
  const b = builder(`rematerialized-address-${escaped}`),
    entry = b.block('entry'),
    loop = b.block('loop'),
    exit = b.block('exit');
  entry.writeRegister(rdx, entry.load(i64, entry.readRegister(rdi)));
  entry.jump(loop);
  const node = loop.readRegister(rdx);
  const fields = loop.int('add', node, loop.constant(i64, 0x190n));
  loop.store(fields, loop.constant(i64, 0n));
  const next = loop.load(i64, node);
  loop.store(
    loop.int('add', fields, loop.constant(i64, 8n)),
    loop.cast('truncate', i32, loop.readRegister(rsi)),
  );
  if (escaped) loop.store(loop.readRegister(rdi), fields);
  loop.writeRegister(rdx, next);
  loop.branch(loop.compare('ne', next, loop.constant(i64, 0n)), loop.edge(loop), loop.edge(exit));
  exit.return([]);
  const ssa = constructSSA(b.finish(entry, [])).value as SSAForm;
  const types = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), {
    slice_id: slice,
    image_id: image,
    revision: 1,
  });
  return { ssa, types, fields };
}
/** `*0x1000` heads a list of nodes at `nodes`; every other byte is patterned. */
function listMemory(nodes: readonly bigint[]): Map<bigint, number> {
  const bytes = new Map<bigint, number>();
  for (let offset = 0n; offset < 0x800n; offset++)
    bytes.set(0x1000n + offset, Number((offset * 37n + 11n) & 0xffn));
  const pointer = (at: bigint, value: bigint): void => {
    for (let byte = 0n; byte < 8n; byte++)
      bytes.set(at + byte, Number((value >> (8n * byte)) & 0xffn));
  };
  pointer(0x1000n, nodes[0]!);
  nodes.forEach((node, index) => pointer(node, nodes[index + 1] ?? 0n));
  return bytes;
}

for (const language of ['c-like', 'python-like'] as const)
  describe(`address rematerialization ${language}`, () => {
    const render = (
      program: DisplacedFields,
      view: 'source' | 'checked' = 'source',
    ): EmissionResult =>
      emit(
        program.ssa,
        { types: program.types, source: { abi: sysvAMD64Abi, callees: [], addresses: [] } },
        language,
        view,
      );
    const run = (output: EmissionResult, bytes: Map<bigint, number>) => {
      const [head, value] = emittedFormals(output.emission);
      return execute(
        output.emission,
        new Map([
          ...head!.semantic_ids.map((id) => [id, 0x1000n] as const),
          ...value!.semantic_ids.map((id) => [id, 0x1234_5678_9an] as const),
        ]),
        bytes,
      );
    };
    test('a displaced address read only as store addresses prints at each access, through a reassigned base', () => {
      const program = displacedFields(false),
        output = render(program),
        checked = render(program, 'checked'),
        text = output.emission.text;
      assert.ok(!named(output, program.fields), text);
      assert.ok(
        output.emission.local_validation?.some(
          (record) => record.rule === 'address_rematerialization',
        ),
        text,
      );
      if (language === 'c-like')
        assert.match(text, /(\w+)->field_0x190 = 0;\n.*\n\s*\1->field_0x198 = arg1;/, text);
      // Two nodes; a node at `first + 0x190` whose link the first store clears;
      // the second node's +0x198 field missing (a fault after earlier effects).
      const fault = listMemory([0x1100n, 0x1300n]);
      fault.delete(0x1300n + 0x19an);
      for (const bytes of [listMemory([0x1100n, 0x1300n]), listMemory([0x1100n, 0x1290n]), fault]) {
        const actual = run(output, new Map(bytes)),
          expected = run(checked, new Map(bytes));
        assert.equal(actual.exit, expected.exit, text);
        assert.deepEqual(actual.events, expected.events, text);
        assert.deepEqual(actual.memory, expected.memory, text);
      }
      const observed = run(output, listMemory([0x1100n, 0x1290n]));
      // The aliased link was cleared before it was read: the walk stops there.
      assert.deepEqual(observed.events, [
        'load',
        'store',
        'load',
        'store',
        'store',
        'load',
        'store',
      ]);
      assert.equal(observed.memory.get(0x1290n + 0x198n), 0x9a);
      assert.equal(observed.memory.get(0x1100n + 0x190n), 0);
      assert.equal(run(output, fault).exit, 'fault');
    });

    test('a displaced address also stored as a value stays a variable', () => {
      const program = displacedFields(true),
        output = render(program);
      assert.ok(named(output, program.fields), output.emission.text);
      const bytes = listMemory([0x1100n, 0x1300n]);
      const actual = run(output, new Map(bytes)),
        expected = run(render(program, 'checked'), new Map(bytes));
      assert.deepEqual(actual.events, expected.events);
      assert.deepEqual(actual.memory, expected.memory);
    });
  });

/** `*a += d; *b ^= *a; return *a + *b;` with every access a separate load. With
 * `barrier`, a call precedes the last reload of `*a`, or the last load reads
 * `a + 8` after only a byte store there. */
function aliasing(barrier?: 'call' | 'narrow') {
  const b = program(`nonfaulting-reload-${barrier ?? 'plain'}`),
    entry = b.block('entry', [i64, i64, i64]);
  const [first, second, delta] = entry.parameters as [Value, Value, Value];
  entry.store(first, entry.int('add', entry.load(i64, first), delta));
  const reload = entry.load(i64, first);
  entry.store(second, entry.int('xor', entry.load(i64, second), reload));
  if (barrier === 'call')
    entry.call(
      { kind: 'direct', address: { image_id: image, space: 'va', value: 0x4000n } },
      [],
      [],
      { registers: [], flags: [], memory: 'unknown_read_write' },
    );
  let last = first;
  if (barrier === 'narrow') {
    last = entry.int('add', first, entry.constant(i64, 8n));
    entry.store(last, entry.constant(i8, 0x5an));
  }
  last = entry.load(i64, last);
  entry.return([entry.int('add', last, entry.load(i64, second))]);
  return { input: b.finish(entry, [i64]), first, second, delta, reloads: [reload, last] };
}
/** Little-endian u64 cells at each address; an address absent from `words` is unmapped. */
function words(cells: readonly (readonly [bigint, bigint])[]): Map<bigint, number> {
  const bytes = new Map<bigint, number>();
  for (const [address, value] of cells)
    for (let byte = 0n; byte < 8n; byte++)
      bytes.set(address + byte, Number((value >> (8n * byte)) & 0xffn));
  return bytes;
}

for (const language of ['c-like', 'python-like'] as const)
  describe(`non-faulting reloads ${language}`, () => {
    const render = (input: SSAForm, view: 'source' | 'checked' = 'source'): EmissionResult =>
      emit(input, { source }, language, view);
    const mask = (1n << 64n) - 1n;
    test('a reload of a just-accessed address moves across independent loads, also when the pointers alias', () => {
      const { input, first, second, delta, reloads } = aliasing(),
        output = render(input),
        checked = render(input, 'checked'),
        text = output.emission.text;
      for (const reload of reloads) assert.ok(!named(output, reload), text);
      const rules = (output.emission.local_validation ?? []).map((record) => record.rule);
      assert.ok(rules.includes('nonfaulting_load_order'), text);
      assert.ok(
        output.emission.requirements?.some(
          (requirement) =>
            requirement.kind === 'abi_conformance' &&
            requirement.explanation.includes('does not fault'),
        ),
        text,
      );
      const a0 = 0xfedc_ba98_7654_3210n,
        b0 = 0x0123_4567_89ab_cdefn,
        d = 0x1111_2222_3333_4444n;
      for (const [left, right, expected] of [
        // Distinct objects: *a = a0 + d; *b = b0 ^ *a; *a + *b.
        [0x1000n, 0x2000n, ((a0 + d) & mask) + (b0 ^ ((a0 + d) & mask))],
        // a == b: the xor clears the shared cell, which the last reload observes.
        [0x1000n, 0x1000n, 0n],
      ] as const) {
        const inputs = new Map([
          [first.id, left],
          [second.id, right],
          [delta.id, d],
        ]);
        const bytes = (): Map<bigint, number> =>
          words(
            left === right
              ? [[left, a0]]
              : [
                  [left, a0],
                  [right, b0],
                ],
          );
        const actual = execute(output.emission, inputs, bytes()),
          oracle = execute(checked.emission, inputs, bytes());
        assert.deepEqual(actual.values, [expected & mask], text);
        assert.deepEqual(actual.values, oracle.values, text);
        assert.deepEqual(actual.memory, oracle.memory, text);
      }
    });

    test('faults keep their order: the first access faults before any effect, a later fault after the earlier store', () => {
      const { input, first, second, delta } = aliasing(),
        output = render(input),
        checked = render(input, 'checked'),
        text = output.emission.text;
      const inputs = new Map([
        [first.id, 0x1000n],
        [second.id, 0x2000n],
        [delta.id, 5n],
      ]);
      // `*a` unmapped: its first load faults with nothing written.
      for (const result of [output, checked]) {
        const fault = execute(result.emission, inputs, words([[0x2000n, 7n]]));
        assert.equal(fault.exit, 'fault', text);
        assert.deepEqual(fault.events, ['load'], text);
        assert.deepEqual(fault.memory, words([[0x2000n, 7n]]), text);
      }
      // `*b` unmapped: the fault follows the completed store to `*a`, and the
      // reload of `*a` (which cannot fault) adds no fault of its own.
      const actual = execute(output.emission, inputs, words([[0x1000n, 2n]])),
        oracle = execute(checked.emission, inputs, words([[0x1000n, 2n]]));
      assert.equal(actual.exit, 'fault', text);
      assert.equal(oracle.exit, 'fault', text);
      assert.deepEqual(actual.memory, words([[0x1000n, 7n]]), text);
      assert.deepEqual(actual.memory, oracle.memory, text);
      assert.deepEqual(actual.events.slice(0, 2), ['load', 'store'], text);
      assert.ok(
        actual.events.slice(2).every((event) => event === 'load'),
        text,
      );
    });

    test('a call or only a narrower access before a reload keeps it a statement', () => {
      for (const barrier of ['call', 'narrow'] as const) {
        const { input, first, second, delta, reloads } = aliasing(barrier),
          output = render(input),
          text = output.emission.text;
        assert.ok(!named(output, reloads[0]!), `${barrier}\n${text}`);
        assert.ok(named(output, reloads[1]!), `${barrier}\n${text}`);
        if (barrier === 'call') continue;
        const inputs = new Map([
          [first.id, 0x1000n],
          [second.id, 0x2000n],
          [delta.id, 1n],
        ]);
        const bytes = (): Map<bigint, number> =>
          words([
            [0x1000n, 0x100n],
            [0x1008n, 0x77n],
            [0x2000n, 3n],
          ]);
        const actual = execute(output.emission, inputs, bytes()),
          oracle = execute(render(input, 'checked').emission, inputs, bytes());
        assert.deepEqual(actual.values, oracle.values, text);
        assert.deepEqual(actual.memory, oracle.memory, text);
        assert.deepEqual(actual.events, oracle.events, text);
      }
    });
  });
