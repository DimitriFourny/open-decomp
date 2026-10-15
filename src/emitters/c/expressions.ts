import { bitWidth, type DataType, type Expression, type Value } from '../../ir/index.js';
import type { Writer } from './writer.js';

/** These are machine storage types, never inferred C source types. */
export function machineType(type: DataType): string {
  switch (type.kind) {
    case 'integer': return `bits${type.bits}_t`;
    case 'float': return `ieee${type.bits}_t`;
    case 'vector': return `vector_${type.element.kind === 'float' ? 'f' : 'i'}${type.element.bits}x${type.lanes}_t`;
  }
}

const integerMeaning: Record<string, string> = {
  add: 'Add unsigned bit patterns and reduce modulo 2^width.',
  sub: 'Subtract unsigned bit patterns and reduce modulo 2^width.',
  mul: 'Multiply unsigned bit patterns and reduce modulo 2^width.',
  and: 'Bitwise AND of width-bit patterns.', or: 'Bitwise OR of width-bit patterns.', xor: 'Bitwise XOR of width-bit patterns.',
  udiv: 'Unsigned division, quotient rounded toward zero. Zero divisor is undefined, not an established machine trap.',
  urem: 'Unsigned remainder. Zero divisor is undefined, not an established machine trap.',
  sdiv: 'Interpret operands as width-bit two\'s complement, divide toward zero, return width-bit pattern. Zero divisor and minimum/-1 are undefined, not established traps.',
  srem: 'Signed remainder with quotient rounded toward zero; zero divisor and minimum/-1 are undefined, not established traps.',
  shl: 'Shift left by the full unsigned count; counts >= width produce zero. Reduce modulo 2^width. No implicit ISA count mask.',
  lshr: 'Logical right shift by the full unsigned count; counts >= width produce zero. No implicit ISA count mask.',
  ashr: 'Two\'s-complement arithmetic right shift; counts >= width produce all sign bits. No implicit ISA count mask.',
  rol: 'Rotate left; count modulo width.', ror: 'Rotate right; count modulo width.',
};
const castMeaning: Record<string, string> = {
  truncate: 'Keep the low destination-width bits.', zero_extend: 'Zero-extend the bit pattern to destination width.',
  sign_extend: 'Interpret the source as two\'s complement and sign-extend to destination width.',
  bitcast: 'Reinterpret exactly the same bits, including NaN payloads, signed zero and vector lane packing; no numeric conversion.',
  signed_to_float: 'Convert signed two\'s-complement integer directly to IEEE destination precision, round nearest ties-even (no intermediate double rounding).',
  unsigned_to_float: 'Convert unsigned integer directly to IEEE destination precision, round nearest ties-even (no intermediate double rounding).',
  float_to_signed: 'IEEE to signed integer, truncate toward zero. Non-finite or out-of-range results are undefined, not traps.',
  float_to_unsigned: 'IEEE to unsigned integer, truncate toward zero. Non-finite or out-of-range results are undefined, not traps.',
  float_convert: 'IEEE precision conversion with nearest ties-even rounding, gradual underflow and canonical arithmetic NaNs.',
};
const fpMeaning = 'IEEE binary32/64, nearest ties-even and gradual underflow; arithmetic NaNs canonicalize to 0x7fc00000/0x7ff8000000000000. No ambient exception/control-register behavior is invented.';

/** Formatting never propagates, reassociates, or evaluates input expressions. SSA
 * operands remain named references, so size is linear even for shared DAGs. Helper
 * arguments carry widths explicitly; C promotions/overflow never define semantics. */
export function expressionText(expression: Expression, type: DataType, writer: Writer, name: (value: Value) => string): string {
  const width = bitWidth(type);
  const invoke = (helper: string, meaning: string, args: readonly string[]): string => {
    writer.helper(helper, meaning);
    return `${helper}(${writer.join(args)})`;
  };
  switch (expression.kind) {
    case 'constant': return invoke('bit_pattern', 'Construct the exact low width bits in the named machine storage type; hexadecimal literals are arbitrary precision data, not host C integer literals.', [writer.quote(machineType(type)), String(width), `0x${BigInt.asUintN(width, expression.bits).toString(16)}`]);
    case 'address': return invoke('image_address', 'Image-qualified address-space value; no host pointer, ASLR assumption or memory read.', [writer.quote(expression.address.image_id), writer.quote(expression.address.space), `0x${expression.address.value.toString(16)}`]);
    case 'integer': return invoke(`bv_${expression.op}`, `Arguments: width, left, right. ${integerMeaning[expression.op]} Unknown/undefined operands propagate; these are not host C operators.`, [String(width), name(expression.left), name(expression.right)]);
    case 'integer_unary': return invoke(`bv_${expression.op}`, `Arguments: width, value. ${expression.op === 'not' ? 'Complement every bit.' : expression.op === 'neg' ? 'Negate modulo 2^width.' : expression.op === 'clz' ? 'Count leading zeros; zero input returns width.' : expression.op === 'ctz' ? 'Count trailing zeros; zero input returns width.' : 'Count set bits.'} Unknown/undefined operands propagate.`, [String(width), name(expression.value)]);
    case 'compare': {
      const operators = { eq: '==', ne: '!=', ult: '<', ule: '<=', ugt: '>', uge: '>=', slt: '<', sle: '<=', sgt: '>', sge: '>=' } as const;
      const signed = expression.op.startsWith('s');
      const operand = (value: Value): string => signed ? invoke('signed_value', 'Interpret a width-bit pattern as its mathematical two\'s-complement signed value; no host narrowing cast. Unknown/undefined propagates.', [String(bitWidth(value.type)), name(value)]) : name(value);
      return `(${operand(expression.left)} ${operators[expression.op]} ${operand(expression.right)})`;
    }
    case 'cast': return invoke(`cast_${expression.op}`, `Arguments: destination machine type, source machine type, value. ${castMeaning[expression.op]} Unknown/undefined operands propagate.`, [writer.quote(machineType(type)), writer.quote(machineType(expression.value.type)), name(expression.value)]);
    case 'extract': return invoke('extract_bits', 'Arguments: result width, source, bit offset. Return that slice, offset zero is least significant; preserve raw FP/vector bits. Unknown/undefined propagates.', [String(width), name(expression.value), String(expression.offset)]);
    case 'insert': return invoke('insert_bits', 'Arguments: result width, base, value width, value, offset. Replace only the designated slice, preserving all other bits. Unknown/undefined propagates.', [String(width), name(expression.base), String(bitWidth(expression.value.type)), name(expression.value), String(expression.offset)]);
    case 'concat': {
      const args = [String(width)];
      for (const value of expression.values) { writer.context.checkpoint(1); args.push(String(bitWidth(value.type)), name(value)); }
      return invoke('concat_low_first', 'Arguments: total width, repeated (part width, value). First part occupies least significant bits; no host endian dependency. Undefined dominates unknown, otherwise concatenate exact patterns.', args);
    }
    case 'select': return `(${name(expression.condition)} ? ${name(expression.when_true)} : ${name(expression.when_false)})`;
    case 'flag': return invoke(`flag_${expression.op}_${expression.flag}`, `Arguments: operand width, left, right, carry/borrow-in. Compute full mathematical ${expression.op === 'add' ? 'left + right + carry' : 'left - right - borrow'} then its wrapped result. Carry is full >= 2^width for addition, full >= 0 for subtraction; borrow is full < 0; overflow compares signed full result with signed wrapped result; zero/negative inspect wrapped result; parity is even parity of its low eight bits. Return the named flag as one bit. Unknown/undefined propagates.`, [String(bitWidth(expression.left.type)), name(expression.left), name(expression.right), name(expression.carry)]);
    case 'float': return invoke(`fp_${expression.op}`, `Arguments: width, left, right. ${fpMeaning} Unknown/undefined propagates.`, [String(width), name(expression.left), name(expression.right)]);
    case 'float_unary': return invoke(`fp_${expression.op}`, `Arguments: width, value. ${expression.op === 'neg' ? 'Toggle only the sign bit, preserving NaN payloads and signed zero.' : expression.op === 'abs' ? 'Clear only the sign bit, preserving NaN payloads.' : fpMeaning} Unknown/undefined propagates.`, [String(width), name(expression.value)]);
    case 'float_compare': return invoke(`fp_${expression.op}`, 'Arguments: operand width, left, right. IEEE comparison returning one bit: unordered iff either is NaN; ordered iff neither is NaN; ne is true for unordered inputs, all other relational comparisons are false for unordered inputs. +0 equals -0. Unknown/undefined propagates.', [String(bitWidth(expression.left.type)), name(expression.left), name(expression.right)]);
    case 'vector': return invoke('vector_lanes', 'Arguments: vector machine type, lanes in increasing index order. Lane zero occupies the least significant bits. Unknown/undefined propagates.', [writer.quote(machineType(type)), ...writer.list(expression.lanes, name)]);
    case 'vector_lane': return invoke('vector_lane', 'Arguments: result machine type, vector, zero-based lane index. Extract raw lane bits, preserving IEEE payloads. Unknown/undefined propagates.', [writer.quote(machineType(type)), name(expression.vector), String(expression.lane)]);
    case 'vector_insert': return invoke('vector_insert', 'Arguments: vector machine type, vector, zero-based lane index, value. Replace only this lane; preserve all other bits. Unknown/undefined propagates.', [writer.quote(machineType(type)), name(expression.vector), String(expression.lane), name(expression.value)]);
    case 'vector_integer': return invoke(`vector_bv_${expression.op}`, `Arguments: vector machine type, left, right. Independent per-lane operation; no cross-lane carry. ${integerMeaning[expression.op]} A lane with undefined/unknown input or result makes the vector undefined/unknown.`, [writer.quote(machineType(type)), name(expression.left), name(expression.right)]);
    case 'vector_float': return invoke(`vector_fp_${expression.op}`, `Arguments: vector machine type, left, right. Independent per-lane IEEE operation. ${fpMeaning} Unknown/undefined propagates.`, [writer.quote(machineType(type)), name(expression.left), name(expression.right)]);
    case 'indeterminate': return invoke(expression.state === 'unknown' ? 'unknown_value' : 'undefined_value', 'Arguments: machine type, inert reason text. An unavailable/undefined value, not zero, a fresh random number, or an established trap; dependencies remain indeterminate.', [writer.quote(machineType(type)), writer.quote(expression.reason)]);
  }
}
