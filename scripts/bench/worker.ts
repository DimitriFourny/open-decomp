import { appendFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { encodeDiagnostic, type Job, type OperationContext, type ProjectStore, type ToolArgs, type ToolName, type ToolResult } from '../../src/core/index.js';
import { queryWorkerHandler } from '../../src/service/queries/handler.js';
import { runProjectWorker, workerDiagnostic, type WorkerHandler } from '../../src/workers/runtime.js';
import { METRICS_ENV, PIPELINE_SCHEMA, sampleMemory, type PublicationSample, type WorkerEvidence, type WorkerMark, type WorkerMeasurement } from './pipeline-metrics.js';

// This fixed trusted entry delegates every operation to the production handler.
// Its host-selected output directory is never derived from a target or IPC input.
const directory = process.env[METRICS_ENV];
if (!directory || !isAbsolute(directory)) throw new Error('Benchmark worker requires an absolute metrics directory');
const destination = join(directory, `${process.pid}.jsonl`);
let active: {
  job: Job; start: number; marks: WorkerMark[];
  outcome: WorkerMeasurement['handler_outcome']; error: WorkerMeasurement['error'];
  before: PublicationSample | null; after: PublicationSample | null;
} | undefined;

function persist(evidence: WorkerEvidence): void {
  appendFileSync(destination, `${JSON.stringify(evidence)}\n`, { encoding: 'utf8', mode: 0o600 });
}
function mark(phase: string): void {
  if (!active) throw new Error('Worker observation outside an active job');
  active.marks.push({ phase, elapsed_ms: performance.now() - active.start, memory: sampleMemory() });
}
function flush(boundary: WorkerMeasurement['flush_boundary']): void {
  if (!active) return;
  persist({ kind: 'worker_job', schema: PIPELINE_SCHEMA, pid: process.pid, job_id: active.job.id,
    operation: active.job.operation, marks: active.marks, handler_outcome: active.outcome,
    error: active.error, before: active.before, after: active.after, flush_boundary: boundary });
  active = undefined;
}
function instrument(context: OperationContext): OperationContext {
  return { ...context, progress(phase, completed, total) {
    mark(phase);
    context.progress(phase, completed, total);
  } };
}
function publication(store: ProjectStore, jobId: string, functionId: string | undefined, revision: number): PublicationSample {
  const job = store.readJob(jobId);
  const artifacts = functionId ? store.findAnalysisArtifacts({ revision, ids: [functionId], limit: 1000 }) : null;
  return { revision: store.snapshot().revision, job_state: job?.state ?? null,
    job_artifact_ids: job?.artifacts.map(artifact => artifact.id) ?? [],
    function_artifact_ids: artifacts?.items.map(artifact => artifact.id).sort() ?? [],
    more_function_artifacts: artifacts?.next_cursor != null };
}

const handler: WorkerHandler = {
  async prepareImport(image, scope) {
    mark('prepare_import');
    try {
      // The production registration always supplies this method; fail rather than
      // silently skipping indexing if that contract changes.
      if (!queryWorkerHandler.prepareImport) throw new Error('Query import preparation is not registered');
      const prepared = await queryWorkerHandler.prepareImport(image, { ...scope, context: instrument(scope.context) });
      mark('prepare_import_return');
      return prepared;
    } catch (error) {
      if (active) { active.outcome = 'threw'; active.error = encodeDiagnostic(workerDiagnostic(error)); }
      mark('prepare_import_throw');
      throw error;
    }
  },
  async execute<K extends ToolName>(operation: K, args: ToolArgs<K>, scope: { readonly store: ProjectStore; readonly context: OperationContext; readonly job_id: string; readonly max_result_bytes?: number }): Promise<ToolResult<K>> {
    const functionId = operation === 'function_decompile' && 'function_id' in args ? args.function_id : undefined;
    const revision = 'revision' in args ? args.revision : scope.store.snapshot().revision;
    if (!active) throw new Error('Handler started without runtime observation');
    active.before = publication(scope.store, scope.job_id, functionId, revision);
    mark('handler_enter');
    try {
      const result = await queryWorkerHandler.execute(operation, args, { ...scope, context: instrument(scope.context) });
      active.outcome = 'returned';
      return result;
    } catch (error) {
      active.outcome = 'threw'; active.error = encodeDiagnostic(workerDiagnostic(error));
      throw error;
    } finally {
      mark('handler_end');
      active.after = publication(scope.store, scope.job_id, functionId, revision);
      flush('handler_return');
    }
  },
};

persist({ kind: 'worker_start', schema: PIPELINE_SCHEMA, pid: process.pid, memory: sampleMemory() });
process.once('exit', () => {
  flush('process_exit');
  persist({ kind: 'worker_exit', schema: PIPELINE_SCHEMA, pid: process.pid, memory: sampleMemory() });
});
runProjectWorker(handler, { phase(phase, job) {
  if (phase === 'running') {
    flush('next_job');
    active = { job, start: performance.now(), marks: [], outcome: null, error: null, before: null, after: null };
  }
  mark(phase);
  if (phase === 'published') flush('import_published');
} });
