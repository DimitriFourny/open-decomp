import { performance } from 'node:perf_hooks';
import { budgetSchema, type Budget, type Diagnostic } from './primitives.js';
import type { OperationContext } from './contracts.js';

export class OperationError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.name = 'OperationError';
  }

  get code(): Diagnostic['code'] {
    return this.diagnostic.code;
  }
}

/** One use of a per-process structure (`buildOnce`): its name, unique among the structures
 * one operation can use, and its recorded build cost. Serializable, so work replayed from a
 * persisted result can make the payments the original computation made. */
export interface BuildUse {
  readonly name: string;
  readonly cost: number;
}

const buildUses = new WeakMap<object, BuildUse>();
/** Per operation: the structures it has paid, their names, and the names paid by
 * `replayBuilds` that no structure has claimed yet (the next structure of that name uses
 * that payment). */
const paidBuilds = new WeakMap<
  OperationContext,
  { values: WeakSet<object>; names: Set<string>; replayed: Set<string> }
>();
/** Per operation: the open `recordBuilds` scopes. */
const recorders = new WeakMap<OperationContext, Map<string, BuildUse>[]>();

/** Charge `use` (of `value`, or replayed without one) on `context`'s whole operation unless
 * the operation has paid it already. */
function pay(context: OperationContext, use: BuildUse, value: object | undefined): void {
  const operation = context.root ?? context;
  for (const recorder of recorders.get(operation) ?? []) recorder.set(use.name, use);
  let paid = paidBuilds.get(operation);
  if (!paid)
    paidBuilds.set(
      operation,
      (paid = { values: new WeakSet(), names: new Set(), replayed: new Set() }),
    );
  const free = value
    ? paid.values.has(value) || paid.replayed.delete(use.name)
    : paid.names.has(use.name);
  if (value) paid.values.add(value);
  else if (!free) paid.replayed.add(use.name);
  paid.names.add(use.name);
  if (free) context.checkpoint(0);
  else operation.checkpoint(use.cost);
}

/** The work building `value` cost, charged on `context`'s whole operation the first
 * time the operation uses it. */
function payBuild(context: OperationContext, value: object): void {
  pay(context, buildUses.get(value)!, value);
}

/** Build a per-process, image-scoped structure (an index kept for every later request).
 * The build itself charges nothing; its measured cost is recorded on the result, and
 * every operation that uses the result pays exactly that cost once, through `useBuilt`
 * (this call pays it for the building operation). An operation's work, and every
 * budget-dependent decision it makes, is therefore the same whether it built the
 * structure or found it built, and the shared work limit still bounds it. Cancellation
 * and deadlines are checked throughout the build. `name` identifies the structure among
 * those one operation can use (see `BuildUse`). */
export function buildOnce<T extends object>(
  context: OperationContext,
  name: string,
  build: (context: OperationContext) => T,
): T {
  const value = buildDeferred(context, name, build);
  payBuild(context, value);
  return value;
}

/** `buildOnce` without the payment: the caller charges what its operation uses, the
 * whole recorded cost through `useBuilt` or a part it derives from the structure and
 * its own subject alone (so that charge too is the same whether it built the
 * structure or found it built). */
export function buildDeferred<T extends object>(
  context: OperationContext,
  name: string,
  build: (context: OperationContext) => T,
): T {
  let cost = 0;
  const value = build({
    ...context,
    checkpoint(work) {
      context.checkpoint(0);
      cost += work;
    },
  });
  buildUses.set(value, { name, cost });
  return value;
}

/** Charge the recorded build cost of an existing `buildOnce` result, once per operation. */
export function useBuilt<T extends object>(context: OperationContext, value: T): T {
  payBuild(context, value);
  return value;
}

/** Run `compute`, also returning every per-process structure its operation used meanwhile
 * (paid then or before), in first-use order. A cached result of `compute` replays them with
 * `replayBuilds`, so reusing it charges the payments computing it would have made. */
export function recordBuilds<T>(
  context: OperationContext,
  compute: () => T,
): { readonly value: T; readonly builds: readonly BuildUse[] } {
  const operation = context.root ?? context;
  let open = recorders.get(operation);
  if (!open) recorders.set(operation, (open = []));
  const recorder = new Map<string, BuildUse>();
  open.push(recorder);
  try {
    const value = compute();
    return { value, builds: [...recorder.values()] };
  } finally {
    open.splice(open.lastIndexOf(recorder), 1);
  }
}

/** What `replayBuilds(context, builds)` will charge: the uses not yet paid by the operation. */
export function unpaidBuildCost(context: OperationContext, builds: readonly BuildUse[]): number {
  const paid = paidBuilds.get(context.root ?? context);
  let cost = 0;
  for (const use of builds) if (!paid?.names.has(use.name)) cost += use.cost;
  return cost;
}

/** Make the payments of recorded uses `builds` on `context`'s operation, as using each
 * structure would (each once per operation). */
export function replayBuilds(context: OperationContext, builds: readonly BuildUse[]): void {
  for (const use of builds) pay(context, use, undefined);
}

/** One context per operation; counters and monotonic deadline are never reset by a pass. */
export function createOperationContext(
  options: {
    signal?: AbortSignal;
    budget?: Partial<Budget>;
    onProgress?: (phase: string, completed: number, total: number | null) => void;
  } = {},
): OperationContext {
  const budget = Object.freeze(budgetSchema.parse(options.budget ?? {}));
  const signal = options.signal ?? new AbortController().signal;
  const deadline = performance.now() + budget.deadline_ms;
  let consumed = 0;
  // Reading the clock dominates a charge; analyses charge millions of times per
  // request. Sample it every few charges (a deadline is detected at most a handful of
  // charges late) and latch expiry so every later charge fails as before.
  let clockCountdown = 0,
    expired = false;
  const checkpoint = (work: number): void => {
    if (!Number.isSafeInteger(work) || work < 0)
      throw new RangeError('Work charge must be a nonnegative safe integer');
    if (signal.aborted)
      throw new OperationError({
        code: 'cancelled',
        severity: 'error',
        message: 'Operation cancelled',
        evidence_ids: [],
      });
    if (!expired && --clockCountdown < 0) {
      clockCountdown = 31;
      expired = performance.now() >= deadline;
    }
    if (expired)
      throw new OperationError({
        code: 'resource_limit',
        severity: 'error',
        message: 'Operation deadline exceeded',
        evidence_ids: [],
        details: {
          kind: 'limit',
          resource: 'deadline_ms',
          limit: budget.deadline_ms,
          consumed: budget.deadline_ms,
        },
      });
    consumed += work;
    if (consumed > budget.work)
      throw new OperationError({
        code: 'resource_limit',
        severity: 'error',
        message: 'Operation work limit exceeded',
        evidence_ids: [],
        details: {
          kind: 'limit',
          resource: 'work',
          limit: budget.work,
          consumed: Math.min(consumed, Number.MAX_SAFE_INTEGER),
        },
      });
  };
  const context: { -readonly [K in keyof OperationContext]: OperationContext[K] } = {
    signal,
    budget,
    checkpoint,
    remainingWork: () => Math.max(0, budget.work - consumed),
    consumedWork: () => consumed,
    progress(phase, completed, total) {
      checkpoint(0);
      if (
        !Number.isSafeInteger(completed) ||
        completed < 0 ||
        (total !== null && (!Number.isSafeInteger(total) || total < completed))
      )
        throw new RangeError('Invalid progress counters');
      options.onProgress?.(phase, completed, total);
    },
  };
  context.root = context;
  return context;
}
