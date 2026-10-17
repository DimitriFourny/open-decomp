import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_ANALYSIS_OPTIONS,
  DEFAULT_BUDGET,
  SCHEMA_VERSION,
  createOperationContext,
  entityIdentity,
  fingerprint,
  newIdentity,
  validateToolResponse,
  type CacheIdentity,
  type FunctionRecord,
  type Job,
} from '../../../src/core/index.js';
import { SqliteProjectStore } from '../../../src/project/store/index.js';
import { encodeStored } from '../../../src/project/store/encoding.js';
import {
  readAnnotationCatalog,
  runCachedDecompilation,
  type AnalysisComputation,
} from '../../../src/project/cache/index.js';
import { fixtureImage } from '../../metadata/fixture.js';

async function project(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'open-decomp-cache-'));
  const state = { path, store: SqliteProjectStore.open(path, 'create') };
  t.after(async () => {
    await state.store.close();
    rmSync(path, { recursive: true, force: true });
  });
  const image = fixtureImage('metadata.dll');
  await state.store.importImage({
    bytes: image.bytes,
    sha256: image.sha256,
    selected_slice_id: image.selected_slice_id,
  });
  const entry = image.exports.find((record) => record.address !== null)!.address!;
  const fn: FunctionRecord = {
    id: entityIdentity(image.selected_slice_id, 'function', entry.value),
    entry,
    ranges: [{ start: entry, size: 1n }],
    boundary: 'candidate',
    original_name: null,
    display_name: null,
    evidence_ids: [],
    signature: null,
    analysis: 'not_analyzed',
  };
  assert.equal(
    state.store.transaction(1, (tx) => {
      tx.putImage(image);
      tx.putRecord(image.id, 'function', fn);
    }).state,
    'committed',
  );
  const identity: CacheIdentity = {
    image_sha256: image.sha256,
    slice_id: image.selected_slice_id,
    target: image.target,
    versions: {
      backend: 'cache-regression',
      loader: '1',
      decoder: '1',
      lifter: '1',
      analysis: '1',
      abi: '1',
      emitter: '1',
    },
    evidence_revision: 2,
    annotation_revision: 2,
    function_id: fn.id,
    options: DEFAULT_ANALYSIS_OPTIONS,
    budget: { ...DEFAULT_BUDGET, output_bytes: 65536 },
  };
  const versionIdentity = fingerprint(identity.versions);
  const typeId = entityIdentity(image.selected_slice_id, 'type', 'cache-boundary');
  const fieldId = entityIdentity(image.selected_slice_id, 'field', 'cache-boundary');
  const evidenceId = newIdentity('evidence');
  function computation(cache = identity, textSize = 64): AnalysisComputation {
    const typeRecord = {
      id: typeId,
      source: 'analysis' as const,
      status: 'candidate' as const,
      evidence_ids: [evidenceId],
      definition: { kind: 'unknown' as const, size: 0x20000000000001n },
      dwarf_id: 'metadata-record',
      display_name: 'display only',
    };
    return {
      result: {
        schema_version: SCHEMA_VERSION,
        project_id: state.store.project_id,
        revision: cache.annotation_revision,
        versions: cache.versions,
        options: cache.options,
        budget: cache.budget,
        artifacts: [],
        evidence: [],
        diagnostics: [],
        coverage: [
          {
            layer: 'reconstruction',
            state: 'partial',
            completed_units: 1,
            total_units: 2,
            reasons: ['Unknown indirect target'],
          },
        ],
        state: 'partial',
        reason: 'unsupported_subset',
        continuation: null,
        data: {
          delivery: 'inline',
          function_id: fn.id,
          signature: null,
          cache: 'computed',
          capabilities: [],
          emission: {
            language: 'c-like',
            emitter_version: '1',
            text: '/* storage payload */'.padEnd(textSize, ' '),
            span_unit: 'utf16',
            reconstruction: 'pseudocode',
            mappings: [],
            helpers: [],
          },
        },
      },
      catalog: {
        subjects: [
          {
            id: fn.id,
            kind: 'function',
            image_id: image.id,
            slice_id: image.selected_slice_id,
            abi: image.target.abi,
          },
          {
            id: fieldId,
            kind: 'field',
            image_id: image.id,
            slice_id: image.selected_slice_id,
            abi: image.target.abi,
          },
        ],
        types: [typeRecord],
        evidence: [
          {
            id: evidenceId,
            origin: {
              kind: 'analysis',
              analyzer: 'cache-regression',
              version: '1',
              rule: 'storage boundary',
            },
            claim: 'Derived field identity',
            revision: cache.annotation_revision,
            derived_from: [],
            conflicts_with: [],
          },
        ],
      },
    };
  }
  function job(cache = identity): Job {
    const value: Job = {
      id: newIdentity('job'),
      project_id: state.store.project_id,
      input_revision: cache.annotation_revision,
      operation: 'function_decompile',
      state: 'running',
      progress: { phase: 'analysis', completed: 0, total: 1 },
      artifacts: [],
      diagnostics: [],
      published_revision: null,
    };
    state.store.saveJob(value);
    return value;
  }
  async function run(cache = identity, inline_limit = 65536, compute = () => computation(cache)) {
    const current = job(cache);
    const result = await runCachedDecompilation(
      {
        store: state.store,
        job_id: current.id,
        identity: cache,
        context: createOperationContext({ budget: cache.budget }),
        inline_limit,
      },
      compute,
    );
    return { result, job: current };
  }
  return {
    state,
    image,
    fn,
    identity,
    typeId,
    fieldId,
    evidenceId,
    computation,
    job,
    run,
    isCurrent: (candidate: CacheIdentity) => fingerprint(candidate.versions) === versionIdentity,
  };
}

test('reopened analysis catalogs preserve opaque subjects and unsigned type sizes, and cache-hit jobs share one artifact file', async (t) => {
  const p = await project(t);
  const first = await p.run();
  assert.equal(first.result.state, 'partial');
  const handle = p.state.store.readJob(first.job.id)!.artifacts[0]!;
  assert.equal(p.state.store.readJob(first.job.id)?.progress.completed, 1);
  await p.state.store.close();
  p.state.store = SqliteProjectStore.open(p.state.path, 'resume');
  const catalog = await readAnnotationCatalog(
    p.state.store,
    2,
    [p.fieldId, p.typeId, p.evidenceId],
    createOperationContext(),
    p.isCurrent,
  );
  assert.equal(catalog?.subject(p.fieldId)?.kind, 'field');
  assert.deepEqual(catalog?.types(p.typeId)[0]?.definition, {
    kind: 'unknown',
    size: 0x20000000000001n,
  });
  assert.equal(catalog?.evidence(p.evidenceId)?.revision, 2);
  const hit = await p.run(p.identity, 65536, () => {
    assert.fail('A durable cache hit must not compute');
  });
  assert.ok('data' in hit.result);
  assert.equal(hit.result.data.cache, 'hit');
  assert.equal(hit.result.state, 'partial');
  if (hit.result.state === 'partial') assert.equal(hit.result.reason, 'unsupported_subset');
  assert.deepEqual(p.state.store.readJob(hit.job.id)?.artifacts, [handle]);
  assert.deepEqual(readdirSync(join(p.state.path, 'artifacts')), [handle.id]);
  assert.throws(() => p.state.store.readArtifactBytes({ ...handle, sha256: '0'.repeat(64) }), {
    code: 'invalid_input',
  });
  assert.throws(
    () => p.state.store.readArtifactBytes({ ...handle, project_id: newIdentity('project') }),
    { code: 'permission_denied' },
  );
});

test('artifact-only delivery is bounded before publication and later inline hits preserve semantic partialness', async (t) => {
  const p = await project(t);
  const first = await p.run(p.identity, 4096, () => p.computation(p.identity, 20000));
  assert.equal(first.result.state, 'partial');
  assert.ok('data' in first.result);
  assert.equal(first.result.data.delivery, 'artifact');
  assert.ok(Buffer.byteLength(JSON.stringify(first.result)) <= 4096);
  const responseScope = {
    project_id: p.state.store.project_id,
    revision: 2,
    function_id: p.fn.id,
    wait: true,
    delivery: 'auto' as const,
    options: p.identity.options,
    budget: p.identity.budget,
  };
  validateToolResponse('function_decompile', first.result, responseScope);
  assert.ok(first.result.state === 'partial');
  const { reason: _reason, continuation: _continuation, ...withoutPartial } = first.result;
  for (const invalid of [
    { ...withoutPartial, state: 'complete' },
    { ...first.result, reason: 'unsupported_subset' },
    { ...first.result, artifacts: [] },
    { ...first.result, data: { ...first.result.data, artifact_id: newIdentity('artifact') } },
  ])
    assert.throws(() => validateToolResponse('function_decompile', invalid, responseScope));
  const hit = await p.run();
  assert.ok('data' in hit.result);
  assert.equal(hit.result.data.delivery, 'inline');
  assert.equal(hit.result.state, 'partial');
  if (hit.result.state === 'partial') assert.equal(hit.result.reason, 'unsupported_subset');
  assert.equal(hit.result.coverage[0]?.completed_units, 1);
  assert.equal(hit.result.artifacts[0]?.id, first.result.artifacts[0]?.id);
  const boundedHit = await p.run(p.identity, 4096);
  assert.ok('data' in boundedHit.result);
  assert.equal(boundedHit.result.data.delivery, 'artifact');
  assert.equal(boundedHit.result.data.cache, 'hit');
  assert.equal(boundedHit.result.artifacts[0]?.id, first.result.artifacts[0]?.id);
  const impossibleHit = p.job();
  await assert.rejects(
    runCachedDecompilation(
      {
        store: p.state.store,
        job_id: impossibleHit.id,
        identity: p.identity,
        context: createOperationContext(),
        inline_limit: 32,
      },
      () => {
        assert.fail('A cache hit cannot compute');
      },
    ),
    { code: 'resource_limit' },
  );
  assert.equal(p.state.store.readJob(impossibleHit.id)?.state, 'running');
  const impossible = {
    ...p.identity,
    versions: { ...p.identity.versions, backend: 'cannot-frame' },
  };
  const job = p.job(impossible);
  await assert.rejects(
    runCachedDecompilation(
      {
        store: p.state.store,
        job_id: job.id,
        identity: impossible,
        context: createOperationContext(),
        inline_limit: 32,
      },
      () => p.computation(impossible),
    ),
    { code: 'resource_limit' },
  );
  assert.equal(p.state.store.findArtifact(impossible), null);
  assert.equal(p.state.store.readJob(job.id)?.state, 'running');
  assert.equal(readdirSync(join(p.state.path, 'artifacts')).length, 1);
  const cancelled = p.job();
  p.state.store.saveJob({ ...cancelled, state: 'cancelled' });
  await assert.rejects(
    runCachedDecompilation(
      {
        store: p.state.store,
        job_id: cancelled.id,
        identity: p.identity,
        context: createOperationContext(),
        inline_limit: 65536,
      },
      () => {
        assert.fail('Cancelled cache hits cannot compute');
      },
    ),
    { code: 'cancelled' },
  );
  assert.equal(p.state.store.readJob(cancelled.id)?.state, 'cancelled');
});

test('original budget, options, versions and target features invalidate cache identities', async (t) => {
  const p = await project(t);
  let computed = 0;
  const variants: CacheIdentity[] = [
    p.identity,
    {
      ...p.identity,
      budget: { ...p.identity.budget, deadline_ms: p.identity.budget.deadline_ms + 1 },
    },
    { ...p.identity, versions: { ...p.identity.versions, analysis: '2' } },
    {
      ...p.identity,
      options: { ...p.identity.options, include_evidence: !p.identity.options.include_evidence },
    },
  ];
  const handles = new Set<string>();
  for (const identity of variants) {
    const result = await p.run(identity, 65536, () => {
      computed++;
      return p.computation(identity);
    });
    handles.add(result.result.artifacts[0]!.id);
  }
  assert.equal(computed, variants.length);
  assert.equal(handles.size, variants.length);
  const current = p.job();
  const reduced = createOperationContext({ budget: { ...p.identity.budget, deadline_ms: 10000 } });
  const hit = await runCachedDecompilation(
    {
      store: p.state.store,
      job_id: current.id,
      identity: p.identity,
      context: reduced,
      inline_limit: 65536,
    },
    () => {
      assert.fail('Remaining deadline must not change cache identity');
    },
  );
  assert.ok('data' in hit);
  assert.equal(hit.data.cache, 'hit');
  const foreignFeatures = {
    ...p.identity,
    target: { ...p.identity.target, features: ['unselected-feature'] },
  };
  await assert.rejects(p.run(foreignFeatures), { code: 'invalid_input' });
  assert.equal(p.state.store.findArtifact(foreignFeatures), null);
});

test('component upgrades cannot authorize or merge stale same-revision semantic catalogs', async (t) => {
  const p = await project(t);
  await p.run();
  for (const component of Object.keys(p.identity.versions) as (keyof CacheIdentity['versions'])[]) {
    const expected = fingerprint({ ...p.identity.versions, [component]: 'upgraded' });
    assert.equal(
      await readAnnotationCatalog(
        p.state.store,
        2,
        [p.fieldId],
        createOperationContext(),
        (candidate) => fingerprint(candidate.versions) === expected,
      ),
      undefined,
    );
  }
  const next = { ...p.identity, versions: { ...p.identity.versions, analysis: '2' } };
  const computed = p.computation(next);
  const value: AnalysisComputation = {
    ...computed,
    catalog: {
      ...computed.catalog,
      types: [{ ...computed.catalog.types[0]!, definition: { kind: 'unknown', size: 8n } }],
    },
  };
  await p.run(next, 65536, () => value);
  const expected = fingerprint(next.versions);
  const catalog = await readAnnotationCatalog(
    p.state.store,
    2,
    [p.fieldId, p.typeId],
    createOperationContext(),
    (candidate) => fingerprint(candidate.versions) === expected,
  );
  assert.equal(catalog?.subject(p.fieldId)?.kind, 'field');
  assert.deepEqual(
    catalog?.types(p.typeId).map((record) => record.definition),
    [{ kind: 'unknown', size: 8n }],
  );
});

test('publication validates every catalog subject against its exact function and target scope', async (t) => {
  type Subjects = AnalysisComputation['catalog']['subjects'];
  const other = (id: string): string => `${id.slice(0, -1)}${id.endsWith('0') ? '1' : '0'}`;
  const corruptions: readonly [string, (subjects: Subjects) => Subjects][] = [
    ['foreign image', (subjects) => subjects.map((subject, index) =>
      index === 1 ? { ...subject, image_id: other(subject.image_id) } : subject)],
    ['foreign slice', (subjects) => subjects.map((subject, index) =>
      index === 1 ? { ...subject, slice_id: other(subject.slice_id) } : subject)],
    ['mixed ABI', (subjects) => subjects.map((subject, index) =>
      index === 1 ? { ...subject, abi: subject.abi === 'sysv-amd64'
        ? 'windows-x64' as const : 'sysv-amd64' as const } : subject)],
    ['missing function', (subjects) => subjects.filter((subject) => subject.kind !== 'function')],
    ['function impostor', (subjects) => subjects.map((subject, index) =>
      index === 0 ? { ...subject, kind: 'value' as const } : subject)],
    ['empty subjects', () => []],
    ['ambiguous duplicate', (subjects) => [...subjects, { ...subjects[0]!, kind: 'call' as const }]],
  ];
  for (const [name, corrupt] of corruptions) await t.test(name, async (t) => {
    const p = await project(t), computation = p.computation(), job = p.job();
    await assert.rejects(runCachedDecompilation({
      store: p.state.store, job_id: job.id, identity: p.identity,
      context: createOperationContext({ budget: p.identity.budget }),
      inline_limit: 65536,
    }, () => ({ ...computation,
      catalog: { ...computation.catalog, subjects: corrupt(computation.catalog.subjects) },
    })), { code: 'invalid_input' });
    assert.equal(p.state.store.findArtifact(p.identity), null);
    assert.equal(p.state.store.readJob(job.id)?.state, 'running');
    assert.equal(readdirSync(join(p.state.path, 'artifacts')).length, 0);
  });
});

test('bounded publication visits catalog subjects once while retaining every published identity', async (t) => {
  const p = await project(t);
  const identity = { ...p.identity, budget: { ...p.identity.budget, work: 600 } };
  const computation = p.computation(identity), template = computation.catalog.subjects[1]!;
  const subjects = [...computation.catalog.subjects,
    ...Array.from({ length: 500 }, (_, index) => ({ ...template,
      id: entityIdentity(p.image.selected_slice_id, 'field', ['catalog-work', index]),
    }))];
  const published = await p.run(identity, 65536, () => ({ ...computation,
    catalog: { ...computation.catalog, subjects },
  }));
  assert.equal(p.state.store.readJob(published.job.id)?.state, 'completed');
  const restored = await readAnnotationCatalog(p.state.store, 2,
    subjects.map((subject) => subject.id), createOperationContext(), p.isCurrent);
  for (const subject of subjects)
    assert.equal(restored?.subject(subject.id)?.kind, subject.kind);
});

test('cancellation, stale computation and forged full-result metadata never publish success', async (t) => {
  const p = await project(t);
  const cancelled = p.job();
  await assert.rejects(
    runCachedDecompilation(
      {
        store: p.state.store,
        job_id: cancelled.id,
        identity: p.identity,
        context: createOperationContext(),
        inline_limit: 65536,
      },
      () => {
        p.state.store.saveJob({ ...cancelled, state: 'cancelled' });
        return p.computation();
      },
    ),
    { code: 'cancelled' },
  );
  assert.equal(p.state.store.findArtifact(p.identity), null);
  const controller = new AbortController(),
    aborted = p.job();
  await assert.rejects(
    runCachedDecompilation(
      {
        store: p.state.store,
        job_id: aborted.id,
        identity: p.identity,
        context: createOperationContext({ signal: controller.signal }),
        inline_limit: 65536,
      },
      () => {
        controller.abort();
        return p.computation();
      },
    ),
    { code: 'cancelled' },
  );
  const forged = p.job();
  await assert.rejects(
    runCachedDecompilation(
      {
        store: p.state.store,
        job_id: forged.id,
        identity: p.identity,
        context: createOperationContext(),
        inline_limit: 65536,
      },
      () => {
        const value = p.computation();
        return { ...value, result: { ...value.result, budget: DEFAULT_BUDGET } };
      },
    ),
    { code: 'invalid_input' },
  );
  for (const emission of [
    { ...p.computation().result.data.emission, language: 'python-like' as const },
    { ...p.computation().result.data.emission, emitter_version: 'stale-emitter' },
  ]) {
    const mismatched = p.job();
    await assert.rejects(
      runCachedDecompilation(
        {
          store: p.state.store,
          job_id: mismatched.id,
          identity: p.identity,
          context: createOperationContext(),
          inline_limit: 65536,
        },
        () => {
          const value = p.computation();
          return {
            ...value,
            result: { ...value.result, data: { ...value.result.data, emission } },
          };
        },
      ),
      {
        code: 'invalid_input',
        message: 'Stored emission dialect/version does not match its cache identity',
      },
    );
    assert.equal(p.state.store.findArtifact(p.identity), null);
    assert.equal(p.state.store.readJob(mismatched.id)?.state, 'running');
  }
  const stale = p.job();
  await assert.rejects(
    runCachedDecompilation(
      {
        store: p.state.store,
        job_id: stale.id,
        identity: p.identity,
        context: createOperationContext(),
        inline_limit: 65536,
      },
      () => {
        p.state.store.transaction(2, () => {});
        return p.computation();
      },
    ),
    { code: 'stale_revision' },
  );
  assert.equal(readdirSync(join(p.state.path, 'artifacts')).length, 0);
  assert.notEqual(p.state.store.readJob(stale.id)?.state, 'completed');
});

test('catalog index pages are exact-snapshot and bind project, identities and page size', async (t) => {
  const p = await project(t),
    other = await project(t);
  await p.run();
  await p.run({ ...p.identity, versions: { ...p.identity.versions, analysis: '2' } });
  const query = { revision: 2, ids: [p.fieldId], limit: 1 };
  const first = p.state.store.findAnalysisArtifacts(query);
  assert.ok(first.next_cursor);
  const second = p.state.store.findAnalysisArtifacts({ ...query, cursor: first.next_cursor });
  assert.equal(second.items.length, 1);
  assert.equal(second.next_cursor, null);
  assert.notEqual(first.items[0]?.id, second.items[0]?.id);
  assert.throws(
    () =>
      p.state.store.findAnalysisArtifacts({
        ...query,
        ids: [p.typeId],
        cursor: first.next_cursor!,
      }),
    { code: 'stale_cursor' },
  );
  assert.throws(
    () => p.state.store.findAnalysisArtifacts({ ...query, limit: 2, cursor: first.next_cursor! }),
    { code: 'stale_cursor' },
  );
  assert.throws(
    () => other.state.store.findAnalysisArtifacts({ ...query, cursor: first.next_cursor! }),
    { code: 'stale_cursor' },
  );
  assert.deepEqual(p.state.store.findAnalysisArtifacts({ ...query, ids: [] }).items, []);
  assert.equal(
    p.state.store.findAnalysisArtifacts({ ...query, ids: [p.evidenceId], limit: 10 }).items.length,
    2,
  );
  p.state.store.transaction(2, () => {});
  assert.deepEqual(p.state.store.findAnalysisArtifacts({ ...query, revision: 3 }).items, []);
  assert.equal(
    await readAnnotationCatalog(
      p.state.store,
      3,
      [p.fieldId],
      createOperationContext(),
      p.isCurrent,
    ),
    undefined,
  );
  await assert.rejects(
    readAnnotationCatalog(p.state.store, 2, [p.fieldId], createOperationContext(), p.isCurrent),
    { code: 'stale_revision' },
  );
});

test('stored hash corruption cannot complete cache-hit jobs or reconstruct trusted catalogs', async (t) => {
  const p = await project(t),
    first = await p.run();
  const artifact = p.state.store.readJob(first.job.id)!.artifacts[0]!;
  writeFileSync(
    join(p.state.path, 'artifacts', artifact.id),
    Buffer.alloc(Number(artifact.size), 0x20),
  );
  const hit = p.job();
  await assert.rejects(
    runCachedDecompilation(
      {
        store: p.state.store,
        job_id: hit.id,
        identity: p.identity,
        context: createOperationContext(),
        inline_limit: 65536,
      },
      () => {
        assert.fail('Corruption must not be treated as a miss');
      },
    ),
    { code: 'invalid_input' },
  );
  assert.equal(p.state.store.readJob(hit.id)?.state, 'running');
  await assert.rejects(
    readAnnotationCatalog(p.state.store, 2, [p.fieldId], createOperationContext(), p.isCurrent),
    { code: 'invalid_input' },
  );
});

test('original response and full-artifact byte boundaries reject before creating durable success', async (t) => {
  const p = await project(t);
  const tiny = { ...p.identity, budget: { ...p.identity.budget, output_bytes: 1024 } };
  const tinyJob = p.job(tiny);
  await assert.rejects(
    runCachedDecompilation(
      {
        store: p.state.store,
        job_id: tinyJob.id,
        identity: tiny,
        context: createOperationContext(),
        inline_limit: 65536,
      },
      () => p.computation(tiny, 20000),
    ),
    { code: 'resource_limit' },
  );
  assert.equal(p.state.store.findArtifact(tiny), null);
  assert.equal(p.state.store.readJob(tinyJob.id)?.state, 'running');
  const oversized = p.job();
  await assert.rejects(
    runCachedDecompilation(
      {
        store: p.state.store,
        job_id: oversized.id,
        identity: p.identity,
        context: createOperationContext(),
        inline_limit: 65536,
      },
      () => p.computation(p.identity, 16 * 1024 * 1024),
    ),
    { code: 'resource_limit' },
  );
  assert.equal(p.state.store.findArtifact(p.identity), null);
  assert.equal(readdirSync(join(p.state.path, 'artifacts')).length, 0);
});

test('schema-2 migration preserves artifacts, jobs, revisions and removal actors without inventing an old catalog index', async (t) => {
  const p = await project(t),
    published = await p.run();
  const artifact = p.state.store.readJob(published.job.id)!.artifacts[0]!;
  const annotation = newIdentity('annotation');
  p.state.store.applyAnnotations({
    expected_revision: 2,
    author: 'prior-author',
    origin: 'user',
    edits: [
      {
        operation: 'set',
        id: annotation,
        entity_id: p.fn.id,
        value: { kind: 'note', value: 'preserved' },
        status: 'asserted',
        evidence_ids: [],
      },
    ],
  });
  p.state.store.applyAnnotations({
    expected_revision: 3,
    author: 'prior-remover',
    origin: 'llm',
    edits: [{ operation: 'remove', id: annotation }],
  });
  const snapshot = p.state.store.snapshot();
  await p.state.store.close();
  const db = new DatabaseSync(join(p.state.path, 'project.sqlite'));
  const { bytes: _bytes, address_map: _map, ...legacyMetadata } = p.image;
  db.prepare('UPDATE loaded_images SET payload=?').run(encodeStored(legacyMetadata));
  db.exec('DROP TABLE analysis_artifacts; DROP TABLE loaded_image_records; DROP TABLE analysis_reuse; DROP INDEX records_scope_revision; DROP INDEX loaded_images_revision; PRAGMA user_version=2;');
  db.close();
  p.state.store = SqliteProjectStore.open(p.state.path, 'resume');
  assert.equal(p.state.store.snapshot().revision, snapshot.revision);
  assert.equal(p.state.store.project_id, snapshot.project_id);
  assert.deepEqual(p.state.store.readJob(published.job.id)?.artifacts, [artifact]);
  assert.equal(p.state.store.readArtifactBytes(artifact).length, Number(artifact.size));
  assert.deepEqual(
    p.state.store
      .queryAnnotationHistory({ id: annotation, revision: 4, limit: 10 })
      .items.map((item) => item.actor),
    [
      { author: 'prior-author', origin: 'user' },
      { author: 'prior-remover', origin: 'llm' },
    ],
  );
  assert.deepEqual(
    p.state.store.findAnalysisArtifacts({ revision: 2, ids: [p.fieldId], limit: 10 }).items,
    [],
  );
  const current = { ...p.identity, annotation_revision: 4, evidence_revision: 4 };
  await p.run(current);
  assert.equal(
    (
      await readAnnotationCatalog(
        p.state.store,
        4,
        [p.fieldId],
        createOperationContext(),
        p.isCurrent,
      )
    )?.subject(p.fieldId)?.kind,
    'field',
  );
});

test('a real SQLite index insertion failure rolls back artifact and terminal-job publication together', async (t) => {
  const p = await project(t);
  await p.state.store.close();
  const db = new DatabaseSync(join(p.state.path, 'project.sqlite'));
  db.exec(
    "CREATE TRIGGER reject_catalog BEFORE INSERT ON analysis_artifacts BEGIN SELECT RAISE(ABORT, 'interrupted publication'); END;",
  );
  db.close();
  p.state.store = SqliteProjectStore.open(p.state.path, 'resume');
  const job = p.job();
  await assert.rejects(
    runCachedDecompilation(
      {
        store: p.state.store,
        job_id: job.id,
        identity: p.identity,
        context: createOperationContext(),
        inline_limit: 65536,
      },
      () => p.computation(),
    ),
  );
  assert.equal(p.state.store.readJob(job.id)?.state, 'running');
  assert.equal(p.state.store.findArtifact(p.identity), null);
  assert.deepEqual(
    p.state.store.findAnalysisArtifacts({ revision: 2, ids: [p.fieldId], limit: 10 }).items,
    [],
  );
  assert.equal(readdirSync(join(p.state.path, 'artifacts')).length, 0);
});
