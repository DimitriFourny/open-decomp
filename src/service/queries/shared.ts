import { DEFAULT_ANALYSIS_OPTIONS, OperationError, SCHEMA_VERSION } from '../../core/index.js';
import type { Budget, Diagnostic, ResultMetadata } from '../../core/index.js';

export function queryFailure(code: Diagnostic['code'], message: string): never {
  throw new OperationError({ code, severity: 'error', message, evidence_ids: [] });
}
/** Shared wire metadata has no dependency on child decoders, loaders or storage. */
export function queryEnvelope(project_id: string, revision: number, budget: Budget): ResultMetadata {
  return { schema_version: SCHEMA_VERSION, project_id, revision, versions: { backend: 'open-decomp/1', loader: null, decoder: null, lifter: null, analysis: 'navigation/1', abi: null, emitter: null }, options: DEFAULT_ANALYSIS_OPTIONS, budget, coverage: [], diagnostics: [], evidence: [], artifacts: [] };
}
