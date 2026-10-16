import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath, lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OperationError, artifactReadArgsSchema, budgetSchema, decodeDiagnostic, newIdentity, toolSchemas, type Diagnostic, type WireJob, type ToolResult } from '../core/index.js';
import { commandSchema, eventSchema, FrameDecoder, frame, requestSchema, snapshotSchema, type ArtifactReadInput, type ArtifactReadResult, type Command, type WorkRequest, type WorkerEvent, type WorkerOperation, type WorkerSnapshot } from './protocol.js';
export type { ArtifactReadInput, ArtifactReadArgs, ArtifactReadResult, WorkRequest, ImportRequest, ExecuteRequest, WorkerOperation, WorkerSnapshot } from './protocol.js';
export type { WorkerHandler } from './runtime.js';

export interface WorkerPoolOptions {
  /** Trusted host configuration, never accepted from an analysis tool request. */
  readonly authorized_roots: readonly string[];
  readonly max_workers?: number;
  readonly max_queued?: number;
  readonly startup_timeout_ms?: number;
  readonly cancel_grace_ms?: number;
  /** Trusted, statically registered child entry point; defaults to workers/entry.js (or .ts under tsx). */
  readonly entry_point?: URL;
  readonly exec_argv?: readonly string[];
}
export interface JobOutcome { readonly job: WireJob; readonly result?: WorkerSnapshot | ToolResult<WorkerOperation> }
export interface JobTicket {
  readonly id: string;
  /** Resolves only after SQLite has durably saved the queued identity and input revision. */
  readonly accepted: Promise<WireJob>;
  /** Terminal state is durable. A recovered completed job may omit its transient result; inspect its artifacts/snapshot. */
  readonly result: Promise<JobOutcome>;
  cancel(): Promise<JobOutcome>;
}
function failure(code: Diagnostic['code'], message: string): OperationError { return new OperationError({ code, severity: 'error', message, evidence_ids: [] }); }
function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw failure('invalid_input', 'Invalid worker resource limit');
  return result;
}
interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Callers may wait for admission before attaching to the terminal promise.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
type PendingJob = {
  id: string; request: WorkRequest; admitted: boolean; running: boolean; cancelled: boolean;
  accepted: Deferred<WireJob>; outcome: Deferred<JobOutcome>;
  latest: WireJob | undefined;
  timer: NodeJS.Timeout; cleanup: () => void;
  onProgress: ((job: WireJob) => void) | undefined;
};

/** One persistent child per canonical project; idle owners count against max_workers.
 * Queue capacity is reserved before source authorization; no unbounded admission backlog.
 * Capacity exhaustion rejects immediately. Close an idle project to release its worker slot.
 * Processes are fault containment, not a filesystem sandbox against a malicious local host. */
export class ProjectWorkerPool {
  readonly max_workers: number;
  readonly max_queued: number;
  readonly #roots: readonly string[];
  readonly #options: WorkerPoolOptions;
  readonly #projects = new Map<string, ProjectWorker>();
  #opening = 0;
  #closed = false;
  private constructor(roots: readonly string[], options: WorkerPoolOptions) {
    this.#roots = roots; this.#options = options;
    this.max_workers = bounded(options.max_workers, 2, 1, 32);
    this.max_queued = bounded(options.max_queued, 16, 0, 1024);
    bounded(options.startup_timeout_ms, 30000, 1, 600000);
    bounded(options.cancel_grace_ms, 100, 0, 10000);
  }
  static async create(options: WorkerPoolOptions): Promise<ProjectWorkerPool> {
    if (!options.authorized_roots.length || options.authorized_roots.length > 64) throw failure('invalid_input', 'Configure between one and 64 authorized roots');
    const roots = await Promise.all(options.authorized_roots.map(async path => {
      const root = await realpath(path); if (!(await lstat(root)).isDirectory()) throw failure('permission_denied', 'Authorized root must be a directory'); return root;
    }));
    return new ProjectWorkerPool(roots, options);
  }
  async authorize(path: string, create = false): Promise<string> {
    const requested = resolve(path);
    let canonical: string;
    try {
      try { canonical = await realpath(requested); }
      catch (error) {
        if (!create || !(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
        canonical = resolve(await realpath(dirname(requested)), basename(requested));
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT') throw failure('not_found', 'Requested path or its parent does not exist');
      if (code === 'EACCES' || code === 'EPERM') throw failure('permission_denied', 'Requested path is not accessible');
      if (code === 'ENOTDIR' || code === 'ELOOP') throw failure('invalid_input', 'Requested path has an invalid directory or symlink chain');
      throw error;
    }
    if (!this.#roots.some(root => { const part = relative(root, canonical); return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)); })) throw failure('permission_denied', 'Path is outside host-authorized roots');
    return canonical;
  }
  async open(input: { path: string; mode: 'create' | 'resume' }): Promise<ProjectWorker> {
    if (this.#closed) throw failure('invalid_input', 'Worker pool is closed');
    if (this.#projects.size + this.#opening >= this.max_workers) throw failure('resource_limit', 'Persistent worker capacity is exhausted');
    this.#opening++;
    try {
      const path = await this.authorize(input.path, input.mode === 'create');
      if (this.#closed) throw failure('invalid_input', 'Worker pool is closed');
      if (this.#projects.has(path)) throw failure('invalid_input', 'Project already has an owner in this pool');
      const worker = new ProjectWorker(this, path, this.#options, () => { this.#projects.delete(path); });
      this.#projects.set(path, worker);
      try { await worker.start(input.mode); return worker; }
      catch (error) { await worker.dispose(); throw error; }
    } finally { this.#opening--; }
  }
  async close(policy: 'wait' | 'cancel' | 'reject' = 'wait'): Promise<void> {
    if (policy === 'reject' && [...this.#projects.values()].some(project => project.busy)) throw failure('invalid_input', 'Worker pool has active jobs');
    this.#closed = true;
    const outcomes = await Promise.allSettled([...this.#projects.values()].map(project => project.close(policy)));
    // One failed close must not let the CLI exit while another owner still holds
    // its database or an admitted job. Report failure only after all owners settle.
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  }
}

export class ProjectWorker {
  readonly #pool: ProjectWorkerPool;
  readonly path: string;
  readonly #options: WorkerPoolOptions;
  readonly #release: () => void;
  #child: ChildProcessWithoutNullStreams | undefined;
  #snapshot: WorkerSnapshot | undefined;
  #closed = false;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #disposePromise: Promise<void> | undefined;
  #expectedExit = false;
  #recovering: Promise<void> | undefined;
  #exit = deferred<void>();
  #running: PendingJob | undefined;
  #reserved = 0;
  readonly #jobs = new Map<string, PendingJob>();
  readonly #requests = new Map<string, Deferred<WorkerEvent>>();
  constructor(pool: ProjectWorkerPool, path: string, options: WorkerPoolOptions, release: () => void) { this.#pool = pool; this.path = path; this.#options = options; this.#release = release; }
  get pid(): number | undefined { return this.#child?.pid; }
  get busy(): boolean { return this.#jobs.size + this.#reserved > 0; }
  get snapshot(): WorkerSnapshot { if (!this.#snapshot) throw failure('invalid_input', 'Worker is not ready'); return structuredClone(this.#snapshot); }
  async start(mode: 'create' | 'resume', interrupted?: { id: string; reason: 'cancelled' | 'deadline' }): Promise<void> {
    const entry = this.#options.entry_point ?? new URL(import.meta.url.endsWith('.ts') ? './entry.ts' : './entry.js', import.meta.url);
    this.#expectedExit = false; this.#exit = deferred<void>();
    const child = spawn(process.execPath, [...(this.#options.exec_argv ?? (entry.pathname.endsWith('.ts') ? ['--import', 'tsx'] : [])), fileURLToPath(entry)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.#child = child;
    let stderrBytes = 0;
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 65536) child.kill('SIGKILL'); });
    const decoder = new FrameDecoder(value => {
      const event = eventSchema.parse(value);
      if (event.kind === 'progress') {
        const job = this.#jobs.get(event.id);
        if (job) { job.latest = event.job; job.onProgress?.(structuredClone(event.job)); }
        return;
      }
      const request = this.#requests.get(event.id);
      if (!request) throw new Error('Unsolicited worker response');
      this.#requests.delete(event.id);
      if (event.kind === 'error') request.reject(new OperationError(decodeDiagnostic(event.diagnostic)));
      else request.resolve(event);
    });
    child.stdout.on('data', (chunk: Buffer) => { try { decoder.push(chunk); } catch { child.kill('SIGKILL'); } });
    child.stdin.on('error', () => { child.kill('SIGKILL'); });
    child.on('error', error => { for (const request of this.#requests.values()) request.reject(error); this.#requests.clear(); });
    child.on('close', () => {
      this.#exit.resolve();
      for (const request of this.#requests.values()) request.reject(failure('worker_failed', 'Project worker exited before acknowledgement'));
      this.#requests.clear();
      if (!this.#expectedExit && !this.#closed && this.#snapshot) void this.#recover();
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), bounded(this.#options.startup_timeout_ms, 30000, 1, 600000));
    try {
      const event = await this.#rpc({ kind: 'open', id: newIdentity('job'), path: this.path, mode, max_queued: this.#pool.max_queued, ...(interrupted ? { interrupted } : {}) });
      if (event.kind !== 'opened') throw failure('worker_failed', 'Invalid worker startup acknowledgement');
      this.#snapshot = event.snapshot;
    } finally { clearTimeout(timeout); }
  }
  async #rpc(command: Command): Promise<WorkerEvent> {
    if (!this.#child || this.#child.exitCode !== null || this.#child.signalCode !== null) throw failure('worker_failed', 'Project worker is unavailable');
    if (this.#requests.size >= this.#pool.max_queued + 4) throw failure('resource_limit', 'Worker control request limit exceeded');
    if (this.#requests.has(command.id)) throw failure('invalid_input', 'Worker request is already pending');
    const bytes = frame(commandSchema.parse(command));
    if (this.#child.stdin.writableLength + bytes.length > 4 * 1024 * 1024) throw failure('resource_limit', 'Worker transport queue is full');
    const result = deferred<WorkerEvent>(); this.#requests.set(command.id, result);
    this.#child.stdin.write(bytes, error => { if (error) { this.#requests.delete(command.id); result.reject(error); } });
    return result.promise;
  }
  async submit(input: WorkRequest, options: { signal?: AbortSignal; onProgress?: (job: WireJob) => void } = {}): Promise<JobTicket> {
    if (this.#closed || this.#closing || this.#recovering) throw failure('invalid_input', 'Project is closing or recovering');
    if (this.#jobs.size + this.#reserved >= this.#pool.max_queued + 1) throw failure('resource_limit', 'Project job queue is full');
    this.#reserved++;
    try {
      let request = requestSchema.parse(input) as WorkRequest;
      if (request.kind === 'import') request = { ...request, source_path: await this.#pool.authorize(request.source_path) };
      else {
        const args = request.args;
        if (!('project_id' in args) || args.project_id !== this.snapshot.project_id) throw failure('permission_denied', 'Request belongs to another project');
      }
      if (this.#closed || this.#closing || this.#recovering) throw failure('invalid_input', 'Project is closing or recovering');
      if (options.signal?.aborted) throw failure('cancelled', 'Submission was already cancelled');
      const id = newIdentity('job'), accepted = deferred<WireJob>(), outcome = deferred<JobOutcome>();
      const deadline = Date.now() + budgetSchema.parse(request.budget).deadline_ms;
      const timer = setTimeout(() => { void this.#interrupt(id, 'deadline').catch(() => {}); }, request.budget.deadline_ms);
      const onAbort = (): void => { void this.#interrupt(id, 'cancelled').catch(() => {}); };
      const job: PendingJob = { id, request, admitted: false, running: false, cancelled: false, latest: undefined, accepted, outcome, timer, cleanup: () => options.signal?.removeEventListener('abort', onAbort), onProgress: options.onProgress };
      this.#jobs.set(id, job); options.signal?.addEventListener('abort', onAbort, { once: true });
      void this.#rpc({ kind: 'admit', id, request, deadline }).then(event => {
        if (event.kind !== 'job') throw failure('worker_failed', 'Invalid admission acknowledgement');
        job.admitted = true; job.latest = structuredClone(event.job); accepted.resolve(event.job);
        this.#pump();
      }).catch(error => { if (!this.#recovering) this.#finishError(job, error); });
      return { id, accepted: accepted.promise, result: outcome.promise, cancel: () => this.#interrupt(id, 'cancelled').then(() => outcome.promise) };
    } finally { this.#reserved--; }
  }
  #pump(): void {
    if (this.#running || this.#recovering || this.#closed) return;
    const job = [...this.#jobs.values()].find(item => item.admitted);
    if (!job) return;
    this.#running = job; job.running = true;
    void this.#rpc({ kind: job.cancelled ? 'cancel' : 'run', id: job.id }).then(event => {
      if (event.kind !== 'job') throw failure('worker_failed', 'Invalid terminal acknowledgement');
      if (['queued', 'running'].includes(event.job.state)) throw failure('worker_failed', 'Worker returned a nonterminal job');
      let result: JobOutcome['result'];
      if (event.result !== undefined) {
        if (job.request.kind === 'import') result = snapshotSchema.parse(event.result);
        else if (job.request.operation === 'annotations_apply') {
          const mutation = toolSchemas.annotations_apply.output.parse(event.result);
          if (event.job.state === 'completed' && mutation.state === 'complete' && this.#snapshot) {
            if (mutation.project_id !== this.#snapshot.project_id || mutation.data.previous_revision !== job.request.args.expected_revision) throw failure('worker_failed', 'Annotation completion does not match its admitted snapshot');
            this.#snapshot = { ...this.#snapshot, revision: Math.max(this.#snapshot.revision, mutation.data.revision) };
          }
          result = mutation;
        } else result = toolSchemas[job.request.operation].output.parse(event.result);
      }
      if (job.request.kind === 'import' && result !== undefined) this.#snapshot = snapshotSchema.parse(result);
      this.#finish(job, { job: event.job, ...(result === undefined ? {} : { result }) });
    }).catch(error => { if (!this.#recovering) this.#finishError(job, error); });
  }
  #remove(job: PendingJob): void { clearTimeout(job.timer); job.cleanup(); this.#jobs.delete(job.id); if (this.#running === job) this.#running = undefined; }
  #finish(job: PendingJob, outcome: JobOutcome): void { this.#remove(job); job.accepted.resolve(outcome.job); job.outcome.resolve(outcome); this.#pump(); }
  #finishError(job: PendingJob, error: unknown): void { this.#remove(job); job.accepted.reject(error); job.outcome.reject(error); this.#pump(); }
  async #interrupt(id: string, reason: 'cancelled' | 'deadline'): Promise<void> {
    const job = this.#jobs.get(id); if (!job) return;
    job.cancelled = true;
    if (!job.running && reason === 'cancelled') { clearTimeout(job.timer); this.#pump(); return; }
    // A blocked JS loop cannot receive cancellation. Stop the owner, then reconcile SQLite.
    await this.#recover({ id, reason });
  }
  #recover(interrupted?: { id: string; reason: 'cancelled' | 'deadline' }): Promise<void> {
    if (this.#recovering) return this.#recovering;
    this.#recovering = (async () => {
      this.#expectedExit = true;
      const child = this.#child;
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), bounded(this.#options.cancel_grace_ms, 100, 0, 10000));
        try { await this.#exit.promise; } finally { clearTimeout(timer); }
      }
      try {
        await this.start('resume', interrupted);
        for (const job of [...this.#jobs.values()]) {
          try {
            const event = await this.#rpc({ kind: 'status', id: newIdentity('job'), job_id: job.id });
            if (event.kind !== 'job') throw failure('worker_failed', 'Invalid recovered job acknowledgement');
            this.#finish(job, { job: event.job });
          } catch (error) { this.#finishError(job, error); }
        }
      } catch (error) {
        for (const job of [...this.#jobs.values()]) this.#finishError(job, error);
        await this.dispose();
      }
    })().finally(() => { this.#recovering = undefined; this.#pump(); });
    return this.#recovering;
  }
  /** Active observations are last acknowledged durable child states, not invented host
   * progress. This remains responsive while the owner is in synchronous analysis. */
  async inspectJob(id: string): Promise<WireJob> {
    if (this.#recovering) await this.#recovering;
    const pending = this.#jobs.get(id);
    if (pending) return structuredClone(pending.latest ?? await pending.accepted.promise);
    const event = await this.#rpc({ kind: 'status', id: newIdentity('job'), job_id: id });
    if (event.kind !== 'job') throw failure('worker_failed', 'Invalid job inspection acknowledgement'); return event.job;
  }
  /** Cancels admitted work through the existing durable lifecycle, never a second queue. */
  async cancelJob(id: string): Promise<WireJob> {
    const pending = this.#jobs.get(id);
    if (pending) { await this.#interrupt(id, 'cancelled'); return (await pending.outcome.promise).job; }
    return this.inspectJob(id);
  }
  /** Artifact identities are resolved only by this project's child/store. Hex output is
   * capped below the IPC frame limit; next_offset permits bounded continuation. */
  async readArtifact(input: ArtifactReadInput): Promise<ArtifactReadResult> {
    const args = artifactReadArgsSchema.parse(input);
    if (this.#closed || this.#closing) throw failure('invalid_input', 'Project is closing');
    if (args.project_id !== this.snapshot.project_id) throw failure('permission_denied', 'Artifact belongs to another project');
    if (this.#recovering) await this.#recovering;
    const event = await this.#rpc({ kind: 'artifact_read', id: newIdentity('job'), args });
    if (event.kind !== 'artifact') throw failure('worker_failed', 'Invalid artifact acknowledgement');
    return event.result;
  }
  async refresh(): Promise<WorkerSnapshot> {
    if (this.#recovering) await this.#recovering;
    const event = await this.#rpc({ kind: 'snapshot', id: newIdentity('job') });
    if (event.kind !== 'opened') throw failure('worker_failed', 'Invalid project snapshot acknowledgement');
    this.#snapshot = event.snapshot; return this.snapshot;
  }
  async close(policy: 'wait' | 'cancel' | 'reject' = 'wait'): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#closed) return this.#disposePromise;
    if (policy === 'reject' && this.busy) throw failure('invalid_input', 'Project has active jobs');
    this.#closing = true;
    this.#closePromise = this.#closeOwned(policy);
    return this.#closePromise;
  }
  async #closeOwned(policy: 'wait' | 'cancel' | 'reject'): Promise<void> {
    if (policy === 'cancel') await Promise.all([...this.#jobs.keys()].map(id => this.#interrupt(id, 'cancelled')));
    await Promise.allSettled([...this.#jobs.values()].map(job => job.outcome.promise));
    if (this.#recovering) await this.#recovering;
    if (this.#closed) return;
    this.#expectedExit = true;
    const timer = setTimeout(() => this.#child?.kill('SIGKILL'), bounded(this.#options.startup_timeout_ms, 30000, 1, 600000));
    try {
      await this.#rpc({ kind: 'close', id: newIdentity('job') });
      await this.#exit.promise;
    } finally { clearTimeout(timer); await this.dispose(); }
  }
  /** Unconditionally releases the OS owner; pending identities are reconciled on next resume. */
  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#closed = true; this.#expectedExit = true;
    this.#disposePromise = (async () => {
      if (this.#child && this.#child.exitCode === null && this.#child.signalCode === null) { this.#child.kill('SIGKILL'); await this.#exit.promise; }
      for (const job of [...this.#jobs.values()]) this.#finishError(job, failure('worker_failed', 'Worker disposed before completion'));
      this.#release();
    })();
    return this.#disposePromise;
  }
}
