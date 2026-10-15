import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, entityIdentity } from '../../src/core/index.js';
import type { CallClobbers } from '../../src/core/index.js';
import { IRBuilder, OracleMemory, OracleMemoryFault, assertValidIR, evaluateIR, integer, verifyIR } from '../../src/ir/index.js';
import { builder, image, provenance, register, returned, slice } from './support.js';

const i1 = integer(1), i32 = integer(32), i64 = integer(64);
const unknownClobbers: CallClobbers = { registers: [], flags: [], memory: 'unknown_read_write' };

test('diamond joins use typed parameters, never predecessor-local implicit references', () => {
  const ir = new IRBuilder(slice, entityIdentity(slice, 'function', 'diamond'), provenance, 'ssa');
  const entry = ir.block('entry', [i1]), yes = ir.block('yes'), no = ir.block('no'), join = ir.block('join', [i32]);
  entry.branch(entry.parameters[0]!, entry.edge(yes), entry.edge(no));
  yes.jump(join, [yes.constant(i32, 42n)]); no.jump(join, [no.constant(i32, 7n)]);
  join.return([join.parameters[0]!]);
  const program = ir.finish(entry, [i32]);
  assert.deepEqual(returned(evaluateIR(program, { arguments: [1n] })), [42n]);
  assert.deepEqual(returned(evaluateIR(program, { arguments: [0n] })), [7n]);
  assert.deepEqual(verifyIR(program), []);
});

test('loop backedges pass values simultaneously and ordered memory loads evaluate aliasing', () => {
  const ir = builder('sum-loop');
  const entry = ir.block('entry', [i64, i32]), loop = ir.block('loop', [i64, i32, i32]), body = ir.block('body', [i64, i32, i32]), exit = ir.block('exit', [i32]);
  entry.jump(loop, [entry.parameters[0]!, entry.parameters[1]!, entry.constant(i32, 0n)]);
  loop.branch(loop.compare('eq', loop.parameters[1]!, loop.constant(i32, 0n)), loop.edge(exit, [loop.parameters[2]!]), loop.edge(body, loop.parameters));
  const word = body.load(i32, body.parameters[0]!);
  body.jump(loop, [body.int('add', body.parameters[0]!, body.constant(i64, 4n)), body.int('sub', body.parameters[1]!, body.constant(i32, 1n)), body.int('add', body.parameters[2]!, word)]);
  exit.return([exit.parameters[0]!]);
  const program = ir.finish(entry, [i32]);
  const memory = new OracleMemory([{ base: 0x1000n, bytes: new Uint8Array(16), writable: true }]);
  [1n, 7n, 19n, 0xffffffffn].forEach((value, index) => memory.write(0x1000n + BigInt(index * 4), 32, value));
  assert.deepEqual(returned(evaluateIR(program, { arguments: [0x1000n, 4n], memory: memory.snapshot(), context: createOperationContext() })), [26n]);
  assert.deepEqual(returned(evaluateIR(program, { arguments: [0x1000n, 0n] })), [0n]);
  const limited = evaluateIR(program, { arguments: [0x1000n, 4n], memory: memory.snapshot(), max_steps: 10 });
  assert.equal(limited.status, 'step_limit'); assert.equal(limited.steps, 10);
});

test('memory ordering preserves overlapping writes, endian and volatile read trace', () => {
  const ir = builder('aliasing'); const b = ir.block('entry');
  const address = b.constant(i64, 0x1000n);
  b.store(address, b.constant(i32, 0x11223344n));
  b.store(b.int('add', address, b.constant(i64, 1n)), b.constant(integer(16), 0xaabbn), { endian: 'big', alignment: 1, volatile: true });
  const little = b.load(i32, address), big = b.load(i32, address, { endian: 'big', alignment: 4, volatile: true });
  b.return([little, big]);
  const program = ir.finish(b, [i32, i32]);
  const result = evaluateIR(program, { memory: [{ base: 0x1000n, bytes: new Uint8Array(4), writable: true }] });
  assert.deepEqual(returned(result), [0x11bbaa44n, 0x44aabb11n]);
  assert.deepEqual(result.effect_trace, program.blocks[0]!.instructions.filter(node => 'effect_in' in node).map(node => node.id));
  assert.deepEqual([...result.memory[0]!.bytes], [0x44, 0xaa, 0xbb, 0x11]);
});

test('fixture memory is copied, faults are not traps, stores cannot partially commit', () => {
  const initial = new Uint8Array([1, 2]);
  const memory = new OracleMemory([{ base: 8n, bytes: initial, writable: true }]);
  initial[0] = 99;
  assert.equal(memory.read(8n, 16), 513n);
  assert.throws(() => memory.write(9n, 16, 0xffffn), OracleMemoryFault);
  assert.equal(memory.read(8n, 16), 513n);
  const snapshot = memory.snapshot(); snapshot[0]!.bytes[0] = 99;
  assert.equal(memory.read(8n, 16), 513n);
  const ir = builder('alignment'); const b = ir.block('entry');
  b.return([b.load(i32, b.constant(i64, 9n), { endian: 'little', alignment: 4, volatile: false })]);
  assert.equal(evaluateIR(ir.finish(b, [i32]), { memory: memory.snapshot() }).status, 'memory_fault');
  assert.throws(() => new OracleMemory([{ base: 0n, bytes: new Uint8Array(2), writable: true }, { base: 1n, bytes: new Uint8Array(2), writable: true }]), RangeError);
});

test('unknown effect always stops even if its outputs are unused; established trap is separate', () => {
  const ir = builder('unknown'); const b = ir.block('entry');
  b.unknown('Unsupported instruction with unknown state changes', unknownClobbers);
  b.store(b.constant(i64, 0n), b.constant(i32, 99n)); b.return([]);
  const result = evaluateIR(ir.finish(b), { memory: [{ base: 0n, bytes: new Uint8Array(4), writable: true }] });
  assert.equal(result.status, 'unknown'); assert.deepEqual([...result.memory[0]!.bytes], [0, 0, 0, 0]); assert.equal(result.effect_trace.length, 1);
  const trap = builder('trap'); const c = trap.block('entry'); c.terminate({ kind: 'trap', reason: 'Established architectural trap instruction' });
  assert.equal(evaluateIR(trap.finish(c)).status, 'trap');
  const indirect = builder('indirect'); const d = indirect.block('entry'); d.terminate({ kind: 'indirect', target: d.constant(i64, 0x1000n), reason: 'Target not established' });
  assert.equal(evaluateIR(indirect.finish(d)).status, 'unknown');
});

test('explicit trusted call oracle returns values, mutates memory and invalidates only clobbered slices', () => {
  const ir = builder('call'); const b = ir.block('entry');
  const rax = register('rax', 64, 0, 'replace_root'), al = register('al', 8), high = register('high', 8, 8);
  b.writeRegister(rax, b.constant(i64, 0x1234n));
  const result = b.call({ kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } }, [b.constant(i32, 7n)], [i32], { registers: [al], flags: [], memory: 'unknown_read_write' });
  b.return([result[0]!, b.readRegister(high), b.load(i32, b.constant(i64, 0x1000n))]);
  const program = ir.finish(b, [i32, integer(8), i32]);
  const call = program.blocks[0]!.instructions.find(node => node.kind === 'call')!;
  assert.equal(evaluateIR(program).status, 'unknown');
  const evaluated = evaluateIR(program, {
    memory: [{ base: 0x1000n, bytes: new Uint8Array([5, 0, 0, 0]), writable: true }],
    calls: new Map([[call.id, input => {
      assert.equal(input.target, 0x2000n);
      const value = input.arguments[0]! + input.readMemory(0x1000n, 32);
      return { results: [value], writes: [{ address: 0x1000n, width: 32, bits: value }] };
    }]]),
  });
  assert.deepEqual(returned(evaluated), [12n, 0x12n, 12n]);
  assert.equal(evaluated.registers.get('x86_64:rax')!.known & 255n, 0n);
});

test('physical call oracles preserve nonvolatile slices without inventing formal parameters', () => {
  const ir = builder('physical-call'), b = ir.block('entry');
  const rax = register('rax', 64, 0, 'replace_root'), al = register('al', 8);
  b.writeRegister(rax, b.constant(i64, 0x1234n));
  b.call({ kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } }, [], [], { registers: [al], flags: [], memory: 'unknown_read_write' });
  b.return([b.readRegister(rax)]);
  const program = ir.finish(b, [i64]), call = program.blocks[0]!.instructions.find(node => node.kind === 'call')!;
  const evaluated = evaluateIR(program, { calls: new Map([[call.id, input => ({ results: [], writes: [], register_writes: [{ register: al, bits: input.readRegister(rax) + 1n }] })]]) });
  assert.deepEqual(returned(evaluated), [0x1235n]);
  assert.throws(() => evaluateIR(program, { calls: new Map([[call.id, () => ({ results: [], writes: [], register_writes: [{ register: rax, bits: 7n }] })]]) }), /clobber contract/);
});

test('an oracle zero-extending write cannot alter upper bits outside a partial clobber', () => {
  const ir = builder('oracle-zero-extension'), b = ir.block('entry'), eax = register('eax', 32, 0, 'zero_extend_root');
  b.call({ kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } }, [], [], { registers: [eax], flags: [], memory: 'unknown_read_write' });
  b.return();
  const program = ir.finish(b), call = program.blocks[0]!.instructions.find(node => node.kind === 'call')!;
  assert.throws(() => evaluateIR(program, { calls: new Map([[call.id, () => ({ results: [], writes: [], register_writes: [{ register: eax, bits: 7n }] })]]) }), /clobber contract/);
});

test('switch arms and fallback select exact values; missing arity is rejected', () => {
  const ir = builder('switch'); const b = ir.block('entry', [i32]), one = ir.block('one'), other = ir.block('other');
  b.terminate({ kind: 'switch', value: b.parameters[0]!, cases: [{ bits: 1n, edge: b.edge(one) }], otherwise: b.edge(other) });
  one.return([one.constant(i32, 7n)]); other.return([other.constant(i32, 9n)]);
  const program = ir.finish(b, [i32]);
  assert.deepEqual(returned(evaluateIR(program, { arguments: [1n] })), [7n]); assert.deepEqual(returned(evaluateIR(program, { arguments: [2n] })), [9n]);
  assert.throws(() => evaluateIR(program), TypeError);
  assertValidIR(program);
});
