import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../../src/core/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { recoverStack } from '../../../src/analysis/stack/index.js';
import { boundedUnknownClobbers } from '../../../src/lifters/arm64/semantics.js';
import { evaluate, fromWords, lift, registerBits } from './support.js';

// Compiler MOV vN.16b aliases expose opaque display operands in the pinned
// decoder. Canonical ORR fields, not those strings, specify the source registers.
test('canonical SIMD ORR and MOV aliases preserve bits and Q=0 clears the high half', () => {
  const left = 0x7ff0000000000123_8000000000000000n;
  const right = 0x0011223344556677_8899aabbccddeeffn;
  for (const [word, width, alias] of [
    [0x4ea11c20, 128, true],
    [0x0ea11c20, 64, true],
    [0x4ea21c20, 128, false],
    [0x0ea21c20, 64, false],
  ] as const) {
    const graph = fromWords([word, 0xd65f03c0]);
    assert.equal(graph.instructions[0]!.payload?.architecture, 'arm64');
    const payload = graph.instructions[0]!.payload!;
    if (payload.architecture !== 'arm64') assert.fail('Expected ARM64');
    assert.equal(payload.canonical_encoding, 'ORR_asimdsame_only');
    const lifted = lift(graph);
    assert.equal(lifted.coverage.state, 'complete');
    const inputs = new Map<string, bigint>();
    inputs.set('arm64:v0', (1n << 128n) - 1n);
    inputs.set('arm64:v1', left);
    if (!alias) inputs.set('arm64:v2', right);
    const observed = evaluate(lifted.ir, inputs);
    assert.equal(observed.status, 'returned');
    assert.equal(
      registerBits(observed, 'arm64:v0', 128),
      BigInt.asUintN(width, alias ? left : left | right),
    );
  }
});

test('INS from a general register replaces exactly one lane and keeps every other bit', () => {
  const vector = 0x0011223344556677_8899aabbccddeeffn,
    general = 0xfedcba9876543210n;
  // ins v0.<T>[index], <R>1: imm5 encodes the element size and lane index.
  for (const [imm5, lane, index] of [
    [0b11111, 8, 15],
    [0b01110, 16, 3],
    [0b01100, 32, 1],
    [0b11000, 64, 1],
    [0b00001, 8, 0],
  ] as const) {
    const graph = fromWords([0x4e001c20 | (imm5 << 16), 0xd65f03c0]);
    const payload = graph.instructions[0]!.payload!;
    if (payload.architecture !== 'arm64') assert.fail('Expected ARM64');
    assert.equal(payload.canonical_encoding, 'INS_asimdins_IR_r');
    const lifted = lift(graph);
    assert.equal(lifted.coverage.state, 'complete');
    const observed = evaluate(
      lifted.ir,
      new Map([
        ['arm64:v0', vector],
        ['arm64:x1', general],
      ]),
    );
    const mask = ((1n << BigInt(lane)) - 1n) << BigInt(index * lane);
    assert.equal(
      registerBits(observed, 'arm64:v0', 128),
      (vector & ~mask) | ((general << BigInt(index * lane)) & mask),
    );
  }
});

test('an unlifted SIMD&FP data-processing encoding keeps SP, x19-x28, FPCR and memory', () => {
  // movz x9, #42; stur x9, [sp, #-16]; fmadd d0, d1, d2, d3; ldur x0, [sp, #-16]; ret
  const graph = fromWords([0xd2800549, 0xf81f03e9, 0x1f420c20, 0xf85f03e0, 0xd65f03c0]);
  const lifted = lift(graph);
  assert.equal(lifted.coverage.state, 'partial');
  const effects = lifted.ir.blocks.flatMap((block) =>
    block.instructions.filter((node) => node.kind === 'unknown_effect'),
  );
  assert.equal(effects.length, 1);
  const effect = effects[0]!;
  if (effect.kind !== 'unknown_effect') assert.fail('Expected an unknown effect');
  // The diagnostic reason is unchanged.
  assert.equal(effect.reason, 'Unsupported ARM64 encoding FMADD_D_floatdp3');
  assert.equal(effect.clobbers.memory, 'none');
  const roots = new Set(effect.clobbers.registers.map((register) => register.root));
  assert.deepEqual([...roots].sort(), Array.from({ length: 32 }, (_, n) => `arm64:v${n}`).sort());
  for (const kept of [
    'arm64:sp',
    'arm64:fpcr',
    ...Array.from({ length: 10 }, (_, n) => `arm64:x${19 + n}`),
  ])
    assert.ok(!roots.has(kept), kept);
  assert.deepEqual(
    effect.clobbers.flags.map((flag) => flag.root),
    ['arm64:nzcv', 'arm64:fpsr'],
  );
  // The frame address survives the effect and the reload sees the stored byte
  // pattern: neither SP nor memory is clobbered.
  const ssa = constructSSA(lifted.ir);
  if (ssa.value.form !== 'ssa') assert.fail('Expected SSA');
  const stack = recoverStack(ssa.value, new DarwinArm64Abi(), createOperationContext());
  const reads = stack.accesses.filter((access) => access.kind === 'read');
  assert.equal(reads.length, 1);
  assert.equal(reads[0]!.offset, -16n);
  assert.deepEqual(reads[0]!.value.value, { kind: 'constant', bits: 42n });
  assert.equal(reads[0]!.value.initialization, 'initialized');
});

test('only the to-general forms add their general destination; GP-reading forms stay unbounded', () => {
  const bound = (word: number) => {
    const payload = fromWords([word, 0xd65f03c0]).instructions[0]!.payload!;
    if (payload.architecture !== 'arm64') assert.fail('Expected ARM64');
    return boundedUnknownClobbers(payload);
  };
  const general = (word: number) =>
    bound(word)
      ?.registers.filter((register) => register.bank === 'integer')
      .map((register) => register.root);
  assert.deepEqual(general(0x0e0c3c20), ['arm64:x0']); // umov w0, v1.s[1]
  assert.deepEqual(general(0x4e012c20), ['arm64:x0']); // smov x0, v1.b[0]
  assert.deepEqual(general(0x1e58c020), ['arm64:x0']); // fcvtzs w0, d1, #16
  assert.deepEqual(general(0x4e083c3f), []); // umov xzr, v1.d[0]: register 31 is ZR
  assert.deepEqual(general(0x6ee24420), []); // ushl v0.2d, v1.2d, v2.2d
  assert.deepEqual(general(0x1e610400), []); // fccmp d0, d1, #0, eq
  for (const word of [
    0x9e620020, // scvtf d0, x1 (float2int from general)
    0x1e420020, // scvtf d0, w1, #64 (float2fix from general)
    0x9eaf0020, // fmov v0.d[1], x1
    0x4e0c1c20, // ins v0.s[1], w1
    0x4e080c20, // dup v0.2d, x1
    0x0d9f9000, // st1 {v0.s}[1], [x0], #4: a SIMD store
    0xd503201f, // nop: not SIMD&FP data processing
  ])
    assert.equal(bound(word), undefined, word.toString(16));
});

test('an instruction the decoder marks undefined keeps the unbounded effect', () => {
  // aese v0.16b, v1.16b without FEAT_AES
  const lifted = lift(fromWords([0x4e284820, 0xd65f03c0]));
  const effect = lifted.ir.blocks
    .flatMap((block) => block.instructions)
    .find((node) => node.kind === 'unknown_effect');
  assert.ok(effect?.kind === 'unknown_effect');
  assert.equal(effect.clobbers.memory, 'unknown_read_write');
  assert.ok(effect.clobbers.registers.some((register) => register.root === 'arm64:sp'));
});
