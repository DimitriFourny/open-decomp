import type { OperationContext } from '../core/index.js';
import {
  bitWidth,
  bits,
  evaluateExpression,
  expressionOperands,
  type Expression,
  type Instruction,
  type RuntimeValue,
  type Value,
} from '../ir/index.js';
import type { BlockRegion, Control, ParallelTransfer, Region } from '../presentation/index.js';
import type { Reconstruction } from '../reconstruction/model.js';
import { controlArms } from './source-control.js';

type IfControl = Extract<Control, { kind: 'if' }>;
type Load = Extract<Instruction, { kind: 'load' }>;
type Store = Extract<Instruction, { kind: 'store' }>;

/** One test of a short-circuit chain. */
export interface FlagStage {
  readonly control: IfControl;
  /** Condition value on the arm that continues to the next stage. */
  readonly enter: boolean;
  /** Flag value the merge observes when this test leaves the chain. */
  readonly value: boolean;
}

/** `a && b`/`a || b` lowered through a promoted private flag local (typical O0
 * code): each stage writes a constant 0/1 to the flag and either reaches the
 * merge or continues; the last stage writes a one-bit value (or copies the
 * flag of a nested chain, as for `a && (b || c)`) and jumps to the merge,
 * which reads the flag once. */
export interface FlagTest {
  readonly head: string;
  readonly merge: string;
  readonly stages: readonly FlagStage[];
  /** One-bit value written by the last stage, or the nested chain whose flag
   * it copies (`invert`: as its complement). */
  readonly last: Value | { readonly chain: FlagTest; readonly invert: boolean };
  /** The merge test holds exactly when the flag is 1 (nested chains: true). */
  readonly positive: boolean;
  /** Every retained access of the flag locals: their stores and loads. */
  readonly accesses: readonly string[];
  /** Absorbed controls: every stage test and last-stage jump. */
  readonly controls: readonly string[];
}

export interface FlagFacts {
  /** The statement prints anything at its position (itself, anchored
   * definitions or deferred stores). */
  readonly prints: (node: Instruction) => boolean;
  /** Notes, definitions or deferred stores are anchored at this id. */
  readonly anchored: (id: string) => boolean;
  /** Number of edge copies the transfer prints. */
  readonly copies: (transfer: ParallelTransfer) => number;
  /** The pure expression a value prints as at each of its uses. */
  readonly expression: (id: string) => Expression | undefined;
  /** The load result prints only inside this statement or control. */
  readonly readOnlyBy: (value: Value, reader: string) => boolean;
  /** The store prints at its own position. */
  readonly inPlace: (store: string) => boolean;
  /** The test prints as an ordinary condition (no requirement predicate). */
  readonly plain: (control: Control) => boolean;
}

const MAX_STAGES = 64,
  MAX_NESTING = 8;

/** Find flag-carried short-circuit tests on the final layout. Side conditions,
 * all checked on the IR: each flag is a promoted private local whose retained
 * accesses are exactly its chain's stores and one load; every stage store is
 * the last retained statement of its block and nothing else in the chain
 * prints (the outermost head may print statements before its store); stage
 * blocks are entered only through the chain and each merge only from it, all
 * edges copy-free; the merge prints only its test, which reads only the flag
 * and is the exact one-bit test of the flag over the stored values 0 and 1.
 * Keyed by the merge control id. */
export function planFlagTests(
  body: Region,
  program: Reconstruction,
  facts: FlagFacts,
  context: OperationContext,
): ReadonlyMap<string, FlagTest> {
  const result = new Map<string, FlagTest>();
  const locals = program.source?.locals;
  if (!locals?.size) return result;
  const predecessors = new Map<string, ParallelTransfer[]>();
  const accesses = new Map<string, string[]>();
  for (const block of program.blocks.values()) {
    context.checkpoint(1 + block.statements.length);
    const control = block.control;
    for (const transfer of control.kind === 'jump'
      ? [control.transfer]
      : controlArms(control).map((arm) => arm.transfer)) {
      const list = predecessors.get(transfer.target) ?? [];
      list.push(transfer);
      predecessors.set(transfer.target, list);
    }
    for (const node of block.statements) {
      const local = locals.get(node.id);
      if (!local || !program.retained.has(node.id)) continue;
      const list = accesses.get(local.id) ?? [];
      list.push(node.id);
      accesses.set(local.id, list);
    }
  }
  // Lexical sibling pairs (nested sequences print as one list) and block counts.
  const occurrences = new Map<string, number>();
  const pairs: [BlockRegion, BlockRegion][] = [];
  const flatten = (region: Region, into: Region[]): void => {
    if (region.kind === 'sequence') for (const child of region.regions) flatten(child, into);
    else into.push(region);
  };
  const visit = (region: Region): void => {
    context.checkpoint(1);
    if (region.kind === 'sequence') {
      const list: Region[] = [];
      flatten(region, list);
      for (let index = 0; index + 1 < list.length; index++) {
        const left = list[index]!,
          right = list[index + 1]!;
        if (left.kind === 'block' && right.kind === 'block') pairs.push([left, right]);
      }
      for (const child of list) visit(child);
    } else if (region.kind === 'loop') visit(region.body);
    else {
      occurrences.set(region.id, (occurrences.get(region.id) ?? 0) + 1);
      for (const arm of controlArms(region.control)) if (arm.body) visit(arm.body);
    }
  };
  visit(body);
  const once = (id: string): boolean => occurrences.get(id) === 1;
  const entered = (id: string, transfers: readonly ParallelTransfer[]): boolean => {
    const list = predecessors.get(id) ?? [];
    return list.length === transfers.length && list.every((item) => transfers.includes(item));
  };
  /** The one retained load of a promoted local in `block` that `value` reads,
   * through pure inline expressions and constants only. */
  const flagRead = (value: Value, block: BlockRegion): Load | undefined => {
    const loads = new Map<string, Load>();
    for (const node of block.statements)
      if (node.kind === 'load' && program.retained.has(node.id) && locals.has(node.id))
        loads.set(node.result.id, node);
    let load: Load | undefined;
    const reads = (current: Value, depth: number): boolean => {
      context.checkpoint(1);
      const found = loads.get(current.id);
      if (found) {
        if (load && load !== found) return false;
        load = found;
        return true;
      }
      const expression = facts.expression(current.id);
      if (!expression || expression.kind === 'indeterminate' || depth > 32) return false;
      return expressionOperands(expression).every((operand) => reads(operand, depth + 1));
    };
    return reads(value, 0) ? load : undefined;
  };
  /** Whether `value` is 1 when `load` reads `flag`; undefined unless it is 0 or 1. */
  const evaluate = (value: Value, load: Load, flag: bigint): boolean | undefined => {
    const memo = new Map<string, RuntimeValue>();
    const get = (current: Value): RuntimeValue => {
      if (current.id === load.result.id) return bits(flag, bitWidth(current.type));
      const known = memo.get(current.id);
      if (known) return known;
      const expression = facts.expression(current.id);
      const computed: RuntimeValue = expression
        ? evaluateExpression(current.type, expression, get)
        : { kind: 'unknown', reason: 'flag operand' };
      memo.set(current.id, computed);
      return computed;
    };
    let computed: RuntimeValue;
    try {
      computed = get(value);
    } catch {
      // An operation outside the evaluator's domain proves nothing.
      return undefined;
    }
    return computed.kind === 'bits' && computed.bits <= 1n ? computed.bits === 1n : undefined;
  };
  /** The flag's content as written by a store: a 0/1 constant or the zero
   * extension of a one-bit value; undefined otherwise. */
  const written = (value: Value, depth = 0): boolean | Value | undefined => {
    if (depth > 16) return undefined;
    if (bitWidth(value.type) === 1) return value;
    const expression = program.expressions.get(value.id);
    if (expression?.kind === 'constant') {
      const bits = BigInt.asUintN(bitWidth(value.type), expression.bits);
      return bits === 0n ? false : bits === 1n ? true : undefined;
    }
    if (
      expression?.kind === 'cast' &&
      (expression.op === 'bitcast' || expression.op === 'zero_extend') &&
      expression.value.type.kind === 'integer'
    )
      return written(expression.value, depth + 1);
    return undefined;
  };
  /** The chain from `head` to `merge` carried by `local`, read once by `load`.
   * `quiet`: the head prints nothing at all (a nested chain is one operand). */
  const chain = (
    head: BlockRegion,
    merge: BlockRegion,
    local: string,
    load: string,
    quiet: boolean,
    nesting: number,
  ): FlagTest | undefined => {
    if (nesting > MAX_NESTING || !once(head.id) || !once(merge.id)) return undefined;
    const stages: FlagStage[] = [];
    const stores: string[] = [];
    const nested: string[] = [];
    const controls: string[] = [];
    const exits: ParallelTransfer[] = [];
    let block = head,
      // A nested chain's head printed right before `block` (its merge).
      previous: BlockRegion | undefined;
    for (;;) {
      context.checkpoint(1 + block.statements.length);
      if (stages.length > MAX_STAGES) return undefined;
      let index = -1;
      for (let at = block.statements.length - 1; at >= 0; at--)
        if (program.retained.has(block.statements[at]!.id)) {
          index = at;
          break;
        }
      const store = block.statements[index];
      if (
        store?.kind !== 'store' ||
        locals.get(store.id)?.id !== local ||
        !facts.inPlace(store.id) ||
        facts.anchored(store.id) ||
        facts.anchored(block.control.id) ||
        ((block !== head || quiet) && facts.anchored(block.id))
      )
        return undefined;
      // The outermost head keeps statements before its store.
      const silent = block === head && !quiet ? block.statements.slice(index) : block.statements;
      if (silent.some((node) => node !== store && facts.prints(node))) return undefined;
      stores.push(store.id);
      controls.push(block.control.id);
      const control = block.control;
      if (control.kind === 'jump') {
        if (
          block === head ||
          control.transfer.target !== merge.id ||
          facts.copies(control.transfer)
        )
          return undefined;
        exits.push(control.transfer);
        const last = previous ? copied(store, block, previous, nesting) : written(store.value);
        if (last === undefined || typeof last === 'boolean') return undefined;
        if ('chain' in last) {
          nested.push(...last.chain.accesses);
          controls.push(...last.chain.controls);
        }
        // The merge is entered exactly through the chain's exits, and the flag
        // is accessed only by the chain's stores and the merge's one load.
        if (!entered(merge.id, exits)) return undefined;
        const all = accesses.get(local) ?? [];
        if (
          all.length !== stores.length + 1 ||
          !all.includes(load) ||
          stores.some((id) => !all.includes(id))
        )
          return undefined;
        return {
          head: head.id,
          merge: merge.id,
          stages,
          last,
          positive: true,
          accesses: [...stores, load, ...nested],
          controls,
        };
      }
      const value = written(store.value);
      if (previous || control.kind !== 'if' || !facts.plain(control) || typeof value !== 'boolean')
        return undefined;
      const leave = [control.when_true, control.when_false].find(
        (arm) => !arm.body && arm.transfer.target === merge.id,
      );
      const stay = leave === control.when_true ? control.when_false : control.when_true;
      if (!leave || facts.copies(leave.transfer) || facts.copies(stay.transfer) || !stay.body)
        return undefined;
      const list: Region[] = [];
      flatten(stay.body, list);
      const first = list[0],
        next = list.at(-1);
      if (
        (list.length !== 1 && list.length !== 2) ||
        first?.kind !== 'block' ||
        next?.kind !== 'block' ||
        first.id !== stay.transfer.target ||
        !once(first.id) ||
        !entered(first.id, [stay.transfer])
      )
        return undefined;
      exits.push(leave.transfer);
      stages.push({ control, enter: stay === control.when_true, value });
      // Two blocks: a nested chain (its head, then its merge as the last stage).
      previous = list.length === 2 ? first : undefined;
      block = next;
    }
  };
  /** The last stage `block` copies the 0/1 flag of a nested chain headed by
   * `head` (its merge is `block`): exactly, or as its complement. */
  const copied = (
    store: Store,
    block: BlockRegion,
    head: BlockRegion,
    nesting: number,
  ): { readonly chain: FlagTest; readonly invert: boolean } | undefined => {
    const load = flagRead(store.value, block);
    const local = load && locals.get(load.id)?.id;
    if (!load || !local || local === locals.get(store.id)?.id) return undefined;
    if (!facts.readOnlyBy(load.result, store.id)) return undefined;
    const zero = evaluate(store.value, load, 0n),
      one = evaluate(store.value, load, 1n);
    if (zero === undefined || one === undefined || zero === one) return undefined;
    const inner = chain(head, block, local, load.id, true, nesting + 1);
    return inner && { chain: inner, invert: !one };
  };
  const match = (head: BlockRegion, merge: BlockRegion): FlagTest | undefined => {
    const test = merge.control;
    if (
      test.kind !== 'if' ||
      !facts.plain(test) ||
      facts.anchored(merge.id) ||
      facts.anchored(test.id) ||
      merge.statements.some((node) => facts.prints(node))
    )
      return undefined;
    // The merge test reads only the flag and tests exactly its bit.
    const load = flagRead(test.condition, merge);
    if (!load || !facts.readOnlyBy(load.result, test.id)) return undefined;
    const zero = evaluate(test.condition, load, 0n),
      one = evaluate(test.condition, load, 1n);
    if (zero === undefined || one === undefined || zero === one) return undefined;
    const found = chain(head, merge, locals.get(load.id)!.id, load.id, false, 0);
    return found && { ...found, positive: one };
  };
  for (const [head, merge] of pairs) {
    context.checkpoint(1);
    if (head.control.kind !== 'if' || merge.control.kind !== 'if') continue;
    const found = match(head, merge);
    if (found) result.set(merge.control.id, found);
  }
  return result;
}
