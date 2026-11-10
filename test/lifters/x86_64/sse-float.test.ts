import assert from 'node:assert/strict';
import { test } from 'node:test';
import { floatBits, verifyIR } from '../../../src/ir/index.js';
import type { RegisterIR } from '../../../src/ir/index.js';
import { liftBytes, register, run } from './helpers.js';

const mask = (width: number): bigint => (1n << BigInt(width)) - 1n;
function lifted(hex: string): RegisterIR {
  const result = liftBytes(`${hex} c3`);
  assert.deepEqual(verifyIR(result.ir), []);
  assert.ok(
    !result.coverage.reasons.some((reason) => reason.includes('Instruction family')),
    `${hex} is lifted`,
  );
  return result.ir;
}
const f64 = (value: number): bigint => floatBits(value, 64);
const f32 = (value: number): bigint => floatBits(value, 32);
// A NaN with a payload: MIN/MAX/CMP pass operand bits through exactly.
const nan64 = 0x7ff4000000000123n,
  nan32 = 0x7fa00123n;

test('CVTTSD2SI/CVTTSS2SI truncate; NaN and out-of-range give the integer indefinite value', () => {
  const cases = [
    // [opcode, source bits, expected destination]
    ['f2 0f 2c c0', f64(2147483647.9), 0x7fffffffn],
    ['f2 0f 2c c0', f64(-2147483648.9), 0x80000000n],
    ['f2 0f 2c c0', f64(2147483648), 0x80000000n],
    ['f2 0f 2c c0', f64(-2147483649), 0x80000000n],
    ['f2 0f 2c c0', f64(-1.5), 0xffffffffn],
    ['f2 0f 2c c0', f64(-0.5), 0n],
    ['f2 0f 2c c0', f64(Infinity), 0x80000000n],
    ['f2 0f 2c c0', nan64, 0x80000000n],
    ['f2 48 0f 2c c0', f64(2 ** 63 - 1024), 0x7ffffffffffffc00n],
    ['f2 48 0f 2c c0', f64(-(2 ** 63)), 1n << 63n],
    ['f2 48 0f 2c c0', f64(2 ** 63), 1n << 63n],
    ['f2 48 0f 2c c0', f64(-(2 ** 63) - 2048), 1n << 63n],
    ['f2 48 0f 2c c0', f64(-123456.75), BigInt.asUintN(64, -123456n)],
    ['f3 0f 2c c0', f32(2147483520), 0x7fffff80n],
    ['f3 0f 2c c0', f32(2 ** 31), 0x80000000n],
    ['f3 0f 2c c0', f32(-(2 ** 31)), 0x80000000n],
    ['f3 0f 2c c0', f32(-(2 ** 31) - 256), 0x80000000n],
    ['f3 0f 2c c0', nan32, 0x80000000n],
    ['f3 48 0f 2c c0', f32(-(2 ** 40)), BigInt.asUintN(64, -(2n ** 40n))],
    ['f3 48 0f 2c c0', f32(2 ** 63), 1n << 63n],
  ] as const;
  for (const [opcode, source, expected] of cases) {
    const result = run(lifted(opcode), { rax: -1n, zmm0: (0x55n << 64n) | source });
    assert.equal(register(result, 'rax'), expected, `${opcode} ${source.toString(16)}`);
  }
  // Unsupported MXCSR environments end at the explicit guard.
  assert.equal(run(lifted('f2 0f 2c c0'), { mxcsr: 0x1f00n }).status, 'unknown');
});

test('CVTSS2SD/CVTSD2SS convert the low lane with nearest-even rounding; upper bits stay', () => {
  const upper = 0xfeedn << 64n;
  let result = run(lifted('f3 0f 5a c1'), { zmm0: upper | 0x1234n, zmm1: f32(1.5) });
  assert.equal(register(result, 'zmm0', 128), upper | f64(1.5));
  result = run(lifted('f3 0f 5a c1'), { zmm1: 1n }); // smallest float subnormal is exact
  assert.equal(register(result, 'zmm0', 64), f64(2 ** -149));
  for (const [value, expected] of [
    [0.1, Math.fround(0.1)],
    [1 + 2 ** -24, 1],
    [1 + 3 * 2 ** -24, 1 + 2 ** -22],
    [1e300, Infinity],
    [-1e-50, -0],
  ] as const) {
    result = run(lifted('f2 0f 5a c1'), { zmm0: upper | (0xabcdn << 32n), zmm1: f64(value) });
    assert.equal(register(result, 'zmm0', 32), f32(expected), `${value}`);
    assert.equal(register(result, 'zmm0', 96, 32), (upper | (0xabcdn << 32n)) >> 32n);
  }
});

test('SQRTSS/SQRTSD replace the low lane with the square root', () => {
  let result = run(lifted('f2 0f 51 c1'), { zmm0: 7n << 64n, zmm1: f64(2) });
  assert.equal(register(result, 'zmm0', 128), (7n << 64n) | f64(Math.SQRT2));
  result = run(lifted('f3 0f 51 c1'), { zmm1: f32(6.25) });
  assert.equal(register(result, 'zmm0', 32), f32(2.5));
});

test('MIN/MAX return the second operand for NaN or equal operands, bit for bit', () => {
  const cases = [
    // [left, right, min, max] as 64-bit patterns
    [f64(1), f64(2), f64(1), f64(2)],
    [f64(2), f64(1), f64(1), f64(2)],
    [f64(0), f64(-0), f64(-0), f64(-0)],
    [f64(-0), f64(0), f64(0), f64(0)],
    [f64(1), nan64, nan64, nan64],
    [nan64, f64(1), f64(1), f64(1)],
    [f64(-Infinity), f64(3), f64(-Infinity), f64(3)],
  ] as const;
  for (const [left, right, minimum, maximum] of cases) {
    const operands = { zmm0: (9n << 64n) | left, zmm1: right };
    assert.equal(
      register(run(lifted('f2 0f 5d c1'), operands), 'zmm0', 128),
      (9n << 64n) | minimum,
    );
    assert.equal(
      register(run(lifted('f2 0f 5f c1'), operands), 'zmm0', 128),
      (9n << 64n) | maximum,
    );
    // minpd/maxpd: both lanes.
    const packed = { zmm0: (left << 64n) | left, zmm1: (right << 64n) | right };
    assert.equal(
      register(run(lifted('66 0f 5d c1'), packed), 'zmm0', 128),
      (minimum << 64n) | minimum,
    );
    assert.equal(
      register(run(lifted('66 0f 5f c1'), packed), 'zmm0', 128),
      (maximum << 64n) | maximum,
    );
  }
  const single = { zmm0: f32(-2), zmm1: nan32 };
  assert.equal(register(run(lifted('f3 0f 5d c1'), single), 'zmm0', 32), nan32);
  assert.equal(register(run(lifted('f3 0f 5f c1'), single), 'zmm0', 32), nan32);
});

test('CMPSD/CMPSS/CMPPD/CMPPS predicates 0-7 write all-ones or zero lanes', () => {
  // EQ, LT, LE, UNORD, NEQ, NLT, NLE, ORD for (x, y)
  const truth = (x: number, y: number): boolean[] => {
    const unordered = Number.isNaN(x) || Number.isNaN(y);
    return [x === y, x < y, x <= y, unordered, !(x === y), !(x < y), !(x <= y), !unordered];
  };
  for (const [x, y] of [
    [1, 2],
    [2, 1],
    [3, 3],
    [0, -0],
    [1, NaN],
    [NaN, NaN],
  ] as const) {
    const expected = truth(x, y);
    for (let predicate = 0; predicate < 8; predicate++) {
      const imm = (predicate | (predicate === 3 ? 8 : 0)).toString(16).padStart(2, '0');
      const bits = (value: number, width: 32 | 64): bigint =>
        Number.isNaN(value) ? (width === 64 ? nan64 : nan32) : floatBits(value, width);
      let result = run(lifted(`f2 0f c2 c1 ${imm}`), {
        zmm0: (5n << 64n) | bits(x, 64),
        zmm1: bits(y, 64),
      });
      assert.equal(
        register(result, 'zmm0', 128),
        (5n << 64n) | (expected[predicate] ? mask(64) : 0n),
        `cmpsd ${x} ${y} #${predicate}`,
      );
      result = run(lifted(`0f c2 c1 ${imm}`), {
        zmm0: bits(x, 32) * 0x0000000100000001_0000000100000001n,
        zmm1: bits(y, 32) * 0x0000000100000001_0000000100000001n,
      });
      assert.equal(register(result, 'zmm0', 128), expected[predicate] ? mask(128) : 0n);
    }
  }
});

test('packed conversions: truncation to the indefinite value, exact widening, zeroed upper half', () => {
  // cvttpd2dq xmm0, xmm1
  let result = run(lifted('66 0f e6 c1'), { zmm0: -1n, zmm1: (nan64 << 64n) | f64(-7.9) });
  assert.equal(register(result, 'zmm0', 128), (0x80000000n << 32n) | 0xfffffff9n);
  // cvttps2dq xmm0, xmm1
  result = run(lifted('f3 0f 5b c1'), {
    zmm1: (f32(2 ** 31) << 96n) | (f32(-1.5) << 64n) | (f32(3.99) << 32n) | f32(-(2 ** 31)),
  });
  assert.equal(
    register(result, 'zmm0', 128),
    (0x80000000n << 96n) | (0xffffffffn << 64n) | (3n << 32n) | 0x80000000n,
  );
  // cvtdq2pd xmm0, xmm1 reads the low two doublewords
  result = run(lifted('f3 0f e6 c1'), { zmm1: (0x1234n << 64n) | (0xfffffffen << 32n) | 7n });
  assert.equal(register(result, 'zmm0', 128), (f64(-2) << 64n) | f64(7));
  // cvtdq2ps rounds to nearest even: 16777217 -> 16777216
  result = run(lifted('0f 5b c1'), { zmm1: 16777217n });
  assert.equal(register(result, 'zmm0', 32), f32(16777216));
  // cvtps2pd / cvtpd2ps
  result = run(lifted('0f 5a c1'), { zmm1: (f32(0.1) << 32n) | f32(-2) });
  assert.equal(register(result, 'zmm0', 128), (f64(Math.fround(0.1)) << 64n) | f64(-2));
  result = run(lifted('66 0f 5a c1'), { zmm0: -1n, zmm1: (f64(1e300) << 64n) | f64(0.1) });
  assert.equal(register(result, 'zmm0', 128), (f32(Infinity) << 32n) | f32(0.1));
});
