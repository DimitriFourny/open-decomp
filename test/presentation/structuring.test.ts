import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, entityIdentity } from '../../src/core/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { IRBuilder, evaluateIR, integer, successors } from '../../src/ir/index.js';
import type { BlockBuilder, SSAForm, TrustedCall, Value } from '../../src/ir/index.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import type {
  BlockRegion,
  ParallelTransfer,
  Region,
  StructuredFunction,
} from '../../src/presentation/index.js';
import { builder, image, provenance, register, returned, slice } from '../ir/support.js';
import { equivalent, lower, regions } from './support.js';

const i1 = integer(1),
  i32 = integer(32),
  i64 = integer(64);
const memory = [{ base: 0x1000n, bytes: new Uint8Array(8), writable: true }];
const ssa = (name: string): IRBuilder<'ssa'> =>
  new IRBuilder(slice, entityIdentity(slice, 'function', name), provenance, 'ssa');
const blocks = (program: StructuredFunction): BlockRegion[] =>
  regions(program.body).filter((region): region is BlockRegion => region.kind === 'block');
const transfers = (program: StructuredFunction): ParallelTransfer[] =>
  blocks(program).flatMap((block) => {
    const control = block.control;
    if (control.kind === 'jump') return [control.transfer];
    if (control.kind === 'if') return [control.when_true.transfer, control.when_false.transfer];
    if (control.kind === 'switch')
      return [...control.cases.map((item) => item.arm.transfer), control.otherwise.transfer];
    return [];
  });

test('diamond owns if/else effects and sequences without duplicating a shared join', () => {
  const b = ssa('structured-diamond');
  const entry = b.block('entry', [i1]),
    yes = b.block('yes'),
    yes2 = b.block('yes2', [i32]),
    no = b.block('no'),
    join = b.block('join', [i32]);
  entry.branch(entry.parameters[0]!, entry.edge(yes), entry.edge(no));
  yes.store(yes.constant(i64, 0x1000n), yes.constant(i32, 17n));
  yes.jump(yes2, [yes.constant(i32, 41n)]);
  yes2.jump(join, [yes2.int('add', yes2.parameters[0]!, yes2.constant(i32, 1n))]);
  no.store(no.constant(i64, 0x1000n), no.constant(i32, 23n));
  no.jump(join, [no.constant(i32, 7n)]);
  join.return([join.parameters[0]!]);
  const input = b.finish(entry, [i32]),
    result = equivalent(input, [
      { arguments: [0n], memory },
      { arguments: [1n], memory },
    ]);
  const control = blocks(result).find((block) => block.id === entry.id)!.control;
  assert.equal(control.kind, 'if');
  if (control.kind !== 'if') return;
  assert.ok(control.when_true.body);
  assert.ok(control.when_false.body);
  assert.ok(regions(control.when_true.body).some((region) => region.kind === 'sequence'));
  assert.equal(blocks(result).filter((block) => block.id === join.id).length, 1);
  assert.deepEqual(returned(evaluateIR(lower(result), { arguments: [1n], memory })), [42n]);
});

test('flat successor chains do not consume nesting depth or strand labeled continuations', () => {
  const b = ssa('flat-structured-chain'),
    chain = Array.from({ length: 64 }, (_, index) => b.block(`step-${index}`));
  chain.forEach((block, index) => {
    const address = block.constant(i64, 0x1000n),
      value = block.int('add', block.load(i32, address), block.constant(i32, 1n));
    block.store(address, value);
    if (index + 1 < chain.length) block.jump(chain[index + 1]!);
    else block.return([value]);
  });
  const input = b.finish(chain[0]!, [i32]),
    result = structureControlFlow(input, createOperationContext(), { max_depth: 4 });
  assert.equal(result.state, 'complete');
  assert.ok(result.value);
  assert.ok(
    blocks(result.value).every(
      (block) => block.control.kind !== 'jump' || block.control.transfer.mode === 'next',
    ),
  );
  assert.deepEqual(returned(evaluateIR(input, { memory })), [64n]);
  assert.deepEqual(returned(evaluateIR(lower(result.value), { memory })), [64n]);
});

test('loop header effects repeat, early returns stay inside, and backedge copies swap simultaneously', () => {
  const b = ssa('structured-loop');
  const entry = b.block('entry', [i32]),
    header = b.block('header', [i32, i32, i32]),
    body = b.block('body', [i32, i32, i32]),
    latch = b.block('latch', [i32, i32, i32]),
    early = b.block('early', [i32]),
    exit = b.block('exit', [i32, i32]);
  entry.jump(header, [entry.parameters[0]!, entry.constant(i32, 3n), entry.constant(i32, 8n)]);
  const address = header.constant(i64, 0x1000n),
    count = header.load(i32, address);
  header.store(address, header.int('add', count, header.constant(i32, 1n)));
  header.branch(
    header.compare('eq', header.parameters[0]!, header.constant(i32, 0n)),
    header.edge(exit, [header.parameters[1]!, header.parameters[2]!]),
    header.edge(body, header.parameters),
  );
  body.branch(
    body.compare('eq', body.parameters[0]!, body.constant(i32, 9n)),
    body.edge(early, [body.parameters[1]!]),
    body.edge(latch, body.parameters),
  );
  latch.jump(header, [
    latch.int('sub', latch.parameters[0]!, latch.constant(i32, 1n)),
    latch.parameters[2]!,
    latch.parameters[1]!,
  ]);
  early.return([early.parameters[0]!, early.constant(i32, 99n)]);
  exit.return(exit.parameters);
  const input = b.finish(entry, [i32, i32]);
  const result = equivalent(
    input,
    [0n, 1n, 2n, 3n, 9n].map((n) => ({ arguments: [n], memory })),
  );
  const loop = regions(result.body).find((region) => region.kind === 'loop');
  assert.ok(loop);
  assert.equal(loop.header, header.id);
  const structuredLatch = blocks(result).find((block) => block.id === latch.id)!;
  assert.equal(structuredLatch.control.kind, 'jump');
  if (structuredLatch.control.kind === 'jump') {
    assert.equal(structuredLatch.control.transfer.mode, 'continue');
    assert.equal(structuredLatch.control.transfer.copies[1]!.source.id, latch.parameters[2]!.id);
  }
  const evaluated = evaluateIR(lower(result), { arguments: [3n], memory });
  assert.deepEqual(returned(evaluated), [8n, 3n]);
  assert.equal(evaluated.memory[0]!.bytes[0], 4);
  assert.deepEqual(returned(evaluateIR(lower(result), { arguments: [9n], memory })), [3n, 99n]);
});

test('nested single-entry loops preserve inner and outer continue destinations', () => {
  const b = ssa('nested-loop');
  const entry = b.block('entry'),
    outer = b.block('outer', [i32]),
    inner = b.block('inner', [i32, i32]),
    innerBody = b.block('inner-body', [i32, i32]),
    latch = b.block('outer-latch', [i32]),
    exit = b.block('exit');
  entry.jump(outer, [entry.constant(i32, 2n)]);
  outer.branch(
    outer.compare('eq', outer.parameters[0]!, outer.constant(i32, 0n)),
    outer.edge(exit),
    outer.edge(inner, [outer.parameters[0]!, outer.constant(i32, 3n)]),
  );
  inner.branch(
    inner.compare('eq', inner.parameters[1]!, inner.constant(i32, 0n)),
    inner.edge(latch, [inner.parameters[0]!]),
    inner.edge(innerBody, inner.parameters),
  );
  const address = innerBody.constant(i64, 0x1000n);
  innerBody.store(
    address,
    innerBody.int('add', innerBody.load(i32, address), innerBody.constant(i32, 1n)),
  );
  innerBody.jump(inner, [
    innerBody.parameters[0]!,
    innerBody.int('sub', innerBody.parameters[1]!, innerBody.constant(i32, 1n)),
  ]);
  latch.jump(outer, [latch.int('sub', latch.parameters[0]!, latch.constant(i32, 1n))]);
  exit.return([exit.load(i32, exit.constant(i64, 0x1000n))]);
  const result = equivalent(b.finish(entry, [i32]), [{ memory }]);
  assert.equal(regions(result.body).filter((region) => region.kind === 'loop').length, 2);
  assert.deepEqual(returned(evaluateIR(lower(result), { memory })), [6n]);
});

test('irreducible multi-entry cycles keep one loop and a real labeled entry, including bounded infinite paths', () => {
  const b = ssa('irreducible');
  const entry = b.block('entry', [i1, i32]),
    left = b.block('left', [i32]),
    right = b.block('right', [i32]),
    exit = b.block('exit', [i32]);
  entry.branch(
    entry.parameters[0]!,
    entry.edge(left, [entry.parameters[1]!]),
    entry.edge(right, [entry.parameters[1]!]),
  );
  const leftValue = left.int('sub', left.parameters[0]!, left.constant(i32, 1n));
  left.store(left.constant(i64, 0x1000n), leftValue);
  left.branch(
    left.compare('eq', leftValue, left.constant(i32, 0n)),
    left.edge(exit, [leftValue]),
    left.edge(right, [leftValue]),
  );
  const rightValue = right.int('sub', right.parameters[0]!, right.constant(i32, 1n));
  right.store(right.constant(i64, 0x1004n), rightValue);
  right.branch(
    right.compare('eq', rightValue, right.constant(i32, 0n)),
    right.edge(exit, [rightValue]),
    right.edge(left, [rightValue]),
  );
  exit.return(exit.parameters);
  const result = equivalent(
    b.finish(entry, [i32]),
    [0n, 1n].flatMap((side) =>
      [0n, 1n, 4n, 7n].map((n) => ({ arguments: [side, n], memory, max_steps: 80 })),
    ),
  );
  // The cycle loops at the entry first in reverse postorder; the other entry
  // is a labeled transfer into the loop body.
  const loops = regions(result.body).filter((region) => region.kind === 'loop');
  assert.deepEqual(
    loops.map((region) => region.kind === 'loop' && region.header),
    [left.id],
  );
  const entryControl = blocks(result).find((block) => block.id === entry.id)!.control;
  assert.equal(entryControl.kind, 'if');
  if (entryControl.kind === 'if') {
    assert.equal(entryControl.when_false.transfer.mode, 'goto');
    assert.equal(entryControl.when_false.transfer.target, right.id);
  }
  const rightControl = blocks(result).find((block) => block.id === right.id)!.control;
  assert.ok(rightControl.kind === 'if' && rightControl.when_false.transfer.mode === 'continue');
});

test('established switch retains duplicate destinations, per-edge copies and explicit fallback', () => {
  const b = ssa('switch-fallback'),
    entry = b.block('entry', [i32]),
    shared = b.block('shared', [i32]),
    fallback = b.block('fallback');
  entry.terminate({
    kind: 'switch',
    value: entry.parameters[0]!,
    cases: [
      { bits: 1n, edge: entry.edge(shared, [entry.constant(i32, 11n)]) },
      { bits: 2n, edge: entry.edge(shared, [entry.constant(i32, 22n)]) },
    ],
    otherwise: entry.edge(fallback),
  });
  shared.return(shared.parameters);
  fallback.terminate({ kind: 'unknown', reason: 'Unestablished table fallback boundary' });
  const result = equivalent(
    b.finish(entry, [i32]),
    [0n, 1n, 2n, 0xffffffffn].map((n) => ({ arguments: [n] })),
  );
  const control = blocks(result).find((block) => block.id === entry.id)!.control;
  assert.equal(control.kind, 'switch');
  if (control.kind !== 'switch') return;
  assert.equal(control.cases.length, 2);
  assert.equal(control.cases[0]!.arm.transfer.target, shared.id);
  assert.notEqual(
    control.cases[0]!.arm.transfer.copies[0]!.source.id,
    control.cases[1]!.arm.transfer.copies[0]!.source.id,
  );
  assert.equal(evaluateIR(lower(result), { arguments: [99n] }).status, 'unknown');
});

test('calls, architectural exit roots and fault snapshots survive without formal returns', () => {
  const b = builder('presentation-physical-effects'),
    entry = b.block('entry'),
    exit = b.block('exit');
  const rax = register('rax', 64, 0, 'replace_root');
  entry.writeRegister(rax, entry.constant(i64, 55n));
  entry.call(
    { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
    [],
    [],
    { registers: [rax], flags: [], memory: 'unknown_read_write' },
  );
  entry.store(entry.constant(i64, 0x1000n), entry.readRegister(rax));
  entry.jump(exit);
  exit.return();
  const constructed = constructSSA(b.finish(entry));
  assert.equal(constructed.value.form, 'ssa');
  if (constructed.value.form !== 'ssa') return;
  const input: SSAForm = constructed.value,
    call = input.blocks[0]!.instructions.find((node) => node.kind === 'call')!;
  const oracle: TrustedCall = (args) => ({
    results: [],
    writes: [],
    register_writes: [{ register: rax, bits: args.readRegister(rax) + 7n }],
  });
  const calls = new Map([[call.id, oracle]]);
  const result = equivalent(input, [{ calls, memory }, { calls }, {}]);
  const evaluated = evaluateIR(lower(result), { calls, memory });
  assert.equal(evaluated.registers.get(rax.root)!.bits, 62n);
  assert.equal(evaluated.memory[0]!.bytes[0], 62);
  assert.equal(evaluateIR(lower(result), { calls }).status, 'memory_fault');
  assert.ok(blocks(result).some((block) => block.register_exit.length > 0));
});

test('unknown effects, traps, indirect and unreachable boundaries never disappear', () => {
  const b = ssa('boundaries'),
    entry = b.block('entry', [i32]),
    unknown = b.block('unknown'),
    trap = b.block('trap'),
    indirect = b.block('indirect'),
    unreachable = b.block('unreachable');
  entry.terminate({
    kind: 'switch',
    value: entry.parameters[0]!,
    cases: [
      { bits: 0n, edge: entry.edge(unknown) },
      { bits: 1n, edge: entry.edge(trap) },
    ],
    otherwise: entry.edge(indirect),
  });
  unknown.unknown('unsupported effect boundary', {
    registers: [],
    flags: [],
    memory: 'unknown_read_write',
  });
  unknown.store(unknown.constant(i64, 0x1000n), unknown.constant(i32, 99n));
  unknown.return();
  trap.terminate({ kind: 'trap', reason: 'established trap' });
  indirect.terminate({
    kind: 'indirect',
    target: indirect.constant(i64, 0x4000n),
    reason: 'unresolved target',
  });
  unreachable.jump(unreachable);
  const result = equivalent(
    b.finish(entry),
    [0n, 1n, 2n].map((n) => ({ arguments: [n], memory })),
  );
  assert.equal(blocks(result).length, 5);
  assert.equal(evaluateIR(lower(result), { arguments: [0n], memory }).memory[0]!.bytes[0], 0);
  assert.equal(regions(result.body).filter((region) => region.kind === 'loop').length, 0);
});

test('depth fallback preserves full paths while work and cancellation exhaustion publish no partial tree', () => {
  const b = ssa('bounded-structure'),
    entry = b.block('entry'),
    loop = b.block('loop', [i32]),
    exit = b.block('exit');
  entry.jump(loop, [entry.constant(i32, 1n)]);
  loop.branch(
    loop.compare('eq', loop.parameters[0]!, loop.constant(i32, 0n)),
    loop.edge(exit),
    loop.edge(loop, [loop.constant(i32, 0n)]),
  );
  exit.return();
  const input = b.finish(entry);
  const result = structureControlFlow(input, createOperationContext(), { max_depth: 1 });
  assert.equal(result.state, 'complete');
  assert.ok(result.value);
  assert.equal(regions(result.value.body).filter((region) => region.kind === 'loop').length, 0);
  assert.deepEqual(evaluateIR(lower(result.value)), evaluateIR(input));
  const limited = structureControlFlow(input, createOperationContext(), { max_work: 3 });
  assert.equal(limited.state, 'partial');
  assert.equal(limited.value, null);
  assert.equal(limited.diagnostics[0]!.code, 'resource_limit');
  const abort = new AbortController();
  abort.abort();
  const cancelled = structureControlFlow(input, createOperationContext({ signal: abort.signal }));
  assert.equal(cancelled.state, 'partial');
  assert.equal(cancelled.value, null);
  assert.equal(cancelled.diagnostics[0]!.code, 'cancelled');
});

test('instruction ranges, evidence and coverage stay attached to semantic identities', () => {
  const b = ssa('presentation-origins'),
    entry = b.block('entry'),
    exit = b.block('exit', [i32]);
  const origin = {
    instruction_ids: [entityIdentity(slice, 'instruction', 0x1000n)],
    ranges: [{ start: { image_id: image, space: 'va' as const, value: 0x1000n }, size: 4n }],
    evidence_ids: [`evidence_${'b'.repeat(64)}`],
    synthetic: [],
  };
  entry.source(origin);
  entry.jump(exit, [entry.constant(i32, 42n)]);
  exit.source(origin);
  exit.return(exit.parameters);
  const input = b.finish(entry, [i32]),
    result = equivalent(input);
  assert.deepEqual(
    result.coverage,
    input.blocks.map((block) => ({
      block_id: block.id,
      statement_ids: block.instructions.map((node) => node.id),
      terminator_id: block.terminator.id,
    })),
  );
  assert.deepEqual(
    blocks(result).find((block) => block.id === entry.id)!.statements[0]!.provenance,
    origin,
  );
  assert.deepEqual(
    blocks(result).find((block) => block.id === exit.id)!.control.provenance,
    origin,
  );
});

test('short-circuit operands nest in their arm and share the join without labels', () => {
  // if (a && b) { store } return
  const b = ssa('short-circuit'),
    entry = b.block('entry', [i1, i1]),
    second = b.block('second'),
    body = b.block('body'),
    join = b.block('join');
  const [a, c] = entry.parameters as [Value, Value];
  entry.branch(a, entry.edge(second), entry.edge(join));
  second.branch(c, second.edge(body), second.edge(join));
  body.store(body.constant(i64, 0x1000n), body.constant(i32, 7n));
  body.jump(join);
  join.return([join.load(i32, join.constant(i64, 0x1000n))]);
  const result = equivalent(
    b.finish(entry, [i32]),
    [0n, 1n].flatMap((x) => [0n, 1n].map((y) => ({ arguments: [x, y], memory }))),
  );
  assert.ok(transfers(result).every((transfer) => transfer.mode !== 'goto'));
  const head = blocks(result).find((block) => block.id === entry.id)!.control;
  assert.ok(head.kind === 'if' && head.when_true.body && !head.when_false.body);
  const operand = blocks(result).find((block) => block.id === second.id)!.control;
  assert.ok(operand.kind === 'if' && operand.when_true.body && !operand.when_false.body);
  assert.equal(operand.when_false.transfer.target, join.id);
});

test('continue and break leave a loop at its header and its single follow', () => {
  // while (n--) { if (*p) continue; *q += 1; if (*q == 3) break; } return *q
  const b = ssa('loop-continue'),
    entry = b.block('entry', [i32]),
    head = b.block('head', [i32]),
    body = b.block('body', [i32]),
    rest = b.block('rest', [i32]),
    done = b.block('done');
  entry.jump(head, [entry.parameters[0]!]);
  const n = head.parameters[0]!;
  head.branch(
    head.compare('eq', n, head.constant(i32, 0n)),
    head.edge(done),
    head.edge(body, [head.int('sub', n, head.constant(i32, 1n))]),
  );
  const skip = body.load(i32, body.constant(i64, 0x1004n));
  body.branch(
    body.compare('ne', skip, body.constant(i32, 0n)),
    body.edge(head, [body.parameters[0]!]),
    body.edge(rest, [body.parameters[0]!]),
  );
  const address = rest.constant(i64, 0x1000n),
    count = rest.int('add', rest.load(i32, address), rest.constant(i32, 1n));
  rest.store(address, count);
  rest.branch(
    rest.compare('eq', count, rest.constant(i32, 3n)),
    rest.edge(done),
    rest.edge(head, [rest.parameters[0]!]),
  );
  done.return([done.load(i32, done.constant(i64, 0x1000n))]);
  const result = equivalent(
    b.finish(entry, [i32]),
    [0n, 2n, 9n].flatMap((value) => [
      { arguments: [value], memory },
      {
        arguments: [value],
        memory: [
          { base: 0x1000n, bytes: new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0]), writable: true },
        ],
      },
    ]),
  );
  const modes = transfers(result).map((transfer) => transfer.mode);
  assert.ok(!modes.includes('goto'));
  assert.equal(modes.filter((mode) => mode === 'continue').length, 2);
  assert.equal(modes.filter((mode) => mode === 'break').length, 2);
  const loops = regions(result.body).filter((region) => region.kind === 'loop');
  assert.equal(loops.length, 1);
});

test('a multi-level exit breaks every loop it leaves and keeps its exact continuation', () => {
  // for (i) for (j) if (*p == i + j) goto out; out: return
  const b = ssa('multi-level-exit'),
    entry = b.block('entry'),
    outer = b.block('outer', [i32]),
    inner = b.block('inner', [i32, i32]),
    step = b.block('step', [i32, i32]),
    latch = b.block('latch', [i32]),
    out = b.block('out', [i32]);
  entry.jump(outer, [entry.constant(i32, 0n)]);
  const i = outer.parameters[0]!;
  outer.branch(
    outer.compare('eq', i, outer.constant(i32, 3n)),
    outer.edge(out, [outer.constant(i32, 99n)]),
    outer.edge(inner, [i, outer.constant(i32, 0n)]),
  );
  const [ii, j] = inner.parameters as [Value, Value];
  const sum = inner.int('add', ii, j);
  inner.branch(
    inner.compare('eq', inner.load(i32, inner.constant(i64, 0x1000n)), sum),
    inner.edge(out, [sum]),
    inner.edge(step, [ii, j]),
  );
  const [si, sj] = step.parameters as [Value, Value];
  const next = step.int('add', sj, step.constant(i32, 1n));
  step.branch(
    step.compare('eq', next, step.constant(i32, 3n)),
    step.edge(latch, [si]),
    step.edge(inner, [si, next]),
  );
  latch.jump(outer, [latch.int('add', latch.parameters[0]!, latch.constant(i32, 1n))]);
  out.return(out.parameters);
  const result = equivalent(
    b.finish(entry, [i32]),
    [0, 2, 4, 9].map((value) => ({
      memory: [{ base: 0x1000n, bytes: new Uint8Array([value, 0, 0, 0]), writable: true }],
    })),
  );
  const leave = blocks(result).find((block) => block.id === inner.id)!.control;
  assert.ok(leave.kind === 'if');
  if (leave.kind !== 'if') return;
  // Both loops are exited: the transfer names the outermost one it leaves.
  assert.equal(leave.when_true.transfer.mode, 'break');
  assert.equal(leave.when_true.transfer.loop, outer.id);
  assert.equal(leave.when_true.transfer.target, out.id);
  assert.equal(regions(result.body).filter((region) => region.kind === 'loop').length, 2);
});

test('a switch case falling into another case keeps every case edge and its copies', () => {
  // switch (x) { case 1: *p = 1; /* fallthrough */ case 2: *p += 2; break; default: *p = 9; }
  const b = ssa('switch-fallthrough'),
    entry = b.block('entry', [i32]),
    one = b.block('one'),
    two = b.block('two', [i32]),
    other = b.block('other'),
    join = b.block('join');
  const address = (block: BlockBuilder) => block.constant(i64, 0x1000n);
  entry.terminate({
    kind: 'switch',
    value: entry.parameters[0]!,
    cases: [
      { bits: 1n, edge: entry.edge(one) },
      { bits: 2n, edge: entry.edge(two, [entry.constant(i32, 0n)]) },
    ],
    otherwise: entry.edge(other),
  });
  one.store(address(one), one.constant(i32, 1n));
  one.jump(two, [one.constant(i32, 1n)]);
  two.store(address(two), two.int('add', two.parameters[0]!, two.constant(i32, 2n)));
  two.jump(join);
  other.store(address(other), other.constant(i32, 9n));
  other.jump(join);
  join.return([join.load(i32, address(join))]);
  const result = equivalent(
    b.finish(entry, [i32]),
    [0n, 1n, 2n, 3n].map((value) => ({ arguments: [value], memory })),
  );
  // The fallthrough edge is the only transfer that is not structured.
  assert.ok(transfers(result).filter((transfer) => transfer.mode === 'goto').length <= 1);
  assert.deepEqual(
    [0n, 1n, 2n, 3n].map(
      (value) => returned(evaluateIR(lower(result), { arguments: [value], memory }))[0],
    ),
    [9n, 3n, 2n, 9n],
  );
});

type Statement =
  | { readonly kind: 'store' | 'break' | 'continue' | 'return' }
  | { readonly kind: 'if'; readonly then: Statement[]; readonly otherwise: Statement[] }
  | { readonly kind: 'while' | 'do'; readonly body: Statement[] };

/** A random structured program: nested if/else, top- and bottom-tested loops,
 * innermost break/continue and early returns. */
function program(next: (bound: number) => number, depth: number, loop: boolean): Statement[] {
  const list: Statement[] = [];
  for (let count = 1 + next(3); count > 0; count--) {
    const roll = next(10);
    if (depth < 3 && roll < 3)
      list.push({
        kind: 'if',
        then: program(next, depth + 1, loop),
        otherwise: next(2) ? program(next, depth + 1, loop) : [],
      });
    else if (depth < 3 && roll < 5)
      list.push({ kind: next(2) ? 'while' : 'do', body: program(next, depth + 1, true) });
    else if (loop && roll === 5) {
      list.push({ kind: next(2) ? 'break' : 'continue' });
      break;
    } else if (roll === 6) {
      list.push({ kind: 'return' });
      break;
    } else list.push({ kind: 'store' });
  }
  return list;
}

/** Lowers a structured program to SSA blocks; loops count through private cells. */
function lowerProgram(name: string, statements: Statement[]): SSAForm {
  const b = ssa(name);
  let blocks = 0,
    cells = 0,
    stores = 0;
  const fresh = (): BlockBuilder => b.block(`b${blocks++}`);
  const test = (block: BlockBuilder, cell: number): Value => {
    const address = block.constant(i64, 0x1010n + 4n * BigInt(cell)),
      value = block.load(i32, address);
    block.store(address, block.int('add', value, block.constant(i32, 1n)));
    return block.compare('ult', value, block.constant(i32, 2n));
  };
  type Exits = { readonly repeat: () => BlockBuilder; readonly leave: () => BlockBuilder };
  const emit = (list: Statement[], at: BlockBuilder, exits?: Exits): BlockBuilder | null => {
    let current: BlockBuilder | null = at;
    for (const statement of list) {
      if (!current) break;
      const block: BlockBuilder = current;
      switch (statement.kind) {
        case 'store': {
          const slot = stores++;
          block.store(
            block.constant(i64, 0x1080n + 4n * BigInt(slot % 16)),
            block.constant(i32, BigInt(slot)),
          );
          break;
        }
        case 'break':
          block.jump(exits!.leave());
          current = null;
          break;
        case 'continue':
          block.jump(exits!.repeat());
          current = null;
          break;
        case 'return':
          block.return([]);
          current = null;
          break;
        case 'if': {
          const yes = fresh(),
            no = fresh(),
            cell = (stores + blocks) % 4;
          block.branch(
            block.compare(
              'ne',
              block.load(i32, block.constant(i64, 0x1000n + 4n * BigInt(cell))),
              block.constant(i32, 0n),
            ),
            block.edge(yes),
            block.edge(no),
          );
          const ends = [emit(statement.then, yes, exits), emit(statement.otherwise, no, exits)];
          current = null;
          for (const end of ends)
            if (end) {
              current ??= fresh();
              end.jump(current);
            }
          break;
        }
        case 'while': {
          const head = fresh(),
            body = fresh(),
            exit = fresh(),
            cell = cells++;
          block.jump(head);
          head.branch(test(head, cell), head.edge(body), head.edge(exit));
          const end = emit(statement.body, body, { repeat: () => head, leave: () => exit });
          end?.jump(head);
          current = exit;
          break;
        }
        case 'do': {
          const body = fresh(),
            cell = cells++;
          let latch: BlockBuilder | undefined, exit: BlockBuilder | undefined;
          const leave = (): BlockBuilder => (exit ??= fresh());
          const repeat = (): BlockBuilder => (latch ??= fresh());
          block.jump(body);
          const end = emit(statement.body, body, { repeat, leave });
          if (end) end.jump(repeat());
          if (latch) latch.branch(test(latch, cell), latch.edge(body), latch.edge(leave()));
          current = exit ?? null;
          break;
        }
      }
    }
    return current;
  };
  const entry = fresh();
  emit(statements, entry)?.return([]);
  return b.finish(entry, []);
}

test('reducible programs without multi-level exits structure without labeled transfers', () => {
  let seed = 0x2545f491;
  const next = (bound: number): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % bound;
  };
  const bytes = (values: readonly number[]): Uint8Array => {
    const result = new Uint8Array(0x100);
    values.forEach((value, index) => (result[index * 4] = value));
    return result;
  };
  for (let index = 0; index < 300; index++) {
    const input = lowerProgram(`random-${index}`, program(next, 0, false));
    const result = equivalent(
      input,
      [
        [0, 0, 0, 0],
        [1, 0, 1, 0],
        [1, 1, 1, 1],
        [0, 1, 0, 1],
      ].map((cells) => ({
        memory: [{ base: 0x1000n, bytes: bytes(cells), writable: true }],
        max_steps: 2_000,
      })),
    );
    const labeled = transfers(result).filter((transfer) => transfer.mode === 'goto');
    assert.deepEqual(labeled, [], `program ${index}`);
  }
});

test('random acyclic graphs with shared joins keep every labeled transfer forward', () => {
  let seed = 0x1b873593;
  const next = (bound: number): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % bound;
  };
  const bytes = (values: readonly number[]): Uint8Array => {
    const result = new Uint8Array(0x100);
    values.forEach((value, index) => (result[index * 4] = value));
    return result;
  };
  let labels = 0;
  for (let index = 0; index < 300; index++) {
    // Blocks only jump forward, so joins are entered from unrelated arms.
    const b = ssa(`dag-${index}`),
      count = 4 + next(10),
      list = Array.from({ length: count }, (_, id) => b.block(`n${id}`));
    list.forEach((block, id) => {
      block.store(
        block.constant(i64, 0x1080n + 4n * BigInt(id % 16)),
        block.constant(i32, BigInt(id)),
      );
      const later = (): BlockBuilder => list[id + 1 + next(Math.min(4, count - id - 1))]!;
      if (id === count - 1 || (id > 1 && next(6) === 0)) block.return([]);
      else if (next(3) === 0) block.jump(later());
      else {
        const yes = later();
        let no = later();
        if (no === yes) no = list[id + 1]! === yes ? list[count - 1]! : list[id + 1]!;
        block.branch(
          block.compare(
            'ne',
            block.load(i32, block.constant(i64, 0x1000n + 4n * BigInt(id % 4))),
            block.constant(i32, 0n),
          ),
          block.edge(yes),
          block.edge(no),
        );
      }
    });
    const input = b.finish(list[0]!, []);
    const result = equivalent(
      input,
      [
        [0, 0, 0, 0],
        [1, 0, 1, 0],
        [1, 1, 1, 1],
        [0, 1, 1, 0],
      ].map((cells) => ({ memory: [{ base: 0x1000n, bytes: bytes(cells), writable: true }] })),
    );
    // Text order: sequence elements in order, a block before its arm bodies.
    const position = new Map<string, number>();
    const walk = (region: Region): void => {
      if (region.kind === 'sequence') region.regions.forEach(walk);
      else if (region.kind === 'loop') walk(region.body);
      else {
        position.set(region.id, position.size);
        const control = region.control;
        if (control.kind === 'if')
          for (const arm of [control.when_true, control.when_false]) if (arm.body) walk(arm.body);
      }
    };
    walk(result.body);
    // Unreachable blocks are only kept, never ordered.
    const reached = new Set([input.entry]);
    for (const block of input.blocks)
      if (reached.has(block.id))
        for (const edge of successors(block.terminator)) reached.add(edge.target);
    for (const block of blocks(result)) {
      if (!reached.has(block.id)) continue;
      const control = block.control;
      const own =
        control.kind === 'jump'
          ? [control.transfer]
          : control.kind === 'if'
            ? [control.when_true.transfer, control.when_false.transfer]
            : [];
      for (const transfer of own) {
        if (transfer.mode !== 'goto') continue;
        labels++;
        assert.ok(
          position.get(transfer.target)! > position.get(block.id)!,
          `program ${index}: labeled transfer ${block.id} -> ${transfer.target} jumps backward`,
        );
      }
    }
  }
  // The sample does exercise labels (joins entered from unrelated arms).
  assert.ok(labels > 0);
});
