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

const buildCosts = new WeakMap<object, number>();
const paidBuilds = new WeakMap<OperationContext, WeakSet<object>>();

/** The work building `value` cost, charged on `context`'s whole operation the first
 * time the operation uses it. */
function payBuild(context: OperationContext, value: object): void {
  const operation = context.root ?? context;
  let paid = paidBuilds.get(operation);
  if (!paid) paidBuilds.set(operation, (paid = new WeakSet()));
  if (paid.has(value)) {
    context.checkpoint(0);
    return;
  }
  paid.add(value);
  operation.checkpoint(buildCosts.get(value) ?? 0);
}

/** Build a per-process, image-scoped structure (an index kept for every later request).
 * The build itself charges nothing; its measured cost is recorded on the result, and
 * every operation that uses the result pays exactly that cost once, through `useBuilt`
 * (this call pays it for the building operation). An operation's work, and every
 * budget-dependent decision it makes, is therefore the same whether it built the
 * structure or found it built, and the shared work limit still bounds it. Cancellation
 * and deadlines are checked throughout the build. */
export function buildOnce<T extends object>(
  context: OperationContext,
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
  buildCosts.set(value, cost);
  payBuild(context, value);
  return value;
}

/** Charge the recorded build cost of an existing `buildOnce` result, once per operation. */
export function useBuilt<T extends object>(context: OperationContext, value: T): T {
  payBuild(context, value);
  return value;
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
