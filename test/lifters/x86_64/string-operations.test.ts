import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyIR } from '../../../src/ir/index.js';
import type { RegisterIR } from '../../../src/ir/index.js';
import { liftBytes, register, run } from './helpers.js';

function lift(hex: string): { ir: RegisterIR; unknown: boolean } {
  const { ir } = liftBytes(`${hex} c3`);
  assert.deepEqual(verifyIR(ir), []);
  return {
    ir,
    unknown: ir.blocks.some((block) =>
      block.instructions.some((node) => node.kind === 'unknown_effect'),
    ),
  };
}
const pattern = (): Uint8Array => Uint8Array.from({ length: 64 }, (_, index) => index + 1);
const memory = () => ({ memory: [{ base: 0x2000n, bytes: pattern(), writable: true }] });
const bytes = (result: ReturnType<typeof run>): number[] => [
  ...result.memory.find((region) => region.base === 0x2000n)!.bytes,
];

test('REP STOS stores RCX elements of the accumulator forward, then RDI and RCX are advanced', () => {
  // No flag is read or written (the IR names no RFLAGS state at all).
  for (const [hex, size] of [
    ['f3 aa', 1],
    ['f3 66 ab', 2],
    ['f3 ab', 4],
    ['f3 48 ab', 8],
  ] as const) {
    const { ir, unknown } = lift(hex);
    assert.ok(!unknown, hex);
    for (const count of [0, 1, 3]) {
      const result = run(
        ir,
        { rdi: 0x2004n, rcx: BigInt(count), rax: 0xa1a2a3a4a5a6a7a8n },
        memory(),
      );
      const expected = [...pattern()];
      for (let i = 0; i < count * size; i++)
        expected[4 + i] = [0xa8, 0xa7, 0xa6, 0xa5, 0xa4, 0xa3, 0xa2, 0xa1][i % size]!;
      assert.deepEqual(bytes(result), expected, `${hex} x${count}`);
      assert.equal(register(result, 'rdi'), 0x2004n + BigInt(count * size));
      assert.equal(register(result, 'rcx'), 0n);
    }
  }
});

test('REP MOVS copies element by element, so an overlapping forward copy repeats the source', () => {
  const { ir, unknown } = lift('f3 a4'); // rep movsb
  assert.ok(!unknown);
  const result = run(ir, { rsi: 0x2000n, rdi: 0x2002n, rcx: 6n }, memory());
  assert.deepEqual(bytes(result).slice(0, 9), [1, 2, 1, 2, 1, 2, 1, 2, 9]);
  assert.equal(register(result, 'rsi'), 0x2006n);
  assert.equal(register(result, 'rdi'), 0x2008n);
  // movsq without REP moves one element.
  const single = run(lift('48 a5').ir, { rsi: 0x2000n, rdi: 0x2010n }, memory());
  assert.deepEqual(bytes(single).slice(16, 24), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('string operations stay unknown when DF may be set or the address size is 32-bit', () => {
  // std anywhere in the function; popfq can load DF; a 32-bit address size; a segment override.
  for (const hex of ['fd f3 aa', '9d f3 aa', 'f3 67 aa', '64 f3 a4'])
    assert.ok(lift(hex).unknown, hex);
  // cld is a no-op when DF is already known clear.
  assert.ok(!lift('fc f3 aa').unknown);
});
