import {
  OperationError,
  type Address,
  type Diagnostic,
  type FunctionRecord,
  type LikelyHeuristic,
  type OperationContext,
  type RegisterDescriptor,
} from '../../core/index.js';
import type { SSAForm } from '../../ir/index.js';
import type { InferredCallee, LikelyArity } from '../../reconstruction/source-model.js';
import { nativeCallIndex } from './calls.js';
import type { PreparedNativeUnit } from './native-prepare.js';
import type { NativeInterface, NativeSummary, NativeSummaryCapacity } from './native-worklist.js';
import type { SourceFactsInput } from './source-facts.js';

/** Minimum precision a heuristic needs on the harness (`scripts/bench/likely-precision.ts`)
 * before it may change the printed text in `likely` inference mode. */
export const LIKELY_PRECISION_GATE = 0.95;

/** Which heuristics currently pass the gate. This table is data from a measurement run:
 * each entry must cite its harness result in docs/PERFORMANCE.md and is changed only with
 * a new run. A heuristic that fails keeps firing and is recorded in provenance
 * (`applied: false`), so the harness can keep measuring it, but it never prints. */
export const LIKELY_GATE: Readonly<Record<LikelyHeuristic, boolean>> = {
  callee_reads: true,
  caller_consensus: true,
};

/** Most distinct caller functions one consensus examines. A hub with more callers
 * (`sqlite3_free`) is not guessed: consensus over a sample is a different, unmeasured
 * heuristic, and the work grows with every caller. */
export const MAX_CONSENSUS_CALLERS = 32;

const rootsOf = (registers: readonly RegisterDescriptor[]): readonly string[] =>
  registers.map((register) => register.root);
const addressKey = (address: Address): string =>
  `${address.image_id}:${address.space}:${address.value}`;

/** `callee_reads`: the callee's body, taken alone, reads exactly its observed argument
 * registers once unobserved arguments forwarded into an indirect call are not counted
 * as read, and this site prepares nothing beyond them. Needs a complete body. */
export function calleeReadsGuess(
  summary: NativeSummary | undefined,
  prepared: InferredCallee | undefined,
): boolean {
  const observed = summary?.observed;
  if (
    !observed ||
    !summary.arity_complete ||
    observed.likely_closure !== true ||
    observed.argument_list_closure !== undefined ||
    observed.parameter_state === 'ambiguous' ||
    observed.variadic_stack ||
    observed.stack_parameters?.length
  )
    return false;
  const reads = new Set(rootsOf(observed.parameters));
  return rootsOf(prepared?.parameters ?? []).every((root) => reads.has(root));
}

interface Site {
  /** Register roots the caller prepared, in ABI order. */
  readonly prefix: string;
}

/** Marks a work-limit stop of this module's own bounded share. */
class ConsensusLimit extends Error {}

export interface LikelyArityEnv {
  readonly input: SourceFactsInput;
  /** The selected body, as the worklist's preloaded unit. */
  readonly selected: PreparedNativeUnit | undefined;
  readonly load: (fn: FunctionRecord, context: OperationContext) => PreparedNativeUnit;
  /** Optional-work pool of this request's native summaries (already narrowed). */
  readonly context: OperationContext;
  readonly capacity: NativeSummaryCapacity;
  /** Interfaces already known per call id (summaries merged with the call's own prefix). */
  readonly callees: ReadonlyMap<string, InferredCallee>;
  /** Native interface of each call's callee, when it has a body summary. */
  readonly summaries: ReadonlyMap<string, NativeInterface>;
}

/** Caller-consensus arity: every discovered call site of the target prepares the same
 * argument-register prefix, and the callee (when its body is known) reads nothing outside
 * it. Sound for the source interface only if the discovered sites are all the sites; the
 * mode says so by being opt-in and by marking every closure. */
function consensusPrefix(
  env: LikelyArityEnv,
  target: Address,
  calleeReads: ReadonlySet<string> | undefined,
  ir: SSAForm,
  context: OperationContext,
): { readonly sites: number; readonly prefix: string } | undefined {
  const { input } = env;
  const index = nativeCallIndex(input.image, input.functions, input.references, context);
  const key = addressKey(target);
  const references = index.callers_by_target.get(key);
  if (!references?.length) return undefined;
  const byCaller = new Map<string, number>();
  for (const reference of references) {
    context.checkpoint(1);
    // A tail transfer jumps with the caller's registers as they stand: it abstains rather
    // than votes. A site no function owns prepares an argument list this scan cannot read.
    if (reference.kind === 'tail_call') continue;
    if (reference.from_function === null) return undefined;
    byCaller.set(reference.from_function, (byCaller.get(reference.from_function) ?? 0) + 1);
    if (byCaller.size > MAX_CONSENSUS_CALLERS) return undefined;
  }
  const sites: Site[] = [];
  for (const [callerId, count] of byCaller) {
    context.checkpoint(1);
    let unit: PreparedNativeUnit | undefined;
    if (callerId === ir.id) unit = env.selected;
    else {
      const caller = index.functions_by_id.get(callerId);
      if (!caller) return undefined;
      try {
        unit = env.load(caller, context);
      } catch (error) {
        const details = error instanceof OperationError ? error.diagnostic.details : undefined;
        // A caller too large for the remaining capacity leaves its sites unknown.
        if (
          error instanceof OperationError &&
          error.code === 'resource_limit' &&
          details?.kind === 'limit' &&
          details.resource !== 'work'
        )
          return undefined;
        throw error;
      }
    }
    if (!unit) return undefined;
    if (!unit.ir || unit.budget_truncated || unit.analysis?.state !== 'complete') return undefined;
    const found: string[] = [];
    for (const block of unit.ir.blocks)
      for (const node of block.instructions)
        if (
          node.kind === 'call' &&
          node.target.kind === 'direct' &&
          addressKey(node.target.address) === key
        )
          found.push(node.id);
    if (found.length !== count) return undefined;
    for (const id of found) {
      const observed = unit.observed_calls.find((call) => call.call_id === id);
      if (!observed) return undefined;
      sites.push({ prefix: rootsOf(observed.parameters).join(',') });
    }
  }
  const first = sites[0];
  if (!first || sites.some((site) => site.prefix !== first.prefix)) return undefined;
  const roots = new Set(first.prefix === '' ? [] : first.prefix.split(','));
  if (calleeReads) {
    for (const root of calleeReads) if (!roots.has(root)) return undefined;
  } else if (roots.size === 0) return undefined;
  return { sites: sites.length, prefix: first.prefix };
}

/** Guessed argument-list closures for the open direct calls of the selected body. Runs
 * only in `likely` mode. `calleeReads` lists the calls where `callee_reads` fired; the
 * consensus runs here. A call that a proven rule closes is never consulted: the planner
 * reads a guess only for an open argument list. */
export function likelyArities(
  env: LikelyArityEnv,
  calleeReads: ReadonlySet<string>,
): { readonly guesses: Map<string, LikelyArity>; readonly diagnostics: Diagnostic[] } {
  const { input } = env;
  const guesses = new Map<string, LikelyArity>();
  const diagnostics: Diagnostic[] = [];
  const add = (id: string, heuristic: LikelyHeuristic, sites?: number): void => {
    const prior = guesses.get(id);
    const list = [...new Set([...(prior?.heuristics ?? []), heuristic])].sort();
    guesses.set(id, {
      heuristics: list,
      applied: list.some((name) => LIKELY_GATE[name]),
      ...(sites === undefined && prior?.sites === undefined
        ? {}
        : { sites: Math.max(sites ?? 0, prior?.sites ?? 0) }),
    });
  };
  for (const id of calleeReads) add(id, 'callee_reads');
  const calls = new Map(input.types.calls?.calls.map((call) => [call.node_id, call]) ?? []);
  const memo = new Map<string, { sites: number; prefix: string } | null>();
  let limited = false;
  const share = Math.max(1, Math.floor((env.context.remainingWork?.() ?? 0) / 2));
  let used = 0;
  const bounded: OperationContext = {
    ...env.context,
    budget: {
      ...env.context.budget,
      instructions: env.capacity.instructions,
      blocks: env.capacity.blocks,
      ir_nodes: env.capacity.nodes,
    },
    remainingWork: () => Math.max(0, Math.min(share - used, env.context.remainingWork?.() ?? 0)),
    checkpoint(work) {
      if (used + work > share) throw new ConsensusLimit();
      env.context.checkpoint(work);
      used += work;
    },
  };
  try {
    for (const block of input.ir.blocks)
      for (const node of block.instructions) {
        if (node.kind !== 'call' || node.target.kind !== 'direct') continue;
        if (
          calls
            .get(node.id)
            ?.contracts.some(
              (contract) =>
                contract.status === 'established' && contract.layout.state === 'complete',
            )
        )
          continue;
        const callee = env.callees.get(node.id);
        if (!callee || callee.argument_list_closure) continue;
        const summary = env.summaries.get(node.id);
        if (summary?.variadic_stack || summary?.stack_parameters?.length) continue;
        const target = node.target.address;
        const key = addressKey(target);
        let result = memo.get(key);
        if (result === undefined) {
          result =
            consensusPrefix(
              env,
              target,
              summary ? new Set(rootsOf(summary.parameters)) : undefined,
              input.ir,
              bounded,
            ) ?? null;
          memo.set(key, result);
        }
        if (result) add(node.id, 'caller_consensus', result.sites);
      }
  } catch (error) {
    if (!(error instanceof ConsensusLimit)) throw error;
    limited = true;
  }
  if (limited)
    diagnostics.push({
      code: 'resource_limit',
      severity: 'warning',
      message:
        'Likely-mode caller scan stopped at its work share; arities it did not reach stay open',
      evidence_ids: [],
      details: { kind: 'limit', resource: 'work', limit: share, consumed: used },
    });
  return { guesses, diagnostics };
}
