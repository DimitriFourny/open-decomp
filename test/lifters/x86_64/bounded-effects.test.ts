import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyIR } from '../../../src/ir/index.js';
import type { Instruction } from '../../../src/ir/index.js';
import { unknownClobbers } from '../../../src/lifters/x86_64/semantics.js';
import { liftBytes } from './helpers.js';

type Effect = Extract<Instruction, { kind: 'unknown_effect' }>;
function effects(hex: string): Effect[] {
  const { ir } = liftBytes(`${hex} c3`);
  assert.deepEqual(verifyIR(ir), []);
  return ir.blocks.flatMap((block) =>
    block.instructions.filter((node): node is Effect => node.kind === 'unknown_effect'),
  );
}
function only(hex: string): Effect {
  const found = effects(hex);
  assert.equal(found.length, 1, hex);
  return found[0]!;
}
const slices = (effect: Effect): string[] =>
  effect.clobbers.registers
    .map(
      (register) =>
        `${register.root.slice(7)}[${register.offset_bits}:${register.offset_bits + register.width_bits}]`,
    )
    .sort();
const flags = (effect: Effect): string[] =>
  effect.clobbers.flags.map((register) => register.id.slice(7)).sort();

test('an unlifted instruction clobbers only the state its decoded access sets may write', () => {
  const cases: readonly (readonly [string, string, string[], string[], string])[] = [
    // pmaddwd xmm0, xmm1: legacy SSE preserves bits above 127.
    ['66 0f f5 c1', 'pmaddwd', ['zmm0[0:128]'], ['mxcsr[0:6]'], 'none'],
    // rep stosq: RCX and RDI change, memory is written; RAX, RSP and flags survive.
    ['f3 48 ab', 'rep stosq', ['rcx[0:64]', 'rdi[0:64]'], [], 'unknown_read_write'],
    // rep movsb also advances RSI.
    ['f3 a4', 'rep movsb', ['rcx[0:64]', 'rdi[0:64]', 'rsi[0:64]'], [], 'unknown_read_write'],
    // cvtsd2si rax, xmm0: a GPR result from a vector input touches no memory.
    ['f2 48 0f 2d c0', 'cvtsd2si', ['rax[0:64]'], ['mxcsr[0:6]'], 'none'],
    // cvtsd2si eax, xmm0: a 32-bit write zero-extends, so the whole RAX root is an output.
    ['f2 0f 2d c0', 'cvtsd2si', ['rax[0:64]'], ['mxcsr[0:6]'], 'none'],
    // crc32 eax, ecx reads a GPR: memory stays conservatively readable (frame escape).
    ['f2 0f 38 f1 c1', 'crc32', ['rax[0:64]'], [], 'read_only'],
    // fnstsw ax: a 16-bit write preserves the rest of RAX; x87 state is not modeled.
    ['df e0', 'fnstsw', ['rax[0:16]'], [], 'none'],
    // fld qword [rsp]: reads memory, writes only unmodeled x87 state.
    ['dd 04 24', 'fld', [], [], 'read_only'],
    // fstp qword [rsp+8] writes memory.
    ['dd 5c 24 08', 'fstp', [], [], 'unknown_read_write'],
    // fld1 has no modeled output at all; the ordered effect remains.
    ['d9 e8', 'fld1', [], [], 'none'],
    // cpuid writes four GPRs; it reads EAX/ECX, so memory stays conservatively readable.
    ['0f a2', 'cpuid', ['rax[0:64]', 'rbx[0:64]', 'rcx[0:64]', 'rdx[0:64]'], [], 'read_only'],
    // pushfq writes RSP itself, and memory.
    ['9c', 'pushfq', ['rsp[0:64]'], [], 'unknown_read_write'],
    // vzeroupper zeroes the upper bits of ZMM0-15 only.
    [
      'c5 f8 77',
      'vzeroupper',
      Array.from({ length: 16 }, (_, i) => `zmm${i}[0:512]`).sort(),
      ['mxcsr[0:6]'],
      'none',
    ],
  ];
  for (const [hex, name, registers, flagNames, memory] of cases) {
    const effect = only(hex);
    assert.deepEqual(slices(effect), registers, name);
    assert.deepEqual(flags(effect), flagNames.sort(), name);
    assert.equal(effect.clobbers.memory, memory, name);
  }
});

test('modified flags come from the decoded flag sets, never more', () => {
  // rdrand rax writes CF and clears OF/SF/ZF/AF/PF.
  let effect = only('48 0f c7 f0');
  assert.deepEqual(slices(effect), ['rax[0:64]']);
  assert.deepEqual(flags(effect), ['af', 'cf', 'of', 'pf', 'sf', 'zf']);
  assert.equal(effect.clobbers.memory, 'none');
  // rcl eax, 1 changes only CF and OF.
  effect = only('d1 d0');
  assert.deepEqual(slices(effect), ['rax[0:64]']);
  assert.deepEqual(flags(effect), ['cf', 'of']);
});

test('the whole modeled state stays clobbered where access sets do not bound the effect', () => {
  for (const [hex, name] of [
    ['0f ae 14 24', 'ldmxcsr writes MXCSR control bits'],
    ['f3 48 0f ae d0', 'wrfsbase writes the FS base'],
    ['8e e0', 'mov fs, ax reloads the FS base'],
    ['fa', 'cli is privileged'],
  ] as const) {
    const effect = only(hex);
    assert.equal(effect.clobbers, unknownClobbers, name);
  }
});

test('stack pointer and callee-saved registers survive a bounded effect', () => {
  // push rbx; pmaddwd xmm0, xmm1; pop rbx; ret
  const { ir } = liftBytes('53 66 0f f5 c1 5b c3');
  assert.deepEqual(verifyIR(ir), []);
  const effect = ir.blocks
    .flatMap((block) => block.instructions)
    .find((node): node is Effect => node.kind === 'unknown_effect')!;
  const roots = new Set(effect.clobbers.registers.map((register) => register.root));
  for (const root of ['rsp', 'rbx', 'rbp', 'r12'])
    assert.ok(!roots.has(`x86_64:${root}`), `${root} is not clobbered`);
  assert.equal(effect.clobbers.memory, 'none');
});
