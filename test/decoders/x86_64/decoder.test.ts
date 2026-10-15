import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { X86Decoder } from '../../../src/decoders/x86_64/index.js';
import { createOperationContext as operation, type DecodeResult, type DecodedInstruction, type X86Payload } from '../../../src/core/index.js';
import { imageFromBytes, region } from './helpers.js';

function decode(bytes: readonly number[]): DecodeResult {
  const decoder = new X86Decoder({ formatting: false });
  const image = imageFromBytes(Uint8Array.from(bytes));
  try { return decoder.decode({ image, regions: [region(image)], features: [], mode: 'long64' }, operation()); }
  finally { decoder.dispose(); }
}
function x86(instruction: DecodedInstruction | undefined): X86Payload {
  assert.ok(instruction);
  assert.equal(instruction.validity, 'valid');
  assert.ok(instruction.payload?.architecture === 'x86_64');
  return instruction.payload;
}

test('RIP-relative loads preserve signed displacement, target, and exact reference', () => {
  const result = decode([0x48, 0x8b, 0x05, 0xe0, 0xff, 0xff, 0xff]);
  const instruction = result.instructions[0]!;
  const operand = x86(instruction).operands[1];
  assert.ok(operand?.kind === 'memory');
  assert.equal(operand.memory.base?.id, 'x86_64:rip');
  assert.equal(operand.memory.displacement, -32n);
  assert.equal(operand.memory.rip_relative_target?.value, 0xfe7n);
  assert.equal(operand.memory.access_bits, 64);
  assert.equal(operand.memory.access, 'read');
  assert.equal(x86(instruction).memory[0]?.rip_relative_target?.value, 0xfe7n);
  assert.equal(instruction.bytes.start.space, 'file');
  assert.equal(instruction.bytes.start.value, 0n);
  assert.equal(instruction.bytes.size, 7n);
});

test('address override, SIB scale, FS override, and LEA address-only effects stay distinct', () => {
  const [load, lea] = decode([0x64, 0x67, 0x48, 0x8b, 0x44, 0x8b, 0xf0, 0x48, 0x8d, 0x04, 0x8b]).instructions;
  const memory = x86(load).operands[1];
  assert.ok(memory?.kind === 'memory');
  assert.equal(memory.memory.address_bits, 32);
  assert.equal(memory.memory.base?.id, 'x86_64:ebx');
  assert.equal(memory.memory.index?.id, 'x86_64:ecx');
  assert.equal(memory.memory.scale, 4);
  assert.equal(memory.memory.displacement, -16n);
  assert.equal(memory.memory.segment?.id, 'x86_64:fs');
  const address = x86(lea).operands[1];
  assert.ok(address?.kind === 'memory');
  assert.equal(address.memory.access, 'none');
  assert.equal(address.memory.access_bits, 0);
  assert.ok(x86(lea).memory.every((m) => m.access === 'none'));
});

test('EAX zero-extends its root, while AH replaces only bits 8 through 15', () => {
  const [eax, ah, ax] = decode([0xb8, 0x78, 0x56, 0x34, 0x12, 0xb4, 0xab, 0x66, 0xb8, 0x34, 0x12]).instructions;
  const destination = x86(eax).operands[0];
  assert.ok(destination?.kind === 'register');
  assert.equal(destination.register.root, 'x86_64:rax');
  assert.equal(destination.register.width_bits, 32);
  assert.equal(destination.register.write_rule, 'zero_extend_root');
  const high = x86(ah).operands[0];
  assert.ok(high?.kind === 'register');
  assert.equal(high.register.id, 'x86_64:ah');
  assert.equal(high.register.offset_bits, 8);
  assert.equal(high.register.width_bits, 8);
  assert.equal(high.register.write_rule, 'preserve_other_bits');
  assert.equal(x86(ax).operand_bits, 16);
  assert.ok(x86(eax).registers.some((r) => !r.implicit && r.register.id === 'x86_64:eax' && r.register.write_rule === 'zero_extend_root'));
});

test('MUL and DIV expose accumulator/high-half dependencies and undefined flags', () => {
  const [mul, div] = decode([0xf7, 0xe3, 0xf7, 0xf3]).instructions;
  for (const instruction of [mul, div]) {
    const p = x86(instruction);
    assert.ok(p.registers.some((r) => r.implicit && r.register.root === 'x86_64:rax' && r.access.includes('read')));
    assert.ok(p.registers.some((r) => r.implicit && r.register.id === 'x86_64:edx' && r.access.includes('write') && r.register.write_rule === 'zero_extend_root'));
    assert.ok(p.registers.some((r) => !r.implicit && r.register.id === 'x86_64:ebx' && r.access === 'read'));
  }
  assert.equal(x86(mul).flags.written, (1n << 0n) | (1n << 11n));
  assert.equal(x86(mul).flags.undefined, (1n << 2n) | (1n << 4n) | (1n << 6n) | (1n << 7n));
  assert.equal(x86(div).flags.undefined, 0x8d5n);
  assert.ok(x86(div).registers.some((r) => r.implicit && r.register.root === 'x86_64:rdx' && r.access.includes('read')));
});

test('CMOV reads flags, with unconditional 32-bit zero-extension but conditional 64-bit writes', () => {
  const [branch, cmov, cmov64] = decode([0x76, 0xfe, 0x0f, 0x4f, 0xc3, 0x48, 0x0f, 0x4f, 0xc3]).instructions;
  assert.deepEqual(branch?.flow, { kind: 'branch', target: { ...branch!.address, value: 0x1000n }, conditional: true, fallthrough: { ...branch!.address, value: 0x1002n } });
  assert.equal(x86(branch).flags.read, 0x41n);
  assert.equal(x86(branch).flags.written, 0n);
  assert.equal(x86(cmov).flags.read, 0x8c0n);
  const destination = x86(cmov).operands[0];
  assert.ok(destination?.kind === 'register');
  // Intel operation: false CMOV32 still clears DEST[63:32]. https://www.felixcloutier.com/x86/cmovcc#operation
  assert.equal(destination.access, 'read_write');
  assert.equal(destination.register.write_rule, 'zero_extend_root');
  const destination64 = x86(cmov64).operands[0];
  assert.ok(destination64?.kind === 'register');
  assert.equal(destination64.access, 'conditional_write');
});

test('direct/indirect calls, branches, returns and proven UD2 traps have discovery flow', () => {
  const result = decode([0xe8, 0xfb, 0xff, 0xff, 0xff, 0xff, 0xd0, 0xff, 0xe0, 0xc3, 0x0f, 0x0b]);
  assert.deepEqual(result.instructions.map((i) => i.flow.kind), ['call', 'call', 'indirect_branch', 'return', 'trap']);
  const direct = result.instructions[0]!.flow;
  assert.ok(direct.kind === 'call');
  assert.equal(direct.target?.value, 0x1000n);
  assert.equal(direct.indirect, false);
  const indirect = result.instructions[1]!.flow;
  assert.ok(indirect.kind === 'call');
  assert.equal(indirect.target, null);
  assert.equal(indirect.indirect, true);
  assert.ok(x86(result.instructions[0]).memory.some((m) => m.base?.id === 'x86_64:rsp' && m.displacement === -8n && m.access === 'write' && m.access_bits === 64));
});

test('opcode variants and sign-extended immediate widths survive normalization', () => {
  const [short, full] = decode([0x48, 0x83, 0xc0, 0xff, 0x48, 0x05, 0xff, 0xff, 0xff, 0xff]).instructions;
  assert.notEqual(x86(short).encoding, x86(full).encoding);
  const small = x86(short).operands[1];
  const large = x86(full).operands[1];
  assert.ok(small?.kind === 'immediate' && large?.kind === 'immediate');
  assert.equal(small.encoded_bits, 8);
  assert.equal(large.encoded_bits, 32);
  assert.equal(small.effective_bits, 64);
  assert.equal(small.sign_extended, true);
  assert.equal(small.value, 0xffffffffffffffffn);
  assert.equal(large.value, small.value);
});

test('raw duplicate/ignored prefixes and VEX prefix bytes are preserved without confusing REX', () => {
  const [ignored, vector] = decode([0x66, 0x66, 0x40, 0x66, 0x90, 0xc5, 0xf8, 0x57, 0xc0]).instructions;
  assert.deepEqual(x86(ignored).prefixes.bytes, [0x66, 0x66, 0x40, 0x66]);
  assert.equal(x86(ignored).prefixes.rex, null);
  assert.deepEqual(x86(vector).prefixes.bytes, [0xc5, 0xf8]);
  assert.equal(x86(vector).prefixes.encoding, 'vex');
  const dest = x86(vector).operands[0];
  assert.ok(dest?.kind === 'register');
  assert.equal(dest.register.write_rule, 'zero_extend_root');
  assert.equal(dest.register.root, 'x86_64:zmm0');
});

test('FPU condition masks use status-word bits, never synthetic RFLAGS bits', () => {
  const p = x86(decode([0xd8, 0xd1]).instructions[0]); // fcom st(1)
  assert.equal(p.flags.written, 0n);
  assert.equal(p.flags.undefined, 0n);
  assert.ok(p.fpu_flags);
  assert.equal(p.fpu_flags.written, 0x4500n);
  assert.equal(p.fpu_flags.cleared, 0x200n);
});

test('invalid bytes and truncated encodings do not become proven traps or padding', () => {
  const invalid = decode([0xf0, 0x01, 0xc0, 0xc3]); // forbidden LOCK register destination
  assert.equal(invalid.instructions[0]?.validity, 'invalid');
  assert.equal(invalid.instructions[0]?.payload, null);
  assert.equal(invalid.instructions[0]?.flow.kind, 'unknown');
  assert.equal(invalid.gaps.length, 0);
  assert.equal(invalid.coverage.state, 'partial');
  const truncated = decode([0xe8, 0x01, 0x02]);
  assert.equal(truncated.instructions.length, 0);
  assert.equal(truncated.gaps[0]?.reason, 'truncated');
  assert.equal(truncated.gaps[0]?.range.size, 3n);
  const overlong = decode([...Array<number>(15).fill(0x66), 0x90]);
  assert.equal(overlong.instructions[0]?.validity, 'invalid');
});

test('known data, zero-fill, unmapped holes and instruction budgets stay distinct', () => {
  const initial = imageFromBytes(Uint8Array.from([0x90, 0x90, 0xc3]), { mappings: [{ id: 'code', va: 0x1000n, memory_size: 5n, file_offset: 0n, file_size: 3n, permissions: ['execute'] }] });
  const image = { ...initial, hints: [{ kind: 'data' as const, range: region(initial, 0x1001n, 1), encoding: 'bytes' as const, evidence_ids: [] }] };
  const decoder = new X86Decoder({ formatting: false });
  try {
    const result = decoder.decode({ image, regions: [region(image, 0x1000n, 7)], features: [], mode: 'long64' }, operation());
    assert.deepEqual(result.instructions.map((i) => i.address.value), [0x1000n, 0x1002n]);
    assert.deepEqual(result.gaps.map((g) => [g.reason, g.range.size]), [['data', 1n], ['unmapped', 2n], ['unmapped', 2n]]);
    const limited = decoder.decode({ image, regions: [region(image)], features: [], mode: 'long64' }, operation({ budget: { instructions: 1 } }));
    assert.equal(limited.instructions.length, 1);
    assert.ok(limited.gaps.some((g) => g.reason === 'budget'));
  } finally { decoder.dispose(); }
});

test('adjacent virtual mappings decode across disjoint backing using a VA byte reference', () => {
  const image = imageFromBytes(Uint8Array.from([0xe8, 0, 0, 0xcc, 0xcc, 0, 0, 0xc3]), { mappings: [
    { id: 'one', va: 0x1000n, memory_size: 3n, file_offset: 0n, file_size: 3n, permissions: ['execute'] },
    { id: 'two', va: 0x1003n, memory_size: 3n, file_offset: 5n, file_size: 3n, permissions: ['execute'] },
  ] });
  const decoder = new X86Decoder({ formatting: false });
  try {
    const result = decoder.decode({ image, regions: [region(image, 0x1000n, 6)], features: [], mode: 'long64' }, operation());
    assert.equal(result.gaps.length, 0);
    assert.equal(result.instructions[0]?.bytes.start.space, 'va');
    assert.equal(result.instructions[0]?.size, 5);
    assert.equal(result.instructions[1]?.bytes.start.value, 7n);
    assert.equal(result.instructions[1]?.flow.kind, 'return');
  } finally { decoder.dispose(); }
});

test('RVA/file requests normalize to VA and overlapping regions decode once', () => {
  const image = imageFromBytes(Uint8Array.from([0x90, 0xc3]));
  const decoder = new X86Decoder();
  try {
    const result = decoder.decode({ image, regions: [{ start: { image_id: image.id, space: 'rva', value: 0n }, size: 2n }, { start: { image_id: image.id, space: 'file', value: 0n }, size: 2n }], features: [], mode: 'long64' }, operation());
    assert.equal(result.instructions.length, 2);
    assert.equal(result.instructions[0]?.address.space, 'va');
    assert.equal(decoder.format(result.instructions[1]!).mnemonic, 'ret');
    decoder.dispose(); decoder.dispose();
    assert.throws(() => decoder.decode({ image, regions: [], features: [], mode: 'long64' }, operation()), /disposed/);
    assert.throws(() => decoder.format(result.instructions[0]!), /disposed/);
  } finally { decoder.dispose(); }
});

test('long regions retain instruction boundaries across bounded decode windows', () => {
  const bytes = new Uint8Array(65540).fill(0x90);
  bytes.set([0xe8, 0, 0, 0, 0], 65534);
  bytes[65539] = 0xc3;
  const image = imageFromBytes(bytes);
  const decoder = new X86Decoder({ formatting: false });
  try {
    const result = decoder.decode({ image, regions: [region(image)], features: [], mode: 'long64' }, operation({ budget: { instructions: 100000 } }));
    assert.equal(result.gaps.length, 0);
    assert.equal(result.instructions.length, 65536);
    assert.equal(result.instructions.at(-2)?.size, 5);
    assert.equal(result.instructions.at(-1)?.flow.kind, 'return');
  } finally { decoder.dispose(); }
});

test('PE corpus function bytes have actual returns, signed division, direct and indirect calls', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../../fixtures/manifest.json', import.meta.url), 'utf8')) as { codeRanges: { architecture: string; symbol: string; image: string; address: string; fileOffset: number; size: number; path: string }[] };
  const decoder = new X86Decoder();
  try {
    for (const name of ['fixture_arithmetic', 'fixture_maximum', 'fixture_divide', 'fixture_direct', 'fixture_indirect', 'fixture_float', 'fixture_vector', 'fixture_vector_integer']) {
      const fn = manifest.codeRanges.find((entry) => entry.architecture === 'x86_64' && entry.symbol === name)!;
      assert.ok(fn);
      const container = await readFile(new URL(`../../../${fn.image}`, import.meta.url));
      const extracted = await readFile(new URL(`../../../${fn.path}`, import.meta.url));
      assert.deepEqual(container.subarray(fn.fileOffset, fn.fileOffset + fn.size), extracted);
      const image = imageFromBytes(container, { base: BigInt(fn.address), fileOffset: BigInt(fn.fileOffset) });
      const result = decoder.decode({ image, regions: [region(image, BigInt(fn.address), fn.size)], features: [], mode: 'long64' }, operation());
      assert.equal(result.coverage.state, 'complete', name);
      assert.ok(result.instructions.some((i) => i.flow.kind === 'return'), name);
      assert.equal(result.instructions.reduce((sum, i) => sum + i.size, 0), fn.size);
      for (const instruction of result.instructions) assert.equal(instruction.bytes.start.value - BigInt(fn.fileOffset), instruction.address.value - BigInt(fn.address));
      if (name === 'fixture_divide') assert.ok(result.instructions.some((i) => x86(i).mnemonic === 'idiv' && x86(i).registers.some((r) => r.implicit && r.register.root === 'x86_64:rdx')));
      if (name === 'fixture_direct') assert.ok(result.instructions.some((i) => i.flow.kind === 'call' && !i.flow.indirect && i.flow.target !== null));
      if (name === 'fixture_indirect') assert.ok(result.instructions.some((i) => i.flow.kind === 'call' && i.flow.indirect));
      if (name === 'fixture_maximum') assert.ok(result.instructions.some((i) => x86(i).flags.read !== 0n));
    }
  } finally { decoder.dispose(); }
});

test('implied shift-by-one is not confused with an encoded immediate byte', () => {
  const [implied, encoded] = decode([0xd1, 0xe0, 0xc1, 0xe0, 0x01]).instructions;
  const implicitOperand = x86(implied).operands[1];
  const encodedOperand = x86(encoded).operands[1];
  assert.ok(implicitOperand?.kind === 'immediate' && encodedOperand?.kind === 'immediate');
  assert.equal(implicitOperand.value, 1n);
  assert.equal(encodedOperand.value, 1n);
  assert.equal(implicitOperand.encoded_bits, 0);
  assert.equal(encodedOperand.encoded_bits, 8);
  assert.equal(implicitOperand.effective_bits, 8);
  assert.equal(implied?.size, 2);
  assert.equal(encoded?.size, 3);
});

test('EIP-relative accesses wrap at 32 bits while 64-bit branch targets retain high bits', () => {
  const bytes = Uint8Array.from([0x67, 0x48, 0x8b, 0x05, 0xf0, 0xff, 0xff, 0xff, 0xeb, 0xf6]);
  const image = imageFromBytes(bytes, { base: 0x180001000n });
  const decoder = new X86Decoder({ formatting: false });
  try {
    const result = decoder.decode({ image, regions: [region(image)], features: [], mode: 'long64' }, operation());
    const memory = x86(result.instructions[0]).operands[1];
    assert.ok(memory?.kind === 'memory');
    assert.equal(memory.memory.base?.id, 'x86_64:eip');
    assert.equal(memory.memory.rip_relative_target?.value, 0x80000ff8n);
    assert.equal(memory.memory.displacement, -16n);
    const branch = result.instructions[1]!.flow;
    assert.ok(branch.kind === 'branch');
    assert.equal(branch.target.value, 0x180001000n);
  } finally { decoder.dispose(); }
});

test('feature-disabled encodings preserve their structured payload and diagnostics', () => {
  const image = imageFromBytes(Uint8Array.from([0xc5, 0xf8, 0x57, 0xc0]));
  const decoder = new X86Decoder({ formatting: false });
  try {
    const result = decoder.decode({ image, regions: [region(image)], features: ['INTEL8086'], mode: 'long64' }, operation());
    assert.equal(result.instructions[0]?.validity, 'feature_disabled');
    assert.equal(result.instructions[0]?.payload?.architecture, 'x86_64');
    assert.equal(result.instructions[0]?.diagnostics[0]?.code, 'unsupported_target');
    assert.equal(result.coverage.state, 'partial');
  } finally { decoder.dispose(); }
});

test('implicit accumulator and stack effects remain implicit when explicit operands overlap', () => {
  const [mul, push] = decode([0xf7, 0xe0, 0x54]).instructions; // mul eax; push rsp
  const source = x86(mul).operands[0];
  assert.ok(source?.kind === 'register');
  assert.equal(source.register.id, 'x86_64:eax');
  assert.equal(source.access, 'read');
  assert.ok(x86(mul).registers.some((r) => r.implicit && r.register.root === 'x86_64:rax' && r.access.includes('write')));
  assert.ok(x86(push).registers.some((r) => r.implicit && r.register.root === 'x86_64:rsp' && r.access.includes('write')));
});
