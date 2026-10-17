import type { OperationContext } from '../core/index.js';
import { bitWidth, sameType, type DataType, type Expression, type RegisterBinding, type Value } from '../ir/index.js';
import { identityOperand } from './expressions.js';

export interface RegisterTypeSlice {
  readonly type: DataType;
  /** Bit offset in the typed value represented by the low bit of this SSA cell. */
  readonly offset: number;
  readonly written: boolean;
}
export interface StorageCopy {
  readonly source: Value;
  readonly destination: Value;
}

interface RegisterTypeLinks {
  propagate(value: Value, slice: RegisterTypeSlice,
    note: (value: Value, type: DataType, offset: number, written: boolean) => void, context: OperationContext): void;
}

/** Structural physical-storage transport and original typed values for one
 * owned immutable stage. Call observations and propagated slices stay fresh. */
export interface RegisterTypeGraph {
  originalTypedValues(values: ReadonlyMap<string, Value>, expressions: ReadonlyMap<string, Expression>,
    copies: readonly StorageCopy[], context: OperationContext): readonly Value[];
  query(values: ReadonlyMap<string, Value>, expressions: ReadonlyMap<string, Expression>,
    copies: readonly StorageCopy[], context: OperationContext): RegisterTypeLinks;
}

export function createRegisterTypeGraph(
  values: ReadonlyMap<string, Value>,
  expressions: ReadonlyMap<string, Expression>,
  copies: readonly StorageCopy[],
): RegisterTypeGraph {
  let prepared: RegisterTypeLinks | undefined;
  let originalTypedValues: readonly Value[] | undefined;
  return Object.freeze({
    originalTypedValues(inputValues: ReadonlyMap<string, Value>, inputExpressions: ReadonlyMap<string, Expression>,
      inputCopies: readonly StorageCopy[], context: OperationContext): readonly Value[] {
      context.checkpoint(0);
      if (inputValues !== values || inputExpressions !== expressions || inputCopies !== copies)
        throw new TypeError('Register type graph belongs to a different storage stage');
      if (!originalTypedValues) {
        const typed: Value[] = [];
        for (const value of values.values())
          if (value.type.kind !== 'integer') typed.push(value);
        originalTypedValues = Object.freeze(typed);
      }
      return originalTypedValues;
    },
    query(inputValues: ReadonlyMap<string, Value>, inputExpressions: ReadonlyMap<string, Expression>,
      inputCopies: readonly StorageCopy[], context: OperationContext): RegisterTypeLinks {
      context.checkpoint(0);
      if (inputValues !== values || inputExpressions !== expressions || inputCopies !== copies)
        throw new TypeError('Register type graph belongs to a different storage stage');
      if (prepared) return prepared;
      const links = new Map<string, { readonly value: Value; readonly delta: number }[]>();
      const connect = (whole: Value, part: Value, offset: number): void => {
        context.checkpoint(1);
        const forward = links.get(whole.id) ?? [];
        forward.push({ value: part, delta: offset });
        links.set(whole.id, forward);
        const backward = links.get(part.id) ?? [];
        backward.push({ value: whole, delta: -offset });
        links.set(part.id, backward);
      };
      for (const [id, expression] of expressions) {
        context.checkpoint(1);
        const result = values.get(id);
        if (!result) continue;
        if (expression.kind === 'cast' && ['bitcast', 'truncate', 'zero_extend', 'sign_extend'].includes(expression.op))
          connect(expression.value, result, 0);
        else if (expression.kind === 'extract') connect(expression.value, result, expression.offset);
        else if (expression.kind === 'insert') connect(result, expression.value, expression.offset);
        else if (expression.kind === 'concat') {
          let offset = 0;
          for (const part of expression.values) {
            connect(result, part, offset);
            offset += bitWidth(part.type);
          }
        }
      }
      for (const copy of copies) connect(copy.source, copy.destination, 0);
      prepared = Object.freeze({
        propagate(value: Value, slice: RegisterTypeSlice,
          note: (value: Value, type: DataType, offset: number, written: boolean) => void, context: OperationContext): void {
          for (const link of links.get(value.id) ?? []) {
            context.checkpoint(1);
            note(link.value, slice.type, slice.offset + link.delta, slice.written);
          }
        },
      });
      return prepared;
    },
  });
}

/** Typed uses constrain storage slices, not the capacity of an architectural root.
 * Keep multiple interpretations: a scalar lane and its enclosing SIMD value are
 * different views, and neither can silently replace the other's return bank. */
export function registerTypeSlices(
  values: ReadonlyMap<string, Value>,
  expressions: ReadonlyMap<string, Expression>,
  copies: readonly StorageCopy[],
  callResults: Iterable<readonly Value[]>,
  context: OperationContext,
  additionalSlices?: Iterable<readonly [Value, RegisterTypeSlice]>,
  graph?: RegisterTypeGraph,
): ReadonlyMap<string, readonly RegisterTypeSlice[]> {
  context.checkpoint(0);
  const slices = new Map<string, RegisterTypeSlice[]>();
  const queue: { readonly value: Value; readonly slice: RegisterTypeSlice }[] = [];
  const note = (value: Value, type: DataType, offset: number, written: boolean): void => {
    if (offset < 0 || offset >= bitWidth(type)) return;
    const known = slices.get(value.id) ?? [];
    const index = known.findIndex((slice) => slice.offset === offset && sameType(slice.type, type));
    if (index >= 0 && (!written || known[index]!.written)) return;
    context.checkpoint(1);
    const slice = { type, offset, written };
    if (index < 0) known.push(slice);
    else known[index] = slice;
    slices.set(value.id, known);
    queue.push({ value, slice });
  };
  for (const value of graph ? graph.originalTypedValues(values, expressions, copies, context) : values.values()) {
    if (value.type.kind === 'integer') continue;
    const expression = expressions.get(value.id);
    const written = expression !== undefined && expression.kind !== 'extract' && expression.kind !== 'concat' &&
      (expression.kind !== 'cast' || !['bitcast', 'truncate', 'zero_extend', 'sign_extend'].includes(expression.op));
    note(value, value.type, 0, written);
  }
  for (const returned of callResults)
    for (const value of returned)
      if (value.type.kind !== 'integer') note(value, value.type, 0, true);
  for (const [value, slice] of additionalSlices ?? [])
    note(value, slice.type, slice.offset, slice.written);
  // Without a typed observation there is nothing to propagate. Enumerate every
  // original seed source before allocating the physical-storage adjacency.
  if (queue.length === 0) {
    context.checkpoint(0);
    return slices;
  }
  const links = (graph ?? createRegisterTypeGraph(values, expressions, copies)).query(values, expressions, copies, context);
  for (let index = 0; index < queue.length; index++) {
    const { value, slice } = queue[index]!;
    links.propagate(value, slice, note, context);
  }
  return slices;
}

/** A type is available only if every physical slice covering its meaningful bits
 * agrees on lane offsets. Scalar results never acquire unrelated high SIMD bits. */
export function registerTypes(
  bindings: readonly RegisterBinding[],
  root: string,
  offset: number,
  slices: ReadonlyMap<string, readonly RegisterTypeSlice[]>,
  context: OperationContext,
  requireWritten = false,
): readonly DataType[] {
  const cells = bindings.filter((binding) => binding.register.root === root)
    .sort((left, right) => left.register.offset_bits - right.register.offset_bits);
  const low = cells.find((binding) => binding.register.offset_bits === offset);
  if (!low) return [];
  const result: DataType[] = [];
  for (const candidate of slices.get(low.value.id) ?? []) {
    if (candidate.offset !== 0 || result.some((type) => sameType(type, candidate.type))) continue;
    const end = offset + bitWidth(candidate.type);
    let cursor = offset, written = false;
    for (const binding of cells) {
      context.checkpoint(1);
      if (binding.register.root !== root || binding.register.offset_bits >= end ||
          binding.register.offset_bits + binding.register.width_bits <= offset) continue;
      if (binding.register.offset_bits !== cursor) break;
      const view = slices.get(binding.value.id)?.find((slice) =>
        sameType(slice.type, candidate.type) && slice.offset === cursor - offset);
      if (!view) break;
      written ||= view.written;
      cursor = Math.min(end, cursor + binding.register.width_bits);
      if (cursor === end) break;
    }
    if (cursor === end && (!requireWritten || written)) result.push(candidate.type);
  }
  // Prefer the complete meaningful view, then FP interpretation over integer
  // packing artifacts such as MOVI's one-lane zero initialization.
  result.sort((left, right) => bitWidth(right) - bitWidth(left) ||
    Number(right.kind === 'float' || (right.kind === 'vector' && right.element.kind === 'float')) -
    Number(left.kind === 'float' || (left.kind === 'vector' && left.element.kind === 'float')));
  return result;
}

/** Prove unchanged incoming storage through lossless aliases and phi transport.
 * Cyclic phis are allowed only when their complete leaf set is this entry value. */
export function unchangedStorage(
  value: Value,
  incoming: string | undefined,
  expressions: ReadonlyMap<string, Expression>,
  sources: ReadonlyMap<string, readonly Value[]>,
  context: OperationContext,
): boolean {
  if (!incoming) return false;
  const pending = [value], seen = new Set<string>();
  let reached = false;
  while (pending.length) {
    context.checkpoint(1);
    const current = pending.pop()!;
    if (current.id === incoming) { reached = true; continue; }
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    const expression = expressions.get(current.id);
    const alias = expression && identityOperand(current.type, expression);
    if (alias) pending.push(alias);
    else {
      const operands = sources.get(current.id);
      if (!operands?.length) return false;
      pending.push(...operands);
    }
  }
  return reached;
}
