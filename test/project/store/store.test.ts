import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  ImmutableBytes, contentHash, imageIdentity, sliceIdentity, entityIdentity, newIdentity,
  DEFAULT_BUDGET, DEFAULT_ANALYSIS_OPTIONS, artifactReadArgsSchema,
  type FunctionRecord, type Job, type CacheIdentity, type StoreTransaction,
} from '../../../src/core/index.js';
import { SqliteProjectStore } from '../../../src/project/store/index.js';

async function project(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'open-decomp-store-'));
  const state = { path, store: SqliteProjectStore.open(path, 'create') };
  t.after(async () => { await state.store.close(); rmSync(path, { recursive: true, force: true }); });
  const raw = Uint8Array.of(0x90, 0xc3);
  const sha256 = contentHash(raw), imageId = imageIdentity(sha256);
  const sliceId = sliceIdentity(imageId, 0n, 2n, 'x86_64');
  await state.store.importImage({ bytes: new ImmutableBytes(raw), sha256, selected_slice_id: sliceId });
  const entry = { image_id: imageId, space: 'va' as const, value: 0x8000000000000001n };
  const fn: FunctionRecord = { id: entityIdentity(sliceId, 'function', entry.value), entry, ranges: [{ start: entry, size: 2n }], boundary: 'candidate', original_name: 'original', display_name: 'original', evidence_ids: [], signature: null, analysis: 'not_analyzed' };
  return { state, raw, sha256, imageId, sliceId, fn };
}

test('reopen preserves unsigned addresses, historical facts, annotation text and independent image identities', async t => {
  const { state, raw, imageId, sha256, sliceId, fn } = await project(t);
  assert.equal(state.store.transaction(1, tx => { tx.putRecord(imageId, 'function', fn); tx.setIndexState(imageId, 'function', 'complete'); }).state, 'committed');
  const annotation = newIdentity('annotation');
  assert.equal(state.store.applyAnnotations({ expected_revision: 2, author: 'fixture', origin: 'user', edits: [{ operation: 'set', id: annotation, entity_id: fn.id, value: { kind: 'note', value: '0xffffffffffffffff' }, status: 'asserted', evidence_ids: [] }] }).state, 'committed');
  assert.deepEqual(await state.store.importImage({ bytes: new ImmutableBytes(raw), sha256, selected_slice_id: sliceId }), { image_id: imageId, existing: true });
  assert.equal(state.store.snapshot().revision, 3);
  const changed = Uint8Array.of(0x90, 0x90, 0xc3), changedHash = contentHash(changed), changedId = imageIdentity(changedHash);
  await state.store.importImage({ bytes: new ImmutableBytes(changed), sha256: changedHash, selected_slice_id: sliceIdentity(changedId, 0n, 3n, 'x86_64') });
  const before = state.store.snapshot();
  await state.store.close(); state.store = SqliteProjectStore.open(state.path, 'resume');
  assert.deepEqual(state.store.snapshot(), before);
  assert.deepEqual(state.store.readImage(imageId).read(0n, 2), raw);
  assert.deepEqual(state.store.readImage(changedId).read(0n, 3), changed);
  assert.deepEqual(state.store.snapshot(3).images.map(image => image.image_id), [imageId]);
  const records = state.store.queryRecords({ kind: 'function', image_id: imageId, revision: 4, address: fn.entry, limit: 10 });
  assert.equal(records.index_state, 'complete');
  assert.deepEqual(records.items, [fn]);
  assert.deepEqual(state.store.readAnnotations(fn.id, 2), []);
  assert.deepEqual(state.store.readAnnotations(fn.id, 4)[0]?.value, { kind: 'note', value: '0xffffffffffffffff' });
  assert.equal(state.store.applyAnnotations({ expected_revision: 4, author: 'fixture', origin: 'user', edits: [{ operation: 'remove', id: annotation }] }).state, 'committed');
  assert.deepEqual(state.store.readAnnotations(fn.id, 5), []);
  assert.equal(state.store.readAnnotations(fn.id, 4)[0]?.id, annotation);
});

test('transactions roll back all writes, reject stale/async callers, and revoke escaped handles', async t => {
  const { state, imageId, fn } = await project(t);
  let escaped: StoreTransaction | undefined;
  const rejected = state.store.transaction(1, tx => { escaped = tx; tx.putRecord(imageId, 'function', fn); throw new Error('deliberate interruption'); });
  assert.equal(rejected.state, 'rejected');
  assert.equal(state.store.snapshot().revision, 1);
  assert.deepEqual(state.store.queryRecords({ kind: 'function', image_id: imageId, revision: 1, limit: 10 }).items, []);
  assert.throws(() => escaped!.putRecord(imageId, 'function', fn), { code: 'invalid_input' });
  let invoked = false;
  assert.equal(state.store.transaction(0, () => { invoked = true; }).state, 'conflict');
  assert.equal(invoked, false);
  assert.equal(state.store.transaction(1, async () => { invoked = true; }).state, 'rejected');
  assert.equal(invoked, false);
  assert.equal(state.store.transaction(1, tx => { tx.putRecord(imageId, 'function', fn); }).state, 'committed');
  assert.deepEqual(state.store.queryRecords({ kind: 'function', image_id: imageId, revision: 2, limit: 10 }).items, [fn]);
});

test('keyset pages are snapshot-bound and do not turn an unfinished empty index into complete', async t => {
  const { state, imageId, sliceId, fn } = await project(t);
  assert.equal(state.store.queryRecords({ kind: 'function', image_id: imageId, revision: 1, limit: 1 }).index_state, 'not_started');
  const second = { ...fn, id: entityIdentity(sliceId, 'function', 5n), original_name: 'second', display_name: 'second' };
  assert.equal(state.store.transaction(1, tx => { tx.putRecord(imageId, 'function', fn); tx.putRecord(imageId, 'function', second); }).state, 'committed');
  const query = { kind: 'function' as const, image_id: imageId, revision: 2, limit: 1 };
  const first = state.store.queryRecords(query);
  assert.equal(first.index_state, 'partial');
  assert.ok(first.next_cursor);
  const last = state.store.queryRecords({ ...query, cursor: first.next_cursor });
  assert.deepEqual([...first.items, ...last.items].map(item => item.id), [fn.id, second.id].sort());
  assert.equal(last.next_cursor, null);
  assert.throws(() => state.store.queryRecords({ ...query, cursor: first.next_cursor!, text: 'second' }), { code: 'stale_cursor' });
  assert.equal(state.store.transaction(2, tx => { tx.setIndexState(imageId, 'function', 'complete'); }).state, 'committed');
  assert.throws(() => state.store.queryRecords({ ...query, revision: 3, cursor: first.next_cursor! }), { code: 'stale_cursor' });
  assert.equal(state.store.queryRecords({ ...query, revision: 3, text: 'absent' }).index_state, 'complete');
  assert.equal(state.store.queryRecords({ ...query, text: 'absent' }).index_state, 'partial');
});

test('artifact publication binds job/project/revision and cancellation cannot publish output', async t => {
  const { state, sha256, sliceId, fn } = await project(t);
  const job: Job = { id: newIdentity('job'), project_id: state.store.project_id, input_revision: 1, operation: 'function_decompile', state: 'running', progress: { phase: 'emit', completed: 0, total: 1 }, artifacts: [], diagnostics: [], published_revision: null };
  const cache: CacheIdentity = { image_sha256: sha256, slice_id: sliceId, function_id: fn.id, target: { format: 'pe', architecture: 'x86_64', abi: 'windows-x64', endian: 'little', address_bits: 64, features: [] }, versions: { backend: 'test', loader: null, decoder: null, lifter: null, analysis: null, abi: null, emitter: null }, evidence_revision: 1, annotation_revision: 1, options: DEFAULT_ANALYSIS_OPTIONS, budget: DEFAULT_BUDGET };
  state.store.saveJob(job);
  const result = await state.store.publishArtifact({ job_id: job.id, expected_revision: 1, media_type: 'text/plain', bytes: Buffer.from('return 42;'), cache });
  assert.equal(result.state, 'published'); if (result.state !== 'published') throw new Error('Unreachable result');
  const args = artifactReadArgsSchema.parse({ project_id: state.store.project_id, revision: 1, artifact_id: result.artifact.id, offset: '0x0', length: 7 });
  const page = await state.store.readArtifact(args);
  assert.equal(Buffer.from(page.bytes_hex, 'hex').toString(), 'return ');
  assert.equal(page.next_offset, '0x7');
  assert.equal(state.store.readJob(job.id)?.state, 'completed');
  assert.deepEqual(state.store.findArtifact(cache), result.artifact);
  await assert.rejects(state.store.readArtifact({ ...args, project_id: newIdentity('project') }), { code: 'permission_denied' });
  assert.throws(() => state.store.saveJob({ ...job, state: 'running' }), { code: 'invalid_input' });
  const cancelled = { ...job, id: newIdentity('job'), state: 'cancelled' as const };
  state.store.saveJob(cancelled);
  assert.deepEqual(await state.store.publishArtifact({ job_id: cancelled.id, expected_revision: 1, media_type: 'text/plain', bytes: Buffer.from('bad'), cache }), { state: 'cancelled', current_revision: 1 });
  state.store.transaction(1, tx => { tx.putRecord(imageIdentity(sha256), 'function', fn); });
  assert.equal(state.store.findArtifact(cache), null);
  assert.deepEqual(await state.store.publishArtifact({ job_id: newIdentity('job'), expected_revision: 1, media_type: 'text/plain', bytes: Buffer.from('stale'), cache }), { state: 'stale', current_revision: 2 });
  await state.store.close(); state.store = SqliteProjectStore.open(state.path, 'resume');
  assert.equal(Buffer.from((await state.store.readArtifact(args)).bytes_hex, 'hex').toString(), 'return ');
});

test('newer schema rejection leaves database bytes untouched and an active store excludes a second writer', async t => {
  const { state } = await project(t);
  assert.throws(() => SqliteProjectStore.open(state.path, 'resume'), error => error instanceof Error && 'errcode' in error && error.errcode === 5);
  await state.store.close();
  const db = new DatabaseSync(join(state.path, 'project.sqlite'));
  db.exec('PRAGMA user_version=99'); db.close();
  const before = contentHash(readFileSync(join(state.path, 'project.sqlite')));
  assert.throws(() => SqliteProjectStore.open(state.path, 'resume'), { code: 'unsupported_version' });
  assert.equal(contentHash(readFileSync(join(state.path, 'project.sqlite'))), before);
});

test('process exit during SQLite mutation rolls back and releases the project lock', async t => {
  const { state, imageId, fn } = await project(t);
  await state.store.close();
  const module = new URL('../../../src/project/store/index.ts', import.meta.url).href;
  const script = `import {SqliteProjectStore} from ${JSON.stringify(module)}; const store=SqliteProjectStore.open(process.argv[1],'resume'); const record=${JSON.stringify({ ...fn, entry: { ...fn.entry, value: fn.entry.value.toString() }, ranges: fn.ranges.map(range => ({ start: { ...range.start, value: range.start.value.toString() }, size: range.size.toString() })) })}; record.entry.value=BigInt(record.entry.value); for(const range of record.ranges){range.start.value=BigInt(range.start.value);range.size=BigInt(range.size)}; store.transaction(1,tx=>{tx.putRecord(${JSON.stringify(imageId)},'function',record);process.exit(23)});`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script, state.path], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 23, child.stderr);
  state.store = SqliteProjectStore.open(state.path, 'resume');
  assert.equal(state.store.snapshot().revision, 1);
  assert.deepEqual(state.store.queryRecords({ kind: 'function', image_id: imageId, revision: 1, limit: 10 }).items, []);
  assert.equal(state.store.transaction(1, tx => { tx.putRecord(imageId, 'function', fn); }).state, 'committed');
});

test('job recovery pagination survives reopen and rejects cursors after project mutation', async t => {
  const { state, imageId, fn } = await project(t);
  const jobs: Job[] = ['queued', 'running', 'cancelled'].map((stateName, index) => ({
    id: `job_${String(index + 1).padStart(64, '0')}`, project_id: state.store.project_id, input_revision: 1,
    operation: 'function_decompile', state: stateName as 'queued' | 'running' | 'cancelled',
    progress: { phase: 'analysis', completed: 0, total: null }, artifacts: [], diagnostics: [], published_revision: null,
  }));
  for (const job of jobs) state.store.saveJob(job);
  await state.store.close(); state.store = SqliteProjectStore.open(state.path, 'resume');
  const first = state.store.listJobs({ limit: 2 });
  assert.deepEqual(first.items, jobs.slice(0, 2));
  assert.ok(first.next_cursor);
  const last = state.store.listJobs({ limit: 2, cursor: first.next_cursor });
  assert.deepEqual(last.items, jobs.slice(2));
  assert.equal(last.next_cursor, null);
  state.store.transaction(1, tx => { tx.putRecord(imageId, 'function', fn); });
  assert.throws(() => state.store.listJobs({ limit: 2, cursor: first.next_cursor! }), { code: 'stale_cursor' });
});
