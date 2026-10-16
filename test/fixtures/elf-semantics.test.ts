// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ImmutableBytes, contentHash, createOperationContext, imageIdentity } from '../../src/core/index.js';
import { ELFLoader } from '../../src/loaders/elf/index.js';
import { X86Decoder } from '../../src/decoders/x86_64/index.js';
import { X86Lifter } from '../../src/lifters/x86_64/index.js';
import { gpr } from '../../src/lifters/x86_64/semantics.js';
import { discoverFunctions } from '../../src/analysis/discovery/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { bitsFloat, evaluateIR, floatBits, verifyIR, type MemoryRegion, type TrustedCall } from '../../src/ir/index.js';
import { machineRegisters, register } from '../lifters/x86_64/helpers.js';
import { inspectELF } from '../../scripts/fixtures/inspect-elf.js';
import { expectedSchema } from './oracle.js';
const bytes = readFileSync('fixtures/bin/libcorpus-elf-x86_64-symbols.so'), sha256 = contentHash(bytes);
const image = new ELFLoader().load({ image_id: imageIdentity(sha256), sha256, bytes: new ImmutableBytes(bytes), slice_id: null }, createOperationContext());
const decoder = new X86Decoder({ formatting: false });
const graphs = (() => {
  try { return discoverFunctions({ image, decoder, revision: 0 }, createOperationContext()).graphs; }
  finally { decoder.dispose(); }
})();
const facts = inspectELF(bytes);
const entries = Object.fromEntries(facts.functions.map(fn => [fn.name, BigInt(fn.address)]));
const expected = expectedSchema.parse(JSON.parse(readFileSync('fixtures/expected.json', 'utf8')));
const integerRegisters = ['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9'];
const mapped: MemoryRegion[] = image.mappings.filter(mapping => mapping.file_size > 0n).map(mapping => ({ base: mapping.va, bytes: image.bytes.read(mapping.file_offset!, Number(mapping.file_size)), writable: false }));

for (const fixture of expected.cases) test(`ELF/SysV decoded IR ${fixture.function} ${JSON.stringify(fixture.arguments)}`, () => {
  const graph = graphs.find(graph => graph.function.entry.value === entries[fixture.function]);
  assert.ok(graph, fixture.function);
  const lifted = new X86Lifter().lift(graph, sysvAMD64Abi, createOperationContext());
  assert.deepEqual(verifyIR(lifted.ir), []);
  const supplied: Record<string, bigint> = {};
  const data = new Uint8Array(256), view = new DataView(data.buffer);
  const stack = new Uint8Array(4096), stackView = new DataView(stack.buffer), sp = 0x30000808n;
  const args = fixture.arguments;
  let width = 32;
  if (fixture.family === 'vector-float' || fixture.family === 'vector-integer') {
    for (let side = 0; side < 2; side++) for (let lane = 0; lane < 4; lane++) {
      const value = (args[side] as string[])[lane]!;
      if (fixture.family === 'vector-float') view.setFloat32(side * 32 + lane * 4, Number(value), true);
      else view.setUint32(side * 32 + lane * 4, Number(value), true);
    }
    Object.assign(supplied, { rdi: 0x20000040n, rsi: 0x20000000n, rdx: 0x20000020n });
  } else if (fixture.function === 'fixture_loop') {
    (args[0] as string[]).forEach((value, i) => view.setUint32(i * 4, Number(value), true));
    Object.assign(supplied, { rdi: 0x20000000n, rsi: BigInt(args[1] as string) });
  } else if (fixture.function === 'fixture_memory') {
    view.setBigUint64(0, BigInt(args[0] as string), true);
    Object.assign(supplied, { rdi: 0x20000000n, rsi: BigInt(args[1] as string) }); width = 64;
  } else if (fixture.function === 'fixture_float') {
    Object.assign(supplied, { zmm0: floatBits(Number(args[0]), 64), zmm1: floatBits(Number(args[1]), 64) });
  } else if (fixture.function === 'fixture_variadic') {
    supplied.rdi = BigInt(args[0] as string); supplied.rax = BigInt(args.length - 1);
    for (let i = 1; i < args.length; i++) supplied[`zmm${i - 1}`] = floatBits(Number(args[i]), 64);
  } else if (fixture.function === 'fixture_indirect') {
    Object.assign(supplied, { rdi: entries.fixture_stack, rsi: BigInt(args[1] as string) });
  } else {
    for (let i = 0; i < Math.min(6, args.length); i++) supplied[integerRegisters[i]!] = BigInt(args[i] as string);
    if (fixture.function === 'fixture_stack_args') {
      for (let i = 6; i < args.length; i++) stackView.setBigUint64(Number(sp - 0x30000000n) + 8 + (i - 6) * 8, BigInt(args[i] as string), true);
      width = 64;
    }
    if (fixture.function === 'fixture_width' || fixture.function === 'fixture_string') width = 64;
  }
  const registers = machineRegisters(lifted.ir);
  for (const [name, value] of Object.entries(supplied)) {
    assert.ok(registers.has(`x86_64:${name}`), `Compiler reads supplied ${name}`);
    registers.set(`x86_64:${name}`, value);
  }
  if (registers.has('x86_64:rsp')) registers.set('x86_64:rsp', sp);
  const calls = new Map<string, TrustedCall>();
  for (const block of lifted.ir.blocks) for (const instruction of block.instructions) if (instruction.kind === 'call') {
    calls.set(instruction.id, input => {
      const a = input.readRegister(gpr('rdi'));
      let result: bigint;
      if (input.target === entries.fixture_stack) result = BigInt.asUintN(32, a + 7n);
      else if (input.target === entries.fixture_arithmetic) result = BigInt.asUintN(32, a + input.readRegister(gpr('rsi')) * 3n) ^ 0x55n;
      else throw new Error(`No trusted source contract for target ${input.target}`);
      return { results: [], writes: [], register_writes: [{ register: gpr('rax'), bits: result }] };
    });
  }
  const result = evaluateIR(lifted.ir, { registers, memory: [...mapped, { base: 0x20000000n, bytes: data, writable: true }, { base: 0x30000000n, bytes: stack, writable: true }], calls });
  assert.equal(result.status, 'returned', result.reason ?? undefined);
  if (fixture.family === 'vector-float' || fixture.family === 'vector-integer') {
    const output = result.memory.find(region => region.base === 0x20000000n)!;
    const values = new DataView(output.bytes.buffer, output.bytes.byteOffset, output.bytes.byteLength);
    assert.deepEqual(Array.from({ length: 4 }, (_, lane) => fixture.family === 'vector-float' ? values.getFloat32(64 + lane * 4, true) : values.getUint32(64 + lane * 4, true)), (fixture.result as string[]).map(Number));
  } else if (fixture.function === 'fixture_float' || fixture.function === 'fixture_variadic') assert.equal(bitsFloat(register(result, 'zmm0', 64), 64), Number(fixture.result));
  else if (fixture.function === 'fixture_string') {
    const pointer = register(result, 'rax'), region = result.memory.find(region => pointer >= region.base && pointer < region.base + BigInt(region.bytes.length));
    assert.ok(region);
    const offset = Number(pointer - region.base);
    assert.equal(Buffer.from(region.bytes.subarray(offset, offset + (fixture.result as string).length)).toString(), fixture.result);
  } else assert.equal(register(result, 'rax', width), BigInt.asUintN(width, BigInt(fixture.result as string)));
  if (fixture.memoryAfter !== undefined) {
    const output = result.memory.find(region => region.base === 0x20000000n)!;
    assert.equal(new DataView(output.bytes.buffer, output.bytes.byteOffset, output.bytes.byteLength).getBigUint64(0, true), BigInt(fixture.memoryAfter));
  }
});
