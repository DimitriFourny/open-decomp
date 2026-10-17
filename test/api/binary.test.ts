import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BinaryOpenError, FunctionSelectionError, openBinary } from '../../src/api/index.js';
import type { BinarySession, ToolResult } from '../../src/api/index.js';
import { SqliteProjectStore } from '../../src/project/store/index.js';

async function setup(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-api-')));
  const input = join(root, 'app');
  await copyFile(resolve('fixtures/bin/macho-arm64-symbols'), input);
  const sessions: BinarySession[] = [];
  t.after(async () => {
    await Promise.all(sessions.map(session => session.close()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, input, sessions };
}
function emission(result: ToolResult<'function_decompile'>) {
  assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
  return result.data;
}

test('sidecar resumes imports and analysis across owners, while changed bytes cannot return stale analysis', { timeout: 60000 }, async t => {
  const { input, sessions } = await setup(t);
  const original = await readFile(input), times = await stat(input);
  const first = await openBinary(input); sessions.push(first);
  const computed = await first.decompile({ address: { space: 'va', value: '0x100000574' } });
  assert.equal(first.reused, false);
  assert.equal(emission(computed).cache, 'computed');
  const { projectId, projectPath, revision } = first;
  await first.close();
  const second = await openBinary(input); sessions.push(second);
  const hit = await second.decompile({ id: emission(computed).function_id });
  assert.equal(second.reused, true);
  assert.equal(second.projectId, projectId);
  assert.equal(second.revision, revision);
  assert.equal(emission(hit).cache, 'hit');
  assert.equal(emission(hit).emission.text, emission(computed).emission.text);
  assert.deepEqual(hit.artifacts, computed.artifacts);
  const python = await second.decompile({ id: emission(hit).function_id }, { emitter: 'python-like' });
  assert.equal(emission(python).cache, 'computed');
  assert.equal(emission(python).emission.language, 'python-like');
  assert.notEqual(python.artifacts[0]?.id, hit.artifacts[0]?.id);
  await second.close();
  const store = SqliteProjectStore.open(projectPath, 'resume');
  try { assert.equal(store.listJobs({ limit: 1000 }).items.filter(job => job.operation === 'project_open').length, 1); }
  finally { await store.close(); }
  const changed = Buffer.from(original);
  const marker = changed.indexOf('open-decomp trusted fixture v1');
  assert.ok(marker >= 0);
  changed[marker] = 'O'.charCodeAt(0);
  await writeFile(input, changed);
  await utimes(input, times.atime, times.mtime);
  const third = await openBinary(input); sessions.push(third);
  assert.equal(third.reused, false);
  assert.notEqual(third.projectPath, projectPath);
  assert.notEqual(third.image.sha256, second.image.sha256);
  await third.close();
  await writeFile(input, original);
  const restored = await openBinary(input); sessions.push(restored);
  assert.equal(restored.reused, true);
  assert.equal(restored.projectId, projectId);
  assert.equal(emission(await restored.decompile({ id: emission(hit).function_id })).cache, 'hit');
});

test('artifact-backed decompilation returns full semantic state and preserves cache hits at a small delivery budget', { timeout: 60000 }, async t => {
  const { root, input, sessions } = await setup(t);
  const session = await openBinary(input, { cachePath: join(root, 'cache') }); sessions.push(session);
  const selector = { address: { space: 'va' as const, value: '0x100000574' } };
  const computed = await session.decompile(selector, { budget: { output_bytes: 4096 } });
  assert.equal(computed.state, 'complete');
  assert.equal(emission(computed).cache, 'computed');
  assert.ok(Buffer.byteLength(JSON.stringify(computed)) > 4096, 'Exercise real artifact delivery rather than an inline response');
  assert.equal(computed.budget.output_bytes, 4096);
  const hit = await session.decompile(selector, { budget: { output_bytes: 4096 } });
  assert.equal(hit.state, computed.state);
  assert.equal(emission(hit).cache, 'hit');
  assert.deepEqual(emission(hit).emission, emission(computed).emission);
  assert.deepEqual(hit.artifacts, computed.artifacts);
});

test('function selection retains uncertainty under incomplete discovery and closed sessions cannot keep querying', { timeout: 60000 }, async t => {
  const { input, sessions } = await setup(t);
  const session = await openBinary(input); sessions.push(session);
  const selected = await session.decompile({ name: '_fixture_arithmetic' });
  assert.equal(emission(selected).emission.language, 'c-like');
  await assert.rejects(session.decompile({ name: 'no_such_function_in_this_fixture' }), error =>
    error instanceof FunctionSelectionError && error.reason === 'incomplete' && error.candidates.length === 0);
  await session.close();
  await assert.rejects(session.findFunctions(), { code: 'invalid_input' });
});

test('failed imports are retained for inspection and never silently replayed on the next invocation', { timeout: 60000 }, async t => {
  const { input } = await setup(t);
  await writeFile(input, 'not a native image');
  let projectPath = '';
  await assert.rejects(openBinary(input), error => {
    assert.ok(error instanceof BinaryOpenError);
    assert.equal(error.reused, false);
    assert.equal(error.result.state, 'failed');
    projectPath = error.projectPath;
    return true;
  });
  await assert.rejects(openBinary(input), error => {
    assert.ok(error instanceof BinaryOpenError);
    assert.equal(error.reused, true);
    assert.equal(error.result.state, 'partial');
    assert.ok('data' in error.result && error.result.data.image === null);
    return true;
  });
  const store = SqliteProjectStore.open(projectPath, 'resume');
  try {
    const jobs = store.listJobs({ limit: 1000 }).items.filter(job => job.operation === 'project_open');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.state, 'failed');
  } finally { await store.close(); }
});

test('an automatically discovered sidecar cannot redirect project writes through a symlink', async t => {
  const { root, input } = await setup(t);
  const destination = join(root, 'destination');
  await mkdir(destination);
  await symlink(destination, `${input}.open-decomp`, 'dir');
  await assert.rejects(openBinary(input), { code: 'invalid_input' });
  assert.deepEqual(await readdir(destination), []);
});
