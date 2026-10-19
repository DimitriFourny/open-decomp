import type { OperationContext } from '../core/index.js';
import { bitWidth, type Instruction, type Value } from '../ir/index.js';
import type { BlockRegion, ControlArm } from '../presentation/index.js';
import type { Reconstruction } from '../reconstruction/model.js';
import type { SourceAddress } from '../reconstruction/source-model.js';
import { sourceConstantValues, sourceDataValues } from '../reconstruction/source-data.js';

export interface IndexedDataAccess {
  readonly data: SourceAddress & { readonly object: NonNullable<SourceAddress['object']> };
  readonly index: Value;
  readonly stride: bigint;
  readonly offset: bigint;
  readonly bits: number;
  /** Greatest element index the access reaches from the object base, counted in
   * elements: `offset + stride * (greatest value of index)`. The index's width,
   * masks and the comparisons dominating the access bound it. */
  readonly last: bigint;
}

/** Match only exact, nonwrapping integer address arithmetic. The declaration is
 * a view of existing storage, never an allocation or a claim of an array bound. */
export function indexedDataAccesses(
  program: Reconstruction,
  context: OperationContext,
): ReadonlyMap<string, IndexedDataAccess> {
  const result = new Map<string, IndexedDataAccess>();
  const data = sourceDataValues(program.expressions, program.source?.addresses ?? [], context);
  const constant = sourceConstantValues(program.expressions, context);
  const narrow = (value: Value): Value => {
    const seen = new Set<string>();
    while (!seen.has(value.id)) {
      seen.add(value.id);
      const expression = program.expressions.get(value.id);
      if (expression?.kind !== 'cast' || expression.op !== 'zero_extend') break;
      value = expression.value;
    }
    return value;
  };
  /** Greatest unsigned value the index can take: its width, lowered by any
   * unsigned-extension chain and constant AND masks (`x & c <= c`). */
  const limits = new Map<string, bigint>();
  const maximum = (value: Value): bigint => {
    const cached = limits.get(value.id);
    if (cached !== undefined) return cached;
    context.checkpoint(1);
    let limit = (1n << BigInt(bitWidth(value.type))) - 1n;
    const expression = program.expressions.get(value.id);
    if (expression?.kind === 'integer' && expression.op === 'and') {
      for (const operand of [expression.left, expression.right]) {
        const bound = constant(operand) ?? maximum(operand);
        if (bound < limit) limit = bound;
      }
    } else if (
      expression?.kind === 'cast' &&
      (expression.op === 'zero_extend' || expression.op === 'bitcast') &&
      expression.value.type.kind === 'integer'
    ) {
      const bound = maximum(expression.value);
      if (bound < limit) limit = bound;
    }
    limits.set(value.id, limit);
    return limit;
  };
  // Unsigned upper bounds on values from the comparisons that dominate a block:
  // an edge into a block whose only predecessor is the branching block holds in
  // every block that block dominates.
  const predecessors = new Map<string, number>();
  const arms = (block: BlockRegion): readonly ControlArm[] =>
    block.control.kind === 'jump'
      ? [{ transfer: block.control.transfer }]
      : block.control.kind === 'if'
        ? [block.control.when_true, block.control.when_false]
        : block.control.kind === 'switch'
          ? [...block.control.cases.map((item) => item.arm), block.control.otherwise]
          : [];
  for (const block of program.blocks.values())
    for (const arm of arms(block))
      predecessors.set(arm.transfer.target, (predecessors.get(arm.transfer.target) ?? 0) + 1);
  const guards = new Map<string, ReadonlyMap<string, bigint>>();
  const guardsAt = (id: string, depth = 0): ReadonlyMap<string, bigint> => {
    const known = guards.get(id);
    if (known) return known;
    context.checkpoint(1);
    const block = program.blocks.get(id),
      parent = block?.dominator ? program.blocks.get(block.dominator) : undefined;
    let facts: ReadonlyMap<string, bigint> = new Map();
    if (block && parent && depth < 256) {
      facts = guardsAt(parent.id, depth + 1);
      const control = parent.control;
      if (control.kind === 'if' && predecessors.get(id) === 1) {
        const through = [control.when_true, control.when_false].filter(
          (arm) => arm.transfer.target === id,
        );
        const condition = program.expressions.get(control.condition.id);
        if (through.length === 1 && condition?.kind === 'compare') {
          const taken = through[0] === control.when_true;
          const left = constant(condition.left),
            right = constant(condition.right);
          // Normalize to `value op bound` with the constant on the right.
          const swap = {
            ult: 'ugt',
            ule: 'uge',
            ugt: 'ult',
            uge: 'ule',
            eq: 'eq',
            ne: 'ne',
          } as const;
          const subject = right !== undefined ? condition.left : condition.right,
            bound = right ?? left,
            op =
              right !== undefined
                ? condition.op
                : condition.op in swap
                  ? swap[condition.op as keyof typeof swap]
                  : undefined;
          const flip = {
            ult: 'uge',
            ule: 'ugt',
            ugt: 'ule',
            uge: 'ult',
            eq: 'ne',
            ne: 'eq',
          } as const;
          const effective =
            op && op in flip ? (taken ? op : flip[op as keyof typeof flip]) : undefined;
          let limit: bigint | undefined;
          if (bound !== undefined && subject.type.kind === 'integer')
            if (effective === 'ult' && bound > 0n) limit = bound - 1n;
            else if (effective === 'ule' || effective === 'eq') limit = bound;
          if (limit !== undefined) {
            const next = new Map(facts);
            const previous = next.get(subject.id);
            next.set(subject.id, previous === undefined || limit < previous ? limit : previous);
            facts = next;
          }
        }
      }
    }
    guards.set(id, facts);
    return facts;
  };
  /** Greatest value the guards bound `value` to, through zero extensions. */
  const guarded = (value: Value, block: string): bigint | undefined => {
    const facts = guardsAt(block);
    let best: bigint | undefined;
    const seen = new Set<string>();
    while (!seen.has(value.id)) {
      seen.add(value.id);
      const fact = facts.get(value.id);
      if (fact !== undefined && (best === undefined || fact < best)) best = fact;
      const expression = program.expressions.get(value.id);
      if (expression?.kind !== 'cast' || expression.op !== 'zero_extend') break;
      value = expression.value;
    }
    return best;
  };
  const candidate = (node: Extract<Instruction, { kind: 'load' }>, block: string): void => {
    const bits = bitWidth(node.result.type);
    if (
      node.result.type.kind !== 'integer' ||
      program.source?.float_accesses?.has(node.id) ||
      ![8, 16, 32, 64].includes(bits) ||
      node.access.volatile ||
      node.access.endian !== 'little' ||
      node.access.alignment !== 1 ||
      bitWidth(node.address.type) !== 64
    )
      return;
    const address = program.expressions.get(node.address.id);
    if (address?.kind !== 'integer' || address.op !== 'add') return;
    let base = data(address.left),
      index = address.right;
    if (!base?.object) {
      base = data(address.right);
      index = address.left;
    }
    if (
      !base?.object ||
      base.object.kind === 'unknown' ||
      base.address.space !== 'va' ||
      base.object.address.space !== 'va' ||
      base.address.image_id !== base.object.address.image_id ||
      base.object.offset < 0n ||
      base.address.value !== base.object.address.value + base.object.offset
    )
      return;
    let scale = 1n;
    const scaled = program.expressions.get(index.id);
    if (scaled?.kind === 'integer' && (scaled.op === 'mul' || scaled.op === 'shl')) {
      let amount = constant(scaled.right);
      let operand = scaled.left;
      if (amount === undefined && scaled.op === 'mul') {
        amount = constant(scaled.left);
        operand = scaled.right;
      }
      if (amount === undefined || amount < 0n || (scaled.op === 'shl' && amount > 63n)) return;
      scale = scaled.op === 'shl' ? 1n << amount : amount;
      index = operand;
    }
    const widest = index;
    index = narrow(index);
    let limit = maximum(index);
    const guard = guarded(widest, block);
    if (guard !== undefined && guard < limit) limit = guard;
    const size = BigInt(bits / 8),
      object = base.object;
    if (
      index.type.kind !== 'integer' ||
      scale === 0n ||
      scale % size !== 0n ||
      object.offset % size !== 0n ||
      object.address.value % size !== 0n ||
      object.address.value + object.offset + limit * scale >= 1n << 64n
    )
      return;
    result.set(node.id, {
      data: { ...base, object },
      index,
      stride: scale / size,
      offset: object.offset / size,
      bits,
      last: object.offset / size + (limit * scale) / size,
    });
  };
  for (const block of program.blocks.values())
    for (const node of block.statements) {
      context.checkpoint(1);
      if (
        node.kind === 'load' &&
        program.retained.has(node.id) &&
        !program.source?.locals.has(node.id)
      )
        candidate(node, block.id);
    }
  return result;
}
