import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeJob,
  encodeArtifact,
  encodeDiagnostic,
  encodeJob,
  type Diagnostic,
  type Job,
} from '../core/index.js';
import { SqliteProjectStore } from '../project/store/index.js';
import { FrameDecoder, MAX_FRAME_BYTES, frame } from './protocol.js';
import type { RequestCommand, RequestEvent, WirePublication } from './request-pool.js';
import { RequestStore } from './request-store.js';
import {
  executeRequest,
  requestContext,
  throttled,
  workerDiagnostic,
  type WorkerHandler,
} from './runtime.js';

const terminal = (job: Job): boolean => !['queued', 'running'].includes(job.state);

/** A request worker process (docs/internals/project-cache.md §4b): opens the owner's project
 * snapshot read-only and runs the jobs it is handed exactly as the owner would
 * (`executeRequest`), one at a time; the owner publishes what it returns. */
export function runRequestWorker(handler: WorkerHandler): void {
  let store: SqliteProjectStore | undefined;
  let openError: Diagnostic | undefined;
  let publications = '';
  let chain = Promise.resolve();
  const send = (event: RequestEvent): Promise<void> =>
    new Promise((resolve, reject) =>
      process.stdout.write(frame(event, MAX_FRAME_BYTES), (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  const handle = async (command: RequestCommand): Promise<void> => {
    if (command.kind === 'open') {
      try {
        store = SqliteProjectStore.openSnapshot(command.project, command.database, {
          outbox: command.outbox,
          ...(command.native_summary_bytes === undefined
            ? {}
            : { native_summary_bytes: command.native_summary_bytes }),
        });
        publications = join(command.outbox, 'publications');
        mkdirSync(publications, { recursive: true, mode: 0o700 });
        // Decode the image now, while the owner is still opening, not in the first request.
        for (const image of store.snapshot().images)
          store.readLoadedImage(image.image_id, image.selected_slice_id);
      } catch (error) {
        openError = workerDiagnostic(error);
      }
      return;
    }
    if (command.kind === 'finish') {
      try {
        await store?.close();
      } finally {
        store = undefined;
        await send({ kind: 'finished' });
      }
      return;
    }
    const job = decodeJob(command.job);
    if (!store) {
      await send({
        kind: 'done',
        id: job.id,
        job: command.job,
        publications: [],
        error: encodeDiagnostic(
          openError ?? {
            code: 'worker_failed',
            severity: 'error',
            message: 'Request worker has no project snapshot',
            evidence_ids: [],
          },
        ),
      });
      return;
    }
    const overlay = new RequestStore(store, job);
    const context = requestContext(
      command.request.budget,
      command.deadline,
      throttled((phase, completed, total) => {
        if (process.stdout.writableLength === 0)
          process.stdout.write(
            frame({
              kind: 'progress',
              id: job.id,
              job: encodeJob({ ...overlay.job, progress: { phase, completed, total } }),
            } satisfies RequestEvent),
          );
      }),
    );
    let result: unknown, error: Diagnostic | undefined;
    try {
      context.checkpoint(0);
      result = await executeRequest(handler, command.request, {
        store: overlay,
        context,
        job_id: job.id,
        analysis_cache: command.analysis_cache,
      });
      if (!terminal(overlay.job)) context.checkpoint(0);
    } catch (failure) {
      result = undefined;
      error = workerDiagnostic(failure);
    }
    // Publications precede a later failure, as they would in the owner.
    const wire = overlay.publications.map((publication): WirePublication => {
      const bytes = join(publications, `${publication.artifact.id}.bin`);
      writeFileSync(bytes, publication.bytes, { mode: 0o600 });
      if (publication.kind === 'transient')
        return {
          kind: 'transient',
          artifact: encodeArtifact(publication.artifact),
          media_type: publication.media_type,
          bytes,
        };
      const index = join(publications, `${publication.artifact.id}.json`);
      writeFileSync(
        index,
        JSON.stringify({
          cache: publication.cache,
          ...(publication.analysis_ids === undefined
            ? {}
            : { analysis_ids: publication.analysis_ids }),
          ...(publication.reuse_scope === undefined
            ? {}
            : { reuse_scope: publication.reuse_scope }),
        }),
        { mode: 0o600 },
      );
      return {
        kind: 'artifact',
        artifact: encodeArtifact(publication.artifact),
        media_type: publication.media_type,
        bytes,
        index,
      };
    });
    await send({
      kind: 'done',
      id: job.id,
      job: encodeJob(overlay.job),
      publications: wire,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error: encodeDiagnostic(error) }),
    });
  };
  const decoder = new FrameDecoder((value) => {
    chain = chain
      .then(() => handle(value as RequestCommand))
      .catch(() => {
        process.exit(1);
      });
  });
  process.stdin.on('data', (chunk: Buffer) => {
    try {
      decoder.push(chunk);
    } catch {
      process.exit(1);
    }
  });
  // The owner is gone: nothing could publish this worker's results.
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(1));
}
