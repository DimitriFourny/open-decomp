import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';
import { contentHash, createOperationContext, imageIdentity, ImmutableBytes, registerSchema,
  type AbiCallLayout, type AbiLocation, type AbiType, type Arm64Payload, type DecodedInstruction } from '../../../src/core/index.js';
import { darwinArm64Abi as abi } from '../../../src/abi/darwin-arm64/index.js';
import { MachOLoader } from '../../../src/loaders/macho/index.js';
import { Arm64Decoder } from '../../../src/decoders/arm64/index.js';

const u8: AbiType = { kind: 'integer', bits: 8, signed: false };
const u32: AbiType = { kind: 'integer', bits: 32, signed: false };
const u64: AbiType = { kind: 'integer', bits: 64, signed: false };
const i128: AbiType = { kind: 'integer', bits: 128, signed: true };
const f32: AbiType = { kind: 'float', bits: 32 };
const f64: AbiType = { kind: 'float', bits: 64 };
const v4f: AbiType = { kind: 'vector', element: 'float', element_bits: 32, lanes: 4 };
const nothing: AbiType = { kind: 'void' };
const unknown: AbiType = { kind: 'unknown', size: null };
function record(size: bigint, alignment: number, fields: readonly { readonly offset: bigint; readonly type: AbiType }[]): AbiType {
  return { kind: 'aggregate', size, alignment, fields };
}
function repeated(type: AbiType, count: number, stride: bigint, alignment: number): AbiType {
  return record(BigInt(count) * stride, alignment, Array.from({ length: count }, (_, index) => ({ offset: BigInt(index) * stride, type })));
}
function call(parameters: readonly AbiType[], returns: AbiType = nothing, fixed = parameters.length): AbiCallLayout {
  return abi.classifyCall({ parameters, returns, variadic: fixed !== parameters.length, fixed_parameter_count: fixed, argument_list_complete: true });
}
function registers(locations: readonly AbiLocation[]): readonly string[] {
  return locations.map(location => { assert.equal(location.kind, 'register'); assert.ok(location.kind === 'register'); return location.register.id; });
}
function stack(location: AbiLocation | undefined, offset: bigint, size: bigint, alignment: number): void {
  assert.deepEqual(location, { kind: 'stack', offset, size, alignment, value_offset_bits: 0 });
}

// Independent source declarations and LLVM disassembly live in fixtures/source/
// corpus.{c,h} and fixtures/metadata/macho-arm64-symbols.disassembly.txt. Tests
// decode their actual bytes, not assembly text or names as signature evidence.
const manifest = z.object({ codeRanges: z.array(z.object({ architecture: z.string(), symbol: z.string(), address: z.string(), size: z.number() })) })
  .parse(JSON.parse(readFileSync('fixtures/manifest.json', 'utf8')) as unknown);
const bytes = readFileSync('fixtures/bin/macho-arm64-symbols');
const sha256 = contentHash(bytes);
const image = new MachOLoader().load({ image_id: imageIdentity(sha256), sha256, bytes: new ImmutableBytes(bytes), slice_id: null }, createOperationContext());
function fixture(symbol: string): readonly DecodedInstruction[] {
  const range = manifest.codeRanges.find(entry => entry.architecture === 'arm64' && entry.symbol === symbol);
  assert.ok(range);
  const decoder = new Arm64Decoder();
  try {
    const result = decoder.decode({ image, mode: 'a64', features: ['FEAT_FP', 'FEAT_AdvSIMD'], regions: [{
      start: { image_id: image.id, space: 'va', value: BigInt(range.address) }, size: BigInt(range.size),
    }] }, createOperationContext());
    assert.deepEqual(result.gaps, []);
    return result.instructions;
  } finally { decoder.dispose(); }
}
function arm(instruction: DecodedInstruction | undefined): Arm64Payload {
  assert.ok(instruction?.payload?.architecture === 'arm64'); return instruction.payload;
}
function reg(instruction: DecodedInstruction | undefined, index: number) {
  const operand = arm(instruction).operands[index]; assert.ok(operand?.kind === 'register'); return operand.register;
}

test('profile publishes Darwin LP64 and no argument-count or symbol lookup policy', () => {
  assert.equal(abi.id, 'darwin-arm64'); assert.equal(abi.architecture, 'arm64');
  assert.deepEqual(abi.layout, { endian: 'little', pointer_bits: 64, char_bits: 8, short_bits: 16, int_bits: 32,
    long_bits: 64, long_long_bits: 64, float_bits: 32, double_bits: 64, long_double_bits: 64, long_double_storage_bits: 64,
    stack_alignment: 16, aggregate_max_alignment: 16 });
  const opaque = call([], unknown);
  assert.deepEqual(opaque.parameters, []); assert.deepEqual(opaque.returns, []); assert.equal(opaque.hidden_result, null);
  assert.equal(opaque.state, 'partial'); assert.equal(opaque.clobbers.memory, 'unknown_read_write');
});

test('real integer fixture input and return registers exactly match decoder roots and writes', () => {
  const instructions = fixture('_fixture_arithmetic');
  const layout = call([u32, u32], u32);
  assert.equal(layout.state, 'complete'); assert.equal(layout.stack_bytes, 0n);
  const a = layout.parameters[0]!.locations[0], b = layout.parameters[1]!.locations[0], result = layout.returns[0];
  assert.ok(a?.kind === 'register' && b?.kind === 'register' && result?.kind === 'register');
  assert.deepEqual(a.register, reg(instructions[2], 2));
  assert.deepEqual(b.register, reg(instructions[0], 1));
  assert.deepEqual(result.register, reg(instructions[3], 0));
  assert.equal(result.width_bits, 32); assert.equal(result.value_offset_bits, 0);
});

test('real ten-argument fixture reads entry SP offsets zero/eight without a pushed return address', () => {
  const instructions = fixture('_fixture_stack_args');
  const layout = call(Array<AbiType>(10).fill(u64), u64);
  assert.equal(layout.state, 'complete'); assert.equal(layout.stack_bytes, 16n); assert.equal(layout.shadow_space, 0n);
  for (let index = 0; index < 8; index++) assert.deepEqual(registers(layout.parameters[index]!.locations), [`arm64:x${index}`]);
  stack(layout.parameters[8]!.locations[0], 0n, 8n, 8); stack(layout.parameters[9]!.locations[0], 8n, 8n, 8);
  const memory = arm(instructions[0]).operands.find(operand => operand.kind === 'memory');
  assert.ok(memory?.kind === 'memory'); assert.deepEqual(memory.base, abi.stack_pointer);
  assert.equal(memory.displacement, 0n); assert.equal(memory.access_bits, 128); assert.equal(memory.writeback, 'none');
  assert.equal(reg(instructions[0], 0).id, 'arm64:x9'); assert.equal(reg(instructions[0], 1).id, 'arm64:x8');
  const returned = layout.returns[0]; assert.ok(returned?.kind === 'register');
  assert.deepEqual(returned.register, reg(instructions.at(-2), 0));
});

test('real floating fixture agrees on independent SIMD parameter bank and scalar return', () => {
  const instructions = fixture('_fixture_float');
  const layout = call([f64, f64], f64);
  assert.deepEqual(registers(layout.parameters[0]!.locations), ['arm64:d0']);
  assert.deepEqual(registers(layout.parameters[1]!.locations), ['arm64:d1']);
  const result = layout.returns[0]; assert.ok(result?.kind === 'register');
  assert.deepEqual(result.register, reg(instructions[4], 0));
  assert.deepEqual(result.register, reg(instructions[1], 1));
  const mixed = call([u32, f32, u64, f64, v4f, { kind: 'pointer' }], v4f);
  assert.deepEqual(mixed.parameters.map(parameter => registers(parameter.locations)), [
    ['arm64:w0'], ['arm64:s0'], ['arm64:x1'], ['arm64:d1'], ['arm64:v2'], ['arm64:x2'],
  ]);
  assert.deepEqual(registers(mixed.returns), ['arm64:v0']);
  const vectorResult = mixed.returns[0]; assert.ok(vectorResult?.kind === 'register');
  assert.deepEqual(vectorResult.register, reg(fixture('_fixture_vector')[2], 0));
});

test('real variadic fixture starts va_list at entry SP and advances in eight-byte slots', () => {
  const instructions = fixture('_fixture_variadic');
  const layout = call([u32, f64, f64, f64], f64, 1);
  assert.deepEqual(registers(layout.parameters[0]!.locations), ['arm64:w0']);
  [0n, 8n, 16n].forEach((offset, index) => stack(layout.parameters[index + 1]!.locations[0], offset, 8n, 8));
  assert.equal(layout.stack_bytes, 32n);
  // SUB SP,#16 followed by ADD X8,SP,#16 initializes va_list to entry SP.
  assert.equal(arm(instructions[0]).fields.imm12, 16n);
  assert.equal(reg(instructions[0], 0).id, 'arm64:sp');
  assert.equal(arm(instructions[1]).fields.imm12, 16n); assert.equal(reg(instructions[1], 1).id, 'arm64:sp');
  const advance = instructions.find(instruction => arm(instruction).fields.imm12 === 8n);
  assert.ok(advance); assert.equal(reg(advance, 0).id, 'arm64:x9'); assert.equal(reg(advance, 1).id, 'arm64:x8');
  const load = instructions.find(instruction => arm(instruction).operands.some(operand => operand.kind === 'memory' && operand.base.id === 'arm64:x8'));
  assert.ok(load); assert.equal(reg(load, 0).id, 'arm64:d1');
});

test('Darwin packs named narrow stack values and honors natural alignment', () => {
  const layout = call([...Array<AbiType>(8).fill(u64), u8, u8, u32, u64]);
  stack(layout.parameters[8]!.locations[0], 0n, 1n, 1);
  stack(layout.parameters[9]!.locations[0], 1n, 1n, 1);
  stack(layout.parameters[10]!.locations[0], 4n, 4n, 4);
  stack(layout.parameters[11]!.locations[0], 8n, 8n, 8);
  assert.equal(layout.stack_bytes, 16n);
  const floats = call([...Array<AbiType>(8).fill(f64), f32, f32, f64]);
  stack(floats.parameters[8]!.locations[0], 0n, 4n, 4);
  stack(floats.parameters[9]!.locations[0], 4n, 4n, 4);
  stack(floats.parameters[10]!.locations[0], 8n, 8n, 8);
  const narrow = call([u8, { kind: 'integer', bits: 16, signed: true }], u8);
  assert.deepEqual(registers(narrow.parameters[0]!.locations), ['arm64:w0']);
  assert.equal(narrow.parameters[0]!.locations[0]?.kind === 'register' && narrow.parameters[0]!.locations[0].width_bits, 8);
  assert.equal(narrow.returns[0]?.kind === 'register' && narrow.returns[0].width_bits, 8);
});

test('int128 can start in odd register and never splits across registers and stack', () => {
  const odd = call([u32, i128, u64], i128);
  assert.deepEqual(registers(odd.parameters[1]!.locations), ['arm64:x1', 'arm64:x2']);
  assert.deepEqual(registers(odd.parameters[2]!.locations), ['arm64:x3']);
  assert.deepEqual(registers(odd.returns), ['arm64:x0', 'arm64:x1']);
  assert.deepEqual(odd.returns.map(location => location.kind === 'register' ? location.value_offset_bits : -1), [0, 64]);
  const spill = call([...Array<AbiType>(7).fill(u64), i128, u64]);
  stack(spill.parameters[7]!.locations[0], 0n, 16n, 16);
  stack(spill.parameters[8]!.locations[0], 16n, 8n, 8); assert.equal(spill.stack_bytes, 32n);
});

test('small mixed aggregates use integer chunks with exact source offsets', () => {
  const mixed = record(16n, 8, [{ offset: 0n, type: f64 }, { offset: 8n, type: u32 }]);
  const layout = call([u32, mixed], mixed);
  assert.equal(layout.state, 'complete'); assert.deepEqual(registers(layout.parameters[1]!.locations), ['arm64:x1', 'arm64:x2']);
  assert.deepEqual(registers(layout.returns), ['arm64:x0', 'arm64:x1']);
  const threeBytes = repeated(u8, 3, 1n, 1);
  const short = call([threeBytes], threeBytes).returns[0];
  assert.ok(short?.kind === 'register'); assert.equal(short.register.id, 'arm64:x0'); assert.equal(short.width_bits, 24);
  const spill = call([...Array<AbiType>(7).fill(u64), mixed, u32]);
  stack(spill.parameters[7]!.locations[0], 0n, 16n, 8); stack(spill.parameters[8]!.locations[0], 16n, 4n, 4);
});

test('HFA/HVA classification flattens nested complete layouts and counts at most four members', () => {
  const pair = repeated(f32, 2, 4n, 4);
  const nested = repeated(pair, 2, 8n, 4);
  const layout = call([u64, nested, f64], nested);
  assert.deepEqual(registers(layout.parameters[1]!.locations), ['arm64:s0', 'arm64:s1', 'arm64:s2', 'arm64:s3']);
  assert.deepEqual(registers(layout.parameters[2]!.locations), ['arm64:d4']);
  assert.deepEqual(layout.returns.map(location => location.kind === 'register' ? location.value_offset_bits : -1), [0, 32, 64, 96]);
  const bigHfa = repeated(f64, 4, 8n, 8);
  assert.equal(call([bigHfa], bigHfa).hidden_result, null);
  assert.deepEqual(registers(call([], bigHfa).returns), ['arm64:d0', 'arm64:d1', 'arm64:d2', 'arm64:d3']);
  const hva = repeated(v4f, 4, 16n, 16);
  assert.deepEqual(registers(call([hva], hva).returns), ['arm64:v0', 'arm64:v1', 'arm64:v2', 'arm64:v3']);
  const vector64: AbiType = { kind: 'vector', element: 'integer', element_bits: 8, lanes: 8 };
  const other64: AbiType = { kind: 'vector', element: 'float', element_bits: 32, lanes: 2 };
  // HVA homogeneity compares vector total widths, not their lane types.
  assert.deepEqual(registers(call([], record(16n, 8, [{ offset: 0n, type: vector64 }, { offset: 8n, type: other64 }])).returns), ['arm64:v0', 'arm64:v1']);
  const five = repeated(f32, 5, 4n, 4);
  assert.equal(call([], five).hidden_result?.kind, 'indirect');
});

test('HFA exhaustion spills whole object and closes SIMD bank, not integer bank', () => {
  const hfa = repeated(f32, 2, 4n, 4);
  const layout = call([...Array<AbiType>(7).fill(f64), hfa, f32, u64]);
  stack(layout.parameters[7]!.locations[0], 0n, 8n, 4);
  stack(layout.parameters[8]!.locations[0], 8n, 4n, 4);
  assert.deepEqual(registers(layout.parameters[9]!.locations), ['arm64:x0']);
  assert.equal(layout.stack_bytes, 16n);
});

test('padding and heterogeneous aggregates do not become invented HFAs', () => {
  const padded = record(16n, 8, [{ offset: 0n, type: f32 }, { offset: 8n, type: f32 }]);
  assert.deepEqual(registers(call([], padded).returns), ['arm64:x0', 'arm64:x1']);
  const mixed = record(16n, 8, [{ offset: 0n, type: f32 }, { offset: 8n, type: f64 }]);
  assert.deepEqual(registers(call([], mixed).returns), ['arm64:x0', 'arm64:x1']);
  const packed = record(9n, 1, [{ offset: 0n, type: u8 }, { offset: 1n, type: u64 }]);
  const locations = call([], packed).returns;
  assert.deepEqual(registers(locations), ['arm64:x0', 'arm64:x1']);
  assert.equal(locations[1]?.kind === 'register' && locations[1].width_bits, 8);
});

test('large non-HFA uses indirect copy, and x8 result does not shift normal arguments', () => {
  const large = repeated(u64, 3, 8n, 8);
  const layout = call([large, u32], large);
  assert.equal(layout.state, 'complete'); assert.equal(layout.stack_bytes, 0n); assert.deepEqual(layout.returns, []);
  const hidden = layout.hidden_result; assert.ok(hidden?.kind === 'indirect' && 'id' in hidden.pointer);
  assert.equal(hidden.pointer.id, 'arm64:x8'); assert.equal(hidden.size, 24n); assert.equal(hidden.alignment, 8);
  const argument = layout.parameters[0]!.locations[0]; assert.ok(argument?.kind === 'indirect' && 'id' in argument.pointer);
  assert.equal(argument.pointer.id, 'arm64:x0'); assert.equal(argument.size, 24n);
  assert.deepEqual(registers(layout.parameters[1]!.locations), ['arm64:w1']);
  const spill = call([...Array<AbiType>(8).fill(u64), large], large);
  assert.deepEqual(spill.parameters[8]!.locations, [{ kind: 'indirect', pointer: { stack_offset: 0n }, size: 24n, alignment: 8 }]);
  assert.equal(spill.stack_bytes, 16n); // Not the caller-chosen object's storage.
});

test('empty trivial aggregates consume no register or stack slot', () => {
  const empty = record(0n, 1, []);
  const layout = call([empty, u32, empty, f64], empty);
  assert.equal(layout.state, 'complete'); assert.deepEqual(layout.parameters[0]!.locations, []);
  assert.deepEqual(registers(layout.parameters[1]!.locations), ['arm64:w0']);
  assert.deepEqual(registers(layout.parameters[3]!.locations), ['arm64:d0']); assert.deepEqual(layout.returns, []);
});

test('variadic anonymous slots follow packed fixed spills, use promotions and preserve wide alignment', () => {
  const layout = call([...Array<AbiType>(8).fill(u64), u8, u32, f64, i128, v4f], nothing, 9);
  stack(layout.parameters[8]!.locations[0], 0n, 1n, 1);
  stack(layout.parameters[9]!.locations[0], 8n, 4n, 8);
  stack(layout.parameters[10]!.locations[0], 16n, 8n, 8);
  stack(layout.parameters[11]!.locations[0], 32n, 16n, 16);
  stack(layout.parameters[12]!.locations[0], 48n, 16n, 16); assert.equal(layout.stack_bytes, 64n);
  const hfa = repeated(f32, 3, 4n, 4);
  const aggregates = call([u32, hfa, u64], nothing, 1);
  stack(aggregates.parameters[1]!.locations[0], 0n, 12n, 8);
  stack(aggregates.parameters[2]!.locations[0], 16n, 8n, 8);
  for (const type of [u8, f32]) {
    const promoted = call([u32, type, u64], nothing, 1);
    assert.equal(promoted.state, 'complete');
    stack(promoted.parameters[1]!.locations[0], 0n, type.kind === 'float' ? 8n : 4n, 8);
    stack(promoted.parameters[2]!.locations[0], 8n, 8n, 8);
  }
});

test('unknown/unsupported parameters never invent later bank or stack certainty', () => {
  const unsupported: AbiType[] = [unknown, { kind: 'unknown', size: 8n }, { kind: 'float', bits: 128 },
    { kind: 'integer', bits: 256, signed: true }, { kind: 'vector', element: 'integer', element_bits: 32, lanes: 8 },
    record(8n, 8, []), record(8n, 8, [{ offset: 0n, type: unknown }]),
    record(16n, 8, [{ offset: 0n, type: u64 }, { offset: 4n, type: u64 }]),
    record(8n, 8, [{ offset: 8n, type: u64 }]), record(8n, 3, [{ offset: 0n, type: u64 }])];
  for (const type of unsupported) {
    const layout = call([...Array<AbiType>(9).fill(u64), type, f64, u64], u64);
    assert.equal(layout.state, 'partial'); assert.equal(layout.stack_bytes, 16n);
    assert.deepEqual(layout.parameters.slice(9).map(parameter => parameter.locations), [[], [], []]);
    assert.deepEqual(registers(layout.returns), ['arm64:x0']);
  }
  const unknownReturn = call([u64, f64], unknown);
  assert.deepEqual(registers(unknownReturn.parameters[0]!.locations), ['arm64:x0']);
  assert.deepEqual(registers(unknownReturn.parameters[1]!.locations), ['arm64:d0']);
});

test('invalid signatures and cyclic/overdeep layouts produce explicit bounded diagnostics', () => {
  for (const count of [-1, 0.5, 2, NaN]) {
    const layout = abi.classifyCall({ parameters: [u32], returns: u32, variadic: true, fixed_parameter_count: count });
    assert.equal(layout.state, 'unsupported'); assert.equal(layout.diagnostics[0]?.code, 'invalid_input');
    assert.deepEqual(layout.parameters[0]!.locations, []);
  }
  const invalid = abi.classifyCall({ parameters: [u32], returns: u32, variadic: false, fixed_parameter_count: 0 });
  assert.equal(invalid.state, 'unsupported');
  let nested: AbiType = f32;
  for (let i = 0; i < 70; i++) nested = record(4n, 4, [{ offset: 0n, type: nested }]);
  assert.equal(call([nested]).state, 'partial');
  const fields: { offset: bigint; type: AbiType }[] = [];
  const cyclic = record(8n, 8, fields); fields.push({ offset: 0n, type: cyclic });
  assert.equal(call([cyclic]).state, 'partial');
});

test('unknown counts and non-C contracts never become a known ordinary call', () => {
  const unknownCount = abi.classifyCall({ parameters: null, returns: u64, variadic: false, fixed_parameter_count: 0 });
  assert.equal(unknownCount.state, 'partial');
  assert.deepEqual(unknownCount.parameters, []);
  assert.deepEqual(registers(unknownCount.returns), ['arm64:x0']);
  for (const calling_convention of ['vectorcall', 'member_function', 'unknown'] as const) {
    const unsupported = abi.classifyCall({ parameters: [u64], returns: u64, variadic: false, fixed_parameter_count: 1, calling_convention });
    assert.equal(unsupported.state, 'unsupported');
    assert.deepEqual(unsupported.parameters[0]?.locations, []);
    assert.deepEqual(unsupported.returns, []);
  }
  const nontrivial: AbiType = { kind: 'aggregate', size: 8n, alignment: 8, fields: [{ offset: 0n, type: u64 }], trivial_for_abi: false };
  const layout = call([nontrivial, u64], nontrivial);
  assert.equal(layout.state, 'partial');
  assert.deepEqual(layout.parameters.map(parameter => parameter.locations), [[], []]);
  assert.deepEqual(layout.returns, []);
});

test('preservation boundaries are disjoint from conservative call clobbers including SIMD high halves', () => {
  const preserved = abi.preserved;
  assert.ok(preserved.some(register => register.id === 'arm64:sp'));
  for (let i = 19; i <= 29; i++) assert.ok(preserved.some(register => register.id === `arm64:x${i}` && register.width_bits === 64));
  assert.ok(!preserved.some(register => register.id === 'arm64:x18' || register.id === 'arm64:x30'));
  for (let i = 8; i <= 15; i++) {
    const low = preserved.find(register => register.root === `arm64:v${i}`);
    assert.ok(low); assert.equal(low.offset_bits, 0); assert.equal(low.width_bits, 64); assert.equal(low.root_width_bits, 128);
    const high = abi.unknown_call_clobbers.registers.find(register => register.root === low.root);
    assert.ok(high); assert.equal(high.offset_bits, 64); assert.equal(high.width_bits, 64); assert.equal(high.write_rule, 'preserve_other_bits');
  }
  for (const register of [...preserved, ...abi.unknown_call_clobbers.registers, ...abi.unknown_call_clobbers.flags]) registerSchema.parse(register);
  for (const kept of preserved) for (const lost of abi.unknown_call_clobbers.registers) {
    if (kept.root === lost.root) assert.ok(kept.offset_bits + kept.width_bits <= lost.offset_bits || lost.offset_bits + lost.width_bits <= kept.offset_bits);
  }
  for (const id of ['arm64:x0', 'arm64:x8', 'arm64:x16', 'arm64:x17', 'arm64:x30', 'arm64:v0', 'arm64:v31', 'arm64:fpcr']) {
    assert.ok(abi.unknown_call_clobbers.registers.some(register => register.id === id), id);
  }
  assert.deepEqual(abi.unknown_call_clobbers.flags.map(register => register.id), ['arm64:nzcv', 'arm64:fpsr']);
  assert.equal(abi.unknown_call_clobbers.memory, 'unknown_read_write');
  const frame = arm(fixture('_fixture_direct')[0]).operands.filter(operand => operand.kind === 'register');
  assert.ok(frame.length >= 2);
  for (const operand of frame) assert.ok(preserved.some(register => register.id === operand.register.id));
});
