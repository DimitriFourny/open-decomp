import type { OperationContext } from '../core/index.js';
import { bitWidth, type Expression, type Value } from '../ir/index.js';

const maximumDepth = 24;

/** Inclusive unsigned upper bounds of integer SSA values, derived only from
 * their immutable definitions: constants, masks, zero extensions, truncations,
 * logical right shifts, remainders and bounded sums/products that cannot wrap.
 * Any operand without such a definition (a parameter, a phi, a load) is
 * bounded by its width alone, so every answer holds for every execution. */
export class UnsignedBounds {
  private readonly memo = new Map<string, bigint>();

  constructor(
    private readonly expressions: ReadonlyMap<string, Expression>,
    private readonly context: OperationContext,
  ) {}

  /** Largest unsigned value the integer `value` can hold; undefined for any
   * other type. */
  maximum(value: Value): bigint | undefined {
    return value.type.kind === 'integer' ? this.bound(value, 0) : undefined;
  }

  private bound(value: Value, depth: number): bigint {
    const width = bitWidth(value.type),
      full = (1n << BigInt(width)) - 1n;
    const known = this.memo.get(value.id);
    if (known !== undefined) return known;
    const expression = this.expressions.get(value.id);
    if (!expression || depth >= maximumDepth || value.type.kind !== 'integer') return full;
    this.context.checkpoint(1);
    const of = (operand: Value): bigint =>
      operand.type.kind === 'integer'
        ? this.bound(operand, depth + 1)
        : (1n << BigInt(bitWidth(operand.type))) - 1n;
    const constant = (operand: Value): bigint | undefined => {
      const definition = this.expressions.get(operand.id);
      return definition?.kind === 'constant' && operand.type.kind === 'integer'
        ? BigInt.asUintN(operand.type.bits, definition.bits)
        : undefined;
    };
    const cap = (bound: bigint): bigint => (bound < full ? bound : full);
    const covering = (bound: bigint): bigint => cap((1n << BigInt(bound.toString(2).length)) - 1n);
    let result = full;
    switch (expression.kind) {
      case 'constant':
        result = BigInt.asUintN(width, expression.bits);
        break;
      case 'integer': {
        const left = of(expression.left),
          right = of(expression.right),
          count = constant(expression.right);
        switch (expression.op) {
          case 'and':
            result = left < right ? left : right;
            break;
          case 'or':
          case 'xor':
            result = covering(left > right ? left : right);
            break;
          case 'add':
            result = cap(left + right);
            break;
          case 'mul':
            result = cap(left * right);
            break;
          case 'shl':
            result = count === undefined ? full : count >= BigInt(width) ? 0n : cap(left << count);
            break;
          case 'lshr':
            result = count === undefined ? left : count >= BigInt(width) ? 0n : left >> count;
            break;
          case 'udiv':
            result = count !== undefined && count > 0n ? left / count : full;
            break;
          case 'urem': {
            const remainder = right > 0n ? right - 1n : 0n;
            result = left < remainder ? left : remainder;
            break;
          }
          default:
            break;
        }
        break;
      }
      case 'cast':
        if (expression.value.type.kind !== 'integer') break;
        if (
          expression.op === 'zero_extend' ||
          expression.op === 'bitcast' ||
          expression.op === 'truncate'
        )
          result = cap(of(expression.value));
        else if (expression.op === 'sign_extend') {
          const inner = of(expression.value);
          if (inner < 1n << BigInt(bitWidth(expression.value.type) - 1)) result = inner;
        }
        break;
      case 'extract':
        if (expression.value.type.kind === 'integer')
          result = cap(of(expression.value) >> BigInt(expression.offset));
        break;
      case 'select': {
        const yes = of(expression.when_true),
          no = of(expression.when_false);
        result = yes > no ? yes : no;
        break;
      }
      default:
        break;
    }
    this.memo.set(value.id, result);
    return result;
  }
}
