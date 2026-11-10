import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyIR } from '../../../src/ir/index.js';
import type { RegisterIR } from '../../../src/ir/index.js';
import { liftBytes, register, run } from './helpers.js';

const mask = (width: number): bigint => (1n << BigInt(width)) - 1n;
const upper = 0xabcdn << 200n; // bits above 127 that legacy SSE preserves
function lifted(hex: string): RegisterIR {
  const result = liftBytes(`${hex} c3`);
  assert.deepEqual(verifyIR(result.ir), []);
  assert.ok(
    !result.ir.blocks.some((block) =>
      block.instructions.some((node) => node.kind === 'unknown_effect'),
    ),
    `${hex} is lifted`,
  );
  return result.ir;
}
const lanes = (value: bigint, size: number): bigint[] =>
  Array.from({ length: 128 / size }, (_, i) => (value >> BigInt(i * size)) & mask(size));
const join = (parts: readonly bigint[], size: number): bigint =>
  parts.reduce((sum, part, i) => sum | ((part & mask(size)) << BigInt(i * size)), 0n);
const signed = (value: bigint, size: number): bigint => BigInt.asIntN(size, value);
function vectors(): [bigint, bigint][] {
  const out: [bigint, bigint][] = [
    [0n, 0n],
    [mask(128), 0n],
    [0x8000_7fff_0080_ff7f_8000_0000_ffff_0001n, 0x7fff_8000_ff7f_0080_0000_8000_0001_ffffn],
  ];
  let state = 0x243f6a8885a308d3n;
  const next = (): bigint => {
    state = BigInt.asUintN(64, state * 6364136223846793005n + 1442695040888963407n);
    return state;
  };
  for (let i = 0; i < 12; i++) {
    const a = (next() << 64n) | next(),
      b = i % 3 === 0 ? a ^ (next() & 0xff00ff00n) : (next() << 64n) | next();
    out.push([a, b]);
  }
  return out;
}
/** Run `op xmm0, xmm1` and return xmm0, checking bits above 127 are preserved. */
function binary(ir: RegisterIR, left: bigint, right?: bigint): bigint {
  const result = run(ir, { zmm0: upper | left, ...(right === undefined ? {} : { zmm1: right }) });
  assert.equal(register(result, 'zmm0', 384, 128), upper >> 128n);
  return register(result, 'zmm0', 128);
}

test('PUNPCKL/H and UNPCKL/H interleave the low or high halves, destination first', () => {
  const forms = [
    ['66 0f 60', 8, false],
    ['66 0f 61', 16, false],
    ['66 0f 62', 32, false],
    ['66 0f 6c', 64, false],
    ['66 0f 68', 8, true],
    ['66 0f 69', 16, true],
    ['66 0f 6a', 32, true],
    ['66 0f 6d', 64, true],
    ['0f 14', 32, false],
    ['0f 15', 32, true],
    ['66 0f 14', 64, false],
    ['66 0f 15', 64, true],
  ] as const;
  for (const [opcode, size, high] of forms) {
    const ir = lifted(`${opcode} c1`);
    for (const [a, b] of vectors()) {
      const half = 64 / size,
        base = high ? half : 0;
      const parts: bigint[] = [];
      for (let i = base; i < base + half; i++) parts.push(lanes(a, size)[i]!, lanes(b, size)[i]!);
      assert.equal(binary(ir, a, b), join(parts, size), `${opcode} ${size}`);
    }
  }
  // punpcklqdq xmm0, xmm0 duplicates the low quadword.
  const result = run(lifted('66 0f 6c c0'), { zmm0: (0x1111n << 64n) | 0x2222n });
  assert.equal(register(result, 'zmm0', 128), (0x2222n << 64n) | 0x2222n);
});

test('PSHUFD/PSHUFLW/PSHUFHW/SHUFPS/SHUFPD select lanes by the immediate', () => {
  for (const order of [0x1b, 0xe4, 0x4e, 0x00, 0xff, 0x9c, 0x39]) {
    const hex = order.toString(16).padStart(2, '0');
    const pick = (i: number): number => (order >> (2 * i)) & 3;
    for (const [a, b] of vectors()) {
      const d = lanes(b, 32),
        w = lanes(b, 16);
      assert.equal(
        binary(lifted(`66 0f 70 c1 ${hex}`), a, b),
        join(
          [0, 1, 2, 3].map((i) => d[pick(i)]!),
          32,
        ),
      );
      assert.equal(
        binary(lifted(`f2 0f 70 c1 ${hex}`), a, b),
        join([...[0, 1, 2, 3].map((i) => w[pick(i)]!), ...w.slice(4)], 16),
      );
      assert.equal(
        binary(lifted(`f3 0f 70 c1 ${hex}`), a, b),
        join([...w.slice(0, 4), ...[0, 1, 2, 3].map((i) => w[4 + pick(i)]!)], 16),
      );
      const s = lanes(a, 32);
      assert.equal(
        binary(lifted(`0f c6 c1 ${hex}`), a, b),
        join([s[pick(0)]!, s[pick(1)]!, d[pick(2)]!, d[pick(3)]!], 32),
      );
      assert.equal(
        binary(lifted(`66 0f c6 c1 ${hex}`), a, b),
        join([lanes(a, 64)[order & 1]!, lanes(b, 64)[(order >> 1) & 1]!], 64),
      );
    }
  }
});

test('PCMPEQ/PCMPGT produce lane masks; PMAX/PMIN select lanes', () => {
  const forms = [
    ['66 0f 74', 8, (x: bigint, y: bigint) => (x === y ? -1n : 0n)],
    ['66 0f 75', 16, (x: bigint, y: bigint) => (x === y ? -1n : 0n)],
    ['66 0f 76', 32, (x: bigint, y: bigint) => (x === y ? -1n : 0n)],
    ['66 0f 38 29', 64, (x: bigint, y: bigint) => (x === y ? -1n : 0n)],
    ['66 0f 64', 8, (x: bigint, y: bigint) => (signed(x, 8) > signed(y, 8) ? -1n : 0n)],
    ['66 0f 65', 16, (x: bigint, y: bigint) => (signed(x, 16) > signed(y, 16) ? -1n : 0n)],
    ['66 0f 66', 32, (x: bigint, y: bigint) => (signed(x, 32) > signed(y, 32) ? -1n : 0n)],
    ['66 0f 38 37', 64, (x: bigint, y: bigint) => (signed(x, 64) > signed(y, 64) ? -1n : 0n)],
    ['66 0f de', 8, (x: bigint, y: bigint) => (x > y ? x : y)],
    ['66 0f da', 8, (x: bigint, y: bigint) => (x < y ? x : y)],
    ['66 0f ee', 16, (x: bigint, y: bigint) => (signed(x, 16) > signed(y, 16) ? x : y)],
    ['66 0f ea', 16, (x: bigint, y: bigint) => (signed(x, 16) < signed(y, 16) ? x : y)],
    ['66 0f 38 3d', 32, (x: bigint, y: bigint) => (signed(x, 32) > signed(y, 32) ? x : y)],
    ['66 0f 38 3b', 32, (x: bigint, y: bigint) => (x < y ? x : y)],
  ] as const;
  for (const [opcode, size, reference] of forms) {
    const ir = lifted(`${opcode} c1`);
    for (const [a, b] of vectors()) {
      const left = lanes(a, size),
        right = lanes(b, size);
      assert.equal(
        binary(ir, a, b),
        join(
          left.map((x, i) => reference(x, right[i]!)),
          size,
        ),
        `${opcode}`,
      );
    }
  }
  // pcmpeqd xmm0, xmm0 is all ones without reading xmm0.
  const ones = lifted('66 0f 76 c0');
  assert.equal(register(run(ones, { zmm0: upper }), 'zmm0', 128), mask(128));
});

test('PMOVMSKB/MOVMSKPS/MOVMSKPD gather lane sign bits into a zero-extended GPR', () => {
  for (const [opcode, size] of [
    ['66 0f d7', 8],
    ['0f 50', 32],
    ['66 0f 50', 64],
  ] as const)
    for (const [, b] of vectors()) {
      const result = run(lifted(`${opcode} c1`), { rax: -1n, zmm1: b });
      const expected = lanes(b, size).reduce(
        (sum, lane, i) => sum | ((lane >> BigInt(size - 1)) << BigInt(i)),
        0n,
      );
      assert.equal(register(result, 'rax'), expected);
    }
});

test('PINSRW/PEXTRW move one word selected by the low three immediate bits', () => {
  for (const [a] of vectors())
    for (const index of [0, 5, 7, 13]) {
      const hex = index.toString(16).padStart(2, '0'),
        lane = index & 7;
      let result = run(lifted(`66 0f c4 c1 ${hex}`), {
        zmm0: upper | a,
        rcx: 0xdead_beef_1234_5678n,
      });
      assert.equal(
        register(result, 'zmm0', 128),
        (a & ~(mask(16) << BigInt(lane * 16))) | (0x5678n << BigInt(lane * 16)),
      );
      result = run(lifted(`66 48 0f c5 c1 ${hex}`), { rax: -1n, zmm1: a });
      assert.equal(register(result, 'rax'), lanes(a, 16)[lane]);
    }
});

test('packed shifts clamp counts at the lane width; PSLLDQ/PSRLDQ shift whole bytes', () => {
  const forms = [
    ['d1', 'lshr', 16],
    ['d2', 'lshr', 32],
    ['d3', 'lshr', 64],
    ['e1', 'ashr', 16],
    ['e2', 'ashr', 32],
    ['f1', 'shl', 16],
    ['f2', 'shl', 32],
    ['f3', 'shl', 64],
  ] as const;
  const shift = (op: string, lane: bigint, count: bigint, size: number): bigint => {
    if (op === 'ashr') return signed(lane, size) >> (count < BigInt(size) ? count : BigInt(size));
    if (count >= BigInt(size)) return 0n;
    return op === 'shl' ? lane << count : lane >> count;
  };
  for (const [opcode, op, size] of forms) {
    const ir = lifted(`66 0f ${opcode} c1`);
    for (const [a] of vectors())
      for (const count of [0n, 1n, 7n, 15n, 16n, 17n, 31n, 32n, 63n, 64n, 1n << 40n, mask(64)]) {
        const expected = join(
          lanes(a, size).map((lane) => shift(op, lane, count, size)),
          size,
        );
        // Only the low quadword of the count register matters.
        assert.equal(binary(ir, a, (0x77n << 64n) | count), expected, `${opcode} by ${count}`);
      }
  }
  for (const [group, extension, op, size] of [
    ['71', 2, 'lshr', 16],
    ['71', 4, 'ashr', 16],
    ['71', 6, 'shl', 16],
    ['72', 2, 'lshr', 32],
    ['72', 4, 'ashr', 32],
    ['73', 6, 'shl', 64],
  ] as const)
    for (const count of [0, 3, 15, 16, 31, 33, 64, 255]) {
      const modrm = (0xc0 | (extension << 3)).toString(16);
      const ir = lifted(`66 0f ${group} ${modrm} ${count.toString(16).padStart(2, '0')}`);
      for (const [a] of vectors())
        assert.equal(
          binary(ir, a),
          join(
            lanes(a, size).map((lane) => shift(op, lane, BigInt(count), size)),
            size,
          ),
        );
    }
  for (const count of [0, 1, 5, 15, 16, 200]) {
    const hex = count.toString(16).padStart(2, '0');
    for (const [a] of vectors()) {
      const bits = BigInt(count > 15 ? 128 : count * 8);
      assert.equal(binary(lifted(`66 0f 73 d8 ${hex}`), a), (a >> bits) & mask(128));
      assert.equal(binary(lifted(`66 0f 73 f8 ${hex}`), a), (a << bits) & mask(128));
    }
  }
});

test('PMULUDQ multiplies the even doublewords; PMULLW keeps the low product words', () => {
  for (const [a, b] of vectors()) {
    const x = lanes(a, 32),
      y = lanes(b, 32);
    assert.equal(binary(lifted('66 0f f4 c1'), a, b), join([x[0]! * y[0]!, x[2]! * y[2]!], 64));
    const v = lanes(a, 16),
      w = lanes(b, 16);
    assert.equal(
      binary(lifted('66 0f d5 c1'), a, b),
      join(
        v.map((lane, i) => lane * w[i]!),
        16,
      ),
    );
  }
});

test('MOVHPS/MOVLPS/MOVHLPS/MOVLHPS move one quadword and keep the other', () => {
  const quad = 0x0102030405060708n,
    bytes = (): Uint8Array => {
      const buffer = Buffer.alloc(8);
      buffer.writeBigUInt64LE(quad);
      return Uint8Array.from(buffer);
    };
  const region = () => ({ memory: [{ base: 0x2000n, bytes: bytes(), writable: true }] });
  for (const [a, b] of vectors()) {
    const [low, high] = lanes(a, 64);
    // movhps/movhpd xmm0, [rdx] ; movlps/movlpd xmm0, [rdx]
    for (const opcode of ['0f 16', '66 0f 16'])
      assert.equal(
        register(run(lifted(`${opcode} 02`), { zmm0: a, rdx: 0x2000n }, region()), 'zmm0', 128),
        join([low!, quad], 64),
      );
    for (const opcode of ['0f 12', '66 0f 12'])
      assert.equal(
        register(run(lifted(`${opcode} 02`), { zmm0: a, rdx: 0x2000n }, region()), 'zmm0', 128),
        join([quad, high!], 64),
      );
    // movhps [rdx], xmm0 / movlps [rdx], xmm0
    for (const [opcode, expected] of [
      ['0f 17', high],
      ['0f 13', low],
    ] as const) {
      const result = run(lifted(`${opcode} 02`), { zmm0: a, rdx: 0x2000n }, region());
      const stored = Buffer.from(result.memory.find((r) => r.base === 0x2000n)!.bytes);
      assert.equal(stored.readBigUInt64LE(), expected);
    }
    const [low2, high2] = lanes(b, 64);
    assert.equal(binary(lifted('0f 12 c1'), a, b), join([high2!, high!], 64)); // movhlps
    assert.equal(binary(lifted('0f 16 c1'), a, b), join([low!, low2!], 64)); // movlhps
  }
});

test('an m128 source must be 16-byte aligned; a 64-bit half move need not be', () => {
  const region = { memory: [{ base: 0x2000n, bytes: new Uint8Array(0x40), writable: true }] };
  assert.equal(run(lifted('66 0f 70 02 1b'), { rdx: 0x2008n }, region).status, 'memory_fault');
  assert.equal(run(lifted('66 0f 70 02 1b'), { rdx: 0x2010n }, region).status, 'returned');
  assert.equal(run(lifted('0f 16 02'), { rdx: 0x2008n }, region).status, 'returned');
});
