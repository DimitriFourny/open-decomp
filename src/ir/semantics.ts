import { bitWidth, expressionOperands } from './model.js';
import type { DataType, Expression, FloatOp, IntegerOp, Value } from './model.js';

/** All runtime data, including FP/vector values, retains its exact machine bit pattern. */
export type RuntimeValue = { readonly kind: 'bits'; readonly bits: bigint } | { readonly kind: 'unknown' | 'undefined'; readonly reason: string };
export function bits(value: bigint, width: number): RuntimeValue { return { kind: 'bits', bits: BigInt.asUintN(width, value) }; }
// Synchronous conversions never retain a view; reuse scratch storage across lanes.
const floatView = new DataView(new ArrayBuffer(8));
export function floatBits(value: number, width: 32 | 64): bigint {
  // Arithmetic NaNs are canonical quiet NaNs. Loads/stores/bitcasts preserve payloads.
  if (Number.isNaN(value)) return width === 32 ? 0x7fc00000n : 0x7ff8000000000000n;
  if (width === 32) { floatView.setFloat32(0, value, true); return BigInt(floatView.getUint32(0, true)); }
  floatView.setFloat64(0, value, true); return floatView.getBigUint64(0, true);
}
export function bitsFloat(value: bigint, width: 32 | 64): number {
  if (width === 32) { floatView.setUint32(0, Number(BigInt.asUintN(32, value)), true); return floatView.getFloat32(0, true); }
  floatView.setBigUint64(0, BigInt.asUintN(64, value), true); return floatView.getFloat64(0, true);
}
/** Integer -> IEEE round-to-nearest ties-even, avoiding Number->f32 double rounding. */
function integerFloat(value: bigint, width: 32 | 64): bigint {
  const negative = value < 0n;
  let magnitude = negative ? -value : value;
  const precision = width === 32 ? 24 : 53;
  const length = magnitude.toString(2).length;
  if (length > precision) {
    const shift = BigInt(length - precision);
    const remainder = magnitude & ((1n << shift) - 1n);
    let significand = magnitude >> shift;
    const halfway = 1n << (shift - 1n);
    if (remainder > halfway || (remainder === halfway && (significand & 1n) !== 0n)) significand++;
    magnitude = significand << shift;
  }
  return floatBits(Number(negative ? -magnitude : magnitude), width);
}
export function evaluateInteger(op: IntegerOp, left: bigint, right: bigint, width: number): RuntimeValue {
  if (!Number.isInteger(width) || width < 1 || width > 2048) throw new RangeError('Integer width must be 1..2048');
  if (right < 0n && ['shl', 'lshr', 'ashr', 'rol', 'ror'].includes(op)) throw new RangeError('Shift count must be unsigned');
  const a = BigInt.asUintN(width, left), b = BigInt.asUintN(width, right), signedA = BigInt.asIntN(width, a), signedB = BigInt.asIntN(width, b);
  const n = BigInt(width);
  let result: bigint;
  switch (op) {
    case 'add': result = a + b; break;
    case 'sub': result = a - b; break;
    case 'mul': result = a * b; break;
    case 'and': result = a & b; break;
    case 'or': result = a | b; break;
    case 'xor': result = a ^ b; break;
    case 'udiv': case 'urem':
      if (b === 0n) return { kind: 'undefined', reason: 'Integer division by zero; ISA lifter must choose its architectural behavior' };
      result = op === 'udiv' ? a / b : a % b; break;
    case 'sdiv': case 'srem':
      if (signedB === 0n || (signedA === -(1n << (n - 1n)) && signedB === -1n)) return { kind: 'undefined', reason: 'Signed division by zero or overflow; not an established machine trap' };
      result = op === 'sdiv' ? signedA / signedB : signedA % signedB; break;
    // Shift counts are *not* implicitly masked. Lifters encode their ISA's mask explicitly.
    case 'shl': result = right >= n ? 0n : a << right; break;
    case 'lshr': result = right >= n ? 0n : a >> right; break;
    case 'ashr': result = right >= n ? (signedA < 0n ? -1n : 0n) : signedA >> right; break;
    case 'rol': { const count = right % n; result = (a << count) | (a >> (n - count)); break; }
    case 'ror': { const count = right % n; result = (a >> count) | (a << (n - count)); break; }
  }
  return bits(result, width);
}
function evaluateFloat(op: FloatOp, left: bigint, right: bigint, width: 32 | 64): bigint {
  const a = bitsFloat(left, width), b = bitsFloat(right, width);
  switch (op) {
    case 'add': return floatBits(a + b, width);
    case 'sub': return floatBits(a - b, width);
    case 'mul': return floatBits(a * b, width);
    case 'div': return floatBits(a / b, width);
  }
}
/** IEEE default nearest-even, gradual underflow, no ambient FP exception/control register emulation. */
export function evaluateExpression(type: DataType, expression: Expression, get: (value: Value) => RuntimeValue): RuntimeValue {
  const width = bitWidth(type);
  if (expression.kind === 'indeterminate') return { kind: expression.state, reason: expression.reason };
  if (expression.kind === 'constant') return bits(expression.bits, width);
  if (expression.kind === 'address') return bits(expression.address.value, width);
  if (expression.kind === 'select') {
    const condition = get(expression.condition);
    return condition.kind === 'bits' ? get(condition.bits === 0n ? expression.when_false : expression.when_true) : condition;
  }
  if (expression.kind === 'concat') {
    let result = 0n, offset = 0;
    let unknown: RuntimeValue | undefined;
    for (const value of expression.values) {
      const part = get(value);
      if (part.kind === 'undefined') return part;
      if (part.kind === 'unknown') unknown ??= part;
      else if (part.kind === 'bits' && !unknown) result |= part.bits << BigInt(offset);
      offset += bitWidth(value.type);
    }
    return unknown ?? bits(result, width);
  }
  const operands = expressionOperands(expression).map(get);
  const indeterminate = operands.find(value => value.kind !== 'bits');
  if (indeterminate) return indeterminate;
  const raw = operands.map(value => { if (value.kind !== 'bits') throw new TypeError('Expected known operand'); return value.bits; });
  const a = raw[0]!, b = raw[1]!;
  switch (expression.kind) {
    case 'integer': return evaluateInteger(expression.op, a, b, width);
    case 'integer_unary': {
      switch (expression.op) {
        case 'not': return bits(~a, width);
        case 'neg': return bits(-a, width);
        case 'clz': return bits(BigInt(a === 0n ? width : width - a.toString(2).length), width);
        case 'ctz': { let count = 0; let value = a; while (count < width && (value & 1n) === 0n) { count++; value >>= 1n; } return bits(BigInt(count), width); }
        case 'popcount': { let count = 0n; let value = a; while (value !== 0n) { count++; value &= value - 1n; } return bits(count, width); }
      }
      break;
    }
    case 'compare': {
      const n = bitWidth(expression.left.type), sa = BigInt.asIntN(n, a), sb = BigInt.asIntN(n, b);
      let result: boolean;
      switch (expression.op) {
        case 'eq': result = a === b; break; case 'ne': result = a !== b; break;
        case 'ult': result = a < b; break; case 'ule': result = a <= b; break; case 'ugt': result = a > b; break; case 'uge': result = a >= b; break;
        case 'slt': result = sa < sb; break; case 'sle': result = sa <= sb; break; case 'sgt': result = sa > sb; break; case 'sge': result = sa >= sb; break;
      }
      return bits(result ? 1n : 0n, 1);
    }
    case 'cast': {
      const source = expression.value.type;
      switch (expression.op) {
        case 'bitcast': case 'zero_extend': case 'truncate': return bits(a, width);
        case 'sign_extend': return bits(BigInt.asIntN(bitWidth(source), a), width);
        case 'signed_to_float': case 'unsigned_to_float': {
          if (type.kind !== 'float') throw new TypeError('Invalid float cast result');
          return bits(integerFloat(expression.op === 'signed_to_float' ? BigInt.asIntN(bitWidth(source), a) : a, type.bits), width);
        }
        case 'float_convert': {
          if (source.kind !== 'float' || type.kind !== 'float') throw new TypeError('Invalid float conversion');
          return bits(floatBits(bitsFloat(a, source.bits), type.bits), width);
        }
        case 'float_to_signed': case 'float_to_unsigned': {
          if (source.kind !== 'float') throw new TypeError('Invalid float cast source');
          const value = bitsFloat(a, source.bits);
          if (!Number.isFinite(value)) return { kind: 'undefined', reason: 'Non-finite floating-to-integer conversion' };
          const truncated = BigInt(Math.trunc(value));
          const signed = expression.op === 'float_to_signed';
          const minimum = signed ? -(1n << BigInt(width - 1)) : 0n;
          const maximum = signed ? (1n << BigInt(width - 1)) - 1n : (1n << BigInt(width)) - 1n;
          return truncated < minimum || truncated > maximum ? { kind: 'undefined', reason: 'Out-of-range floating-to-integer conversion' } : bits(truncated, width);
        }
      }
      break;
    }
    case 'extract': return bits(a >> BigInt(expression.offset), width);
    case 'insert': {
      const mask = ((1n << BigInt(bitWidth(expression.value.type))) - 1n) << BigInt(expression.offset);
      return bits((a & ~mask) | (b << BigInt(expression.offset)), width);
    }
    case 'flag': {
      const n = bitWidth(expression.left.type), carry = raw[2]!;
      const full = expression.op === 'add' ? a + b + carry : a - b - carry;
      const result = BigInt.asUintN(n, full);
      let flag: boolean;
      switch (expression.flag) {
        case 'carry': flag = expression.op === 'add' ? full >= (1n << BigInt(n)) : full >= 0n; break;
        case 'borrow': flag = full < 0n; break;
        case 'overflow': {
          const signed = expression.op === 'add' ? BigInt.asIntN(n, a) + BigInt.asIntN(n, b) + carry : BigInt.asIntN(n, a) - BigInt.asIntN(n, b) - carry;
          flag = signed !== BigInt.asIntN(n, result); break;
        }
        case 'zero': flag = result === 0n; break;
        case 'negative': flag = (result & (1n << BigInt(n - 1))) !== 0n; break;
        case 'parity': { let parity = 0n, low = result & 255n; while (low !== 0n) { parity ^= low & 1n; low >>= 1n; } flag = parity === 0n; break; }
      }
      return bits(flag ? 1n : 0n, 1);
    }
    case 'float': {
      if (type.kind !== 'float') throw new TypeError('Invalid float type');
      return bits(evaluateFloat(expression.op, a, b, type.bits), width);
    }
    case 'float_unary': {
      if (type.kind !== 'float') throw new TypeError('Invalid float type');
      const sign = 1n << BigInt(width - 1);
      if (expression.op === 'neg') return bits(a ^ sign, width);
      if (expression.op === 'abs') return bits(a & ~sign, width);
      return bits(floatBits(Math.sqrt(bitsFloat(a, type.bits)), type.bits), width);
    }
    case 'float_compare': {
      const input = expression.left.type;
      if (input.kind !== 'float') throw new TypeError('Invalid float comparison');
      const left = bitsFloat(a, input.bits), right = bitsFloat(b, input.bits), unordered = Number.isNaN(left) || Number.isNaN(right);
      let result: boolean;
      switch (expression.op) {
        case 'eq': result = left === right; break; case 'ne': result = left !== right; break;
        case 'lt': result = left < right; break; case 'le': result = left <= right; break; case 'gt': result = left > right; break; case 'ge': result = left >= right; break;
        case 'ordered': result = !unordered; break; case 'unordered': result = unordered; break;
      }
      return bits(result ? 1n : 0n, 1);
    }
    case 'vector': {
      if (type.kind !== 'vector') throw new TypeError('Invalid vector type');
      let packed = 0n;
      for (let i = 0; i < raw.length; i++) packed |= raw[i]! << BigInt(i * type.element.bits);
      return bits(packed, width);
    }
    case 'vector_lane': return bits(a >> BigInt(expression.lane * width), width);
    case 'vector_insert': {
      const laneWidth = bitWidth(expression.value.type), offset = BigInt(expression.lane * laneWidth);
      const mask = ((1n << BigInt(laneWidth)) - 1n) << offset;
      return bits((a & ~mask) | (b << offset), width);
    }
    case 'vector_integer': case 'vector_float': {
      if (type.kind !== 'vector') throw new TypeError('Invalid vector type');
      const n = type.element.bits;
      let packed = 0n;
      for (let lane = 0; lane < type.lanes; lane++) {
        const offset = BigInt(lane * n), left = BigInt.asUintN(n, a >> offset), right = BigInt.asUintN(n, b >> offset);
        let result: RuntimeValue;
        if (expression.kind === 'vector_integer') result = evaluateInteger(expression.op, left, right, n);
        else {
          if (type.element.kind !== 'float') throw new TypeError('Invalid vector float element');
          result = bits(evaluateFloat(expression.op, left, right, type.element.bits), n);
        }
        if (result.kind !== 'bits') return result;
        packed |= result.bits << offset;
      }
      return bits(packed, width);
    }
  }
  throw new TypeError('Invalid semantic expression');
}
