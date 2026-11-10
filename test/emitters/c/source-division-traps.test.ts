import assert from 'node:assert/strict';
import test from 'node:test';
import { WindowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { recoverTypes } from '../../../src/analysis/types/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { simplifySSA } from '../../../src/analysis/values/index.js';
import { createOperationContext } from '../../../src/core/index.js';
import type { SSAForm } from '../../../src/ir/index.js';
import { liftBytes } from '../../lifters/x86_64/helpers.js';
import { emit, execute } from './support.js';

/** Win64 machine code bytes (rcx = dividend, r8 = divisor, r9 = result
 * pointer), assembled offline with GNU as (Intel syntax). */
const abi = new WindowsX64Abi();

function emitted(hex: string, language: 'c-like' | 'python-like') {
  const { graph, ir: lifted } = liftBytes(hex);
  const ir = simplifySSA(constructSSA(lifted).value as SSAForm).value;
  const types = recoverTypes(ir, abi, createOperationContext(), {
    image_id: graph.function.entry.image_id,
    slice_id: `slice_${'0'.repeat(64)}`,
    revision: 0,
  });
  const output = emit(ir, { types, source: { abi, callees: [], addresses: [] } }, language);
  assert.ok(output.emission, JSON.stringify(output.diagnostics));
  return { ir, emission: output.emission };
}

/** Runs the emitted text on (rcx, r8, r9 = 0x2000) and returns the trap or the
 * stored bytes [0x2000, 0x2018) as little-endian words of `width` bits. */
function run(
  ir: SSAForm,
  emission: Parameters<typeof execute>[0],
  a: bigint,
  b: bigint,
): { trap: boolean; memory: Map<bigint, number> } {
  const roots = new Map<string, bigint>([
    ['x86_64:rcx', BigInt.asUintN(64, a)],
    ['x86_64:r8', BigInt.asUintN(64, b)],
    ['x86_64:r9', 0x2000n],
    ['x86_64:rdx', 0x55n],
    ['x86_64:rsp', 0x9000n],
  ]);
  const entry = ir.blocks.find((block) => block.id === ir.entry)!;
  const bindings = ir.register_states.find((state) => state.block === ir.entry)!.entry;
  const inputs = new Map(entry.parameters.map((value) => [value.id, 0n]));
  for (const binding of bindings)
    inputs.set(
      binding.value.id,
      BigInt.asUintN(
        binding.register.width_bits,
        (roots.get(binding.register.root) ?? 0n) >> BigInt(binding.register.offset_bits),
      ),
    );
  const memory = new Map<bigint, number>();
  for (let i = 0n; i < 24n; i++) memory.set(0x2000n + i, 0xee);
  for (let i = -16n; i < 16n; i++) memory.set(0x9000n + i, 0);
  const observation = execute(
    emission,
    inputs,
    memory,
    0n,
    new Map([...roots].map(([root, bits]) => [root, { bits, known: (1n << 64n) - 1n }])),
  );
  assert.ok(['trap_exit', 'machine_return'].includes(observation.exit), observation.exit);
  return { trap: observation.exit === 'trap_exit', memory: new Map(observation.memory) };
}

const word = (memory: ReadonlyMap<bigint, number>, address: bigint, bytes: number): bigint => {
  let value = 0n;
  for (let i = 0; i < bytes; i++)
    value |= BigInt(memory.get(address + BigInt(i)) ?? 0) << BigInt(8 * i);
  return value;
};

interface Case {
  readonly name: string;
  readonly hex: string;
  readonly bits: number;
  readonly signed: boolean;
  /** Stored words: quotient at 0x2000, remainder at 0x2000 + bits/8 (when stored). */
  readonly stores: readonly ('quotient' | 'remainder')[];
  /** Whether the source view omits the guards (C-like). */
  readonly omitted: boolean;
}

// mov rax, rcx; cqo; idiv r8; mov [r9], rax; mov [r9+8], rdx; ret
const cases: readonly Case[] = [
  {
    name: 'signed 64-bit quotient and remainder',
    hex: '4889c8489949f7f849890149895108c3',
    bits: 64,
    signed: true,
    stores: ['quotient', 'remainder'],
    omitted: true,
  },
  {
    // mov eax, ecx; cdq; idiv r8d; mov [r9], eax; mov [r9+4], edx; ret
    name: 'signed 32-bit quotient and remainder',
    hex: '89c89941f7f841890141895104c3',
    bits: 32,
    signed: true,
    stores: ['quotient', 'remainder'],
    omitted: true,
  },
  {
    // mov rax, rcx; xor edx, edx; div r8; mov [r9], rax; mov [r9+8], rdx; ret
    name: 'unsigned 64-bit quotient and remainder',
    hex: '4889c831d249f7f049890149895108c3',
    bits: 64,
    signed: false,
    stores: ['quotient', 'remainder'],
    omitted: true,
  },
  {
    // mov eax, ecx; xor edx, edx; div r8d; mov [r9+4], edx; ret
    name: 'unsigned 32-bit remainder only',
    hex: '89c831d241f7f041895104c3',
    bits: 32,
    signed: false,
    stores: ['remainder'],
    omitted: true,
  },
  {
    // push rbx; mov rbx, r9; mov edx, r8d; movzx eax, cl; div dl; mov [rbx], ax; pop rbx; ret
    name: 'unsigned 8-bit quotient and remainder',
    hex: '534c89cb4489c20fb6c1f6f26689035bc3',
    bits: 8,
    signed: false,
    stores: ['quotient', 'remainder'],
    omitted: true,
  },
  {
    // mov ax, cx; cwd; idiv r8w; mov [r9], ax; mov [r9+2], dx; ret
    name: 'signed 16-bit division keeps its guards (int promotion does not overflow)',
    hex: '6689c866996641f7f8664189016641895102c3',
    bits: 16,
    signed: true,
    stores: ['quotient', 'remainder'],
    omitted: false,
  },
];

const edges = (bits: number): bigint[] => {
  const half = 1n << BigInt(bits - 1);
  return [0n, 1n, -1n, 2n, -3n, 7n, -7n, half - 1n, -half, -half + 1n];
};

for (const item of cases)
  test(`division trap guards: ${item.name} matches the machine on edge inputs`, () => {
    for (const language of ['c-like', 'python-like'] as const) {
      const { ir, emission } = emitted(item.hex, language);
      const omitted = item.omitted && (language === 'c-like' || !item.signed);
      assert.equal(emission.text.includes('trap_exit'), !omitted, emission.text);
      assert.equal(
        emission.local_validation?.some(
          (record) => record.kind === 'presentation' && record.rule === 'division_trap',
        ),
        omitted,
      );
      if (omitted) assert.ok(!/bv_[su](div|rem)/.test(emission.text), emission.text);
      const bytes = item.bits / 8,
        mask = (1n << BigInt(item.bits)) - 1n,
        minimum = -(1n << BigInt(item.bits - 1));
      for (const a of edges(item.bits))
        for (const b of edges(item.bits)) {
          const x = item.signed ? BigInt.asIntN(item.bits, a) : BigInt.asUintN(item.bits, a),
            y = item.signed ? BigInt.asIntN(item.bits, b) : BigInt.asUintN(item.bits, b);
          // The machine: #DE on a zero divisor or a quotient the destination cannot hold.
          const trap = y === 0n || (item.signed && x === minimum && y === -1n);
          const observed = run(ir, emission, a, b);
          assert.equal(observed.trap, trap, `${language} ${x} / ${y}\n${emission.text}`);
          if (trap) continue;
          const expected = { quotient: (x / y) & mask, remainder: (x % y) & mask };
          item.stores.forEach((kind, index) => {
            const address = 0x2000n + BigInt(item.stores.length === 1 ? bytes : index * bytes);
            assert.equal(
              word(observed.memory, address, bytes),
              expected[kind],
              `${language} ${kind} of ${x} / ${y}\n${emission.text}`,
            );
          });
        }
    }
  });

test('division trap: an earlier store happens before the trap, a later one never', () => {
  // mov qword ptr [r9+16], 7; mov rax, rcx; cqo; idiv r8; mov qword ptr [r9], 1; ret
  const hex = '49c74110070000004889c8489949f7f849c70101000000c3';
  const { ir, emission } = emitted(hex, 'c-like');
  assert.ok(!emission.text.includes('trap_exit'), emission.text);
  // Both results are dead: the division still prints, so it still traps.
  assert.match(emission.text, /\(int64_t\)\w+ \/ \(int64_t\)\w+;/);
  const trapped = run(ir, emission, 5n, 0n);
  assert.ok(trapped.trap);
  assert.equal(word(trapped.memory, 0x2010n, 8), 7n);
  assert.equal(word(trapped.memory, 0x2000n, 8), 0xeeeeeeeeeeeeeeeen);
  const overflow = run(ir, emission, -(1n << 63n), -1n);
  assert.ok(overflow.trap);
  const normal = run(ir, emission, 5n, 2n);
  assert.ok(!normal.trap);
  assert.equal(word(normal.memory, 0x2000n, 8), 1n);
});

test('division trap: a dividend whose high half is not its extension keeps the guards', () => {
  // mov rax, rcx; mov rdx, r9; div r8; mov [r9], rax; ret
  const hex = '4889c84c89ca49f7f0498901c3';
  const { emission } = emitted(hex, 'c-like');
  assert.ok(emission.text.includes('trap_exit'), emission.text);
  assert.ok(emission.text.includes('quotient overflow'), emission.text);
});

test('division trap: bytes of the test sequences decode as documented', () => {
  // Guard against a typo in the hand-assembled hex: the first case must lift a
  // signed 128/64 division.
  const { ir } = emitted(cases[0]!.hex, 'c-like');
  const ops = ir.blocks.flatMap((block) =>
    block.instructions.flatMap((node) =>
      node.kind === 'assign' && node.expression.kind === 'integer' ? [node.expression.op] : [],
    ),
  );
  assert.ok(ops.includes('sdiv') && ops.includes('srem'));
});

test('division trap: a constant divisor (folded extension) narrows to the constant', () => {
  // mov eax, ecx; mov r8d, 12; cdq; idiv r8d; mov [r9], eax; mov [r9+4], edx; ret
  // mov rax, rcx; mov r8, -1; cqo; idiv r8; mov [r9], rax; mov [r9+8], rdx; ret
  for (const [hex, bits, divisor] of [
    ['89c841b80c0000009941f7f841890141895104c3', 32, 12n],
    ['4889c849c7c0ffffffff489949f7f849890149895108c3', 64, -1n],
  ] as const) {
    const { ir, emission } = emitted(hex, 'c-like');
    assert.ok(!emission.text.includes('trap_exit'), emission.text);
    const bytes = bits / 8,
      mask = (1n << BigInt(bits)) - 1n,
      minimum = -(1n << BigInt(bits - 1));
    for (const a of edges(bits)) {
      const x = BigInt.asIntN(bits, a);
      const observed = run(ir, emission, a, 0n);
      const trap = x === minimum && divisor === -1n;
      assert.equal(observed.trap, trap, `${x} / ${divisor}\n${emission.text}`);
      if (trap) continue;
      assert.equal(word(observed.memory, 0x2000n, bytes), (x / divisor) & mask);
      assert.equal(word(observed.memory, 0x2000n + BigInt(bytes), bytes), (x % divisor) & mask);
    }
  }
});
