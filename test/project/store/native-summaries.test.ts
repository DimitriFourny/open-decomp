import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { decodeStoredGraph, encodeStoredGraph } from '../../../src/project/store/encoding.js';
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

test('graph encoding keeps Maps, bigints, shared substructure and drops nothing else', () => {
  const shared = { register: 'arm64:x0', width: 64 };
  const identifier = `evidence_${'a'.repeat(64)}`;
  const value: {
    memory: Map<bigint, { byte: number }>;
    first: typeof shared;
    second: typeof shared;
    list: unknown[];
    gone: undefined;
    nested: { memory: Map<string, unknown[]> };
  } = {
    memory: new Map<bigint, { byte: number }>([
      [0n, { byte: 1 }],
      [-8n, { byte: 2 }],
    ]),
    first: shared,
    second: shared,
    list: [shared, identifier, identifier, 18446744073709551615n, null, true, 0.5],
    gone: undefined,
    nested: { memory: new Map<string, unknown[]>([['k', [shared]]]) },
  };
  const decoded = decodeStoredGraph<typeof value>(encodeStoredGraph(value));
  assert.deepEqual(decoded.memory, value.memory);
  assert.ok(decoded.first === decoded.second, 'shared object stays shared');
  assert.ok(
    decoded.list[0] === decoded.first && decoded.nested.memory.get('k')![0] === decoded.first,
  );
  assert.deepEqual(decoded.list.slice(1), value.list.slice(1));
  assert.ok(!Object.hasOwn(decoded, 'gone'));
  assert.deepEqual({ ...decoded.first }, shared);
  // The identifier is stored once.
  const text = Buffer.from(encodeStoredGraph(value)).toString('utf8');
  assert.equal(text.split(identifier).length - 1, 1);
});

test('graph encoding rejects what it cannot reproduce exactly and malformed input', () => {
  for (const bad of [new Date(), new Set([1]), Number.NaN, -0, [undefined], new Uint8Array(1)])
    assert.throws(() => encodeStoredGraph({ bad }), TypeError, String(bad));
  assert.throws(
    () =>
      decodeStoredGraph(Buffer.from('{"version":2,"strings":[],"shared":[],"value":["ref",0]}')),
    TypeError,
  );
  assert.throws(
    () => decodeStoredGraph(Buffer.from('{"version":2,"strings":[],"shared":[],"value":["s",3]}')),
    TypeError,
  );
  assert.throws(() => decodeStoredGraph(Buffer.from('{"version":1,"value":null}')), TypeError);
});

test('queued summaries are written in one batch and read back with their numbers', (t) => {
  const state = open(t);
  const first = row(0, 'a');
  assert.ok(state.store.queueNativeSummary(first));
  assert.equal(
    state.store.readNativeSummary(first.scope, first.function_id),
    null,
    'not yet written',
  );
  state.store.flushNativeSummaries();
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
  // A row that alone exceeds the cap is never stored.
  assert.equal(state.store.queueNativeSummary(row(0, 'huge', 20000)), false);
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
