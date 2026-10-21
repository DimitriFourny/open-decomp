import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate, floatBits, fromWords, lift, registerBits } from './support.js';

const ret = 0xd65f03c0;

function lifted(word: number, encoding: string) {
  const graph = fromWords([word, ret]);
  const payload = graph.instructions[0]!.payload!;
  if (payload.architecture !== 'arm64') assert.fail('Expected ARM64');
  assert.equal(payload.canonical_encoding, encoding);
  const result = lift(graph);
  assert.ok(
    result.diagnostics.every((diagnostic) => !diagnostic.message.startsWith('Unsupported ARM64')),
    encoding,
  );
  return result;
}

/** Architectural FCVTZ{S,U}: round toward zero, saturate, NaN to zero (independent BigInt model). */
function convertToInteger(value: number, bits: number, signed: boolean): bigint {
  if (Number.isNaN(value)) return 0n;
  const minimum = signed ? -(1n << BigInt(bits - 1)) : 0n,
    maximum = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
  if (value === Infinity) return BigInt.asUintN(bits, maximum);
  if (value === -Infinity) return BigInt.asUintN(bits, minimum);
  const truncated = BigInt(Math.trunc(value));
  return BigInt.asUintN(
    bits,
    truncated < minimum ? minimum : truncated > maximum ? maximum : truncated,
  );
}

test('FCVTZS/FCVTZU round toward zero, saturate and convert NaN to zero for every width pair', () => {
  const values = [
    0,
    -0,
    0.5,
    -0.5,
    1.9,
    -1.9,
    123456.75,
    -123456.75,
    2147483647.5,
    2147483648,
    -2147483648,
    -2147483648.5,
    -2147483649,
    4294967295,
    4294967296,
    4294967296.5,
    2 ** 53,
    2 ** 62,
    9223372036854775807,
    2 ** 63 - 1024,
    2 ** 63,
    -(2 ** 63),
    -(2 ** 63) - 2048,
    2 ** 64,
    1e30,
    -1e30,
    5e-324,
    -5e-324,
    NaN,
    Infinity,
    -Infinity,
  ];
  // [word, encoding, destination bits, source float bits, signed]
  for (const [word, encoding, bits, from, signed] of [
    [0x9e780020, 'FCVTZS_64D_float2int', 64, 64, true],
    [0x1e780020, 'FCVTZS_32D_float2int', 32, 64, true],
    [0x9e380020, 'FCVTZS_64S_float2int', 64, 32, true],
    [0x1e380020, 'FCVTZS_32S_float2int', 32, 32, true],
    [0x9e790020, 'FCVTZU_64D_float2int', 64, 64, false],
    [0x1e790020, 'FCVTZU_32D_float2int', 32, 64, false],
    [0x9e390020, 'FCVTZU_64S_float2int', 64, 32, false],
    [0x1e390020, 'FCVTZU_32S_float2int', 32, 32, false],
  ] as const) {
    const { ir } = lifted(word, encoding);
    for (const value of values) {
      const source = from === 32 ? Math.fround(value) : value;
      const result = evaluate(
        ir,
        new Map([
          ['arm64:x0', 0xdeadbeefcafef00dn],
          ['arm64:v1', (0xabcdn << 64n) | floatBits(source, from)],
        ]),
      );
      assert.equal(
        registerBits(result),
        convertToInteger(source, bits, signed),
        `${encoding}(${source})`,
      );
      // A 32-bit destination zero-extends; the source vector is untouched.
      assert.equal(
        registerBits(result, 'arm64:v1', 128),
        (0xabcdn << 64n) | floatBits(source, from),
      );
    }
  }
});

test('FCVTZS/FCVTZU require the guarded FP environment and leave FPSR unknown', () => {
  const { ir, coverage } = lifted(0x9e780020, 'FCVTZS_64D_float2int');
  assert.equal(coverage.state, 'partial');
  const inputs = new Map([['arm64:v1', floatBits(-7.5, 64)]]);
  const result = evaluate(ir, inputs);
  assert.equal(registerBits(result), BigInt.asUintN(64, -7n));
  assert.equal(result.registers.get('arm64:fpsr')!.known, 0n);
  // Round-to-zero conversion ignores RMode, but trap enables and flush modes are not modeled.
  for (const control of [1n << 22n, 1n << 24n, 1n << 8n, 1n << 15n]) {
    assert.equal(evaluate(ir, new Map([...inputs, ['arm64:fpcr', control]])).status, 'unknown');
  }
});

test('SCVTF/UCVTF fixed-point scale by 2^-fbits with one rounding', () => {
  // [word without fraction, encoding, source bits, destination float bits, signed]
  for (const [base, encoding, source, destination, signed] of [
    [0x9e430000, 'UCVTF_D64_float2fix', 64, 64, false],
    [0x1e430000, 'UCVTF_D32_float2fix', 32, 64, false],
    [0x9e030000, 'UCVTF_S64_float2fix', 64, 32, false],
    [0x1e030000, 'UCVTF_S32_float2fix', 32, 32, false],
    [0x9e420000, 'SCVTF_D64_float2fix', 64, 64, true],
    [0x1e420000, 'SCVTF_D32_float2fix', 32, 64, true],
    [0x9e020000, 'SCVTF_S64_float2fix', 64, 32, true],
    [0x1e020000, 'SCVTF_S32_float2fix', 32, 32, true],
  ] as const) {
    for (const fbits of [1, 3, 16, source]) {
      const word = base | ((64 - fbits) << 10) | (1 << 5);
      const { ir } = lifted(word, encoding);
      for (const raw of [0n, 1n, 5n, 0x7fffffffn, 0x80000000n, 0xffffffffn, 0x8000000000000001n]) {
        const input = BigInt.asUintN(source, raw);
        const integer = signed ? BigInt.asIntN(source, input) : input;
        // Exact for 53-bit-or-narrower magnitudes; wider ones are covered below.
        if (BigInt.asUintN(64, integer < 0n ? -integer : integer) >= 1n << 53n) continue;
        const expected = (Number(integer) / 2 ** fbits) as number;
        const result = evaluate(
          ir,
          new Map([
            ['arm64:x1', source === 64 ? input : 0xffff_ffff_0000_0000n | input],
            ['arm64:v0', (1n << 128n) - 1n],
          ]),
        );
        assert.equal(
          registerBits(result, 'arm64:v0', 128),
          floatBits(expected, destination as 32 | 64),
          `${encoding} #${fbits} of ${integer}`,
        );
      }
    }
  }
});

test('fixed-point conversion rounds the integer once, not through an intermediate double', () => {
  // 2^60 + 2^36 + 1 sits just above a binary32 tie: correct rounding goes up to
  // 2^60 + 2^37, while rounding via binary64 first would drop the +1 and tie down to 2^60.
  const value = (1n << 60n) + (1n << 36n) + 1n;
  const single = lifted(0x9e03fc20, 'UCVTF_S64_float2fix').ir; // ucvtf s0, x1, #1
  const result = evaluate(
    single,
    new Map([
      ['arm64:x1', value],
      ['arm64:v0', 0n],
    ]),
  );
  assert.equal(registerBits(result, 'arm64:v0', 128), floatBits(2 ** 59 + 2 ** 36, 32));
  const double = lifted(0x9e43fc20, 'UCVTF_D64_float2fix').ir; // ucvtf d0, x1, #1
  const odd = evaluate(
    double,
    new Map([
      ['arm64:x1', (1n << 63n) | 1n],
      ['arm64:v0', 0n],
    ]),
  );
  assert.equal(registerBits(odd, 'arm64:v0', 128), floatBits(2 ** 62, 64));
  assert.equal(
    evaluate(
      double,
      new Map([
        ['arm64:x1', 1n],
        ['arm64:fpcr', 1n << 22n],
      ]),
    ).status,
    'unknown',
  );
});

const lane = (value: bigint, size: number, index: number): bigint =>
  BigInt.asUintN(size, value >> BigInt(index * size));
const pack = (lanes: readonly bigint[], size: number): bigint =>
  lanes.reduce(
    (packed, value, index) => packed | (BigInt.asUintN(size, value) << BigInt(index * size)),
    0n,
  );

test('DUP (general) broadcasts the low element bits across 64- and 128-bit vectors', () => {
  const source = 0xfedcba9876543210n;
  for (const [q, imm5, size] of [
    [1, 0b00001, 8],
    [1, 0b00010, 16],
    [1, 0b00100, 32],
    [1, 0b01000, 64],
    [0, 0b00001, 8],
    [0, 0b00010, 16],
    [0, 0b00100, 32],
    [1, 0b10101, 8],
    [1, 0b01100, 32],
  ] as const) {
    const width = q ? 128 : 64;
    const word = 0x0e000c00 | (q << 30) | (imm5 << 16) | (1 << 5);
    const { ir } = lifted(word, 'DUP_asimdins_DR_r');
    const result = evaluate(
      ir,
      new Map([
        ['arm64:x1', source],
        ['arm64:v0', (1n << 128n) - 1n],
      ]),
    );
    const element = BigInt.asUintN(size, source);
    assert.equal(
      registerBits(result, 'arm64:v0', 128),
      pack(
        Array.from({ length: width / size }, () => element),
        size,
      ),
      `q=${q} imm5=${imm5.toString(2)}`,
    );
  }
  // XZR as the source broadcasts zero.
  const zero = lifted(0x4e010fe0, 'DUP_asimdins_DR_r').ir;
  assert.equal(registerBits(evaluate(zero, new Map([['arm64:v0', 5n]])), 'arm64:v0', 128), 0n);
});

test('reserved DUP arrangements stay explicit unknown effects', () => {
  for (const word of [0x0e080c20 /* 1d */, 0x4e100c20 /* imm5 = 10000 */]) {
    const result = lift(fromWords([word, ret]));
    assert.equal(result.coverage.state, 'partial');
    assert.equal(evaluate(result.ir).status, 'unknown');
  }
});

test('CMEQ register produces per-lane all-ones masks at every element width', () => {
  const left = 0x1122334455667788_99aabbccddeeff00n;
  const right = 0x1122334455667788_00aabbccddeeff01n;
  for (const [q, size] of [
    [1, 0],
    [1, 1],
    [1, 2],
    [1, 3],
    [0, 0],
    [0, 1],
    [0, 2],
  ] as const) {
    const element = 8 << size,
      width = q ? 128 : 64;
    const word = 0x2e208c00 | (q << 30) | (size << 22) | (2 << 16) | (1 << 5);
    const { ir } = lifted(word, 'CMEQ_asimdsame_only');
    const result = evaluate(
      ir,
      new Map([
        ['arm64:v0', (1n << 128n) - 1n],
        ['arm64:v1', left],
        ['arm64:v2', right],
      ]),
    );
    const expected = pack(
      Array.from({ length: width / element }, (_, index) =>
        lane(left, element, index) === lane(right, element, index)
          ? (1n << BigInt(element)) - 1n
          : 0n,
      ),
      element,
    );
    assert.equal(registerBits(result, 'arm64:v0', 128), expected, `q=${q} size=${size}`);
  }
  // The same register on both sides is all ones; Rd == Rn reads before it writes.
  const same = lifted(0x6e218c21, 'CMEQ_asimdsame_only').ir; // cmeq v1.16b, v1.16b, v1.16b
  assert.equal(
    registerBits(evaluate(same, new Map([['arm64:v1', left]])), 'arm64:v1', 128),
    (1n << 128n) - 1n,
  );
  const reserved = lift(fromWords([0x2ee28c20, ret])); // cmeq v0.1d: Q=0 size=3
  assert.equal(evaluate(reserved.ir).status, 'unknown');
});

test('AND register is whole-register bitwise and clears the high half for Q=0', () => {
  const left = 0xf0f0f0f0f0f0f0f0_ff00ff00ff00ff00n;
  const right = 0x1234567890abcdef_0ff00ff00ff00ff0n;
  for (const [word, width] of [
    [0x4e221c20, 128],
    [0x0e221c20, 64],
  ] as const) {
    const { ir } = lifted(word, 'AND_asimdsame_only');
    const result = evaluate(
      ir,
      new Map([
        ['arm64:v0', (1n << 128n) - 1n],
        ['arm64:v1', left],
        ['arm64:v2', right],
      ]),
    );
    assert.equal(registerBits(result, 'arm64:v0', 128), BigInt.asUintN(width, left & right));
  }
  // Destination aliasing a source reads both sources before writing.
  const alias = lifted(0x4e211c21, 'AND_asimdsame_only').ir; // and v1.16b, v1.16b, v1.16b
  assert.equal(registerBits(evaluate(alias, new Map([['arm64:v1', left]])), 'arm64:v1', 128), left);
});
