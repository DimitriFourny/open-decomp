import type { LoadedImage, StoreTransaction } from '../core/index.js';
import { constants, openSync, fstatSync, readSync, closeSync, realpathSync, existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { ImmutableBytes, OperationError, contentHash, createOperationContext, encodeDiagnostic, encodeJob, imageIdentity, type Diagnostic, type Job, type OperationContext, type ProjectStore, type ToolArgs, type ToolName, type ToolResult, toolSchemas } from '../core/index.js';
import { MachOLoader } from '../loaders/macho/index.js';
import { peLoader } from '../loaders/pe/index.js';
import { SqliteProjectStore } from '../project/store/index.js';
import { commandSchema, eventSchema, FrameDecoder, frame, MAX_IMAGES, type Command, type WorkRequest, type WorkerEvent, type WorkerSnapshot } from './protocol.js';

/** Statically wire this in a trusted child entry point. Inputs/results are frontend wire types;
 * the store, decoded images and IR remain inside the owning child. Publishing handlers must
 * use store.publishArtifact or commit the terminal job in their mutation transaction.
 * No module names, executable source or SQL are accepted over the transport. */
export interface WorkerHandler {
  execute<K extends ToolName>(operation: K, args: ToolArgs<K>, scope: { readonly store: ProjectStore; readonly context: OperationContext; readonly job_id: string }): Promise<ToolResult<K>>;
  /** Async preparation runs before publication; returned writes run synchronously in
   * the same transaction as immutable loader facts. A failed preparation publishes none. */
  prepareImport?(image: LoadedImage, scope: { readonly store: ProjectStore; readonly context: OperationContext; readonly revision: number }): Promise<(tx: StoreTransaction) => void>;
}
export function workerDiagnostic(error: unknown): Diagnostic {
  return error instanceof OperationError ? error.diagnostic : { code: 'internal_error', severity: 'error', message: (error instanceof Error ? error.message : String(error)).slice(0, 8192), evidence_ids: [] };
}
function fail(code: Diagnostic['code'], message: string): never { throw new OperationError({ code, severity: 'error', message, evidence_ids: [] }); }
const terminal = (job: Job): boolean => !['queued', 'running'].includes(job.state);

export async function describeProject(store: ProjectStore): Promise<WorkerSnapshot> {
  const snapshot = store.snapshot();
  if (snapshot.images.length > MAX_IMAGES) fail('resource_limit', 'Worker project summary exceeds 256 images');
  const images = snapshot.images.map(image => {
    try { store.readLoadedImage(image.image_id, image.selected_slice_id); return { ...image, state: 'loaded' as const }; }
    catch (error) {
      if (error instanceof OperationError && error.code === 'not_found') return { ...image, state: 'snapshot_without_metadata' as const };
      throw error;
    }
  });
  return { ...snapshot, images };
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
  let stopping = false;
  const admitted = new Map<string, { request: WorkRequest; deadline: number }>();
  let chain = Promise.resolve();
  let pending = 0;
  const send = async (event: WorkerEvent): Promise<void> => {
    const bytes = frame(eventSchema.parse(event));
    await new Promise<void>((resolve, reject) => process.stdout.write(bytes, error => error ? reject(error) : resolve()));
  };
  const requireStore = (): SqliteProjectStore => { if (!store) fail('invalid_input', 'Worker project is not open'); return store; };
  const saveFailure = (job: Job, error: unknown): Job => {
    const db = requireStore();
    const persisted = db.readJob(job.id);
    if (persisted && terminal(persisted)) return persisted;
    const diagnostic = workerDiagnostic(error);
    // A mutation may already have committed before cancellation was observed. Never label it cancelled.
    const changed = db.snapshot().revision !== job.input_revision;
    const state = diagnostic.code === 'cancelled' && !changed ? 'cancelled' : 'failed';
    const result: Job = { ...job, state, diagnostics: [diagnostic, ...(changed ? [{ code: 'internal_error' as const, severity: 'warning' as const, message: 'Project revision changed before interruption; inspect the committed snapshot. The mutation was not retried.', evidence_ids: [] }] : [])] };
    db.saveJob(result); return result;
  };
  const execute = async (command: Command): Promise<void> => {
    if (stopping) return;
    if (command.kind === 'open') {
      if (store) fail('invalid_input', 'Worker already owns a project');
      const canonical = existsSync(command.path) ? realpathSync(command.path) : join(realpathSync(dirname(command.path)), basename(command.path));
      if (canonical !== command.path) fail('permission_denied', 'Authorized project path changed before child open');
      store = SqliteProjectStore.open(command.path, command.mode); maxQueued = command.max_queued;
      const recoveryContext = createOperationContext();
      let cursor: string | undefined;
      do {
        const page = store.listJobs({ limit: 100, ...(cursor ? { cursor } : {}) });
        for (const job of page.items) {
          recoveryContext.checkpoint(1);
          if (!terminal(job)) {
            const interrupted = command.interrupted?.id === job.id ? command.interrupted.reason : undefined;
            const cancelled = interrupted === 'cancelled' && store.snapshot().revision === job.input_revision;
            store.saveJob({ ...job, state: cancelled ? 'cancelled' : 'failed', diagnostics: [{ code: cancelled ? 'cancelled' : interrupted === 'deadline' ? 'resource_limit' : 'worker_failed', severity: 'error', message: 'Worker ownership was lost before terminal acknowledgement; inspect the last committed snapshot. Operation was not retried.', evidence_ids: [] }] });
          }
        }
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
      await send({ kind: 'opened', id: command.id, snapshot: await describeProject(store) }); return;
    }
    const db = requireStore();
    if (command.kind === 'snapshot') { await send({ kind: 'opened', id: command.id, snapshot: await describeProject(db) }); return; }
    if (command.kind === 'artifact_read') {
      // Reserve envelope overhead below the transport's 2 MiB cap (hex doubles bytes).
      const result = await db.readArtifact({ ...command.args, length: Math.min(command.args.length, 512 * 1024) });
      await send({ kind: 'artifact', id: command.id, result }); return;
    }
    if (command.kind === 'close') {
      if (admitted.size) fail('invalid_input', 'Cannot close with admitted jobs');
      await db.close(); store = undefined; stopping = true;
      await send({ kind: 'closed', id: command.id }); process.stdin.destroy(); return;
    }
    if (command.kind === 'status') {
      const job = db.readJob(command.job_id); if (!job) fail('not_found', 'Unknown durable job');
      await send({ kind: 'job', id: command.id, job: encodeJob(job) }); return;
    }
    if (command.kind === 'admit') {
      if (admitted.size >= maxQueued + 1) fail('resource_limit', 'Worker admission queue is full');
      if (db.readJob(command.id)) fail('invalid_input', 'Job identity already exists');
      let inputRevision = db.snapshot().revision;
      if (command.request.kind === 'execute') {
        const args = toolSchemas[command.request.operation].input.parse(command.request.args);
        if (args.project_id !== db.project_id) fail('permission_denied', 'Operation belongs to another project');
        inputRevision = 'revision' in args ? args.revision : args.expected_revision;
      }
      const job: Job = { id: command.id, project_id: db.project_id, input_revision: inputRevision, operation: command.request.kind === 'import' ? 'project_open' : command.request.operation, state: 'queued', progress: { phase: 'queued', completed: 0, total: null }, artifacts: [], diagnostics: [], published_revision: null };
      db.saveJob(job);
      admitted.set(command.id, { request: command.request as WorkRequest, deadline: command.deadline });
      await send({ kind: 'job', id: command.id, job: encodeJob(job) }); return;
    }
    let job = db.readJob(command.id); if (!job) fail('not_found', 'Unknown durable job');
    if (terminal(job)) { await send({ kind: 'job', id: command.id, job: encodeJob(job) }); return; }
    if (command.kind === 'cancel') {
      admitted.delete(command.id); job = { ...job, state: 'cancelled' }; db.saveJob(job);
      await send({ kind: 'job', id: command.id, job: encodeJob(job) }); return;
    }
    const work = admitted.get(command.id); if (!work) fail('invalid_input', 'Job input is not admitted in this process');
    admitted.delete(command.id);
    let result: unknown;
    try {
      if (Date.now() >= work.deadline) fail('resource_limit', 'Job deadline expired while queued');
      const requiresCurrent = work.request.kind === 'import' || work.request.operation === 'annotations_apply' || work.request.operation === 'function_decompile';
      if (requiresCurrent && job.input_revision !== db.snapshot().revision) {
        job = { ...job, state: 'stale' }; db.saveJob(job);
      } else {
        job = { ...job, state: 'running', progress: { phase: 'running', completed: 0, total: null } }; db.saveJob(job);
        await send({ kind: 'progress', id: job.id, job: encodeJob(job) });
        observer?.phase?.('running', job);
        let lastProgress = 0;
        const context = createOperationContext({ budget: { ...work.request.budget, deadline_ms: Math.max(1, Math.min(work.request.budget.deadline_ms, work.deadline - Date.now())) }, onProgress: (phase, completed, total) => {
          const now = Date.now(); if (now - lastProgress < 100) return; lastProgress = now;
          job = { ...job!, progress: { phase, completed, total } }; db.saveJob(job);
          // At most one buffered progress frame; stdout backpressure never grows an unbounded queue.
          if (process.stdout.writableLength === 0) process.stdout.write(frame({ kind: 'progress', id: job.id, job: encodeJob(job) }));
        } });
        context.checkpoint(0);
        if (work.request.kind === 'import') {
          if (db.snapshot().images.length >= MAX_IMAGES) fail('resource_limit', 'Project image limit reached');
          if (realpathSync(work.request.source_path) !== work.request.source_path) fail('permission_denied', 'Authorized source path changed before child read');
          const fd = openSync(work.request.source_path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          let raw: Buffer;
          try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.size > 512 * 1024 * 1024) fail('resource_limit', 'Input must be a regular file of at most 512 MiB');
            raw = Buffer.allocUnsafe(stat.size);
            for (let offset = 0; offset < raw.length;) {
              context.checkpoint(1);
              const count = readSync(fd, raw, offset, Math.min(1_048_576, raw.length - offset), offset);
              if (!count) fail('invalid_input', 'Input changed while being read'); offset += count;
            }
          } finally { closeSync(fd); }
          const sha256 = contentHash(raw), bytes = new ImmutableBytes(raw), image_id = imageIdentity(sha256);
          const loader = raw[0] === 0x4d && raw[1] === 0x5a ? peLoader : new MachOLoader();
          const image = loader.load({ bytes, sha256, image_id, slice_id: work.request.slice_id }, context);
          context.checkpoint(0);
          await db.importImage({ bytes, sha256, selected_slice_id: image.selected_slice_id });
          job = { ...job, progress: { phase: 'image_snapshot', completed: 1, total: 2 } }; db.saveJob(job);
          await send({ kind: 'progress', id: job.id, job: encodeJob(job) });
          observer?.phase?.('image_snapshot', job);
          context.checkpoint(0);
          const publishPrepared = await handler?.prepareImport?.(image, { store: db, context, revision: db.snapshot().revision + 1 });
          context.checkpoint(0);
          const completed: Job = { ...job, state: 'completed', progress: { phase: 'complete', completed: 1, total: 1 } };
          const mutation = db.transaction(db.snapshot().revision, tx => { tx.putImage(image); publishPrepared?.(tx); db.saveJob(completed); });
          if (mutation.state !== 'committed') fail('internal_error', 'Loaded image metadata transaction did not commit');
          job = completed;
          await send({ kind: 'progress', id: job.id, job: encodeJob(job) });
          observer?.phase?.('published', job);
          result = await describeProject(db);
          frame(result, work.request.budget.output_bytes);
        } else {
          if (!handler) fail('unavailable_semantics', `No child handler is registered for ${work.request.operation}`);
          const args = toolSchemas[work.request.operation].input.parse(work.request.args);
          result = await handler.execute(work.request.operation, args, { store: db, context, job_id: job.id });
          result = toolSchemas[work.request.operation].output.parse(result);
          frame(result, work.request.budget.output_bytes);
          const persisted = db.readJob(job.id);
          if (persisted && terminal(persisted)) job = persisted;
          else { context.checkpoint(0); job = { ...job, state: 'completed', progress: { phase: 'complete', completed: 1, total: 1 } }; db.saveJob(job); }
        }
      }
    } catch (error) { result = undefined; job = saveFailure(job, error); }
    await send({ kind: 'job', id: command.id, job: encodeJob(job), ...(result === undefined ? {} : { result }) });
  };
  const decoder = new FrameDecoder(value => {
    const command = commandSchema.parse(value);
    if (++pending > 1028) throw new Error('Too many pending worker commands');
    chain = chain.then(async () => {
      try { await execute(command); }
      catch (error) { await send({ kind: 'error', id: command.id, diagnostic: encodeDiagnostic(workerDiagnostic(error)) }); }
      finally { pending--; }
    }).catch(() => { process.exitCode = 1; process.stdin.destroy(); void store?.close(); });
  });
  process.stdin.on('data', (chunk: Buffer) => { try { decoder.push(chunk); } catch { process.exit(1); } });
  process.stdin.on('end', () => { void chain.finally(async () => { await store?.close(); }); });
  process.stdin.on('error', () => { process.exitCode = 1; void store?.close(); });
}
