import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_ANALYSIS_OPTIONS,
  DEFAULT_BUDGET,
  toolSchemas,
  type WireJob,
} from '../../src/core/index.js';
import { SqliteProjectStore } from '../../src/project/store/index.js';
import { ProjectWorkerPool, type WorkerPoolOptions } from '../../src/workers/index.js';
import { resumeWorker, waitForWorkerPause } from './gate.js';

const fixtureRoot = fileURLToPath(new URL('../../fixtures/bin/', import.meta.url));
const macho = join(fixtureRoot, 'macho-arm64-symbols');
const pe = join(fixtureRoot, 'pe-x86_64-symbols.exe');
const importRequest = (source_path: string) => ({
  kind: 'import' as const,
  source_path,
  slice_id: null,
  budget: DEFAULT_BUDGET,
});
const unix = process.platform !== 'win32';
function phaseWait(phase: string) {
  let resolve!: (job: WireJob) => void;
  const promise = new Promise<WireJob>((yes) => {
    resolve = yes;
  });
  return {
    promise,
    onProgress: (job: WireJob) => {
      if (job.progress.phase === phase) resolve(job);
    },
  };
}
async function setup(t: TestContext, options: Partial<WorkerPoolOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-workers-')));
  const pool = await ProjectWorkerPool.create({
    authorized_roots: [root, fixtureRoot],
    max_workers: 2,
    max_queued: 2,
    cancel_grace_ms: 20,
    ...options,
  });
  t.after(async () => {
    await pool.close('cancel');
    await rm(root, { recursive: true, force: true });
  });
  return { root, pool };
}

test(
  'real Mach-O and PE imports run in persistent children and survive close/reopen',
  { timeout: 120000 },
  async (t) => {
    const { root, pool } = await setup(t);
    for (const [index, source] of [macho, pe].entries()) {
      const path = join(root, `project-${index}`);
      const project = await pool.open({ path, mode: 'create' });
      const pid = project.pid;
      assert.notEqual(pid, process.pid);
      const ticket = await project.submit(importRequest(source));
      const admitted = await ticket.accepted;
      assert.equal(admitted.state, 'queued');
      assert.equal(admitted.input_revision, 0);
      const result = await ticket.result;
      assert.equal(result.job.state, 'completed');
      assert.equal(project.pid, pid);
      assert.equal(project.snapshot.images.length, 1);
      assert.equal(project.snapshot.images[0]?.state, 'loaded');
      assert.equal(project.snapshot.revision, 2);
      const snapshot = project.snapshot;
      assert.equal((await ticket.cancel()).job.state, 'completed');
      await project.close('reject');
      const resumed = await pool.open({ path, mode: 'resume' });
      assert.deepEqual(resumed.snapshot, snapshot);
      assert.deepEqual(await resumed.inspectJob(ticket.id), result.job);
      await resumed.close();
    }
  },
);

test(
  'canonical authorization, worker capacity and exclusive ownership reject conflicting callers',
  { timeout: 120000 },
  async (t) => {
    const { root, pool } = await setup(t, { max_workers: 1 });
    await assert.rejects(
      pool.open({ path: join(root, '..', 'unauthorized-project'), mode: 'create' }),
      { code: 'permission_denied' },
    );
    const project = await pool.open({ path: join(root, 'project'), mode: 'create' });
    await assert.rejects(pool.open({ path: join(root, 'second'), mode: 'create' }), {
      code: 'resource_limit',
    });
    const competing = await ProjectWorkerPool.create({ authorized_roots: [root], max_workers: 1 });
    t.after(() => competing.close('cancel'));
    await assert.rejects(competing.open({ path: project.path, mode: 'resume' }));
    await assert.rejects(
      project.submit(importRequest(fileURLToPath(new URL('../../package.json', import.meta.url)))),
      { code: 'permission_denied' },
    );
    if (unix) {
      const link = join(root, 'outside');
      await symlink(join(root, '..'), link);
      await assert.rejects(pool.authorize(join(link, 'outside-project'), true), {
        code: 'permission_denied',
      });
    }
    await project.close();
  },
);

test(
  'forced process death after image snapshot preserves explicit incomplete metadata and never retries',
  { timeout: 30000 },
  async (t) => {
    const { root, pool } = await setup(t, {
      entry_point: new URL('./pause-snapshot.ts', import.meta.url),
    });
    const project = await pool.open({ path: join(root, 'project'), mode: 'create' });
    const boundary = phaseWait('image_snapshot');
    const ticket = await project.submit(importRequest(macho), boundary);
    await boundary.promise;
    await waitForWorkerPause(ticket.id, t);
    const originalPid = project.pid!;
    process.kill(originalPid, 'SIGKILL');
    const result = await ticket.result;
    assert.equal(result.job.state, 'failed');
    assert.equal(result.job.diagnostics[0]?.code, 'worker_failed');
    assert.notEqual(project.pid, originalPid);
    assert.equal(project.snapshot.revision, 1);
    assert.equal(project.snapshot.images[0]?.state, 'snapshot_without_metadata');
    assert.equal((await project.inspectJob(ticket.id)).state, 'failed');
    const path = project.path;
    await project.close();
    const normal = await ProjectWorkerPool.create({ authorized_roots: [root, fixtureRoot] });
    t.after(() => normal.close('cancel'));
    const resumed = await normal.open({ path, mode: 'resume' });
    assert.equal(resumed.snapshot.images[0]?.state, 'snapshot_without_metadata');
    // Only this explicit caller action completes the interrupted import.
    const retry = await resumed.submit(importRequest(macho));
    assert.equal((await retry.result).job.state, 'completed');
    assert.equal(resumed.snapshot.revision, 2);
    assert.equal(resumed.snapshot.images[0]?.state, 'loaded');
    await resumed.close();
  },
);

test(
  'cancellation before publication terminates an unresponsive child and is durable',
  { timeout: 30000 },
  async (t) => {
    const { root, pool } = await setup(t, {
      entry_point: new URL('./pause-running.ts', import.meta.url),
    });
    const project = await pool.open({ path: join(root, 'project'), mode: 'create' });
    const boundary = phaseWait('running');
    const ticket = await project.submit(importRequest(pe), boundary);
    await boundary.promise;
    await waitForWorkerPause(ticket.id, t);
    const pid = project.pid;
    const result = await ticket.cancel();
    assert.equal(result.job.state, 'cancelled');
    assert.notEqual(project.pid, pid);
    assert.equal(project.snapshot.revision, 0);
    assert.deepEqual(project.snapshot.images, []);
    assert.equal((await project.inspectJob(ticket.id)).state, 'cancelled');
  },
);

test(
  'durable publication wins cancellation even when the final response is lost',
  { timeout: 30000 },
  async (t) => {
    const { root, pool } = await setup(t, {
      entry_point: new URL('./pause-published.ts', import.meta.url),
    });
    const project = await pool.open({ path: join(root, 'project'), mode: 'create' });
    const boundary = phaseWait('complete');
    const ticket = await project.submit(importRequest(pe), boundary);
    await boundary.promise;
    await waitForWorkerPause(ticket.id, t);
    const result = await ticket.cancel();
    assert.equal(result.job.state, 'completed');
    assert.equal((await project.inspectJob(ticket.id)).state, 'completed');
    assert.equal(project.snapshot.revision, 2);
    assert.equal(project.snapshot.images[0]?.state, 'loaded');
  },
);

test(
  'bounded queued admission, queued cancellation and shutdown reject operate on real imports',
  { timeout: 30000 },
  async (t) => {
    const { root, pool } = await setup(t, {
      max_queued: 1,
      entry_point: new URL('./pause-running.ts', import.meta.url),
    });
    const project = await pool.open({ path: join(root, 'project'), mode: 'create' });
    const boundary = phaseWait('running');
    const first = await project.submit(importRequest(macho), boundary);
    await boundary.promise;
    await waitForWorkerPause(first.id, t);
    const queued = await project.submit(importRequest(pe));
    const cancelled = queued.cancel();
    await assert.rejects(project.submit(importRequest(pe)), { code: 'resource_limit' });
    await assert.rejects(project.close('reject'), { code: 'invalid_input' });
    await resumeWorker(first.id);
    assert.equal((await first.result).job.state, 'completed');
    assert.equal((await cancelled).job.state, 'cancelled');
    assert.equal((await queued.accepted).state, 'queued');
    assert.equal(project.snapshot.images.length, 1);
    await project.close('wait');
  },
);

test(
  'host heartbeat continues while a blocked child hits its enforced deadline',
  { timeout: 30000 },
  async (t) => {
    const { root, pool } = await setup(t, {
      entry_point: new URL('./pause-running.ts', import.meta.url),
    });
    const project = await pool.open({ path: join(root, 'project'), mode: 'create' });
    let heartbeats = 0;
    // Real-platform deadline/host-responsiveness integration: a fake clock cannot stop or reap this child.
    const heartbeat = setInterval(() => {
      heartbeats++;
    }, 5);
    try {
      const ticket = await project.submit({
        ...importRequest(macho),
        budget: { ...DEFAULT_BUDGET, deadline_ms: 200 },
      });
      await waitForWorkerPause(ticket.id, t);
      const result = await ticket.result;
      assert.equal(result.job.state, 'failed');
      assert.equal(result.job.diagnostics[0]?.code, 'resource_limit');
      assert.ok(heartbeats >= 2);
      assert.equal(project.snapshot.revision, 0);
    } finally {
      clearInterval(heartbeat);
    }
  },
);

test(
  'pre-aborted submissions and actual loader work budgets do not publish images',
  { timeout: 30000 },
  async (t) => {
    const { root, pool } = await setup(t);
    const project = await pool.open({ path: join(root, 'project'), mode: 'create' });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(project.submit(importRequest(macho), { signal: controller.signal }), {
      code: 'cancelled',
    });
    const ticket = await project.submit({
      ...importRequest(macho),
      budget: { ...DEFAULT_BUDGET, work: 1 },
    });
    const result = await ticket.result;
    assert.equal(result.job.state, 'failed');
    assert.equal(result.job.diagnostics[0]?.code, 'resource_limit');
    assert.equal(project.snapshot.revision, 0);
  },
);

test(
  'forced owner death releases SQLite locks and durable completed jobs on every host',
  { timeout: 120000 },
  async (t) => {
    const { root, pool } = await setup(t);
    const path = join(root, 'project');
    const project = await pool.open({ path, mode: 'create' });
    const ticket = await project.submit(importRequest(pe));
    assert.equal((await ticket.result).job.state, 'completed');
    const snapshot = project.snapshot;
    // dispose uses SIGKILL, not graceful project_close; it awaits the actual process exit.
    await project.dispose();
    const resumed = await pool.open({ path, mode: 'resume' });
    assert.deepEqual(resumed.snapshot, snapshot);
    assert.equal((await resumed.inspectJob(ticket.id)).state, 'completed');
    await resumed.close();
  },
);

test(
  'cancel shutdown reaps a blocked owner and preserves the terminal job on resume',
  { timeout: 30000 },
  async (t) => {
    const { root, pool } = await setup(t, {
      entry_point: new URL('./pause-running.ts', import.meta.url),
    });
    const path = join(root, 'project');
    const project = await pool.open({ path, mode: 'create' });
    const boundary = phaseWait('running');
    const ticket = await project.submit(importRequest(pe), boundary);
    await boundary.promise;
    await waitForWorkerPause(ticket.id, t);
    await project.close('cancel');
    assert.equal((await ticket.result).job.state, 'cancelled');
    const resumed = await pool.open({ path, mode: 'resume' });
    assert.equal((await resumed.inspectJob(ticket.id)).state, 'cancelled');
    assert.equal(resumed.snapshot.revision, 0);
    await resumed.close();
  },
);

test(
  'default static query handler returns real loaded image facts',
  { timeout: 30000 },
  async (t) => {
    const { root, pool } = await setup(t);
    const project = await pool.open({ path: join(root, 'project'), mode: 'create' });
    const imported = await project.submit(importRequest(pe));
    assert.equal((await imported.result).job.state, 'completed');
    const image = project.snapshot.images[0];
    assert.ok(image);
    const ticket = await project.submit({
      kind: 'execute',
      operation: 'binary_info',
      budget: DEFAULT_BUDGET,
      args: {
        project_id: project.snapshot.project_id,
        revision: project.snapshot.revision,
        image_id: image.image_id,
        view: 'summary',
        page: { limit: 100 },
        budget: DEFAULT_BUDGET,
      },
    });
    const outcome = await ticket.result;
    assert.equal(outcome.job.input_revision, 2);
    assert.equal(outcome.job.state, 'completed');
    const result = toolSchemas.binary_info.output.parse(outcome.result);
    assert.equal(result.state, 'complete');
    if (!('data' in result) || result.data.view !== 'summary')
      assert.fail('Expected a real image summary');
    assert.equal(result.data.image.id, image.image_id);
    assert.equal(result.data.image.target.format, 'pe');
    await Promise.all([project.close(), project.close()]);
  },
);

test(
  'a failed owner close waits for every other owner and admitted job before rejecting',
  { timeout: 120000 },
  async (t) => {
    const { root, pool } = await setup(t, {
      max_queued: 0,
      entry_point: new URL('./pause-running.ts', import.meta.url),
    });
    const first = await pool.open({ path: join(root, 'first'), mode: 'create' });
    const second = await pool.open({ path: join(root, 'second'), mode: 'create' });
    const ticket = await second.submit(importRequest(macho));
    await ticket.accepted;
    await waitForWorkerPause(ticket.id, t);
    // Occupy the idle owner's control channel before its close command is admitted.
    const controls = Array.from({ length: 4 }, () => first.refresh().catch(() => {}));
    // Release the blocked owner on the other owner's actual failure, not a guessed delay.
    const release = first.close('wait').catch(() => resumeWorker(ticket.id));
    await assert.rejects(pool.close('wait'), { code: 'resource_limit' });
    assert.equal(second.busy, false);
    assert.throws(() => process.kill(second.pid!, 0), { code: 'ESRCH' });
    assert.equal((await ticket.result).job.state, 'completed');
    await release;
    await Promise.all(controls);
  },
);

test(
  'a worker killed after acknowledged decompiles keeps their jobs and artifacts, and writes callee summaries while idle',
  { timeout: 300000, skip: !unix },
  async (t) => {
    const { root, pool } = await setup(t, { max_workers: 1 });
    const path = join(root, 'project');
    const project = await pool.open({ path, mode: 'create' });
    const imported = await project.submit(
      importRequest(join(fixtureRoot, 'libcorpus-arm64-symbols.dylib')),
    );
    assert.equal((await imported.result).job.state, 'completed');
    const image = project.snapshot.images[0]!;
    const context = {
      project_id: project.snapshot.project_id,
      revision: project.snapshot.revision,
      budget: DEFAULT_BUDGET,
    };
    const listing = await (
      await project.submit({
        kind: 'execute',
        operation: 'functions_find',
        budget: DEFAULT_BUDGET,
        args: toolSchemas.functions_find.input.parse({
          ...context,
          image_id: image.image_id,
          page: { limit: 100 },
        }),
      })
    ).result;
    const found = toolSchemas.functions_find.output.parse(listing.result);
    assert.ok('data' in found);
    const ids = found.data.items.map((item) => item.id).slice(0, 40);
    assert.ok(ids.length >= 10);
    const acknowledged: string[] = [];
    for (const id of ids) {
      const ticket = await project.submit({
        kind: 'execute',
        operation: 'function_decompile',
        budget: DEFAULT_BUDGET,
        args: toolSchemas.function_decompile.input.parse({
          ...context,
          function_id: id,
          wait: true,
          options: DEFAULT_ANALYSIS_OPTIONS,
        }),
      });
      const outcome = await ticket.result;
      assert.equal(outcome.job.state, 'completed');
      acknowledged.push(ticket.id);
    }
    // No command is waiting: the worker writes its queued callee summaries in idle slices.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    process.kill(project.pid!, 'SIGKILL');
    await project.close().catch(() => {});
    const store = SqliteProjectStore.open(path, 'resume');
    for (const id of acknowledged) {
      const job = store.readJob(id);
      assert.equal(job?.state, 'completed', id);
      assert.equal(job.artifacts.length, 1);
      assert.ok(store.readArtifactBytes(job.artifacts[0]!).length > 0);
    }
    await store.close();
    const db = new DatabaseSync(join(path, 'project.sqlite'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT count(*) AS n FROM native_summaries').get() as { n: number };
      assert.ok(rows.n > 0, 'no callee summary was written while the worker was idle');
      assert.deepEqual(
        { ...db.prepare('PRAGMA integrity_check').get() },
        { integrity_check: 'ok' },
      );
    } finally {
      db.close();
    }
  },
);
