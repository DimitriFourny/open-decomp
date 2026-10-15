import assert from 'node:assert/strict';
import test from 'node:test';
import { entityIdentity } from '../../../src/core/index.js';
import { IRBuilder, floating, integer, vector, type IntegerOp, type IntegerPredicate } from '../../../src/ir/index.js';
import { provenance, slice } from '../../ir/support.js';
import { emit, execute } from './support.js';

function program(name: string): IRBuilder<'ssa'> { return new IRBuilder(slice, entityIdentity(slice, 'function', name), provenance, 'ssa'); }

test('emitted grouping and finite-width arithmetic are independently executed across non-C widths', () => {
  for (const width of [1, 8, 32, 64, 127, 2048]) {
    const b = program(`emitted-wrap-${width}`), type = integer(width), entry = b.block('entry', [type, type, type]);
    const [a, c, d] = entry.parameters;
    const result = entry.int('mul', entry.int('sub', a!, entry.int('sub', c!, d!)), entry.int('add', a!, d!));
    entry.return([result]);
    const output = emit(b.finish(entry, [type]));
    const mask = (1n << BigInt(width)) - 1n;
    for (const [x, y, z] of [[mask, 2n & mask, 3n & mask], [0n, mask, 1n]] as const) {
      const actual = execute(output.emission.text, new Map([[a!.id, x], [c!.id, y], [d!.id, z]]));
      const wrapped = (value: bigint): bigint => value & mask;
      assert.deepEqual(actual.values, [wrapped(wrapped(x - wrapped(y - z)) * wrapped(x + z))]);
    }
  }
});

test('signedness, full shift counts, rotates and integer unary families survive formatting', () => {
  const b = program('emitted-integer-families'), i8 = integer(8), entry = b.block('entry');
  const a = entry.constant(i8, 0x81n), c = entry.constant(i8, 3n), huge = entry.constant(i8, 9n);
  const ops: IntegerOp[] = ['add', 'sub', 'mul', 'and', 'or', 'xor', 'udiv', 'sdiv', 'urem', 'srem', 'shl', 'lshr', 'ashr', 'rol', 'ror'];
  const expected = [132n, 126n, 131n, 1n, 131n, 130n, 43n, 214n, 0n, 255n, 8n, 16n, 240n, 12n, 48n];
  const values = ops.map(op => entry.int(op, a, c));
  values.push(...['shl', 'lshr', 'ashr', 'rol', 'ror'].map(op => entry.int(op as IntegerOp, a, huge)));
  expected.push(0n, 0n, 255n, 3n, 192n);
  values.push(entry.unary('not', a), entry.unary('neg', a), entry.unary('clz', a), entry.unary('ctz', a), entry.unary('popcount', a));
  expected.push(126n, 127n, 0n, 0n, 2n);
  const predicates: IntegerPredicate[] = ['eq', 'ne', 'ult', 'ule', 'ugt', 'uge', 'slt', 'sle', 'sgt', 'sge'];
  values.push(...predicates.map(op => entry.compare(op, a, c))); expected.push(0n, 1n, 0n, 0n, 1n, 1n, 1n, 1n, 0n, 0n);
  entry.return(values);
  assert.deepEqual(execute(emit(b.finish(entry, values.map(value => value.type))).emission.text).values, expected);
});

test('bit slices, low-first concat, casts, lazy select and carry/borrow flags retain bit identity', () => {
  const b = program('emitted-slices'), i1 = integer(1), i8 = integer(8), i16 = integer(16), entry = b.block('entry');
  const lo = entry.constant(i8, 0x81n), hi = entry.constant(i8, 0x12n), joined = entry.concat([lo, hi]);
  const inserted = entry.insert(joined, entry.constant(i8, 0x34n), 4);
  const condition = entry.compare('slt', lo, hi);
  const unknown = entry.indeterminate(i16, 'unknown', 'No value; not zero or a trap');
  const values = [joined, inserted, entry.extract(inserted, 4, 8), entry.cast('sign_extend', i16, lo), entry.cast('zero_extend', i16, lo), entry.cast('truncate', i8, joined), entry.select(condition, joined, unknown)];
  const carry = entry.constant(i1, 1n), max = entry.constant(i8, 255n), zero = entry.constant(i8, 0n);
  for (const flag of ['carry', 'borrow', 'overflow', 'zero', 'negative', 'parity'] as const) values.push(entry.flag('add', flag, max, zero, carry));
  for (const flag of ['carry', 'borrow', 'overflow', 'zero', 'negative', 'parity'] as const) values.push(entry.flag('sub', flag, zero, zero, carry));
  entry.return(values);
  assert.deepEqual(execute(emit(b.finish(entry, values.map(value => value.type))).emission.text).values, [0x1281n, 0x1341n, 0x34n, 0xff81n, 0x81n, 0x81n, 0x1281n, 1n, 0n, 0n, 1n, 0n, 1n, 0n, 1n, 0n, 0n, 1n, 1n]);
});

test('IEEE payloads, negative zero, comparisons, conversions and vector lane arithmetic are not integer approximations', () => {
  const b = program('emitted-fp-vector'), f32 = floating(32), f64 = floating(64), i32 = integer(32), entry = b.block('entry');
  const nan = entry.constant(f32, 0x7fa12345n), minusZero = entry.constant(f32, 0x80000000n), one = entry.constant(f32, 0x3f800000n), two = entry.constant(f32, 0x40000000n);
  const values = [entry.assign(f32, { kind: 'float_unary', op: 'neg', value: nan }), entry.assign(f32, { kind: 'float_unary', op: 'abs', value: minusZero }), entry.fp('add', nan, one), entry.fp('sub', two, one), entry.fp('mul', two, two), entry.fp('div', one, two), entry.assign(f32, { kind: 'float_unary', op: 'sqrt', value: entry.constant(f32, 0x40800000n) }), entry.fpCompare('unordered', nan, one), entry.fpCompare('ne', nan, one), entry.fpCompare('eq', minusZero, entry.constant(f32, 0n)), entry.cast('bitcast', i32, nan), entry.cast('float_convert', f64, one), entry.cast('float_to_signed', i32, entry.constant(f32, 0xbfc00000n)), entry.cast('unsigned_to_float', f32, entry.constant(i32, 3n)), entry.cast('signed_to_float', f32, entry.constant(i32, 0xffffffffn))];
  const vi = vector(integer(8), 2), vf = vector(f32, 2);
  const packed = entry.pack(vi, [entry.constant(integer(8), 255n), entry.constant(integer(8), 1n)]);
  const doubled = entry.vectorInt('add', packed, packed);
  values.push(entry.lane(doubled, 0), entry.lane(doubled, 1), entry.assign(vi, { kind: 'vector_insert', vector: packed, value: entry.constant(integer(8), 7n), lane: 1 }));
  const floats = entry.pack(vf, [one, two]); values.push(entry.lane(entry.vectorFloat('mul', floats, floats), 1));
  entry.return(values);
  assert.deepEqual(execute(emit(b.finish(entry, values.map(value => value.type))).emission.text).values, [0xffa12345n, 0n, 0x7fc00000n, 0x3f800000n, 0x40800000n, 0x3f000000n, 0x40000000n, 1n, 1n, 1n, 0x7fa12345n, 0x3ff0000000000000n, 0xffffffffn, 0x40400000n, 0xbf800000n, 254n, 2n, 0x7ffn, 0x40800000n]);
});

test('undefined integer division and indeterminate branch conditions do not become traps or false branches', () => {
  for (const mode of ['zero', 'overflow', 'unknown', 'undefined'] as const) {
    const b = program(`emitted-undefined-${mode}`), i8 = integer(8), entry = b.block('entry'), yes = b.block('yes'), no = b.block('no');
    const value = mode === 'zero' ? entry.int('udiv', entry.constant(i8, 3n), entry.constant(i8, 0n))
      : mode === 'overflow' ? entry.int('sdiv', entry.constant(i8, 128n), entry.constant(i8, 255n))
        : entry.indeterminate(i8, mode, 'not established');
    entry.branch(entry.compare('eq', value, entry.constant(i8, 0n)), entry.edge(yes), entry.edge(no));
    yes.return([yes.constant(i8, 1n)]); no.return([no.constant(i8, 2n)]);
    const output = emit(b.finish(entry, [i8]));
    assert.equal(execute(output.emission.text).exit, 'unknown');
    assert.equal(output.diagnostics.some(diagnostic => diagnostic.code === 'unavailable_semantics'), mode === 'unknown');
  }
});
