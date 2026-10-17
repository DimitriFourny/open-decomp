import type { OperationContext } from '../core/index.js';
import { bitWidth, expressionOperands, type Expression, type Value } from '../ir/index.js';
import type { BlockRegion, ParallelTransfer } from '../presentation/index.js';

interface Range {
  readonly minimum: bigint;
  readonly maximum: bigint;
  /** A singleton bit range alone cannot discard an unknown/undefined operand. */
  readonly defined: boolean;
}
type Fact = Range | null;

/** Forward, edge-constrained unsigned intervals over immutable SSA values.
 * Parallel copies are evaluated before any destination fact is joined. Branches
 * establish both the tested bit range and definedness on the selected edge.
 * Growing loop bounds widen conservatively; failed proofs leave the original
 * expressions untouched. No CFG, effect, statement identity or provenance moves.
 */
export function normalizeSourceRanges(
  entry: string,
  blocks: ReadonlyMap<string, BlockRegion>,
  expressions: Map<string, Expression>,
  parameterSources: ReadonlyMap<string, readonly Value[]>,
  context: OperationContext,
): void {
  const resolve = (value: Value): Value => {
    const seen = new Set<string>();
    while (!seen.has(value.id)) {
      context.checkpoint(1); seen.add(value.id);
      const expression = expressions.get(value.id);
      if (expression?.kind !== 'cast' || expression.op !== 'bitcast') break;
      value = expression.value;
    }
    return value;
  };
  const entryParameters = new Set(blocks.get(entry)!.parameters.map((value) => value.id));
  const candidates = new Map<string, Value>();
  for (const expression of expressions.values()) {
    context.checkpoint(1);
    if (expression.kind !== 'concat') continue;
    for (let index = 1; index < expression.values.length; index++) {
      const value = resolve(expression.values[index]!);
      if (value.type.kind === 'integer' && parameterSources.has(value.id) && !entryParameters.has(value.id))
        candidates.set(value.id, value);
    }
  }
  if (candidates.size === 0) return;
  // Slice through existing SSA/phi dependencies rather than repeatedly walking
  // unrelated saved registers, call snapshots, floating lanes and accumulators.
  const demanded = new Set<string>(), dependencies = [...candidates.values()];
  for (let cursor = 0; cursor < dependencies.length; cursor++) {
    context.checkpoint(1);
    const value = dependencies[cursor]!;
    if (demanded.has(value.id)) continue;
    demanded.add(value.id);
    const incoming = parameterSources.get(value.id), expression = expressions.get(value.id);
    const operands = incoming ?? (expression ? expressionOperands(expression) : []);
    context.checkpoint(operands.length);
    for (const operand of operands) dependencies.push(operand);
  }
  const limits = new Map<number, bigint>();
  const mask = (width: number): bigint => {
    let result = limits.get(width);
    if (result === undefined) { result = (1n << BigInt(width)) - 1n; limits.set(width, result); }
    return result;
  };
  const top = (value: Value, defined = false): Range =>
    ({ minimum: 0n, maximum: mask(bitWidth(value.type)), defined });
  const exact = (bits: bigint, defined = true): Range => ({ minimum: bits, maximum: bits, defined });
  const project = (minimum: bigint, maximum: bigint, width: number, defined: boolean): Range =>
    (minimum >> BigInt(width)) === (maximum >> BigInt(width))
      ? { minimum: BigInt.asUintN(width, minimum), maximum: BigInt.asUintN(width, maximum), defined }
      : { minimum: 0n, maximum: mask(width), defined };
  const facts = new Map<string, Range>(), updates = new Map<string, number>();
  const reachable = new Set<string>([entry]), queued = new Set<string>([entry]), pending = [entry];
  for (const parameter of blocks.get(entry)!.parameters)
    if (demanded.has(parameter.id)) facts.set(parameter.id, top(parameter));

  const evaluate = (root: Value, constraints: ReadonlyMap<string, Range>, cache: Map<string, Fact>): Fact => {
    const active = new Set<string>();
    const work: { value: Value; exit: boolean }[] = [{ value: root, exit: false }];
    while (work.length) {
      context.checkpoint(1);
      const { value, exit } = work.pop()!;
      if (cache.has(value.id)) continue;
      const constrained = constraints.get(value.id);
      if (constrained) { cache.set(value.id, constrained); continue; }
      const parameter = facts.get(value.id);
      if (parameter) { cache.set(value.id, parameter); continue; }
      const expression = expressions.get(value.id);
      if (!expression || value.type.kind !== 'integer') {
        cache.set(value.id, top(value)); continue;
      }
      if (expression.kind === 'constant') {
        cache.set(value.id, exact(BigInt.asUintN(bitWidth(value.type), expression.bits))); continue;
      }
      if (!exit) {
        if (active.has(value.id)) { cache.set(value.id, top(value)); continue; }
        active.add(value.id);
        work.push({ value, exit: true });
        const operands = expressionOperands(expression);
        context.checkpoint(operands.length);
        for (let index = operands.length - 1; index >= 0; index--)
          work.push({ value: operands[index]!, exit: false });
        continue;
      }
      active.delete(value.id);
      const operands = expressionOperands(expression).map((operand) => cache.get(operand.id) ?? null);
      if (operands.some((operand) => operand === null)) { cache.set(value.id, null); continue; }
      const ranges = operands as Range[];
      const defined = ranges.every((operand) => operand.defined), width = bitWidth(value.type);
      let result = top(value);
      switch (expression.kind) {
        case 'cast': {
          const source = ranges[0]!, sourceWidth = bitWidth(expression.value.type);
          if (expression.op === 'bitcast' || expression.op === 'zero_extend') result = { ...source };
          else if (expression.op === 'truncate') result = project(source.minimum, source.maximum, width, defined);
          else if (expression.op === 'sign_extend') {
            const sign = 1n << BigInt(sourceWidth - 1);
            if (source.maximum < sign) result = { ...source };
            else if (source.minimum >= sign) {
              const extension = mask(width) - mask(sourceWidth);
              result = { minimum: source.minimum + extension, maximum: source.maximum + extension, defined };
            } else result = top(value, defined);
          }
          break;
        }
        case 'extract': {
          const source = ranges[0]!;
          result = project(source.minimum >> BigInt(expression.offset), source.maximum >> BigInt(expression.offset), width, defined);
          break;
        }
        case 'concat': {
          let minimum = 0n, maximum = 0n, offset = 0;
          for (let index = 0; index < expression.values.length; index++) {
            context.checkpoint(1);
            minimum |= ranges[index]!.minimum << BigInt(offset);
            maximum |= ranges[index]!.maximum << BigInt(offset);
            offset += bitWidth(expression.values[index]!.type);
          }
          result = { minimum, maximum, defined };
          break;
        }
        case 'integer': {
          const a = ranges[0]!, b = ranges[1]!;
          if (expression.op === 'add') result = project(a.minimum + b.minimum, a.maximum + b.maximum, width, defined);
          else if (expression.op === 'sub') result = project(a.minimum - b.maximum, a.maximum - b.minimum, width, defined);
          else if (expression.op === 'mul') result = project(a.minimum * b.minimum, a.maximum * b.maximum, width, defined);
          else if (expression.op === 'and' && b.minimum === b.maximum)
            result = { minimum: 0n, maximum: b.maximum, defined };
          else if (expression.op === 'and' && a.minimum === a.maximum)
            result = { minimum: 0n, maximum: a.maximum, defined };
          else if (b.minimum === b.maximum && (expression.op === 'shl' || expression.op === 'lshr')) {
            const count = b.minimum;
            if (count >= BigInt(width)) result = exact(0n, defined);
            else if (expression.op === 'shl') result = project(a.minimum << count, a.maximum << count, width, defined);
            else result = { minimum: a.minimum >> count, maximum: a.maximum >> count, defined };
          } else if (['and', 'or', 'xor', 'shl', 'lshr', 'ashr', 'rol', 'ror'].includes(expression.op))
            result = top(value, defined);
          break;
        }
        case 'compare': {
          const a = ranges[0]!, b = ranges[1]!;
          let known: boolean | undefined;
          if (expression.op === 'eq' || expression.op === 'ne') {
            if (a.maximum < b.minimum || b.maximum < a.minimum) known = expression.op === 'ne';
            else if (a.minimum === a.maximum && b.minimum === b.maximum)
              known = expression.op === 'eq' ? a.minimum === b.minimum : a.minimum !== b.minimum;
          } else if (expression.op === 'ult' || expression.op === 'ule') {
            if (expression.op === 'ult' ? a.maximum < b.minimum : a.maximum <= b.minimum) known = true;
            else if (expression.op === 'ult' ? a.minimum >= b.maximum : a.minimum > b.maximum) known = false;
          } else if (expression.op === 'ugt' || expression.op === 'uge') {
            if (expression.op === 'ugt' ? a.minimum > b.maximum : a.minimum >= b.maximum) known = true;
            else if (expression.op === 'ugt' ? a.maximum <= b.minimum : a.maximum < b.minimum) known = false;
          }
          result = known === undefined ? top(value, defined) : exact(BigInt(known), defined);
          break;
        }
        case 'select': {
          const condition = ranges[0]!, yes = ranges[1]!, no = ranges[2]!;
          if (!condition.defined) break;
          if (condition.maximum === 0n) result = no;
          else if (condition.minimum > 0n) result = yes;
          else result = { minimum: yes.minimum < no.minimum ? yes.minimum : no.minimum,
            maximum: yes.maximum > no.maximum ? yes.maximum : no.maximum, defined: yes.defined && no.defined };
          break;
        }
      }
      cache.set(value.id, result);
    }
    return cache.get(root.id) ?? null;
  };
  const refine = (
    value: Value, predicate: string, constant: bigint, constraints: Map<string, Range>, cache: Map<string, Fact>,
  ): boolean => {
    value = resolve(value);
    const current = evaluate(value, constraints, cache);
    if (!current) return false;
    let { minimum, maximum } = current;
    switch (predicate) {
      case 'eq': minimum = minimum > constant ? minimum : constant; maximum = maximum < constant ? maximum : constant; break;
      case 'ne':
        if (minimum === constant) minimum++;
        if (maximum === constant) maximum--;
        break;
      case 'ult': if (maximum >= constant) maximum = constant - 1n; break;
      case 'ule': if (maximum > constant) maximum = constant; break;
      case 'ugt': if (minimum <= constant) minimum = constant + 1n; break;
      case 'uge': if (minimum < constant) minimum = constant; break;
    }
    if (minimum > maximum) return false;
    constraints.set(value.id, { minimum, maximum, defined: true });
    return true;
  };
  const inverse: Record<string, string> = { eq: 'ne', ne: 'eq', ult: 'uge', ule: 'ugt', ugt: 'ule', uge: 'ult' };
  const swapped: Record<string, string> = { eq: 'eq', ne: 'ne', ult: 'ugt', ule: 'uge', ugt: 'ult', uge: 'ule' };
  // Blocks read dominating parameter facts directly; any fact change makes
  // every block last evaluated under an older version stale.
  let version = 0;
  const evaluated = new Map<string, number>();
  const join = (destination: Value, incoming: Range): boolean => {
    const previous = facts.get(destination.id);
    if (!previous) { facts.set(destination.id, incoming); updates.set(destination.id, 1); version++; return true; }
    let minimum = previous.minimum < incoming.minimum ? previous.minimum : incoming.minimum;
    let maximum = previous.maximum > incoming.maximum ? previous.maximum : incoming.maximum;
    const defined = previous.defined && incoming.defined;
    if (minimum === previous.minimum && maximum === previous.maximum && defined === previous.defined) return false;
    const count = updates.get(destination.id) ?? 0;
    // Widen only expanding bounds, never strengthen an unproved loop fact.
    if (count >= 2) {
      if (minimum < previous.minimum) minimum = 0n;
      if (maximum > previous.maximum) maximum = mask(bitWidth(destination.type));
    }
    facts.set(destination.id, { minimum, maximum, defined }); updates.set(destination.id, count + 1);
    version++;
    return true;
  };
  // Dominance SSA: an edge-established range for a value referenced across
  // blocks holds at the target's entry. Entry constraints join over incoming
  // edges; a value constrained on only some edges is unconstrained there.
  const inherited = new Map<string, ReadonlyMap<string, Range>>();
  const inheritedUpdates = new Map<string, number>();
  const inherit = (target: string, constraints: ReadonlyMap<string, Range>): boolean => {
    const previous = inherited.get(target);
    if (!previous) { inherited.set(target, new Map(constraints)); return true; }
    const count = inheritedUpdates.get(target) ?? 0;
    const next = new Map<string, Range>();
    let changed = false;
    for (const [id, before] of previous) {
      context.checkpoint(1);
      const incoming = constraints.get(id);
      if (!incoming) { changed = true; continue; }
      const minimum = before.minimum < incoming.minimum ? before.minimum : incoming.minimum;
      const maximum = before.maximum > incoming.maximum ? before.maximum : incoming.maximum;
      const defined = before.defined && incoming.defined;
      if (minimum === before.minimum && maximum === before.maximum && defined === before.defined) {
        next.set(id, before); continue;
      }
      changed = true;
      // Widen a repeatedly growing loop constraint to no constraint.
      if (count < 2) next.set(id, { minimum, maximum, defined });
    }
    if (!changed) return false;
    inherited.set(target, next); inheritedUpdates.set(target, count + 1);
    return true;
  };
  const propagate = (transfer: ParallelTransfer, constraints: ReadonlyMap<string, Range>): void => {
    const cache = new Map<string, Fact>();
    const incoming: { destination: Value; range: Range }[] = [];
    for (const copy of transfer.copies) {
      context.checkpoint(1);
      if (!demanded.has(copy.destination.id)) continue;
      const range = evaluate(copy.source, constraints, cache);
      if (!range) return;
      incoming.push({ destination: copy.destination, range });
    }
    let changed = !reachable.has(transfer.target) || (evaluated.get(transfer.target) ?? -1) < version;
    for (const { destination, range } of incoming) {
      context.checkpoint(1);
      changed = join(destination, range) || changed;
    }
    changed = inherit(transfer.target, constraints) || changed;
    reachable.add(transfer.target);
    if (changed && !queued.has(transfer.target)) { pending.push(transfer.target); queued.add(transfer.target); }
  };
  for (let cursor = 0; cursor < pending.length; cursor++) {
    context.checkpoint(1);
    const id = pending[cursor]!; queued.delete(id); evaluated.set(id, version);
    const control = blocks.get(id)!.control;
    // Values (re)defined in this block, including its parameters rebound by
    // the incoming transfer, are new instances: older constraints do not apply.
    const base = new Map(inherited.get(id) ?? []);
    if (base.size) {
      const block = blocks.get(id)!;
      for (const value of block.parameters) base.delete(value.id);
      for (const node of block.statements) {
        context.checkpoint(1);
        if ('result' in node) base.delete(node.result.id);
        if (node.kind === 'call') for (const value of node.results) base.delete(value.id);
        if ('register_outputs' in node) for (const binding of node.register_outputs) base.delete(binding.value.id);
      }
    }
    if (control.kind === 'jump') propagate(control.transfer, base);
    else if (control.kind === 'if') {
      const condition = resolve(control.condition), comparison = expressions.get(condition.id);
      for (const [truth, arm] of [[true, control.when_true], [false, control.when_false]] as const) {
        const constraints = new Map(base), cache = new Map<string, Fact>();
        const selected = evaluate(condition, constraints, cache);
        if (!selected || (truth ? selected.maximum === 0n : selected.minimum > 0n)) continue;
        constraints.set(condition.id, exact(truth ? 1n : 0n));
        let possible = true;
        if (comparison?.kind === 'compare' && inverse[comparison.op]) {
          let predicate = truth ? comparison.op : inverse[comparison.op]!;
          const left = evaluate(comparison.left, constraints, cache), right = evaluate(comparison.right, constraints, cache);
          if (right && right.minimum === right.maximum && right.defined)
            possible = refine(comparison.left, predicate, right.minimum, constraints, cache);
          else if (left && left.minimum === left.maximum && left.defined) {
            predicate = swapped[predicate]!;
            possible = refine(comparison.right, predicate, left.minimum, constraints, cache);
          }
        }
        if (possible) propagate(arm.transfer, constraints);
      }
    } else if (control.kind === 'switch') {
      const value = resolve(control.value);
      for (const item of control.cases) {
        context.checkpoint(1);
        const constraints = new Map(base);
        if (refine(value, 'eq', item.bits, constraints, new Map())) propagate(item.arm.transfer, constraints);
      }
      const constraints = new Map(base);
      let possible = true;
      for (const item of control.cases) {
        context.checkpoint(1);
        if (!refine(value, 'ne', item.bits, constraints, new Map())) { possible = false; break; }
      }
      if (possible) propagate(control.otherwise.transfer, constraints);
    }
  }
  // Commit only after the conservative fixed point. Retaining an explicit alias
  // is unnecessary for constants; normal source normalization/liveness removes
  // their incoming copies without changing any executed effect.
  for (const parameter of candidates.values()) {
    context.checkpoint(1);
    const range = facts.get(parameter.id);
    if (range?.defined && range.minimum === range.maximum)
      expressions.set(parameter.id, { kind: 'constant', bits: range.minimum });
  }
}
