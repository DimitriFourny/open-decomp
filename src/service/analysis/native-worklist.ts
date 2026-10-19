import {
  OperationError,
  type Evidence,
  type FunctionRecord,
  type OperationContext,
  type RegisterDescriptor,
} from '../../core/index.js';
import type { InferredCallee } from '../../reconstruction/source-model.js';
import type { NativeParameterShape } from '../../analysis/types/memory-shapes.js';
import type { DataType } from '../../ir/index.js';
import { nativeContextKey, type NativeContext } from './native-context.js';

export type NativeInterface = Omit<InferredCallee, 'call_id' | 'evidence_ids'> & {
  readonly parameter_shapes?: readonly NativeParameterShape[];
  /** Context/import-tail refinements never replace the original checked interface. */
  readonly source_interface?: Omit<NativeInterface, 'source_interface'>;
  /** Actual written result storage. Consumption alone is not a write/extension
   * guarantee and therefore never seeds a recursive dependency's contract. */
  readonly written_result?: {
    readonly registers: readonly RegisterDescriptor[];
    readonly types: readonly DataType[];
  };
};
export interface NativeDependency {
  readonly call_id: string;
  readonly target: FunctionRecord;
  readonly return_demand?: readonly RegisterDescriptor[];
  readonly assumptions?: NativeContext;
  readonly evidence_ids?: readonly string[];
  readonly original_subject_ids?: readonly string[];
}
export interface NativeSummaryCapacity {
  readonly instructions: number;
  readonly blocks: number;
  readonly nodes: number;
}
export interface NativeSummaryUnit extends NativeSummaryCapacity {
  readonly function: FunctionRecord;
  /** Peak construction capacity, not just the final simplified node count. */
  readonly required_nodes: number;
  readonly dependencies: readonly NativeDependency[];
  readonly evidence: readonly Evidence[];
  readonly evidence_ids: readonly string[];
  readonly reasons: readonly string[];
  readonly budget_truncated: boolean;
  /** Complete machine call/stack semantics, independently of optional debug/type metadata. */
  readonly arity_complete?: boolean;
}
export interface NativeSummary {
  readonly observed: NativeInterface;
  readonly evidence_ids: readonly string[];
  readonly reasons: readonly string[];
  readonly complete: boolean;
  readonly arity_complete?: boolean;
}
export interface NativeWorklistResult<U extends NativeSummaryUnit> {
  readonly units: ReadonlyMap<string, U>;
  readonly summaries: ReadonlyMap<string, NativeSummary>;
  /** Requested context key to the effective (possibly generic) bounded unit. */
  readonly context_keys: ReadonlyMap<string, string>;
  readonly remaining: NativeSummaryCapacity;
  readonly complete: boolean;
}

const unresolved = (): NativeInterface => ({
  parameters: [],
  returns: [],
  parameter_state: 'ambiguous',
  argument_list_complete: false,
});

/** Recursive dependency groups among loaded units (strongly connected
 * components with more than one member or a self edge), callees first. */
function recursiveGroups<U extends NativeSummaryUnit>(
  units: ReadonlyMap<string, U>,
  key: (dependency: NativeDependency) => string,
  context: OperationContext,
): string[][] {
  const index = new Map<string, number>(),
    low = new Map<string, number>(),
    onStack = new Set<string>(),
    stack: string[] = [],
    groups: string[][] = [];
  const edges = (id: string): string[] =>
    [...new Set(units.get(id)!.dependencies.map(key))].filter((target) => units.has(target));
  for (const root of units.keys()) {
    if (index.has(root)) continue;
    const frames: { id: string; next: string[] }[] = [];
    const enter = (id: string): void => {
      index.set(id, index.size);
      low.set(id, index.get(id)!);
      stack.push(id);
      onStack.add(id);
      frames.push({ id, next: edges(id) });
    };
    enter(root);
    while (frames.length) {
      context.checkpoint(1);
      const frame = frames.at(-1)!;
      const target = frame.next.pop();
      if (target !== undefined) {
        if (!index.has(target)) enter(target);
        else if (onStack.has(target))
          low.set(frame.id, Math.min(low.get(frame.id)!, index.get(target)!));
        continue;
      }
      frames.pop();
      const parent = frames.at(-1);
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) !== index.get(frame.id)) continue;
      const group: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        group.push(member);
      } while (member !== frame.id);
      if (group.length > 1 || edges(frame.id).includes(frame.id)) groups.push(group);
    }
  }
  return groups;
}

/** Analyze only the direct dependency closure of the requested roots. Loading and
 * refinement are separate: a recursive edge never reloads/re-lifts its caller.
 * The injected loader owns graph/SSA work and must honor the supplied capacities;
 * the observer reuses that prepared unit and performs no graph/type analysis.
 *
 * Interface transfer is monotone: an observer may add proven input requirements
 * and refine output guarantees, but must not treat an absent dependency as a
 * zero-argument declaration. Fixed-point equality is supplied by the observer so
 * all transported evidence/types (not just register names) participate. */
export function nativeDependencyWorklist<U extends NativeSummaryUnit>(options: {
  readonly roots: readonly FunctionRecord[];
  readonly root_dependencies?: readonly NativeDependency[];
  readonly max_contexts_per_function?: number;
  readonly max_contexts?: number;
  readonly specialize?: (baseline: U, assumptions: NativeContext, context: OperationContext) => U;
  readonly context: OperationContext;
  readonly capacity: NativeSummaryCapacity;
  readonly max_functions: number;
  readonly max_refinements: number;
  /** Borrowed live maps for conservative recovery if optional work stops. */
  readonly on_partial?: (
    units: ReadonlyMap<string, U>,
    summaries: ReadonlyMap<string, NativeSummary>,
  ) => void;
  readonly return_demands?: ReadonlyMap<string, readonly RegisterDescriptor[]>;
  /** Already analyzed selected bodies are reused if recursion reaches them. */
  readonly preloaded?: ReadonlyMap<string, U>;
  readonly load: (fn: FunctionRecord, context: OperationContext) => U;
  readonly observe: (
    unit: U,
    dependencies: ReadonlyMap<string, NativeInterface>,
    context: OperationContext,
    demandedReturns: readonly RegisterDescriptor[],
  ) => NativeInterface;
  readonly equal: (left: NativeInterface, right: NativeInterface) => boolean;
  /** Locally authored return witnesses seed recursive SCCs; no dependency output
   * may be treated as an authored witness. Normal observations validate all exits. */
  readonly initialize: (
    unit: U,
    context: OperationContext,
    demandedReturns: readonly RegisterDescriptor[],
  ) => NativeInterface;
}): NativeWorklistResult<U> {
  const { context } = options;
  const units = new Map<string, U>(),
    summaries = new Map<string, NativeSummary>();
  const scheduled = new Set<string>();
  const pending: {
    readonly fn: FunctionRecord;
    readonly key: string;
    readonly assumptions?: NativeContext;
  }[] = [];
  const baselines = new Map<string, U>(),
    contextKeys = new Map<string, string>();
  const contextCounts = new Map<string, number>(),
    fallbackReasons = new Map<string, string>();
  let contextCount = 0;
  const failures = new Map<string, string[]>(),
    parents = new Map<string, Set<string>>();
  const refinements = new Map<string, number>(),
    refinementLimits = new Map<string, string>();
  const demands = new Map<string, Map<string, RegisterDescriptor>>();
  const demand = (id: string, registers: readonly RegisterDescriptor[]): void => {
    const known = demands.get(id) ?? new Map<string, RegisterDescriptor>();
    for (const register of registers) {
      context.checkpoint(1);
      const prior = known.get(register.root);
      known.set(register.root, {
        ...register,
        offset_bits: 0,
        width_bits: Math.max(prior?.width_bits ?? 0, register.offset_bits + register.width_bits),
      });
    }
    demands.set(id, known);
  };
  for (const [id, registers] of options.return_demands ?? []) demand(id, registers);
  let remaining = { ...options.capacity };
  const schedule = (fn: FunctionRecord, assumptions?: NativeContext): string => {
    context.checkpoint(1);
    const requested = nativeContextKey(fn.id, assumptions);
    const prior = contextKeys.get(requested);
    if (prior) return prior;
    const count = contextCounts.get(fn.id) ?? 0;
    if (
      assumptions &&
      (!options.specialize ||
        count >= (options.max_contexts_per_function ?? 4) ||
        contextCount >= (options.max_contexts ?? 64))
    ) {
      fallbackReasons.set(fn.id, 'native context limit: conservative generic interface');
      assumptions = undefined;
    }
    const key = nativeContextKey(fn.id, assumptions);
    contextKeys.set(requested, key);
    if (scheduled.has(key)) return key;
    if (assumptions) {
      contextCounts.set(fn.id, count + 1);
      contextCount++;
    }
    scheduled.add(key);
    pending.push({ fn, key, ...(assumptions ? { assumptions } : {}) });
    return key;
  };
  for (const root of options.roots) schedule(root);
  for (const dependency of options.root_dependencies ?? [])
    demand(schedule(dependency.target, dependency.assumptions), dependency.return_demand ?? []);
  const initialWork = context.remainingWork?.();
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const { fn, key, assumptions } = pending[cursor]!;
    context.checkpoint(1);
    const prepared = baselines.get(fn.id) ?? options.preloaded?.get(fn.id);
    if (!baselines.has(fn.id) && baselines.size >= options.max_functions) {
      failures.set(key, [`native dependency function limit (${options.max_functions})`]);
      continue;
    }
    if (
      !prepared &&
      (remaining.instructions <= 0 || remaining.blocks <= 0 || remaining.nodes <= 0)
    ) {
      const exhausted = (['instructions', 'blocks', 'nodes'] as const).filter(
        (resource) => remaining[resource] <= 0,
      );
      failures.set(key, [`native dependency ${exhausted.join('/')} capacity exhausted`]);
      continue;
    }
    // Fair shares: one expensive dependency cannot starve refinement of the
    // others. A load receives at most a quarter of the remaining work and no
    // new body is loaded once half of the initial allowance is gone, so finished
    // interfaces keep a reserve for the fixed point instead of all being lost
    // at the shared limit. An exhausted share is that dependency's own limit.
    const available = context.remainingWork?.();
    if (!prepared && available !== undefined && initialWork !== undefined) {
      if (available < initialWork / 2) {
        failures.set(key, [`native dependency load work reserve (${initialWork})`]);
        continue;
      }
    }
    const share = available === undefined ? undefined : Math.max(1, Math.floor(available / 4));
    let used = 0,
      loading = true;
    const bounded: OperationContext = {
      ...context,
      budget: {
        ...context.budget,
        instructions: remaining.instructions,
        blocks: remaining.blocks,
        ir_nodes: remaining.nodes,
      },
      ...(share === undefined
        ? {}
        : {
            // Loaders may retain this context (lazy indexes); the share bounds
            // only the load itself.
            remainingWork: () =>
              loading
                ? Math.max(0, Math.min(share - used, context.remainingWork!()))
                : context.remainingWork!(),
            checkpoint(work: number) {
              if (loading && used + work > share)
                throw new OperationError({
                  code: 'resource_limit',
                  severity: 'warning',
                  message: 'Native dependency work share exhausted',
                  evidence_ids: [],
                  details: { kind: 'limit', resource: 'work', limit: share, consumed: used + work },
                });
              context.checkpoint(work);
              used += work;
            },
          }),
    };
    let unit: U;
    try {
      unit = prepared ?? options.load(fn, bounded);
      loading = false;
    } catch (error) {
      loading = false;
      const details = error instanceof OperationError ? error.diagnostic.details : undefined;
      // Only this optional dependency's capacities are recoverable. Cancellation,
      // deadlines, selected-body failures and the outer work limit still escape.
      const local =
        details?.kind === 'limit' &&
        ((details.resource === 'ir_nodes' && details.limit === remaining.nodes) ||
          (details.resource === 'blocks' && details.limit === remaining.blocks) ||
          (details.resource === 'instructions' && details.limit === remaining.instructions) ||
          (details.resource === 'work' && share !== undefined && details.limit === share));
      if (!(error instanceof OperationError) || error.code !== 'resource_limit' || !local)
        throw error;
      context.checkpoint(0);
      failures.set(key, [`native dependency ${details.resource} limit (${details.limit})`]);
      continue;
    }
    if (
      !prepared &&
      (unit.instructions > remaining.instructions ||
        unit.blocks > remaining.blocks ||
        unit.required_nodes > remaining.nodes)
    ) {
      failures.set(key, [
        'native dependency loader exceeded its reserved instruction/block/IR capacity',
      ]);
      continue;
    }
    if (!prepared)
      remaining = {
        instructions: remaining.instructions - unit.instructions,
        blocks: remaining.blocks - unit.blocks,
        nodes: remaining.nodes - unit.nodes,
      };
    baselines.set(fn.id, unit);
    if (assumptions && options.specialize) {
      try {
        unit = options.specialize(unit, assumptions, {
          ...context,
          budget: { ...context.budget, ir_nodes: remaining.nodes, blocks: remaining.blocks },
        });
        remaining = {
          ...remaining,
          nodes: remaining.nodes - unit.nodes,
          blocks: remaining.blocks - unit.blocks,
        };
      } catch (error) {
        const details = error instanceof OperationError ? error.diagnostic.details : undefined;
        if (
          !(error instanceof OperationError) ||
          error.code !== 'resource_limit' ||
          details?.kind !== 'limit' ||
          !(
            (details.resource === 'ir_nodes' && details.limit === remaining.nodes) ||
            (details.resource === 'blocks' && details.limit === remaining.blocks)
          )
        )
          throw error;
        context.checkpoint(0);
        unit = baselines.get(fn.id)!;
        fallbackReasons.set(
          key,
          `native context ${details.resource} capacity: conservative generic interface`,
        );
      }
    }
    units.set(key, unit);
    // An incomplete graph must not turn its visible calls into a complete closure.
    options.on_partial?.(units, summaries);
    for (const dependency of unit.dependencies) {
      context.checkpoint(1);
      const dependencyKey = schedule(dependency.target, dependency.assumptions);
      const callers = parents.get(dependencyKey) ?? new Set<string>();
      callers.add(key);
      parents.set(dependencyKey, callers);
      demand(dependencyKey, dependency.return_demand ?? []);
    }
  }
  for (const [id, unit] of units)
    summaries.set(id, {
      observed: options.initialize(unit, context, [...(demands.get(id)?.values() ?? [])]),
      evidence_ids: unit.evidence_ids,
      reasons: unit.reasons,
      complete: false,
    });
  options.on_partial?.(units, summaries);

  const dependencyKey = (dependency: NativeDependency): string =>
    contextKeys.get(nativeContextKey(dependency.target.id, dependency.assumptions)) ??
    dependency.target.id;
  const dependenciesOf = (
    unit: U,
    assumed?: ReadonlyMap<string, NativeInterface>,
  ): Map<string, NativeInterface> => {
    const dependencies = new Map<string, NativeInterface>();
    for (const dependency of unit.dependencies) {
      context.checkpoint(1);
      const key = dependencyKey(dependency);
      dependencies.set(
        dependency.call_id,
        assumed?.get(key) ?? summaries.get(key)?.observed ?? unresolved(),
      );
    }
    return dependencies;
  };
  // Refinement runs in three quarters of what loading left, so limit and
  // reason propagation below always finish. When it stops, every summary whose
  // observation is still pending, or that transitively depends on one, is cut
  // with an explicit refinement limit; all others are already at their fixed
  // point and keep their established facts.
  const refineLimit =
    context.remainingWork === undefined ? undefined : Math.floor((context.remainingWork() * 3) / 4);
  let refineUsed = 0;
  const refineContext: OperationContext =
    refineLimit === undefined
      ? context
      : {
          ...context,
          remainingWork: () =>
            Math.max(0, Math.min(refineLimit - refineUsed, context.remainingWork!())),
          checkpoint(work: number) {
            if (refineUsed + work > refineLimit)
              throw new OperationError({
                code: 'resource_limit',
                severity: 'warning',
                message: 'Native interface refinement work share exhausted',
                evidence_ids: [],
                details: {
                  kind: 'limit',
                  resource: 'work',
                  limit: refineLimit,
                  consumed: refineUsed + work,
                },
              });
            context.checkpoint(work);
            refineUsed += work;
          },
        };
  const unsettled = new Set<string>();
  // A changed callee schedules only its direct callers. Self/mutual recursion use
  // the same finite queue and the same shared operation/work clock as all roots.
  const refine = (initial: readonly string[]): void => {
    const queue = [...initial],
      queued = new Set(queue);
    for (const id of queue) unsettled.add(id);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      refineContext.checkpoint(1);
      const id = queue[cursor]!;
      queued.delete(id);
      const unit = units.get(id)!;
      const visits = (refinements.get(id) ?? 0) + 1;
      if (visits > options.max_refinements) {
        refinementLimits.set(id, `native interface refinement limit (${options.max_refinements})`);
        unsettled.delete(id);
        continue;
      }
      refinements.set(id, visits);
      const observed = options.observe(unit, dependenciesOf(unit), refineContext, [
          ...(demands.get(id)?.values() ?? []),
        ]),
        previous = summaries.get(id)!;
      if (!queued.has(id)) unsettled.delete(id);
      if (options.equal(previous.observed, observed)) continue;
      summaries.set(id, { ...previous, observed });
      options.on_partial?.(units, summaries);
      for (const caller of parents.get(id) ?? []) {
        refineContext.checkpoint(1);
        if (queued.has(caller) || !units.has(caller)) continue;
        queued.add(caller);
        queue.push(caller);
        unsettled.add(caller);
      }
    }
  };

  // Least-fixpoint refinement starts every recursive member open, so a group
  // whose members wait only on each other never closes its argument lists.
  // Coinductive check: assume every member closed with its current observed
  // parameters, re-observe each body once against those assumptions, and keep
  // the results only when every member then closes with exactly the assumed
  // parameters. Any actual read happens at a finite call depth, so induction
  // over that depth makes the self-consistent assumption a proof; otherwise the
  // group stays open.
  const parameterKey = (observed: NativeInterface): string =>
    observed.parameters
      .map((register) => `${register.root}:${register.offset_bits}:${register.width_bits}`)
      .join(',');
  try {
    refine([...units.keys()]);
    for (const group of recursiveGroups(units, dependencyKey, refineContext)) {
      const members = group.map((id) => [id, summaries.get(id)!] as const);
      if (
        members.every(([, summary]) => summary.observed.argument_list_closure !== undefined) ||
        members.some(
          ([id, summary]) =>
            summary.observed.parameter_state === 'ambiguous' ||
            summary.observed.variadic_stack ||
            summary.observed.stack_parameters?.length ||
            refinementLimits.has(id),
        )
      )
        continue;
      const assumed = new Map(
        members.map(([id, summary]) => [
          id,
          {
            ...summary.observed,
            argument_list_closure: summary.observed.argument_list_closure ?? 'callee_reads',
          } satisfies NativeInterface,
        ]),
      );
      const results = members.map(([id]) => {
        const unit = units.get(id)!;
        return [
          id,
          options.observe(unit, dependenciesOf(unit, assumed), refineContext, [
            ...(demands.get(id)?.values() ?? []),
          ]),
        ] as const;
      });
      if (
        !results.every(
          ([id, observed]) =>
            observed.argument_list_closure !== undefined &&
            observed.parameter_state !== 'ambiguous' &&
            parameterKey(observed) === parameterKey(assumed.get(id)!),
        )
      )
        continue;
      const outside = new Set<string>();
      for (const [id, observed] of results) {
        summaries.set(id, { ...summaries.get(id)!, observed });
        for (const caller of parents.get(id) ?? [])
          if (!group.includes(caller)) outside.add(caller);
      }
      options.on_partial?.(units, summaries);
      refine([...outside]);
    }
  } catch (error) {
    const details = error instanceof OperationError ? error.diagnostic.details : undefined;
    if (
      !(error instanceof OperationError) ||
      error.code !== 'resource_limit' ||
      details?.kind !== 'limit' ||
      details.resource !== 'work' ||
      refineLimit === undefined ||
      details.limit > refineLimit
    )
      throw error;
    context.checkpoint(0);
    const cut = [...unsettled];
    for (let cursor = 0; cursor < cut.length; cursor++)
      for (const caller of parents.get(cut[cursor]!) ?? []) {
        context.checkpoint(1);
        if (!units.has(caller) || unsettled.has(caller)) continue;
        unsettled.add(caller);
        cut.push(caller);
      }
    for (const id of unsettled)
      refinementLimits.set(id, `native interface refinement work limit (${refineLimit})`);
  }

  // Limit/reason propagation is itself a bounded fixed point. SCCs with no open
  // dependencies are closed; recursion alone is not an unavailable-semantics gap.
  const reasons = new Map<string, Set<string>>();
  const arityComplete = new Map<string, boolean>();
  for (const [id, unit] of units) {
    arityComplete.set(
      id,
      (unit.arity_complete ?? unit.reasons.length === 0) &&
        !unit.budget_truncated &&
        !fallbackReasons.has(id) &&
        !refinementLimits.has(id),
    );
    reasons.set(
      id,
      new Set([
        ...unit.reasons,
        ...(fallbackReasons.has(id) ? [fallbackReasons.get(id)!] : []),
        ...(refinementLimits.has(id) ? [refinementLimits.get(id)!] : []),
        ...(unit.budget_truncated ? ['native dependency graph instruction budget truncated'] : []),
      ]),
    );
  }
  const reasonQueue = [...units.keys()],
    reasonQueued = new Set(reasonQueue);
  for (let cursor = 0; cursor < reasonQueue.length; cursor++) {
    context.checkpoint(1);
    const id = reasonQueue[cursor]!,
      unit = units.get(id)!,
      own = reasons.get(id)!;
    reasonQueued.delete(id);
    let changed = false;
    for (const dependency of unit.dependencies) {
      const key =
        contextKeys.get(nativeContextKey(dependency.target.id, dependency.assumptions)) ??
        dependency.target.id;
      if (arityComplete.get(id) && !arityComplete.get(key)) {
        arityComplete.set(id, false);
        changed = true;
      }
      const inherited =
        reasons.get(key) ??
        new Set(failures.get(key) ?? ['native dependency interface unavailable']);
      for (const reason of inherited) {
        context.checkpoint(1);
        const qualified = `${dependency.target.original_name ?? dependency.target.id}: ${reason}`;
        // Keep reasons as leaf identities, not recursively growing call chains.
        const leaf = reason.includes(': ') ? reason : qualified;
        if (own.has(leaf)) continue;
        own.add(leaf);
        changed = true;
      }
    }
    if (!changed) continue;
    for (const caller of parents.get(id) ?? []) {
      context.checkpoint(1);
      if (reasonQueued.has(caller)) continue;
      reasonQueued.add(caller);
      reasonQueue.push(caller);
    }
  }
  for (const [id, summary] of summaries) {
    const limits = [...reasons.get(id)!].sort();
    summaries.set(id, {
      ...summary,
      reasons: limits,
      complete: limits.length === 0 && summary.observed.parameter_state !== 'ambiguous',
      arity_complete:
        arityComplete.get(id) === true &&
        (summary.observed.source_interface ?? summary.observed).parameter_state !== 'ambiguous',
    });
  }
  for (const [id, limits] of failures)
    summaries.set(id, {
      observed: unresolved(),
      evidence_ids: pending.find((entry) => entry.key === id)?.fn.evidence_ids ?? [],
      reasons: limits,
      complete: false,
    });
  return {
    units,
    summaries,
    context_keys: contextKeys,
    remaining,
    complete: [...summaries.values()].every((summary) => summary.complete),
  };
}
