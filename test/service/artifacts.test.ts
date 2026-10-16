import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_ANALYSIS_OPTIONS, DEFAULT_BUDGET, ImmutableBytes, contentHash, createOperationContext, imageIdentity, newIdentity, type CacheIdentity, type Job } from '../../src/core/index.js';
import { MachOLoader } from '../../src/loaders/macho/index.js';
import { SqliteProjectStore } from '../../src/project/store/index.js';
import { QueryService } from '../../src/service/queries/index.js';
import { prepareQueryImport } from '../../src/service/queries/prepare.js';

// Seed a real durable artifact while no child owns the project. Production artifact
// reads never expose this store or accept arbitrary filesystem paths/SQL over IPC.
test('real child artifact reads are project/revision scoped, resumable and below the 2 MiB IPC frame', { timeout: 60000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-artifacts-'))), fixtures = resolve('fixtures/bin');
  const projectPath = join(root, 'artifact-project');
  const store = SqliteProjectStore.open(projectPath, 'create');
  const raw = await readFile(join(fixtures, 'macho-arm64-symbols')), sha256 = contentHash(raw);
  const context = createOperationContext();
  const image = new MachOLoader().load({ bytes: new ImmutableBytes(raw), image_id: imageIdentity(sha256), sha256, slice_id: null }, context);
  await store.importImage({ bytes: image.bytes, sha256, selected_slice_id: image.selected_slice_id });
  const publish = await prepareQueryImport(image, { revision: 2, context });
  assert.equal(store.transaction(1, tx => { tx.putImage(image); publish(tx); }).state, 'committed');
  const fn = store.queryRecords({ image_id: image.id, revision: 2, kind: 'function', limit: 1 }).items[0];
  assert.ok(fn);
  const job: Job = { id: newIdentity('job'), project_id: store.project_id, input_revision: 2, operation: 'function_get', state: 'running', progress: { phase: 'archive', completed: 0, total: 1 }, artifacts: [], diagnostics: [], published_revision: null };
  const cache: CacheIdentity = { image_sha256: sha256, slice_id: image.selected_slice_id, function_id: fn.id, target: image.target, versions: { backend: 'artifact-read-fixture', loader: null, decoder: null, lifter: null, analysis: null, abi: null, emitter: null }, evidence_revision: 2, annotation_revision: 2, options: DEFAULT_ANALYSIS_OPTIONS, budget: DEFAULT_BUDGET };
  store.saveJob(job);
  const bytes = Buffer.concat(Array.from({ length: 32 }, () => raw));
  const published = await store.publishArtifact({ job_id: job.id, expected_revision: 2, media_type: 'application/octet-stream', bytes, cache });
  assert.equal(published.state, 'published');
  if (published.state !== 'published') assert.fail('Artifact publication failed');
  const artifact = published.artifact;
  await store.close();
  const service = await QueryService.create({ authorized_roots: [root, fixtures], max_workers: 2 });
  t.after(async () => { await service.close('cancel'); await rm(root, { recursive: true, force: true }); });
  const opened = await service.execute('project_open', { source: { kind: 'resume', project_path: projectPath } });
  assert.equal(opened.project_id, artifact.project_id); assert.equal(opened.revision, artifact.revision);
  const chunks: Buffer[] = [];
  let offset = '0x0';
  do {
    const page = await service.readArtifact({ project_id: artifact.project_id, revision: artifact.revision, artifact_id: artifact.id, offset, length: 1_048_576 });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 2 * 1024 * 1024);
    assert.ok(page.bytes_hex.length <= 2 * 512 * 1024);
    chunks.push(Buffer.from(page.bytes_hex, 'hex'));
    offset = page.next_offset ?? '';
  } while (offset);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  const second = await service.execute('project_open', { wait: true, source: { kind: 'import', input_path: join(fixtures, 'pe-x86_64-symbols.exe'), project_path: join(root, 'second') } });
  assert.ok(second.project_id && second.revision !== null);
  await assert.rejects(service.readArtifact({ project_id: second.project_id, revision: second.revision, artifact_id: artifact.id, offset: '0x0', length: 1 }), { code: 'not_found' });
  await assert.rejects(service.readArtifact({ project_id: artifact.project_id, revision: artifact.revision - 1, artifact_id: artifact.id, offset: '0x0', length: 1 }), { code: 'stale_revision' });
  await assert.rejects(service.readArtifact({ project_id: artifact.project_id, revision: artifact.revision, artifact_id: artifact.id, offset: `0x${(artifact.size + 1n).toString(16)}`, length: 1 }), { code: 'invalid_address' });
});
