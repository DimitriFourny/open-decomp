import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { entityIdentity } from '../../../src/core/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { IRBuilder, integer, type SSAForm } from '../../../src/ir/index.js';
import { builder, image, provenance, register, slice } from '../../ir/support.js';
import { emit as render, execute } from './support.js';

const i1 = integer(1), i8 = integer(8), i32 = integer(32), i64 = integer(64);
function program(name: string): IRBuilder<'ssa'> { return new IRBuilder(slice, entityIdentity(slice, 'function', name), provenance, 'ssa'); }
function memory(): Map<bigint, number> { return new Map(Array.from({ length: 16 }, (_, index) => [0x1000n + BigInt(index), 0])); }

for (const language of ['c-like', 'python-like'] as const) describe(language, () => {
const emit: typeof render = (input, extra) => render(input, extra, language);
test('emitted loop labels and simultaneous backedge swaps preserve observable effects', () => {
  const b = program('emitted-loop-swaps'), entry = b.block('entry', [i32]), loop = b.block('loop', [i32, i32, i32]), exit = b.block('exit', [i32, i32]);
  entry.jump(loop, [entry.parameters[0]!, entry.constant(i32, 3n), entry.constant(i32, 8n)]);
  const address = loop.constant(i64, 0x1000n), count = loop.load(i32, address);
  loop.store(address, loop.int('add', count, loop.constant(i32, 1n)));
  loop.branch(loop.compare('eq', loop.parameters[0]!, loop.constant(i32, 0n)), loop.edge(exit, [loop.parameters[1]!, loop.parameters[2]!]), loop.edge(loop, [loop.int('sub', loop.parameters[0]!, loop.constant(i32, 1n)), loop.parameters[2]!, loop.parameters[1]!]));
  exit.return(exit.parameters);
  const output = emit(b.finish(entry, [i32, i32]));
  for (const count of [0n, 1n, 2n, 3n, 6n]) {
    const observation = execute(output.emission.text, new Map([[entry.parameters[0]!.id, count]]), memory());
    assert.deepEqual(observation.values, count % 2n === 0n ? [3n, 8n] : [8n, 3n]);
    assert.equal(observation.memory.get(0x1000n), Number(count + 1n));
    assert.deepEqual(observation.events, Array.from({ length: Number(count + 1n) }, () => ['load', 'store']).flat());
  }
});

test('inner switch break cannot redirect a transfer out of its enclosing machine loop', () => {
  const b = program('emitted-switch-loop'), entry = b.block('entry', [i32]), loop = b.block('loop', [i32]), step = b.block('step', [i32]), exit = b.block('exit', [i32]);
  entry.jump(loop, [entry.parameters[0]!]);
  loop.terminate({ kind: 'switch', value: loop.parameters[0]!, cases: [{ bits: 0n, edge: loop.edge(exit, [loop.constant(i32, 77n)]) }, { bits: 2n, edge: loop.edge(exit, [loop.constant(i32, 88n)]) }], otherwise: loop.edge(step, loop.parameters) });
  step.store(step.constant(i64, 0x1000n), step.parameters[0]!);
  step.jump(loop, [step.int('sub', step.parameters[0]!, step.constant(i32, 1n))]); exit.return(exit.parameters);
  const output = emit(b.finish(entry, [i32]));
  for (const [input, expected, writes] of [[0n, 77n, 0], [1n, 77n, 1], [2n, 88n, 0], [4n, 88n, 2]] as const) {
    const result = execute(output.emission.text, new Map([[entry.parameters[0]!.id, input]]), memory());
    assert.deepEqual(result.values, [expected]); assert.equal(result.events.length, writes);
  }
});

test('irreducible flow, nested if arms and per-edge switch arguments execute emitted control rather than IR', () => {
  const b = program('emitted-irreducible'), entry = b.block('entry', [i1, i32]), left = b.block('left', [i32]), right = b.block('right', [i32]), exit = b.block('exit', [i32]);
  entry.branch(entry.parameters[0]!, entry.edge(left, [entry.parameters[1]!]), entry.edge(right, [entry.parameters[1]!]));
  for (const [block, other, marker] of [[left, right, 11n], [right, left, 22n]] as const) {
    block.store(block.constant(i64, 0x1000n), block.constant(i32, marker));
    const next = block.int('sub', block.parameters[0]!, block.constant(i32, 1n));
    block.branch(block.compare('eq', next, block.constant(i32, 0n)), block.edge(exit, [block.constant(i32, marker)]), block.edge(other, [next]));
  }
  exit.return(exit.parameters);
  const output = emit(b.finish(entry, [i32]));
  for (const start of [0n, 1n]) for (const count of [1n, 2n, 5n]) {
    const result = execute(output.emission.text, new Map([[entry.parameters[0]!.id, start], [entry.parameters[1]!.id, count]]), memory());
    const leftLast = (start === 1n) === (count % 2n === 1n);
    assert.deepEqual(result.values, [leftLast ? 11n : 22n]); assert.equal(result.memory.get(0x1000n), leftLast ? 11 : 22);
  }
});

test('partial-register call clobbers, stores, fault ordering and physical returns survive empty formal signatures', () => {
  const b = builder('emitted-physical-call'), entry = b.block('entry');
  const rax = register('rax', 64, 0, 'replace_root'), ah = register('ah', 8, 8);
  entry.writeRegister(rax, entry.constant(i64, 0x1122334455667700n));
  entry.call({ kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } }, [], [], { registers: [ah], flags: [], memory: 'unknown_read_write' });
  entry.store(entry.constant(i64, 0x1000n), entry.readRegister(rax), { endian: 'big', alignment: 8, volatile: true }); entry.return();
  const converted = constructSSA(b.finish(entry)); assert.equal(converted.state, 'complete'); assert.equal(converted.value.form, 'ssa');
  const ir = converted.value as SSAForm, output = emit(ir);
  const inputs = new Map(ir.blocks.find(block => block.id === ir.entry)!.parameters.map(value => [value.id, 0n]));
  const result = execute(output.emission.text, inputs, memory(), 0x100n);
  assert.deepEqual(result.values, []); assert.deepEqual(result.registers.get(rax.root), { bits: 0x1122334455667800n, known: 0xffffffffffffffffn });
  assert.deepEqual([...result.memory.values()].slice(0, 8), [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x78, 0]);
  assert.deepEqual(result.events, ['call', 'store']);
  const fault = execute(output.emission.text, inputs, new Map(), 0x100n);
  assert.equal(fault.exit, 'fault'); assert.deepEqual(fault.events, ['call', 'store']);
});

test('unknown effects and each physical exit family are observable and not interchanged', () => {
  for (const mode of ['effect', 'unknown', 'trap', 'indirect'] as const) {
    const b = program(`emitted-boundary-${mode}`), entry = b.block('entry');
    if (mode === 'effect') { entry.unknown('unmodeled instruction', { registers: [], flags: [], memory: 'unknown_read_write' }); entry.store(entry.constant(i64, 0x1000n), entry.constant(i8, 99n)); entry.return(); }
    else if (mode === 'indirect') entry.terminate({ kind: 'indirect', target: entry.constant(i64, 0xabcden), reason: 'unresolved jump' });
    else entry.terminate({ kind: mode, reason: 'explicit boundary' });
    const result = execute(emit(b.finish(entry)).emission.text, new Map(), memory());
    assert.equal(result.exit, mode === 'effect' ? 'unknown' : `${mode}_exit`);
    assert.equal(result.memory.get(0x1000n), 0);
    assert.deepEqual(result.events, mode === 'effect' ? ['unknown'] : []);
  }
});

test('direct and indirect calls retain targets, explicit operands, results and one-element effect tuples', () => {
  const b = program('emitted-call-operands'), entry = b.block('entry', [i64]);
  const clobbers = { registers: [], flags: [], memory: 'unknown_read_write' as const };
  entry.call({ kind: 'direct', address: { image_id: image, space: 'va', value: 0x1234n } }, [], [], clobbers);
  const results = entry.call({ kind: 'indirect', value: entry.parameters[0]! }, [entry.constant(i32, 42n), entry.constant(i64, 99n)], [i32, i64], clobbers);
  entry.store(entry.constant(i64, 0x1000n), results[0]!); entry.return(results);
  const output = emit(b.finish(entry, [i32, i64]));
  const observation = execute(output.emission.text, new Map([[entry.parameters[0]!.id, 0x5678n]]), memory(), 7n);
  assert.deepEqual(observation.calls, [{ target: 0x1234n, arguments: [] }, { target: 0x5678n, arguments: [42n, 99n] }]);
  assert.deepEqual(observation.values, [7n, 7n]); assert.deepEqual(observation.events, ['call', 'call', 'store']);
  assert.equal(observation.memory.get(0x1000n), 7);
});
test('required memory alignment faults before later stores or successful return', () => {
  const b = program('emitted-alignment-fault'), entry = b.block('entry');
  entry.store(entry.constant(i64, 0x1000n), entry.constant(i32, 9n));
  const loaded = entry.load(i32, entry.constant(i64, 0x1001n), { endian: 'little', alignment: 4, volatile: true });
  entry.store(entry.constant(i64, 0x1008n), entry.constant(i32, 77n));
  entry.return([loaded]);
  const result = execute(emit(b.finish(entry, [i32])).emission.text, new Map(), memory());
  assert.equal(result.exit, 'fault');
  assert.deepEqual(result.events, ['store', 'load']);
  assert.equal(result.memory.get(0x1000n), 9);
  assert.equal(result.memory.get(0x1008n), 0);
});

test('indeterminate arithmetic and conditional values never choose a switch default', () => {
  for (const kind of ['arithmetic', 'select'] as const) {
    const b = program(`emitted-unknown-match-${kind}`), entry = b.block('entry'), yes = b.block('yes'), no = b.block('no');
    const value = kind === 'arithmetic'
      ? entry.int('add', entry.indeterminate(i32, 'unknown', 'unavailable input'), entry.constant(i32, 1n))
      : entry.select(entry.indeterminate(i1, 'undefined', 'undefined flag'), entry.constant(i32, 0n), entry.constant(i32, 1n));
    entry.terminate({ kind: 'switch', value, cases: [{ bits: 0n, edge: entry.edge(yes) }], otherwise: entry.edge(no) });
    yes.store(yes.constant(i64, 0x1000n), yes.constant(i8, 11n)); yes.return();
    no.store(no.constant(i64, 0x1000n), no.constant(i8, 22n)); no.return();
    const result = execute(emit(b.finish(entry)).emission.text, new Map(), memory());
    assert.equal(result.exit, 'unknown');
    assert.deepEqual(result.events, []);
    assert.equal(result.memory.get(0x1000n), 0);
  }
});
});
