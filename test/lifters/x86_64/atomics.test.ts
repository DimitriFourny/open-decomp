import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyIR } from '../../../src/ir/index.js';
import type { RegisterIR } from '../../../src/ir/index.js';
import { liftBytes, register, run } from './helpers.js';

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
// Memory events of the instruction, without the RET's return-address load.
const kinds = (ir: RegisterIR): string[] =>
  ir.blocks
    .flatMap((block) =>
      block.instructions
        .filter((node) => ['memory_fence', 'load', 'store'].includes(node.kind))
        .map((node) => node.kind),
    )
    .slice(0, -1);
function memory(value: bigint) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt.asUintN(64, value));
  return { memory: [{ base: 0x2000n, bytes: Uint8Array.from(bytes), writable: true }] };
}
const stored = (result: ReturnType<typeof run>): bigint =>
  Buffer.from(result.memory.find((region) => region.base === 0x2000n)!.bytes).readBigUInt64LE();

test('a LOCK read-modify-write is the plain operation between two memory fences', () => {
  // lock or qword [rsp], 0 (the GCC barrier idiom)
  const ir = lifted('f0 48 83 0c 24 00');
  assert.deepEqual(kinds(ir), ['memory_fence', 'load', 'store', 'memory_fence']);
  let result = run(ir, { rflags: 0x8d5n });
  assert.equal(register(result, 'rflags', 1, 0), 0n);
  assert.equal(register(result, 'rflags', 1, 6), 1n);
  // lock add dword [rdx], ecx ; lock inc qword [rdx] ; lock neg qword [rdx] ; lock not byte [rdx]
  result = run(lifted('f0 01 0a'), { rdx: 0x2000n, rcx: 0xffffffffn }, memory(0x1122334400000001n));
  assert.equal(stored(result), 0x1122334400000000n);
  assert.equal(register(result, 'rflags', 1, 0), 1n);
  result = run(lifted('f0 48 ff 02'), { rdx: 0x2000n, rflags: 1n }, memory(-1n));
  assert.equal(stored(result), 0n);
  assert.equal(register(result, 'rflags', 1, 0), 1n, 'INC preserves CF');
  result = run(lifted('f0 48 f7 1a'), { rdx: 0x2000n }, memory(5n));
  assert.equal(stored(result), BigInt.asUintN(64, -5n));
  result = run(lifted('f0 f6 12'), { rdx: 0x2000n }, memory(0x0fn));
  assert.equal(stored(result), 0xf0n);
  // lock btr dword [rdx], 1
  result = run(lifted('f0 0f ba 32 01'), { rdx: 0x2000n }, memory(3n));
  assert.equal(stored(result), 1n);
  assert.equal(register(result, 'rflags', 1, 0), 1n);
});

test('XCHG with memory is implicitly locked and swaps', () => {
  const ir = lifted('48 87 0a'); // xchg qword [rdx], rcx
  assert.deepEqual(kinds(ir), ['memory_fence', 'load', 'store', 'memory_fence']);
  const result = run(ir, { rdx: 0x2000n, rcx: 7n }, memory(9n));
  assert.equal(stored(result), 7n);
  assert.equal(register(result, 'rcx'), 9n);
});

test('CMPXCHG compares with the accumulator, stores the old value back on failure', () => {
  // lock cmpxchg qword [rdx], rcx
  const wide = lifted('f0 48 0f b1 0a');
  let result = run(wide, { rdx: 0x2000n, rax: 5n, rcx: 8n }, memory(5n));
  assert.equal(stored(result), 8n);
  assert.equal(register(result, 'rax'), 5n);
  assert.equal(register(result, 'rflags', 1, 6), 1n);
  result = run(wide, { rdx: 0x2000n, rax: 4n, rcx: 8n }, memory(5n));
  assert.equal(stored(result), 5n);
  assert.equal(register(result, 'rax'), 5n);
  assert.equal(register(result, 'rflags', 1, 6), 0n);
  assert.equal(register(result, 'rflags', 1, 0), 1n, 'CF of 4 - 5');
  // lock cmpxchg dword [rdx], ecx: EAX is written (zero-extending RAX) only on failure.
  const narrow = lifted('f0 0f b1 0a');
  result = run(narrow, { rdx: 0x2000n, rax: 0xffffffff00000005n, rcx: 8n }, memory(5n));
  assert.equal(register(result, 'rax'), 0xffffffff00000005n);
  assert.equal(stored(result), 8n);
  result = run(narrow, { rdx: 0x2000n, rax: 0xffffffff00000004n, rcx: 8n }, memory(5n));
  assert.equal(register(result, 'rax'), 5n);
  assert.equal(stored(result), 5n);
  // cmpxchg byte [rdx], cl only touches AL.
  result = run(lifted('0f b0 0a'), { rdx: 0x2000n, rax: 0x1234n, rcx: 1n }, memory(0x99n));
  assert.equal(register(result, 'rax'), 0x1299n);
});

test('XADD stores the sum and returns the old destination', () => {
  let result = run(lifted('f0 48 0f c1 0a'), { rdx: 0x2000n, rcx: 3n }, memory(-1n));
  assert.equal(stored(result), 2n);
  assert.equal(register(result, 'rcx'), BigInt.asUintN(64, -1n));
  assert.equal(register(result, 'rflags', 1, 0), 1n);
  // xadd rax, rax: the destination write wins.
  result = run(lifted('48 0f c1 c0'), { rax: 21n });
  assert.equal(register(result, 'rax'), 42n);
  // xadd eax, ecx: both 32-bit writes zero-extend.
  result = run(lifted('0f c1 c8'), { rax: -1n, rcx: 0xffffffff00000002n });
  assert.equal(register(result, 'rax'), 1n);
  assert.equal(register(result, 'rcx'), 0xffffffffn);
});

test('MFENCE/LFENCE/SFENCE are memory fences and PAUSE is a no-op', () => {
  for (const hex of ['0f ae f0', '0f ae e8', '0f ae f8'])
    assert.deepEqual(kinds(lifted(hex)), ['memory_fence']);
  assert.deepEqual(kinds(lifted('f3 90')), []);
});

test('LOCK forms without a modeled read-modify-write stay unknown', () => {
  for (const hex of ['f0 48 0f c7 0a', 'f0 0f c7 0a']) {
    // cmpxchg16b / cmpxchg8b
    const { ir, coverage } = liftBytes(`${hex} c3`);
    assert.equal(coverage.state, 'partial');
    assert.equal(run(ir).status, 'unknown');
  }
  // cmpxchg with a register destination
  assert.equal(run(liftBytes('0f b1 c8 c3').ir).status, 'unknown');
});
