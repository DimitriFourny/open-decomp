import assert from 'node:assert/strict';
import test from 'node:test';
import { integer, syntheticProvenance } from '../../../src/ir/index.js';
import type { SSAForm } from '../../../src/ir/index.js';
import { builder, register, returned } from '../../ir/support.js';
import { equivalent, forms } from '../ssa/support.js';

const i1 = integer(1),
  i8 = integer(8),
  i32 = integer(32),
  i64 = integer(64);
const reg = (name: string) => register(name, 64, 0, 'replace_root', `join:${name}`, 64);
const N = reg('n'),
  I = reg('i'),
  K = reg('k'),
  ACC = reg('acc');

const branches = (ssa: SSAForm) => ssa.blocks.filter((block) => block.terminator.kind === 'branch');

test('a rotated counted loop with a constant preheader joins its guard and bottom test, also for zero iterations', () => {
  // acc = 0; if (0 < n) { i = 0; k = 3; do { acc += i * k; i++; } while (i < n); } return acc;
  const ir = builder('join-rotated-counted');
  const entry = ir.block('entry', [i64]),
    pre = ir.block('pre'),
    body = ir.block('body'),
    exit = ir.block('exit');
  entry.writeRegister(N, entry.parameters[0]!);
  entry.writeRegister(ACC, entry.constant(i64, 0n));
  entry.source(syntheticProvenance('guard test'));
  entry.branch(
    entry.compare('ult', entry.constant(i64, 0n), entry.parameters[0]!),
    entry.edge(pre),
    entry.edge(exit),
  );
  pre.writeRegister(I, pre.constant(i64, 0n));
  pre.writeRegister(K, pre.constant(i64, 3n));
  pre.jump(body);
  const i = body.readRegister(I);
  body.writeRegister(
    ACC,
    body.int('add', body.readRegister(ACC), body.int('mul', i, body.readRegister(K))),
  );
  const next = body.int('add', i, body.constant(i64, 1n));
  body.writeRegister(I, next);
  body.source(syntheticProvenance('bottom test'));
  body.branch(body.compare('ult', next, body.readRegister(N)), body.edge(body), body.edge(exit));
  exit.return([exit.readRegister(ACC)]);
  const program = ir.finish(entry, [i64]);
  for (const n of [0n, 1n, 2n, 5n]) {
    const result = equivalent(program, {
      arguments: [n],
      registers: new Map([
        [I.root, 77n],
        [K.root, 88n],
      ]),
    });
    assert.deepEqual(returned(result.original), [(3n * n * (n - 1n)) / 2n]);
    const tests = branches(result.optimized);
    assert.equal(tests.length, 1, 'one loop test remains');
    const header = tests[0]!;
    assert.ok(
      ['bottom test', 'guard test'].every((reason) =>
        header.terminator.provenance.synthetic.includes(reason),
      ),
      'the joined test keeps both original tests as provenance',
    );
    const optimizedEntry = result.optimized.blocks.find((block) => block.id === entry.id)!;
    assert.equal(optimizedEntry.terminator.kind, 'jump');
  }
});

test('a rotated loop over loop-carried leaves joins without a preheader', () => {
  // if (n != 0) do { acc += n; n--; } while (n != 0); return acc;
  const ir = builder('join-rotated-countdown');
  const entry = ir.block('entry', [i64]),
    body = ir.block('body'),
    exit = ir.block('exit');
  entry.writeRegister(N, entry.parameters[0]!);
  entry.writeRegister(ACC, entry.constant(i64, 5n));
  entry.branch(
    entry.compare('ne', entry.parameters[0]!, entry.constant(i64, 0n)),
    entry.edge(body),
    entry.edge(exit),
  );
  const n = body.readRegister(N);
  body.writeRegister(ACC, body.int('add', body.readRegister(ACC), n));
  const left = body.int('sub', n, body.constant(i64, 1n));
  body.writeRegister(N, left);
  body.branch(body.compare('ne', left, body.constant(i64, 0n)), body.edge(body), body.edge(exit));
  exit.return([exit.readRegister(ACC)]);
  const program = ir.finish(entry, [i64]);
  for (const count of [0n, 1n, 4n]) {
    const result = equivalent(program, { arguments: [count] });
    assert.deepEqual(returned(result.original), [5n + (count * (count + 1n)) / 2n]);
    assert.equal(branches(result.optimized).length, 1);
  }
});

test('complemented duplicated tests join, carrying differing leaves and destination arguments per edge', () => {
  const ir = builder('join-complemented');
  const entry = ir.block('entry', [i1, i32, i32]),
    a = ir.block('a'),
    b = ir.block('b'),
    yes = ir.block('yes', [i32]),
    no = ir.block('no', [i32]);
  const [select, x, y] = entry.parameters as [
    (typeof entry.parameters)[0],
    (typeof entry.parameters)[0],
    (typeof entry.parameters)[0],
  ];
  entry.branch(select, entry.edge(a), entry.edge(b));
  // a: if (x + 1 == 5) yes(x) else no(x + 1)
  const t = a.int('add', x, a.constant(i32, 1n));
  a.source(syntheticProvenance('first copy'));
  a.branch(a.compare('eq', t, a.constant(i32, 5n)), a.edge(yes, [x]), a.edge(no, [t]));
  // b: if (y + 1 != 5) no(y + 1) else yes(y)
  const u = b.int('add', y, b.constant(i32, 1n));
  b.source(syntheticProvenance('second copy'));
  b.branch(b.compare('ne', u, b.constant(i32, 5n)), b.edge(no, [u]), b.edge(yes, [y]));
  yes.return([yes.int('mul', yes.parameters[0]!, yes.constant(i32, 2n))]);
  no.return([no.int('add', no.parameters[0]!, no.constant(i32, 100n))]);
  const program = ir.finish(entry, [i32]);
  for (const [s, p, q] of [
    [0n, 4n, 4n],
    [0n, 4n, 9n],
    [0n, 9n, 4n],
    [1n, 4n, 4n],
    [1n, 4n, 9n],
    [1n, 9n, 4n],
    [1n, 0xffffffffn, 4n],
  ] as const) {
    const result = equivalent(program, { arguments: [s, p, q] });
    const taken = s === 1n ? p : q;
    assert.deepEqual(returned(result.original), [
      taken === 4n ? 8n : BigInt.asUintN(32, taken + 101n),
    ]);
    const tests = branches(result.optimized);
    assert.equal(tests.length, 2, 'the selector and one joined test');
    const joined = tests.find((block) => block.id !== entry.id)!;
    assert.ok(
      ['first copy', 'second copy'].every((reason) =>
        joined.terminator.provenance.synthetic.includes(reason),
      ),
    );
  }
});

test('a 1-bit `not` at the root reads as swapped destinations', () => {
  const ir = builder('join-not-root');
  const entry = ir.block('entry', [i1, i32, i32]),
    a = ir.block('a'),
    b = ir.block('b'),
    yes = ir.block('yes'),
    no = ir.block('no');
  const [select, x, y] = entry.parameters;
  entry.branch(select!, entry.edge(a), entry.edge(b));
  a.branch(a.extract(x!, 3, 1), a.edge(yes), a.edge(no));
  b.branch(b.unary('not', b.extract(y!, 3, 1)), b.edge(no), b.edge(yes));
  yes.return([yes.constant(i32, 1n)]);
  no.return([no.constant(i32, 2n)]);
  const program = ir.finish(entry, [i32]);
  for (const [s, p, q] of [
    [0n, 0n, 8n],
    [0n, 8n, 0n],
    [1n, 0n, 8n],
    [1n, 8n, 0n],
  ] as const) {
    const result = equivalent(program, { arguments: [s, p, q] });
    assert.deepEqual(returned(result.original), [((s === 1n ? p : q) & 8n) !== 0n ? 1n : 2n]);
    assert.equal(branches(result.optimized).length, 2);
  }
});

test('loaded leaves join while each load stays once in its own block', () => {
  const ir = builder('join-loaded-leaves');
  const entry = ir.block('entry', [i1, i64, i64]),
    a = ir.block('a'),
    b = ir.block('b'),
    yes = ir.block('yes'),
    no = ir.block('no');
  const [select, p, q] = entry.parameters;
  entry.branch(select!, entry.edge(a), entry.edge(b));
  a.branch(a.compare('ne', a.load(i8, p!), a.constant(i8, 0n)), a.edge(yes), a.edge(no));
  b.branch(b.compare('ne', b.load(i8, q!), b.constant(i8, 0n)), b.edge(yes), b.edge(no));
  yes.return([yes.constant(i32, 1n)]);
  no.return([no.constant(i32, 2n)]);
  const program = ir.finish(entry, [i32]);
  const memory = [{ base: 0x1000n, bytes: new Uint8Array([0, 7]), writable: false }];
  for (const [s, address, expected] of [
    [1n, 0x1000n, 2n],
    [1n, 0x1001n, 1n],
    [0n, 0x1000n, 2n],
    [0n, 0x1001n, 1n],
  ] as const) {
    const result = equivalent(program, {
      arguments: [s, s === 1n ? address : 0x1000n, s === 1n ? 0x1000n : address],
      memory,
    });
    assert.deepEqual(returned(result.original), [expected]);
    assert.equal(branches(result.optimized).length, 2);
    for (const block of [a, b])
      assert.equal(
        result.optimized.blocks
          .find((item) => item.id === block.id)!
          .instructions.filter((node) => node.kind === 'load').length,
        1,
      );
  }
});

test('impure cones are not joined: an effectful preheader or a call result keeps both tests', () => {
  // The preheader stores, so it cannot also run on the bottom test's path.
  const loop = builder('join-impure-preheader');
  const entry = loop.block('entry', [i64, i64]),
    pre = loop.block('pre'),
    body = loop.block('body'),
    exit = loop.block('exit');
  const [count, address] = entry.parameters;
  entry.writeRegister(N, count!);
  entry.branch(
    entry.compare('ne', count!, entry.constant(i64, 0n)),
    entry.edge(pre),
    entry.edge(exit),
  );
  pre.store(address!, pre.constant(i8, 1n));
  pre.jump(body);
  const left = body.int('sub', body.readRegister(N), body.constant(i64, 1n));
  body.writeRegister(N, left);
  body.branch(body.compare('ne', left, body.constant(i64, 0n)), body.edge(body), body.edge(exit));
  exit.return([exit.readRegister(N)]);
  const program = loop.finish(entry, [i64]);
  for (const n of [0n, 3n]) {
    const result = equivalent(program, {
      arguments: [n, 0x2000n],
      memory: [{ base: 0x2000n, bytes: new Uint8Array([0]), writable: true }],
    });
    assert.deepEqual(returned(result.original), [0n]);
    assert.equal(branches(result.optimized).length, 2);
  }
  // Tests that are call results are effects, never copied into a joined block.
  const calls = builder('join-impure-call');
  const start = calls.block('start', [i1]),
    a = calls.block('a'),
    b = calls.block('b'),
    yes = calls.block('yes'),
    no = calls.block('no');
  start.branch(start.parameters[0]!, start.edge(a), start.edge(b));
  const clobbers = { registers: [], flags: [], memory: 'unknown_read_write' as const };
  for (const block of [a, b]) {
    const [result] = block.call(
      { kind: 'indirect', value: block.constant(i64, 0x40n) },
      [],
      [i1],
      clobbers,
    );
    block.branch(result!, block.edge(yes), block.edge(no));
  }
  yes.return([]);
  no.return([]);
  const { optimized } = forms(calls.finish(start));
  assert.equal(branches(optimized).length, 3);
});
