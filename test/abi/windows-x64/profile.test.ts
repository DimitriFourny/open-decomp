// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AbiCallLayout, AbiLocation, AbiProfile, AbiType, RegisterDescriptor } from '../../../src/core/index.js';
import { registerSchema } from '../../../src/core/index.js';
import { WindowsX64Abi, windowsX64Abi } from '../../../src/abi/windows-x64/index.js';

type Signature = Parameters<AbiProfile['classifyCall']>[0];
const u32: AbiType = { kind: 'integer', bits: 32, signed: false };
const u64: AbiType = { kind: 'integer', bits: 64, signed: false };
const f32: AbiType = { kind: 'float', bits: 32 };
const f64: AbiType = { kind: 'float', bits: 64 };
const aggregate = (size: bigint, alignment = 1): AbiType => ({ kind: 'aggregate', size, alignment, fields: [] });
function call(parameters: readonly AbiType[], returns: AbiType = u64, options: Partial<Signature> = {}): AbiCallLayout {
  return windowsX64Abi.classifyCall({ returns, parameters, variadic: false, fixed_parameter_count: parameters.length, ...options });
}
function register(location: AbiLocation | undefined, name: string, bits: number): void {
  assert.ok(location?.kind === 'register');
  assert.equal(location.register.id, `x86_64:${name}`);
  assert.equal(location.value_offset_bits, 0);
  assert.equal(location.width_bits, bits);
}
function overlap(a: RegisterDescriptor, b: RegisterDescriptor): boolean {
  return a.root === b.root && a.offset_bits < b.offset_bits + b.width_bits && b.offset_bits < a.offset_bits + a.width_bits;
}

test('concrete Microsoft profile exposes LLP64 and binary64 long double', () => {
  assert.ok(windowsX64Abi instanceof WindowsX64Abi);
  assert.equal(windowsX64Abi.id, 'windows-x64');
  assert.equal(windowsX64Abi.architecture, 'x86_64');
  assert.deepEqual(windowsX64Abi.layout, { endian: 'little', pointer_bits: 64, char_bits: 8, short_bits: 16,
    int_bits: 32, long_bits: 32, long_long_bits: 64, float_bits: 32, double_bits: 64, long_double_bits: 64,
    stack_alignment: 16, aggregate_max_alignment: 16 });
  assert.equal(windowsX64Abi.stack_pointer.id, 'x86_64:rsp');
});

test('integer and FP arguments share positional slots rather than separate SysV counters', () => {
  const result = call([u32, f64, u64, f32, u64, f64]);
  assert.equal(result.state, 'complete');
  register(result.parameters[0]?.locations[0], 'rcx', 32);
  register(result.parameters[1]?.locations[0], 'xmm1', 64);
  register(result.parameters[2]?.locations[0], 'r8', 64);
  register(result.parameters[3]?.locations[0], 'xmm3', 32);
  assert.deepEqual(result.parameters[4]?.locations, [{ kind: 'stack', offset: 40n, size: 8n, alignment: 8, value_offset_bits: 0 }]);
  assert.deepEqual(result.parameters[5]?.locations, [{ kind: 'stack', offset: 48n, size: 8n, alignment: 8, value_offset_bits: 0 }]);
  register(result.returns[0], 'rax', 64);
  assert.equal(result.shadow_space, 32n);
  assert.equal(result.stack_bytes, 48n);
});

test('shadow space is always reserved but never asserted initialized', () => {
  for (let count = 0; count <= 10; count++) {
    const result = call(Array.from({ length: count }, () => u64), { kind: 'void' });
    assert.equal(result.stack_bytes, (32n + BigInt(Math.max(0, count - 4)) * 8n + 15n) / 16n * 16n);
    assert.equal(result.shadow_space, 32n);
    assert.equal(result.stack_alignment, 16);
    assert.deepEqual(result.returns, []);
    assert.equal(result.hidden_result, null);
    for (const parameter of result.parameters) {
      assert.equal(parameter.locations.length, 1);
      if (parameter.index < 4) assert.equal(parameter.locations[0]?.kind, 'register');
      else assert.deepEqual(parameter.locations[0], { kind: 'stack', offset: 8n + BigInt(parameter.index) * 8n, size: 8n, alignment: 8, value_offset_bits: 0 });
    }
  }
});

test('narrow integer values are right justified without claiming upper register bits', () => {
  const result = call([8, 16, 32, 64].map(bits => ({ kind: 'integer', bits, signed: true })), { kind: 'integer', bits: 8, signed: true });
  for (const [index, name] of ['rcx', 'rdx', 'r8', 'r9'].entries()) register(result.parameters[index]?.locations[0], name, [8, 16, 32, 64][index]!);
  register(result.returns[0], 'rax', 8);
});

test('float and double results use low XMM0 with a decoder-compatible ZMM root', () => {
  for (const bits of [32, 64] as const) {
    const result = call([], { kind: 'float', bits });
    register(result.returns[0], 'xmm0', bits);
    assert.ok(result.returns[0]?.kind === 'register');
    assert.equal(result.returns[0].register.root, 'x86_64:zmm0');
    assert.equal(result.returns[0].register.root_width_bits, 512);
    assert.equal(result.returns[0].register.write_rule, 'preserve_other_bits');
  }
});

for (const size of [1n, 2n, 4n, 8n]) {
  test(`plain ${size}-byte aggregates pass and return as single integers`, () => {
    const result = call([aggregate(size)], aggregate(size));
    assert.equal(result.state, 'complete');
    register(result.parameters[0]?.locations[0], 'rcx', Number(size * 8n));
    register(result.returns[0], 'rax', Number(size * 8n));
    assert.equal(result.hidden_result, null);
  });
}

for (const size of [3n, 5n, 7n, 12n, 16n, 32n]) {
  test(`plain ${size}-byte aggregate results use hidden RCX and return its pointer in RAX`, () => {
    const result = call([u32, f64, u32, f32], aggregate(size));
    assert.equal(result.state, 'complete');
    assert.ok(result.hidden_result?.kind === 'indirect');
    assert.ok('id' in result.hidden_result.pointer);
    assert.equal(result.hidden_result.pointer.id, 'x86_64:rcx');
    assert.equal(result.hidden_result.size, size);
    register(result.returns[0], 'rax', 64);
    register(result.parameters[0]?.locations[0], 'rdx', 32);
    register(result.parameters[1]?.locations[0], 'xmm2', 64);
    register(result.parameters[2]?.locations[0], 'r9', 32);
    assert.deepEqual(result.parameters[3]?.locations[0], { kind: 'stack', offset: 40n, size: 4n, alignment: 8, value_offset_bits: 0 });
    assert.equal(result.stack_bytes, 48n);
  });
}

test('indirect aggregate arguments occupy one pointer slot with aligned caller storage', () => {
  const result = call([aggregate(3n), u32, u64, u32, aggregate(24n, 8)]);
  const first = result.parameters[0]?.locations[0];
  assert.ok(first?.kind === 'indirect' && 'id' in first.pointer);
  assert.equal(first.pointer.id, 'x86_64:rcx');
  assert.equal(first.size, 3n); assert.equal(first.alignment, 16);
  register(result.parameters[1]?.locations[0], 'rdx', 32);
  assert.deepEqual(result.parameters[4]?.locations[0], { kind: 'indirect', pointer: { stack_offset: 40n }, size: 24n, alignment: 16 });
});

test('__m128 arguments are indirect but returns are XMM0, not a hidden result', () => {
  const vector: AbiType = { kind: 'vector', element: 'float', element_bits: 32, lanes: 4 };
  const result = call([vector], vector);
  const argument = result.parameters[0]?.locations[0];
  assert.ok(argument?.kind === 'indirect' && 'id' in argument.pointer);
  assert.equal(argument.pointer.id, 'x86_64:rcx'); assert.equal(argument.alignment, 16);
  register(result.returns[0], 'xmm0', 128);
  assert.equal(result.hidden_result, null);
});

test('64-bit generic vectors cannot be guessed to be Microsoft __m64', () => {
  const vector: AbiType = { kind: 'vector', element: 'integer', element_bits: 32, lanes: 2 };
  const result = call([vector], vector);
  assert.equal(result.state, 'unsupported');
  assert.deepEqual(result.parameters, []);
  assert.deepEqual(result.returns, []);
  assert.ok(result.diagnostics.length > 0);
});

test('variadic FP duplicates positional values in GPRs, with default argument promotions', () => {
  const result = call([f32, u32, f32, f64, f32], f64, { variadic: true, fixed_parameter_count: 2 });
  register(result.parameters[0]?.locations[0], 'xmm0', 32);
  register(result.parameters[0]?.locations[1], 'rcx', 32);
  register(result.parameters[2]?.locations[0], 'xmm2', 64);
  register(result.parameters[2]?.locations[1], 'r8', 64);
  register(result.parameters[3]?.locations[0], 'xmm3', 64);
  register(result.parameters[3]?.locations[1], 'r9', 64);
  assert.equal(result.parameters[1]?.locations.length, 1);
  assert.deepEqual(result.parameters[4]?.locations, [{ kind: 'stack', offset: 40n, size: 8n, alignment: 8, value_offset_bits: 0 }]);
  const integers = call([{ kind: 'integer', bits: 8, signed: false }], u32, { variadic: true, fixed_parameter_count: 0 });
  register(integers.parameters[0]?.locations[0], 'rcx', 32);
});

test('unprototyped known actual operands promote and duplicate FP without inventing a callee count', () => {
  const result = call([u32, f32], f64, { prototyped: false });
  register(result.parameters[1]?.locations[0], 'xmm1', 64);
  register(result.parameters[1]?.locations[1], 'rdx', 64);
});

test('hidden result consumes a positional slot even for variadic duplication', () => {
  const result = call([u32, f64, f64, f64], aggregate(12n, 4), { variadic: true, fixed_parameter_count: 1 });
  register(result.parameters[1]?.locations[0], 'xmm2', 64);
  register(result.parameters[1]?.locations[1], 'r8', 64);
  register(result.parameters[2]?.locations[0], 'xmm3', 64);
  register(result.parameters[2]?.locations[1], 'r9', 64);
  assert.equal(result.parameters[3]?.locations[0]?.kind, 'stack');
});

test('preservation and conservative clobbers cover disjoint SIMD slices, never entire XMM6 roots', () => {
  const clobbers = windowsX64Abi.unknown_call_clobbers;
  assert.equal(clobbers.memory, 'unknown_read_write');
  for (const descriptor of [windowsX64Abi.stack_pointer, ...windowsX64Abi.preserved, ...clobbers.registers, ...clobbers.flags]) registerSchema.parse(descriptor);
  for (const retained of windowsX64Abi.preserved) for (const lost of [...clobbers.registers, ...clobbers.flags]) assert.equal(overlap(retained, lost), false);
  for (let i = 6; i <= 15; i++) {
    const retained = windowsX64Abi.preserved.find(r => r.id === `x86_64:xmm${i}`);
    assert.ok(retained); assert.equal(retained.offset_bits, 0); assert.equal(retained.width_bits, 128); assert.equal(retained.root_width_bits, 512);
    const lost = clobbers.registers.find(r => r.root === retained.root);
    assert.ok(lost); assert.equal(lost.offset_bits, 128); assert.equal(lost.width_bits, 384); assert.equal(lost.write_rule, 'preserve_other_bits');
  }
  for (const name of ['rbx', 'rdi', 'rsi', 'rsp', 'rbp', 'r12', 'r13', 'r14', 'r15']) assert.ok(windowsX64Abi.preserved.some(r => r.id === `x86_64:${name}`));
  for (const name of ['rax', 'rcx', 'rdx', 'r8', 'r9', 'r10', 'r11', 'zmm0', 'zmm5', 'zmm16', 'zmm31', 'st0', 'mm0', 'k0']) assert.ok(clobbers.registers.some(r => r.id === `x86_64:${name}`));
  assert.ok(clobbers.flags.some(r => r.root === 'x86_64:rflags' && r.offset_bits === 11));
});

test('unknown counts and returns preserve uncertainty and conservative memory effects', () => {
  const unknown = windowsX64Abi.classifyCall({ returns: { kind: 'unknown', size: null }, parameters: null, variadic: false, fixed_parameter_count: 0 });
  assert.equal(unknown.state, 'partial'); assert.deepEqual(unknown.parameters, []); assert.deepEqual(unknown.returns, []);
  assert.equal(unknown.hidden_result, null); assert.ok(unknown.diagnostics.length > 0); assert.equal(unknown.clobbers.memory, 'unknown_read_write');
  const count = windowsX64Abi.classifyCall({ returns: u32, parameters: null, variadic: false, fixed_parameter_count: 0 });
  assert.equal(count.state, 'partial'); assert.deepEqual(count.parameters, []);
  register(count.returns[0], 'rax', 32);
  const result = call([u32, { kind: 'unknown', size: 8n }, f64]);
  assert.equal(result.state, 'partial'); assert.deepEqual(result.parameters[1]?.locations, []);
  register(result.parameters[2]?.locations[0], 'xmm2', 64);
});

test('unsupported conventions and nontrivial C++ layouts cannot masquerade as default ABI', () => {
  for (const calling_convention of ['vectorcall', 'member_function', 'unknown'] as const) {
    const result = call([u32], u32, { calling_convention });
    assert.equal(result.state, 'unsupported'); assert.deepEqual(result.parameters, []); assert.deepEqual(result.returns, []);
    assert.ok(result.diagnostics.length > 0);
  }
  const nontrivial: AbiType = { kind: 'aggregate', size: 8n, alignment: 8, fields: [], trivial_for_abi: false };
  assert.equal(call([nontrivial]).state, 'unsupported');
  assert.equal(call([u32], nontrivial).state, 'unsupported');
});

test('unsupported scalar/vector/layout boundaries remain explicit', () => {
  const unsupported: AbiType[] = [
    { kind: 'integer', bits: 128, signed: false }, { kind: 'float', bits: 128 }, { kind: 'float', bits: 16 },
    { kind: 'vector', element: 'float', element_bits: 32, lanes: 8 }, aggregate(0n), aggregate(32n, 32), { kind: 'void' },
  ];
  for (const type of unsupported) {
    const result = call([type]);
    assert.equal(result.state, 'unsupported'); assert.deepEqual(result.parameters[0]?.locations, []); assert.ok(result.diagnostics.length > 0);
  }
  for (const count of [-1, 2, 0.5]) {
    const result = call([u32], u32, { fixed_parameter_count: count });
    assert.equal(result.state, 'unsupported'); assert.equal(result.diagnostics[0]?.code, 'invalid_input');
  }
});
