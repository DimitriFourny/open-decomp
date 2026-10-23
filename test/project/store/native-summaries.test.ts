import { serialize } from 'node:v8';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_ANALYSIS_OPTIONS,
  DEFAULT_BUDGET,
  newIdentity,
  type CacheIdentity,
} from '../../../src/core/index.js';
import { decodeStoredClone, encodeStoredClone } from '../../../src/project/store/encoding.js';
import { SqliteProjectStore } from '../../../src/project/store/index.js';

function open(t: TestContext, options: { native_summary_bytes?: number } = {}) {
  const path = mkdtempSync(join(tmpdir(), 'open-decomp-summaries-'));
  const state = { path, store: SqliteProjectStore.open(path, 'create', options) };
  t.after(async () => {
    await state.store.close();
    rmSync(path, { recursive: true, force: true });
  });
  return state;
}

let counter = 0;
const entityId = (): string =>
  `entity_${createHash('sha256').update(`summary-test-${counter++}`).digest('hex')}`;

/** Incompressible text of a given length: summaries of different identity have different bytes. */
function noise(seed: string, length: number): string {
  let text = '';
  for (let counter = 0; text.length < length; counter++)
    text += createHash('sha256').update(`${seed}:${counter}`).digest('base64');
  return text.slice(0, length);
}
const row = (revision: number, seed: string, length = 1500) => ({
  scope: 'scope-under-test',
  function_id: entityId(),
  revision,
  allowance: 1000,
  work: 10,
  value: { pad: noise(seed, length) },
});
const query = (path: string, sql: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(sql)
      .all()
      .map((item) => ({ ...item }));
  } finally {
    db.close();
  }
};

test('clone encoding keeps Maps, bigints, shared substructure, undefined fields and frozenness', () => {
  const shared = Object.freeze({ register: 'arm64:x0', width: 64 });
  const identifier = `evidence_${'a'.repeat(64)}`;
  const value: {
    memory: Map<bigint, { byte: number }>;
    first: typeof shared;
    second: typeof shared;
    list: unknown[];
    gone: undefined;
    nested: { memory: Map<string, unknown[]> };
    open: { width: number };
  } = {
    memory: new Map<bigint, { byte: number }>([
      [0n, { byte: 1 }],
      [-8n, { byte: 2 }],
    ]),
    first: shared,
    second: shared,
    list: Object.freeze([shared, identifier, 18446744073709551615n, null, true, 0.5, -0, NaN]),
    gone: undefined,
    nested: { memory: new Map<string, unknown[]>([['k', [shared]]]) },
    open: { width: 8 },
  } as never;
  const decoded = decodeStoredClone<typeof value>(encodeStoredClone(value));
  assert.deepEqual(decoded.memory, value.memory);
  assert.ok(decoded.first === decoded.second, 'shared object stays shared');
  assert.ok(
    decoded.list[0] === decoded.first && decoded.nested.memory.get('k')![0] === decoded.first,
  );
  assert.deepEqual(decoded.list.slice(1), value.list.slice(1));
  assert.ok(Object.is(decoded.list[6], -0));
  assert.ok(Object.hasOwn(decoded, 'gone') && decoded.gone === undefined);
  assert.deepEqual({ ...decoded.first }, shared);
  // Exactly the containers that were frozen are frozen again.
  assert.ok(Object.isFrozen(decoded.first) && Object.isFrozen(decoded.list));
  assert.ok(!Object.isFrozen(decoded) && !Object.isFrozen(decoded.open));
  assert.ok(!Object.isFrozen(decoded.nested.memory.get('k')));
});

test('clone encoding rejects what it cannot reproduce exactly and malformed input', () => {
  class Box {
    value = 1;
  }
  for (const bad of [new Date(), new Set([1]), new Uint8Array(1), new Box(), () => 1])
    assert.throws(() => encodeStoredClone({ bad }), TypeError, String(bad));
  assert.throws(() => decodeStoredClone(Buffer.from('{"version":3}')), Error);
  assert.throws(
    () => decodeStoredClone(serialize({ version: 2, frozen: [], value: {} })),
    TypeError,
  );
  // A frozen index the value does not have.
  assert.throws(
    () => decodeStoredClone(serialize({ version: 3, frozen: [5], value: {} })),
    TypeError,
  );
});

test('queued summaries are written in one batch and read back with their numbers', (t) => {
  const state = open(t);
  const first = row(0, 'a');
  assert.ok(state.store.queueNativeSummary(first));
  assert.equal(
    state.store.readNativeSummary(first.scope, first.function_id),
    null,
    'not yet released at a request boundary',
  );
  // Released rows are served from the queue exactly as the written row will be.
  state.store.releaseNativeSummaries();
  assert.deepEqual(state.store.readNativeSummary(first.scope, first.function_id), first);
  assert.equal(state.store.flushNativeSummaries(), 0);
  const stored = state.store.readNativeSummary(first.scope, first.function_id);
  assert.deepEqual(stored, first);
  // A different scope or function never matches.
  assert.equal(state.store.readNativeSummary('another-scope', first.function_id), null);
  assert.equal(state.store.readNativeSummary(first.scope, entityId()), null);
  // Rows for another revision than the store's are refused.
  assert.equal(state.store.queueNativeSummary(row(1, 'b')), false);
});

test('the byte cap evicts oldest entries first and refuses a single row above it', async (t) => {
  const state = open(t, { native_summary_bytes: 4000 });
  const rows = Array.from({ length: 8 }, (_, index) => row(0, `r${index}`));
  // One batch is larger than the cap: the oldest of it goes, deterministically.
  for (const item of rows.slice(0, 5)) assert.ok(state.store.queueNativeSummary(item));
  state.store.flushNativeSummaries();
  for (const item of rows.slice(5)) assert.ok(state.store.queueNativeSummary(item));
  state.store.flushNativeSummaries();
  await state.store.close();
  const kept = query(
    join(state.path, 'project.sqlite'),
    'SELECT function_id, bytes FROM native_summaries ORDER BY seq',
  );
  const total = kept.reduce((sum, item) => sum + (item['bytes'] as number), 0);
  assert.ok(total <= 4000, `kept ${total} bytes`);
  assert.ok(kept.length >= 2 && kept.length < rows.length, `kept ${kept.length}`);
  // What stays is exactly the newest rows, in write order.
  assert.deepEqual(
    kept.map((item) => item['function_id']),
    rows.slice(rows.length - kept.length).map((item) => item.function_id),
  );
  state.store = SqliteProjectStore.open(state.path, 'resume', { native_summary_bytes: 4000 });
  assert.ok(state.store.readNativeSummary(rows[7]!.scope, rows[7]!.function_id));
  assert.equal(state.store.readNativeSummary(rows[0]!.scope, rows[0]!.function_id), null);
  // A row that alone exceeds the cap is accepted, then dropped by the write: never stored, never served.
  const huge = row(0, 'huge', 20000);
  assert.equal(state.store.queueNativeSummary(huge), true);
  state.store.releaseNativeSummaries();
  assert.equal(state.store.readNativeSummary(huge.scope, huge.function_id), null);
  assert.equal(state.store.flushNativeSummaries(), 0);
  assert.equal(state.store.readNativeSummary(huge.scope, huge.function_id), null);
  await state.store.close();
  assert.ok(
    query(join(state.path, 'project.sqlite'), 'SELECT function_id FROM native_summaries').every(
      (item) => item['function_id'] !== huge.function_id,
    ),
  );
});

test('rows of superseded revisions are dropped when a newer revision writes', async (t) => {
  const state = open(t);
  const old = row(0, 'old');
  state.store.queueNativeSummary(old);
  state.store.flushNativeSummaries();
  assert.equal(state.store.transaction(0, () => {}).state, 'committed');
  const current = row(1, 'new');
  state.store.queueNativeSummary(current);
  state.store.flushNativeSummaries();
  assert.equal(state.store.readNativeSummary(old.scope, old.function_id), null);
  assert.ok(state.store.readNativeSummary(current.scope, current.function_id));
  // A summary queued before the revision moved is discarded, never written for the new one.
  const late = row(1, 'late');
  state.store.queueNativeSummary(late);
  assert.equal(state.store.transaction(1, () => {}).state, 'committed');
  state.store.flushNativeSummaries();
  assert.equal(state.store.readNativeSummary(late.scope, late.function_id), null);
});

test('a schema-5 project migrates to 7 with an empty summary table and keeps working', async (t) => {
  const state = open(t);
  await state.store.close();
  const db = new DatabaseSync(join(state.path, 'project.sqlite'));
  db.exec('DROP TABLE native_summaries; DROP TABLE discovery_frontiers; PRAGMA user_version=5;');
  db.close();
  state.store = SqliteProjectStore.open(state.path, 'resume');
  assert.equal(state.store.snapshot().schema_version, 7);
  const item = row(0, 'after-migration');
  assert.ok(state.store.queueNativeSummary(item));
  state.store.flushNativeSummaries();
  assert.deepEqual(state.store.readNativeSummary(item.scope, item.function_id), item);
  await state.store.close();
  assert.deepEqual(query(join(state.path, 'project.sqlite'), 'PRAGMA user_version'), [
    { user_version: 7 },
  ]);
});

test('a flush slice writes the oldest rows first and reports what is left', async (t) => {
  const state = open(t);
  const rows = Array.from({ length: 5 }, (_, index) => row(0, `slice${index}`));
  for (const item of rows) assert.ok(state.store.queueNativeSummary(item));
  state.store.releaseNativeSummaries();
  assert.equal(state.store.flushNativeSummaries(2), 3);
  assert.equal(state.store.flushNativeSummaries(2), 1);
  // Written and queued rows read alike.
  for (const item of rows)
    assert.deepEqual(state.store.readNativeSummary(item.scope, item.function_id), item);
  assert.equal(state.store.flushNativeSummaries(2), 0);
  assert.equal(state.store.flushNativeSummaries(), 0);
  await state.store.close();
  assert.deepEqual(
    query(
      join(state.path, 'project.sqlite'),
      'SELECT function_id FROM native_summaries ORDER BY seq',
    ).map((item) => item['function_id']),
    rows.map((item) => item.function_id),
    'queue order is write order, whatever the slicing',
  );
});

test('requeueing an unreleased row keeps serving the previous version until the request boundary', (t) => {
  const state = open(t);
  const first = row(0, 'v1');
  const second = { ...first, allowance: 7, value: { pad: 'v2' } };
  state.store.queueNativeSummary(first);
  state.store.releaseNativeSummaries();
  state.store.queueNativeSummary(second);
  assert.deepEqual(state.store.readNativeSummary(first.scope, first.function_id), first);
  state.store.releaseNativeSummaries();
  assert.deepEqual(state.store.readNativeSummary(first.scope, first.function_id), second);
  state.store.flushNativeSummaries();
  assert.deepEqual(state.store.readNativeSummary(first.scope, first.function_id), second);
  // An unreleased replacement of a written row leaves the written row visible.
  const third = { ...first, allowance: 9, value: { pad: 'v3' } };
  state.store.queueNativeSummary(third);
  assert.deepEqual(state.store.readNativeSummary(first.scope, first.function_id), second);
  state.store.releaseNativeSummaries();
  assert.deepEqual(state.store.readNativeSummary(first.scope, first.function_id), third);
});

test('queueing rejects invalid weights and never encodes the value', (t) => {
  const state = open(t);
  assert.equal(state.store.queueNativeSummary({ ...row(0, 'w'), weight: -1 }), false);
  assert.equal(state.store.queueNativeSummary({ ...row(0, 'w'), weight: 1.5 }), false);
  // An unencodable value is accepted (it is only looked at by the write) and then dropped.
  const bad = { ...row(0, 'bad'), value: { bad: new Set([1]) } };
  assert.equal(state.store.queueNativeSummary(bad), true);
  state.store.releaseNativeSummaries();
  assert.equal(state.store.readNativeSummary(bad.scope, bad.function_id), null);
  assert.equal(state.store.flushNativeSummaries(), 0);
  assert.equal(state.store.readNativeSummary(bad.scope, bad.function_id), null);
});

/** A project whose `function_decompile` job and cache identity a child process can publish. */
function crashProject(t: TestContext) {
  const state = open(t);
  const cache: CacheIdentity = {
    image_sha256: 'a'.repeat(64),
    slice_id: `slice_${'b'.repeat(64)}`,
    function_id: entityId(),
    target: {
      format: 'pe',
      architecture: 'x86_64',
      abi: 'windows-x64',
      endian: 'little',
      address_bits: 64,
      features: [],
    },
    versions: {
      backend: 'crash',
      loader: null,
      decoder: null,
      lifter: null,
      analysis: null,
      abi: null,
      emitter: null,
    },
    evidence_revision: 0,
    annotation_revision: 0,
    options: DEFAULT_ANALYSIS_OPTIONS,
    budget: DEFAULT_BUDGET,
  };
  return { state, cache };
}

/** Publish an artifact in a child process that queued summaries, acknowledge it on stdout, then
 * die by SIGKILL without closing the store or flushing anything. */
async function killedAfterAcknowledge(t: TestContext, scenario: 'queued' | 'slice' | 'pressure') {
  const { state, cache } = crashProject(t);
  await state.store.close();
  const rows = Array.from({ length: 5 }, (_, index) => row(0, `crash${index}`));
  const job = {
    id: newIdentity('job'),
    project_id: state.store.project_id,
    input_revision: 0,
    operation: 'function_decompile',
    state: 'running',
    progress: { phase: 'emit', completed: 0, total: 1 },
    artifacts: [],
    diagnostics: [],
    published_revision: null,
  };
  const store = new URL('../../../src/project/store/index.ts', import.meta.url).href;
  const script = `
    import {SqliteProjectStore} from ${JSON.stringify(store)};
    import {writeSync} from 'node:fs';
    const [path, scenario, rowsJson, jobJson, cacheJson] = process.argv.slice(1);
    const store = SqliteProjectStore.open(path, 'resume');
    const rows = JSON.parse(rowsJson), job = JSON.parse(jobJson), cache = JSON.parse(cacheJson);
    for (const item of rows) if (!store.queueNativeSummary(item)) process.exit(3);
    store.saveJob(job);
    const published = await store.publishArtifact({
      job_id: job.id, expected_revision: 0, media_type: 'text/plain',
      bytes: Buffer.from('acknowledged payload'), cache,
    });
    if (published.state !== 'published') process.exit(4);
    // The response would be sent here: the job and artifact must already be durable.
    if (scenario === 'slice') store.flushNativeSummaries(2);
    if (scenario === 'pressure')
      store.queueNativeSummary({ ...rows[0], function_id: ${JSON.stringify(entityId())}, weight: 1 << 18 });
    writeSync(1, JSON.stringify({ artifact: published.artifact.id }) + '\\n');
    process.kill(process.pid, 'SIGKILL');
  `;
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      script,
      state.path,
      scenario,
      JSON.stringify(rows),
      JSON.stringify(job),
      JSON.stringify(cache),
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const acknowledged = JSON.parse(child.stdout.trim()) as { artifact: string };
  state.store = SqliteProjectStore.open(state.path, 'resume');
  return { state, rows, job, cache, acknowledged };
}

test('after a kill that follows an acknowledged publication the job and artifact are durable and unflushed summaries are simply absent', async (t) => {
  const { state, rows, job, cache, acknowledged } = await killedAfterAcknowledge(t, 'queued');
  assert.equal(state.store.readJob(job.id)?.state, 'completed');
  const artifact = state.store.findArtifact(cache);
  assert.equal(artifact?.id, acknowledged.artifact);
  assert.equal(
    Buffer.from(state.store.readArtifactBytes(artifact!)).toString(),
    'acknowledged payload',
  );
  for (const item of rows)
    assert.equal(state.store.readNativeSummary(item.scope, item.function_id), null);
  // The project is fully usable: the same rows can be queued, written and read again.
  for (const item of rows) assert.ok(state.store.queueNativeSummary(item));
  state.store.flushNativeSummaries();
  for (const item of rows)
    assert.deepEqual(state.store.readNativeSummary(item.scope, item.function_id), item);
  await state.store.close();
  assert.deepEqual(query(join(state.path, 'project.sqlite'), 'PRAGMA integrity_check'), [
    { integrity_check: 'ok' },
  ]);
});

test('summaries written by an idle slice or by queue pressure before a kill survive it, in order, and nothing else is half-written', async (t) => {
  const sliced = await killedAfterAcknowledge(t, 'slice');
  assert.equal(sliced.state.store.readJob(sliced.job.id)?.state, 'completed');
  rowsAre(sliced, [true, true, false, false, false]);
  const pressured = await killedAfterAcknowledge(t, 'pressure');
  assert.equal(pressured.state.store.readJob(pressured.job.id)?.state, 'completed');
  rowsAre(pressured, [true, true, true, true, true]);
  for (const { state } of [sliced, pressured]) {
    await state.store.close();
    assert.deepEqual(query(join(state.path, 'project.sqlite'), 'PRAGMA integrity_check'), [
      { integrity_check: 'ok' },
    ]);
  }
  function rowsAre(
    killed: { state: { store: SqliteProjectStore }; rows: ReturnType<typeof row>[] },
    written: boolean[],
  ): void {
    killed.rows.forEach((item, index) =>
      assert.deepEqual(
        killed.state.store.readNativeSummary(item.scope, item.function_id),
        written[index] ? item : null,
        `row ${index}`,
      ),
    );
  }
});
