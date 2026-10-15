import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { RegisterDescriptor } from '../../../src/core/index.js';
import { bitsFloat, floatBits, verifyIR } from '../../../src/ir/index.js';
import type { MemoryRegion, RegisterIR, TrustedCall } from '../../../src/ir/index.js';
import { gpr } from '../../../src/lifters/x86_64/semantics.js';
import { loadCorpus, register, run } from './helpers.js';

const entries: Record<string, bigint> = {
  fixture_stack: 0x180001000n, fixture_arithmetic: 0x180001030n, fixture_maximum: 0x180001040n,
  fixture_loop: 0x180001050n, fixture_memory: 0x180001070n, fixture_direct: 0x180001080n,
  fixture_indirect: 0x1800010b0n, fixture_divide: 0x1800010d0n, fixture_width: 0x1800010e0n,
  fixture_stack_args: 0x1800010f0n, fixture_float: 0x180001150n, fixture_vector: 0x180001170n,
  fixture_vector_integer: 0x180001190n, fixture_variadic: 0x1800011b0n, fixture_string: 0x180001200n, fixture_check: 0x180001210n,
};
const corpus = loadCorpus();
const mapped: MemoryRegion[] = corpus.image.mappings.filter(mapping => mapping.file_size > 0n).map(mapping => ({ base: mapping.va, bytes: corpus.image.bytes.read(mapping.file_offset!, Number(mapping.file_size)), writable: false }));
const expected = JSON.parse(readFileSync('fixtures/expected.json', 'utf8')) as { cases: { function: string; family: string; arguments: (string | string[])[]; result: string | string[]; memoryAfter?: string }[] };

function callOracles(ir: RegisterIR): Map<string, TrustedCall> {
  const calls = new Map<string, TrustedCall>();
  for (const block of ir.blocks) for (const instruction of block.instructions) if (instruction.kind === 'call') {
    assert.deepEqual(instruction.arguments, []); assert.deepEqual(instruction.results, []);
    calls.set(instruction.id, input => {
      const target = input.target;
      // These independent test-owned C semantics consume physical state, not a
      // fabricated production prototype. Each oracle is keyed by its call node.
      const read = (name: string) => input.readRegister(gpr(name));
      const xmm = (index: number): RegisterDescriptor => ({ id: `x86_64:xmm${index}`, root: `x86_64:zmm${index}`, bank: 'vector', offset_bits: 0, width_bits: 128, root_width_bits: 512, role: 'general', write_rule: 'preserve_other_bits' });
      const writes: { address: bigint; width: number; bits: bigint }[] = [];
      let result = 0n, resultRegister = gpr('rax');
      if (target === entries.fixture_stack) result = BigInt.asUintN(32, read('rcx') + 7n);
      else if (target === entries.fixture_arithmetic) result = BigInt.asUintN(32, read('rcx') + read('rdx') * 3n) ^ 0x55n;
      else if (target === entries.fixture_maximum) {
        const left = BigInt.asIntN(32, read('rcx')), right = BigInt.asIntN(32, read('rdx'));
        result = BigInt.asUintN(32, left > right ? left : right);
      } else if (target === entries.fixture_loop) {
        const count = Number(read('rdx')), pointer = read('rcx'); assert.ok(count <= 100);
        for (let i = 0; i < count; i++) result = BigInt.asUintN(32, result + input.readMemory(pointer + BigInt(i * 4), 32));
      } else if (target === entries.fixture_memory) {
        const pointer = read('rcx'); result = BigInt.asUintN(64, input.readMemory(pointer, 64) + read('rdx')); writes.push({ address: pointer, width: 64, bits: result });
      } else if (target === entries.fixture_direct) {
        const value = read('rcx'); result = BigInt.asUintN(32, value + 7n + (BigInt.asUintN(32, value + 6n) ^ 0x55n));
      } else if (target === entries.fixture_indirect) {
        assert.equal(read('rcx'), entries.fixture_stack); result = BigInt.asUintN(32, read('rdx') + 8n);
      } else if (target === entries.fixture_divide) result = BigInt.asUintN(32, BigInt.asIntN(32, read('rcx')) / BigInt.asIntN(32, read('rdx')));
      else if (target === entries.fixture_width) result = (BigInt.asUintN(32, read('rcx')) + BigInt.asUintN(32, read('rdx'))) >> (read('r8') & 63n);
      else if (target === entries.fixture_stack_args) {
        for (let i = 0; i < 10; i++) result += BigInt(i + 1) * (i < 4 ? read(['rcx', 'rdx', 'r8', 'r9'][i]!) : input.readMemory(read('rsp') + 40n + BigInt((i - 4) * 8), 64));
      } else if (target === entries.fixture_float) {
        resultRegister = xmm(0); result = floatBits(bitsFloat(input.readRegister(xmm(0)), 64) * 1.5 + bitsFloat(input.readRegister(xmm(1)), 64) * 0.5, 64);
      } else if (target === entries.fixture_vector || target === entries.fixture_vector_integer) {
        const out = read('rcx'), left = read('rdx'), right = read('r8');
        for (let i = 0; i < 4; i++) {
          const offset = BigInt(i * 4), a = input.readMemory(left + offset, 32), b = input.readMemory(right + offset, 32);
          const bits = target === entries.fixture_vector ? floatBits(Math.fround(bitsFloat(a, 32) * 2) + bitsFloat(b, 32), 32) : BigInt.asUintN(32, a + b) ^ 0x55n;
          writes.push({ address: out + offset, width: 32, bits });
        }
      } else if (target === entries.fixture_variadic) {
        const count = Number(read('rcx')); assert.ok(count <= 3); let sum = 0;
        for (let i = 0; i < count; i++) sum += bitsFloat(read(['rdx', 'r8', 'r9'][i]!), 64);
        resultRegister = xmm(0); result = floatBits(sum, 64);
      } else if (target === entries.fixture_string) result = 0x180002000n;
      else throw new Error(`Unexpected trusted call target ${target.toString(16)}`);
      return { results: [], writes, register_writes: [{ register: resultRegister, bits: result }] };
    });
  }
  return calls;
}

for (const fixture of expected.cases) test(`PE corpus ${fixture.function} ${JSON.stringify(fixture.arguments)}`, () => {
  const lifted = corpus.lifted.get(entries[fixture.function]!); assert.ok(lifted);
  assert.deepEqual(verifyIR(lifted.ir), []);
  const state: Record<string, bigint> = {}, memory: MemoryRegion[] = [...mapped];
  const data = new Uint8Array(0x100), view = new DataView(data.buffer);
  const args = fixture.arguments;
  let outputWidth = 32;
  if (fixture.family === 'vector-float' || fixture.family === 'vector-integer') {
    for (let side = 0; side < 2; side++) for (let lane = 0; lane < 4; lane++) {
      const value = (args[side] as string[])[lane]!;
      if (fixture.family === 'vector-float') view.setFloat32(side * 32 + lane * 4, Number(value), true);
      else view.setUint32(side * 32 + lane * 4, Number(value), true);
    }
    Object.assign(state, { rcx: 0x2040n, rdx: 0x2000n, r8: 0x2020n });
  } else if (fixture.function === 'fixture_loop') {
    (args[0] as string[]).forEach((value, lane) => view.setUint32(lane * 4, Number(value), true));
    Object.assign(state, { rcx: 0x2000n, rdx: BigInt(args[1] as string) });
  } else if (fixture.function === 'fixture_memory') {
    view.setBigUint64(0, BigInt(args[0] as string), true); Object.assign(state, { rcx: 0x2000n, rdx: BigInt(args[1] as string) }); outputWidth = 64;
  } else if (fixture.function === 'fixture_float') {
    Object.assign(state, { zmm0: floatBits(Number(args[0]), 64), zmm1: floatBits(Number(args[1]), 64) });
  } else if (fixture.function === 'fixture_variadic') {
    Object.assign(state, { rcx: BigInt(args[0] as string), rdx: floatBits(Number(args[1]), 64), r8: floatBits(Number(args[2]), 64), r9: floatBits(Number(args[3]), 64) });
  } else if (fixture.function === 'fixture_indirect') Object.assign(state, { rcx: entries.fixture_stack, rdx: BigInt(args[1] as string) });
  else if (fixture.function === 'fixture_stack_args') {
    for (let i = 0; i < 4; i++) state[['rcx', 'rdx', 'r8', 'r9'][i]!] = BigInt(args[i] as string);
    // Existing helper supplies a disjoint default stack. Override its contents
    // through the dedicated stack fixture below, not overlapping memory regions.
    outputWidth = 64;
  } else {
    for (let i = 0; i < Math.min(4, args.length); i++) state[['rcx', 'rdx', 'r8', 'r9'][i]!] = BigInt(args[i] as string);
    if (fixture.function === 'fixture_width' || fixture.function === 'fixture_string') outputWidth = 64;
  }
  memory.push({ base: 0x2000n, bytes: data, writable: true });
  if (fixture.function === 'fixture_stack_args') {
    const stack = new Uint8Array(0x200), stackView = new DataView(stack.buffer);
    for (let i = 4; i < args.length; i++) stackView.setBigUint64(40 + (i - 4) * 8, BigInt(args[i] as string), true);
    state.rsp = 0xb008n;
    memory.push({ base: 0xb008n, bytes: stack, writable: true }, { base: 0xaf00n, bytes: new Uint8Array(0x108), writable: true });
  }
  const result = run(lifted.ir, state, { memory, calls: callOracles(lifted.ir) });
  assert.equal(result.status, 'returned', result.reason ?? 'Unexpected boundary');
  if (fixture.family === 'vector-float' || fixture.family === 'vector-integer') {
    const output = result.memory.find(region => region.base === 0x2000n)!;
    const values = new DataView(output.bytes.buffer, output.bytes.byteOffset, output.bytes.byteLength);
    assert.deepEqual(Array.from({ length: 4 }, (_, lane) => fixture.family === 'vector-float' ? values.getFloat32(64 + lane * 4, true) : values.getUint32(64 + lane * 4, true)), (fixture.result as string[]).map(Number));
  } else if (fixture.function === 'fixture_float' || fixture.function === 'fixture_variadic') assert.equal(bitsFloat(register(result, 'zmm0', 64), 64), Number(fixture.result));
  else if (fixture.function === 'fixture_string') {
    const pointer = register(result, 'rax'), region = result.memory.find(region => pointer >= region.base && pointer < region.base + BigInt(region.bytes.length)); assert.ok(region);
    const offset = Number(pointer - region.base); assert.equal(Buffer.from(region.bytes.subarray(offset, offset + (fixture.result as string).length)).toString(), fixture.result);
  } else assert.equal(register(result, 'rax', outputWidth), BigInt.asUintN(outputWidth, BigInt(fixture.result as string)));
  if (fixture.memoryAfter !== undefined) {
    const output = result.memory.find(region => region.base === 0x2000n)!;
    assert.equal(new DataView(output.bytes.buffer, output.bytes.byteOffset, output.bytes.byteLength).getBigUint64(0, true), BigInt(fixture.memoryAfter));
  }
});

test('every agreed corpus function, including fixture_check, has actual semantics', () => {
  for (const [name, address] of Object.entries(entries)) {
    const lifted = corpus.lifted.get(address); assert.ok(lifted, name);
    assert.deepEqual(verifyIR(lifted.ir), [], name);
    assert.ok(lifted.ir.blocks.every(block => block.instructions.every(instruction => instruction.kind !== 'unknown_effect')), name);
    assert.equal(lifted.coverage.completed_units, lifted.coverage.total_units, name);
  }
});

test('full fixture_check follows all trusted success paths through decoded caller IR', () => {
  const lifted = corpus.lifted.get(entries.fixture_check!); assert.ok(lifted);
  const result = run(lifted.ir, {}, { memory: mapped, calls: callOracles(lifted.ir), max_steps: 100_000 });
  assert.equal(register(result, 'rax', 32), 0n);
  assert.equal(register(result, 'rsp'), 0x8810n);
});
