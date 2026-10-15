import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateIR, evaluateInteger, bitsFloat, floatBits, floating, integer, vector } from '../../src/ir/index.js';
import type { IntegerOp } from '../../src/ir/index.js';
import { builder, register, returned } from './support.js';

const i1 = integer(1), i8 = integer(8), i32 = integer(32), i64 = integer(64);

test('finite-width arithmetic, extensions and signed comparisons are actual evaluations', () => {
  const ir = builder('integer'); const b = ir.block('entry');
  const minusOne = b.constant(i8, -1n), three = b.constant(i8, 3n), minusThirteen = b.constant(i8, -13n);
  const values = [b.int('add', minusOne, three), b.int('mul', minusOne, three), b.int('sdiv', minusThirteen, three), b.int('srem', minusThirteen, three), b.int('udiv', minusOne, three), b.int('urem', minusOne, three), b.cast('sign_extend', i64, minusOne), b.cast('zero_extend', i64, minusOne), b.cast('truncate', i8, b.constant(i64, 0x1234n)), b.compare('slt', minusOne, three), b.compare('ult', minusOne, three), b.unary('clz', b.constant(i8, 0n)), b.unary('ctz', b.constant(i8, 0x40n)), b.unary('popcount', minusOne)];
  b.return(values);
  assert.deepEqual(returned(evaluateIR(ir.finish(b, values.map(v => v.type)))), [2n, 253n, 252n, 255n, 85n, 0n, 0xffffffffffffffffn, 255n, 52n, 1n, 0n, 8n, 6n, 8n]);
});

test('deterministic wide arithmetic property vectors never narrow to JavaScript int32', () => {
  let state = 0x123456789abcdefn;
  for (const width of [1, 8, 16, 32, 64, 128, 2048]) {
    const mask = (1n << BigInt(width)) - 1n;
    for (let index = 0; index < 40; index++) {
      state = BigInt.asUintN(256, state * 6364136223846793005n + 1442695040888963407n);
      const a = state & mask;
      state = BigInt.asUintN(256, state * 6364136223846793005n + 1442695040888963407n);
      const b = state & mask;
      for (const [op, expected] of [['add', a + b], ['sub', a - b], ['mul', a * b], ['xor', a ^ b], ['and', a & b], ['or', a | b]] as const) {
        assert.deepEqual(evaluateInteger(op, a, b, width), { kind: 'bits', bits: expected & mask });
      }
    }
  }
});

test('shift edges and rotates at 64 and 128 bits use explicit count semantics', () => {
  const ir = builder('shifts'); const b = ir.block('entry');
  const a = b.constant(i64, 0x8000000000000001n), count = b.constant(i8, 64n);
  const wide = b.constant(integer(128), (1n << 127n) | 1n);
  const values = [b.int('lshr', a, count), b.int('ashr', a, count), b.int('shl', a, count), b.int('rol', a, b.constant(i8, 1n)), b.int('ror', a, b.constant(i8, 1n)), b.int('lshr', wide, count), b.int('rol', wide, b.constant(i8, 127n))];
  b.return(values);
  assert.deepEqual(returned(evaluateIR(ir.finish(b, values.map(v => v.type)))), [0n, 0xffffffffffffffffn, 0n, 3n, 0xc000000000000000n, 1n << 63n, (1n << 127n) | (1n << 126n)]);
});

test('division undefined boundaries differ from traps and unchosen select arms do not poison', () => {
  for (const op of ['udiv', 'sdiv', 'urem', 'srem'] satisfies IntegerOp[]) {
    const ir = builder(op); const b = ir.block('entry');
    b.return([b.int(op, b.constant(i32, 5n), b.constant(i32, 0n))]);
    assert.equal(evaluateIR(ir.finish(b, [i32])).status, 'undefined');
  }
  const ir = builder('select-undefined'); const b = ir.block('entry');
  const invalid = b.int('sdiv', b.constant(i32, -0x80000000n), b.constant(i32, -1n));
  b.return([b.select(b.constant(i1, 0n), invalid, b.constant(i32, 42n))]);
  assert.deepEqual(returned(evaluateIR(ir.finish(b, [i32]))), [42n]);
});

test('carry, borrow, overflow, sign, parity and zero flags are width-correct', () => {
  const ir = builder('flags'); const b = ir.block('entry');
  const ff = b.constant(i8, 255n), one = b.constant(i8, 1n), zero = b.constant(i8, 0n), carry = b.constant(i1, 0n);
  const values = [b.flag('add', 'carry', ff, one, carry), b.flag('add', 'zero', ff, one, carry), b.flag('add', 'overflow', b.constant(i8, 127n), zero, b.constant(i1, 1n)), b.flag('sub', 'carry', zero, one, carry), b.flag('sub', 'borrow', zero, one, carry), b.flag('sub', 'negative', zero, one, carry), b.flag('sub', 'parity', zero, one, carry), b.flag('sub', 'overflow', b.constant(i8, 128n), one, carry)];
  b.return(values);
  assert.deepEqual(returned(evaluateIR(ir.finish(b, values.map(v => v.type)))), [1n, 1n, 1n, 0n, 1n, 1n, 1n, 1n]);
});

test('AL/AH/AX preserve root bits while EAX and ARM W writes zero-extend', () => {
  const ir = builder('slices'); const b = ir.block('entry');
  const rax = register('rax', 64, 0, 'replace_root'), al = register('al', 8), ah = register('ah', 8, 8), ax = register('ax', 16), eax = register('eax', 32, 0, 'zero_extend_root');
  b.writeRegister(rax, b.constant(i64, 0x1122334455667788n));
  b.writeRegister(al, b.constant(i8, 0xaan));
  b.writeRegister(ah, b.constant(i8, 0xbbn));
  const partial = b.readRegister(rax);
  b.writeRegister(ax, b.constant(integer(16), 0xccddn)); const half = b.readRegister(rax);
  b.writeRegister(eax, b.constant(i32, 0xeeff0011n)); const dword = b.readRegister(rax);
  const x = register('arm64:x0', 64, 0, 'replace_root', 'arm64:x0'), w = register('arm64:w0', 32, 0, 'zero_extend_root', 'arm64:x0');
  b.writeRegister(x, b.constant(i64, -1n)); b.writeRegister(w, b.constant(i32, 7n));
  b.return([partial, half, dword, b.readRegister(x), b.extract(partial, 8, 8), b.insert(dword, b.constant(i8, 0x12n), 40)]);
  assert.deepEqual(returned(evaluateIR(ir.finish(b, [i64, i64, i64, i64, i8, i64]))), [0x112233445566bbaan, 0x112233445566ccddn, 0xeeff0011n, 7n, 0xbbn, 0x1200eeff0011n]);
});

test('zero register discard, partial initialization and undefined flag writes remain distinct', () => {
  const ir = builder('unknown-slices'); const b = ir.block('entry');
  const al = register('al', 8), rax = register('rax', 64, 0, 'replace_root');
  const zr = { ...register('arm64:xzr', 64, 0, 'discard', 'arm64:xzr'), role: 'zero' as const };
  b.writeRegister(zr, b.constant(i64, 9n)); b.writeRegister(al, b.constant(i8, 42n));
  b.return([b.readRegister(al), b.readRegister(zr), b.readRegister(rax)]);
  const result = evaluateIR(ir.finish(b, [i8, i64, i64]));
  assert.equal(result.status, 'unknown'); assert.deepEqual(result.values.slice(0, 2), [{ kind: 'bits', bits: 42n }, { kind: 'bits', bits: 0n }]);
  const undef = builder('undefined-flag'); const c = undef.block('entry');
  const flag = { ...register('x86_64:cf', 1, 0, 'preserve_other_bits', 'x86_64:rflags'), bank: 'flags' as const, role: 'flags' as const };
  c.writeRegister(flag, c.indeterminate(i1, 'undefined', 'Architectural undefined flag'));
  c.return([c.readRegister(flag)]);
  assert.equal(evaluateIR(undef.finish(c, [i1])).status, 'undefined');
});

test('IEEE float semantics retain signed zero, NaN boundaries, rounding and subnormals', () => {
  const ir = builder('float-edges'); const b = ir.block('entry'); const f32 = floating(32), f64 = floating(64);
  const values = [b.fp('add', b.constant(f32, floatBits(16777216, 32)), b.constant(f32, floatBits(1, 32))), b.fp('mul', b.constant(f32, 1n), b.constant(f32, floatBits(1, 32))), b.fp('div', b.constant(f64, floatBits(1, 64)), b.constant(f64, floatBits(-0, 64))), b.fp('div', b.constant(f64, 0n), b.constant(f64, 0n)), b.assign(f64, { kind: 'float_unary', op: 'neg', value: b.constant(f64, 0x7ff8000000001234n) }), b.fpCompare('unordered', b.constant(f64, 0x7ff8000000000001n), b.constant(f64, 0n)), b.cast('signed_to_float', f32, b.constant(i64, 16777217n)), b.cast('float_to_signed', i32, b.constant(f64, floatBits(-13.9, 64)))];
  b.return(values);
  assert.deepEqual(returned(evaluateIR(ir.finish(b, values.map(v => v.type)))), [floatBits(16777216, 32), 1n, floatBits(-Infinity, 64), 0x7ff8000000000000n, 0xfff8000000001234n, 1n, floatBits(16777216, 32), BigInt.asUintN(32, -13n)]);
  assert.ok(Object.is(bitsFloat(floatBits(-0, 64), 64), -0));
  const bad = builder('float-range'); const c = bad.block('entry');
  c.return([c.cast('float_to_unsigned', i8, c.constant(f64, floatBits(256, 64)))]);
  assert.equal(evaluateIR(bad.finish(c, [i8])).status, 'undefined');
});

test('fixed vector integer wrapping, float lane rounding, insertion and reinterpretation', () => {
  const ir = builder('vectors'); const b = ir.block('entry'); const v4i = vector(i32, 4), f32 = floating(32), v4f = vector(f32, 4);
  const a = b.pack(v4i, [0xffffffffn, 1n, 0x80000000n, 7n].map(n => b.constant(i32, n)));
  const ones = b.pack(v4i, [1n, 2n, 0x80000000n, 3n].map(n => b.constant(i32, n)));
  const sum = b.vectorInt('add', a, ones);
  const changed = b.assign(v4i, { kind: 'vector_insert', vector: sum, value: b.constant(i32, 99n), lane: 1 });
  const f = b.pack(v4f, [1, -2, 0.5, 16777216].map(n => b.constant(f32, floatBits(n, 32))));
  const g = b.pack(v4f, [3, 4, -1, 1].map(n => b.constant(f32, floatBits(n, 32))));
  const fs = b.vectorFloat('add', f, g);
  const values = [0, 1, 2, 3].map(lane => b.lane(changed, lane));
  values.push(...[0, 1, 2, 3].map(lane => b.cast('bitcast', i32, b.lane(fs, lane))));
  values.push(b.cast('bitcast', integer(128), sum)); b.return(values);
  assert.deepEqual(returned(evaluateIR(ir.finish(b, values.map(v => v.type)))), [0n, 99n, 0n, 10n, floatBits(4, 32), floatBits(2, 32), floatBits(-0.5, 32), floatBits(16777216, 32), (10n << 96n) | (3n << 32n)]);
});

test('large integer to binary32 conversion avoids double rounding through binary64', () => {
  const ir = builder('integer-float-rounding'); const b = ir.block('entry');
  const witness = (1n << 60n) + (1n << 36n) + 1n;
  const result = b.cast('unsigned_to_float', floating(32), b.constant(i64, witness));
  b.return([result]);
  assert.deepEqual(returned(evaluateIR(ir.finish(b, [floating(32)]))), [floatBits(Number((1n << 60n) + (1n << 37n)), 32)]);
});
