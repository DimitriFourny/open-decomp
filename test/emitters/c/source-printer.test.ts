import assert from 'node:assert/strict';
import test from 'node:test';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { integer, type SSAForm } from '../../../src/ir/index.js';
import { builder, image, register } from '../../ir/support.js';
import { emit, emittedFormals, execute } from './support.js';

const i32 = integer(32),
  i64 = integer(64);
const source = { abi: sysvAMD64Abi, callees: [], addresses: [] };
const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
const writing = { registers: [], flags: [], memory: 'unknown_read_write' as const };
const target = (value: bigint) => ({
  kind: 'direct' as const,
  address: { image_id: image, space: 'va' as const, value },
});

/** Two nested loops with exits into one return tail: the inner loop leaves the whole
 * nest with the constant 88, the outer one with 77; the tail's block parameter
 * carries the value, so the inner exit needs a transfer out of both loops. */
function tailConstants(): SSAForm {
  const b = builder('tail-constants'),
    entry = b.block('entry'),
    outer = b.block('outer', [i64]),
    inner = b.block('inner', [i64, i64]),
    step = b.block('step'),
    tail = b.block('tail', [i64]);
  const x = entry.readRegister(rdi);
  entry.jump(outer, [entry.constant(i64, 0n)]);
  const i = outer.parameters[0]!;
  outer.branch(
    outer.compare('eq', i, outer.constant(i64, 3n)),
    outer.edge(tail, [outer.constant(i64, 77n)]),
    outer.edge(inner, [i, outer.constant(i64, 0n)]),
  );
  const [i2, j] = inner.parameters as [typeof i, typeof i];
  inner.branch(
    inner.compare('eq', j, x),
    inner.edge(tail, [inner.constant(i64, 88n)]),
    inner.edge(step),
  );
  step.branch(
    step.compare('eq', j, step.constant(i64, 10n)),
    step.edge(outer, [step.int('add', i2, step.constant(i64, 1n))]),
    step.edge(inner, [i2, step.int('add', j, step.constant(i64, 1n))]),
  );
  tail.return([tail.parameters[0]!]);
  return constructSSA(b.finish(entry, [i64])).value as SSAForm;
}

/** A join entered by two arms: only one of them is a constant. */
function joinConstant(): SSAForm {
  const b = builder('join-constant'),
    entry = b.block('entry'),
    then = b.block('then'),
    otherwise = b.block('otherwise'),
    tail = b.block('tail', [i64]);
  const x = entry.readRegister(rdi);
  entry.branch(
    entry.compare('eq', x, entry.constant(i64, 1n)),
    entry.edge(then),
    entry.edge(otherwise),
  );
  then.jump(tail, [then.constant(i64, 9n)]);
  otherwise.jump(tail, [otherwise.int('add', x, otherwise.constant(i64, 100n))]);
  tail.return([tail.parameters[0]!]);
  return constructSSA(b.finish(entry, [i64])).value as SSAForm;
}

/** A void callee whose final statement is its call; it returns nothing. */
function voidFunction(): SSAForm {
  const b = builder('void-tail'),
    entry = b.block('entry');
  entry.writeRegister(rdi, entry.readRegister(rdi));
  entry.call(target(0x4000n), [], [], writing);
  entry.return([]);
  return constructSSA(b.finish(entry, [])).value as SSAForm;
}

const expected = (x: bigint): bigint => (x <= 10n ? 88n : 77n);

for (const language of ['c-like', 'python-like'] as const) {
  const run = (emission: ReturnType<typeof emit>['emission'], x: bigint) =>
    execute(emission, new Map(emittedFormals(emission)[0]!.semantic_ids.map((id) => [id, x])))
      .values;

  test(`${language} a constant reaching a return through a variable dead after it prints as the return`, () => {
    const { emission } = emit(tailConstants(), { source }, language);
    assert.match(emission.text, /return 88\b/, emission.text);
    // No assignment of the constant immediately followed by the return that reads it.
    assert.doesNotMatch(emission.text, /\w+ = 88;?\n\s*return \w+/, emission.text);
    for (const x of [0n, 1n, 10n, 11n, 100n])
      assert.deepEqual(run(emission, x), [expected(x)], `${x}`);
    assert.ok(emission.local_validation?.some((record) => record.rule === 'return_constant'));
  });

  test(`${language} a join entered by several arms keeps its carrier: the constant is not substituted`, () => {
    const { emission } = emit(joinConstant(), { source }, language);
    for (const x of [0n, 1n, 2n, 0xffffffffffffff9cn])
      assert.deepEqual(run(emission, x), [x === 1n ? 9n : BigInt.asUintN(64, x + 100n)], `${x}`);
  });

  test(`${language} a void function does not end with an explicit return`, () => {
    const { emission } = emit(voidFunction(), { source }, language);
    assert.doesNotMatch(emission.text, /\breturn\b/, emission.text);
    const observed = execute(
      emission,
      new Map(),
      new Map(),
      0n,
      new Map(),
      new Map(),
      new Map([['sub_4000', () => 0n]]),
    );
    assert.equal(observed.exit, 'machine_return');
    assert.deepEqual(observed.values, []);
    if (language === 'python-like') assert.match(emission.text, /-> void:/);
  });
}

test('an open argument list prints `...` in both dialects with its meaning stated once in the header', () => {
  for (const language of ['c-like', 'python-like'] as const) {
    const { emission } = emit(voidFunction(), { source }, language);
    assert.match(emission.text, /sub_4000\(\.\.\.\)/, emission.text);
    assert.doesNotMatch(emission.text, /unknown_argument/, emission.text);
    const note = emission.text
      .split('\n')
      .filter((line) => line.includes('`...` as a call argument'));
    assert.equal(note.length, 1, 'one header line states the meaning');
    assert.ok(emission.helpers.some((helper) => helper.name === 'unknown_arguments'));
  }
  // A function with no open argument list has no such header line.
  const closed = emit(tailConstants(), { source }, 'c-like').emission.text;
  assert.doesNotMatch(closed, /\.\.\./);
});
