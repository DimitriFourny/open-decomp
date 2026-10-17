import type { OperationContext } from '../core/index.js';
import { evaluateExpression, type Expression, type RuntimeValue, type Value } from '../ir/index.js';
import type { SourceAddress } from './source-model.js';

/** Evaluate only exact integer/address transport. No loads, relocation-slot reads,
 * pointer dereferences, float arithmetic or conjectured table elements are folded.
 */
export function sourceConstantValues(
  expressions: ReadonlyMap<string, Expression>,
  context: OperationContext,
  imageId?: string,
): (value: Value) => bigint | undefined {
  const memo = new Map<string, RuntimeValue>();
  const active = new Set<string>();
  const unknown: RuntimeValue = { kind: 'unknown', reason: 'No exact source data address' };
  const resolve = (value: Value): RuntimeValue => {
    context.checkpoint(1);
    const previous = memo.get(value.id);
    if (previous) return previous;
    if (value.type.kind !== 'integer' || active.has(value.id) || active.size >= 128) return unknown;
    const expression = expressions.get(value.id);
    if (!expression) return unknown;
    switch (expression.kind) {
      case 'constant':
      case 'address':
      case 'integer':
      case 'integer_unary':
      case 'extract':
      case 'insert':
      case 'concat':
      case 'select':
      case 'compare':
        break;
      case 'cast':
        if (expression.op !== 'bitcast' && expression.op !== 'truncate' &&
          expression.op !== 'zero_extend' && expression.op !== 'sign_extend') return unknown;
        break;
      default:
        return unknown;
    }
    if (expression.kind === 'address' && imageId !== undefined && expression.address.image_id !== imageId)
      return unknown;
    active.add(value.id);
    const result = evaluateExpression(value.type, expression, resolve);
    active.delete(value.id);
    memo.set(value.id, result);
    return result;
  };
  return (value) => {
    const result = resolve(value);
    return result.kind === 'bits' ? result.bits : undefined;
  };
}

/** Exact-address lookup only: a nearby literal is never a base for another object. */
export function sourceDataValues(
  expressions: ReadonlyMap<string, Expression>,
  addresses: readonly SourceAddress[],
  context: OperationContext,
): (value: Value) => SourceAddress | undefined {
  const byValue = new Map<bigint, SourceAddress | null>();
  const exact = new Map<string, SourceAddress | null>();
  const images = new Set(addresses.map((item) => item.address.image_id));
  for (const item of addresses) {
    context.checkpoint(1);
    const key = `${item.address.image_id}:${item.address.space}:${item.address.value}`;
    const existing = exact.get(key);
    if (existing === undefined) exact.set(key, item);
    else if (existing && (existing.string !== item.string || existing.name !== item.name))
      exact.set(key, null);
    if (item.address.space !== 'va') continue;
    const previous = byValue.get(item.address.value);
    if (previous === undefined) byValue.set(item.address.value, item);
    else if (previous && (previous.address.image_id !== item.address.image_id ||
      previous.string !== item.string || previous.name !== item.name)) byValue.set(item.address.value, null);
  }
  const bits = sourceConstantValues(expressions, context, images.size === 1 ? [...images][0] : undefined);
  return (value) => {
    const expression = expressions.get(value.id);
    if (expression?.kind === 'address') {
      const address = expression.address;
      return exact.get(`${address.image_id}:${address.space}:${address.value}`) ?? undefined;
    }
    const constant = bits(value);
    const item = constant === undefined ? undefined : byValue.get(constant);
    return item ?? undefined;
  };
}
