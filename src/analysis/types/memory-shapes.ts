import {
  entityIdentity,
  fingerprint,
  type CanonicalValue,
  type Evidence,
  type OperationContext,
  type RecoveredType,
} from '../../core/index.js';
import { bitWidth, successors, type Expression, type SSAForm, type Value } from '../../ir/index.js';
import { AnalysisBudget } from '../ssa/budget.js';
import { typeKey } from './layout.js';
import type {
  MemoryShape,
  ObjectAllocation,
  ObservedField,
  SuppliedTypeRecord,
  TypeAssociation,
  TypeConflict,
  TypeRecoveryResult,
} from './model.js';

/** A callee view associated with one observed physical argument, not a prototype. */
export interface NativeParameterShape {
  readonly parameter_index: number;
  readonly parameter_shape: MemoryShape;
  readonly types: readonly SuppliedTypeRecord[];
  readonly associations: readonly TypeAssociation[];
  readonly evidence: readonly Evidence[];
  readonly conflicts?: readonly TypeConflict[];
}
export interface MemoryShapeTransfer extends NativeParameterShape {
  readonly argument: Value;
  readonly call_id: string;
  readonly evidence_ids: readonly string[];
}
export interface MemoryShapeRefinementOptions {
  readonly slice_id: string;
  readonly revision: number;
  readonly max_work?: number;
  readonly transfers: readonly MemoryShapeTransfer[];
}
export interface MemoryShapeParameter {
  readonly parameter_index: number;
  readonly value: Value;
}

/** Portable existing-type closure for observed pointer arguments only. An
 * incoming-register dependency is not enough to assert pointer alias identity.
 * Exhaustion throws to the native unit's bounded/truncated-summary boundary. */
export function parameterMemoryShapes(
  recovery: TypeRecoveryResult,
  parameters: readonly MemoryShapeParameter[],
  context: OperationContext,
  options: { readonly max_work?: number } = {},
): readonly NativeParameterShape[] {
  const budget = new AnalysisBudget({
    max_work: options.max_work ?? 1_000_000,
    checkpoint: (work) => context.checkpoint(work),
  });
  budget.charge();
  if (recovery.state !== 'complete' || parameters.length === 0) return [];
  const byBase = new Map<string, number[]>();
  for (const parameter of parameters) {
    budget.charge();
    const list = byBase.get(parameter.value.id) ?? [];
    list.push(parameter.parameter_index);
    byBase.set(parameter.value.id, list);
  }
  const records = new Map<string, SuppliedTypeRecord[]>();
  for (const record of recovery.types) {
    budget.charge(record.definition.kind === 'structure' ? record.definition.fields.length + 1 : 1);
    const list = records.get(record.id) ?? [];
    list.push(record);
    records.set(record.id, list);
  }
  const bindings = new Map<string, TypeAssociation[]>();
  for (const association of recovery.associations) {
    budget.charge();
    const list = bindings.get(association.subject_id) ?? [];
    list.push(association);
    bindings.set(association.subject_id, list);
  }
  const proofs = new Map<string, Evidence>();
  for (const proof of recovery.evidence) {
    budget.charge();
    proofs.set(proof.id, proof);
  }
  const result: NativeParameterShape[] = [];
  for (const shape of recovery.shapes) {
    budget.charge(shape.fields.length + 1);
    if (shape.base.kind !== 'value') continue;
    const indices = byBase.get(shape.base.value_id);
    if (!indices?.length) continue;
    const associations = shape.fields.flatMap((field) => bindings.get(field.id) ?? []);
    budget.charge(associations.length);
    const pendingTypes = [shape.type_id, ...associations.map((association) => association.type_id)];
    const typeIds = new Set<string>(),
      types: SuppliedTypeRecord[] = [];
    for (let cursor = 0; cursor < pendingTypes.length; cursor++) {
      budget.charge();
      const type_id = pendingTypes[cursor]!;
      if (typeIds.has(type_id)) continue;
      typeIds.add(type_id);
      for (const record of records.get(type_id) ?? []) {
        budget.charge();
        types.push(record);
        const definition = record.definition;
        if (definition.kind === 'pointer') pendingTypes.push(definition.to);
        else if (definition.kind === 'array' || definition.kind === 'vector')
          pendingTypes.push(definition.element);
        else if (definition.kind === 'structure')
          for (const field of definition.fields) {
            budget.charge();
            pendingTypes.push(field.type_id);
          }
      }
    }
    const pendingProofs = [
      ...shape.evidence_ids,
      ...types.flatMap((record) => record.evidence_ids),
      ...associations.flatMap((association) => association.evidence_ids),
    ];
    const evidenceIds = new Set<string>(),
      evidence: Evidence[] = [];
    for (let cursor = 0; cursor < pendingProofs.length; cursor++) {
      budget.charge();
      const proof_id = pendingProofs[cursor]!;
      if (evidenceIds.has(proof_id)) continue;
      evidenceIds.add(proof_id);
      const proof = proofs.get(proof_id);
      if (!proof) continue;
      budget.charge(proof.derived_from.length + proof.conflicts_with.length);
      evidence.push(proof);
      pendingProofs.push(...proof.derived_from, ...proof.conflicts_with);
    }
    const relatedSubjects = new Set([
      shape.id,
      shape.type_id,
      ...typeIds,
      ...shape.fields.map((field) => field.id),
    ]);
    const conflicts = recovery.conflicts.filter((conflict) => {
      budget.charge();
      return relatedSubjects.has(conflict.subject_id);
    });
    for (const parameter_index of indices) {
      budget.charge();
      result.push({
        parameter_index,
        parameter_shape: shape,
        types,
        associations,
        evidence,
        conflicts,
      });
    }
  }
  return result;
}
export interface AffineAddress {
  readonly base: string;
  readonly offset: bigint;
  readonly stride: bigint | null;
  /** A same-loop counter `k` with address `base + offset + k * stride` exactly. */
  readonly index?: string;
}

/** Exact incoming SSA copies only; dependencies of arithmetic are not aliases. */
export function memoryAddressSources(
  input: SSAForm,
  budget: AnalysisBudget,
): ReadonlyMap<string, readonly Value[]> {
  const blocks = new Map(input.blocks.map((block) => [block.id, block]));
  const sources = new Map<string, Value[]>();
  for (const block of input.blocks)
    for (const edge of successors(block.terminator)) {
      budget.charge();
      const target = blocks.get(edge.target);
      if (!target) continue;
      for (const [index, value] of edge.arguments.entries()) {
        budget.charge();
        const parameter = target.parameters[index];
        if (!parameter || bitWidth(parameter.type) !== bitWidth(value.type)) continue;
        const list = sources.get(parameter.id) ?? [];
        list.push(value);
        sources.set(parameter.id, list);
      }
    }
  return sources;
}

/** Every block parameter with its owning block (loop-variable identity). */
export function memoryLoopParameters(
  input: SSAForm,
  budget: AnalysisBudget,
): ReadonlyMap<string, { readonly block: string; readonly value: Value }> {
  const result = new Map<string, { block: string; value: Value }>();
  for (const block of input.blocks)
    for (const value of block.parameters) {
      budget.charge();
      result.set(value.id, { block: block.id, value });
    }
  return result;
}

/** Lossless constituent bits used when a source pointer spans entry SSA cells.
 * Offsets are within the source pointer, not machine-register displacements. */
export function memoryPointerFragments(
  value: Value,
  definitions: ReadonlyMap<string, Expression>,
  budget: AnalysisBudget,
): readonly { readonly value: Value; readonly offset: number; readonly width: number }[] {
  const result: { value: Value; offset: number; width: number }[] = [];
  const pending = [{ value, offset: 0, depth: 0 }];
  while (pending.length) {
    budget.charge();
    const current = pending.pop()!,
      expression = definitions.get(current.value.id);
    if (expression?.kind === 'concat' && current.depth < 64) {
      let offset = current.offset;
      for (const part of expression.values) {
        budget.charge();
        pending.push({ value: part, offset, depth: current.depth + 1 });
        offset += bitWidth(part.type);
      }
    } else if (
      current.depth < 64 &&
      ((expression?.kind === 'extract' && expression.offset === 0) ||
        (expression?.kind === 'cast' && expression.op === 'bitcast')) &&
      bitWidth(expression.value.type) === bitWidth(current.value.type)
    )
      pending.push({ value: expression.value, offset: current.offset, depth: current.depth + 1 });
    else
      result.push({
        value: current.value,
        offset: current.offset,
        width: bitWidth(current.value.type),
      });
  }
  return result;
}

/** One owning normalization for local extraction and interprocedural actuals.
 * Arithmetic remains modulo the machine address width; dynamic counts and
 * multiple independent scaled indices are never inferred as a constant extent. */
export function createAffineResolver(
  definitions: ReadonlyMap<string, Expression>,
  constant: (id: string) => bigint | undefined,
  budget: AnalysisBudget,
  sources?: ReadonlyMap<string, readonly Value[]>,
  /** Block parameters with their owning block, for loop induction recovery. */
  parameters?: ReadonlyMap<string, { readonly block: string; readonly value: Value }>,
): (value: Value) => AffineAddress {
  const cache = new Map<string, AffineAddress>();
  const concatenations = new Map<string, string>();
  for (const [id, expression] of definitions) {
    budget.charge();
    if (expression.kind !== 'concat') continue;
    const key = expression.values
      .map((value) => {
        budget.charge();
        return `${value.id}:${bitWidth(value.type)}`;
      })
      .join(',');
    if (!concatenations.has(key)) concatenations.set(key, id);
  }
  const known = (id: string): bigint | undefined => {
    const expression = definitions.get(id);
    return constant(id) ?? (expression?.kind === 'constant' ? expression.bits : undefined);
  };
  type Incoming = { readonly constant: bigint } | { readonly value: Value };
  interface LoopVariable {
    readonly block: string;
    readonly key: string;
    readonly edges: readonly Incoming[];
  }
  interface Induction {
    readonly initial: bigint;
    readonly stride: bigint;
    readonly step: bigint;
    readonly loop: LoopVariable;
  }
  const concatKey = (expression: Extract<Expression, { kind: 'concat' }>): string =>
    `concat:${expression.values.map((part) => `${part.id}:${bitWidth(part.type)}`).join(',')}`;
  /** One loop variable held whole, or as exact register cells of one block. */
  const variableKey = (value: Value): string => {
    const expression = definitions.get(value.id);
    return expression?.kind === 'concat' ? concatKey(expression) : value.id;
  };
  /** Whole 64-bit incoming values of a block parameter, or of a concatenation
   * of same-block parameters whose cells arrive as constants or as exact
   * extracts of one whole value on every edge. */
  const loopVariable = (value: Value): LoopVariable | undefined => {
    if (!parameters) return undefined;
    const expression = definitions.get(value.id);
    const incoming = (item: Value): Incoming => {
      const bits = known(item.id);
      return bits === undefined ? { value: item } : { constant: BigInt.asUintN(64, bits) };
    };
    if (!expression) {
      const list = sources?.get(value.id),
        block = parameters.get(value.id)?.block;
      return list && block && list.length >= 2
        ? { block, key: value.id, edges: list.map(incoming) }
        : undefined;
    }
    if (expression.kind !== 'concat') return undefined;
    const block = parameters.get(expression.values[0]?.id ?? '')?.block;
    const parts = expression.values.map((part) =>
      parameters.get(part.id)?.block === block ? sources?.get(part.id) : undefined,
    );
    const count = parts[0]?.length ?? 0;
    if (!block || count < 2 || parts.some((list) => list?.length !== count)) return undefined;
    const edges: Incoming[] = [];
    for (let edge = 0; edge < count; edge++) {
      budget.charge(parts.length);
      let offset = 0,
        bits: bigint | undefined = 0n,
        whole: Value | undefined;
      for (const [index, list] of parts.entries()) {
        const item = list![edge]!,
          width = bitWidth(expression.values[index]!.type);
        const cell = known(item.id),
          fragment = definitions.get(item.id);
        if (bits !== undefined && cell !== undefined)
          bits |= BigInt.asUintN(width, cell) << BigInt(offset);
        else if (
          fragment?.kind === 'extract' &&
          fragment.offset === offset &&
          bitWidth(fragment.value.type) === 64 &&
          (index === 0 || whole?.id === fragment.value.id)
        ) {
          whole = fragment.value;
          bits = undefined;
        } else return undefined;
        offset += width;
      }
      if (offset !== 64) return undefined;
      edges.push(whole ? { value: whole } : { constant: bits! });
    }
    return { block, key: concatKey(expression), edges };
  };
  /** Signed step of one incoming value `variable ± c`. */
  const delta = (item: Value, key: string): bigint | undefined => {
    const next = definitions.get(item.id);
    if (next?.kind !== 'integer' || (next.op !== 'add' && next.op !== 'sub')) return undefined;
    const left = known(next.left.id),
      right = known(next.right.id);
    if (right !== undefined && variableKey(next.left) === key)
      return (next.op === 'add' ? 1n : -1n) * BigInt.asIntN(64, right);
    if (next.op === 'add' && left !== undefined && variableKey(next.right) === key)
      return BigInt.asIntN(64, left);
    return undefined;
  };
  /** Every entry edge carries one constant and every other incoming value is
   * exactly the variable plus one constant step. */
  const loopInduction = (value: Value): Induction | undefined => {
    const loop = bitWidth(value.type) === 64 ? loopVariable(value) : undefined;
    if (!loop) return undefined;
    let initial: bigint | undefined, step: bigint | undefined;
    for (const item of loop.edges) {
      budget.charge();
      if ('constant' in item) {
        const start = BigInt.asIntN(64, item.constant);
        if (initial !== undefined && initial !== start) return undefined;
        initial = start;
        continue;
      }
      const next = delta(item.value, loop.key);
      if (next === undefined || (step !== undefined && step !== next)) return undefined;
      step = next;
    }
    const stride = step === undefined ? 0n : step < 0n ? -step : step;
    return initial !== undefined && step !== undefined && stride > 0n && stride <= 65536n
      ? { initial, stride, step, loop }
      : undefined;
  };
  const inductions = new Map<string, Induction | null>();
  /** A loop induction variable, optionally used with a constant addend. */
  const induction = (value: Value, depth = 0): Induction | undefined => {
    budget.charge();
    if (inductions.has(value.id)) return inductions.get(value.id) ?? undefined;
    let result: Induction | null = null;
    const expression = definitions.get(value.id);
    if (
      depth < 8 &&
      expression?.kind === 'integer' &&
      (expression.op === 'add' || expression.op === 'sub')
    ) {
      const left = known(expression.left.id),
        right = known(expression.right.id);
      const inner =
        right !== undefined
          ? induction(expression.left, depth + 1)
          : left !== undefined && expression.op === 'add'
            ? induction(expression.right, depth + 1)
            : undefined;
      const addend =
        right !== undefined
          ? (expression.op === 'add' ? 1n : -1n) * BigInt.asIntN(64, right)
          : BigInt.asIntN(64, left ?? 0n);
      if (inner) result = { ...inner, initial: BigInt.asIntN(64, inner.initial + addend) };
    } else result = loopInduction(value) ?? null;
    if (result && (result.initial < -65536n || result.initial > 65536n)) result = null;
    inductions.set(value.id, result);
    return result ?? undefined;
  };
  let loopCandidates: Map<string, Value[]> | undefined;
  /** A same-loop counter `k` (0 on every entry, +1 on every repeat edge) moving
   * in lockstep with a positive-step induction: the variable is exactly
   * `initial + step * k` modulo 2^64 at every point both are defined. */
  const counter = (variable: Induction): string | undefined => {
    if (variable.step <= 0n || !parameters) return undefined;
    if (!loopCandidates) {
      loopCandidates = new Map();
      for (const { block, value } of parameters.values())
        if (bitWidth(value.type) === 64) {
          budget.charge();
          const list = loopCandidates.get(block) ?? [];
          list.push(value);
          loopCandidates.set(block, list);
        }
      for (const [id, expression] of definitions) {
        budget.charge();
        const block = parameters.get(
          expression.kind === 'concat' ? (expression.values[0]?.id ?? '') : '',
        )?.block;
        if (!block || expression.kind !== 'concat') continue;
        const list = loopCandidates.get(block) ?? [];
        list.push({ id, type: { kind: 'integer', bits: 64 } });
        loopCandidates.set(block, list);
      }
    }
    for (const candidate of loopCandidates.get(variable.loop.block) ?? []) {
      budget.charge();
      const index = loopInduction(candidate);
      if (
        !index ||
        index.loop.key === variable.loop.key ||
        index.initial !== 0n ||
        index.step !== 1n ||
        index.loop.edges.length !== variable.loop.edges.length ||
        index.loop.edges.some(
          (edge, position) => 'constant' in edge !== 'constant' in variable.loop.edges[position]!,
        )
      )
        continue;
      return candidate.id;
    }
    return undefined;
  };
  const affine = (value: Value, active = new Set<string>()): AffineAddress => {
    budget.charge();
    const cached = cache.get(value.id);
    if (cached) return cached;
    const fallback: AffineAddress = { base: value.id, offset: 0n, stride: null };
    if (active.has(value.id) || active.size >= 64 || bitWidth(value.type) !== 64) return fallback;
    active.add(value.id);
    const expression = definitions.get(value.id);
    let result = fallback;
    const incoming = expression ? undefined : sources?.get(value.id);
    if (incoming?.length) {
      const candidates = incoming
        .filter((source) => source.id !== value.id)
        .map((source) => affine(source, active));
      const first = candidates[0];
      if (
        first &&
        candidates.every(
          (candidate) =>
            candidate.base === first.base &&
            candidate.offset === first.offset &&
            candidate.stride === first.stride,
        )
      )
        result = first;
    } else if (expression?.kind === 'concat') {
      let source: Value | undefined,
        offset = 0,
        exact = true;
      for (const part of expression.values) {
        budget.charge();
        const fragment = definitions.get(part.id);
        if (
          fragment?.kind !== 'extract' ||
          fragment.offset !== offset ||
          bitWidth(fragment.value.type) !== 64 ||
          (source && fragment.value.id !== source.id)
        ) {
          exact = false;
          break;
        }
        source = fragment.value;
        offset += bitWidth(part.type);
      }
      if (exact && source && offset === 64) result = affine(source, active);
      else {
        const key = expression.values.map((part) => `${part.id}:${bitWidth(part.type)}`).join(',');
        const owner = concatenations.get(key);
        if (owner && owner !== value.id) result = affine({ ...value, id: owner }, active);
      }
    } else if (expression?.kind === 'integer' && ['or', 'xor', 'and'].includes(expression.op)) {
      const left = constant(expression.left.id),
        right = constant(expression.right.id);
      const identity = expression.op === 'and' ? 0xffffffffffffffffn : 0n;
      if (right !== undefined && BigInt.asUintN(64, right) === identity)
        result = affine(expression.left, active);
      else if (left !== undefined && BigInt.asUintN(64, left) === identity)
        result = affine(expression.right, active);
    } else if (
      expression?.kind === 'integer' &&
      (expression.op === 'add' || expression.op === 'sub')
    ) {
      const left = constant(expression.left.id),
        right = constant(expression.right.id);
      if (right !== undefined) {
        const base = affine(expression.left, active);
        result = {
          ...base,
          offset: BigInt.asIntN(
            64,
            base.offset + (expression.op === 'add' ? 1n : -1n) * BigInt.asIntN(64, right),
          ),
        };
      } else if (left !== undefined && expression.op === 'add') {
        const base = affine(expression.right, active);
        result = { ...base, offset: BigInt.asIntN(64, base.offset + BigInt.asIntN(64, left)) };
      } else if (expression.op === 'add') {
        for (const [baseValue, indexValue] of [
          [expression.left, expression.right],
          [expression.right, expression.left],
        ] as const) {
          const index = definitions.get(indexValue.id);
          if (index?.kind !== 'integer' || (index.op !== 'mul' && index.op !== 'shl')) continue;
          let scale = constant(index.right.id);
          if (scale === undefined && index.op === 'mul') scale = constant(index.left.id);
          if (scale === undefined) continue;
          const stride =
            index.op === 'mul'
              ? BigInt.asIntN(64, scale)
              : scale >= 0n && scale < 64n
                ? 1n << scale
                : 0n;
          if (stride > 0n && stride <= 65536n) {
            const base = affine(baseValue, active);
            // Two independent indices need a richer expression, not one guessed stride.
            if (base.stride !== null) continue;
            result = { ...base, stride };
            break;
          }
        }
        if (result === fallback) {
          // A loop-carried byte offset `i = c; i += s` added to an invariant
          // base addresses `base + c + k * s`: one constant element period.
          const steps = [expression.right, expression.left].map((item) => induction(item));
          for (const [index, step] of steps.entries()) {
            if (!step || steps[1 - index]) continue;
            const base = affine(index === 0 ? expression.left : expression.right, active);
            if (base.stride !== null) continue;
            const index_id = counter(step);
            result = {
              ...base,
              offset: BigInt.asIntN(64, base.offset + step.initial),
              stride: step.stride,
              ...(index_id ? { index: index_id } : {}),
            };
          }
        }
      }
    } else if (
      expression?.kind === 'extract' &&
      expression.offset === 0 &&
      bitWidth(expression.value.type) === 64
    )
      result = affine(expression.value, active);
    else if (
      expression?.kind === 'cast' &&
      expression.op === 'bitcast' &&
      bitWidth(expression.value.type) === 64
    )
      result = affine(expression.value, active);
    active.delete(value.id);
    cache.set(value.id, result);
    return result;
  };
  return affine;
}

export interface MemoryShapeBuildOptions {
  readonly id: string;
  readonly type_id: string;
  readonly base: MemoryShape['base'];
  readonly fields: readonly ObservedField[];
  readonly alias: MemoryShape['alias'];
  readonly escape: MemoryShape['escape'];
  readonly dynamic: boolean;
  readonly field_type: (field: ObservedField) => string;
  readonly array_type: (element: string, field: ObservedField) => string;
  /** The base is a fresh allocation of this size (see `MemoryShape.allocation`). */
  readonly allocation?: ObjectAllocation;
}
export interface BuiltMemoryShape {
  readonly shape: MemoryShape;
  readonly definition: Extract<RecoveredType, { kind: 'structure' }>;
  readonly conflicts: readonly TypeConflict[];
}

/** Observed accesses describe an incomplete view, never an allocation boundary. */
export function buildMemoryShape(
  options: MemoryShapeBuildOptions,
  budget: AnalysisBudget,
): BuiltMemoryShape {
  budget.charge(options.fields.length);
  if (options.fields.length > 10000) budget.charge(budget.limit + 1);
  const fields = [...options.fields].sort((a, b) =>
    a.offset < b.offset
      ? -1
      : a.offset > b.offset
        ? 1
        : a.width_bits - b.width_bits || a.id.localeCompare(b.id),
  );
  const start = fields[0]?.offset ?? 0n,
    base_offset = start < 0n ? start : 0n;
  let extent: MemoryShape['observed_extent'] = null;
  const conflicts: TypeConflict[] = [];
  const end = (field: ObservedField): bigint =>
    field.offset + BigInt(Math.ceil(field.width_bits / 8));
  // Equal-width fixed/dynamic observations can be compatible views of the
  // same element. Different widths or element periods remain alternatives.
  const compatible = (a: ObservedField, b: ObservedField): boolean =>
    !a.dynamic &&
    !b.dynamic &&
    a.offset === b.offset &&
    a.width_bits === b.width_bits &&
    (a.stride === null || b.stride === null || a.stride === b.stride);
  // Overlapping constant/strided views compete by evidence weight (accesses,
  // then lower offset, then narrower width): the layout keeps the heavier
  // member and every losing access stays an explicit cast at its own use; only
  // the losing member is conflicted, not the whole view.
  const placed: ObservedField[] = [];
  const winners = new Map<string, ObservedField>();
  for (const field of fields
    .filter((item) => !item.dynamic)
    .sort(
      (a, b) =>
        b.node_ids.length - a.node_ids.length ||
        (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0) ||
        a.width_bits - b.width_bits ||
        a.id.localeCompare(b.id),
    )) {
    budget.charge(placed.length + 1);
    const winner = placed.find(
      (other) =>
        field.offset < end(other) && other.offset < end(field) && !compatible(field, other),
    );
    if (winner) winners.set(field.id, winner);
    else placed.push(field);
  }
  for (const field of fields) {
    budget.charge();
    if (field.stride !== null || field.dynamic) continue;
    const stop = end(field);
    extent =
      extent === null
        ? { start: field.offset, end: stop }
        : { start: extent.start, end: stop > extent.end ? stop : extent.end };
  }
  const coreFields = fields
    .filter((field) => !field.dynamic && !winners.has(field.id))
    .map((field) => {
      budget.charge();
      let type_id = options.field_type(field);
      if (field.width_bits % 8 === 0 && field.stride === BigInt(field.width_bits / 8))
        type_id = options.array_type(type_id, field);
      return {
        id: field.id,
        name: `field_${(field.offset - base_offset).toString(16)}`,
        offset: field.offset - base_offset,
        type_id,
      };
    });
  for (const loser of fields) {
    const winner = winners.get(loser.id);
    if (!winner) continue;
    conflicts.push({
      subject_id: loser.id,
      alternatives: [winner.id, loser.id],
      evidence_ids: [...new Set([...winner.evidence_ids, ...loser.evidence_ids])],
      reason: 'overlapping_accesses',
    });
  }
  for (let index = 0; index < fields.length; index++)
    for (
      let next = index + 1;
      next < fields.length && fields[next]!.offset < end(fields[index]!);
      next++
    ) {
      budget.charge();
      const a = fields[index]!,
        b = fields[next]!;
      // A dynamic index may select any member: an overlap with one leaves the
      // whole view unresolved.
      if ((!a.dynamic && !b.dynamic) || compatible(a, b)) continue;
      conflicts.push({
        subject_id: options.id,
        alternatives: [a.id, b.id],
        evidence_ids: [...new Set([...a.evidence_ids, ...b.evidence_ids])],
        reason: 'overlapping_accesses',
      });
    }
  const evidence_ids = [...new Set(fields.flatMap((field) => field.evidence_ids))].sort();
  if (evidence_ids.length > 1000) budget.charge(budget.limit + 1);
  // A fresh allocation sizes the object only if every displaced access lies in it.
  const allocation =
    options.allocation &&
    base_offset === 0n &&
    fields.every((field) => field.dynamic || end(field) <= options.allocation!.size)
      ? options.allocation
      : undefined;
  return {
    shape: {
      id: options.id,
      type_id: options.type_id,
      base: options.base,
      base_offset,
      observed_extent: extent,
      fields,
      alias: options.alias,
      escape: options.escape,
      dynamic: options.dynamic || fields.some((field) => field.stride !== null || field.dynamic),
      evidence_ids,
      ...(allocation ? { allocation } : {}),
    },
    definition: {
      kind: 'structure',
      size: allocation?.size ?? null,
      alignment: null,
      fields: coreFields,
    },
    conflicts,
  };
}

/** Refine an already recovered caller transactionally. No ABI/SSA/stack pass is
 * rerun, and no foreign callee value becomes a caller SSA declaration. */
export function refineMemoryShapes(
  input: SSAForm,
  existing: TypeRecoveryResult,
  context: OperationContext,
  options: MemoryShapeRefinementOptions,
): TypeRecoveryResult {
  if (!Number.isSafeInteger(options.revision) || options.revision < 0)
    throw new RangeError('Invalid type recovery revision');
  if (!options.transfers.length || existing.state !== 'complete') return existing;
  const budget = new AnalysisBudget({
    max_work: options.max_work ?? 1_000_000,
    checkpoint: (work) => context.checkpoint(work),
  });
  try {
    budget.charge();
    const id = (kind: string, birth: CanonicalValue): string =>
      entityIdentity(options.slice_id, `types-${kind}`, [input.id, birth]);
    const definitions = new Map<string, Expression>(),
      values = new Map<string, Value>();
    for (const block of input.blocks) {
      budget.charge();
      for (const value of block.parameters) {
        budget.charge();
        values.set(value.id, value);
      }
      for (const node of block.instructions) {
        budget.charge();
        if ('result' in node) values.set(node.result.id, node.result);
        if (node.kind === 'assign') definitions.set(node.result.id, node.expression);
      }
    }
    for (const state of input.register_states)
      for (const binding of [...state.entry, ...state.exit]) {
        budget.charge();
        values.set(binding.value.id, binding.value);
      }
    const stack = existing.calls?.stack;
    const affine = createAffineResolver(
      definitions,
      (value) => {
        const fact = stack?.values.get(value)?.value;
        if (fact?.kind === 'constant') return fact.bits;
        const expression = definitions.get(value);
        return expression?.kind === 'constant' ? expression.bits : undefined;
      },
      budget,
      memoryAddressSources(input, budget),
      memoryLoopParameters(input, budget),
    );
    const records = [...existing.types],
      associations = [...existing.associations];
    const subjects = new Set(existing.subjects),
      evidence = new Map(existing.evidence.map((item) => [item.id, item]));
    const conflicts = [...existing.conflicts],
      diagnostics = [...existing.diagnostics];
    const bySubject = new Map<string, TypeAssociation[]>();
    for (const association of associations) {
      budget.charge();
      const list = bySubject.get(association.subject_id) ?? [];
      list.push(association);
      bySubject.set(association.subject_id, list);
    }
    const recordKey = (record: SuppliedTypeRecord): string =>
      `${record.id}:${record.source}:${record.status}:${typeKey(record.definition)}`;
    const recordKeys = new Set(records.map(recordKey));
    const byType = new Map<string, SuppliedTypeRecord[]>();
    for (const record of records) {
      budget.charge();
      const list = byType.get(record.id) ?? [];
      list.push(record);
      byType.set(record.id, list);
    }
    const addRecord = (record: SuppliedTypeRecord): void => {
      budget.charge(
        record.definition.kind === 'structure' ? record.definition.fields.length + 1 : 1,
      );
      if (
        record.evidence_ids.length > 1000 ||
        (record.definition.kind === 'structure' && record.definition.fields.length > 10000)
      )
        budget.charge(budget.limit + 1);
      const key = recordKey(record);
      if (!recordKeys.has(key)) {
        records.push(record);
        recordKeys.add(key);
        subjects.add(record.id);
        const list = byType.get(record.id) ?? [];
        list.push(record);
        byType.set(record.id, list);
      }
    };
    const generated = (definition: RecoveredType, proof: readonly string[]): string => {
      const type_id = id('type', typeKey(definition));
      addRecord({
        id: type_id,
        definition,
        source: 'analysis',
        status: 'candidate',
        evidence_ids: proof,
      });
      return type_id;
    };
    const associate = (binding: Omit<TypeAssociation, 'id'>): void => {
      budget.charge();
      const key = id('association', [
        binding.subject_id,
        binding.type_id,
        binding.source,
        binding.status,
        binding.value_offset_bits,
        binding.width_bits,
        binding.machine_offset_bits,
      ]);
      const list = bySubject.get(binding.subject_id) ?? [];
      const previous = list.find((item) => item.id === key);
      if (previous) {
        const merged = {
          ...previous,
          evidence_ids: [...new Set([...previous.evidence_ids, ...binding.evidence_ids])].sort(),
        };
        associations[associations.indexOf(previous)] = merged;
        list[list.indexOf(previous)] = merged;
      } else {
        const association = { ...binding, id: key };
        associations.push(association);
        list.push(association);
        bySubject.set(binding.subject_id, list);
      }
      subjects.add(binding.subject_id);
    };
    const groups = new Map<
      string,
      {
        original?: MemoryShape;
        base: MemoryShape['base'];
        fields: Map<string, ObservedField>;
        alias: MemoryShape['alias'];
        escape: MemoryShape['escape'];
        dynamic: boolean;
      }
    >();
    const groupKey = (base: MemoryShape['base']): string =>
      base.kind === 'stack' ? 'stack' : base.value_id;
    for (const shape of existing.shapes) {
      budget.charge(shape.fields.length + 1);
      groups.set(groupKey(shape.base), {
        original: shape,
        base: shape.base,
        fields: new Map(shape.fields.map((field) => [field.id, field])),
        alias: shape.alias,
        escape: shape.escape,
        dynamic: shape.dynamic,
      });
    }
    const allocations = new Map(
      (existing.allocations ?? []).map((allocation) => [allocation.value_id, allocation]),
    );
    const changed = new Set<string>();
    for (const transfer of options.transfers) {
      budget.charge();
      const address = affine(transfer.argument),
        fact = stack?.values.get(transfer.argument.id)?.value;
      const isStack = fact?.kind === 'stack';
      const base: MemoryShape['base'] = isStack
        ? { kind: 'stack' }
        : { kind: 'value', value_id: address.base };
      const displacement = isStack ? fact.offset : address.offset,
        key = groupKey(base);
      const group = groups.get(key) ?? {
        base,
        fields: new Map<string, ObservedField>(),
        alias: isStack && stack?.frame.aliased ? ('observed' as const) : ('possible' as const),
        escape: 'observed' as const,
        dynamic: false,
      };
      group.escape = 'observed';
      if (transfer.parameter_shape.alias === 'observed') group.alias = 'observed';
      group.dynamic ||= transfer.parameter_shape.dynamic || address.stride !== null;
      for (const proof of transfer.evidence) {
        budget.charge();
        evidence.set(proof.id, proof);
      }
      const foreignTypes = new Map<string, SuppliedTypeRecord[]>();
      for (const record of transfer.types) {
        budget.charge();
        const list = foreignTypes.get(record.id) ?? [];
        list.push(record);
        foreignTypes.set(record.id, list);
      }
      const importedTypes = new Map<string, string>();
      const importing = new Set<string>();
      const importType = (type_id: string): string => {
        budget.charge();
        const cached = importedTypes.get(type_id);
        if (cached) return cached;
        if (importing.has(type_id) || importing.size >= 64) {
          // Recursive nominal references retain their exact IDs and definitions.
          for (const record of foreignTypes.get(type_id) ?? []) addRecord(record);
          return type_id;
        }
        importing.add(type_id);
        const alternatives = foreignTypes.get(type_id) ?? [];
        const canonical =
          alternatives.length === 1 &&
          alternatives[0]!.source === 'analysis' &&
          alternatives[0]!.status === 'candidate' &&
          alternatives[0]!.definition.kind !== 'structure';
        let result = type_id;
        for (const record of alternatives) {
          budget.charge();
          let definition = record.definition;
          if (definition.kind === 'pointer')
            definition = { ...definition, to: importType(definition.to) };
          else if (definition.kind === 'array' || definition.kind === 'vector')
            definition = { ...definition, element: importType(definition.element) };
          else if (definition.kind === 'structure')
            definition = {
              ...definition,
              fields: definition.fields.map((field) => {
                budget.charge();
                return { ...field, type_id: importType(field.type_id) };
              }),
            };
          if (canonical) result = generated(definition, record.evidence_ids);
          else addRecord({ ...record, definition });
        }
        importing.delete(type_id);
        importedTypes.set(type_id, result);
        return result;
      };
      const imported = new Map<string, TypeAssociation[]>();
      for (const association of transfer.associations) {
        budget.charge();
        const list = imported.get(association.subject_id) ?? [];
        list.push(association);
        imported.set(association.subject_id, list);
      }
      const transferredSubjects = new Map<string, string>([
        [transfer.parameter_shape.id, id('shape', key)],
      ]);
      for (const field of transfer.parameter_shape.fields) {
        budget.charge(field.evidence_ids.length + 1);
        // Independent caller/callee indices remain explicitly dynamic; neither
        // an observed extent nor one arbitrarily selected stride is sound.
        const dynamic = field.dynamic || (field.stride !== null && address.stride !== null);
        const offset = BigInt.asIntN(64, displacement + field.offset);
        const stride = dynamic ? null : (field.stride ?? address.stride);
        const fieldId = id('field', [
          key,
          offset,
          field.width_bits,
          stride,
          ...(dynamic ? [true] : []),
        ]);
        transferredSubjects.set(field.id, fieldId);
        const previous = group.fields.get(fieldId);
        const parents = [
          ...new Set([
            ...field.evidence_ids,
            ...transfer.evidence_ids,
            ...transfer.parameter_shape.evidence_ids,
          ]),
        ].sort();
        if (parents.length > 1000) budget.charge(budget.limit + 1);
        const proofId = `evidence_${fingerprint([options.slice_id, input.id, transfer.call_id, field.id, parents])}`;
        evidence.set(proofId, {
          id: proofId,
          origin: {
            kind: 'analysis',
            analyzer: 'source-types',
            version: '3',
            rule: 'callee memory access through caller argument',
          },
          claim: 'callee memory access through caller argument',
          derived_from: parents,
          conflicts_with: [],
          revision: options.revision,
        });
        const merged: ObservedField = {
          ...field,
          id: fieldId,
          offset,
          stride,
          ...(dynamic ? { dynamic: true } : {}),
          node_ids: [...new Set([...(previous?.node_ids ?? []), ...field.node_ids])].sort(),
          origin_ids: [
            ...new Set([...(previous?.origin_ids ?? []), ...(field.origin_ids ?? []), field.id]),
          ].sort(),
          // Foreign value identities survive in evidence, not caller value bindings.
          value_ids: previous?.value_ids ?? [],
          evidence_ids: [...new Set([...(previous?.evidence_ids ?? []), proofId])].sort(),
          access: [...new Set([...(previous?.access ?? []), ...field.access])].sort(),
          stack_region: previous?.stack_region ?? null,
          ...(previous?.call_target_ids?.length || field.call_target_ids?.length
            ? {
                call_target_ids: [
                  ...new Set([
                    ...(previous?.call_target_ids ?? []),
                    ...(field.call_target_ids ?? []),
                  ]),
                ].sort(),
              }
            : {}),
        };
        group.fields.set(fieldId, merged);
        subjects.add(fieldId);
        for (const association of imported.get(field.id) ?? []) {
          const binding = {
            ...association,
            type_id: importType(association.type_id),
            subject_id: fieldId,
            machine_type: null,
            evidence_ids: [...new Set([...association.evidence_ids, proofId])].sort(),
          };
          associate(binding);
          for (const value_id of merged.value_ids) {
            const value = values.get(value_id);
            if (value)
              associate({
                ...binding,
                subject_id: value_id,
                machine_type: value.type,
                width_bits: bitWidth(value.type),
                value_offset_bits: 0,
                machine_offset_bits: 0,
              });
          }
        }
      }
      for (const conflict of transfer.conflicts ?? []) {
        budget.charge(conflict.evidence_ids.length + 1);
        const subject_id =
          transferredSubjects.get(conflict.subject_id) ?? importedTypes.get(conflict.subject_id);
        if (subject_id)
          conflicts.push({
            ...conflict,
            subject_id,
            evidence_ids: [...new Set([...conflict.evidence_ids, ...transfer.evidence_ids])].sort(),
          });
      }
      groups.set(key, group);
      changed.add(key);
    }
    const shapes: MemoryShape[] = [];
    for (const [key, group] of groups) {
      if (!changed.has(key) && group.original) {
        shapes.push(group.original);
        continue;
      }
      const shapeId = id('shape', key),
        type_id = id('shape-type', key);
      const fieldType = (field: ObservedField): string => {
        const candidates = (bySubject.get(field.id) ?? []).filter(
          (item) => item.status !== 'hypothesis' && item.status !== 'conflicting',
        );
        const declarations = candidates.filter((item) => item.source !== 'analysis');
        const selected = declarations.length ? declarations : candidates;
        budget.charge(selected.length);
        const semantic = selected.filter((item) =>
          (byType.get(item.type_id) ?? []).some(
            (record) =>
              record.definition.kind !== 'integer' ||
              record.definition.signed ||
              item.source !== 'analysis',
          ),
        );
        const alternatives = semantic.length ? semantic : selected;
        const definitions = new Set(
          alternatives.flatMap((item) =>
            (byType.get(item.type_id) ?? []).map((record) => typeKey(record.definition)),
          ),
        );
        if (definitions.size > 1) {
          conflicts.push({
            subject_id: field.id,
            alternatives: alternatives.map((item) => item.type_id),
            evidence_ids: [...new Set(alternatives.flatMap((item) => item.evidence_ids))],
            reason: 'incompatible_types',
          });
          return generated({ kind: 'unknown', size: null }, field.evidence_ids);
        }
        if (alternatives.length) return alternatives[0]!.type_id;
        return generated(
          field.width_bits <= 512
            ? { kind: 'integer', bits: field.width_bits, signed: false }
            : { kind: 'unknown', size: null },
          field.evidence_ids,
        );
      };
      const built = buildMemoryShape(
        {
          id: shapeId,
          type_id,
          base: group.base,
          fields: [...group.fields.values()],
          alias: group.alias,
          escape: group.escape,
          dynamic: group.dynamic,
          field_type: fieldType,
          array_type: (element, field) =>
            generated({ kind: 'array', element, count: null }, field.evidence_ids),
          ...(group.base.kind === 'value' && allocations.has(group.base.value_id)
            ? { allocation: allocations.get(group.base.value_id)! }
            : {}),
        },
        budget,
      );
      // This is refinement of this exact generated view, not a second competing declaration.
      for (let index = records.length - 1; index >= 0; index--)
        if (records[index]!.id === type_id && records[index]!.source === 'analysis')
          records.splice(index, 1);
      records.push({
        id: type_id,
        definition: built.definition,
        source: 'analysis',
        status: 'candidate',
        evidence_ids: built.shape.evidence_ids,
      });
      subjects.add(type_id);
      subjects.add(shapeId);
      shapes.push(built.shape);
      conflicts.push(...built.conflicts);
      if (group.base.kind === 'value' && built.shape.base_offset === 0n) {
        const value = values.get(group.base.value_id),
          pointer = generated({ kind: 'pointer', bits: 64, to: type_id }, built.shape.evidence_ids);
        associate({
          subject_id: group.base.value_id,
          type_id: pointer,
          source: 'analysis',
          status: 'candidate',
          evidence_ids: built.shape.evidence_ids,
          machine_type: value?.type ?? null,
          value_offset_bits: 0,
          machine_offset_bits: 0,
          width_bits: value ? bitWidth(value.type) : 64,
        });
        if (value)
          for (const fragment of memoryPointerFragments(value, definitions, budget))
            associate({
              subject_id: fragment.value.id,
              type_id: pointer,
              source: 'analysis',
              status: 'candidate',
              evidence_ids: built.shape.evidence_ids,
              machine_type: fragment.value.type,
              value_offset_bits: fragment.offset,
              machine_offset_bits: 0,
              width_bits: fragment.width,
            });
      }
    }
    const seenConflicts = new Set<string>();
    const uniqueConflicts = conflicts.filter((conflict) => {
      const key = fingerprint([
        conflict.subject_id,
        conflict.reason,
        [...conflict.alternatives].sort(),
      ]);
      if (seenConflicts.has(key)) return false;
      seenConflicts.add(key);
      return true;
    });
    for (const conflict of uniqueConflicts) {
      budget.charge(conflict.evidence_ids.length + 1);
      if (
        !existing.conflicts.some(
          (item) => item.subject_id === conflict.subject_id && item.reason === conflict.reason,
        )
      )
        diagnostics.push({
          code: 'conflicting_evidence',
          severity: 'warning',
          message: `Source type constraint conflict: ${conflict.reason}`,
          entity_id: conflict.subject_id,
          evidence_ids: [...conflict.evidence_ids],
        });
      for (const proof_id of conflict.evidence_ids) {
        const proof = evidence.get(proof_id);
        if (proof)
          evidence.set(proof_id, {
            ...proof,
            conflicts_with: [
              ...new Set([
                ...proof.conflicts_with,
                ...conflict.evidence_ids.filter((other) => other !== proof_id),
              ]),
            ].sort(),
          });
      }
    }
    return {
      ...existing,
      work: existing.work + budget.work,
      subjects: [...subjects].sort(),
      types: records,
      associations,
      shapes: shapes.sort((a, b) => a.id.localeCompare(b.id)),
      conflicts: uniqueConflicts,
      evidence: [...evidence.values()].sort((a, b) => a.id.localeCompare(b.id)),
      diagnostics,
    };
  } catch (error) {
    const failure = budget.result(null, error);
    return {
      ...existing,
      state: 'partial',
      work: existing.work + budget.work,
      diagnostics: [...existing.diagnostics, ...failure.diagnostics],
    };
  }
}
