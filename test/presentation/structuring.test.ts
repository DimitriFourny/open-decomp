import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, entityIdentity } from '../../src/core/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { IRBuilder, evaluateIR, integer } from '../../src/ir/index.js';
import type { SSAForm, TrustedCall } from '../../src/ir/index.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import type { BlockRegion, StructuredFunction } from '../../src/presentation/index.js';
import { builder, image, provenance, register, returned, slice } from '../ir/support.js';
import { equivalent, lower, regions } from './support.js';

const i1 = integer(1), i32 = integer(32), i64 = integer(64);
const memory = [{ base: 0x1000n, bytes: new Uint8Array(8), writable: true }];
const ssa = (name: string): IRBuilder<'ssa'> => new IRBuilder(slice, entityIdentity(slice, 'function', name), provenance, 'ssa');
const blocks = (program: StructuredFunction): BlockRegion[] => regions(program.body).filter((region): region is BlockRegion => region.kind === 'block');

test('diamond owns if/else effects and sequences without duplicating a shared join', () => {
  const b = ssa('structured-diamond');
  const entry = b.block('entry', [i1]), yes = b.block('yes'), yes2 = b.block('yes2', [i32]), no = b.block('no'), join = b.block('join', [i32]);
  entry.branch(entry.parameters[0]!, entry.edge(yes), entry.edge(no));
  yes.store(yes.constant(i64, 0x1000n), yes.constant(i32, 17n)); yes.jump(yes2, [yes.constant(i32, 41n)]);
  yes2.jump(join, [yes2.int('add', yes2.parameters[0]!, yes2.constant(i32, 1n))]);
  no.store(no.constant(i64, 0x1000n), no.constant(i32, 23n)); no.jump(join, [no.constant(i32, 7n)]);
  join.return([join.parameters[0]!]);
  const input = b.finish(entry, [i32]), result = equivalent(input, [{ arguments: [0n], memory }, { arguments: [1n], memory }]);
  const control = blocks(result).find(block => block.id === entry.id)!.control;
  assert.equal(control.kind, 'if');
  if (control.kind !== 'if') return;
  assert.ok(control.when_true.body); assert.ok(control.when_false.body);
  assert.ok(regions(control.when_true.body).some(region => region.kind === 'sequence'));
  assert.equal(blocks(result).filter(block => block.id === join.id).length, 1);
  assert.deepEqual(returned(evaluateIR(lower(result), { arguments: [1n], memory })), [42n]);
});

test('flat successor chains do not consume nesting depth or strand labeled continuations', () => {
  const b = ssa('flat-structured-chain'), chain = Array.from({ length: 64 }, (_, index) => b.block(`step-${index}`));
  chain.forEach((block, index) => {
    const address = block.constant(i64, 0x1000n), value = block.int('add', block.load(i32, address), block.constant(i32, 1n));
    block.store(address, value);
    if (index + 1 < chain.length) block.jump(chain[index + 1]!); else block.return([value]);
  });
  const input = b.finish(chain[0]!, [i32]), result = structureControlFlow(input, createOperationContext(), { max_depth: 4 });
  assert.equal(result.state, 'complete'); assert.ok(result.value);
  assert.ok(blocks(result.value).every(block => block.control.kind !== 'jump' || block.control.transfer.mode === 'next'));
  assert.deepEqual(returned(evaluateIR(input, { memory })), [64n]);
  assert.deepEqual(returned(evaluateIR(lower(result.value), { memory })), [64n]);
});

test('loop header effects repeat, early returns stay inside, and backedge copies swap simultaneously', () => {
  const b = ssa('structured-loop');
  const entry = b.block('entry', [i32]), header = b.block('header', [i32, i32, i32]), body = b.block('body', [i32, i32, i32]), latch = b.block('latch', [i32, i32, i32]), early = b.block('early', [i32]), exit = b.block('exit', [i32, i32]);
  entry.jump(header, [entry.parameters[0]!, entry.constant(i32, 3n), entry.constant(i32, 8n)]);
  const address = header.constant(i64, 0x1000n), count = header.load(i32, address);
  header.store(address, header.int('add', count, header.constant(i32, 1n)));
  header.branch(header.compare('eq', header.parameters[0]!, header.constant(i32, 0n)), header.edge(exit, [header.parameters[1]!, header.parameters[2]!]), header.edge(body, header.parameters));
  body.branch(body.compare('eq', body.parameters[0]!, body.constant(i32, 9n)), body.edge(early, [body.parameters[1]!]), body.edge(latch, body.parameters));
  latch.jump(header, [latch.int('sub', latch.parameters[0]!, latch.constant(i32, 1n)), latch.parameters[2]!, latch.parameters[1]!]);
  early.return([early.parameters[0]!, early.constant(i32, 99n)]); exit.return(exit.parameters);
  const input = b.finish(entry, [i32, i32]);
  const result = equivalent(input, [0n, 1n, 2n, 3n, 9n].map(n => ({ arguments: [n], memory })));
  const loop = regions(result.body).find(region => region.kind === 'loop'); assert.ok(loop); assert.equal(loop.header, header.id);
  const structuredLatch = blocks(result).find(block => block.id === latch.id)!;
  assert.equal(structuredLatch.control.kind, 'jump');
  if (structuredLatch.control.kind === 'jump') { assert.equal(structuredLatch.control.transfer.mode, 'continue'); assert.equal(structuredLatch.control.transfer.copies[1]!.source.id, latch.parameters[2]!.id); }
  const evaluated = evaluateIR(lower(result), { arguments: [3n], memory });
  assert.deepEqual(returned(evaluated), [8n, 3n]); assert.equal(evaluated.memory[0]!.bytes[0], 4);
  assert.deepEqual(returned(evaluateIR(lower(result), { arguments: [9n], memory })), [3n, 99n]);
});

test('nested single-entry loops preserve inner and outer continue destinations', () => {
  const b = ssa('nested-loop');
  const entry = b.block('entry'), outer = b.block('outer', [i32]), inner = b.block('inner', [i32, i32]), innerBody = b.block('inner-body', [i32, i32]), latch = b.block('outer-latch', [i32]), exit = b.block('exit');
  entry.jump(outer, [entry.constant(i32, 2n)]);
  outer.branch(outer.compare('eq', outer.parameters[0]!, outer.constant(i32, 0n)), outer.edge(exit), outer.edge(inner, [outer.parameters[0]!, outer.constant(i32, 3n)]));
  inner.branch(inner.compare('eq', inner.parameters[1]!, inner.constant(i32, 0n)), inner.edge(latch, [inner.parameters[0]!]), inner.edge(innerBody, inner.parameters));
  const address = innerBody.constant(i64, 0x1000n);
  innerBody.store(address, innerBody.int('add', innerBody.load(i32, address), innerBody.constant(i32, 1n)));
  innerBody.jump(inner, [innerBody.parameters[0]!, innerBody.int('sub', innerBody.parameters[1]!, innerBody.constant(i32, 1n))]);
  latch.jump(outer, [latch.int('sub', latch.parameters[0]!, latch.constant(i32, 1n))]);
  exit.return([exit.load(i32, exit.constant(i64, 0x1000n))]);
  const result = equivalent(b.finish(entry, [i32]), [{ memory }]);
  assert.equal(regions(result.body).filter(region => region.kind === 'loop').length, 2);
  assert.deepEqual(returned(evaluateIR(lower(result), { memory })), [6n]);
});

test('irreducible multi-entry cycles remain real labeled paths, including bounded infinite paths', () => {
  const b = ssa('irreducible');
  const entry = b.block('entry', [i1, i32]), left = b.block('left', [i32]), right = b.block('right', [i32]), exit = b.block('exit', [i32]);
  entry.branch(entry.parameters[0]!, entry.edge(left, [entry.parameters[1]!]), entry.edge(right, [entry.parameters[1]!]));
  const leftValue = left.int('sub', left.parameters[0]!, left.constant(i32, 1n));
  left.store(left.constant(i64, 0x1000n), leftValue);
  left.branch(left.compare('eq', leftValue, left.constant(i32, 0n)), left.edge(exit, [leftValue]), left.edge(right, [leftValue]));
  const rightValue = right.int('sub', right.parameters[0]!, right.constant(i32, 1n));
  right.store(right.constant(i64, 0x1004n), rightValue);
  right.branch(right.compare('eq', rightValue, right.constant(i32, 0n)), right.edge(exit, [rightValue]), right.edge(left, [rightValue]));
  exit.return(exit.parameters);
  const result = equivalent(b.finish(entry, [i32]), [0n, 1n].flatMap(side => [0n, 1n, 4n, 7n].map(n => ({ arguments: [side, n], memory, max_steps: 80 }))));
  assert.equal(regions(result.body).filter(region => region.kind === 'loop').length, 0);
  const leftControl = blocks(result).find(block => block.id === left.id)!.control;
  assert.equal(leftControl.kind, 'if');
  if (leftControl.kind === 'if') { assert.equal(leftControl.when_false.transfer.mode, 'goto'); assert.equal(leftControl.when_false.transfer.target, right.id); }
});

test('established switch retains duplicate destinations, per-edge copies and explicit fallback', () => {
  const b = ssa('switch-fallback'), entry = b.block('entry', [i32]), shared = b.block('shared', [i32]), fallback = b.block('fallback');
  entry.terminate({ kind: 'switch', value: entry.parameters[0]!, cases: [{ bits: 1n, edge: entry.edge(shared, [entry.constant(i32, 11n)]) }, { bits: 2n, edge: entry.edge(shared, [entry.constant(i32, 22n)]) }], otherwise: entry.edge(fallback) });
  shared.return(shared.parameters); fallback.terminate({ kind: 'unknown', reason: 'Unestablished table fallback boundary' });
  const result = equivalent(b.finish(entry, [i32]), [0n, 1n, 2n, 0xffffffffn].map(n => ({ arguments: [n] })));
  const control = blocks(result).find(block => block.id === entry.id)!.control;
  assert.equal(control.kind, 'switch');
  if (control.kind !== 'switch') return;
  assert.equal(control.cases.length, 2); assert.equal(control.cases[0]!.arm.transfer.target, shared.id);
  assert.notEqual(control.cases[0]!.arm.transfer.copies[0]!.source.id, control.cases[1]!.arm.transfer.copies[0]!.source.id);
  assert.equal(evaluateIR(lower(result), { arguments: [99n] }).status, 'unknown');
});

test('calls, architectural exit roots and fault snapshots survive without formal returns', () => {
  const b = builder('presentation-physical-effects'), entry = b.block('entry'), exit = b.block('exit');
  const rax = register('rax', 64, 0, 'replace_root');
  entry.writeRegister(rax, entry.constant(i64, 55n));
  entry.call({ kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } }, [], [], { registers: [rax], flags: [], memory: 'unknown_read_write' });
  entry.store(entry.constant(i64, 0x1000n), entry.readRegister(rax)); entry.jump(exit); exit.return();
  const constructed = constructSSA(b.finish(entry)); assert.equal(constructed.value.form, 'ssa');
  if (constructed.value.form !== 'ssa') return;
  const input: SSAForm = constructed.value, call = input.blocks[0]!.instructions.find(node => node.kind === 'call')!;
  const oracle: TrustedCall = args => ({ results: [], writes: [], register_writes: [{ register: rax, bits: args.readRegister(rax) + 7n }] });
  const calls = new Map([[call.id, oracle]]);
  const result = equivalent(input, [{ calls, memory }, { calls }, {}]);
  const evaluated = evaluateIR(lower(result), { calls, memory });
  assert.equal(evaluated.registers.get(rax.root)!.bits, 62n); assert.equal(evaluated.memory[0]!.bytes[0], 62);
  assert.equal(evaluateIR(lower(result), { calls }).status, 'memory_fault');
  assert.ok(blocks(result).some(block => block.register_exit.length > 0));
});

test('unknown effects, traps, indirect and unreachable boundaries never disappear', () => {
  const b = ssa('boundaries'), entry = b.block('entry', [i32]), unknown = b.block('unknown'), trap = b.block('trap'), indirect = b.block('indirect'), unreachable = b.block('unreachable');
  entry.terminate({ kind: 'switch', value: entry.parameters[0]!, cases: [{ bits: 0n, edge: entry.edge(unknown) }, { bits: 1n, edge: entry.edge(trap) }], otherwise: entry.edge(indirect) });
  unknown.unknown('unsupported effect boundary', { registers: [], flags: [], memory: 'unknown_read_write' });
  unknown.store(unknown.constant(i64, 0x1000n), unknown.constant(i32, 99n)); unknown.return();
  trap.terminate({ kind: 'trap', reason: 'established trap' });
  indirect.terminate({ kind: 'indirect', target: indirect.constant(i64, 0x4000n), reason: 'unresolved target' });
  unreachable.jump(unreachable);
  const result = equivalent(b.finish(entry), [0n, 1n, 2n].map(n => ({ arguments: [n], memory })));
  assert.equal(blocks(result).length, 5);
  assert.equal(evaluateIR(lower(result), { arguments: [0n], memory }).memory[0]!.bytes[0], 0);
  assert.equal(regions(result.body).filter(region => region.kind === 'loop').length, 0);
});

test('depth fallback preserves full paths while work and cancellation exhaustion publish no partial tree', () => {
  const b = ssa('bounded-structure'), entry = b.block('entry'), loop = b.block('loop', [i32]), exit = b.block('exit');
  entry.jump(loop, [entry.constant(i32, 1n)]);
  loop.branch(loop.compare('eq', loop.parameters[0]!, loop.constant(i32, 0n)), loop.edge(exit), loop.edge(loop, [loop.constant(i32, 0n)])); exit.return();
  const input = b.finish(entry);
  const result = structureControlFlow(input, createOperationContext(), { max_depth: 1 });
  assert.equal(result.state, 'complete'); assert.ok(result.value);
  assert.equal(regions(result.value.body).filter(region => region.kind === 'loop').length, 0);
  assert.deepEqual(evaluateIR(lower(result.value)), evaluateIR(input));
  const limited = structureControlFlow(input, createOperationContext(), { max_work: 3 });
  assert.equal(limited.state, 'partial'); assert.equal(limited.value, null); assert.equal(limited.diagnostics[0]!.code, 'resource_limit');
  const abort = new AbortController(); abort.abort();
  const cancelled = structureControlFlow(input, createOperationContext({ signal: abort.signal }));
  assert.equal(cancelled.state, 'partial'); assert.equal(cancelled.value, null); assert.equal(cancelled.diagnostics[0]!.code, 'cancelled');
});

test('instruction ranges, evidence and coverage stay attached to semantic identities', () => {
  const b = ssa('presentation-origins'), entry = b.block('entry'), exit = b.block('exit', [i32]);
  const origin = {
    instruction_ids: [entityIdentity(slice, 'instruction', 0x1000n)],
    ranges: [{ start: { image_id: image, space: 'va' as const, value: 0x1000n }, size: 4n }],
    evidence_ids: [`evidence_${'b'.repeat(64)}`], synthetic: [],
  };
  entry.source(origin); entry.jump(exit, [entry.constant(i32, 42n)]); exit.source(origin); exit.return(exit.parameters);
  const input = b.finish(entry, [i32]), result = equivalent(input);
  assert.deepEqual(result.coverage, input.blocks.map(block => ({
    block_id: block.id, statement_ids: block.instructions.map(node => node.id), terminator_id: block.terminator.id,
  })));
  assert.deepEqual(blocks(result).find(block => block.id === entry.id)!.statements[0]!.provenance, origin);
  assert.deepEqual(blocks(result).find(block => block.id === exit.id)!.control.provenance, origin);
});
