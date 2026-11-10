import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyIR } from '../../../src/ir/index.js';
import { liftBytes, register, run } from './helpers.js';

const mask = (width: number): bigint => (1n << BigInt(width)) - 1n;
const flag = (result: ReturnType<typeof run>, offset: number): bigint =>
  register(result, 'rflags', 1, offset);
const undefinedFlag = (result: ReturnType<typeof run>, offset: number): boolean =>
  ((result.registers.get('x86_64:rflags')!.undefined >> BigInt(offset)) & 1n) === 1n;
const CF = 0,
  PF = 2,
  AF = 4,
  ZF = 6,
  SF = 7,
  OF = 11;
const widths = [
  ['66 ', 16],
  ['', 32],
  ['48 ', 64],
] as const;
// REX must follow the F3 mandatory prefix to take effect.
const mandatory = (prefix: string): string => (prefix === '48 ' ? 'f3 48' : `${prefix}f3`);
function lifted(hex: string) {
  const result = liftBytes(`${hex} c3`);
  assert.deepEqual(verifyIR(result.ir), []);
  assert.ok(
    !result.coverage.reasons.some((reason) => reason.includes('Instruction family')),
    `${hex} is lifted`,
  );
  return result.ir;
}
/** Deterministic operands: edge values plus a fixed pseudo-random walk. */
function samples(width: number): bigint[] {
  const values = [0n, 1n, 2n, 3n, 0x80n, mask(width), 1n << BigInt(width - 1), mask(width - 1)];
  let state = 0x9e3779b97f4a7c15n;
  for (let i = 0; i < 24; i++) {
    state = BigInt.asUintN(64, state * 6364136223846793005n + 1442695040888963407n);
    values.push(BigInt.asUintN(width, state >> BigInt(i % 40)));
  }
  return values;
}
const ctz = (value: bigint, width: number): bigint => {
  let count = 0n;
  while (count < BigInt(width) && ((value >> count) & 1n) === 0n) count++;
  return count;
};
const clz = (value: bigint, width: number): bigint =>
  value === 0n ? BigInt(width) : BigInt(width - value.toString(2).length);
const popcount = (value: bigint): bigint => BigInt(value.toString(2).replaceAll('0', '').length);

test('BSF/BSR: index of the lowest/highest set bit, ZF for a zero source, undefined destination then', () => {
  for (const [prefix, width] of widths)
    for (const [opcode, reference] of [
      ['bc', (value: bigint) => ctz(value, width)],
      ['bd', (value: bigint) => BigInt(width - 1) - clz(value, width)],
    ] as const) {
      const ir = lifted(`${prefix}0f ${opcode} c1`); // bsf/bsr eax, ecx
      const upper = 0x1122334455667788n;
      for (const value of samples(width)) {
        const result = run(ir, { rax: upper, rcx: value, rflags: 0x8d5n });
        assert.equal(flag(result, ZF), value === 0n ? 1n : 0n);
        for (const offset of [CF, PF, AF, SF, OF]) assert.ok(undefinedFlag(result, offset));
        const state = result.registers.get('x86_64:rax')!;
        if (value === 0n) {
          // The 16-bit form keeps the bits above the slice; wider forms lose the whole root.
          const lost = width === 16 ? mask(16) : mask(64);
          assert.equal(state.undefined & mask(64), lost, `${width} zero source`);
          if (width === 16) assert.equal(register(result, 'rax', 48, 16), upper >> 16n);
          continue;
        }
        const expected = reference(value);
        assert.equal(
          register(result, 'rax'),
          width === 16 ? (upper & ~mask(16)) | expected : expected,
          `${opcode} ${width} ${value.toString(16)}`,
        );
      }
    }
});

test('TZCNT/LZCNT count to the operand width; CF marks a zero source and ZF a zero result', () => {
  for (const [prefix, width] of widths)
    for (const [opcode, reference] of [
      ['bc', (value: bigint) => ctz(value, width)],
      ['bd', (value: bigint) => clz(value, width)],
    ] as const) {
      const ir = lifted(`${mandatory(prefix)} 0f ${opcode} c1`);
      for (const value of samples(width)) {
        const result = run(ir, { rax: -1n, rcx: value, rflags: 0n });
        const expected = reference(value);
        assert.equal(
          register(result, 'rax'),
          width === 16 ? (mask(64) & ~mask(16)) | expected : expected,
        );
        assert.equal(flag(result, CF), value === 0n ? 1n : 0n);
        assert.equal(flag(result, ZF), expected === 0n ? 1n : 0n);
        for (const offset of [PF, AF, SF, OF]) assert.ok(undefinedFlag(result, offset));
      }
    }
});

test('POPCNT counts set bits, sets ZF for a zero source and clears the other flags', () => {
  for (const [prefix, width] of widths) {
    const ir = lifted(`${mandatory(prefix)} 0f b8 c1`);
    for (const value of samples(width)) {
      const result = run(ir, { rax: 0n, rcx: value, rflags: 0x8d5n });
      assert.equal(register(result, 'rax', width), popcount(value));
      assert.equal(flag(result, ZF), value === 0n ? 1n : 0n);
      for (const offset of [CF, PF, AF, SF, OF]) assert.equal(flag(result, offset), 0n);
    }
  }
});

/** Reference SHLD/SHRD for a masked count 1..width. */
function doubleShift(left: boolean, value: bigint, fill: bigint, count: number, width: number) {
  const w = BigInt(width),
    c = BigInt(count);
  const result = left
    ? ((value << c) | (fill >> (w - c))) & mask(width)
    : ((value >> c) | (fill << (w - c))) & mask(width);
  const carry = left ? (value >> (w - c)) & 1n : (value >> (c - 1n)) & 1n;
  return { result, carry, overflow: ((result ^ value) >> (w - 1n)) & 1n };
}

test('SHLD/SHRD shift in bits of the source, mask the count, and keep state for a zero count', () => {
  for (const [prefix, width] of widths)
    for (const [left, immediate, byCl] of [
      [true, 'a4', 'a5'],
      [false, 'ac', 'ad'],
    ] as const) {
      const variable = lifted(`${prefix}0f ${byCl} d8`); // shld/shrd eax, ebx, cl
      const values = samples(width);
      for (let index = 0; index < values.length; index++) {
        const value = values[index]!,
          fill = values[(index * 7 + 3) % values.length]!;
        for (const raw of [0, 1, 2, 7, 15, 16, 17, 31, 32, 33, 63, 64, 65, 255]) {
          const count = raw & (width === 64 ? 63 : 31);
          const rax = (0xa5a5a5a5a5a5a5a5n & ~mask(width)) | value;
          const result = run(variable, { rax, rcx: BigInt(raw), rbx: fill, rflags: 0x8d5n });
          const label = `${left ? 'shld' : 'shrd'}${width} ${value.toString(16)},${fill.toString(16)} by ${raw}`;
          if (count === 0) {
            // Nothing changes but the architectural 32-bit zero extension.
            assert.equal(register(result, 'rax'), width === 32 ? value : rax, label);
            assert.equal(register(result, 'rflags', 12), 0x8d5n, label);
            continue;
          }
          if (count > width) {
            const state = result.registers.get('x86_64:rax')!;
            assert.equal(state.undefined & mask(64), mask(16), label);
            assert.equal(register(result, 'rax', 48, 16), rax >> 16n, label);
            for (const offset of [CF, PF, AF, ZF, SF, OF]) assert.ok(undefinedFlag(result, offset));
            continue;
          }
          const expected = doubleShift(left, value, fill, count, width);
          assert.equal(
            register(result, 'rax'),
            width === 16 ? (rax & ~mask(16)) | expected.result : expected.result,
            label,
          );
          assert.equal(flag(result, CF), expected.carry, `${label} CF`);
          assert.equal(flag(result, ZF), expected.result === 0n ? 1n : 0n, `${label} ZF`);
          assert.equal(flag(result, SF), expected.result >> BigInt(width - 1), `${label} SF`);
          assert.ok(undefinedFlag(result, AF));
          if (count === 1) assert.equal(flag(result, OF), expected.overflow, `${label} OF`);
          else assert.ok(undefinedFlag(result, OF), `${label} OF`);
        }
      }
      // The immediate form masks its count the same way: imm 0x41 is 1 for 64-bit operands.
      const once = lifted(`${prefix}0f ${immediate} d8 ${width === 64 ? '41' : '21'}`);
      const value = (0x8000000000000001n & mask(width)) | (1n << BigInt(width - 1)),
        fill = mask(width);
      const result = run(once, { rax: value, rbx: fill, rflags: 0n });
      const expected = doubleShift(left, value, fill, 1, width);
      assert.equal(register(result, 'rax', width), expected.result);
      assert.equal(flag(result, CF), expected.carry);
      assert.equal(flag(result, OF), expected.overflow);
    }
});

test('SHLD/SHRD on memory read and write the operand in place', () => {
  // shld qword [rdx], rbx, cl ; shrd word [rdx], rbx, 3
  const bytes = (): Uint8Array => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 0x88]);
  let result = run(
    lifted('48 0f a5 1a'),
    { rdx: 0x2000n, rbx: 0xf000000000000000n, rcx: 4n },
    { memory: [{ base: 0x2000n, bytes: bytes(), writable: true }] },
  );
  const view = (r: typeof result) =>
    Buffer.from(r.memory.find((region) => region.base === 0x2000n)!.bytes).readBigUInt64LE();
  assert.equal(view(result), BigInt.asUintN(64, (0x8807060504030201n << 4n) | 0xfn));
  result = run(
    lifted('66 0f ac 1a 03'),
    { rdx: 0x2000n, rbx: 0x5n },
    { memory: [{ base: 0x2000n, bytes: bytes(), writable: true }] },
  );
  assert.equal(view(result) & 0xffffn, ((0x0201n >> 3n) | (0x5n << 13n)) & 0xffffn);
  assert.equal(view(result) >> 16n, 0x8807060504030201n >> 16n);
});
