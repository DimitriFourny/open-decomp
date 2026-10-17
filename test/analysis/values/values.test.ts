import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeValues, simplifySSA } from '../../../src/analysis/values/index.js';
import { evaluateIR, integer, verifyIR } from '../../../src/ir/index.js';
import { builder, register, returned } from '../../ir/support.js';
import { equivalent, forms } from '../ssa/support.js';

const i1 = integer(1),
  i8 = integer(8),
  i32 = integer(32),
  i64 = integer(64);

test('folding honors wrapping, signed division, arithmetic shifts and signed versus unsigned comparisons', () => {
  const ir = builder('ssa-machine-folding');
  const b = ir.block('entry');
  const maximum = b.constant(i8, 255n),
    one = b.constant(i8, 1n),
    two = b.constant(i8, 2n),
    minusFour = b.constant(i8, 252n);
  const values = [
    b.int('add', maximum, one),
    b.compare('slt', maximum, one),
    b.compare('ult', maximum, one),
    b.int('sdiv', minusFour, two),
    b.int('ashr', minusFour, one),
    b.int('lshr', minusFour, one),
  ];
  b.return(values);
  const result = equivalent(
    ir.finish(
      b,
      values.map((value) => value.type),
    ),
  );
  assert.deepEqual(returned(result.original), [0n, 1n, 0n, 254n, 254n, 126n]);
  assert.ok(
    result.optimized.blocks[0]!.instructions.every(
      (node) => node.kind === 'assign' && node.expression.kind === 'constant',
    ),
  );
});

test('flag recovery identifies unsigned carry/borrow, equality and signed overflow-dependent comparisons', () => {
  const ir = builder('ssa-flag-comparisons');
  const b = ir.block('entry', [i8, i8]);
  const left = b.parameters[0]!,
    right = b.parameters[1]!,
    zero = b.constant(i1, 0n);
  const carry = b.flag('sub', 'carry', left, right, zero),
    borrow = b.flag('sub', 'borrow', left, right, zero),
    equal = b.flag('sub', 'zero', left, right, zero);
  const negative = b.flag('sub', 'negative', left, right, zero),
    overflow = b.flag('sub', 'overflow', left, right, zero);
  b.return([carry, borrow, equal, b.int('xor', negative, overflow)]);
  const program = ir.finish(b, [i1, i1, i1, i1]);
  for (const [a, c] of [
    [0n, 1n],
    [127n, 255n],
    [128n, 1n],
    [255n, 255n],
    [7n, 3n],
  ]) {
    const result = equivalent(program, { arguments: [a!, c!] });
    assert.deepEqual(returned(result.original), [
      a! >= c! ? 1n : 0n,
      a! < c! ? 1n : 0n,
      a === c ? 1n : 0n,
      BigInt.asIntN(8, a!) < BigInt.asIntN(8, c!) ? 1n : 0n,
    ]);
    const comparisons = result.optimized.blocks[0]!.instructions.flatMap((node) =>
      node.kind === 'assign' && node.expression.kind === 'compare' ? [node.expression.op] : [],
    );
    assert.deepEqual(comparisons, ['uge', 'ult', 'eq', 'slt']);
  }
});

test('nonzero borrow-in flags are not rewritten as two-operand comparisons', () => {
  const ir = builder('ssa-borrow-in');
  const b = ir.block('entry', [i8, i8]);
  const borrow = b.flag('sub', 'borrow', b.parameters[0]!, b.parameters[1]!, b.constant(i1, 1n));
  b.return([borrow]);
  const result = equivalent(ir.finish(b, [i1]), { arguments: [3n, 3n] });
  assert.deepEqual(returned(result.original), [1n]);
  assert.ok(
    result.optimized.blocks[0]!.instructions.some(
      (node) => node.kind === 'assign' && node.expression.kind === 'flag',
    ),
  );
});

test('undefined flag and undefined arithmetic are never annihilated by algebraic identities', () => {
  const ir = builder('ssa-undefined-multiply');
  const b = ir.block('entry');
  const undefinedValue = b.indeterminate(
    i32,
    'undefined',
    'architecturally undefined flag expansion',
  );
  b.return([b.int('mul', undefinedValue, b.constant(i32, 0n))]);
  assert.equal(equivalent(ir.finish(b, [i32])).original.status, 'undefined');
  const division = builder('ssa-signed-overflow');
  const c = division.block('entry');
  c.return([c.int('sdiv', c.constant(i8, 128n), c.constant(i8, 255n))]);
  assert.equal(equivalent(division.finish(c, [i8])).original.status, 'undefined');
  const narrow = builder('ssa-one-bit-division');
  const d = narrow.block('entry', [i1]);
  d.return([d.int('sdiv', d.parameters[0]!, d.constant(i1, 1n))]);
  assert.equal(
    equivalent(narrow.finish(d, [i1]), { arguments: [1n] }).original.status,
    'undefined',
  );
});

test('constant branch removes unreachable effects and propagates equal constants through a join', () => {
  const ir = builder('ssa-constant-branch');
  const entry = ir.block('entry'),
    good = ir.block('good'),
    bad = ir.block('bad'),
    join = ir.block('join', [i32]);
  entry.branch(
    entry.compare('slt', entry.constant(i32, 0xffffffffn), entry.constant(i32, 0n)),
    entry.edge(good),
    entry.edge(bad),
  );
  good.jump(join, [good.constant(i32, 42n)]);
  bad.unknown('Unreachable unknown effect', {
    registers: [],
    flags: [],
    memory: 'unknown_read_write',
  });
  bad.jump(join, [bad.constant(i32, 1n)]);
  join.return([join.int('add', join.parameters[0]!, join.constant(i32, 1n))]);
  const result = equivalent(ir.finish(entry, [i32]));
  assert.deepEqual(returned(result.original), [43n]);
  assert.ok(!result.optimized.blocks.some((block) => block.id === bad.id));
  assert.ok(
    result.optimized.blocks.every((block) =>
      block.instructions.every((node) => node.kind !== 'unknown_effect'),
    ),
  );
});

test('different join values become varying and loops invalidate first-iteration constants', () => {
  const ir = builder('ssa-join-lattice');
  const entry = ir.block('entry', [i1]),
    a = ir.block('a'),
    b = ir.block('b'),
    join = ir.block('join', [i32]);
  entry.branch(entry.parameters[0]!, entry.edge(a), entry.edge(b));
  a.jump(join, [a.constant(i32, 1n)]);
  b.jump(join, [b.constant(i32, 2n)]);
  join.return([join.parameters[0]!]);
  const program = ir.finish(entry, [i32]);
  const { ssa } = forms(program);
  assert.deepEqual(analyzeValues(ssa).value.facts.get(join.parameters[0]!.id), { kind: 'varying' });
  for (const value of [0n, 1n]) equivalent(program, { arguments: [value] });
  const loopIR = builder('ssa-loop-lattice');
  const start = loopIR.block('entry'),
    loop = loopIR.block('loop', [i32]),
    exit = loopIR.block('exit', [i32]);
  start.jump(loop, [start.constant(i32, 0n)]);
  const increment = loop.int('add', loop.parameters[0]!, loop.constant(i32, 1n));
  loop.branch(
    loop.compare('ult', increment, loop.constant(i32, 3n)),
    loop.edge(loop, [increment]),
    loop.edge(exit, [increment]),
  );
  exit.return([exit.parameters[0]!]);
  assert.deepEqual(returned(equivalent(loopIR.finish(start, [i32])).original), [3n]);
});

test('branch threading substitutes successor parameters and uses edge-specific predicate facts', () => {
  const ir = builder('ssa-threading');
  const entry = ir.block('entry', [i1, i32]),
    dispatch = ir.block('dispatch', [i1, i32]),
    yes = ir.block('yes', [i32]),
    no = ir.block('no', [i32]);
  entry.branch(
    entry.parameters[0]!,
    entry.edge(dispatch, entry.parameters),
    entry.edge(dispatch, entry.parameters),
  );
  dispatch.branch(
    dispatch.parameters[0]!,
    dispatch.edge(yes, [dispatch.parameters[1]!]),
    dispatch.edge(no, [dispatch.parameters[1]!]),
  );
  yes.return([yes.parameters[0]!]);
  no.return([no.int('add', no.parameters[0]!, no.constant(i32, 1n))]);
  const program = ir.finish(entry, [i32]);
  for (const condition of [0n, 1n]) {
    const result = equivalent(program, { arguments: [condition, 40n] });
    assert.deepEqual(returned(result.original), [condition === 0n ? 41n : 40n]);
    const term = result.optimized.blocks.find((block) => block.id === entry.id)!.terminator;
    assert.ok(term.kind === 'branch');
    if (term.kind !== 'branch') continue;
    assert.equal(term.when_true.target, yes.id);
    assert.equal(term.when_false.target, no.id);
    assert.ok(!result.optimized.blocks.some((block) => block.id === dispatch.id));
  }
});

test('effect-free cycles do not cause endlessly rotating branch-threading rewrites', () => {
  const ir = builder('ssa-empty-cycle');
  const entry = ir.block('entry'),
    a = ir.block('a', [i32, i32]),
    b = ir.block('b', [i32, i32]);
  entry.jump(a, [entry.constant(i32, 1n), entry.constant(i32, 2n)]);
  a.jump(b, [a.parameters[1]!, a.parameters[0]!]);
  b.jump(a, b.parameters);
  const { ssa } = forms(ir.finish(entry));
  const result = simplifySSA(ssa, { max_work: 10000 });
  assert.equal(result.state, 'complete');
  assert.deepEqual(verifyIR(result.value), []);
});

test('optimizer budget interruption returns valid last-complete graph and no provisional constant claims', () => {
  const ir = builder('ssa-value-budget');
  const b = ir.block('entry', [i64]);
  const root = register('state', 64, 0, 'replace_root', 'budget-state');
  b.writeRegister(root, b.int('add', b.parameters[0]!, b.constant(i64, 0n)));
  b.return([b.readRegister(root)]);
  const { ssa } = forms(ir.finish(b, [i64]));
  for (const max_work of [0, 1, 8, 20]) {
    const result = simplifySSA(ssa, { max_work });
    assert.equal(result.state, 'partial');
    assert.deepEqual(verifyIR(result.value), []);
    const facts = analyzeValues(ssa, { max_work: 0 });
    assert.equal(facts.state, 'partial');
    assert.equal(facts.value.facts.size, 0);
  }
});

test('compound flag predicates recover signed and unsigned inclusive/strict conditions', () => {
  const ir = builder('ssa-compound-flags');
  const b = ir.block('entry', [i8, i8]);
  const left = b.parameters[0]!,
    right = b.parameters[1]!,
    zero = b.constant(i1, 0n),
    one = b.constant(i1, 1n);
  const equal = b.flag('sub', 'zero', left, right, zero),
    carry = b.flag('sub', 'carry', left, right, zero);
  const signedLess = b.int(
    'xor',
    b.flag('sub', 'negative', left, right, zero),
    b.flag('sub', 'overflow', left, right, zero),
  );
  const signedLessEqual = b.int('or', equal, signedLess);
  const signedGreater = b.int('xor', signedLessEqual, one);
  const unsignedGreater = b.int('and', carry, b.int('xor', equal, one));
  b.return([signedLessEqual, signedGreater, unsignedGreater]);
  const program = ir.finish(b, [i1, i1, i1]);
  for (const [a, c] of [
    [127n, 255n],
    [128n, 1n],
    [4n, 4n],
    [1n, 2n],
  ]) {
    const result = equivalent(program, { arguments: [a!, c!] });
    assert.deepEqual(returned(result.original), [
      BigInt.asIntN(8, a!) <= BigInt.asIntN(8, c!) ? 1n : 0n,
      BigInt.asIntN(8, a!) > BigInt.asIntN(8, c!) ? 1n : 0n,
      a! > c! ? 1n : 0n,
    ]);
    const predicates = result.optimized.blocks[0]!.instructions.flatMap((node) =>
      node.kind === 'assign' && node.expression.kind === 'compare' ? [node.expression.op] : [],
    );
    assert.deepEqual(predicates, ['sle', 'sgt', 'ugt']);
  }
});

test('constant switch selection retains only the executable arm and its state', () => {
  const ir = builder('ssa-switch');
  const entry = ir.block('entry'),
    one = ir.block('one'),
    two = ir.block('two'),
    other = ir.block('other');
  entry.terminate({
    kind: 'switch',
    value: entry.int('add', entry.constant(i32, 1n), entry.constant(i32, 1n)),
    cases: [
      { bits: 1n, edge: entry.edge(one) },
      { bits: 2n, edge: entry.edge(two) },
    ],
    otherwise: entry.edge(other),
  });
  one.return([one.constant(i32, 11n)]);
  two.return([two.constant(i32, 22n)]);
  other.return([other.constant(i32, 33n)]);
  const result = equivalent(ir.finish(entry, [i32]));
  assert.deepEqual(returned(result.original), [22n]);
  assert.ok(!result.optimized.blocks.some((block) => block.id === one.id || block.id === other.id));
});

test('sparse executable-edge propagation revisits a join when a later predecessor changes a constant', () => {
  const ir = builder('sparse-late-predecessor');
  const entry = ir.block('entry', [i1]),
    left = ir.block('left'),
    delayed = ir.block('delayed'),
    later = ir.block('later'),
    join = ir.block('join', [i32]),
    yes = ir.block('yes'),
    no = ir.block('no');
  entry.branch(entry.parameters[0]!, entry.edge(left), entry.edge(delayed));
  left.jump(join, [left.constant(i32, 7n)]);
  delayed.jump(later);
  later.jump(join, [later.constant(i32, 9n)]);
  join.branch(
    join.compare('eq', join.parameters[0]!, join.constant(i32, 7n)),
    join.edge(yes),
    join.edge(no),
  );
  yes.return([yes.constant(i32, 1n)]);
  no.return([no.constant(i32, 0n)]);
  const program = ir.finish(entry, [i32]);
  const { ssa } = forms(program),
    analysis = analyzeValues(ssa);
  assert.equal(analysis.state, 'complete');
  assert.deepEqual(analysis.value.facts.get(join.parameters[0]!.id), { kind: 'varying' });
  assert.ok(
    analysis.value.reachable_blocks.has(yes.id) && analysis.value.reachable_blocks.has(no.id),
  );
  for (const condition of [0n, 1n])
    assert.deepEqual(returned(equivalent(program, { arguments: [condition] }).original), [
      condition,
    ]);
});

test('sparse phi dependencies revisit loop backedges and activate the eventual exit', () => {
  const ir = builder('sparse-backedge');
  const entry = ir.block('entry'),
    loop = ir.block('loop', [i32]),
    body = ir.block('body', [i32]),
    exit = ir.block('exit', [i32]);
  entry.jump(loop, [entry.constant(i32, 0n)]);
  loop.branch(
    loop.compare('ult', loop.parameters[0]!, loop.constant(i32, 2n)),
    loop.edge(body, [loop.parameters[0]!]),
    loop.edge(exit, [loop.parameters[0]!]),
  );
  body.jump(loop, [body.int('add', body.parameters[0]!, body.constant(i32, 1n))]);
  exit.return([exit.parameters[0]!]);
  const program = ir.finish(entry, [i32]),
    { ssa } = forms(program);
  const analysis = analyzeValues(ssa);
  assert.equal(analysis.state, 'complete');
  assert.deepEqual(analysis.value.facts.get(loop.parameters[0]!.id), { kind: 'varying' });
  assert.ok(analysis.value.reachable_blocks.has(exit.id));
  assert.deepEqual(returned(equivalent(program).original), [2n]);
});

test('sparse propagation is independent of reverse block layout and unrelated phi rounds', () => {
  const ir = builder('sparse-reverse-layout');
  const entry = ir.block('entry');
  const blocks = Array.from({ length: 64 }, (_, index) =>
    ir.block(
      `step-${index}`,
      Array.from({ length: 8 }, () => i32),
    ),
  );
  entry.jump(
    blocks[0]!,
    Array.from({ length: 8 }, (_, index) => entry.constant(i32, BigInt(42 + index))),
  );
  for (let index = 0; index < blocks.length - 1; index++)
    blocks[index]!.jump(blocks[index + 1]!, blocks[index]!.parameters);
  blocks.at(-1)!.return([blocks.at(-1)!.parameters[0]!]);
  const { ssa } = forms(ir.finish(entry, [i32]));
  const reversed = { ...ssa, blocks: [ssa.blocks[0]!, ...ssa.blocks.slice(1).reverse()] };
  assert.deepEqual(verifyIR(reversed), []);
  const analysis = analyzeValues(reversed, { max_work: 8000 });
  assert.equal(analysis.state, 'complete', JSON.stringify(analysis.diagnostics));
  assert.equal(analysis.value.reachable_blocks.size, reversed.blocks.length);
  assert.deepEqual(analysis.value.facts.get(blocks.at(-1)!.parameters[0]!.id), {
    kind: 'constant',
    bits: 42n,
  });
  const optimized = simplifySSA(reversed, { max_work: 20_000 });
  assert.equal(optimized.state, 'complete', JSON.stringify(optimized.diagnostics));
  assert.deepEqual(returned(evaluateIR(optimized.value)), [42n]);
});
