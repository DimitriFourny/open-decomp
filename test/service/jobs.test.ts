import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { cp, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { toolSchemas, validateToolResponse, type ResultEnvelope } from '../../src/core/index.js';
import { SqliteProjectStore } from '../../src/project/store/index.js';
import { QueryService } from '../../src/service/queries/index.js';
import type { WorkerPoolOptions } from '../../src/workers/index.js';
import { waitForWorkerPause } from '../workers/gate.js';

const fixtures = resolve('fixtures/bin');
function data<T>(result: ResultEnvelope<T>): T {
  assert.ok('data' in result, JSON.stringify(result));
  return result.data;
}
async function setup(t: TestContext, options: Partial<WorkerPoolOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-jobs-')));
  const service = await QueryService.create({ authorized_roots: [root, fixtures], cancel_grace_ms: 10, ...options });
  t.after(async () => { await service.close('cancel'); await rm(root, { recursive: true, force: true }); });
  return { root, service };
}

test('async import cancellation reconciles close revision, inspection-only resume and explicit matching repair', { timeout: 120000 }, async t => {
  const { root, service } = await setup(t, { entry_point: new URL('./pause-import.ts', import.meta.url) });
  const project_path = join(root, 'project'), input_path = join(fixtures, 'macho-arm64-symbols');
  const admitted = await service.execute('project_open', { source: { kind: 'import', input_path, project_path } });
  assert.ok(admitted.state === 'queued');
  assert.equal(admitted.revision, 0); assert.equal(admitted.job.input_revision, 0);
  assert.equal(admitted.versions.analysis, null);
  await waitForWorkerPause(admitted.job.id, t);
  const initial = data(await service.execute('analysis_status', { project_id: admitted.job.project_id, revision: 0, job_id: admitted.job.id }));
  assert.ok(['queued', 'running'].includes(initial.job.state)); assert.equal(initial.known_revision, 0);
  const closeArgs = toolSchemas.project_close.input.parse({ project_id: admitted.job.project_id, revision: 0, running_jobs: 'cancel' });
  const closed = await service.execute('project_close', closeArgs);
  validateToolResponse('project_close', closed, closeArgs);
  assert.equal(data(closed).persisted_revision, 1); assert.equal(closed.revision, 1);
  const incomplete = await service.execute('project_open', { source: { kind: 'resume', project_path } });
  assert.ok(incomplete.state === 'partial'); assert.equal(incomplete.reason, 'incomplete_index');
  assert.equal(incomplete.data.image, null); assert.equal(incomplete.project_id, admitted.project_id); assert.equal(incomplete.revision, 1);
  const scope = { project_id: admitted.job.project_id, revision: 1 };
  const interrupted = data(await service.execute('analysis_status', { ...scope, job_id: admitted.job.id }));
  assert.equal(interrupted.job.state, 'failed'); assert.equal(interrupted.known_revision, 1);
  assert.equal(interrupted.job.published_revision, null); assert.deepEqual(interrupted.job.artifacts, []);
  const absent = await service.execute('binary_info', scope);
  assert.ok(absent.state === 'failed'); assert.equal(absent.error.code, 'not_found');
  assert.equal(data(await service.execute('project_close', scope)).persisted_revision, 1);
  await service.close();

  const repair = await QueryService.create({ authorized_roots: [root, fixtures] });
  t.after(() => repair.close('cancel'));
  const wrong = await repair.execute('project_open', { wait: true, source: { kind: 'import', mode: 'resume', input_path: join(fixtures, 'corpus-symbols.dll'), project_path } });
  assert.ok(wrong.state === 'failed'); assert.equal(wrong.error.code, 'invalid_input');
  const unchanged = await repair.execute('project_open', { source: { kind: 'resume', project_path } });
  assert.equal(unchanged.state, 'partial'); assert.equal(unchanged.revision, 1);
  data(await repair.execute('project_close', scope));
  const repaired = await repair.execute('project_open', { wait: true, source: { kind: 'import', mode: 'resume', input_path, project_path } });
  assert.equal(repaired.state, 'complete'); assert.equal(repaired.revision, 2); assert.equal(repaired.project_id, scope.project_id);
  const ready = data(repaired); assert.ok(ready.image); assert.equal(ready.resumed, true);
  const summary = data(await repair.execute('binary_info', { ...scope, revision: 2 }));
  assert.ok(summary.view === 'summary'); assert.equal(summary.image.id, ready.image.id);
  data(await repair.execute('project_close', { ...scope, revision: 2 }));
  const replacement = await repair.execute('project_open', { wait: true, source: { kind: 'import', mode: 'resume', input_path, project_path } });
  assert.ok(replacement.state === 'failed'); assert.equal(replacement.error.code, 'invalid_input');
  const persisted = await repair.execute('project_open', { source: { kind: 'resume', project_path } });
  assert.equal(persisted.revision, 2); assert.equal(data(persisted).image?.id, ready.image.id);
  await repair.close('cancel');
});

test('minimum-output async admissions remain inspectable and cancellable after their request exchange ends', { timeout: 120000 }, async t => {
  const { root, service } = await setup(t, { entry_point: new URL('./pause-analysis.ts', import.meta.url) });
  const project_path = join(root, 'project'), source = { kind: 'import' as const, input_path: join(fixtures, 'corpus-symbols.dll'), project_path };
  const opened = await service.execute('project_open', { source, wait: true });
  const image = data(opened).image; assert.ok(image);
  const scope = { project_id: opened.project_id!, revision: opened.revision! };
  const fn = data(await service.execute('functions_find', { ...scope, image_id: image.id })).items[0]; assert.ok(fn);
  const request = new AbortController();
  const admitted = await service.execute('function_decompile', { ...scope, function_id: fn.id, options: { include_evidence: false }, budget: { output_bytes: 1024 } }, { signal: request.signal });
  assert.ok(admitted.state === 'queued'); assert.equal(admitted.options.include_evidence, false);
  assert.ok(Buffer.byteLength(JSON.stringify(admitted)) <= 1024);
  await waitForWorkerPause(admitted.job.id, t);
  request.abort(new Error('The successful request exchange ended; the project still owns its job'));
  const running = data(await service.execute('analysis_status', { ...scope, job_id: admitted.job.id }));
  assert.ok(['queued', 'running'].includes(running.job.state)); assert.equal(running.known_revision, scope.revision);
  const cancelled = data(await service.execute('analysis_cancel', { ...scope, job_id: admitted.job.id }));
  assert.equal(cancelled.job.state, 'cancelled'); assert.equal(cancelled.outcome, 'cancelled'); assert.deepEqual(cancelled.job.artifacts, []);
  data(await service.execute('project_close', scope));
  const store = SqliteProjectStore.open(project_path, 'resume');
  try {
    const analyses = store.listJobs({ limit: 100 }).items.filter(job => job.operation === 'function_decompile');
    assert.deepEqual(analyses.map(job => ({ id: job.id, state: job.state })), [{ id: admitted.job.id, state: 'cancelled' }]);
    assert.equal(store.snapshot().revision, scope.revision);
  } finally { await store.close(); }
});

test('copied project identities cannot replace an open owner or erase its routing on rejection', { timeout: 120000 }, async t => {
  const { root, service } = await setup(t);
  const project_path = join(root, 'original'), copied = join(root, 'copied');
  const opened = await service.execute('project_open', { wait: true, source: { kind: 'import', input_path: join(fixtures, 'corpus-symbols.dll'), project_path } });
  const image = data(opened).image; assert.ok(image);
  const scope = { project_id: opened.project_id!, revision: opened.revision! };
  data(await service.execute('project_close', scope));
  await cp(project_path, copied, { recursive: true });
  data(await service.execute('project_open', { source: { kind: 'resume', project_path } }));
  const duplicate = await service.execute('project_open', { source: { kind: 'resume', project_path: copied } });
  assert.ok(duplicate.state === 'failed'); assert.equal(duplicate.error.code, 'invalid_input');
  const original = data(await service.execute('binary_info', scope));
  assert.ok(original.view === 'summary'); assert.equal(original.image.id, image.id);
  data(await service.execute('project_close', scope));
  const copy = await service.execute('project_open', { source: { kind: 'resume', project_path: copied } });
  assert.equal(copy.project_id, scope.project_id); assert.equal(copy.revision, scope.revision);
});
