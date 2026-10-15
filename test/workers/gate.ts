import { existsSync, mkdirSync, watch } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

function gatePath(jobId: string): string { return join(tmpdir(), `open-decomp-worker-gate-${jobId}`); }

/** Block the real child event loop at an acknowledged durable boundary on both hosts.
 * The unpredictable job ID names a private test-only gate, never a target-selected path. */
export function pauseWorker(jobId: string): void {
  const path = gatePath(jobId);
  mkdirSync(path, { mode: 0o700 });
  const cell = new Int32Array(new SharedArrayBuffer(4)), deadline = Date.now() + 60_000;
  while (existsSync(path)) {
    if (Date.now() >= deadline) throw new Error('Worker test gate was not released');
    Atomics.wait(cell, 0, 0, 20);
  }
}

/** Observe entry rather than racing a release against a pending pause. */
export async function waitForWorkerPause(jobId: string, test: TestContext): Promise<void> {
  const path = gatePath(jobId);
  test.after(() => rm(path, { recursive: true, force: true }));
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(tmpdir(), () => { if (existsSync(path)) finish(); });
    const timer = setTimeout(() => finish(new Error('Worker did not enter its test gate')), 10_000);
    const finish = (error?: Error): void => {
      watcher.close(); clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    watcher.on('error', finish);
    if (existsSync(path)) finish();
  });
}

export async function resumeWorker(jobId: string): Promise<void> {
  await rm(gatePath(jobId), { recursive: true });
}
