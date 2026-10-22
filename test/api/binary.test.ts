import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BinaryOpenError, FunctionSelectionError, openBinary } from '../../src/api/index.js';
import type { BinarySession, ToolResult } from '../../src/api/index.js';
import { manyFunctions } from '../cli/many-functions.js';
import { SqliteProjectStore } from '../../src/project/store/index.js';

async function setup(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-api-')));
  const input = join(root, 'app');
  await copyFile(resolve('fixtures/bin/macho-arm64-symbols'), input);
  const sessions: BinarySession[] = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, input, sessions };
}
function emission(result: ToolResult<'function_decompile'>) {
  assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
  return result.data;
}

test(
  'openBinary({ analysisCache: false }) recomputes every decompilation and persists no derived analysis',
  { timeout: 60000 },
  async (t) => {
    const { input, sessions } = await setup(t);
    const session = await openBinary(input, { analysisCache: false });
    sessions.push(session);
    const selector = { address: { space: 'va', value: '0x100000574' } } as const;
    const first = await session.decompile(selector);
    const second = await session.decompile(selector);
    assert.equal(emission(first).cache, 'computed');
    assert.equal(emission(second).cache, 'computed');
    assert.equal(emission(second).emission.text, emission(first).emission.text);
    const { projectPath } = session;
    await session.close();
    // A cached session on the same project computes (nothing was published), then hits.
    const cached = await openBinary(input);
    sessions.push(cached);
    const computed = await cached.decompile(selector);
    assert.equal(emission(computed).cache, 'computed');
    assert.equal(emission(computed).emission.text, emission(first).emission.text);
    assert.equal(emission(await cached.decompile(selector)).cache, 'hit');
    await cached.close();
    const store = SqliteProjectStore.open(projectPath, 'resume');
    try {
      assert.equal(
        store.listJobs({ limit: 1000 }).items.filter((job) => job.artifacts.length > 0).length,
        2,
      );
    } finally {
      await store.close();
    }
  },
);

test(
  'sidecar resumes imports and analysis across owners, while changed bytes cannot return stale analysis',
  { timeout: 60000 },
  async (t) => {
    const { input, sessions } = await setup(t);
    const original = await readFile(input),
      times = await stat(input);
    const first = await openBinary(input);
    sessions.push(first);
    const computed = await first.decompile({ address: { space: 'va', value: '0x100000574' } });
    assert.equal(first.reused, false);
    assert.equal(emission(computed).cache, 'computed');
    const { projectId, projectPath, revision } = first;
    await first.close();
    const second = await openBinary(input);
    sessions.push(second);
    const hit = await second.decompile({ id: emission(computed).function_id });
    assert.equal(second.reused, true);
    assert.equal(second.projectId, projectId);
    assert.equal(second.revision, revision);
    assert.equal(emission(hit).cache, 'hit');
    assert.equal(emission(hit).emission.text, emission(computed).emission.text);
    // Work is per delivery: serving the stored result costs less than the run that computed it.
    const computedWork = emission(computed).work;
    const hitWork = emission(hit).work;
    assert.ok(computedWork !== undefined && hitWork !== undefined);
    assert.ok(hitWork > 0 && hitWork < computedWork && computedWork <= computed.budget.work);
    assert.deepEqual(hit.artifacts, computed.artifacts);
    const python = await second.decompile(
      { id: emission(hit).function_id },
      { emitter: 'python-like' },
    );
    assert.equal(emission(python).cache, 'computed');
    assert.equal(emission(python).emission.language, 'python-like');
    assert.notEqual(python.artifacts[0]?.id, hit.artifacts[0]?.id);
    await second.close();
    const store = SqliteProjectStore.open(projectPath, 'resume');
    try {
      assert.equal(
        store.listJobs({ limit: 1000 }).items.filter((job) => job.operation === 'project_open')
          .length,
        1,
      );
    } finally {
      await store.close();
    }
    const changed = Buffer.from(original);
    const marker = changed.indexOf('open-decomp trusted fixture v1');
    assert.ok(marker >= 0);
    changed[marker] = 'O'.charCodeAt(0);
    await writeFile(input, changed);
    await utimes(input, times.atime, times.mtime);
    const third = await openBinary(input);
    sessions.push(third);
    assert.equal(third.reused, false);
    assert.notEqual(third.projectPath, projectPath);
    assert.notEqual(third.image.sha256, second.image.sha256);
    await third.close();
    await writeFile(input, original);
    const restored = await openBinary(input);
    sessions.push(restored);
    assert.equal(restored.reused, true);
    assert.equal(restored.projectId, projectId);
    assert.equal(
      emission(await restored.decompile({ id: emission(hit).function_id })).cache,
      'hit',
    );
  },
);

test(
  'artifact-backed decompilation returns full semantic state and preserves cache hits at a small delivery budget',
  { timeout: 60000 },
  async (t) => {
    const { root, input, sessions } = await setup(t);
    const session = await openBinary(input, { cachePath: join(root, 'cache') });
    sessions.push(session);
    const selector = { address: { space: 'va' as const, value: '0x100000574' } };
    const computed = await session.decompile(selector, { budget: { output_bytes: 4096 } });
    assert.equal(computed.state, 'complete');
    assert.equal(emission(computed).cache, 'computed');
    assert.ok(
      Buffer.byteLength(JSON.stringify(computed)) > 4096,
      'Exercise real artifact delivery rather than an inline response',
    );
    assert.equal(computed.budget.output_bytes, 4096);
    const hit = await session.decompile(selector, { budget: { output_bytes: 4096 } });
    assert.equal(hit.state, computed.state);
    assert.equal(emission(hit).cache, 'hit');
    assert.deepEqual(emission(hit).emission, emission(computed).emission);
    // Artifact delivery materializes the stored analysis and keeps the delivery's own work.
    assert.ok(emission(computed).work! > 0 && emission(hit).work! > 0);
    assert.deepEqual(hit.artifacts, computed.artifacts);
  },
);

test(
  'function selection proves absence once whole-image enumeration completes and closed sessions cannot keep querying',
  { timeout: 60000 },
  async (t) => {
    const { input, sessions } = await setup(t);
    const session = await openBinary(input);
    sessions.push(session);
    const selected = await session.decompile({ name: '_fixture_arithmetic' });
    assert.equal(emission(selected).emission.language, 'c-like');
    await assert.rejects(
      session.decompile({ name: 'no_such_function_in_this_fixture' }),
      (error) =>
        error instanceof FunctionSelectionError &&
        error.reason === 'not_found' &&
        error.candidates.length === 0,
    );
    await session.close();
    await assert.rejects(session.findFunctions(), { code: 'invalid_input' });
  },
);

test(
  'C names resolve through the authoritative symbol table under a partial function index, ambiguity stays honest, absence drives discovery to completion',
  { timeout: 120000 },
  async (t) => {
    const { root, sessions } = await setup(t);
    const binary = await manyFunctions(root, '_');
    const partial = await openBinary(binary, {
      cachePath: join(root, 'partial'),
      budget: { instructions: 1 },
    });
    sessions.push(partial);
    const native = await partial.findFunctions({
      query: { text: '_task_010', match: 'exact', case_sensitive: true },
    });
    assert.ok('data' in native && native.data.page.index_state === 'partial');
    assert.equal(native.data.items.length, 1);
    const selected = await partial.decompile({ name: 'task_010' });
    assert.equal(emission(selected).function_id, native.data.items[0]!.id);
    assert.equal(
      emission(await partial.decompile({ name: '_task_010' })).function_id,
      native.data.items[0]!.id,
    );
    await assert.rejects(
      partial.decompile({ name: 'duplicate' }),
      (error) =>
        error instanceof FunctionSelectionError &&
        error.reason === 'ambiguous' &&
        error.candidates.length === 2,
    );
    // The tables cannot settle an absent name under the partial index, so the session runs
    // whole-image discovery to completion (default request budget) and then proves absence.
    const before = partial.revision;
    await assert.rejects(
      partial.decompile({ name: 'task_absent' }),
      (error) =>
        error instanceof FunctionSelectionError &&
        error.reason === 'not_found' &&
        error.candidates.length === 0,
    );
    assert.ok(partial.revision > before);
    const completed = await partial.findFunctions({ page: { limit: 1 } });
    assert.ok('data' in completed && completed.data.page.index_state === 'complete');
    const complete = await openBinary(binary, { cachePath: join(root, 'complete') });
    sessions.push(complete);
    assert.equal(
      emission(await complete.decompile({ name: 'task_010' })).function_id,
      native.data.items[0]!.id,
    );
    await assert.rejects(
      complete.decompile({ name: 'task_absent' }),
      (error) => error instanceof FunctionSelectionError && error.reason === 'not_found',
    );
  },
);

test(
  'failed imports are retained for inspection and never silently replayed on the next invocation',
  { timeout: 60000 },
  async (t) => {
    const { input } = await setup(t);
    await writeFile(input, 'not a native image');
    let projectPath = '';
    await assert.rejects(openBinary(input), (error) => {
      assert.ok(error instanceof BinaryOpenError);
      assert.equal(error.reused, false);
      assert.equal(error.result.state, 'failed');
      projectPath = error.projectPath;
      return true;
    });
    await assert.rejects(openBinary(input), (error) => {
      assert.ok(error instanceof BinaryOpenError);
      assert.equal(error.reused, true);
      assert.equal(error.result.state, 'partial');
      assert.ok('data' in error.result && error.result.data.image === null);
      return true;
    });
    const store = SqliteProjectStore.open(projectPath, 'resume');
    try {
      const jobs = store
        .listJobs({ limit: 1000 })
        .items.filter((job) => job.operation === 'project_open');
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]?.state, 'failed');
    } finally {
      await store.close();
    }
  },
);

test('an automatically discovered sidecar cannot redirect project writes through a symlink', async (t) => {
  const { root, input } = await setup(t);
  const destination = join(root, 'destination');
  await mkdir(destination);
  await symlink(destination, `${input}.open-decomp`, 'dir');
  await assert.rejects(openBinary(input), { code: 'invalid_input' });
  assert.deepEqual(await readdir(destination), []);
});

test(
  'an import stub is listed under its import name, complete, and selectable by that name',
  { timeout: 60000 },
  async (t) => {
    const { input, sessions } = await setup(t);
    const session = await openBinary(input);
    sessions.push(session);
    const listed = await session.findFunctions({ page: { limit: 100 } });
    assert.ok('data' in listed);
    const stubs = listed.data.items.filter((item) => item.kind === 'import_stub');
    assert.ok(stubs.length > 0);
    for (const stub of stubs) {
      assert.ok(stub.original_name !== null);
      assert.equal(stub.analysis, 'complete');
      assert.equal(stub.boundary, 'established');
    }
    const puts = stubs.find((item) => item.original_name === '_puts');
    assert.ok(puts);
    assert.equal(listed.data.items.filter((item) => item.original_name === '_puts').length, 1);
    const result = await session.decompile({ name: '_puts' });
    assert.ok('data' in result && result.data.function_id === puts.id);
  },
);
