import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';
import {
  AddressMap, ImmutableBytes, OperationError, contentHash, createOperationContext, imageIdentity, sliceIdentity,
  type AddressRange, type Arm64Payload, type DecodedInstruction, type LoadedImage, type LoaderHint,
} from '../../../src/core/index.js';
import { Arm64Decoder } from '../../../src/decoders/arm64/index.js';

const manifest = z.object({ codeRanges: z.array(z.object({ architecture: z.string(), symbol: z.string(), address: z.string(), path: z.string(), size: z.number() })) }).parse(JSON.parse(readFileSync('fixtures/manifest.json', 'utf8')) as unknown);
function image(bytes: Uint8Array, base = 0x1000n, fileOffset = 0n, memorySize = BigInt(bytes.length), hints: readonly LoaderHint[] = []): LoadedImage {
  const container = new Uint8Array(Number(fileOffset) + bytes.length);
  container.set(bytes, Number(fileOffset));
  const sha256 = contentHash(container);
  const id = imageIdentity(sha256);
  const selected_slice_id = sliceIdentity(id, fileOffset, BigInt(bytes.length), 'arm64');
  const mappings = [{ id: 'code', va: base, memory_size: memorySize, file_offset: fileOffset, file_size: BigInt(bytes.length), permissions: ['read', 'execute'] as const }];
  return {
    id, sha256, bytes: new ImmutableBytes(container), selected_slice_id,
    slices: [{ id: selected_slice_id, image_id: id, offset: fileOffset, size: BigInt(bytes.length), architecture: 'arm64', subtype: 'all', supported: true }],
    target: { format: 'macho', architecture: 'arm64', abi: 'darwin-arm64', endian: 'little', address_bits: 64, features: [] }, image_base: base,
    address_map: new AddressMap({ image_id: id, image_base: base, byte_length: BigInt(container.length), slice_offset: fileOffset, slice_size: BigInt(bytes.length), mappings }),
    mappings, hints, headers: [], sections: [], entry_points: [], symbols: [], imports: [], exports: [], relocations: [], evidence: [], diagnostics: [], capabilities: [],
  };
}
function words(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value, true));
  return bytes;
}
function decode(input: LoadedImage, features: readonly string[] = ['FEAT_FP', 'FEAT_AdvSIMD'], regions?: readonly AddressRange[]) {
  const decoder = new Arm64Decoder();
  try {
    return decoder.decode({ image: input, mode: 'a64', features, regions: regions ?? [{ start: { image_id: input.id, space: 'va', value: input.image_base }, size: input.mappings[0]!.memory_size }] }, createOperationContext());
  } finally { decoder.dispose(); }
}
function fixture(symbol: string): LoadedImage {
  const record = manifest.codeRanges.find(range => range.architecture === 'arm64' && range.symbol === symbol);
  assert.ok(record, symbol);
  return image(readFileSync(record.path), BigInt(record.address));
}
function arm(instruction: DecodedInstruction | undefined): Arm64Payload {
  assert.ok(instruction);
  assert.equal(instruction.payload?.architecture, 'arm64');
  assert.ok(instruction.payload?.architecture === 'arm64');
  return instruction.payload;
}

test('actual extracted compiler ranges decode with immutable byte references, not assembly input', () => {
  for (const record of manifest.codeRanges.filter(range => range.architecture === 'arm64')) {
    const input = image(readFileSync(record.path), BigInt(record.address), 16n);
    const result = decode(input);
    assert.deepEqual(result.gaps, [], record.symbol);
    assert.equal(result.instructions.length, record.size / 4, record.symbol);
    for (const instruction of result.instructions) {
      assert.equal(instruction.validity, 'valid', `${record.symbol}: ${instruction.address.value.toString(16)}`);
      assert.equal(instruction.bytes.start.space, 'file');
      assert.equal(instruction.bytes.start.value, 16n + instruction.address.value - input.image_base);
      assert.equal(instruction.bytes.size, 4n);
      assert.equal(arm(instruction).word, BigInt(input.bytes.u32(instruction.bytes.start.value)));
    }
  }
});

test('LLVM-adjudicated arithmetic fields, widths and missing logical shifted decoding are retained', () => {
  // fixtures/metadata/macho-arm64-symbols.disassembly.txt: 0x100000574..0x100000588.
  const result = decode(fixture('_fixture_arithmetic'));
  assert.equal(arm(result.instructions[0]).canonical_encoding, 'ADD_32_addsub_shift');
  assert.deepEqual(arm(result.instructions[0]).operands.at(-1), { kind: 'modifier', operation: 'lsl', amount: 1 });
  const eor = arm(result.instructions[3]);
  assert.equal(eor.canonical_encoding, 'EOR_32_log_shift');
  assert.equal(eor.fields.Rd, 0n); assert.equal(eor.fields.Rn, 8n); assert.equal(eor.fields.Rm, 9n);
  const destination = eor.operands[0]; assert.equal(destination?.kind, 'register');
  if (destination?.kind === 'register') {
    assert.equal(destination.register.width_bits, 32);
    assert.equal(destination.register.root, 'arm64:x0');
    assert.equal(destination.register.write_rule, 'zero_extend_root');
    assert.equal(destination.access, 'unknown');
  }
  assert.deepEqual(result.instructions.at(-1)?.flow, { kind: 'return' });
});

test('compiler loops/calls expose exact targets, post-index and unresolved indirect calls', () => {
  const loop = decode(fixture('_fixture_loop'));
  assert.deepEqual(loop.instructions[0]?.flow, { kind: 'branch', target: { ...loop.instructions[0]!.address, value: 0x1000005b8n }, conditional: true, fallthrough: { ...loop.instructions[0]!.address, value: 0x100000598n } });
  const memory = arm(loop.instructions[4]).operands.find(operand => operand.kind === 'memory');
  assert.ok(memory?.kind === 'memory');
  assert.equal(memory.displacement, 4n); assert.equal(memory.writeback, 'post'); assert.equal(memory.access_bits, 32);
  assert.equal(loop.instructions[7]?.flow.kind, 'branch');
  const direct = decode(fixture('_fixture_direct'));
  const call = direct.instructions.find(instruction => instruction.address.value === 0x1000005e4n);
  assert.ok(call?.flow.kind === 'call');
  assert.equal(call.flow.target?.value, 0x100000548n); assert.equal(call.flow.indirect, false);
  const frame = arm(direct.instructions[0]).operands.find(operand => operand.kind === 'memory');
  assert.ok(frame?.kind === 'memory'); assert.equal(frame.displacement, -32n); assert.equal(frame.writeback, 'pre'); assert.equal(frame.base.role, 'stack_pointer');
  const indirect = decode(fixture('_fixture_indirect')).instructions.find(instruction => instruction.flow.kind === 'call');
  assert.ok(indirect?.flow.kind === 'call'); assert.equal(indirect.flow.target, null); assert.equal(indirect.flow.indirect, true);
});

test('real scalar floating and common vector operands are field-derived and structured', () => {
  for (const symbol of ['_fixture_float', '_fixture_vector', '_fixture_vector_integer', '_fixture_variadic']) {
    const result = decode(fixture(symbol));
    assert.equal(result.coverage.state, 'complete', symbol);
    for (const instruction of result.instructions) assert.ok(!arm(instruction).operands.some(operand => operand.kind === 'opaque'), symbol);
  }
  const float = decode(fixture('_fixture_float'));
  assert.deepEqual(arm(float.instructions[0]).operands[1], { kind: 'floating_immediate', value: 1.5 });
  const destination = arm(float.instructions[1]).operands[0];
  assert.ok(destination?.kind === 'register'); assert.equal(destination.register.width_bits, 64); assert.equal(destination.register.root, 'arm64:v0');
  const vector = decode(fixture('_fixture_vector'));
  const vectorAdd = arm(vector.instructions[2]).operands[0];
  assert.ok(vectorAdd?.kind === 'register'); assert.equal(vectorAdd.arrangement, '4s'); assert.equal(vectorAdd.register.width_bits, 128);
  const load = arm(vector.instructions[0]).operands.find(operand => operand.kind === 'memory');
  assert.ok(load?.kind === 'memory'); assert.equal(load.access_bits, 128);
  const immediate = arm(decode(fixture('_fixture_vector_integer')).instructions[3]).operands[1];
  assert.deepEqual(immediate, { kind: 'immediate', value: 85n, width_bits: 32 });
});

test('SP/WSP and ZR/WZR preserve distinct identities and writes', () => {
  const result = decode(image(words([0x910003fd, 0x2a1f03e0, 0x6b01001f, 0x110003ff])));
  const moveSP = arm(result.instructions[0]);
  assert.equal(moveSP.canonical_encoding, 'ADD_64_addsub_imm');
  const sourceSP = moveSP.operands.find(operand => operand.kind === 'register' && operand.register.role === 'stack_pointer');
  assert.ok(sourceSP?.kind === 'register'); assert.equal(sourceSP.register.id, 'arm64:sp');
  const zero = arm(result.instructions[1]).operands.find(operand => operand.kind === 'register' && operand.register.role === 'zero');
  assert.ok(zero?.kind === 'register'); assert.equal(zero.register.id, 'arm64:wzr'); assert.equal(zero.register.write_rule, 'discard');
  const compare = arm(result.instructions[2]); assert.equal(compare.fields.Rd, 31n);
  const wsp = arm(result.instructions[3]).operands[0]; assert.ok(wsp?.kind === 'register'); assert.equal(wsp.register.id, 'arm64:wsp'); assert.equal(wsp.register.role, 'stack_pointer');
});

test('feature-disabled hints keep NOP behavior, authentication gates and return/call flow', () => {
  const input = image(words([0xd503245f, 0xd503233f, 0xdac10020, 0xd65f0bff, 0xd73f0900]));
  const disabled = decode(input);
  assert.equal(disabled.instructions[0]?.validity, 'feature_disabled');
  assert.equal(arm(disabled.instructions[0]).behavior, 'nop'); assert.equal(disabled.instructions[0]?.flow.kind, 'fallthrough');
  assert.equal(arm(disabled.instructions[1]).behavior, 'nop');
  assert.equal(disabled.instructions[2]?.validity, 'feature_disabled'); assert.equal(disabled.instructions[2]?.flow.kind, 'unknown');
  const authOperand = arm(disabled.instructions[2]).operands[0]; assert.ok(authOperand?.kind === 'register'); assert.equal(authOperand.register.id, 'arm64:x0');
  const enabled = decode(input, ['FEAT_BTI', 'FEAT_PAuth', 'FEAT_PAuth_LR']);
  assert.ok(enabled.instructions.every(instruction => instruction.validity === 'valid'));
  assert.equal(arm(enabled.instructions[1]).behavior, 'instruction'); assert.equal(enabled.instructions[3]?.flow.kind, 'return');
  assert.ok(enabled.instructions[4]?.flow.kind === 'call'); assert.equal(enabled.instructions[4].flow.indirect, true);
  const decoder = new Arm64Decoder();
  assert.deepEqual(decoder.format(disabled.instructions[0]!), { mnemonic: 'nop', operands: '' });
  decoder.dispose();
});

test('PAuth_LR baseline words retain availability and authentication modifiers never become CFG edges', () => {
  const features = ['FEAT_PAuth', 'FEAT_PAuth_LR'];
  const baseline = [0xdac1a7fe, 0xd503233f, 0xdac1bbfe, 0xf3a0001f, 0xd65f0fff];
  const high = image(words(baseline), 0xffffffffff001000n);
  const result = decode(high, features);
  assert.ok(result.instructions.every(instruction => instruction.validity === 'valid'));
  assert.ok(result.instructions.every(instruction => arm(instruction).behavior === 'instruction'));
  assert.equal(result.instructions.at(-1)?.flow.kind, 'return');
  for (const word of [0xd65f0bff, 0xd65f0fff, 0x5500001f, 0x5520001f, 0xd65f0be0, 0xd65f0fe0]) {
    const instruction = decode(image(words([word])), features).instructions[0]!;
    assert.equal(instruction.validity, 'valid', word.toString(16));
    assert.equal(instruction.flow.kind, 'return', word.toString(16));
  }
  for (const word of [0xd71f0900, 0xd71f0d00, 0xd61f091f, 0xd61f0d1f]) {
    const instruction = decode(image(words([word])), features).instructions[0]!;
    assert.deepEqual(instruction.flow, { kind: 'indirect_branch', conditional: false, fallthrough: null });
  }
  const load = decode(image(words([0xf8200400])), features).instructions[0]!;
  const memory = arm(load).operands.find(operand => operand.kind === 'memory');
  assert.ok(memory?.kind === 'memory'); assert.equal(memory.access_bits, 64); assert.equal(memory.access, 'read');
});

test('one word can cross adjacent mappings without inventing contiguous file bytes', () => {
  const bytes = new Uint8Array(12);
  bytes.set([0xc0, 0x03], 0); bytes.set([0x5f, 0xd6], 8);
  const original = image(bytes);
  const mappings = [
    { id: 'first', va: 0x1000n, memory_size: 2n, file_offset: 0n, file_size: 2n, permissions: ['read', 'execute'] as const },
    { id: 'second', va: 0x1002n, memory_size: 2n, file_offset: 8n, file_size: 2n, permissions: ['read', 'execute'] as const },
  ];
  const input = { ...original, mappings, address_map: new AddressMap({ image_id: original.id, image_base: 0x1000n, byte_length: 12n, slice_offset: 0n, slice_size: 12n, mappings }) };
  const result = decode(input, [], [{ start: { image_id: input.id, space: 'va', value: 0x1000n }, size: 4n }]);
  assert.deepEqual(result.gaps, []); assert.equal(result.instructions.length, 1);
  assert.equal(arm(result.instructions[0]).word, 0xd65f03c0n);
  assert.equal(result.instructions[0]?.bytes.start.space, 'va');
  assert.equal(result.instructions[0]?.flow.kind, 'return');
});

test('invalid words, reserved bit patterns and permanent UDF do not collapse to invented traps', () => {
  const result = decode(image(words([0xffffffff, 0x53200020, 0x00000201])));
  assert.equal(result.instructions[0]?.validity, 'invalid'); assert.equal(result.instructions[0]?.payload, null);
  assert.equal(result.instructions[1]?.validity, 'undefined'); assert.equal(result.instructions[1]?.flow.kind, 'unknown');
  assert.equal(arm(result.instructions[2]).behavior, 'undefined'); assert.equal(result.instructions[2]?.validity, 'valid'); assert.equal(result.instructions[2]?.flow.kind, 'trap');
});

test('logical completion retains all opcode/shift choices and rejects W shifts beyond 31', () => {
  for (const sf of [0, 1]) for (const opc of [0, 1, 2, 3]) for (const n of [0, 1]) for (const shift of [0, 1, 2, 3]) {
    // EOR/EON are absent from the pinned upstream's logical register family; other cases ensure completion does not override recognized encodings.
    const value = (0x0a000000 | (sf << 31) | (opc << 29) | (shift << 22) | (n << 21) | (2 << 16) | (31 << 10) | (1 << 5)) >>> 0;
    const instruction = decode(image(words([value]))).instructions[0]!;
    assert.equal(instruction.validity, 'valid', value.toString(16));
    const payload = arm(instruction);
    assert.equal(payload.fields.shift, BigInt(shift)); assert.equal(payload.fields.imm6, 31n);
    assert.deepEqual(payload.operands.at(-1), { kind: 'modifier', operation: ['lsl', 'lsr', 'asr', 'ror'][shift], amount: 31 });
  }
  for (const amount of [32, 63]) {
    const instruction = decode(image(words([(0x4a020020 | (amount << 10)) >>> 0]))).instructions[0]!;
    assert.equal(instruction.validity, 'undefined'); assert.equal(instruction.flow.kind, 'unknown');
  }
});

test('relative operands keep full-width PCs, page alignment and wrapped signed targets', () => {
  const base = 0x20000000001004n;
  const result = decode(image(words([0x90000000, 0x17ffffff, 0x10000020]), base));
  const page = arm(result.instructions[0]).operands.find(operand => operand.kind === 'relative');
  assert.ok(page?.kind === 'relative'); assert.equal(page.target.value, base & ~0xfffn);
  const branch = result.instructions[1]!.flow; assert.ok(branch.kind === 'branch'); assert.equal(branch.target.value, base);
  const adr = arm(result.instructions[2]).operands.find(operand => operand.kind === 'relative');
  assert.ok(adr?.kind === 'relative'); assert.equal(adr.target.value, base + 12n);
  const decoder = new Arm64Decoder();
  assert.equal(decoder.format(result.instructions[0]!).operands, `x0, 0x${(base & ~0xfffn).toString(16)}`);
  decoder.dispose();
});

test('trailing bytes, disconnected regions, zero-fill, known data and instruction budgets stay explicit', () => {
  const trailing = image(readFileSync('fixtures/malformed/arm64-trailing-byte.bin'));
  const result = decode(trailing);
  assert.equal(result.gaps.at(-1)?.reason, 'truncated'); assert.equal(result.gaps.at(-1)?.range.size, 3n);
  const input = image(words([0xd65f03c0, 0xd503201f, 0xd65f03c0]), 0x1000n, 8n, 20n);
  const ranges = [
    { start: { image_id: input.id, space: 'va' as const, value: 0x1000n }, size: 4n },
    { start: { image_id: input.id, space: 'va' as const, value: 0x1008n }, size: 16n },
  ];
  const noncontiguous = decode(input, [], ranges);
  assert.deepEqual(noncontiguous.instructions.map(instruction => instruction.address.value), [0x1000n, 0x1008n]);
  assert.deepEqual(noncontiguous.gaps.map(gap => [gap.reason, gap.range.start.value, gap.range.size]), [['unmapped', 0x100cn, 12n]]);
  const dataHint: LoaderHint = { kind: 'data', range: { start: { image_id: input.id, space: 'va', value: 0x1004n }, size: 4n }, encoding: 'bytes', evidence_ids: [] };
  const knownData = decode({ ...input, hints: [dataHint] });
  assert.deepEqual(knownData.instructions.map(instruction => instruction.address.value), [0x1000n, 0x1008n]); assert.equal(knownData.gaps[0]?.reason, 'data');
  const decoder = new Arm64Decoder();
  const limited = decoder.decode({ image: input, regions: [{ start: { image_id: input.id, space: 'file', value: 8n }, size: 12n }], mode: 'a64', features: [] }, createOperationContext({ budget: { instructions: 1 } }));
  assert.equal(limited.instructions.length, 1); assert.equal(limited.gaps[0]?.reason, 'budget'); assert.equal(limited.gaps[0]?.range.size, 8n);
  decoder.dispose();
});

test('prepared data boundaries survive failed preparation, changing windows and same-byte snapshots', () => {
  const base = image(words([0xd65f03c0, 0xd65f03c0, 0xd65f03c0]), 0x1000n, 8n);
  const entry = { image_id: base.id, space: 'va' as const, value: 0x1000n };
  const input: LoadedImage = { ...base, hints: [
    ...Array.from({ length: 128 }, () => ({ kind: 'function' as const, address: entry, size: null, evidence_ids: [] })),
    { kind: 'data', range: { start: { ...entry, space: 'file', value: 12n }, size: 4n }, encoding: 'literal_pool', evidence_ids: [] },
  ] };
  const request = { image: input, mode: 'a64' as const, features: [], regions: [{ start: entry, size: 4n }] };
  const decoder = new Arm64Decoder();
  try {
    assert.throws(() => decoder.decode(request, createOperationContext({ budget: { work: 16 } })),
      (error: unknown) => error instanceof OperationError && error.code === 'resource_limit');
    const first = decoder.decode(request, createOperationContext({ budget: { work: 1_000 } }));
    assert.equal(first.instructions[0]?.flow.kind, 'return');
    const whole = { ...request, regions: [{ start: entry, size: 12n }] };
    const result = decoder.decode(whole, createOperationContext({ budget: { work: 1_000 } }));
    assert.deepEqual(result.instructions.map(instruction => instruction.address.value), [0x1000n, 0x1008n]);
    assert.deepEqual(result.gaps.map(gap => [gap.reason, gap.range.start.value, gap.range.size]), [['data', 0x1004n, 4n]]);
    assert.equal(result.coverage.state, 'partial');
    assert.deepEqual(result.instructions[0], first.instructions[0]);
    const limited = decoder.decode(whole, createOperationContext({ budget: { instructions: 1 } }));
    assert.ok(limited.gaps.some(gap => gap.reason === 'budget'));
    assert.equal(limited.instructions.length, 1);
    const controller = new AbortController(); controller.abort();
    assert.throws(() => decoder.decode(whole, createOperationContext({ signal: controller.signal })),
      (error: unknown) => error instanceof OperationError && error.code === 'cancelled');
    assert.throws(() => decoder.decode(whole, createOperationContext({ budget: { work: 1 } })),
      (error: unknown) => error instanceof OperationError && error.code === 'resource_limit');
    const other = decoder.decode({ ...whole, image: { ...input, hints: [] } }, createOperationContext());
    assert.equal(other.coverage.state, 'complete');
    assert.deepEqual(other.instructions.map(instruction => instruction.address.value), [0x1000n, 0x1004n, 0x1008n]);
  } finally { decoder.dispose(); }
});

test('feature expressions remain atomic at the API and preserve canonical SVE aliases', () => {
  const input = image(words([0x05403e25]));
  assert.equal(decode(input, ['FEAT_SVE || FEAT_SME']).instructions[0]?.validity, 'feature_disabled');
  for (const feature of ['FEAT_SVE', 'FEAT_SME']) {
    const instruction = decode(input, [feature]).instructions[0]!;
    assert.equal(instruction.validity, 'valid'); assert.equal(arm(instruction).canonical_encoding, 'eor_z_zi_');
    assert.equal(arm(instruction).alias, 'eon_eor_z_zi');
    assert.equal(arm(instruction).operands[0]?.kind, 'scalable_register');
  }
});

test('decoded wrappers are independent, cancellation propagates and disposal is final', () => {
  const input = fixture('_fixture_arithmetic');
  const decoder = new Arm64Decoder();
  const request = { image: input, mode: 'a64' as const, features: [], regions: [{ start: { image_id: input.id, space: 'va' as const, value: input.image_base }, size: 20n }] };
  const first = decoder.decode(request, createOperationContext());
  for (let iteration = 0; iteration < 100; iteration++) {
    const next = decoder.decode(request, createOperationContext());
    assert.deepEqual(next.instructions, first.instructions);
    assert.notEqual(next.instructions[0], first.instructions[0]); assert.notEqual(arm(next.instructions[0]).fields, arm(first.instructions[0]).fields);
  }
  const controller = new AbortController(); controller.abort();
  assert.throws(() => decoder.decode(request, createOperationContext({ signal: controller.signal })), /cancel/i);
  decoder.dispose(); decoder.dispose();
  assert.throws(() => decoder.decode(request, createOperationContext()), /disposed/);
  assert.throws(() => decoder.format(first.instructions[0]!), /disposed/);
});
