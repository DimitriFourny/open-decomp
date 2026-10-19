import type { OperationContext } from '../core/index.js';
import {
  bitWidth,
  evaluateExpression,
  type Expression,
  type RuntimeValue,
  type Value,
} from '../ir/index.js';
import type { BlockRegion } from '../presentation/index.js';
import type { Assignment } from './model.js';
import type { LocalValidationSession } from './local-validation.js';
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
        if (
          expression.op !== 'bitcast' &&
          expression.op !== 'truncate' &&
          expression.op !== 'zero_extend' &&
          expression.op !== 'sign_extend'
        )
          return unknown;
        break;
      default:
        return unknown;
    }
    if (
      expression.kind === 'address' &&
      imageId !== undefined &&
      expression.address.image_id !== imageId
    )
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
  const sameBytes = (left: SourceAddress, right: SourceAddress): boolean =>
    left.constant_bytes === right.constant_bytes ||
    (!!left.constant_bytes &&
      !!right.constant_bytes &&
      left.constant_bytes.length === right.constant_bytes.length &&
      left.constant_bytes.every((byte, index) => byte === right.constant_bytes![index]));
  for (const item of addresses) {
    context.checkpoint(1);
    const key = `${item.address.image_id}:${item.address.space}:${item.address.value}`;
    const existing = exact.get(key);
    if (existing === undefined) exact.set(key, item);
    else if (
      existing &&
      (existing.string !== item.string || existing.name !== item.name || !sameBytes(existing, item))
    )
      exact.set(key, null);
    if (item.address.space !== 'va') continue;
    const previous = byValue.get(item.address.value);
    if (previous === undefined) byValue.set(item.address.value, item);
    else if (
      previous &&
      (previous.address.image_id !== item.address.image_id ||
        previous.string !== item.string ||
        previous.name !== item.name ||
        !sameBytes(previous, item))
    )
      byValue.set(item.address.value, null);
  }
  const bits = sourceConstantValues(
    expressions,
    context,
    images.size === 1 ? [...images][0] : undefined,
  );
  // A value's exact/negative lookup is stable for this immutable expression and
  // address index. Mapping the same contributor to several spans must not
  // re-evaluate its transport graph each time.
  const resolved = new Map<string, SourceAddress | null>();
  return (value) => {
    context.checkpoint(0);
    const cached = resolved.get(value.id);
    if (cached !== undefined) return cached ?? undefined;
    const expression = expressions.get(value.id);
    let item: SourceAddress | null | undefined;
    if (expression?.kind === 'address') {
      const address = expression.address;
      item = exact.get(`${address.image_id}:${address.space}:${address.value}`);
    } else {
      const constant = bits(value);
      item = constant === undefined ? undefined : byValue.get(constant);
    }
    resolved.set(value.id, item ?? null);
    return item ?? undefined;
  };
}

/** Replace only image-proven, exact-width nonvolatile reads. The original
 * statements/effect graph stay in the analyzed program and checked view. */
export function projectSourceConstants(
  blocks: ReadonlyMap<string, BlockRegion>,
  expressions: Map<string, Expression>,
  assignments: Map<string, Assignment>,
  addresses: readonly SourceAddress[],
  context: OperationContext,
  validation: LocalValidationSession,
): ReadonlySet<string> {
  const hidden = new Set<string>();
  if (!addresses.some((item) => item.constant_bytes)) return hidden;
  const data = sourceDataValues(expressions, addresses, context);
  const constant = sourceConstantValues(
    expressions,
    context,
    addresses.length ? addresses[0]!.address.image_id : undefined,
  );
  // Read-only image bytes cannot be changed by a call or a store through an
  // unknown address (that store would fault), so only a store to a constant
  // address that overlaps the bytes read keeps the load.
  const writes: { address: bigint; size: bigint }[] = [];
  for (const block of blocks.values())
    for (const node of block.statements) {
      context.checkpoint(1);
      if (node.kind !== 'store') continue;
      const address = constant(node.address);
      if (address !== undefined)
        writes.push({ address, size: BigInt(Math.ceil(bitWidth(node.value.type) / 8)) });
    }
  for (const block of blocks.values())
    for (const node of block.statements) {
      context.checkpoint(1);
      if (
        node.kind !== 'load' ||
        node.access.volatile ||
        (node.result.type.kind !== 'integer' && node.result.type.kind !== 'float')
      )
        continue;
      const item = data(node.address),
        width = bitWidth(node.result.type);
      if (
        !item?.constant_bytes ||
        item.object?.mutable !== false ||
        width % 8 ||
        item.constant_bytes.length < width / 8 ||
        item.address.value % BigInt(node.access.alignment) !== 0n
      )
        continue;
      if (
        writes.some(
          (write) =>
            write.address < item.address.value + BigInt(width / 8) &&
            write.address + write.size > item.address.value,
        )
      )
        continue;
      const bytes = item.constant_bytes.slice(0, width / 8);
      if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) continue;
      let bits = 0n;
      for (let index = 0; index < bytes.length; index++)
        bits |=
          BigInt(bytes[index]!) <<
          BigInt(8 * (node.access.endian === 'little' ? index : bytes.length - 1 - index));
      if (
        !validation.presentation(
          'constant_pool_literal',
          node.id,
          'exact-width nonvolatile aligned load from immutable file-backed image bytes; no relocation or possible overlapping write',
          [node.id, node.result.id, node.address.id],
          `image ${item.address.image_id}, ${item.address.space} 0x${item.address.value.toString(16)}, bytes ${bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')}, ${node.access.endian}-endian`,
        )
      )
        continue;
      const expression: Expression = { kind: 'constant', bits };
      expressions.set(node.result.id, expression);
      assignments.set(node.result.id, { ...node, kind: 'assign', expression });
      hidden.add(node.id);
    }
  return hidden;
}
