import { setTimeout as delay } from 'node:timers/promises';
import {
  OperationError,
  artifactReadArgsSchema,
  decodeDiagnostic,
  encodeDiagnostic,
  isSchemaValidated,
  toolSchemas,
} from '../../core/index.js';
import type { ToolArgs, ToolInput, ToolName, ToolResult, WireJob } from '../../core/index.js';
import { ProjectWorkerPool } from '../../workers/index.js';
import type {
  OpenJobReport,
  ArtifactReadInput,
  ArtifactReadResult,
  JobOutcome,
  JobTicket,
  ProjectWorker,
  WorkerOperation,
  WorkerPoolOptions,
  ExecuteRequest,
} from '../../workers/index.js';
import { queryAdmission, queryEnvelope, queryFailure } from './shared.js';

export interface QueryCallOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (job: WireJob) => void;
  /** Trusted transport delivery ceiling; never changes the requested budget/cache identity. */
  readonly max_result_bytes?: number;
  /** How long wait:'auto' awaits a result before returning the durable job. */
  readonly auto_wait_ms?: number;
}
export const DEFAULT_AUTO_WAIT_MS = 10_000;
/** Options of the open-time job (docs/internals/project-cache.md §4a). */
export interface OpenJobOptions {
  /** Helper processes; default half the cores, at most 8. */
  readonly jobs?: number;
  /** The job's own work budget (summed over its helpers); default 1G. */
  readonly work?: number;
}
export interface QueryServiceOptions extends WorkerPoolOptions {
  /** Run the open-time job at the end of every `project_open` that returns a loaded image
   * (MCP). Default off: the API runs it itself once discovery is complete. */
  readonly open_job?: OpenJobOptions | false;
}
/** The host facade for project navigation, analysis and annotation jobs. All image
 * parsing, decoding, semantic work and store access stays in persistent children.
 * Paths are host-authorized before admission; target-selected names are never paths.
 * Compiled clients import dist/src/service/queries/index.js; the default worker resolves
 * its sibling compiled entry.js automatically (no tsx/runtime source dependency). */
export class QueryService {
  readonly #pool: ProjectWorkerPool;
  readonly #projects = new Map<string, ProjectWorker>();
  readonly #openJob: OpenJobOptions | false;
  private constructor(pool: ProjectWorkerPool, openJob: OpenJobOptions | false) {
    this.#pool = pool;
    this.#openJob = openJob;
  }

  static async create(options: QueryServiceOptions): Promise<QueryService> {
    const { open_job: openJob = false, ...pool } = options;
    return new QueryService(await ProjectWorkerPool.create(pool), openJob);
  }

  /** Run the open-time job of an open project: prepare and persist the generic native unit
   * of every indexed function at the project's current revision. Never fails for the job's
   * own reasons (they are its reported state); `signal` cancels it. */
  async prepareUnits(
    projectId: string,
    options: OpenJobOptions = {},
    call: Pick<QueryCallOptions, 'signal'> = {},
  ): Promise<OpenJobReport> {
    return this.#project(projectId).prepareUnits(options, call);
  }

  #project(id: string): ProjectWorker {
    const project = this.#projects.get(id);
    if (!project) queryFailure('not_found', 'Project is not open in this client');
    return project;
  }

  /** Exposes the durable ticket directly. execute returns admission for long work
   * by default; wait:true requests the terminal response instead. */
  async submit<K extends WorkerOperation>(
    operation: K,
    input: ToolInput<K>,
    options: QueryCallOptions = {},
  ): Promise<JobTicket> {
    const args = toolSchemas[operation].input.parse(input) as ToolArgs<K>;
    return this.#project(args.project_id).submit(
      {
        kind: 'execute',
        operation,
        args,
        budget: args.budget,
        ...(options.max_result_bytes === undefined
          ? {}
          : { max_result_bytes: options.max_result_bytes }),
      } as ExecuteRequest,
      options,
    );
  }

  async execute<K extends ToolName>(
    operation: K,
    input: ToolInput<K>,
    options: QueryCallOptions = {},
  ): Promise<ToolResult<K>> {
    const args = toolSchemas[operation].input.parse(input);
    let releaseRequest: (() => void) | undefined;
    try {
      let result: unknown;
      const asynchronous =
        (operation === 'project_open' &&
          (args as ToolArgs<'project_open'>).source.kind === 'import' &&
          !(args as ToolArgs<'project_open'>).wait) ||
        (operation === 'function_decompile' && 'wait' in args && args.wait === false);
      const automatic =
        operation === 'function_decompile' && 'wait' in args && args.wait === 'auto';
      if ((asynchronous || automatic) && (options.signal || options.onProgress)) {
        const { signal, onProgress } = options;
        const controller = new AbortController();
        let active = true;
        const abort = (): void => controller.abort(signal?.reason);
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
        options = {
          ...options,
          signal: controller.signal,
          ...(onProgress
            ? {
                onProgress: (job: WireJob): void => {
                  if (active) onProgress(job);
                },
              }
            : {}),
        };
        // Admission transfers ownership to the project. Ending an MCP exchange
        // must not cancel its already-returned durable job handle.
        releaseRequest = () => {
          active = false;
          signal?.removeEventListener('abort', abort);
        };
      }
      if (operation === 'project_open') {
        const open = toolSchemas.project_open.input.parse(args);
        const project = await this.#pool.open({
          path: open.source.project_path,
          mode: open.source.kind === 'import' ? open.source.mode : 'resume',
        });
        const projectId = project.snapshot.project_id;
        try {
          if (this.#projects.has(projectId))
            queryFailure(
              'invalid_input',
              'Another open directory already owns this project identity',
            );
          if (
            open.source.kind === 'import' &&
            open.source.mode === 'resume' &&
            (project.snapshot.images.length > 1 ||
              project.snapshot.images.some((image) => image.state === 'loaded'))
          ) {
            queryFailure(
              'invalid_input',
              'Import repair requires an empty project or one unfinished image snapshot',
            );
          }
          this.#projects.set(projectId, project);
          if (open.source.kind === 'import') {
            const ticket = await project.submit(
              {
                kind: 'import',
                source_path: open.source.input_path,
                slice_id: open.source.slice_id ?? null,
                ...(open.source.mode === 'resume' ? { resume_only: true } : {}),
                budget: open.budget,
              },
              options,
            );
            if (!open.wait) {
              result = queryAdmission(await ticket.accepted, open.budget);
              // The worker owns terminal persistence; async clients use status/artifacts.
              void ticket.result.catch(() => {});
            } else {
              const outcome = await ticket.result;
              requireCompleted(outcome);
            }
          }
          if (result === undefined) {
            const snapshot = project.snapshot;
            if (
              open.source.kind === 'resume' &&
              (snapshot.images.length === 0 ||
                snapshot.images.some((image) => image.state !== 'loaded'))
            ) {
              result = {
                ...queryEnvelope(projectId, snapshot.revision, open.budget),
                state: 'partial',
                reason: 'incomplete_index',
                continuation: null,
                diagnostics: [
                  {
                    code: 'unavailable_semantics',
                    severity: 'info',
                    message:
                      'Project reopened with unfinished import metadata; inspect saved jobs, then close before an explicit import repair.',
                    evidence_ids: [],
                  },
                ],
                data: { image: null, resumed: true },
              };
            } else {
              const info = await this.execute(
                'binary_info',
                {
                  project_id: projectId,
                  revision: snapshot.revision,
                  view: 'summary',
                  budget: open.budget,
                },
                options,
              );
              if (!('data' in info) || info.data.view !== 'summary') {
                if (info.state === 'failed' || info.state === 'unsupported')
                  throw new OperationError(decodeDiagnostic(info.error));
                queryFailure('resource_limit', 'Project summary did not complete');
              }
              result = {
                ...info,
                data: {
                  image: info.data.image,
                  resumed: open.source.kind === 'resume' || open.source.mode === 'resume',
                },
              };
              // The open-time job belongs to the open; its outcome never fails it.
              if (this.#openJob !== false)
                await project.prepareUnits(
                  this.#openJob,
                  options.signal ? { signal: options.signal } : {},
                );
            }
          }
        } catch (error) {
          if (this.#projects.get(projectId) === project) this.#projects.delete(projectId);
          await project.close('cancel');
          throw error;
        }
      } else if (operation === 'project_close') {
        const close = toolSchemas.project_close.input.parse(args),
          project = this.#project(close.project_id);
        if (close.running_jobs === 'reject' && project.busy)
          queryFailure('invalid_input', 'Project has active jobs');
        const snapshot = project.busy ? project.snapshot : await project.refresh();
        if (snapshot.revision !== close.revision)
          queryFailure('stale_revision', 'Close revision does not match the acknowledged snapshot');
        await project.close(close.running_jobs);
        this.#projects.delete(close.project_id);
        // Cancelling or awaiting in-flight work can reveal an already committed
        // revision. Report the final durable snapshot, never the pre-close cache.
        const persistedRevision = project.snapshot.revision;
        result = {
          ...queryEnvelope(close.project_id, persistedRevision, close.budget),
          state: 'complete',
          data: { closed: true, persisted_revision: persistedRevision },
        };
      } else if (operation === 'analysis_status' || operation === 'analysis_cancel') {
        const status = toolSchemas.analysis_status.input.parse(args),
          project = this.#project(status.project_id);
        if (status.revision > project.snapshot.revision)
          queryFailure('stale_revision', 'Job control revision is in the future');
        const job =
          operation === 'analysis_status'
            ? await project.inspectJob(status.job_id)
            : await project.cancelJob(status.job_id);
        const outcome =
          job.state === 'cancelled'
            ? 'cancelled'
            : ['queued', 'running'].includes(job.state)
              ? 'cancellation_requested'
              : 'already_finished';
        result = {
          ...queryEnvelope(status.project_id, status.revision, status.budget),
          state: 'complete',
          data: {
            job,
            known_revision: project.snapshot.revision,
            ...(operation === 'analysis_cancel' ? { outcome } : {}),
          },
        };
      } else {
        const ticket = await this.submit(
          operation as WorkerOperation,
          args as ToolInput<WorkerOperation>,
          options,
        );
        let outcome: JobOutcome | undefined;
        if (automatic) {
          const timer = new AbortController();
          try {
            outcome = await Promise.race([
              ticket.result,
              delay(options.auto_wait_ms ?? DEFAULT_AUTO_WAIT_MS, undefined, {
                signal: timer.signal,
              }).catch(() => undefined),
            ]);
          } finally {
            timer.abort();
          }
        } else if (!asynchronous) outcome = await ticket.result;
        if (outcome === undefined) {
          // Admission transfers ownership to the project; a late failure stays in job status.
          result = queryAdmission(
            await ticket.accepted,
            args.budget,
            'options' in args ? args.options : undefined,
          );
          void ticket.result.catch(() => {});
        } else {
          if (outcome.result === undefined) {
            requireCompleted(outcome);
            queryFailure(
              'not_found',
              operation === 'annotations_apply' || operation === 'types_declare'
                ? 'Annotation job committed, but its response was lost; inspect the saved revision and annotation IDs instead of retrying the mutation'
                : 'Completed job has no transient query result; submit the read-only query again',
            );
          }
          result = outcome.result;
        }
      }
      // A worker result was parsed when it crossed the process boundary.
      const parsed = (
        isSchemaValidated(result) ? result : toolSchemas[operation].output.parse(result)
      ) as ToolResult<K>;
      if (
        Buffer.byteLength(JSON.stringify(parsed)) >
        Math.min(args.budget.output_bytes, options.max_result_bytes ?? Infinity)
      )
        queryFailure(
          'resource_limit',
          'Tool result exceeds the operation or transport delivery limit',
        );
      return parsed;
    } catch (error) {
      const diagnostic =
        error instanceof OperationError
          ? error.diagnostic
          : {
              code: 'internal_error' as const,
              severity: 'error' as const,
              message: (error instanceof Error ? error.message : String(error)).slice(0, 8192),
              evidence_ids: [],
            };
      const project_id = 'project_id' in args ? args.project_id : null;
      const revision =
        'revision' in args
          ? args.revision
          : 'expected_revision' in args
            ? args.expected_revision
            : null;
      const metadata = {
        ...queryEnvelope(project_id ?? '', revision ?? 0, args.budget),
        project_id,
        revision,
      };
      return toolSchemas[operation].output.parse({
        ...metadata,
        state: 'failed',
        error: encodeDiagnostic(diagnostic),
        current_revision:
          project_id && this.#projects.has(project_id)
            ? this.#project(project_id).snapshot.revision
            : null,
      }) as ToolResult<K>;
    } finally {
      releaseRequest?.();
    }
  }

  async readArtifact(input: ArtifactReadInput): Promise<ArtifactReadResult> {
    const args = artifactReadArgsSchema.parse(input);
    return this.#project(args.project_id).readArtifact(args);
  }

  async close(policy: 'wait' | 'cancel' | 'reject' = 'wait'): Promise<void> {
    await this.#pool.close(policy);
    this.#projects.clear();
  }
}
function requireCompleted(outcome: JobOutcome): void {
  if (outcome.job.state === 'completed') return;
  const diagnostic = outcome.job.diagnostics[0];
  if (diagnostic) throw new OperationError(decodeDiagnostic(diagnostic));
  queryFailure(
    outcome.job.state === 'stale' ? 'stale_revision' : 'resource_limit',
    `Job ended ${outcome.job.state}`,
  );
}
