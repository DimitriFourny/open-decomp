import type { LoadedImage, StoreTransaction } from '../core/index.js';
import {
  constants,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  realpathSync,
  existsSync,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';
import {
  ImmutableBytes,
  OperationError,
  contentHash,
  createOperationContext,
  encodeDiagnostic,
  encodeJob,
  imageIdentity,
  isSchemaValidated,
  type Diagnostic,
  type Job,
  type OperationContext,
  type ProjectStore,
  type ToolArgs,
  type ToolName,
  type ToolResult,
  toolSchemas,
} from '../core/index.js';
import { MachOLoader } from '../loaders/macho/index.js';
import { peLoader } from '../loaders/pe/index.js';
import { elfLoader } from '../loaders/elf/index.js';
import { SqliteProjectStore } from '../project/store/index.js';
import {
  commandSchema,
  eventSchema,
  FrameDecoder,
  frame,
  MAX_IMAGES,
  type Command,
  type OpenJobReport,
  type WorkRequest,
  type WorkerEvent,
  type WorkerSnapshot,
  type ExecuteRequest,
} from './protocol.js';
import { RequestPool, publishPooled, type PooledOutcome } from './request-pool.js';

export interface PreparedImport {
  /** Native facts plus the bounded diagnostic/capability report from import preparation. */
  readonly image: LoadedImage;
  publish(transaction: StoreTransaction): void;
}

/** Statically wire this in a trusted child entry point. Inputs/results are frontend wire types;
 * the store, decoded images and IR remain inside the owning child. Publishing handlers must
 * use store.publishArtifact or commit the terminal job in their mutation transaction.
 * No module names, executable source or SQL are accepted over the transport. */
export interface WorkerHandler {
  execute<K extends ToolName>(
    operation: K,
    args: ToolArgs<K>,
    scope: {
      readonly store: ProjectStore;
      readonly context: OperationContext;
      readonly job_id: string;
      readonly max_result_bytes?: number;
      /** False: no derived-analysis reads or writes (host setting, not a request option). */
      readonly analysis_cache?: boolean;
    },
  ): Promise<ToolResult<K>>;
  /** Preparation runs before publication. The final image report and navigation
   * writes share the same transaction; failed preparation publishes neither. */
  prepareImport?(
    image: LoadedImage,
    scope: {
      readonly store: ProjectStore;
      readonly context: OperationContext;
      readonly revision: number;
    },
  ): Promise<PreparedImport>;
  /** The open-time job over the current revision (docs/internals/project-cache.md §5a). It
   * never throws: failure and cancellation are reported states. */
  prepareUnits?(
    store: ProjectStore,
    options: { readonly jobs?: number; readonly work?: number; readonly signal: AbortSignal },
  ): Promise<OpenJobReport>;
}
export function workerDiagnostic(error: unknown): Diagnostic {
  return error instanceof OperationError
    ? error.diagnostic
    : {
        code: 'internal_error',
        severity: 'error',
        message: (error instanceof Error ? error.message : String(error)).slice(0, 8192),
        evidence_ids: [],
      };
}
function fail(code: Diagnostic['code'], message: string): never {
  throw new OperationError({ code, severity: 'error', message, evidence_ids: [] });
}
const terminal = (job: Job): boolean => !['queued', 'running'].includes(job.state);

export async function describeProject(store: ProjectStore): Promise<WorkerSnapshot> {
  const snapshot = store.snapshot();
  if (snapshot.images.length > MAX_IMAGES)
    fail('resource_limit', 'Worker project summary exceeds 256 images');
  const images = snapshot.images.map((image) => {
    try {
      store.readLoadedImage(image.image_id, image.selected_slice_id);
      return { ...image, state: 'loaded' as const };
    } catch (error) {
      if (error instanceof OperationError && error.code === 'not_found')
        return { ...image, state: 'snapshot_without_metadata' as const };
      throw error;
    }
  });
  return { ...snapshot, images };
}

/** Idle write-back of queued callee summaries: wait this long after the last command, then write
 * this many rows per slice, so a command arriving meanwhile waits for one slice at most. */
const IDLE_FLUSH_DELAY_MS = 200;
const IDLE_FLUSH_ROWS = 8;

/** A request's operation context: its budget, its deadline counted from admission. */
export function requestContext(
  budget: WorkRequest['budget'],
  deadline: number,
  onProgress: (phase: string, completed: number, total: number | null) => void,
): OperationContext {
  return createOperationContext({
    budget: {
      ...budget,
      deadline_ms: Math.max(1, Math.min(budget.deadline_ms, deadline - Date.now())),
    },
    onProgress,
  });
}

/** At most one progress report per 100 ms. */
export function throttled(
  report: (phase: string, completed: number, total: number | null) => void,
): (phase: string, completed: number, total: number | null) => void {
  let last = 0;
  return (phase, completed, total) => {
    const now = Date.now();
    if (now - last < 100) return;
    last = now;
    report(phase, completed, total);
  };
}

/** The part of an `execute` request that reads and writes only `store`: the same in the
 * owner (the project's store) and in a request worker (its `RequestStore`), so where a
 * request runs never changes its work or result. Returns the validated result. */
export async function executeRequest(
  handler: WorkerHandler,
  request: ExecuteRequest,
  scope: {
    readonly store: ProjectStore;
    readonly context: OperationContext;
    readonly job_id: string;
    readonly analysis_cache: boolean;
  },
): Promise<unknown> {
  const { store, context } = scope;
  const args = toolSchemas[request.operation].input.parse(request.args);
  let result: unknown = await handler.execute(request.operation, args, {
    store,
    context,
    job_id: scope.job_id,
    ...(scope.analysis_cache ? {} : { analysis_cache: false }),
    ...(request.max_result_bytes === undefined
      ? {}
      : { max_result_bytes: request.max_result_bytes }),
  });
  // Prepared callee summaries this request queued and no publication released: readable
  // from here on. They are written later (idle slices, queue pressure, close), never on the
  // request's path.
  store.releaseNativeSummaries();
  // A handler that parsed and size-checked its result under these very limits
  // (queryWorkerHandler) has marked it; do not repeat the parse and serialization.
  if (!isSchemaValidated(result)) {
    result = toolSchemas[request.operation].output.parse(result);
    frame(result, Math.min(request.budget.output_bytes, request.max_result_bytes ?? Infinity));
  }
  return result;
}

/** Trusted in-process observation seam for deterministic fault injection at real durable boundaries.
 * It is never selected or configured by an IPC request. */
export interface WorkerRuntimeObserver {
  phase?(phase: 'running' | 'image_snapshot' | 'published', job: Job): void;
}
/** A process entry point, not an in-process host backend. stdout is exclusively framed IPC. */
export function runProjectWorker(handler?: WorkerHandler, observer?: WorkerRuntimeObserver): void {
  let store: SqliteProjectStore | undefined;
  let maxQueued = 0;
  let analysisCache = true;
  let stopping = false;
  const admitted = new Map<string, { request: WorkRequest; deadline: number }>();
  // The running open-time job, cancellable on arrival of `cancel_units`.
  let unitsJob: { readonly id: string; readonly controller: AbortController } | undefined;
  let chain = Promise.resolve();
  let pending = 0;
  // Request workers analysing `function_decompile` jobs of this project in parallel (the
  // `open` command's `request_workers` > 1; docs/internals/project-cache.md §4b).
  let requestPool: RequestPool | undefined;
  // Queued callee summaries are cache data: they are written in small slices while no command
  // is waiting, after the response that produced them was sent. A crash loses them, never a
  // job or artifact (those commit before their response; docs/internals/project-cache.md).
  let idleFlush: ReturnType<typeof setTimeout> | undefined;
  const scheduleIdleFlush = (delay: number): void => {
    if (idleFlush !== undefined) clearTimeout(idleFlush);
    idleFlush = setTimeout(() => {
      idleFlush = undefined;
      if (!store || stopping || pending > 0) return;
      try {
        if (store.flushNativeSummaries(IDLE_FLUSH_ROWS) > 0) scheduleIdleFlush(0);
      } catch {
        // A cache write never fails the worker.
      }
    }, delay);
    idleFlush.unref();
  };
  const send = async (event: WorkerEvent): Promise<void> => {
    const bytes = frame(eventSchema.parse(event));
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(bytes, (error) => (error ? reject(error) : resolve())),
    );
  };
  const requireStore = (): SqliteProjectStore => {
    if (!store) fail('invalid_input', 'Worker project is not open');
    return store;
  };
  const saveFailure = (job: Job, error: unknown): Job => {
    const db = requireStore();
    const persisted = db.readJob(job.id);
    if (persisted && terminal(persisted)) return persisted;
    const diagnostic = workerDiagnostic(error);
    // A mutation may already have committed before cancellation was observed. Never label it cancelled.
    const changed = db.snapshot().revision !== job.input_revision;
    const state = diagnostic.code === 'cancelled' && !changed ? 'cancelled' : 'failed';
    const result: Job = {
      ...job,
      state,
      diagnostics: [
        diagnostic,
        ...(changed
          ? [
              {
                code: 'internal_error' as const,
                severity: 'warning' as const,
                message:
                  'Project revision changed before interruption; inspect the committed snapshot. The mutation was not retried.',
                evidence_ids: [],
              },
            ]
          : []),
      ],
    };
    db.saveJob(result);
    return result;
  };
  /** Publish a request worker's outcome as the owner would have published it in place: its
   * artifacts under the identities its result carries, then the job's terminal state. */
  const finishPooled = async (running: Job, outcome: PooledOutcome): Promise<void> => {
    const db = requireStore();
    let job = running;
    let result: unknown;
    try {
      // Publications the request made before failing stand, as they would in the owner.
      await publishPooled(db, job.id, outcome.publications);
      if (outcome.error) throw new OperationError(outcome.error);
      const persisted = db.readJob(job.id);
      if (persisted && terminal(persisted)) job = persisted;
      else {
        job =
          outcome.job && terminal(outcome.job)
            ? outcome.job
            : {
                ...job,
                state: 'completed',
                progress: { phase: 'complete', completed: 1, total: 1 },
              };
        db.saveJob(job);
      }
      result = outcome.result;
    } catch (error) {
      result = undefined;
      job = saveFailure(job, error);
    }
    await send({
      kind: 'job',
      id: job.id,
      job: encodeJob(job),
      ...(result === undefined ? {} : { result }),
    });
  };
  const execute = async (command: Command): Promise<void> => {
    if (stopping) return;
    if (command.kind === 'open') {
      if (store) fail('invalid_input', 'Worker already owns a project');
      const canonical = existsSync(command.path)
        ? realpathSync(command.path)
        : join(realpathSync(dirname(command.path)), basename(command.path));
      if (canonical !== command.path)
        fail('permission_denied', 'Authorized project path changed before child open');
      store = SqliteProjectStore.open(
        command.path,
        command.mode,
        command.native_summary_bytes === undefined
          ? {}
          : { native_summary_bytes: command.native_summary_bytes },
      );
      maxQueued = command.max_queued;
      analysisCache = command.analysis_cache;
      if (handler && command.request_workers > 1) {
        const pool = new RequestPool(command.request_workers, {
          project: command.path,
          analysis_cache: analysisCache,
          ...(command.native_summary_bytes === undefined
            ? {}
            : { native_summary_bytes: command.native_summary_bytes }),
        });
        requestPool = pool;
        // A request worker analysing when the owner is stopped would outlive it.
        process.once('SIGTERM', () => {
          pool.kill();
          process.exit(143);
        });
      }
      const recoveryContext = createOperationContext();
      let cursor: string | undefined;
      do {
        const page = store.listJobs({ limit: 100, ...(cursor ? { cursor } : {}) });
        for (const job of page.items) {
          recoveryContext.checkpoint(1);
          if (!terminal(job)) {
            const interrupted =
              command.interrupted?.id === job.id ? command.interrupted.reason : undefined;
            const cancelled =
              interrupted === 'cancelled' && store.snapshot().revision === job.input_revision;
            store.saveJob({
              ...job,
              state: cancelled ? 'cancelled' : 'failed',
              diagnostics: [
                {
                  code: cancelled
                    ? 'cancelled'
                    : interrupted === 'deadline'
                      ? 'resource_limit'
                      : 'worker_failed',
                  severity: 'error',
                  message:
                    'Worker ownership was lost before terminal acknowledgement; inspect the last committed snapshot. Operation was not retried.',
                  evidence_ids: [],
                },
              ],
            });
          }
        }
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
      await send({ kind: 'opened', id: command.id, snapshot: await describeProject(store) });
      return;
    }
    const db = requireStore();
    if (command.kind === 'snapshot') {
      await send({ kind: 'opened', id: command.id, snapshot: await describeProject(db) });
      return;
    }
    if (command.kind === 'artifact_read') {
      // Reserve envelope overhead below the transport's 2 MiB cap (hex doubles bytes).
      const result = await db.readArtifact({
        ...command.args,
        length: Math.min(command.args.length, 512 * 1024),
      });
      await send({ kind: 'artifact', id: command.id, result });
      return;
    }
    if (command.kind === 'close') {
      if (admitted.size) fail('invalid_input', 'Cannot close with admitted jobs');
      // The request workers' prepared units join the project's store before it closes.
      await requestPool?.close(db);
      await db.close();
      store = undefined;
      stopping = true;
      await send({ kind: 'closed', id: command.id });
      process.stdin.destroy();
      return;
    }
    if (command.kind === 'prepare_units') {
      const controller = new AbortController();
      unitsJob = { id: command.id, controller };
      let report: OpenJobReport;
      try {
        report =
          handler?.prepareUnits && analysisCache
            ? await handler.prepareUnits(db, {
                ...(command.jobs === undefined ? {} : { jobs: command.jobs }),
                ...(command.work === undefined ? {} : { work: command.work }),
                signal: controller.signal,
              })
            : {
                state: 'skipped',
                ms: 0,
                work: 0,
                jobs: 0,
                prepared: 0,
                retained: 0,
                bytes: 0,
                stored: 0,
              };
      } finally {
        unitsJob = undefined;
      }
      // Request workers start now, over a snapshot that holds the job's units, so the first
      // requests do not wait for them.
      requestPool?.prepare(db);
      await send({ kind: 'units', id: command.id, report });
      return;
    }
    if (command.kind === 'status') {
      const job = db.readJob(command.job_id);
      if (!job) fail('not_found', 'Unknown durable job');
      await send({ kind: 'job', id: command.id, job: encodeJob(job) });
      return;
    }
    if (command.kind === 'admit') {
      if (admitted.size >= maxQueued + 1) fail('resource_limit', 'Worker admission queue is full');
      if (db.readJob(command.id)) fail('invalid_input', 'Job identity already exists');
      let inputRevision = db.snapshot().revision;
      if (command.request.kind === 'execute') {
        const args = toolSchemas[command.request.operation].input.parse(command.request.args);
        if (args.project_id !== db.project_id)
          fail('permission_denied', 'Operation belongs to another project');
        inputRevision = 'revision' in args ? args.revision : args.expected_revision;
      }
      const job: Job = {
        id: command.id,
        project_id: db.project_id,
        input_revision: inputRevision,
        operation: command.request.kind === 'import' ? 'project_open' : command.request.operation,
        state: 'queued',
        progress: { phase: 'queued', completed: 0, total: null },
        artifacts: [],
        diagnostics: [],
        published_revision: null,
      };
      db.saveJob(job);
      admitted.set(command.id, {
        request: command.request as WorkRequest,
        deadline: command.deadline,
      });
      await send({ kind: 'job', id: command.id, job: encodeJob(job) });
      return;
    }
    let job = db.readJob(command.id);
    if (!job) fail('not_found', 'Unknown durable job');
    if (terminal(job)) {
      await send({ kind: 'job', id: command.id, job: encodeJob(job) });
      return;
    }
    if (command.kind === 'cancel') {
      admitted.delete(command.id);
      job = { ...job, state: 'cancelled' };
      db.saveJob(job);
      await send({ kind: 'job', id: command.id, job: encodeJob(job) });
      return;
    }
    const work = admitted.get(command.id);
    if (!work) fail('invalid_input', 'Job input is not admitted in this process');
    admitted.delete(command.id);
    let result: unknown;
    try {
      if (Date.now() >= work.deadline) fail('resource_limit', 'Job deadline expired while queued');
      const requiresCurrent =
        work.request.kind === 'import' ||
        work.request.operation === 'annotations_apply' ||
        work.request.operation === 'functions_discover' ||
        work.request.operation === 'function_decompile';
      if (requiresCurrent && job.input_revision !== db.snapshot().revision) {
        job = { ...job, state: 'stale' };
        db.saveJob(job);
      } else {
        job = {
          ...job,
          state: 'running',
          progress: { phase: 'running', completed: 0, total: null },
        };
        db.saveJob(job);
        await send({ kind: 'progress', id: job.id, job: encodeJob(job) });
        observer?.phase?.('running', job);
        const onProgress = (phase: string, completed: number, total: number | null): void => {
          job = { ...job!, progress: { phase, completed, total } };
          db.saveJob(job);
          // At most one buffered progress frame; stdout backpressure never grows an unbounded queue.
          if (process.stdout.writableLength === 0)
            process.stdout.write(frame({ kind: 'progress', id: job.id, job: encodeJob(job) }));
        };
        if (requestPool && work.request.kind === 'execute' && requestPool.serves(work.request)) {
          // Analysed by a request worker; the owner publishes its outcome when it arrives,
          // after this command (docs/internals/project-cache.md §4b).
          requestPool.prepare(db);
          const running = job;
          pending++;
          void requestPool
            .run(running, work.request, work.deadline, (progress) => {
              if (terminal(progress)) return;
              onProgress(
                progress.progress.phase,
                progress.progress.completed,
                progress.progress.total,
              );
            })
            .then((outcome) => schedule(running.id, () => finishPooled(running, outcome)))
            .finally(() => {
              if (--pending === 0 && store && !stopping) scheduleIdleFlush(IDLE_FLUSH_DELAY_MS);
            });
          return;
        }
        const context = requestContext(work.request.budget, work.deadline, throttled(onProgress));
        context.checkpoint(0);
        if (work.request.kind === 'import') {
          const before = db.snapshot();
          if (work.request.resume_only) {
            if (before.images.length > 1)
              fail('invalid_input', 'Import repair cannot select a multi-image project');
            const prior = before.images[0];
            if (prior) {
              let loaded = false;
              try {
                db.readLoadedImage(prior.image_id, prior.selected_slice_id);
                loaded = true;
              } catch (error) {
                if (!(error instanceof OperationError) || error.code !== 'not_found') throw error;
              }
              if (loaded) fail('invalid_input', 'Import repair cannot replace a loaded image');
            }
          }
          if (db.snapshot().images.length >= MAX_IMAGES)
            fail('resource_limit', 'Project image limit reached');
          if (realpathSync(work.request.source_path) !== work.request.source_path)
            fail('permission_denied', 'Authorized source path changed before child read');
          const fd = openSync(
            work.request.source_path,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
          );
          let raw: Buffer;
          try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.size > 512 * 1024 * 1024)
              fail('resource_limit', 'Input must be a regular file of at most 512 MiB');
            raw = Buffer.allocUnsafe(stat.size);
            for (let offset = 0; offset < raw.length;) {
              context.checkpoint(1);
              const count = readSync(
                fd,
                raw,
                offset,
                Math.min(1_048_576, raw.length - offset),
                offset,
              );
              if (!count) fail('invalid_input', 'Input changed while being read');
              offset += count;
            }
          } finally {
            closeSync(fd);
          }
          const sha256 = contentHash(raw),
            bytes = new ImmutableBytes(raw),
            image_id = imageIdentity(sha256);
          const loader =
            raw[0] === 0x4d && raw[1] === 0x5a
              ? peLoader
              : raw[0] === 0x7f && raw[1] === 0x45 && raw[2] === 0x4c && raw[3] === 0x46
                ? elfLoader
                : new MachOLoader();
          const image = loader.load(
            { bytes, sha256, image_id, slice_id: work.request.slice_id },
            context,
          );
          if (
            work.request.resume_only &&
            before.images.some(
              (prior) =>
                prior.sha256 !== sha256 || prior.selected_slice_id !== image.selected_slice_id,
            )
          ) {
            fail(
              'invalid_input',
              'Import repair bytes and selected slice must match the saved snapshot',
            );
          }
          context.checkpoint(0);
          await db.importImage({ bytes, sha256, selected_slice_id: image.selected_slice_id });
          job = { ...job, progress: { phase: 'image_snapshot', completed: 1, total: 2 } };
          db.saveJob(job);
          await send({ kind: 'progress', id: job.id, job: encodeJob(job) });
          observer?.phase?.('image_snapshot', job);
          context.checkpoint(0);
          const prepared = await handler?.prepareImport?.(image, {
            store: db,
            context,
            revision: db.snapshot().revision + 1,
          });
          context.checkpoint(0);
          const completed: Job = {
            ...job,
            state: 'completed',
            progress: { phase: 'complete', completed: 1, total: 1 },
          };
          const mutation = db.transaction(db.snapshot().revision, (tx) => {
            tx.putImage(prepared?.image ?? image);
            prepared?.publish(tx);
            db.saveJob(completed);
          });
          if (mutation.state === 'conflict')
            fail('stale_revision', 'Image publication revision changed');
          if (mutation.state === 'rejected')
            throw new OperationError(
              mutation.diagnostics[0] ?? {
                code: 'internal_error',
                severity: 'error',
                message: 'Image publication was rejected without a diagnostic',
                evidence_ids: [],
              },
            );
          job = completed;
          await send({ kind: 'progress', id: job.id, job: encodeJob(job) });
          observer?.phase?.('published', job);
          result = await describeProject(db);
          frame(result, work.request.budget.output_bytes);
        } else {
          if (!handler)
            fail(
              'unavailable_semantics',
              `No child handler is registered for ${work.request.operation}`,
            );
          result = await executeRequest(handler, work.request, {
            store: db,
            context,
            job_id: job.id,
            analysis_cache: analysisCache,
          });
          const persisted = db.readJob(job.id);
          if (persisted && terminal(persisted)) job = persisted;
          else {
            context.checkpoint(0);
            job = {
              ...job,
              state: 'completed',
              progress: { phase: 'complete', completed: 1, total: 1 },
            };
            db.saveJob(job);
          }
        }
      }
    } catch (error) {
      result = undefined;
      job = saveFailure(job, error);
      // Import may have saved immutable bytes before failing metadata preparation.
      // Acknowledge that revision without pretending the failed job completed.
      if (work.request.kind === 'import') result = await describeProject(db);
    }
    await send({
      kind: 'job',
      id: command.id,
      job: encodeJob(job),
      ...(result === undefined ? {} : { result }),
    });
  };
  /** Run `task` after every command and publication before it, in order; a failure answers
   * `id` with an error. */
  const schedule = (id: string, task: () => Promise<void>): void => {
    if (++pending > 1028) throw new Error('Too many pending worker commands');
    if (idleFlush !== undefined) {
      clearTimeout(idleFlush);
      idleFlush = undefined;
    }
    chain = chain
      .then(async () => {
        try {
          await task();
        } catch (error) {
          await send({
            kind: 'error',
            id,
            diagnostic: encodeDiagnostic(workerDiagnostic(error)),
          });
        } finally {
          if (--pending === 0 && store && !stopping) scheduleIdleFlush(IDLE_FLUSH_DELAY_MS);
        }
      })
      .catch(() => {
        process.exitCode = 1;
        process.stdin.destroy();
        requestPool?.kill();
        void store?.close();
      });
  };
  const decoder = new FrameDecoder((value) => {
    const command = commandSchema.parse(value);
    if (command.kind === 'cancel_units') {
      if (unitsJob?.id === command.target) unitsJob.controller.abort();
      return;
    }
    schedule(command.id, () => execute(command));
  });
  process.stdin.on('data', (chunk: Buffer) => {
    try {
      decoder.push(chunk);
    } catch {
      process.exit(1);
    }
  });
  process.stdin.on('end', () => {
    void chain.finally(async () => {
      requestPool?.kill();
      await store?.close();
    });
  });
  process.stdin.on('error', () => {
    process.exitCode = 1;
    requestPool?.kill();
    void store?.close();
  });
}
