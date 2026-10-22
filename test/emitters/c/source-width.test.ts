import assert from 'node:assert/strict';
import test from 'node:test';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { simplifySSA } from '../../../src/analysis/values/index.js';
import { integer, type SSAForm } from '../../../src/ir/index.js';
import { builder, register } from '../../ir/support.js';
import { checkSourceWidths } from './source-width-fixture.js';
import { emit, emittedFormals, execute } from './support.js';

test('source-width arithmetic, carry-preserving additions, masked shifts and indexed loads survive both emitted dialects', () => {
  checkSourceWidths();
});

const i32 = integer(32),
  i64 = integer(64);
const x = (index: number) => register(`arm64:x${index}`, 64, 0, 'replace_root', `arm64:x${index}`);
const w = (index: number) =>
  register(`arm64:w${index}`, 32, 0, 'zero_extend_root', `arm64:x${index}`);

/** Source: `int32_t i = a, n = b; do i = (int32_t)((uint32_t)i + 1); while (i < n);
 * return (int64_t)i;` The counter's reads are a signed comparison and a sign
 * extension (signed spelling: none converts) against one addition (which must
 * stay unsigned arithmetic). */
function counter(): SSAForm {
  const b = builder('source-width-signed-counter'),
    entry = b.block('entry'),
    loop = b.block('loop'),
    exit = b.block('exit');
  entry.writeRegister(w(8), entry.cast('truncate', i32, entry.readRegister(x(0))));
  entry.writeRegister(w(9), entry.cast('truncate', i32, entry.readRegister(x(1))));
  entry.jump(loop);
  const next = loop.int('add', loop.readRegister(w(8)), loop.constant(i32, 1n));
  loop.writeRegister(w(8), next);
  loop.branch(loop.compare('slt', next, loop.readRegister(w(9))), loop.edge(loop), loop.edge(exit));
  exit.return([exit.cast('sign_extend', i64, exit.readRegister(w(8)))]);
  const converted = constructSSA(b.finish(entry, [i64]));
  assert.equal(converted.value.form, 'ssa');
  const simplified = simplifySSA(converted.value as SSAForm);
  assert.equal(simplified.state, 'complete');
  return simplified.value;
}

for (const language of ['c-like', 'python-like'] as const)
  test(`${language} a signed loop counter declared by conversion cost wraps past INT_MAX exactly`, () => {
    const output = emit(
      counter(),
      { source: { abi: new DarwinArm64Abi(), callees: [], addresses: [] } },
      language,
    );
    const emission = output.emission,
      text = emission.text;
    const recorded = emission.local_validation?.some(
      (record) => record.rule === 'local_integer_spelling',
    );
    if (language === 'c-like') {
      // One signed local: the comparison and the extension read it unconverted,
      // the increment converts it to unsigned arithmetic (no signed overflow).
      assert.match(text, /^\s+int32_t (\w+);$/m, text);
      const name = /^\s+int32_t (\w+);$/m.exec(text)![1]!;
      assert.match(text, new RegExp(`\\(uint32_t\\)${name} \\+ 1`), text);
      assert.match(text, new RegExp(`\\b${name} < `), text);
      assert.doesNotMatch(text, /\(int32_t\)/, text);
      assert.ok(recorded, text);
    } else {
      // Python-like integers are unbounded: the machine spelling stays.
      assert.doesNotMatch(text, /: int32_t$/m, text);
      assert.ok(!recorded, text);
    }
    const [first, second] = emittedFormals(emission);
    const run = (a: bigint, n: bigint) =>
      execute(
        emission,
        new Map([
          ...first!.semantic_ids.map((id) => [id, a] as const),
          ...second!.semantic_ids.map((id) => [id, n] as const),
        ]),
      );
    // Oracle (two's-complement source semantics, independent of the IR):
    // the counter steps from a, wrapping at 2^32, until it is not below n.
    const oracle = (a: bigint, n: bigint): bigint => {
      let i = BigInt.asIntN(32, a);
      const bound = BigInt.asIntN(32, n);
      do i = BigInt.asIntN(32, i + 1n);
      while (i < bound);
      return BigInt.asUintN(32, i);
    };
    for (const [a, n] of [
      // INT_MAX + 1 wraps to INT_MIN, which is below INT_MIN + 2: two more steps.
      [0x7fffffffn, 0x80000002n],
      [0x7ffffffen, 0x80000001n],
      // Signed: -3 counts up to 2; unsigned it would stop at once.
      [0xfffffffdn, 2n],
      [0n, 3n],
      [5n, 1n],
    ] as const) {
      const observed = run(a, n);
      assert.equal(observed.exit, 'machine_return', `${a} ${n}`);
      // The narrow signed result's low word (its upper bits are ABI scratch).
      assert.deepEqual(
        observed.values.map((value) => BigInt.asUintN(32, value as bigint)),
        [oracle(a, n)],
        `${a} ${n}\n${text}`,
      );
    }
  });
