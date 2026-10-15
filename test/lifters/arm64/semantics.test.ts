import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, type FunctionGraph } from '../../../src/core/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { Arm64Lifter } from '../../../src/lifters/arm64/index.js';
import { OracleMemory, evaluateIR, verifyIR, type TrustedCall } from '../../../src/ir/index.js';
import { data, evaluate, floatBits, fromWords, initialRegisters, lift, machineRegister, registerBits, stack } from './support.js';

const ret = 0xd65f03c0;
const inputs = (a: bigint, b: bigint): Map<string, bigint> => new Map([['arm64:x0', a], ['arm64:x1', b]]);

test('ADDS/SUBS/ADCS/SBCS preserve carry, borrow, overflow and W zero extension', () => {
  for (const bits of [32, 64]) {
    const limit = 1n << BigInt(bits), sign = limit >> 1n;
    const values = [0n, 1n, sign - 1n, sign, limit - 1n, 0x12345678n];
    for (const [word, subtract, withCarry] of [[0xab010000, false, false], [0xeb010000, true, false], [0xba010000, false, true], [0xfa010000, true, true]] as const) {
      const ir = lift(fromWords([bits === 32 ? word - 0x80000000 : word, ret])).ir;
      for (const a of values) for (const b of values) for (const oldCarry of [0n, 1n]) {
        const state = inputs(a | (bits === 32 ? 0xdeadbeef00000000n : 0n), b);
        if (withCarry) state.set('arm64:nzcv', oldCarry << 29n);
        const carry = withCarry ? subtract ? 1n - oldCarry : oldCarry : 0n;
        const mathematical = subtract ? a - b - carry : a + b + carry;
        const signed = subtract ? BigInt.asIntN(bits, a) - BigInt.asIntN(bits, b) - carry : BigInt.asIntN(bits, a) + BigInt.asIntN(bits, b) + carry;
        const expected = BigInt.asUintN(bits, mathematical);
        const n = expected >= sign, z = expected === 0n, c = subtract ? mathematical >= 0n : mathematical >= limit, v = signed < -sign || signed >= sign;
        const flags = (BigInt(n) << 31n) | (BigInt(z) << 30n) | (BigInt(c) << 29n) | (BigInt(v) << 28n);
        const result = evaluate(ir, state);
        assert.equal(registerBits(result), expected);
        assert.equal(registerBits(result, 'arm64:nzcv', 32), flags);
      }
    }
  }
});

test('signed/unsigned division encode zero and MIN/-1 architectural results', () => {
  for (const bits of [32, 64]) for (const signed of [false, true]) {
    const word = (bits === 64 ? 0x9ac10800 : 0x1ac10800) + (signed ? 0x400 : 0);
    const ir = lift(fromWords([word, ret])).ir;
    const values = [0n, 1n, -1n, -13n, 5n, -(1n << BigInt(bits - 1))];
    for (const a of values) for (const b of values) {
      const left = signed ? BigInt.asIntN(bits, a) : BigInt.asUintN(bits, a), right = signed ? BigInt.asIntN(bits, b) : BigInt.asUintN(bits, b);
      const expected = right === 0n ? 0n : BigInt.asUintN(bits, left / right);
      assert.equal(registerBits(evaluate(ir, inputs(a, b))), expected);
    }
  }
});

test('variable shifts mask counts and arithmetic shifts sign extend', () => {
  for (const bits of [32, 64]) for (const [offset, op] of [[0, 'lsl'], [0x400, 'lsr'], [0x800, 'asr'], [0xc00, 'ror']] as const) {
    const ir = lift(fromWords([(bits === 64 ? 0x9ac12000 : 0x1ac12000) + offset, ret])).ir;
    const value = BigInt.asUintN(bits, -0x1234567n);
    for (const count of [0, 1, bits - 1, bits, bits + 1, 255]) {
      const n = BigInt(count & (bits - 1));
      const expected = op === 'lsl' ? value << n : op === 'lsr' ? value >> n : op === 'asr' ? BigInt.asIntN(bits, value) >> n : (value >> n) | (value << (BigInt(bits) - n));
      assert.equal(registerBits(evaluate(ir, inputs(value, BigInt(count)))), BigInt.asUintN(bits, expected));
    }
  }
});

test('all NZCV conditions including AL and NV implement architectural selection', () => {
  for (let condition = 0; condition < 16; condition++) {
    const ir = lift(fromWords([0x9a820020 | (condition << 12), ret])).ir;
    for (let flags = 0; flags < 16; flags++) {
      const n = !!(flags & 8), z = !!(flags & 4), c = !!(flags & 2), v = !!(flags & 1);
      const expected = [z, !z, c, !c, n, !n, v, !v, c && !z, !c || z, n === v, n !== v, !z && n === v, z || n !== v, true, true][condition];
      const result = evaluate(ir, new Map([['arm64:x1', 17n], ['arm64:x2', 31n], ['arm64:nzcv', BigInt(flags) << 28n]]));
      assert.equal(registerBits(result), expected ? 17n : 31n);
    }
  }
});

test('SP and ZR differ, W writes clear upper X bits and WSP writes clear upper SP bits', () => {
  const zr = lift(fromWords([0x2a1f03e0, ret])).ir;
  assert.equal(registerBits(evaluate(zr, new Map([['arm64:x0', -1n]]))), 0n);
  const sp = lift(fromWords([0x910043ff, 0x910003e0, ret])).ir;
  assert.equal(registerBits(evaluate(sp)), stack + 16n);
  const wsp = lift(fromWords([0x110003ff, 0x910003e0, ret])).ir;
  assert.equal(registerBits(evaluate(wsp)), BigInt.asUintN(32, stack));
  const discard = lift(fromWords([0x8b01001f, 0xaa0103e0, ret])).ir;
  assert.equal(registerBits(evaluate(discard, inputs(10n, 37n))), 37n);
});

test('ordinary memory sign extension, pre/post writeback and pair snapshots', () => {
  const memory = new OracleMemory([{ base: data, bytes: new Uint8Array(128), writable: true }]);
  memory.write(data, 64, 0x80000000n); memory.write(data + 8n, 64, 0x123456789n);
  const post = lift(fromWords([0xf8408420, ret])).ir; // ldr x0,[x1],#8
  const result = evaluate(post, new Map([['arm64:x1', data]]), { memory: memory.snapshot() });
  assert.equal(registerBits(result), 0x80000000n); assert.equal(registerBits(result, 'arm64:x1'), data + 8n);
  const pre = lift(fromWords([0xf8008c20, ret])).ir; // str x0,[x1,#8]!
  const stored = evaluate(pre, inputs(99n, data), { memory: memory.snapshot() });
  assert.equal(new OracleMemory(stored.memory).read(data + 8n, 64), 99n); assert.equal(registerBits(stored, 'arm64:x1'), data + 8n);
  const pair = lift(fromWords([0xa8c10820, ret])).ir; // ldp x0,x2,[x1],#16
  const paired = evaluate(pair, new Map([['arm64:x1', data]]), { memory: memory.snapshot() });
  assert.equal(registerBits(paired), 0x80000000n); assert.equal(registerBits(paired, 'arm64:x2'), 0x123456789n); assert.equal(registerBits(paired, 'arm64:x1'), data + 16n);
  const signed = lift(fromWords([0xb9800020, ret])).ir; // ldrsw x0,[x1]
  assert.equal(registerBits(evaluate(signed, new Map([['arm64:x1', data]]), { memory: memory.snapshot() })), 0xffffffff80000000n);
});

test('constrained-unpredictable memory overlap and unsupported system operations stay unknown, not traps', () => {
  for (const word of [0xf8408400, 0xf8008c00, 0xa9400020, 0xd5033bbf, 0xffffffff]) {
    const result = lift(fromWords([word, ret]));
    assert.equal(result.coverage.state, 'partial');
    assert.ok(result.ir.blocks.some(block => block.instructions.some(node => node.kind === 'unknown_effect')));
    assert.ok(result.ir.blocks.every(block => block.terminator.kind !== 'trap'));
    assert.equal(evaluate(result.ir).status, 'unknown');
  }
});

test('multiply-high and reverse preserve all 64 bits', () => {
  for (const [word, signed] of [[0x9bc17c00, false], [0x9b417c00, true]] as const) {
    const ir = lift(fromWords([word, ret])).ir;
    for (const a of [0n, 1n, -1n, 0x8000000000000000n, 0x123456789abcdefn]) for (const b of [-1n, 2n, 0xfedcba9876543210n]) {
      const left = signed ? BigInt.asIntN(64, a) : BigInt.asUintN(64, a), right = signed ? BigInt.asIntN(64, b) : BigInt.asUintN(64, b);
      assert.equal(registerBits(evaluate(ir, inputs(a, b))), BigInt.asUintN(64, (left * right) >> 64n));
    }
  }
  const value = 0x0123456789abcdefn;
  assert.equal(registerBits(evaluate(lift(fromWords([0xdac00c00, ret])).ir, new Map([['arm64:x0', value]]))), 0xefcdab8967452301n);
  const reversed = BigInt(`0b${value.toString(2).padStart(64, '0').split('').reverse().join('')}`);
  assert.equal(registerBits(evaluate(lift(fromWords([0xdac00000, ret])).ir, new Map([['arm64:x0', value]]))), reversed);
});

test('indirect/authenticated calls capture the old LR target before writing the new LR', () => {
  for (const word of [0xd63f03c0, 0xd73f0bc1]) {
    const lifted = lift(fromWords([word, ret])), ir = lifted.ir;
    const calls = ir.blocks.flatMap(block => block.instructions).filter(node => node.kind === 'call');
    assert.equal(calls.length, 1); assert.deepEqual(calls[0]!.arguments, []); assert.deepEqual(calls[0]!.results, []);
    const oracle: TrustedCall = input => {
      assert.equal(input.target, 0x12340000n);
      assert.equal(input.readRegister(machineRegister(30)), 0x1004n);
      return { results: [], writes: [], register_writes: [{ register: machineRegister(0), bits: 77n }] };
    };
    const result = evaluate(ir, new Map([['arm64:x30', 0x12340000n]]), { calls: new Map([[calls[0]!.id, oracle]]) });
    assert.equal(registerBits(result), 77n);
    if (word === 0xd73f0bc1) assert.ok(lifted.diagnostics.some(d => d.message.includes('authentication')));
    assert.equal(evaluate(ir, new Map([['arm64:x30', 0x12340000n]])).status, 'unknown');
  }
});

test('pointer authentication preserves logical pointers and explicitly disclaims hardware checks', () => {
  const lifted = lift(fromWords([0xd503233f, 0xd50323bf, 0xd65f0bff]));
  assert.equal(registerBits(evaluate(lifted.ir, new Map([['arm64:x30', 0x12340000n]])), 'arm64:x30'), 0x12340000n);
  assert.equal(lifted.coverage.state, 'partial');
  assert.ok(lifted.diagnostics.every(d => d.message.includes('authentication')));
  for (const word of [0xd61f0000, 0xd71f0801, 0xd65f0000]) {
    const result = lift(fromWords([word]));
    assert.ok(result.ir.blocks.some(block => block.terminator.kind === 'indirect'));
    assert.equal(evaluate(result.ir, new Map([['arm64:x0', 0x12340000n]])).status, 'unknown');
  }
});

test('FPCR guards reject rounding, flush and exception modes without poisoning subsequent supported arithmetic', () => {
  const lifted = lift(fromWords([0x1e612800, 0x1e612800, ret])); // fadd d0,d0,d1 twice
  const values = new Map([['arm64:v0', floatBits(1.5, 64)], ['arm64:v1', floatBits(2.5, 64)]]);
  assert.equal(registerBits(evaluate(lifted.ir, values), 'arm64:v0', 64), floatBits(6.5, 64));
  for (const control of [1n << 22n, 1n << 24n, 1n << 19n, 1n << 8n, 1n]) {
    assert.equal(evaluate(lifted.ir, new Map([...values, ['arm64:fpcr', control]])).status, 'unknown');
  }
  const result = evaluate(lifted.ir, values);
  assert.equal(result.registers.get('arm64:fpsr')!.known, 0n);
  assert.equal(result.registers.get('arm64:fpcr')!.bits, 0n);
  assert.equal(lifted.coverage.state, 'partial');
  const nan = evaluate(lifted.ir, new Map([['arm64:v0', 0x7ff0000000000001n], ['arm64:v1', floatBits(1, 64)]]));
  assert.equal(registerBits(nan, 'arm64:v0', 64), 0x7ff8000000000000n);
});

test('FP comparison flags represent ordered/unordered results and MOV preserves NaN payload bits', () => {
  const compare = lift(fromWords([0x1e612000, ret])).ir;
  for (const [a, b, flags] of [[-1, 2, 8], [2, 2, 6], [3, 2, 2], [NaN, 2, 3]] as const) {
    const result = evaluate(compare, new Map([['arm64:v0', floatBits(a, 64)], ['arm64:v1', floatBits(b, 64)]]));
    assert.equal(registerBits(result, 'arm64:nzcv', 32), BigInt(flags) << 28n);
  }
  const move = lift(fromWords([0x1e604020, ret])).ir; // fmov d0,d1
  const payload = 0xfff0000000000123n;
  assert.equal(registerBits(evaluate(move, new Map([['arm64:v1', payload]])), 'arm64:v0', 64), payload);
});

test('noncontiguous discovery blocks and split-backed provenance survive lifting', () => {
  const original = fromWords([0x14000002, 0xd503201f, 0x528000e0, ret]);
  assert.equal(original.instructions.some(instruction => instruction.address.value === 0x1004n), false);
  const instructions = original.instructions.map(instruction => instruction.address.value === 0x1008n ? { ...instruction, bytes: { start: instruction.address, size: 4n } } : instruction);
  const graph: FunctionGraph = { ...original, instructions };
  const result = lift(graph);
  assert.equal(registerBits(evaluate(result.ir)), 7n);
  assert.deepEqual(verifyIR(result.ir), []);
  const split = instructions.find(instruction => instruction.address.value === 0x1008n)!;
  const sourceNodes = result.ir.blocks.flatMap(block => block.instructions).filter(node => node.provenance.instruction_ids.includes(split.id));
  assert.ok(sourceNodes.length > 0); assert.ok(sourceNodes.every(node => node.provenance.ranges.some(range => range.start.space === 'va' && range.start.value === 0x1008n)));
});

test('decode gaps, cancellation and explicit work limits remain visible', () => {
  const graph = fromWords([0xd503201f]);
  const result = lift(graph);
  assert.equal(result.coverage.state, 'partial'); assert.equal(evaluate(result.ir).status, 'unknown');
  const controller = new AbortController(); controller.abort();
  assert.throws(() => new Arm64Lifter().lift(graph, new DarwinArm64Abi(), createOperationContext({ signal: controller.signal })));
  assert.throws(() => new Arm64Lifter().lift(fromWords([0x528000e0, ret]), new DarwinArm64Abi(), createOperationContext({ budget: { ir_nodes: 1 } })), /node limit/);
  const program = lift(fromWords([0x528000e0, ret])).ir;
  const withoutRegisters = evaluateIR(program, { registers: initialRegisters(program) });
  assert.equal(registerBits(withoutRegisters), 7n);
});

test('bitfields, extracts, MOVK and signed extended operands use canonical fields', () => {
  const value = 0x123456789abcde80n;
  assert.equal(registerBits(evaluate(lift(fromWords([0xd3483c20, ret])).ir, new Map([['arm64:x1', value]]))), 0xden);
  assert.equal(registerBits(evaluate(lift(fromWords([0x93401c20, ret])).ir, new Map([['arm64:x1', value]]))), 0xffffffffffffff80n);
  const inserted = evaluate(lift(fromWords([0xb3781c20, ret])).ir, inputs(0x1122334455667788n, 0xaan));
  assert.equal(registerBits(inserted), 0x112233445566aa88n);
  const high = 0xfedcba9876543210n, low = 0x123456789abcdefn;
  const extracted = evaluate(lift(fromWords([0x93c23420, ret])).ir, new Map([['arm64:x1', high], ['arm64:x2', low]]));
  assert.equal(registerBits(extracted), BigInt.asUintN(64, ((high << 64n) | low) >> 13n));
  assert.equal(registerBits(evaluate(lift(fromWords([0x72a24680, ret])).ir, new Map([['arm64:x0', 0xffffffffffffabcdn]]))), 0x1234abcdn);
  const extended = evaluate(lift(fromWords([0x8b228c20, ret])).ir, new Map([['arm64:x1', 1024n], ['arm64:x2', 0x80n]]));
  assert.equal(registerBits(extended), 0n);
});

test('conditional compare snapshots the old condition before writing replacement flags', () => {
  const ir = lift(fromWords([0xfa410005, ret])).ir;
  const unequal = evaluate(ir, new Map([['arm64:x0', 10n], ['arm64:x1', 10n], ['arm64:nzcv', 0n]]));
  assert.equal(registerBits(unequal, 'arm64:nzcv', 32), 5n << 28n);
  const equal = evaluate(ir, new Map([['arm64:x0', 10n], ['arm64:x1', 10n], ['arm64:nzcv', 1n << 30n]]));
  assert.equal(registerBits(equal, 'arm64:nzcv', 32), 6n << 28n);
});

test('authenticated loads retain memory effects and logical-pointer diagnostics', () => {
  const lifted = lift(fromWords([0xf8200400, ret]));
  const memory = new OracleMemory([{ base: data, bytes: new Uint8Array(16), writable: true }]);
  memory.write(data, 64, 123n);
  assert.equal(registerBits(evaluate(lifted.ir, new Map([['arm64:x0', data]]), { memory: memory.snapshot() })), 123n);
  assert.ok(lifted.diagnostics.some(diagnostic => diagnostic.message.includes('authentication')));
});

test('FP/GPR bit moves and precision conversions work with field-only decoder operands', () => {
  const toFloat = lift(fromWords([0x1e270101, ret])).ir;
  assert.equal(registerBits(evaluate(toFloat, new Map([['arm64:x8', 0x7f800123n]])), 'arm64:v1', 128), 0x7f800123n);
  const toInteger = lift(fromWords([0x9e660020, ret])).ir;
  assert.equal(registerBits(evaluate(toInteger, new Map([['arm64:v1', 0xfff0000000000123n]]))), 0xfff0000000000123n);
  const precision = lift(fromWords([0x1e22c020, ret])).ir;
  assert.equal(registerBits(evaluate(precision, new Map([['arm64:v1', floatBits(1.25, 32)]])), 'arm64:v0', 64), floatBits(1.25, 64));
  const conversion = lift(fromWords([0x9e620020, ret])).ir;
  assert.equal(registerBits(evaluate(conversion, new Map([['arm64:x1', -17n]])), 'arm64:v0', 64), floatBits(-17, 64));
});
