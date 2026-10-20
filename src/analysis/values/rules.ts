import type { EntityId } from '../../core/index.js';
import { bitWidth, expressionOperands, sameType } from '../../ir/index.js';
import type { DataType, Expression, IntegerPredicate, Value } from '../../ir/index.js';

/** Definitions and facts a value rule may consult; `charge` bounds its work. */
export interface ValueRuleScope {
  readonly definition: (id: EntityId) => Expression | undefined;
  readonly constant: (id: EntityId) => bigint | undefined;
  /** Incoming edge values of a block parameter (empty for other values). */
  readonly incoming: (id: EntityId) => readonly Value[];
  readonly charge: (work?: number) => void;
}

/** Unsigned upper bound of a value from its own definition, bounded depth. */
export function upperBound(value: Value, scope: ValueRuleScope, depth = 0): bigint {
  scope.charge();
  const width = bitWidth(value.type),
    full = (1n << BigInt(width)) - 1n;
  const known = scope.constant(value.id);
  if (known !== undefined) return BigInt.asUintN(width, known);
  const expression = scope.definition(value.id);
  if (!expression || depth > 8 || value.type.kind !== 'integer') return full;
  const bound = (operand: Value): bigint => upperBound(operand, scope, depth + 1);
  switch (expression.kind) {
    case 'cast':
      if (expression.op === 'zero_extend' || expression.op === 'bitcast')
        return bound(expression.value) & full;
      if (expression.op === 'truncate') {
        const inner = bound(expression.value);
        return inner <= full ? inner : full;
      }
      return full;
    case 'insert': {
      // Inserting zero bits at or above every set bit of the base leaves the base.
      const base = bound(expression.base);
      return bound(expression.value) === 0n && base < 1n << BigInt(expression.offset) ? base : full;
    }
    case 'integer': {
      const divisor = scope.constant(expression.right.id);
      switch (expression.op) {
        case 'udiv':
          return divisor !== undefined && divisor > 0n ? bound(expression.left) / divisor : full;
        case 'urem': {
          if (divisor === undefined || divisor === 0n) return full;
          const left = bound(expression.left);
          return left < divisor - 1n ? left : divisor - 1n;
        }
        case 'lshr':
          return divisor !== undefined ? bound(expression.left) >> divisor : full;
        case 'and': {
          const left = bound(expression.left),
            right = bound(expression.right);
          return left < right ? left : right;
        }
        default:
          return full;
      }
    }
    default:
      return full;
  }
}

/** True when an indeterminate (unknown/undefined) definition may reach `value`
 * through definitions or block-parameter incoming values; exceeding the bound
 * counts as possibly indeterminate. */
export function mayBeIndeterminate(value: Value, scope: ValueRuleScope): boolean {
  const pending = [value],
    seen = new Set<EntityId>();
  while (pending.length) {
    scope.charge();
    const item = pending.pop()!;
    if (seen.has(item.id)) continue;
    if (seen.size >= 128) return true;
    seen.add(item.id);
    if (scope.constant(item.id) !== undefined) continue;
    const expression = scope.definition(item.id);
    if (expression?.kind === 'indeterminate') return true;
    pending.push(...(expression ? expressionOperands(expression) : scope.incoming(item.id)));
  }
  return false;
}

const reflexive: Readonly<Record<IntegerPredicate, boolean>> = {
  eq: true,
  ne: false,
  ult: false,
  ule: true,
  ugt: false,
  uge: true,
  slt: false,
  sle: true,
  sgt: false,
  sge: true,
};

/** Value-level rules of the expression pool: exact for every bit pattern and
 * applied by simplifySSA, so both views and every analysis consume the result.
 * - zext(trunc_w(v)) is v when v is proven below 2^w (same type).
 * - x OP x of one determinate SSA value is OP's reflexive truth value; a value
 *   whose definitions can reach an explicit unknown/undefined keeps its form.
 * These make guards like x86's quotient-overflow check, which no operand value
 * can satisfy, constant so the unreachable trap disappears. */
export function foldValueRule(
  type: DataType,
  expression: Expression,
  scope: ValueRuleScope,
): Expression | null {
  if (expression.kind === 'cast' && expression.op === 'zero_extend') {
    const inner = scope.definition(expression.value.id);
    if (
      inner?.kind === 'cast' &&
      inner.op === 'truncate' &&
      sameType(type, inner.value.type) &&
      upperBound(inner.value, scope) < 1n << BigInt(bitWidth(expression.value.type))
    )
      return { kind: 'cast', op: 'bitcast', value: inner.value };
  }
  if (
    expression.kind === 'compare' &&
    expression.left.id === expression.right.id &&
    !mayBeIndeterminate(expression.left, scope)
  )
    return { kind: 'constant', bits: reflexive[expression.op] ? 1n : 0n };
  return null;
}
