// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerSchema, type AbiCallLayout, type AbiLocation, type AbiSignature, type AbiType } from '../../../src/core/index.js';
import { SysVAMD64Abi, sysvAMD64Abi as abi } from '../../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { darwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';

const u64: AbiType = { kind: 'integer', bits: 64, signed: false }, f64: AbiType = { kind: 'float', bits: 64 };
const nothing: AbiType = { kind: 'void' };
function aggregate(fields: readonly AbiType[], alignment = 8): Extract<AbiType, { kind: 'aggregate' }> {
  return { kind: 'aggregate', size: BigInt(fields.length * 8), alignment, fields: fields.map((type, index) => ({ type, offset: BigInt(index * 8) })) };
}
function call(parameters: readonly AbiType[], returns: AbiType = nothing, extra: Partial<AbiSignature> = {}): AbiCallLayout {
  return abi.classifyCall({ parameters, returns, variadic: false, fixed_parameter_count: parameters.length, argument_list_complete: true, ...extra });
}
function registers(locations: readonly AbiLocation[]): unknown[] {
  return locations.map(location => location.kind === 'register' ? [location.register.id, location.value_offset_bits, location.width_bits] : location.kind);
}
const stack = (offset: bigint, size: bigint, alignment = 8): AbiLocation => ({ kind: 'stack', offset, size, alignment, value_offset_bits: 0 });

test('LP64 extended precision distinguishes value bits from padded object storage', () => {
  assert.ok(abi instanceof SysVAMD64Abi);
  assert.equal(abi.layout.long_bits, 64); assert.equal(abi.layout.pointer_bits, 64);
  assert.equal(abi.layout.long_double_bits, 80); assert.equal(abi.layout.long_double_storage_bits, 128);
  assert.equal(abi.stack_return_address_bytes, 8n); assert.equal(abi.red_zone_bytes, 128n);
  for (const other of [windowsX64Abi, darwinArm64Abi]) {
    assert.equal(other.layout.long_double_bits, 64); assert.equal(other.layout.long_double_storage_bits, 64);
    assert.deepEqual(other.classifyCall({ returns: nothing, parameters: [], variadic: true, fixed_parameter_count: 0 }).implicit_register_inputs, []);
  }
});

test('INTEGER and SSE use independent banks, including narrow fragments', () => {
  const result = call([{ kind: 'integer', bits: 8, signed: true }, f64, u64, { kind: 'float', bits: 32 }, u64]);
  assert.equal(result.state, 'complete'); assert.equal(result.shadow_space, 0n); assert.equal(result.stack_bytes, 0n);
  assert.deepEqual(result.parameters.map(item => registers(item.locations)), [
    [['x86_64:rdi', 0, 8]], [['x86_64:xmm0', 0, 64]], [['x86_64:rsi', 0, 64]], [['x86_64:xmm1', 0, 32]], [['x86_64:rdx', 0, 64]],
  ]);
});

test('aggregate eightbytes retain source offsets and independent mixed return banks', () => {
  for (const fields of [[u64, f64], [f64, u64], [f64, f64], [u64, u64]]) {
    const type = aggregate(fields), result = call([type], type);
    assert.equal(result.state, 'complete'); assert.equal(result.hidden_result, null);
    let gi = 0, vi = 0;
    assert.deepEqual(registers(result.returns), fields.map((field, index) => [field.kind === 'float' ? `x86_64:xmm${vi++}` : `x86_64:${['rax', 'rdx'][gi++]}`, index * 64, 64]));
  }
  const merged: AbiType = { kind: 'aggregate', size: 8n, alignment: 4, fields: [{ offset: 0n, type: { kind: 'float', bits: 32 } }, { offset: 4n, type: { kind: 'integer', bits: 32, signed: true } }] };
  assert.deepEqual(registers(call([merged], merged).returns), [['x86_64:rax', 0, 64]]);
  const nested = { kind: 'aggregate' as const, size: 16n, alignment: 8, fields: [{ offset: 0n, type: aggregate([f64]) }, { offset: 8n, type: u64 }] };
  assert.deepEqual(registers(call([nested]).parameters[0]!.locations), [['x86_64:xmm0', 0, 64], ['x86_64:rdi', 64, 64]]);
});

test('rollback restores both banks when any aggregate eightbyte cannot fit', () => {
  const mixed = aggregate([u64, f64]);
  const integersFull = call([...Array<AbiType>(6).fill(u64), mixed, f64]);
  assert.deepEqual(integersFull.parameters[6]!.locations, [stack(8n, 16n)]);
  assert.deepEqual(registers(integersFull.parameters[7]!.locations), [['x86_64:xmm0', 0, 64]]);
  const vectorsFull = call([...Array<AbiType>(8).fill(f64), mixed, u64]);
  assert.deepEqual(vectorsFull.parameters[8]!.locations, [stack(8n, 16n)]);
  assert.deepEqual(registers(vectorsFull.parameters[9]!.locations), [['x86_64:rdi', 0, 64]]);
  const twoIntegers = call([...Array<AbiType>(5).fill(u64), aggregate([u64, u64]), u64]);
  assert.deepEqual(twoIntegers.parameters[5]!.locations, [stack(8n, 16n)]);
  assert.deepEqual(registers(twoIntegers.parameters[6]!.locations), [['x86_64:r9', 0, 64]]);
});

test('SSEUP occupies the upper half of one XMM register, not a second vector slot', () => {
  for (const type of [{ kind: 'vector', element: 'float', element_bits: 32, lanes: 4 }, { kind: 'float', bits: 128 }] satisfies AbiType[]) {
    const result = call([type, f64], type, { variadic: true, fixed_parameter_count: 2 });
    assert.deepEqual(registers(result.parameters[0]!.locations), [['x86_64:xmm0', 0, 128]]);
    assert.deepEqual(registers(result.parameters[1]!.locations), [['x86_64:xmm1', 0, 64]]);
    assert.deepEqual(registers(result.returns), [['x86_64:xmm0', 0, 128]]);
    assert.equal(result.implicit_register_inputs[0]!.unsigned_minimum, 2n);
  }
});

test('MEMORY return consumes RDI, returns its pointer in RAX, but does not shift SSE', () => {
  const result = call([u64, f64, ...Array<AbiType>(5).fill(u64)], aggregate([u64, u64, u64]));
  assert.ok(result.hidden_result?.kind === 'indirect' && 'id' in result.hidden_result.pointer);
  assert.equal(result.hidden_result.pointer.id, 'x86_64:rdi'); assert.equal(result.hidden_result.size, 24n);
  assert.deepEqual(registers(result.returns), [['x86_64:rax', 0, 64]]);
  assert.deepEqual(registers(result.parameters[0]!.locations), [['x86_64:rsi', 0, 64]]);
  assert.deepEqual(registers(result.parameters[1]!.locations), [['x86_64:xmm0', 0, 64]]);
  assert.deepEqual(result.parameters[6]!.locations, [stack(8n, 8n)]);
});

test('stack overflow arguments use callee RSP+8 and respect 16-byte and over-aligned objects', () => {
  const result = call([...Array<AbiType>(8).fill(f64), f64, f64]);
  assert.deepEqual(result.parameters.slice(8).map(item => item.locations), [[stack(8n, 8n)], [stack(16n, 8n)]]);
  assert.equal(result.stack_bytes, 16n);
  const wide: AbiType = { kind: 'integer', bits: 128, signed: true };
  const aligned = call([...Array<AbiType>(6).fill(u64), u64, wide]);
  assert.deepEqual(aligned.parameters[7]!.locations, [stack(24n, 16n, 16)]); assert.equal(aligned.stack_bytes, 32n);
  const over: AbiType = { kind: 'aggregate', size: 32n, alignment: 32, fields: [{ offset: 0n, type: u64 }] };
  const overAligned = call([...Array<AbiType>(6).fill(u64), u64, over]);
  assert.deepEqual(overAligned.parameters[7]!.locations, [stack(40n, 32n, 32)]);
  assert.equal(overAligned.stack_alignment, 32); assert.equal(overAligned.stack_bytes, 64n);
  const huge: AbiType = { kind: 'aggregate', size: 0xffff_ffff_ffff_fff8n, alignment: 8, fields: [{ offset: 0n, type: u64 }] };
  const overflow = call([huge, u64]);
  assert.equal(overflow.state, 'unsupported'); assert.deepEqual(overflow.parameters.map(item => item.locations), [[], []]);
});

test('unaligned fields force MEMORY, while incomplete layouts never guess later bank allocation', () => {
  const packed: AbiType = { kind: 'aggregate', size: 9n, alignment: 1, fields: [{ offset: 0n, type: { kind: 'integer', bits: 8, signed: false } }, { offset: 1n, type: f64 }] };
  assert.deepEqual(call([packed]).parameters[0]!.locations, [stack(8n, 9n)]);
  assert.ok(call([], packed).hidden_result);
  for (const type of [{ kind: 'unknown', size: 8n }, { kind: 'aggregate', size: 16n, alignment: 8, fields: [] }] satisfies AbiType[]) {
    const result = call([f64, type, u64, f64], nothing, { variadic: true, fixed_parameter_count: 1 });
    assert.notEqual(result.state, 'complete'); assert.deepEqual(result.parameters.slice(1).map(item => item.locations), [[], [], []]);
    assert.equal(result.implicit_register_inputs[0]!.unsigned_minimum, 1n); assert.equal(result.implicit_register_inputs[0]!.unsigned_maximum, 8n);
    assert.deepEqual(call([u64], type).parameters, []);
  }
});

test('variadic AL is an unsigned upper bound with promotions, never an invented source argument', () => {
  const result = call([u64, { kind: 'float', bits: 32 }, { kind: 'integer', bits: 8, signed: false }], nothing, { variadic: true, fixed_parameter_count: 1 });
  assert.equal(result.parameters.length, 3);
  assert.deepEqual(registers(result.parameters[1]!.locations), [['x86_64:xmm0', 0, 64]]);
  assert.deepEqual(registers(result.parameters[2]!.locations), [['x86_64:rsi', 0, 32]]);
  const input = result.implicit_register_inputs[0]!;
  registerSchema.parse(input.register); assert.equal(input.register.id, 'x86_64:al'); assert.equal(input.register.width_bits, 8);
  assert.equal(input.unsigned_minimum, 1n); assert.equal(input.unsigned_maximum, 8n);
  assert.equal(call([...Array<AbiType>(9).fill(f64)], nothing, { prototyped: false }).implicit_register_inputs[0]!.unsigned_minimum, 8n);
  const unknown = abi.classifyCall({ parameters: null, returns: nothing, variadic: true, fixed_parameter_count: 0 });
  assert.equal(unknown.state, 'partial'); assert.equal(unknown.implicit_register_inputs[0]!.unsigned_minimum, 0n);
  assert.deepEqual(call([]).implicit_register_inputs, []);
});

test('x87 storage is truthful but reconstruction is unsupported; AVX is not silently stack-classified', () => {
  const extended: AbiType = { kind: 'float', bits: 80 };
  const result = call([extended, u64], extended);
  assert.equal(result.state, 'unsupported'); assert.deepEqual(result.returns, []); assert.equal(result.hidden_result, null);
  assert.deepEqual(result.parameters[0]!.locations, [stack(8n, 16n, 16)]);
  assert.deepEqual(registers(result.parameters[1]!.locations), [['x86_64:rdi', 0, 64]]);
  for (const type of [{ kind: 'vector', element: 'float', element_bits: 32, lanes: 8 }, { ...aggregate([u64]), trivial_for_abi: false }] satisfies AbiType[]) {
    const result = call([type, u64]); assert.equal(result.state, 'unsupported'); assert.deepEqual(result.parameters.map(item => item.locations), [[], []]);
  }
});

test('SysV clobbers RDI/RSI and every SIMD bank, preserving only ABI-defined disjoint state', () => {
  const lost = [...abi.unknown_call_clobbers.registers, ...abi.unknown_call_clobbers.flags];
  for (const register of [abi.stack_pointer, ...abi.preserved, ...lost]) registerSchema.parse(register);
  for (const kept of abi.preserved) for (const clobber of lost) assert.equal(kept.root === clobber.root && kept.offset_bits < clobber.offset_bits + clobber.width_bits && clobber.offset_bits < kept.offset_bits + kept.width_bits, false);
  for (const name of ['rdi', 'rsi', 'zmm0', 'zmm6', 'zmm15', 'st0']) assert.ok(lost.some(register => register.id === `x86_64:${name}`));
  for (const name of ['rbx', 'rbp', 'rsp', 'r12', 'r13', 'r14', 'r15']) assert.ok(abi.preserved.some(register => register.id === `x86_64:${name}`));
});

test('anonymous half precision never invents a double promotion without a source-kind contract', () => {
  const result = call([{ kind: 'float', bits: 16 }, u64], nothing, { variadic: true, fixed_parameter_count: 0 });
  assert.equal(result.state, 'unsupported'); assert.deepEqual(result.parameters.map(item => item.locations), [[], []]);
  assert.deepEqual(registers(call([{ kind: 'float', bits: 16 }]).parameters[0]!.locations), [['x86_64:xmm0', 0, 16]]);
});

test('existing profiles never accept newly representable extended precision as binary64', () => {
  for (const other of [darwinArm64Abi, windowsX64Abi]) {
    const result = other.classifyCall({ parameters: [{ kind: 'float', bits: 80 }], returns: { kind: 'float', bits: 80 }, variadic: false, fixed_parameter_count: 1 });
    assert.notEqual(result.state, 'complete'); assert.deepEqual(result.returns, []);
    assert.ok(result.parameters.every(parameter => parameter.locations.length === 0));
  }
});

test('nested packed aggregate leaf alignment uses the absolute containing offset', () => {
  const inner: AbiType = { kind: 'aggregate', size: 8n, alignment: 1, fields: [{ offset: 0n, type: f64 }] };
  const outer: AbiType = { kind: 'aggregate', size: 9n, alignment: 1, fields: [
    { offset: 0n, type: { kind: 'integer', bits: 8, signed: false } }, { offset: 1n, type: inner },
  ] };
  const result = call([outer, u64, f64], outer);
  assert.deepEqual(result.parameters[0]!.locations, [stack(8n, 9n)]);
  assert.ok(result.hidden_result?.kind === 'indirect' && 'root' in result.hidden_result.pointer);
  assert.equal(result.hidden_result.pointer.root, 'x86_64:rdi');
  assert.deepEqual(registers(result.parameters[1]!.locations), [['x86_64:rsi', 0, 64]]);
  assert.deepEqual(registers(result.parameters[2]!.locations), [['x86_64:xmm0', 0, 64]]);
  assert.deepEqual(registers(result.returns), [['x86_64:rax', 0, 64]]);
  assert.deepEqual(registers(call([inner]).parameters[0]!.locations), [['x86_64:xmm0', 0, 64]]);
});

test('actual argument count stays independent from physical layout completeness', () => {
  const partialLayout = call([f64, { kind: 'unknown', size: 8n }], nothing, { variadic: true, fixed_parameter_count: 1 });
  assert.equal(partialLayout.state, 'partial'); assert.equal(partialLayout.argument_count, 2);
  assert.equal(partialLayout.implicit_register_inputs[0]!.unsigned_minimum, 1n);
  const declaration = abi.classifyCall({ parameters: [f64], returns: nothing, variadic: true, fixed_parameter_count: 1 });
  assert.equal(declaration.state, 'partial'); assert.equal(declaration.argument_count, null);
  assert.deepEqual(registers(declaration.parameters[0]!.locations), [['x86_64:xmm0', 0, 64]]);
  assert.equal(declaration.implicit_register_inputs[0]!.unsigned_minimum, 1n);
  assert.equal(call([]).argument_count, 0);
  assert.equal(abi.classifyCall({ parameters: null, returns: nothing, variadic: true, fixed_parameter_count: 0, argument_list_complete: true }).argument_count, null);
});
