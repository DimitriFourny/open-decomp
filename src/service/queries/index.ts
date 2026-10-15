import { OperationError, artifactReadArgsSchema, decodeDiagnostic, encodeDiagnostic, toolSchemas } from '../../core/index.js';
import type { ToolArgs, ToolInput, ToolName, ToolResult, WireJob } from '../../core/index.js';
import { ProjectWorkerPool } from '../../workers/index.js';
import type { ArtifactReadInput, ArtifactReadResult, JobOutcome, JobTicket, ProjectWorker, WorkerOperation, WorkerPoolOptions, ExecuteRequest } from '../../workers/index.js';
import { queryEnvelope, queryFailure } from './shared.js';

export interface QueryCallOptions { readonly signal?: AbortSignal; readonly onProgress?: (job: WireJob) => void }
/** The lifecycle/navigation subset of the eventual AnalysisService. All image parsing,
 * decoding, indexing and store access happens in its project's persistent child.
 * Mutations and decompilation must be supplied by later real static handlers, not mocks.
 * Paths are host-authorized before admission; target-selected names are never paths.
 * Compiled clients import dist/src/service/queries/index.js; the default worker resolves
 * its sibling compiled entry.js automatically (no tsx/runtime source dependency). */
export class QueryService {
  readonly #pool: ProjectWorkerPool;
  readonly #projects = new Map<string, ProjectWorker>();
  private constructor(pool: ProjectWorkerPool) { this.#pool = pool; }
  static async create(options: WorkerPoolOptions): Promise<QueryService> { return new QueryService(await ProjectWorkerPool.create(options)); }
  #project(id: string): ProjectWorker {
    const project = this.#projects.get(id);
    if (!project) queryFailure('not_found', 'Project is not open in this client');
    return project;
  }
  /** Exposes the existing durable ticket for clients needing admission/progress/cancel.
   * execute is the convenient wait-for-terminal form of this same worker lifecycle. */
  async submit<K extends WorkerOperation>(operation: K, input: ToolInput<K>, options: QueryCallOptions = {}): Promise<JobTicket> {
    const args = toolSchemas[operation].input.parse(input) as ToolArgs<K>;
    return this.#project(args.project_id).submit({ kind: 'execute', operation, args, budget: args.budget } as ExecuteRequest, options);
  }
  async execute<K extends ToolName>(operation: K, input: ToolInput<K>, options: QueryCallOptions = {}): Promise<ToolResult<K>> {
    const args = toolSchemas[operation].input.parse(input);
    try {
      let result: unknown;
      if (operation === 'project_open') {
        const open = toolSchemas.project_open.input.parse(args);
        const project = await this.#pool.open({ path: open.source.project_path, mode: open.source.kind === 'import' ? 'create' : 'resume' });
        try {
          if (open.source.kind === 'import') {
            const ticket = await project.submit({ kind: 'import', source_path: open.source.input_path, slice_id: open.source.slice_id ?? null, budget: open.budget }, options);
            const outcome = await ticket.result; requireCompleted(outcome);
          }
          this.#projects.set(project.snapshot.project_id, project);
          const image = project.snapshot.images[0];
          if (!image || image.state !== 'loaded') queryFailure('not_found', 'Project has no ready loaded image');
          const info = await this.execute('binary_info', { project_id: project.snapshot.project_id, revision: project.snapshot.revision, image_id: image.image_id, view: 'summary', budget: open.budget }, options);
          if (!('data' in info) || info.data.view !== 'summary') {
            if (info.state === 'failed' || info.state === 'unsupported') throw new OperationError(decodeDiagnostic(info.error));
            queryFailure('resource_limit', 'Project summary did not complete');
          }
          result = { ...queryEnvelope(project.snapshot.project_id, project.snapshot.revision, open.budget), state: 'complete', data: { image: info.data.image, resumed: open.source.kind === 'resume' } };
        } catch (error) { this.#projects.delete(project.snapshot.project_id); await project.close('cancel'); throw error; }
      } else if (operation === 'project_close') {
        const close = toolSchemas.project_close.input.parse(args), project = this.#project(close.project_id);
        if (close.running_jobs === 'reject' && project.busy) queryFailure('invalid_input', 'Project has active jobs');
        const snapshot = close.running_jobs === 'cancel' && project.busy ? project.snapshot : await project.refresh();
        if (snapshot.revision !== close.revision) queryFailure('stale_revision', 'Close revision does not match the durable snapshot');
        await project.close(close.running_jobs); this.#projects.delete(close.project_id);
        result = { ...queryEnvelope(close.project_id, close.revision, close.budget), state: 'complete', data: { closed: true, persisted_revision: snapshot.revision } };
      } else if (operation === 'analysis_status' || operation === 'analysis_cancel') {
        const status = toolSchemas.analysis_status.input.parse(args), project = this.#project(status.project_id);
        if (status.revision > project.snapshot.revision && status.revision > (await project.refresh()).revision) queryFailure('stale_revision', 'Job control revision is in the future');
        const job = operation === 'analysis_status' ? await project.inspectJob(status.job_id) : await project.cancelJob(status.job_id);
        const outcome = job.state === 'cancelled' ? 'cancelled' : ['queued', 'running'].includes(job.state) ? 'cancellation_requested' : 'already_finished';
        result = { ...queryEnvelope(status.project_id, status.revision, status.budget), state: 'complete', data: { job, ...(operation === 'analysis_cancel' ? { outcome } : {}) } };
      } else {
        const ticket = await this.submit(operation as WorkerOperation, args as ToolInput<WorkerOperation>, options);
        const outcome = await ticket.result;
        requireCompleted(outcome);
        if (outcome.result === undefined) queryFailure('not_found', 'Completed job has no transient query result; submit the read-only query again');
        result = outcome.result;
      }
      const parsed = toolSchemas[operation].output.parse(result) as ToolResult<K>;
      if (Buffer.byteLength(JSON.stringify(parsed)) > args.budget.output_bytes) queryFailure('resource_limit', 'Tool result exceeds the output budget');
      return parsed;
    } catch (error) {
      const diagnostic = error instanceof OperationError ? error.diagnostic : { code: 'internal_error' as const, severity: 'error' as const, message: (error instanceof Error ? error.message : String(error)).slice(0, 8192), evidence_ids: [] };
      const project_id = 'project_id' in args ? args.project_id : null;
      const revision = 'revision' in args ? args.revision : 'expected_revision' in args ? args.expected_revision : null;
      const metadata = { ...queryEnvelope(project_id ?? '', revision ?? 0, args.budget), project_id, revision };
      return toolSchemas[operation].output.parse({ ...metadata, state: 'failed', error: encodeDiagnostic(diagnostic), current_revision: project_id && this.#projects.has(project_id) ? this.#project(project_id).snapshot.revision : null }) as ToolResult<K>;
    }
  }
  async readArtifact(input: ArtifactReadInput): Promise<ArtifactReadResult> {
    const args = artifactReadArgsSchema.parse(input);
    return this.#project(args.project_id).readArtifact(args);
  }
  async close(policy: 'wait' | 'cancel' | 'reject' = 'wait'): Promise<void> { await this.#pool.close(policy); this.#projects.clear(); }
}
function requireCompleted(outcome: JobOutcome): void {
  if (outcome.job.state === 'completed') return;
  const diagnostic = outcome.job.diagnostics[0];
  if (diagnostic) throw new OperationError(decodeDiagnostic(diagnostic));
  queryFailure(outcome.job.state === 'stale' ? 'stale_revision' : 'resource_limit', `Job ended ${outcome.job.state}`);
}
