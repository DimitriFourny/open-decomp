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
  /** Call/tail ids (in this body) that an unobserved entry argument may reach.
   * A closed argument list relies on exactly these callees' closures, so arity
   * completeness is inherited from them only. Worklist bookkeeping, never a
   * source fact. */
  readonly argument_reaching_calls?: readonly string[];
  /** `likely` inference only: the argument list would close if unobserved entry
   * arguments forwarded into an indirect call were not read by its unknown target
   * (and every direct callee they reach is closed or likewise closes). Never a proof:
   * proven mode ignores it and no closure is derived from it. */
  readonly likely_closure?: true;
};
export interface NativeDependency {
  readonly call_id: string;
  readonly target: FunctionRecord;
  readonly return_demand?: readonly RegisterDescriptor[];
  /** The part of `return_demand` not reached only through the caller's own
   * return-exit snapshot (see `CallResultDemands.semantic`). */
  readonly return_demand_semantic?: readonly RegisterDescriptor[];
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

/** A reason produced by a bounded resource (work shares and reserves,
 * capacities, function/context/refinement limits, truncated budgets) rather
 * than by unsupported semantics: more budget may resolve it. Matches the limit
 * vocabulary of this worklist and the native unit preparation. */
export const budgetReason = (reason: string): boolean =>
  /\b(?:limit|capacity|reserve|budget)\b/.test(reason);

/** Strongly connected dependency components among loaded units, callees first
 * (Tarjan emits a component only after every component it reaches). A component
 * is recursive when it has more than one member or a self edge. */
function dependencyComponents<U extends NativeSummaryUnit>(
  units: ReadonlyMap<string, U>,
  key: (dependency: NativeDependency) => string,
  context: OperationContext,
): { readonly members: readonly string[]; readonly recursive: boolean }[] {
  const index = new Map<string, number>(),
    low = new Map<string, number>(),
    onStack = new Set<string>(),
    stack: string[] = [],
    groups: { members: string[]; recursive: boolean }[] = [];
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
      groups.push({
        members: group,
        recursive: group.length > 1 || edges(frame.id).includes(frame.id),
      });
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
  /** Calls of a loaded body that an unobserved entry argument may reach when no
   * callee is known to read anything: a callee-independent superset of every
   * later `argument_reaching_calls`. Only these callees can widen the body's
   * argument list, so they are loaded before calls that matter only for
   * effects or results. Absent, every call is assumed to be relied on. */
  readonly argument_reaching?: (unit: U, context: OperationContext) => ReadonlySet<string>;
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
  interface Scheduled {
    readonly fn: FunctionRecord;
    readonly key: string;
    readonly assumptions?: NativeContext;
  }
  const scheduled = new Map<string, Scheduled>();
  // Demand-driven loading. A requested call's arity relies only on its target's
  // own reads and, transitively, on the callees an unobserved argument may reach;
  // a body whose own graph cannot close relies on none. That sub-closure loads
  // first, breadth-first; every other dependency (wanted only for effects,
  // results and shapes) loads afterwards from what the reserve still allows.
  const demanded: Scheduled[] = [],
    deferred: Scheduled[] = [];
  const arityDemanded = new Set<string>(),
    processed = new Set<string>();
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
    const entry = { fn, key, ...(assumptions ? { assumptions } : {}) };
    scheduled.set(key, entry);
    deferred.push(entry);
    return key;
  };
  // Fair shares: one expensive dependency cannot starve refinement of the
  // others. A step (a load or its demand probe) receives at most a quarter of
  // the remaining work; an exhausted share is that dependency's own limit.
  const shareContext = (
    budget: OperationContext['budget'],
  ): { readonly bounded: OperationContext; readonly share?: number; close(): void } => {
    const available = context.remainingWork?.();
    if (available === undefined) return { bounded: { ...context, budget }, close() {} };
    const share = Math.max(1, Math.floor(available / 4));
    let used = 0,
      active = true;
    return {
      share,
      close() {
        active = false;
      },
      bounded: {
        ...context,
        budget,
        // Loaders may retain this context (lazy indexes); the share bounds
        // only the step itself.
        remainingWork: () =>
          active
            ? Math.max(0, Math.min(share - used, context.remainingWork!()))
            : context.remainingWork!(),
        checkpoint(work: number) {
          if (active && used + work > share)
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
      },
    };
  };
  /** Dependencies whose arity this body's own arity may inherit (the same rule
   * as the completeness propagation below, with the probe's superset). */
  const relied = (key: string, unit: U): readonly NativeDependency[] => {
    if (
      !(unit.arity_complete ?? unit.reasons.length === 0) ||
      unit.budget_truncated ||
      fallbackReasons.has(key)
    )
      return [];
    if (!options.argument_reaching) return unit.dependencies;
    const step = shareContext(context.budget);
    let calls: ReadonlySet<string>;
    try {
      calls = options.argument_reaching(unit, step.bounded);
    } catch (error) {
      const details = error instanceof OperationError ? error.diagnostic.details : undefined;
      if (
        !(error instanceof OperationError) ||
        error.code !== 'resource_limit' ||
        details?.kind !== 'limit' ||
        details.resource !== 'work' ||
        details.limit !== step.share
      )
        throw error;
      context.checkpoint(0);
      // An unfinished probe narrows nothing: every call stays relied on.
      return unit.dependencies;
    } finally {
      step.close();
    }
    return unit.dependencies.filter((dependency) => calls.has(dependency.call_id));
  };
  const demandArity = (start: string): void => {
    const stack = [start];
    while (stack.length) {
      context.checkpoint(1);
      const key = stack.pop()!;
      if (arityDemanded.has(key)) continue;
      arityDemanded.add(key);
      const unit = units.get(key);
      if (!unit) {
        if (!processed.has(key)) demanded.push(scheduled.get(key)!);
        continue;
      }
      for (const dependency of relied(key, unit))
        stack.push(
          contextKeys.get(nativeContextKey(dependency.target.id, dependency.assumptions))!,
        );
    }
  };
  for (const root of options.roots) demandArity(schedule(root));
  for (const dependency of options.root_dependencies ?? []) {
    const key = schedule(dependency.target, dependency.assumptions);
    demand(key, dependency.return_demand ?? []);
    demandArity(key);
  }
  const initialWork = context.remainingWork?.();
  let demandedCursor = 0,
    deferredCursor = 0;
  for (;;) {
    const next =
      demandedCursor < demanded.length
        ? demanded[demandedCursor++]
        : deferredCursor < deferred.length
          ? deferred[deferredCursor++]
          : undefined;
    if (!next) break;
    const { fn, key, assumptions } = next;
    if (processed.has(key)) continue;
    processed.add(key);
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
    // No new body is loaded once half of the initial allowance is gone, so
    // finished interfaces keep a reserve for the fixed point instead of all
    // being lost at the shared limit.
    const available = context.remainingWork?.();
    if (!prepared && available !== undefined && initialWork !== undefined) {
      if (available < initialWork / 2) {
        failures.set(key, [`native dependency load work reserve (${initialWork})`]);
        continue;
      }
    }
    const { bounded, share, close } = shareContext({
      ...context.budget,
      instructions: remaining.instructions,
      blocks: remaining.blocks,
      ir_nodes: remaining.nodes,
    });
    let unit: U;
    try {
      unit = prepared ?? options.load(fn, bounded);
      close();
    } catch (error) {
      close();
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
    if (arityDemanded.has(key))
      for (const dependency of relied(key, unit))
        demandArity(
          contextKeys.get(nativeContextKey(dependency.target.id, dependency.assumptions))!,
        );
  }

  const dependencyKey = (dependency: NativeDependency): string =>
    contextKeys.get(nativeContextKey(dependency.target.id, dependency.assumptions)) ??
    dependency.target.id;
  // Memory shapes are not transferred along recursive edges: shape evidence
  // is content-addressed over its provenance, so a shape derived from a group
  // member's shape derived from this body's is a fresh record every round and
  // the group would never reach a fixed point. Group members still exchange
  // registers, returns and types; shapes cross only into later components.
  const dependenciesOf = (
    unit: U,
    group: ReadonlySet<string>,
    assumed?: ReadonlyMap<string, NativeInterface>,
  ): Map<string, NativeInterface> => {
    const dependencies = new Map<string, NativeInterface>();
    for (const dependency of unit.dependencies) {
      context.checkpoint(1);
      const key = dependencyKey(dependency);
      const known = assumed?.get(key) ?? summaries.get(key)?.observed ?? unresolved();
      if (group.has(key) && known.parameter_shapes) {
        const { parameter_shapes: _cyclic, ...acyclic } = known;
        dependencies.set(dependency.call_id, acyclic);
      } else dependencies.set(dependency.call_id, known);
    }
    return dependencies;
  };
  // Refinement runs in three quarters of what loading left, so limit and
  // reason propagation below always finish. Components are refined callees
  // first: a non-recursive body is observed once, against final callee
  // interfaces, and only recursive groups iterate. When the share runs out,
  // every component not yet finished (the current one and its transitive
  // callers, which all come later) is cut with an explicit refinement limit;
  // finished components are at their fixed point and keep their facts.
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
  const unsettled = new Set(units.keys());
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
  const closeRecursive = (group: readonly string[]): void => {
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
      return;
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
        options.observe(unit, dependenciesOf(unit, new Set(group), assumed), refineContext, [
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
      return;
    for (const [id, observed] of results) summaries.set(id, { ...summaries.get(id)!, observed });
    options.on_partial?.(units, summaries);
  };
  const summarize = (id: string, observed: NativeInterface): void => {
    const unit = units.get(id)!;
    summaries.set(id, {
      observed,
      evidence_ids: unit.evidence_ids,
      reasons: unit.reasons,
      complete: false,
    });
    options.on_partial?.(units, summaries);
  };
  try {
    for (const component of dependencyComponents(units, dependencyKey, refineContext)) {
      // Only a recursive group needs seeds (its members read each other before
      // any is observed); a non-recursive body is observed once, directly
      // against its finished callees. Seeds are local return witnesses.
      if (component.recursive)
        for (const id of component.members)
          summarize(
            id,
            options.initialize(units.get(id)!, refineContext, [
              ...(demands.get(id)?.values() ?? []),
            ]),
          );
      // A changed member schedules only its direct callers inside the group;
      // callers outside it are later components and observe the final result.
      const members = new Set(component.members),
        queue = [...component.members],
        queued = new Set(queue);
      for (let cursor = 0; cursor < queue.length; cursor++) {
        refineContext.checkpoint(1);
        const id = queue[cursor]!;
        queued.delete(id);
        const unit = units.get(id)!;
        const visits = (refinements.get(id) ?? 0) + 1;
        if (visits > options.max_refinements) {
          refinementLimits.set(
            id,
            `native interface refinement limit (${options.max_refinements})`,
          );
          continue;
        }
        refinements.set(id, visits);
        const observed = options.observe(unit, dependenciesOf(unit, members), refineContext, [
            ...(demands.get(id)?.values() ?? []),
          ]),
          previous = summaries.get(id);
        if (previous && options.equal(previous.observed, observed)) continue;
        summarize(id, observed);
        for (const caller of parents.get(id) ?? []) {
          refineContext.checkpoint(1);
          if (!members.has(caller) || queued.has(caller)) continue;
          queued.add(caller);
          queue.push(caller);
        }
      }
      if (component.recursive) closeRecursive(component.members);
      for (const id of component.members) unsettled.delete(id);
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
    for (const id of unsettled)
      refinementLimits.set(id, `native interface refinement work limit (${refineLimit})`);
  }
  // An unfinished body keeps whatever it already established (a seed or an
  // earlier round); one never observed is unresolved, not zero-argument.
  for (const id of units.keys()) if (!summaries.has(id)) summarize(id, unresolved());

  // Limit/reason propagation is itself a bounded fixed point. SCCs with no open
  // dependencies are closed; recursion alone is not an unavailable-semantics gap.
  // Arity completeness is inherited only through calls the closure relies on
  // (an unobserved entry argument may reach them): a callee that sees only
  // observed parameters or computed values cannot widen this argument list.
  const reasons = new Map<string, Set<string>>();
  const arityComplete = new Map<string, boolean>();
  const reaching = new Map<string, ReadonlySet<string>>();
  for (const [id, summary] of summaries)
    reaching.set(
      id,
      new Set([
        ...(summary.observed.argument_reaching_calls ?? []),
        ...(summary.observed.source_interface?.argument_reaching_calls ?? []),
      ]),
    );
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
      if (
        arityComplete.get(id) &&
        !arityComplete.get(key) &&
        reaching.get(id)?.has(dependency.call_id)
      ) {
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
      evidence_ids: scheduled.get(id)?.fn.evidence_ids ?? [],
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
