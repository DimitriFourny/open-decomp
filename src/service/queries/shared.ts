import { DEFAULT_ANALYSIS_OPTIONS, OperationError, SCHEMA_VERSION } from '../../core/index.js';
import type { Budget, Diagnostic, ResultMetadata, WireJob } from '../../core/index.js';

export function queryFailure(code: Diagnostic['code'], message: string): never {
  throw new OperationError({ code, severity: 'error', message, evidence_ids: [] });
}
/** Shared wire metadata has no dependency on child decoders, loaders or storage. */
export function queryEnvelope(
  project_id: string,
  revision: number,
  budget: Budget,
): ResultMetadata {
  return {
    schema_version: SCHEMA_VERSION,
    project_id,
    revision,
    versions: {
      backend: 'open-decomp/1',
      loader: null,
      decoder: null,
      lifter: null,
      analysis: 'navigation/2',
      abi: null,
      emitter: null,
    },
    options: DEFAULT_ANALYSIS_OPTIONS,
    budget,
    coverage: [],
    diagnostics: [],
    evidence: [],
    artifacts: [],
  };
}

/** Admission proves only durable queue ownership, not that analysis components ran. */
export function queryAdmission(
  job: WireJob,
  budget: Budget,
  options = DEFAULT_ANALYSIS_OPTIONS,
): ResultMetadata & { state: 'queued'; job: WireJob } {
  if (job.state !== 'queued')
    queryFailure(
      'worker_failed',
      `Admission acknowledgement was lost for ${job.id}; inspect its durable status`,
    );
  const metadata = queryEnvelope(job.project_id, job.input_revision, budget);
  return {
    ...metadata,
    versions: { ...metadata.versions, analysis: null },
    options,
    state: 'queued',
    job,
  };
}
