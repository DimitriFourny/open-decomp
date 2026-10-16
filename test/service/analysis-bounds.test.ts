import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Budget, type ResultEnvelope, type ToolResult } from '../../src/core/index.js';
import { QueryService } from '../../src/service/queries/index.js';
import { SqliteProjectStore } from '../../src/project/store/index.js';

function data<T>(result: ResultEnvelope<T>): T {
  assert.ok('data' in result, JSON.stringify(result));
  return result.data;
}

for (const fixture of [
  { name: 'macho-arm64-symbols', address: '0x100000574' },
  { name: 'corpus-symbols.dll', address: '0x180001030' },
]) test(`${fixture.name}: terminal budget errors publish no artifacts and preserve normal semantic analysis after reopen`, { timeout: 120000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-analysis-bounds-'))), fixtures = resolve('fixtures/bin');
  const service = await QueryService.create({ authorized_roots: [root, fixtures], max_workers: 1 });
  t.after(async () => { await service.close('cancel'); await rm(root, { recursive: true, force: true }); });
  const project_path = join(root, 'project');
  const opened = await service.execute('project_open', { wait: true, source: { kind: 'import', input_path: join(fixtures, fixture.name), project_path } });
  assert.equal(opened.state, 'complete');
  const image = data(opened).image; assert.ok(image);
  const scope = { project_id: opened.project_id!, revision: opened.revision! };
  const functions = data(await service.execute('functions_find', { ...scope, image_id: image.id, address: { image_id: image.id, space: 'va', value: fixture.address } }));
  const fn = functions.items.find(item => item.entry.value === fixture.address); assert.ok(fn);
  const disassembly = data(await service.execute('function_get', { ...scope, function_id: fn.id, view: 'disassembly' }));
  assert.equal(disassembly.view, 'disassembly');
  if (disassembly.view !== 'disassembly') assert.fail('Expected instruction provenance');
  const budgets: Partial<Budget>[] = [{ instructions: 1 }, { ir_nodes: 1 }, { work: 1 }];
  for (const budget of budgets) for (let attempt = 0; attempt < 2; attempt++) {
    const result: ToolResult<'function_decompile'> = await service.execute('function_decompile', { ...scope, function_id: fn.id, wait: true, budget });
    assert.equal(result.state, 'failed', JSON.stringify(result));
    if (result.state !== 'failed') assert.fail('Resource exhaustion cannot publish partial semantic success');
    assert.equal(result.error.code, 'resource_limit');
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.revision, scope.revision);
    assert.equal('data' in result, false);
  }
  data(await service.execute('project_close', scope));
  const store = SqliteProjectStore.open(project_path, 'resume');
  try {
    assert.equal(store.snapshot().revision, scope.revision);
    const jobs = store.listJobs({ limit: 100 }).items.filter(job => job.operation === 'function_decompile');
    assert.equal(jobs.length, budgets.length * 2, 'Every rejected request remains inspectable as a durable job');
    for (const job of jobs) {
      assert.equal(job.state, 'failed'); assert.equal(job.published_revision, null); assert.deepEqual(job.artifacts, []);
      assert.ok(job.diagnostics.some(diagnostic => diagnostic.code === 'resource_limit'));
    }
  } finally { await store.close(); }
  const resumed = await service.execute('project_open', { source: { kind: 'resume', project_path } });
  assert.equal(resumed.state, 'complete'); assert.equal(resumed.revision, scope.revision);
  const normal = await service.execute('function_decompile', { ...scope, function_id: fn.id, wait: true });
  assert.equal(normal.state, 'complete', JSON.stringify(normal));
  const payload = data(normal);
  assert.equal(payload.delivery, 'inline');
  if (payload.delivery !== 'inline') assert.fail('The ordinary arithmetic fixture must retain inline semantics');
  assert.equal(payload.cache, 'computed', 'Failed bounded requests never become successful cache entries');
  for (const instruction of disassembly.items) assert.ok(payload.emission.mappings.some(mapping => mapping.instruction_ids.includes(instruction.id)));
  const cached = await service.execute('function_decompile', { ...scope, function_id: fn.id, wait: true });
  assert.equal(cached.state, 'complete'); assert.equal(data(cached).cache, 'hit'); assert.deepEqual(cached.artifacts, normal.artifacts);
  data(await service.execute('project_close', scope));
});
