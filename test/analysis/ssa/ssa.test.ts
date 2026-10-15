import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../../src/core/index.js';
import { constructSSA, RegisterSSAConstruction } from '../../../src/analysis/ssa/index.js';
import { integer, successors, verifyIR } from '../../../src/ir/index.js';
import { builder, register, returned } from '../../ir/support.js';
import { equivalent, forms } from './support.js';

const i1 = integer(1), i8 = integer(8), i32 = integer(32), i64 = integer(64);
const r = register('opaque-root', 64, 0, 'replace_root', 'unusual-register-root');
const counter = register('count', 32, 0, 'replace_root', 'opaque-counter', 32);

test('architectural state joins retain both arms and an untouched entry register', () => {
  const ir = builder('ssa-register-diamond');
  const entry = ir.block('entry', [i1]), yes = ir.block('yes'), no = ir.block('no'), join = ir.block('join');
  entry.branch(entry.parameters[0]!, entry.edge(yes), entry.edge(no));
  yes.writeRegister(r, yes.constant(i64, 7n)); yes.jump(join);
  no.writeRegister(r, no.int('add', no.readRegister(r), no.constant(i64, 2n))); no.jump(join);
  join.return([join.readRegister(r)]);
  const program = ir.finish(entry, [i64]);
  for (const condition of [0n, 1n]) {
    const result = equivalent(program, { arguments: [condition], registers: new Map([[r.root, 40n]]) });
    assert.deepEqual(returned(result.original), [condition === 0n ? 42n : 7n]);
    assert.ok(result.ssa.blocks.every(block => block.instructions.every(node => node.kind !== 'read_register' && node.kind !== 'write_register')));
    for (const block of result.ssa.blocks) for (const edge of successors(block.terminator)) assert.equal(edge.arguments.length, result.ssa.blocks.find(target => target.id === edge.target)!.parameters.length);
  }
});

test('register loop has simultaneous backedge state and wrapping accumulation', () => {
  const ir = builder('ssa-register-loop');
  const entry = ir.block('entry', [i32]), loop = ir.block('loop'), body = ir.block('body'), exit = ir.block('exit');
  entry.writeRegister(counter, entry.parameters[0]!); entry.writeRegister(r, entry.constant(i64, 0xffffffffffffffffn)); entry.jump(loop);
  loop.branch(loop.compare('eq', loop.readRegister(counter), loop.constant(i32, 0n)), loop.edge(exit), loop.edge(body));
  body.writeRegister(r, body.int('add', body.readRegister(r), body.cast('zero_extend', i64, body.readRegister(counter))));
  body.writeRegister(counter, body.int('sub', body.readRegister(counter), body.constant(i32, 1n))); body.jump(loop);
  exit.return([exit.readRegister(r)]);
  const program = ir.finish(entry, [i64]);
  for (const n of [0n, 1n, 2n, 9n]) {
    const result = equivalent(program, { arguments: [n] });
    assert.deepEqual(returned(result.original), [BigInt.asUintN(64, n * (n + 1n) / 2n - 1n)]);
  }
});

test('irreducible two-entry cycle uses the same explicit cell interface', () => {
  const ir = builder('ssa-irreducible');
  const entry = ir.block('entry', [i1]), a = ir.block('a'), b = ir.block('b'), exit = ir.block('exit');
  entry.writeRegister(counter, entry.constant(i32, 4n)); entry.branch(entry.parameters[0]!, entry.edge(a), entry.edge(b));
  for (const [block, other] of [[a, b], [b, a]] as const) {
    const next = block.int('sub', block.readRegister(counter), block.constant(i32, 1n)); block.writeRegister(counter, next);
    block.branch(block.compare('eq', next, block.constant(i32, 0n)), block.edge(exit), block.edge(other));
  }
  exit.return([exit.readRegister(counter)]);
  const program = ir.finish(entry, [i32]);
  for (const condition of [0n, 1n]) assert.deepEqual(returned(equivalent(program, { arguments: [condition] }).original), [0n]);
});

test('partial writes, zero extensions, zero registers and typed reads preserve architectural bits', () => {
  const ir = builder('ssa-register-slices'); const b = ir.block('entry');
  const low = { ...r, id: 'byte-low', width_bits: 8, write_rule: 'preserve_other_bits' as const };
  const high = { ...low, id: 'byte-high', offset_bits: 8 };
  const half = { ...r, id: 'half', width_bits: 32, write_rule: 'zero_extend_root' as const };
  const zero = { ...r, id: 'zero', root: 'opaque-zero', role: 'zero' as const, write_rule: 'discard' as const };
  b.writeRegister(r, b.constant(i64, 0x123456789abcdef0n));
  b.writeRegister(high, b.constant(i8, 0x11n)); const before = b.readRegister(r);
  b.writeRegister(half, b.constant(i32, 0x87654321n)); b.writeRegister(low, b.constant(i8, 0xffn));
  b.writeRegister(zero, b.constant(i64, 99n));
  b.return([before, b.readRegister(r), b.readRegister(zero)]);
  assert.deepEqual(returned(equivalent(ir.finish(b, [i64, i64, i64])).original), [0x123456789abc11f0n, 0x876543ffn, 0n]);
});

test('dead assignments cannot erase final register state when explicit return is empty', () => {
  const ir = builder('ssa-final-state'); const b = ir.block('entry');
  b.writeRegister(r, b.constant(i64, 17n)); b.int('mul', b.constant(i64, 8n), b.constant(i64, 9n)); b.return();
  const { original, optimized } = equivalent(ir.finish(b));
  assert.equal(original.registers.get(r.root)!.bits, 17n);
  const state = optimized.register_states[0]!;
  assert.ok(state.exit.length > 0);
  assert.ok(optimized.blocks[0]!.instructions.some(node => node.kind === 'assign' && node.expression.kind === 'constant' && node.expression.bits === 17n));
  assert.ok(!optimized.blocks[0]!.instructions.some(node => node.kind === 'assign' && node.expression.kind === 'integer' && node.expression.op === 'mul'));
});

test('unreachable components construct valid SSA but disappear only in optimization', () => {
  const ir = builder('ssa-unreachable'); const entry = ir.block('entry'), dead = ir.block('dead');
  entry.writeRegister(r, entry.constant(i64, 11n)); entry.return();
  dead.writeRegister(r, dead.int('add', dead.readRegister(r), dead.constant(i64, 1n))); dead.jump(dead);
  const result = equivalent(ir.finish(entry));
  assert.equal(result.ssa.blocks.length, 2); assert.equal(result.optimized.blocks.length, 1);
  assert.equal(result.optimized.register_states.length, 1);
});

test('construction budgets return original valid IR explicitly, cancellation is partial', () => {
  const ir = builder('ssa-budget'); const b = ir.block('entry'); b.return([b.readRegister(r)]); const program = ir.finish(b, [i64]);
  const limited = constructSSA(program, { max_work: 0 });
  assert.equal(limited.state, 'partial'); assert.equal(limited.value, program); assert.equal(limited.diagnostics[0]!.code, 'resource_limit');
  const controller = new AbortController(); controller.abort();
  const cancelled = constructSSA(program, { checkpoint: createOperationContext({ signal: controller.signal }).checkpoint });
  assert.equal(cancelled.state, 'partial'); assert.equal(cancelled.diagnostics[0]!.code, 'cancelled');
  assert.deepEqual(verifyIR(limited.value), []);
  assert.deepEqual(verifyIR(new RegisterSSAConstruction().construct(program, () => {})), []);
});

test('deterministic construction preserves existing definition identities and source provenance', () => {
  const ir = builder('ssa-provenance'); const b = ir.block('entry');
  b.source({ instruction_ids: [], ranges: [], evidence_ids: [], synthetic: ['write-origin'] });
  b.writeRegister(r, b.constant(i64, 9n));
  b.source({ instruction_ids: [], ranges: [], evidence_ids: [], synthetic: ['read-origin'] });
  const result = b.readRegister(r); b.return([result]); const program = ir.finish(b, [i64]);
  assert.deepEqual(constructSSA(program).value, constructSSA(program).value);
  const { ssa, optimized } = forms(program);
  assert.ok(ssa.blocks[0]!.instructions.some(node => node.kind === 'assign' && node.result.id === result.id));
  const origins = optimized.blocks.flatMap(block => [block.provenance, block.terminator.provenance, ...block.instructions.map(node => node.provenance)]).flatMap(origin => origin.synthetic);
  assert.ok(origins.includes('write-origin')); assert.ok(origins.includes('read-origin'));
});
