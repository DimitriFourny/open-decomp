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
    if (performance.now() >= deadline)
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
  return {
    signal,
    budget,
    checkpoint,
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
}
