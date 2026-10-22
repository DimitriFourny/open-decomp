import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { decodeArtifact, newIdentity, type ToolResult } from '../../../src/core/index.js';
import { project } from './support.js';

const FIXTURE = 'libcorpus-arm64-symbols.dylib';

/** Output a run must reproduce exactly, whatever caches were warm: everything but the
 * artifact handle, the cache marker and the work this delivery consumed. */
const comparable = (result: ToolResult<'function_decompile'>): string =>
  JSON.stringify(result, (key, value: unknown) =>
    key === 'artifacts' || key === 'cache' || key === 'artifact_id' || key === 'work'
      ? undefined
      : value,
  );

type Project = Awaited<ReturnType<typeof project>>;

/** Run `sql` against the project database. The store owns an exclusive lock, so it is closed
 * for the query and reopened as a new "process". */
async function sql(p: Project, statement: string, parameters: SQLInputValue[] = []) {
  await p.state.store.close();
  const db = new DatabaseSync(join(p.path, 'project.sqlite'));
  try {
    const statementSync = db.prepare(statement);
    return /^\s*select/i.test(statement)
      ? statementSync.all(...parameters).map((row) => ({ ...row }))
      : (statementSync.run(...parameters), []);
  } finally {
    db.close();
    await p.reopen();
  }
}

/** Uncached reference output of every function: nothing read, retained or written. */
async function uncached(p: Project, ids: readonly string[]): Promise<Map<string, string>> {
  const reference = new Map<string, string>();
  for (const id of ids)
    reference.set(
      id,
      comparable((await p.decompile(id, {}, undefined, { analysis_cache: false })).result),
    );
  return reference;
}

/** Decompile functions of `ids` in fresh "processes" until one reuses a callee summary that
 * no earlier request in its process could have prepared; return that function. */
async function firstPersistedHit(p: Project, ids: readonly string[]) {
  for (const id of ids) {
    await p.reopen();
    const phases: string[] = [];
    const { result } = await p.decompile(id, {}, undefined, { phases });
    if (phases.includes('native_summary_cache')) return { id, result };
  }
  return undefined;
}

/** A project whose first half of functions was decompiled with caching on (persisting the
 * callee units those requests prepared); the second half is untouched. */
async function persisted(t: TestContext) {
  const p = await project(t, FIXTURE);
  const ids = p.functions.map((fn) => fn.id);
  const half = Math.floor(ids.length / 2);
  for (const id of ids.slice(0, half)) await p.decompile(id);
  return { p, ids, rest: ids.slice(half) };
}

/** A function that, in a new process, reuses a persisted summary when nothing is damaged.
 * Fixture analysis is deterministic, so the same function does in any equal project. */
async function reusingFunction(t: TestContext): Promise<string> {
  const { p, rest } = await persisted(t);
  const hit = await firstPersistedHit(p, rest);
  assert.ok(hit, 'no later function reused a persisted summary');
  return hit.id;
}

/** Decompile `id` in a new process; whether it reused a persisted summary, and its output. */
async function inNewProcess(p: Project, id: string) {
  await p.reopen();
  const phases: string[] = [];
  const { result } = await p.decompile(id, {}, undefined, { phases });
  return { reused: phases.includes('native_summary_cache'), output: comparable(result) };
}

test('summaries persisted by an earlier process serve later requests with unchanged output', async (t) => {
  const p = await project(t, FIXTURE);
  const ids = p.functions.map((fn) => fn.id);
  const reference = await uncached(p, ids);
  // Nothing was written while uncached.
  assert.deepEqual(await sql(p, 'SELECT count(*) AS n FROM native_summaries'), [{ n: 0 }]);
  const half = Math.floor(ids.length / 2);
  // Process 1 publishes the first half, persisting the callee units it prepares.
  for (const id of ids.slice(0, half)) await p.decompile(id);
  const persisted = await sql(p, 'SELECT count(*) AS n FROM native_summaries');
  assert.ok((persisted[0]!['n'] as number) > 0, 'no callee summary was persisted');
  // A new process then decompiles functions it has not seen; reuse is only possible from disk.
  const hit = await firstPersistedHit(p, ids.slice(half));
  assert.ok(hit, 'no later function reused a persisted summary');
  assert.equal(comparable(hit.result), reference.get(hit.id));
  // And every remaining function still equals its uncached output, in this process (warm
  // in-process tier) and after another restart.
  for (const id of ids) {
    assert.equal(comparable((await p.decompile(id)).result), reference.get(id), id);
  }
  await p.reopen();
  for (const id of ids) {
    assert.equal(comparable((await p.decompile(id)).result), reference.get(id), id);
  }
});

/** `reasons` of every persisted unit that carries some: facts of the body (an indirect call is
 * `unresolved control flow`), not limits. */
async function persistedReasons(p: Project): Promise<Map<string, readonly string[]>> {
  const rows = (await sql(p, 'SELECT function_id, scope FROM native_summaries')) as {
    function_id: string;
    scope: string;
  }[];
  const reasons = new Map<string, readonly string[]>();
  for (const row of rows) {
    const stored = p.state.store.readNativeSummary(row.scope, row.function_id);
    const unit = (stored?.value as { unit?: { reasons?: readonly string[]; limited?: boolean } })
      .unit;
    assert.equal(unit?.limited, false);
    if (unit?.reasons?.length) reasons.set(row.function_id, unit.reasons);
  }
  return reasons;
}

const workOf = (result: ToolResult<'function_decompile'>): unknown => {
  const work = 'data' in result ? (result.data as { work?: unknown }).work : undefined;
  assert.notEqual(work, undefined, 'the delivery reports no work');
  return work;
};

test('units whose reasons are not limits (an unresolved indirect call) are persisted and served with unchanged output, reused with equal work', async (t) => {
  const p = await project(t, FIXTURE);
  const ids = p.functions.map((fn) => fn.id);
  const references = async (of: Project) => {
    const reference = new Map<string, { text: string; work: unknown }>();
    for (const id of ids) {
      const { result } = await of.decompile(id, {}, undefined, { analysis_cache: false });
      reference.set(id, { text: comparable(result), work: workOf(result) });
    }
    return reference;
  };
  const reference = await references(p);
  const half = Math.floor(ids.length / 2);
  for (const id of ids.slice(0, half)) await p.decompile(id);
  const reasons = await persistedReasons(p);
  assert.ok(reasons.size > 0, 'no unit with a non-limit reason was persisted');
  for (const list of reasons.values())
    assert.ok(
      list.every((reason) => !/work limit|budget/i.test(reason)),
      `a limit reason was persisted: ${list.join('; ')}`,
    );
  // A new process serves the later functions from the rows with the uncached output.
  let served = 0;
  for (const id of ids.slice(half)) {
    await p.reopen();
    const phases: string[] = [];
    const { result } = await p.decompile(id, {}, undefined, { phases });
    if (phases.includes('native_summary_cache')) served++;
    assert.equal(comparable(result), reference.get(id)!.text, id);
  }
  assert.ok(served > 0, 'no persisted summary was served');
  // In one process the retained units (those with reasons included) serve the later
  // functions, which charge exactly the work an uncached preparation charges.
  const q = await project(t, FIXTURE);
  const expected = await references(q);
  for (const id of ids.slice(0, half)) await q.decompile(id);
  const phases: string[] = [];
  for (const id of ids.slice(half)) {
    const { result } = await q.decompile(id, {}, undefined, { phases });
    assert.equal(comparable(result), expected.get(id)!.text, id);
    assert.deepEqual(workOf(result), expected.get(id)!.work, `work of ${id}`);
  }
  assert.ok(phases.includes('native_summary_cache'), 'no retained unit was reused');
});

test('a revision change invalidates persisted summaries and removes the superseded rows', async (t) => {
  const hitId = await reusingFunction(t);
  const { p, ids } = await persisted(t);
  const revision = p.state.store.snapshot().revision;
  assert.deepEqual(await sql(p, 'SELECT DISTINCT revision FROM native_summaries'), [{ revision }]);
  // An annotation advances the revision: nothing stored for the old one may be used.
  assert.equal(
    p.state.store.applyAnnotations({
      expected_revision: revision,
      author: 'persistence-test',
      origin: 'user',
      edits: [
        {
          operation: 'set',
          id: newIdentity('annotation'),
          entity_id: ids[0]!,
          value: { kind: 'note', value: 'changes the revision' },
          status: 'asserted',
          evidence_ids: [],
        },
      ],
    }).state,
    'committed',
  );
  await p.reopen();
  assert.equal(p.state.store.snapshot().revision, revision + 1);
  const reference = comparable(
    (await p.decompile(hitId, {}, undefined, { analysis_cache: false })).result,
  );
  const next = await inNewProcess(p, hitId);
  assert.equal(next.reused, false, 'a summary of the previous revision was used');
  assert.equal(next.output, reference);
  // The request persisted its own units for the new revision and dropped the old rows.
  assert.deepEqual(await sql(p, 'SELECT DISTINCT revision FROM native_summaries'), [
    { revision: revision + 1 },
  ]);
});

test('rows with a foreign identity or a corrupted payload are never served', async (t) => {
  const hitId = await reusingFunction(t);
  const { p } = await persisted(t);
  const reference = comparable(
    (await p.decompile(hitId, {}, undefined, { analysis_cache: false })).result,
  );
  const rows = await sql(p, 'SELECT function_id, scope FROM native_summaries ORDER BY seq');
  assert.ok(rows.length >= 2);
  const scope = rows[0]!['scope'] as string;
  const [a, b] = rows.map((row) => row['function_id'] as string) as [string, string];
  // Store level: swapping payloads between two rows and moving a row to another function are
  // misses (the digest binds identity and content); an untouched row is still served.
  await sql(
    p,
    'UPDATE native_summaries SET payload=(SELECT payload FROM native_summaries WHERE function_id=?) WHERE function_id=?',
    [b, a],
  );
  assert.equal(p.state.store.readNativeSummary(scope, a), null, 'payload of another row');
  assert.ok(p.state.store.readNativeSummary(scope, b), 'untouched row');
  await sql(p, 'UPDATE native_summaries SET function_id=? WHERE function_id=?', [
    `entity_${'0'.repeat(64)}`,
    b,
  ]);
  assert.equal(p.state.store.readNativeSummary(scope, b), null, 'row moved to another function');
  // End to end: with every payload zeroed nothing is reused and the output is the uncached one.
  await sql(p, 'UPDATE native_summaries SET payload=zeroblob(length(payload))');
  const damaged = await inNewProcess(p, hitId);
  assert.equal(damaged.reused, false, 'a corrupted summary was used');
  assert.equal(damaged.output, reference);
});

test('a row whose dependency trace no longer matches the store is a miss', async (t) => {
  const hitId = await reusingFunction(t);
  const { p } = await persisted(t);
  const reference = comparable(
    (await p.decompile(hitId, {}, undefined, { analysis_cache: false })).result,
  );
  const rows = (await sql(p, 'SELECT function_id, scope FROM native_summaries')) as {
    function_id: string;
    scope: string;
  }[];
  // Rewrite every row with an authentic digest but a trace claiming a different store state.
  for (const row of rows) {
    const stored = p.state.store.readNativeSummary(row.scope, row.function_id);
    assert.ok(stored);
    const value = stored.value as { trace: { read: { fingerprint: string } }[] };
    for (const entry of value.trace) entry.read.fingerprint = 'f'.repeat(64);
    assert.ok(p.state.store.queueNativeSummary({ ...stored, value }));
  }
  p.state.store.flushNativeSummaries();
  const forged = await inNewProcess(p, hitId);
  assert.equal(forged.reused, false, 'a summary with a stale trace was used');
  assert.equal(forged.output, reference);
});

test('rows of a unit that hit a limit are never served, whatever else they carry', async (t) => {
  for (const field of ['limited', 'budget_truncated'] as const) {
    const hitId = await reusingFunction(t);
    const { p } = await persisted(t);
    const reference = comparable(
      (await p.decompile(hitId, {}, undefined, { analysis_cache: false })).result,
    );
    const rows = (await sql(p, 'SELECT function_id, scope FROM native_summaries')) as {
      function_id: string;
      scope: string;
    }[];
    // Authentic digests, but every unit claims the limit (the schema admits only false).
    for (const row of rows) {
      const stored = p.state.store.readNativeSummary(row.scope, row.function_id);
      assert.ok(stored);
      const value = stored.value as { unit: Record<string, unknown> };
      value.unit[field] = true;
      assert.ok(p.state.store.queueNativeSummary({ ...stored, value }));
    }
    p.state.store.flushNativeSummaries();
    const forged = await inNewProcess(p, hitId);
    assert.equal(forged.reused, false, `a unit with ${field} was used`);
    assert.equal(forged.output, reference);
  }
});

test('disabled analysis caching writes no derived rows and delivers like a cached run', async (t) => {
  const p = await project(t, FIXTURE);
  const ids = p.functions.map((fn) => fn.id);
  const phases: string[] = [];
  for (const id of ids) await p.decompile(id, {}, undefined, { analysis_cache: false, phases });
  // Twice: a second pass must not read anything the first left behind.
  for (const id of ids) await p.decompile(id, {}, undefined, { analysis_cache: false, phases });
  assert.ok(!phases.includes('native_summary_cache'), 'a summary was reused');
  assert.ok(!phases.includes('dependency-reuse'), 'a stored result was reused');
  for (const table of ['artifacts', 'analysis_artifacts', 'analysis_reuse', 'native_summaries'])
    assert.deepEqual(
      await sql(p, `SELECT count(*) AS n FROM ${table}`),
      [{ n: 0 }],
      `${table} must stay empty`,
    );
  assert.deepEqual(readdirSync(join(p.path, 'artifacts')), []);
  // The same runs with caching on persist rows and match the uncached output.
  const reference = await uncached(p, ids);
  for (const id of ids)
    assert.equal(comparable((await p.decompile(id)).result), reference.get(id), id);
  const enabled = await sql(p, 'SELECT count(*) AS n FROM artifacts');
  assert.equal(enabled[0]!['n'], ids.length);
});

test('with caching disabled an artifact-delivered result is readable but never stored', async (t) => {
  const p = await project(t, FIXTURE);
  const id = p.functions[0]!.id;
  const { result } = await p.decompile(id, { delivery: 'artifact' }, undefined, {
    analysis_cache: false,
  });
  assert.ok('data' in result && result.data.delivery === 'artifact');
  const artifact = decodeArtifact(result.artifacts[0]!);
  const bytes = p.state.store.readArtifactBytes(artifact);
  const stored = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
    result: ToolResult<'function_decompile'>;
  };
  const cached = await p.decompile(id, { delivery: 'artifact' });
  const cachedBytes = p.state.store.readArtifactBytes(decodeArtifact(cached.result.artifacts[0]!));
  // The delivered analysis is the one a cached run publishes.
  assert.equal(
    comparable(stored.result),
    comparable(
      (
        JSON.parse(Buffer.from(cachedBytes).toString('utf8')) as {
          result: ToolResult<'function_decompile'>;
        }
      ).result,
    ),
  );
  // Reading pages of the transient artifact works through the public read, too.
  const page = await p.state.store.readArtifact({
    project_id: p.state.store.project_id,
    revision: artifact.revision,
    artifact_id: artifact.id,
    offset: '0x0' as never,
    length: 16,
  });
  assert.equal(page.artifact.id, artifact.id);
  // Only the cached run persisted anything; it never found the transient one.
  assert.deepEqual(await sql(p, 'SELECT count(*) AS n FROM artifacts'), [{ n: 1 }]);
  assert.equal((cached.result as { data: { cache: string } }).data.cache, 'computed');
});
