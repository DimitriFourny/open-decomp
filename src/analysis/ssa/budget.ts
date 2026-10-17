import { OperationError } from '../../core/index.js';
import type { Diagnostic } from '../../core/index.js';
import type { IRConstructionLimits } from '../../ir/budget.js';

export interface AnalysisOptions extends IRConstructionLimits {
  readonly max_work?: number;
}
export interface AnalysisResult<T> {
  readonly state: 'complete' | 'partial';
  readonly value: T;
  readonly diagnostics: readonly Diagnostic[];
  readonly work: number;
}
/** Transactional pass boundaries return the last complete IR, never a half-rewritten graph. */
export class AnalysisBudget {
  work = 0;
  readonly limit: number;
  constructor(readonly options: AnalysisOptions = {}) {
    this.limit = options.max_work ?? 1_000_000;
    if (!Number.isSafeInteger(this.limit) || this.limit < 0)
      throw new RangeError('Analysis work limit must be a nonnegative safe integer');
  }

  charge(work = 1): void {
    this.work += work;
    if (this.work > this.limit)
      throw new OperationError({
        code: 'resource_limit',
        severity: 'warning',
        message: 'SSA/value analysis work limit reached',
        evidence_ids: [],
        details: { kind: 'limit', resource: 'work', limit: this.limit, consumed: this.work },
      });
    this.options.checkpoint?.(work);
  }

  result<T>(value: T, error?: unknown): AnalysisResult<T> {
    if (
      error !== undefined &&
      (!(error instanceof OperationError) ||
        (error.code !== 'resource_limit' && error.code !== 'cancelled'))
    )
      throw error;
    return {
      state: error === undefined ? 'complete' : 'partial',
      value,
      diagnostics: error instanceof OperationError ? [error.diagnostic] : [],
      work: this.work,
    };
  }
}
