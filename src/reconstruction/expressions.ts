import {
  bitWidth,
  evaluateExpression,
  expressionOperands,
  sameType,
  type Expression,
  type IntegerPredicate,
  type Value,
} from '../ir/index.js';
import type { OperationContext } from '../core/index.js';
import type { Assignment } from './model.js';

const inverse: Record<IntegerPredicate, IntegerPredicate> = {
  eq: 'ne',
  ne: 'eq',
  ult: 'uge',
  ule: 'ugt',
  ugt: 'ule',
  uge: 'ult',
  slt: 'sge',
  sle: 'sgt',
  sgt: 'sle',
  sge: 'slt',
};
export function identityOperand(type: Value['type'], expression: Expression): Value | null {
  return expression.kind === 'cast' &&
    expression.op === 'bitcast' &&
    sameType(type, expression.value.type)
    ? expression.value
    : null;
}
/** Rewrites only pure SSA expressions. No load, effect, or mutable physical name
 * enters this algebra. In particular x-x and x*0 retain unknown operands. */
export function foldExpressions(
  assignments: ReadonlyMap<string, Assignment>,
  context: OperationContext,
): Map<string, Expression> {
  const expressions = new Map<string, Expression>();
  const users = new Map<string, Set<string>>();
  let current = '';
  const observe = (id: string): Expression | undefined => {
    if (current) {
      const list = users.get(id) ?? new Set<string>();
      list.add(current);
      users.set(id, list);
    }
    return expressions.get(id);
  };
  for (const [id, node] of assignments) {
    context.checkpoint(1);
    expressions.set(id, node.expression);
  }
  // Match through identity casts without manufacturing nested expressions. Every
  // inspected definition is a dependency, including ones exposed by later folds.
  const resolve = (value: Value): Value => {
    const seen = new Set<string>();
    while (!seen.has(value.id)) {
      context.checkpoint(1);
      seen.add(value.id);
      const e = observe(value.id),
        next = e && identityOperand(value.type, e);
      if (!next) break;
      value = next;
    }
    return value;
  };
  const constant = (value: Value): bigint | null => {
    const e = observe(resolve(value).id);
    return e?.kind === 'constant' ? BigInt.asUintN(bitWidth(value.type), e.bits) : null;
  };
  const alias = (value: Value): Expression => ({ kind: 'cast', op: 'bitcast', value });
  const subtraction = (value: Value): Extract<Expression, { kind: 'integer' }> | null => {
    const e = observe(resolve(value).id);
    return e?.kind === 'integer' && e.op === 'sub' ? e : null;
  };
  const flag = (
    value: Value,
  ): Pick<Extract<Expression, { kind: 'flag' }>, 'flag' | 'left' | 'right'> | null => {
    value = resolve(value);
    const e = observe(value.id);
    if (e?.kind === 'flag' && e.op === 'sub' && constant(e.carry) === 0n)
      return { flag: e.flag, left: resolve(e.left), right: resolve(e.right) };
    if (
      e?.kind === 'extract' &&
      bitWidth(value.type) === 1 &&
      e.offset === bitWidth(e.value.type) - 1
    ) {
      const sub = subtraction(e.value);
      if (sub) return { flag: 'negative', left: resolve(sub.left), right: resolve(sub.right) };
    }
    return null;
  };
  const comparison = (value: Value): Extract<Expression, { kind: 'compare' }> | null => {
    const e = observe(resolve(value).id);
    return e?.kind === 'compare' ? { ...e, left: resolve(e.left), right: resolve(e.right) } : null;
  };
  // Strict total expressions propagate the first indeterminate operand. Preserve
  // that ordered dependency list, not merely its set: unknown/undefined reasons
  // and precedence are observable. Partial operations and lazy selects are
  // opaque leaves, so their own undefined results cannot be silently discarded.
  const taints = (value: Value): string[] => {
    const result: string[] = [],
      seen = new Set<string>(),
      pending = [value];
    while (pending.length) {
      context.checkpoint(1);
      const item = pending.pop()!;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const e = observe(item.id);
      if (e?.kind === 'constant' || e?.kind === 'address') continue;
      const total =
        e &&
        ((e.kind === 'integer' && !['udiv', 'urem', 'sdiv', 'srem'].includes(e.op)) ||
          e.kind === 'integer_unary' ||
          e.kind === 'compare' ||
          e.kind === 'flag' ||
          e.kind === 'extract' ||
          e.kind === 'insert' ||
          (e.kind === 'cast' &&
            ['bitcast', 'truncate', 'zero_extend', 'sign_extend'].includes(e.op)));
      if (!total) {
        result.push(item.id);
        continue;
      }
      const operands = expressionOperands(e);
      for (let index = operands.length - 1; index >= 0; index--) pending.push(operands[index]!);
    }
    return result;
  };
  const sameTaints = (left: Value, right: Value): boolean => {
    const a = taints(left),
      b = taints(right);
    return a.length === b.length && a.every((id, index) => id === b[index]);
  };
  const unpack = (type: Value['type'], value: Value, offset: number): Expression | null => {
    const original = value,
      seen = new Set<string>();
    while (!seen.has(value.id)) {
      context.checkpoint(1);
      seen.add(value.id);
      const resolved = resolve(value),
        e = observe(resolved.id);
      if (e?.kind !== 'insert') break;
      const end = offset + bitWidth(type),
        insertedEnd = e.offset + bitWidth(e.value.type);
      if (offset >= e.offset && end <= insertedEnd) {
        if (!sameTaints(original, e.value)) return null;
        return offset === e.offset && sameType(type, e.value.type)
          ? alias(e.value)
          : { kind: 'extract', value: e.value, offset: offset - e.offset };
      }
      if (end > e.offset && offset < insertedEnd) break;
      value = e.base;
    }
    return value.id !== original.id && sameTaints(original, value)
      ? { kind: 'extract', value, offset }
      : null;
  };
  const simplify = (node: Assignment, e: Expression): Expression => {
    const operands = expressionOperands(e);
    if (
      e.kind !== 'constant' &&
      e.kind !== 'address' &&
      e.kind !== 'indeterminate' &&
      node.result.type.kind === 'integer' &&
      operands.every((value) => value.type.kind === 'integer' && constant(value) !== null)
    ) {
      const result = evaluateExpression(node.result.type, e, (value) => ({
        kind: 'bits',
        bits: constant(value)!,
      }));
      if (result.kind === 'bits') return { kind: 'constant', bits: result.bits };
      // Keep undefined operations explicit, including division by zero.
    }
    if (e.kind === 'flag' && e.op === 'sub' && constant(e.carry) === 0n) {
      const op =
        e.flag === 'zero' ? 'eq' : e.flag === 'carry' ? 'uge' : e.flag === 'borrow' ? 'ult' : null;
      if (op) return { kind: 'compare', op, left: e.left, right: e.right };
    }
    if (e.kind === 'integer') {
      const a = constant(e.left),
        b = constant(e.right);
      if (
        sameType(node.result.type, e.left.type) &&
        ((b === 0n &&
          ['add', 'sub', 'or', 'xor', 'shl', 'lshr', 'ashr', 'rol', 'ror'].includes(e.op)) ||
          (b === 1n && ['mul', 'udiv'].includes(e.op)) ||
          (b === (1n << BigInt(bitWidth(e.left.type))) - 1n && e.op === 'and'))
      )
        return alias(e.left);
      if (
        sameType(node.result.type, e.right.type) &&
        ((a === 0n && ['add', 'or', 'xor'].includes(e.op)) || (a === 1n && e.op === 'mul'))
      )
        return alias(e.right);
      if (node.result.type.kind === 'integer' && node.result.type.bits === 1) {
        const leftFlag = flag(e.left),
          rightFlag = flag(e.right);
        if (
          e.op === 'xor' &&
          leftFlag &&
          rightFlag &&
          leftFlag.left.id === rightFlag.left.id &&
          leftFlag.right.id === rightFlag.right.id &&
          new Set([leftFlag.flag, rightFlag.flag]).size === 2 &&
          [leftFlag.flag, rightFlag.flag].every(
            (item) => item === 'negative' || item === 'overflow',
          )
        )
          return { kind: 'compare', op: 'slt', left: leftFlag.left, right: leftFlag.right };
        const left = comparison(e.left),
          right = comparison(e.right);
        if (e.op === 'xor' && b === 1n && left) return { ...left, op: inverse[left.op] };
        if (e.op === 'xor' && a === 1n && right) return { ...right, op: inverse[right.op] };
        if (left && right && left.left.id === right.left.id && left.right.id === right.right.id) {
          const pair = new Set([left.op, right.op]);
          if (e.op === 'or' && pair.has('eq')) {
            if (pair.has('ult')) return { ...left, op: 'ule' };
            if (pair.has('slt')) return { ...left, op: 'sle' };
          }
          if (e.op === 'and' && pair.has('ne')) {
            if (pair.has('uge')) return { ...left, op: 'ugt' };
            if (pair.has('sge')) return { ...left, op: 'sgt' };
          }
        }
      }
    }
    if (
      e.kind === 'integer_unary' &&
      e.op === 'not' &&
      bitWidth(node.result.type) === 1 &&
      bitWidth(e.value.type) === 1
    ) {
      const value = comparison(e.value);
      if (value) return { ...value, op: inverse[value.op] };
    }
    if (e.kind === 'compare' && (e.op === 'eq' || e.op === 'ne')) {
      const a = comparison(e.left),
        b = constant(e.right);
      const sub = subtraction(e.left);
      if (sub && b === 0n) return { kind: 'compare', op: e.op, left: sub.left, right: sub.right };
      if (a && (b === 0n || b === 1n))
        return { ...a, op: (e.op === 'eq') === (b === 1n) ? a.op : inverse[a.op] };
      const left = flag(e.left),
        right = flag(e.right);
      if (
        left &&
        right &&
        left.left.id === right.left.id &&
        left.right.id === right.right.id &&
        new Set([left.flag, right.flag]).size === 2 &&
        [left.flag, right.flag].every((item) => item === 'negative' || item === 'overflow')
      )
        return {
          kind: 'compare',
          op: e.op === 'eq' ? 'sge' : 'slt',
          left: left.left,
          right: left.right,
        };
    }
    if (e.kind === 'select') {
      const condition = constant(e.condition);
      if (condition !== null) return alias(condition === 0n ? e.when_false : e.when_true);
    }
    if (
      e.kind === 'cast' &&
      sameType(node.result.type, e.value.type) &&
      ['truncate', 'zero_extend', 'sign_extend'].includes(e.op)
    )
      return alias(e.value);
    if (e.kind === 'cast' && ['truncate', 'zero_extend', 'sign_extend'].includes(e.op)) {
      const source = observe(resolve(e.value).id);
      if (source?.kind === 'cast') {
        if (sameType(node.result.type, source.value.type) && e.op === 'truncate' &&
          (source.op === 'zero_extend' || source.op === 'sign_extend'))
          return alias(source.value);
        if (e.op === source.op && (e.op === 'zero_extend' || e.op === 'sign_extend'))
          return { ...e, value: source.value };
      }
    }
    if (e.kind === 'extract' && e.offset === 0 && sameType(node.result.type, e.value.type))
      return alias(e.value);
    if (e.kind === 'extract') {
      const source = observe(resolve(e.value).id);
      if (source?.kind === 'extract')
        return { kind: 'extract', value: source.value, offset: source.offset + e.offset };
      if (source?.kind === 'cast' &&
        ['truncate', 'zero_extend', 'sign_extend'].includes(source.op) &&
        e.offset + bitWidth(node.result.type) <= bitWidth(source.value.type))
        return e.offset === 0 && sameType(node.result.type, source.value.type)
          ? alias(source.value)
          : { kind: 'extract', value: source.value, offset: e.offset };
      const unpacked = unpack(node.result.type, e.value, e.offset);
      if (unpacked) return unpacked;
    }
    if (e.kind === 'concat' && e.values.length) {
      // Recompose before source-width distribution rewrites the low slice of an
      // arithmetic result. Keeping its original full-width value preserves carry
      // bits and avoids exposing independently recomputed register-cell halves.
      let offset = 0, base: Value | undefined;
      for (const part of e.values) {
        context.checkpoint(1);
        const value = resolve(part), source = observe(value.id);
        if (source?.kind !== 'extract' || source.offset !== offset) return e;
        const original = resolve(source.value);
        if (base && base.id !== original.id) return e;
        base = original;
        offset += bitWidth(part.type);
      }
      if (base && sameType(node.result.type, base.type)) return alias(base);
    }
    return e;
  };
  const pending = [...assignments.keys()],
    queued = new Set(pending);
  for (let cursor = 0; cursor < pending.length; cursor++) {
    context.checkpoint(1);
    const id = pending[cursor]!;
    queued.delete(id);
    current = id;
    const node = assignments.get(id)!,
      before = expressions.get(id)!;
    for (const value of expressionOperands(before)) observe(value.id);
    const after = simplify(node, before);
    // Rewrites only remove expression structure; an equal fresh object is not
    // progress (and must not perpetually reschedule a cyclic dependency).
    const beforeFields = before as unknown as Readonly<Record<string, unknown>>;
    if (
      after === before ||
      (after.kind === before.kind &&
        Object.entries(after).every(([key, a]: [string, unknown]) => {
          const b = beforeFields[key];
          return (
            a === b ||
            (typeof a === 'object' &&
              a !== null &&
              typeof b === 'object' &&
              b !== null &&
              'id' in a &&
              'id' in b &&
              a.id === b.id)
          );
        }))
    )
      continue;
    expressions.set(id, after);
    for (const value of expressionOperands(after)) observe(value.id);
    for (const user of users.get(id) ?? [])
      if (!queued.has(user)) {
        queued.add(user);
        pending.push(user);
      }
  }
  return expressions;
}
