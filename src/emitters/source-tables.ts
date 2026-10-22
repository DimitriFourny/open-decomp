import type { OperationContext } from '../core/index.js';
import { bitWidth, type Instruction, type Value } from '../ir/index.js';
import type { BlockRegion, ControlArm } from '../presentation/index.js';
import type { Reconstruction } from '../reconstruction/model.js';
import type { SourceAddress } from '../reconstruction/source-model.js';
import { sourceConstantValues, sourceDataValues } from '../reconstruction/source-data.js';

export interface IndexedDataAccess {
  readonly data: SourceAddress & { readonly object: NonNullable<SourceAddress['object']> };
  /** Variable terms of the element index, each `index * stride` (in elements). */
  readonly terms: readonly { readonly index: Value; readonly stride: bigint }[];
  readonly offset: bigint;
  readonly bits: number;
  /** Greatest element index the access reaches from the object base, counted in
   * elements: `offset` plus every term's stride times the greatest value of its index. The index's width,
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
  interface Facts {
    readonly upper: ReadonlyMap<string, bigint>;
    readonly lower: ReadonlyMap<string, bigint>;
  }
  const guards = new Map<string, Facts>();
  const guardsAt = (id: string, depth = 0): Facts => {
    const known = guards.get(id);
    if (known) return known;
    context.checkpoint(1);
    const block = program.blocks.get(id),
      parent = block?.dominator ? program.blocks.get(block.dominator) : undefined;
    let facts: Facts = { upper: new Map(), lower: new Map() };
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
          let limit: bigint | undefined, floor: bigint | undefined;
          if (bound !== undefined && subject.type.kind === 'integer') {
            if (effective === 'ult' && bound > 0n) limit = bound - 1n;
            else if (effective === 'ule' || effective === 'eq') limit = bound;
            if (effective === 'uge' || effective === 'eq') floor = bound;
            else if (effective === 'ugt') floor = bound + 1n;
          }
          if (limit !== undefined) {
            const next = new Map(facts.upper);
            const previous = next.get(subject.id);
            next.set(subject.id, previous === undefined || limit < previous ? limit : previous);
            facts = { ...facts, upper: next };
          }
          if (floor !== undefined) {
            const next = new Map(facts.lower);
            const previous = next.get(subject.id);
            next.set(subject.id, previous === undefined || floor > previous ? floor : previous);
            facts = { ...facts, lower: next };
          }
        }
      }
    }
    guards.set(id, facts);
    return facts;
  };
  /** Greatest (`upper`) or least (`lower`) value the guards bound `value` to,
   * through zero extensions (which preserve the value). */
  const guarded = (
    value: Value,
    block: string,
    side: 'upper' | 'lower' = 'upper',
  ): bigint | undefined => {
    const facts = guardsAt(block)[side];
    let best: bigint | undefined;
    const seen = new Set<string>();
    while (!seen.has(value.id)) {
      seen.add(value.id);
      const fact = facts.get(value.id);
      if (
        fact !== undefined &&
        (best === undefined || (side === 'upper' ? fact < best : fact > best))
      )
        best = fact;
      const expression = program.expressions.get(value.id);
      if (expression?.kind !== 'cast' || expression.op !== 'zero_extend') break;
      value = expression.value;
    }
    return best;
  };
  /** Greatest unsigned value `value` can take in `block`: its width, masks and
   * extensions (`maximum`), the dominating guards, a constant right shift of a
   * bounded value, and a subtraction `x - c` whose `x >= c` is guarded, which
   * does not wrap and is at most the greatest `x` minus `c`. */
  const reachOf = (value: Value, block: string, depth = 0): bigint => {
    context.checkpoint(1);
    let limit = maximum(value);
    const guard = guarded(value, block);
    if (guard !== undefined && guard < limit) limit = guard;
    const expression = program.expressions.get(value.id);
    if (depth < 4 && expression?.kind === 'integer' && expression.op === 'sub') {
      const amount = constant(expression.right),
        floor = guarded(expression.left, block, 'lower');
      if (amount !== undefined && floor !== undefined && floor >= amount) {
        const top = reachOf(expression.left, block, depth + 1);
        if (top >= amount && top - amount < limit) limit = top - amount;
      }
    } else if (depth < 4 && expression?.kind === 'integer' && expression.op === 'lshr') {
      // `x >> c` with an in-width constant shift is at most the greatest `x` shifted.
      const amount = constant(expression.right);
      if (amount !== undefined && amount < BigInt(bitWidth(value.type))) {
        const top = reachOf(expression.left, block, depth + 1) >> amount;
        if (top < limit) limit = top;
      }
    }
    return limit;
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
    // The address is a sum: one constant naming mapped storage, constant byte
    // displacements, and variable terms (each optionally scaled by a constant).
    const leaves: Value[] = [];
    const flatten = (value: Value, depth: number): void => {
      const expression = program.expressions.get(value.id);
      if (
        expression?.kind === 'integer' &&
        expression.op === 'add' &&
        depth < 4 &&
        constant(value) === undefined
      ) {
        flatten(expression.left, depth + 1);
        flatten(expression.right, depth + 1);
      } else leaves.push(value);
    };
    flatten(node.address, 0);
    if (leaves.length < 2 || leaves.length > 4) return;
    let base: SourceAddress | undefined,
      displacement = 0n;
    const variable: Value[] = [];
    for (const leaf of leaves) {
      const item = data(leaf);
      if (!base && item?.object) base = item;
      else if (constant(leaf) !== undefined) displacement += constant(leaf)!;
      else variable.push(leaf);
    }
    if (
      !base?.object ||
      !variable.length ||
      base.object.kind === 'unknown' ||
      base.address.space !== 'va' ||
      base.object.address.space !== 'va' ||
      base.address.image_id !== base.object.address.image_id ||
      base.object.offset < 0n ||
      base.address.value !== base.object.address.value + base.object.offset
    )
      return;
    const size = BigInt(bits / 8),
      object = base.object;
    // A displacement is an unsigned byte offset; a wrapped (negative) one is no table.
    displacement = BigInt.asUintN(64, displacement);
    if (displacement >= 1n << 32n) return;
    const terms: { index: Value; stride: bigint }[] = [];
    let reach = object.offset + displacement;
    for (const leaf of variable) {
      let index = leaf,
        scale = 1n;
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
      let limit = reachOf(index, block);
      const guard = guarded(widest, block);
      if (guard !== undefined && guard < limit) limit = guard;
      if (index.type.kind !== 'integer' || scale === 0n || scale % size !== 0n) return;
      reach += limit * scale;
      terms.push({ index, stride: scale / size });
    }
    if (
      (object.offset + displacement) % size !== 0n ||
      object.address.value % size !== 0n ||
      object.address.value + reach >= 1n << 64n
    )
      return;
    result.set(node.id, {
      data: { ...base, object },
      terms,
      offset: (object.offset + displacement) / size,
      bits,
      last: reach / size,
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
