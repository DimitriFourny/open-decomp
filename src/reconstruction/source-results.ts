import type { AbiLocation, OperationContext, RegisterDescriptor } from '../core/index.js';
import type { StackRecoveryResult } from '../analysis/stack/index.js';
import { bitWidth, sameType, type DataType, type Expression, type Value } from '../ir/index.js';
import type { BlockRegion } from '../presentation/index.js';
import { registerTypes, type RegisterTypeSlice } from './source-register-types.js';

type RegisterLocation = Extract<AbiLocation, { kind: 'register' }>;

/** Evidence-based choice between the ABI integer and FP primary result
 * registers of an undeclared function. `float` binds the FP register on every
 * exit; `integer` keeps the integer path without the FP alternative (`reason`
 * when the FP register also qualified); `explicit` retains the physical exit
 * form because candidates or caller evidence conflict; `none` infers no
 * register result (observed native results remain). Null means no decision:
 * the caller's existing projection applies unchanged. */
export type SourcePrimaryResult =
  | {
      readonly kind: 'float';
      readonly location: RegisterLocation;
      readonly type: DataType;
      readonly rejected: string;
    }
  | { readonly kind: 'integer'; readonly reason?: string }
  | { readonly kind: 'explicit' | 'none'; readonly written: boolean; readonly reason: string };

type ExitState =
  | { readonly kind: 'undefined' | 'frame' | 'untyped' | 'vector' }
  | { readonly kind: 'unchanged' | 'written' | 'constant'; readonly type?: DataType };

export interface SourcePrimaryResultInput {
  readonly blocks: ReadonlyMap<string, BlockRegion>;
  readonly entry: BlockRegion;
  readonly expressions: ReadonlyMap<string, Expression>;
  /** Phi/edge-copy sources of block parameters. */
  readonly sources: ReadonlyMap<string, readonly Value[]>;
  readonly typed: ReadonlyMap<string, readonly RegisterTypeSlice[]>;
  /** Projected entry parameters and the register each one denotes. */
  readonly parameters: ReadonlyMap<string, RegisterDescriptor>;
  /** Call results projected by an observed or declared callee interface, by call. */
  readonly callResults: ReadonlyMap<string, readonly Value[]>;
  readonly stack: StackRecoveryResult | undefined;
  readonly integer: RegisterLocation;
  readonly floating: RegisterLocation;
  /** Roots that carry ABI arguments; their unchanged entry value is an input. */
  readonly argumentRoots: ReadonlySet<string>;
  /** Positive caller consumption; absence is not evidence of non-consumption. */
  readonly demands: readonly RegisterDescriptor[];
  /** Native written-result interface; consulted only when write order is mixed. */
  readonly observed: readonly RegisterDescriptor[];
  readonly context: OperationContext;
}

const transportCasts = ['bitcast', 'zero_extend', 'sign_extend', 'truncate'];
const scalarFloat = (type: DataType): boolean =>
  type.kind === 'float' && (type.bits === 32 || type.bits === 64);

/** A register qualifies as the primary result only when it is defined on every
 * exit path. Unknown entry values, unprojected call clobbers and addresses into
 * the dead frame never qualify. FP additionally needs typed IEEE evidence: a
 * written FP value on some exit, with literal bits or a typed argument elsewhere.
 * When both qualify, positive caller demand decides, then the register written
 * last on every exit path, then a native written-result interface naming exactly
 * one of them; otherwise the explicit form remains. */
export function selectSourcePrimaryResult(
  input: SourcePrimaryResultInput,
): SourcePrimaryResult | null {
  const { blocks, entry, expressions, sources, typed, parameters, stack, context } = input;
  const exits = [...blocks.values()].filter((block) => block.control.kind === 'return');
  if (!exits.length) return null;
  const callResults = new Set<string>();
  for (const values of input.callResults.values())
    for (const value of values) callResults.add(value.id);
  const loads = new Map<string, Value>(),
    storeValues = new Map<string, Value>(),
    computed = new Set<string>();
  for (const block of blocks.values())
    for (const node of block.statements) {
      context.checkpoint(1);
      if (node.kind === 'load') loads.set(node.result.id, node.address);
      else if (node.kind === 'store') storeValues.set(node.id, node.value);
      else if (node.kind === 'read_register') computed.add(node.result.id);
      if (node.kind === 'call') for (const value of node.results) computed.add(value.id);
    }
  const entryParameters = new Set(entry.parameters.map((value) => value.id));
  const frame = (value: Value): boolean => {
    const kind = stack?.values.get(value.id)?.value.kind;
    return kind === 'stack' || kind === 'stack_fragment' || kind === 'dynamic_stack';
  };
  // Leaves of one exit slice through lossless transport, phis and projections.
  const walk = (start: Value, root: string) => {
    const leaves: Value[] = [];
    let self = 0,
      constants = 0;
    const pending = [start],
      seen = new Set<string>();
    while (pending.length) {
      context.checkpoint(1);
      const value = pending.pop()!;
      if (seen.has(value.id)) continue;
      seen.add(value.id);
      if (seen.size > 256) return { kind: 'undefined' as const };
      if (frame(value)) return { kind: 'frame' as const };
      const parameter = parameters.get(value.id);
      if (parameter) {
        if (parameter.root === root) self++;
        else leaves.push(value);
        continue;
      }
      if (callResults.has(value.id) || computed.has(value.id)) {
        leaves.push(value);
        continue;
      }
      const expression = expressions.get(value.id);
      if (expression) {
        if (expression.kind === 'indeterminate') return { kind: 'undefined' as const };
        if (expression.kind === 'constant') constants++;
        else if (expression.kind === 'cast' && transportCasts.includes(expression.op))
          pending.push(expression.value);
        else if (expression.kind === 'extract' || expression.kind === 'insert')
          pending.push(expression.value);
        else if (expression.kind === 'concat') pending.push(...expression.values);
        else leaves.push(value);
        continue;
      }
      const incoming = sources.get(value.id);
      if (incoming?.length) {
        pending.push(...incoming);
        continue;
      }
      if (loads.has(value.id)) {
        if (stack?.values.get(value.id)?.initialization === 'uninitialized')
          return { kind: 'undefined' as const };
        leaves.push(value);
        continue;
      }
      // Declared entry inputs of IR without register projection.
      if (entryParameters.has(value.id)) {
        leaves.push(value);
        continue;
      }
      // Unprojected call clobbers, unknown effects and values of unknown origin.
      return { kind: 'undefined' as const };
    }
    return {
      kind: leaves.length || constants ? ('written' as const) : ('unchanged' as const),
      leaves,
      constants,
      self,
    };
  };
  // Values of every direct store to the exact loaded stack slot; partially
  // overlapping or dynamic stack writes leave the slot contents unknown.
  const slotStores = (load: Value): Value[] | undefined => {
    const address = loads.get(load.id);
    const fact = address && stack?.state === 'complete' ? stack.values.get(address.id) : undefined;
    if (fact?.value.kind !== 'stack' || bitWidth(load.type) % 8) return undefined;
    const offset = fact.value.offset,
      size = BigInt(bitWidth(load.type) / 8);
    const stored: Value[] = [];
    for (const access of stack!.accesses) {
      context.checkpoint(1);
      if (access.kind !== 'write') continue;
      if (access.offset === null) return undefined;
      if (access.offset >= offset + size || access.offset + access.size <= offset) continue;
      const value = storeValues.get(access.node_id);
      if (access.offset !== offset || access.size !== size || !value) return undefined;
      stored.push(value);
    }
    return stored;
  };
  // Every stored value is typed FP of the slot width or literal bits.
  const slotType = (load: Value): DataType | undefined => {
    let type: DataType | undefined;
    for (const stored of slotStores(load) ?? []) {
      if (expressions.get(stored.id)?.kind === 'constant') continue;
      const slice = typed
        .get(stored.id)
        ?.find(
          (candidate) =>
            candidate.offset === 0 &&
            scalarFloat(candidate.type) &&
            bitWidth(candidate.type) === bitWidth(load.type),
        );
      if (!slice || (type && !sameType(type, slice.type))) return undefined;
      type = slice.type;
    }
    return type;
  };
  // Path-sensitive write order. A definition site is an SSA statement in its
  // structured block; block parameters merge at their block, entry values and
  // projected parameters precede everything.
  type Site = { readonly block: string; readonly index: number };
  const sites = new Map<string, Site>();
  for (const binding of entry.register_entry)
    sites.set(binding.value.id, { block: entry.id, index: -2 });
  const incoming = new Map<string, { readonly copies: ReadonlyMap<string, Value> }[]>();
  const successors = new Map<string, string[]>();
  for (const block of blocks.values()) {
    for (const parameter of block.parameters)
      sites.set(parameter.id, { block: block.id, index: block.id === entry.id ? -2 : -1 });
    block.statements.forEach((node, index) => {
      const site = { block: block.id, index };
      if ('result' in node) sites.set(node.result.id, site);
      if (node.kind === 'call')
        for (const value of [...node.results, ...(input.callResults.get(node.id) ?? [])])
          sites.set(value.id, site);
      if ('register_outputs' in node)
        for (const binding of node.register_outputs) sites.set(binding.value.id, site);
    });
    const control = block.control;
    const transfers =
      control.kind === 'jump'
        ? [control.transfer]
        : control.kind === 'if'
          ? [control.when_true.transfer, control.when_false.transfer]
          : control.kind === 'switch'
            ? [...control.cases.map((item) => item.arm.transfer), control.otherwise.transfer]
            : [];
    successors.set(
      block.id,
      transfers.map((transfer) => transfer.target),
    );
    for (const transfer of transfers) {
      const row = incoming.get(transfer.target) ?? [];
      row.push({
        copies: new Map(transfer.copies.map((copy) => [copy.destination.id, copy.source])),
      });
      incoming.set(transfer.target, row);
    }
  }
  let idom: Map<string, string> | undefined;
  const dominates = (dominator: string, block: string): boolean => {
    if (!idom) {
      // Cooper–Harvey–Kennedy over reverse postorder.
      const order: string[] = [],
        visited = new Set<string>(),
        stack: { id: string; next: number }[] = [{ id: entry.id, next: 0 }];
      visited.add(entry.id);
      while (stack.length) {
        context.checkpoint(1);
        const top = stack.at(-1)!,
          next = (successors.get(top.id) ?? [])[top.next++];
        if (next === undefined) order.push(stack.pop()!.id);
        else if (!visited.has(next) && blocks.has(next)) {
          visited.add(next);
          stack.push({ id: next, next: 0 });
        }
      }
      order.reverse();
      const rank = new Map(order.map((id, index) => [id, index]));
      const predecessors = new Map<string, string[]>();
      for (const [from, targets] of successors)
        for (const target of targets)
          if (rank.has(from)) predecessors.set(target, [...(predecessors.get(target) ?? []), from]);
      const result = new Map<string, string>([[entry.id, entry.id]]);
      const intersect = (left: string, right: string): string => {
        while (left !== right) {
          context.checkpoint(1);
          while (rank.get(left)! > rank.get(right)!) left = result.get(left)!;
          while (rank.get(right)! > rank.get(left)!) right = result.get(right)!;
        }
        return left;
      };
      for (let changed = true; changed;) {
        changed = false;
        for (const id of order.slice(1)) {
          const known = (predecessors.get(id) ?? []).filter((from) => result.has(from));
          if (!known.length) continue;
          const candidate = known.slice(1).reduce(intersect, known[0]!);
          if (result.get(id) !== candidate) {
            result.set(id, candidate);
            changed = true;
          }
        }
      }
      idom = result;
    }
    for (let current: string | undefined = block; current !== undefined;) {
      context.checkpoint(1);
      if (current === dominator) return true;
      const parent = idom.get(current);
      current = parent === current ? undefined : parent;
    }
    return false;
  };
  const siteOf = (value: Value): { readonly site: Site; readonly value: Value } | undefined => {
    let current = value;
    for (let depth = 0; depth < 16; depth++) {
      const site =
        sites.get(current.id) ??
        (parameters.has(current.id) ? { block: entry.id, index: -2 } : undefined);
      if (site) return { site, value: current };
      const expression = expressions.get(current.id);
      if (
        (expression?.kind === 'cast' && transportCasts.includes(expression.op)) ||
        expression?.kind === 'extract' ||
        expression?.kind === 'insert'
      )
        current = expression.value;
      else return undefined;
    }
    return undefined;
  };
  // Which of two exit values was written last on every path into the exit:
  // a definition dominated by the other's (later in the same block) is later;
  // merges compare per incoming edge and must agree.
  const later = (first: Value, second: Value, depth = 0): 'first' | 'second' | undefined => {
    context.checkpoint(1);
    const x = siteOf(first),
      y = siteOf(second);
    if (!x || !y || depth > 16 || x.value.id === y.value.id) return undefined;
    const after = (p: Site, q: Site): boolean =>
      p.index !== -1 && dominates(q.block, p.block) && (p.block !== q.block || p.index > q.index);
    if (after(x.site, y.site)) return 'first';
    if (after(y.site, x.site)) return 'second';
    const mergeX = x.site.index === -1,
      mergeY = y.site.index === -1;
    const block =
      mergeX && mergeY && x.site.block === y.site.block
        ? x.site.block
        : mergeX && dominates(y.site.block, x.site.block) && !mergeY
          ? x.site.block
          : mergeY && dominates(x.site.block, y.site.block) && !mergeX
            ? y.site.block
            : undefined;
    const edges = block === undefined ? [] : (incoming.get(block) ?? []);
    let result: 'first' | 'second' | undefined;
    for (const edge of edges) {
      const left = x.site.block === block && mergeX ? edge.copies.get(x.value.id) : first,
        right = y.site.block === block && mergeY ? edge.copies.get(y.value.id) : second;
      const order = left && right ? later(left, right, depth + 1) : undefined;
      if (!order || (result && result !== order)) return undefined;
      result = order;
    }
    return result;
  };
  const exitValue = (block: BlockRegion, location: RegisterLocation): Value | undefined =>
    block.register_exit.find(
      (binding) =>
        binding.register.root === location.register.root &&
        binding.register.offset_bits === location.register.offset_bits,
    )?.value;
  const state = (block: BlockRegion, location: RegisterLocation, floating: boolean): ExitState => {
    const root = location.register.root,
      offset = location.register.offset_bits;
    const cell = block.register_exit.find(
      (binding) => binding.register.root === root && binding.register.offset_bits === offset,
    );
    if (!cell) return { kind: 'unchanged' };
    const walked = walk(cell.value, root);
    if (walked.kind !== 'written' && walked.kind !== 'unchanged') return walked;
    if (!floating) return { kind: walked.kind };
    const types = registerTypes(
      block.register_exit,
      root,
      offset,
      typed,
      context,
      walked.kind === 'written',
    );
    const scalar = types.find(scalarFloat);
    if (scalar) return { kind: walked.kind, type: scalar };
    if (walked.kind === 'unchanged') return { kind: 'unchanged' };
    if (types.some((type) => type.kind === 'vector')) return { kind: 'vector' };
    if (!walked.leaves.length) return { kind: 'constant' };
    let type: DataType | undefined;
    for (const leaf of walked.leaves) {
      const slot = loads.has(leaf.id) ? slotType(leaf) : undefined;
      if (!slot || (type && !sameType(type, slot))) return { kind: 'untyped' };
      type = slot;
    }
    return type ? { kind: 'written', type } : { kind: 'untyped' };
  };
  const integerStates = exits.map((block) => state(block, input.integer, false));
  const floatingStates = exits.map((block) => state(block, input.floating, true));
  // Vector interpretations of the FP carrier belong to the existing typed path.
  if (floatingStates.some((item) => item.kind === 'vector')) return null;
  const integerReason = integerStates.find(
    (item) =>
      item.kind === 'undefined' ||
      item.kind === 'frame' ||
      (item.kind === 'unchanged' && !input.argumentRoots.has(input.integer.register.root)),
  );
  const integerQualifies =
    integerReason === undefined && integerStates.some((item) => item.kind === 'written');
  let floatingType: DataType | undefined;
  let floatingQualifies = floatingStates.every(
    (item) =>
      item.kind === 'constant' ||
      ((item.kind === 'written' || item.kind === 'unchanged') && item.type !== undefined),
  );
  for (const item of floatingStates) {
    if (!floatingQualifies || !('type' in item) || !item.type) continue;
    if (floatingType && !sameType(floatingType, item.type)) floatingQualifies = false;
    floatingType ??= item.type;
  }
  floatingQualifies &&= floatingStates.some((item) => item.kind === 'written');
  const written =
    integerStates.some((item) => item.kind === 'written') ||
    floatingStates.some(
      (item) => item.kind === 'written' || item.kind === 'constant' || item.kind === 'untyped',
    );
  const demanded = (location: RegisterLocation): boolean =>
    input.demands.some((register) => register.root === location.register.root);
  const integerDemanded = demanded(input.integer),
    floatingDemanded = demanded(input.floating);
  const describe = (item: ExitState | undefined): string =>
    item?.kind === 'frame'
      ? 'holds an address into the returning frame on some exit'
      : item?.kind === 'unchanged'
        ? 'holds the unchanged entry value of a non-argument register on some exit'
        : 'is undefined on some exit (unknown entry value or unprojected call clobber)';
  const integerName = input.integer.register.root,
    floatingName = input.floating.register.root;
  let choice: 'float' | 'integer' | undefined,
    evidence = '';
  if (integerQualifies && floatingQualifies && floatingType) {
    if (integerDemanded !== floatingDemanded) {
      choice = floatingDemanded ? 'float' : 'integer';
      evidence = `observed callers consume only ${floatingDemanded ? floatingName : integerName}`;
    } else if (integerDemanded)
      evidence = `callers consume both ${integerName} and ${floatingName}`;
    else {
      const orders = exits.map((block) => {
        const integerValue = exitValue(block, input.integer),
          floatingValue = exitValue(block, input.floating);
        return integerValue && floatingValue ? later(integerValue, floatingValue) : undefined;
      });
      const observed = (location: RegisterLocation): boolean =>
        input.observed.some((register) => register.root === location.register.root);
      if (orders.every((order) => order === orders[0]) && orders[0]) {
        choice = orders[0] === 'first' ? 'integer' : 'float';
        evidence = `${choice === 'float' ? floatingName : integerName} is written after ${choice === 'float' ? integerName : floatingName} on every exit path`;
      } else if (observed(input.integer) !== observed(input.floating)) {
        choice = observed(input.floating) ? 'float' : 'integer';
        evidence = `no consistent last write on every exit path; the native written-result interface names only ${choice === 'float' ? floatingName : integerName}`;
      } else evidence = 'no consistent last write on every exit path';
    }
    if (!choice)
      return {
        kind: 'explicit',
        written,
        reason: `${integerName} and typed ${floatingName} are both written on every exit${evidence ? `; ${evidence}` : ' with no distinguishing evidence'}`,
      };
  } else if (floatingQualifies && floatingType) {
    if (integerDemanded)
      return {
        kind: 'explicit',
        written,
        reason: `callers consume ${integerName} while only ${floatingName} qualifies`,
      };
    choice = 'float';
    evidence = integerStates.some((item) => item.kind === 'written')
      ? `${integerName} ${describe(integerReason)}`
      : `${integerName} is never written`;
  } else if (integerQualifies) {
    if (floatingDemanded && !integerDemanded)
      return {
        kind: 'explicit',
        written,
        reason: `callers consume ${floatingName} while only ${integerName} qualifies`,
      };
    return { kind: 'integer' };
  } else
    return {
      kind: 'none',
      written,
      reason: `neither ${integerName} nor typed ${floatingName} is defined by this function on every exit`,
    };
  return choice === 'float'
    ? {
        kind: 'float',
        location: { ...input.floating, width_bits: bitWidth(floatingType!) },
        type: floatingType!,
        rejected: evidence,
      }
    : { kind: 'integer', reason: `${floatingName} also qualifies; ${evidence}` };
}
