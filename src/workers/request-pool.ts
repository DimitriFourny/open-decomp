import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OperationError,
  decodeArtifact,
  decodeDiagnostic,
  decodeJob,
  encodeArtifact,
  encodeJob,
  fingerprint,
  type CacheIdentity,
  type Diagnostic,
  type Job,
  type ProjectStore,
  type WireArtifact,
  type WireDiagnostic,
  type WireJob,
} from '../core/index.js';
import { FrameDecoder, frame, type ExecuteRequest } from './protocol.js';
import type { RequestPublication } from './request-store.js';

/** Owner → request worker. */
export type RequestCommand =
  | {
      readonly kind: 'open';
      /** The owner's project directory (images and artifacts are read from it). */
      readonly project: string;
      /** The immutable database snapshot every worker of this generation shares. */
      readonly database: string;
      /** This worker's private directory: its summary outbox and publication files. */
      readonly outbox: string;
      readonly native_summary_bytes?: number;
    }
  | {
      readonly kind: 'run';
      readonly job: WireJob;
      readonly request: ExecuteRequest;
      readonly deadline: number;
      readonly analysis_cache: boolean;
    }
  | { readonly kind: 'finish' };
/** A publication handed over in files of the worker's outbox (artifacts exceed a frame). */
export interface WirePublication {
  readonly kind: 'artifact' | 'transient';
  readonly artifact: WireArtifact;
  readonly media_type: string;
  /** The artifact bytes. */
  readonly bytes: string;
  /** JSON `{cache, analysis_ids?, reuse_scope?}` of an `artifact` publication. */
  readonly index?: string;
}
/** Request worker → owner. */
export type RequestEvent =
  | { readonly kind: 'progress'; readonly id: string; readonly job: WireJob }
  | {
      readonly kind: 'done';
      readonly id: string;
      readonly result?: unknown;
      /** The job as the request last saved it. */
      readonly job: WireJob;
      readonly publications: readonly WirePublication[];
      readonly error?: WireDiagnostic;
    }
  | { readonly kind: 'finished' };

/** What a request worker made of one job. */
export interface PooledOutcome {
  readonly result?: unknown;
  readonly job: Job | null;
  readonly publications: readonly RequestPublication[];
  readonly error?: Diagnostic;
}

function fail(code: Diagnostic['code'], message: string): never {
  throw new OperationError({ code, severity: 'error', message, evidence_ids: [] });
}

/** Repeat a request worker's publications in the project, in the order it made them: each
 * artifact under the identity the worker's result already carries. A publication the project
 * refuses (the revision moved on, or the job was cancelled) fails the job exactly as the same
 * publication in the owner would have. */
export async function publishPooled(
  store: ProjectStore,
  jobId: string,
  publications: readonly RequestPublication[],
): Promise<void> {
  for (const publication of publications) {
    const artifact =
      publication.kind === 'transient'
        ? store.publishTransientArtifact({
            media_type: publication.media_type,
            bytes: publication.bytes,
            artifact_id: publication.artifact.id,
          })
        : await (async () => {
            const published = await store.publishArtifact({
              job_id: jobId,
              expected_revision: publication.artifact.revision,
              media_type: publication.media_type,
              bytes: publication.bytes,
              cache: publication.cache,
              artifact_id: publication.artifact.id,
              ...(publication.analysis_ids === undefined
                ? {}
                : { analysis_ids: publication.analysis_ids }),
              ...(publication.reuse_scope === undefined
                ? {}
                : { reuse_scope: publication.reuse_scope }),
            });
            if (published.state !== 'published')
              fail(
                published.state === 'cancelled' ? 'cancelled' : 'stale_revision',
                'Analysis publication lost its current job snapshot',
              );
            return published.artifact;
          })();
    if (fingerprint(encodeArtifact(artifact)) !== fingerprint(encodeArtifact(publication.artifact)))
      fail('worker_failed', 'Request worker publication does not match its artifact');
  }
}

const entry = new URL(
  import.meta.url.endsWith('.ts') ? './request-entry.ts' : './request-entry.js',
  import.meta.url,
);

/** One request worker process. */
class RequestWorker {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #runs = new Map<
    string,
    { resolve: (outcome: PooledOutcome) => void; onProgress: (job: Job) => void }
  >();
  #finished: (() => void) | undefined;
  readonly exited: Promise<void>;
  constructor(readonly outbox: string) {
    const path = fileURLToPath(entry);
    this.#child = spawn(
      process.execPath,
      [...(path.endsWith('.ts') ? ['--import', 'tsx'] : []), path],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    this.#child.stderr.resume();
    this.#child.stdin.on('error', () => {});
    const decoder = new FrameDecoder((value) => this.#receive(value as RequestEvent));
    this.#child.stdout.on('data', (chunk: Buffer) => {
      try {
        decoder.push(chunk);
      } catch {
        this.kill();
      }
    });
    this.exited = new Promise((resolve) => this.#child.on('close', () => resolve()));
    void this.exited.then(() => {
      for (const [id, run] of this.#runs) {
        this.#runs.delete(id);
        run.resolve({
          job: null,
          publications: [],
          error: {
            code: 'worker_failed',
            severity: 'error',
            message: 'Request worker exited before its result',
            evidence_ids: [],
          },
        });
      }
      this.#finished?.();
    });
  }

  #receive(event: RequestEvent): void {
    if (event.kind === 'finished') {
      this.#finished?.();
      return;
    }
    const run = this.#runs.get(event.id);
    if (!run) return;
    if (event.kind === 'progress') {
      run.onProgress(decodeJob(event.job));
      return;
    }
    this.#runs.delete(event.id);
    let outcome: PooledOutcome;
    try {
      const publications = event.publications.map((wire): RequestPublication => {
        const artifact = decodeArtifact(wire.artifact),
          bytes = readFileSync(wire.bytes);
        if (wire.kind === 'transient')
          return { kind: 'transient', artifact, media_type: wire.media_type, bytes };
        const index = JSON.parse(readFileSync(wire.index!, 'utf8')) as {
          cache: CacheIdentity;
          analysis_ids?: readonly string[];
          reuse_scope?: string;
        };
        return { kind: 'artifact', artifact, media_type: wire.media_type, bytes, ...index };
      });
      for (const wire of event.publications) {
        rmSync(wire.bytes, { force: true });
        if (wire.index !== undefined) rmSync(wire.index, { force: true });
      }
      outcome = {
        job: decodeJob(event.job),
        publications,
        ...(event.result === undefined ? {} : { result: event.result }),
        ...(event.error === undefined ? {} : { error: decodeDiagnostic(event.error) }),
      };
    } catch (error) {
      outcome = {
        job: null,
        publications: [],
        error: {
          code: 'worker_failed',
          severity: 'error',
          message:
            `Invalid request worker result: ${error instanceof Error ? error.message : String(error)}`.slice(
              0,
              8192,
            ),
          evidence_ids: [],
        },
      };
    }
    run.resolve(outcome);
  }

  send(command: RequestCommand): void {
    this.#child.stdin.write(frame(command));
  }

  run(
    job: Job,
    request: ExecuteRequest,
    deadline: number,
    analysisCache: boolean,
    onProgress: (job: Job) => void,
  ): Promise<PooledOutcome> {
    return new Promise((resolve) => {
      if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
        resolve({
          job: null,
          publications: [],
          error: {
            code: 'worker_failed',
            severity: 'error',
            message: 'Request worker is not running',
            evidence_ids: [],
          },
        });
        return;
      }
      this.#runs.set(job.id, { resolve, onProgress });
      this.send({
        kind: 'run',
        job: encodeJob(job),
        request,
        deadline,
        analysis_cache: analysisCache,
      });
    });
  }

  /** Write its summaries to its outbox and exit. */
  finish(): Promise<void> {
    return new Promise((resolve) => {
      this.#finished = resolve;
      if (this.#child.exitCode !== null || this.#child.signalCode !== null) resolve();
      else this.send({ kind: 'finish' });
    });
  }

  kill(): void {
    this.#child.kill('SIGKILL');
  }
}

/** The workers of one snapshot: a project revision. */
interface Generation {
  readonly revision: number;
  readonly directory: string;
  readonly workers: readonly RequestWorker[];
  readonly idle: RequestWorker[];
  readonly waiting: ((worker: RequestWorker) => void)[];
  retired: boolean;
}

/** The owner's request workers (docs/internals/project-cache.md §4b): N processes that each
 * open the same immutable snapshot of the project's database read-only, analyse the
 * `function_decompile` jobs the owner hands them (one at a time each) and return results,
 * jobs and publications, which the owner, the project's only writer, then publishes. Units
 * they prepare go to their private outboxes and join the project's store when the pool closes.
 * A new project revision starts a new generation over a new snapshot. */
export class RequestPool {
  readonly size: number;
  readonly #options: {
    readonly project: string;
    readonly analysis_cache: boolean;
    readonly native_summary_bytes?: number;
  };
  #generation: Generation | undefined;
  readonly #retired = new Set<Generation>();
  constructor(
    size: number,
    options: {
      readonly project: string;
      readonly analysis_cache: boolean;
      readonly native_summary_bytes?: number;
    },
  ) {
    this.size = size;
    this.#options = options;
  }

  /** Whether a request worker analyses this request. */
  serves(request: ExecuteRequest): boolean {
    return request.operation === 'function_decompile';
  }

  /** Start workers over a snapshot of `store`'s current revision unless they run already.
   * Synchronous: called in the owner's command order. */
  prepare(store: ProjectStore): void {
    const revision = store.snapshot().revision;
    if (this.#generation?.revision === revision) return;
    if (typeof store.snapshotDatabase !== 'function')
      fail('invalid_input', 'The project store cannot be shared with request workers');
    if (this.#generation) this.#retire(this.#generation);
    const directory = mkdtempSync(join(tmpdir(), 'open-decomp-requests-'));
    try {
      const database = join(directory, 'project.sqlite');
      store.snapshotDatabase(database);
      const workers = Array.from({ length: this.size }, (_, index) => {
        const worker = new RequestWorker(join(directory, `w${index}`));
        worker.send({
          kind: 'open',
          project: this.#options.project,
          database,
          outbox: worker.outbox,
          ...(this.#options.native_summary_bytes === undefined
            ? {}
            : { native_summary_bytes: this.#options.native_summary_bytes }),
        });
        return worker;
      });
      this.#generation = {
        revision,
        directory,
        workers,
        idle: [...workers].reverse(),
        waiting: [],
        retired: false,
      };
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  /** Analyse `job` in a worker of the current generation (`prepare` first). */
  async run(
    job: Job,
    request: ExecuteRequest,
    deadline: number,
    onProgress: (job: Job) => void,
  ): Promise<PooledOutcome> {
    const generation = this.#generation;
    if (!generation) fail('invalid_input', 'Request workers are not prepared');
    const worker =
      generation.idle.pop() ??
      (await new Promise<RequestWorker>((resolve) => generation.waiting.push(resolve)));
    try {
      return await worker.run(job, request, deadline, this.#options.analysis_cache, onProgress);
    } finally {
      if (generation.retired) {
        worker.kill();
        this.#sweep(generation);
      } else {
        const next = generation.waiting.shift();
        if (next) next(worker);
        else generation.idle.push(worker);
      }
    }
  }

  /** A generation of an older revision: its idle workers stop now, busy ones after their
   * request; its units are of no later use (their scope names the revision). */
  #retire(generation: Generation): void {
    generation.retired = true;
    this.#retired.add(generation);
    for (const worker of generation.idle.splice(0)) worker.kill();
    this.#sweep(generation);
  }

  #sweep(generation: Generation): void {
    void Promise.all(generation.workers.map((worker) => worker.exited)).then(() => {
      if (!this.#retired.delete(generation)) return;
      rmSync(generation.directory, { recursive: true, force: true });
    });
  }

  /** Stop the workers after writing their outboxes, import the units they prepared into
   * `store` (the owner's project, at its current revision) and remove the snapshot. Called
   * with no job in flight. */
  async close(store: ProjectStore): Promise<void> {
    const generation = this.#generation;
    this.#generation = undefined;
    if (!generation) return;
    try {
      await Promise.all(generation.workers.map((worker) => worker.finish()));
      for (const worker of generation.workers) worker.kill();
      await Promise.all(generation.workers.map((worker) => worker.exited));
      try {
        store.importNativeSummaries?.(
          generation.workers.map((worker) => worker.outbox),
          null,
          [],
        );
      } catch {
        // A cache write never fails the project; the units are prepared again when needed.
      }
    } finally {
      rmSync(generation.directory, { recursive: true, force: true });
    }
  }

  /** Stop every worker now (the owner is stopping). */
  kill(): void {
    const generations = [...this.#retired, ...(this.#generation ? [this.#generation] : [])];
    for (const generation of generations) {
      for (const worker of generation.workers) worker.kill();
      rmSync(generation.directory, { recursive: true, force: true });
    }
    this.#retired.clear();
    this.#generation = undefined;
  }
}
