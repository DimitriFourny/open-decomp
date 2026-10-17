import type { OperationContext } from '../core/index.js';
import { mapExpression } from '../analysis/effects/index.js';
import {
  bitWidth,
  evaluateExpression,
  expressionOperands,
  integer,
  sameType,
  type DataType,
  type Expression,
  type Value,
} from '../ir/index.js';
import { identityOperand } from './expressions.js';
import { LocalValidationSession, validateBitvectorCandidate } from './local-validation.js';

/** ABI packing/unpacking is a pure view. Reduce adjacent cells back to the
 * source value without expanding DAGs or substituting mutable phi variables. */
export function normalizeSourceExpressions(
  values: ReadonlyMap<string, Value>,
  expressions: Map<string, Expression>,
  owner: ReadonlyMap<string, string>,
  make: (
    key: string,
    type: DataType,
    block: string,
    expression?: Expression,
    contributors?: readonly Value[],
  ) => Value,
  context: OperationContext,
  validation = new LocalValidationSession(context),
): void {
  const resolve = (value: Value): Value => {
    const seen = new Set<string>();
    while (!seen.has(value.id)) {
      context.checkpoint(1);
      seen.add(value.id);
      const expression = expressions.get(value.id),
        operand = expression && identityOperand(value.type, expression);
      if (!operand) break;
      value = operand;
    }
    return value;
  };
  const narrow = (value: Value, width: number, block: string): Value =>
    bitWidth(value.type) === width
      ? value
      : make(`low-bits:${value.id}:${width}`, integer(width), block, {
          kind: 'extract',
          value,
          offset: 0,
        });
  const constant = (value: Value): bigint | null => {
    const expression = expressions.get(resolve(value).id);
    return expression?.kind === 'constant'
      ? BigInt.asUintN(bitWidth(value.type), expression.bits)
      : null;
  };
  const factor = (value: Value, coefficient: bigint, block: string): Value =>
    make(`integer-factor:${value.id}:${coefficient}`, value.type, block,
      { kind: 'constant', bits: BigInt.asUintN(bitWidth(value.type), coefficient) }, [value]);
  const scaled = (value: Value): { value: Value; coefficient: bigint } | null => {
    const expression = expressions.get(resolve(value).id);
    if (expression?.kind !== 'integer') return null;
    if (expression.op === 'mul') {
      const left = constant(expression.left), right = constant(expression.right);
      if (right !== null) return { value: resolve(expression.left), coefficient: right };
      if (left !== null) return { value: resolve(expression.right), coefficient: left };
    }
    if (expression.op === 'shl') {
      const count = constant(expression.right);
      if (count !== null)
        return { value: resolve(expression.left),
          coefficient: count >= BigInt(bitWidth(value.type)) ? 0n : 1n << count };
    }
    return null;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, original] of expressions) {
      context.checkpoint(1);
      if (validation.rejectedRewrites.has(id)) continue;
      const value = values.get(id)!;
      let operandsChanged = false;
      const expression = mapExpression(original, (operand) => {
        const resolved = resolve(operand);
        operandsChanged ||= resolved.id !== operand.id;
        return resolved;
      });
      let replacement: Expression = expression;
      if (expression.kind === 'cast' && value.type.kind === 'integer') {
        if (['truncate', 'zero_extend', 'sign_extend'].includes(expression.op) &&
          sameType(value.type, expression.value.type))
          replacement = { kind: 'cast', op: 'bitcast', value: expression.value };
        else if (expression.op === 'truncate')
          replacement = { kind: 'extract', value: expression.value, offset: 0 };
      }
      if (expression.kind === 'integer' && value.type.kind === 'integer') {
        const block = owner.get(id)!;
        if (expression.op === 'shl') {
          const count = constant(expression.right);
          if (count !== null)
            replacement = { kind: 'integer', op: 'mul', left: expression.left,
              right: factor(value, count >= BigInt(value.type.bits) ? 0n : 1n << count, block) };
        } else if (expression.op === 'add') {
          const left = scaled(expression.left), right = scaled(expression.right);
          // Match only x + k*x (in either order), not arbitrary expression
          // reassociation. SSA identity keeps repeated effectful definitions
          // distinct, and no operand or shared DAG is duplicated.
          const matched = right?.value.id === expression.left.id ? right
            : left?.value.id === expression.right.id ? left : null;
          if (matched)
            replacement = { kind: 'integer', op: 'mul', left: matched.value,
              right: factor(value, matched.coefficient + 1n, block) };
        }
      }
      if (expression.kind === 'extract') {
        const source = expressions.get(expression.value.id),
          width = bitWidth(value.type);
        if (expression.offset === 0 && sameType(value.type, expression.value.type))
          replacement = { kind: 'cast', op: 'bitcast', value: expression.value };
        else if (source?.kind === 'extract')
          replacement = {
            kind: 'extract',
            value: source.value,
            offset: source.offset + expression.offset,
          };
        else if (
          source?.kind === 'cast' &&
          (source.op === 'zero_extend' || source.op === 'sign_extend') &&
          expression.offset + width <= bitWidth(source.value.type)
        )
          replacement = { kind: 'extract', value: source.value, offset: expression.offset };
        else if (
          source?.kind === 'insert' &&
          expression.offset >= source.offset &&
          expression.offset + width <= source.offset + bitWidth(source.value.type)
        )
          replacement = {
            kind: 'extract',
            value: source.value,
            offset: expression.offset - source.offset,
          };
        else if (
          expression.offset === 0 &&
          source?.kind === 'integer' &&
          ['add', 'sub', 'mul', 'and', 'or', 'xor'].includes(source.op)
        ) {
          const block = owner.get(id)!;
          replacement = {
            ...source,
            left: narrow(source.left, width, block),
            right: narrow(source.right, width, block),
          };
        } else if (source?.kind === 'concat') {
          let offset = 0;
          for (const part of source.values) {
            context.checkpoint(1);
            if (
              expression.offset >= offset &&
              expression.offset + width <= offset + bitWidth(part.type)
            ) {
              replacement = { kind: 'extract', value: part, offset: expression.offset - offset };
              break;
            }
            offset += bitWidth(part.type);
          }
        }
      } else if (expression.kind === 'concat' && expression.values.length) {
        let offset = 0,
          base: Value | null = null,
          complete = true;
        for (const part of expression.values) {
          const extraction = expressions.get(part.id);
          if (
            extraction?.kind !== 'extract' ||
            extraction.offset !== offset ||
            (base && base.id !== extraction.value.id)
          ) {
            complete = false;
            break;
          }
          base = extraction.value;
          offset += bitWidth(part.type);
        }
        if (complete && base && sameType(value.type, base.type))
          replacement = { kind: 'cast', op: 'bitcast', value: base };
        else if (
          expression.values.slice(1).every((part) => {
            const definition = expressions.get(part.id);
            return definition?.kind === 'constant' && definition.bits === 0n;
          })
        )
          replacement = { kind: 'cast', op: 'zero_extend', value: expression.values[0]! };
      }
      if (expression.kind === 'flag' && expression.op === 'add' && expression.flag === 'zero') {
        const right = expressions.get(expression.right.id),
          carry = expressions.get(expression.carry.id);
        if (right?.kind === 'constant' && carry?.kind === 'constant' && carry.bits === 0n) {
          const compared = make(
            `zero-add:${id}`,
            expression.left.type,
            owner.get(id)!,
            { kind: 'constant', bits: BigInt.asUintN(bitWidth(expression.left.type), -right.bits) },
            [value],
          );
          replacement = { kind: 'compare', op: 'eq', left: expression.left, right: compared };
        }
      }
      const operands = expressionOperands(replacement);
      context.checkpoint(operands.length);
      if (
        operands.length &&
        operands.every((operand) => expressions.get(operand.id)?.kind === 'constant')
      ) {
        const evaluated = evaluateExpression(value.type, replacement, (operand) => {
          const constant = expressions.get(operand.id)!;
          return constant.kind === 'constant'
            ? { kind: 'bits', bits: constant.bits }
            : { kind: 'unknown', reason: 'nonconstant source operand' };
        });
        if (evaluated.kind === 'bits') replacement = { kind: 'constant', bits: evaluated.bits };
      }
      // Only changed operand identities or a strictly reduced operation requeue.
      if (replacement !== expression || operandsChanged) {
        const checked = validation.check('bitvector', id, 'source expression rewrite', () =>
          validateBitvectorCandidate(value, original, replacement, expressions, validation.allowance));
        if (checked.status === 'rejected') {
          validation.rejectedRewrites.add(id);
          continue;
        }
        expressions.set(id, replacement);
        changed = true;
      }
    }
  }
}
