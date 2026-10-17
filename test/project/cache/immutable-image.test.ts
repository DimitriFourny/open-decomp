import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_ANALYSIS_OPTIONS,
  DEFAULT_BUDGET,
  SCHEMA_VERSION,
  createOperationContext,
  entityIdentity,
  newIdentity,
  type CacheIdentity,
  type FunctionRecord,
  type LoadedImage,
} from '../../../src/core/index.js';
import { SqliteProjectStore } from '../../../src/project/store/index.js';
import {
  readAnnotationCatalog,
  runCachedDecompilation,
  type AnalysisComputation,
} from '../../../src/project/cache/index.js';
import { fixtureImage } from '../../metadata/fixture.js';

test('SQLite cache hits and annotation catalogs reuse immutable image facts without weakening validation', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'open-decomp-immutable-cache-'));
  const store = SqliteProjectStore.open(path, 'create');
  t.after(async () => {
    await store.close();
    rmSync(path, { recursive: true, force: true });
  });
  const image = fixtureImage('metadata.dll');
  await store.importImage({
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
  const valueId = entityIdentity(image.selected_slice_id, 'value', 'cached-value');
  // Unrelated image-wide data must not be decoded/revalidated for every catalog read.
  const large = {
    ...image,
    headers: Array.from({ length: 100 }, (_, index) => ({
      ...image.headers[0]!,
      name: `header-${index}`,
      fields: [{ kind: 'text' as const, name: 'unrelated', value: 'x'.repeat(8192) }],
    })),
  };
  assert.equal(
    store.transaction(1, (tx) => {
      tx.putImage(large);
      tx.putRecord(image.id, 'function', fn);
    }).state,
    'committed',
  );
  const identity: CacheIdentity = {
    image_sha256: image.sha256,
    slice_id: image.selected_slice_id,
    target: image.target,
    versions: {
      backend: 'immutable-cache-test',
      loader: '1',
      decoder: '1',
      lifter: '1',
      analysis: '1',
      abi: '1',
      emitter: '1',
    },
    annotation_revision: 2,
    evidence_revision: 2,
    function_id: fn.id,
    options: DEFAULT_ANALYSIS_OPTIONS,
    budget: DEFAULT_BUDGET,
  };
  const computation: AnalysisComputation = {
    result: {
      schema_version: SCHEMA_VERSION,
      project_id: store.project_id,
      revision: 2,
      versions: identity.versions,
      options: identity.options,
      budget: identity.budget,
      state: 'complete',
      artifacts: [],
      evidence: [],
      diagnostics: [],
      coverage: [],
      data: {
        delivery: 'inline',
        function_id: fn.id,
        signature: null,
        cache: 'computed',
        capabilities: [],
        emission: {
          language: 'c-like',
          emitter_version: '1',
          text: 'return 1;',
          span_unit: 'utf16',
          reconstruction: 'pseudocode',
          ids: [],
          evidence: [],
          ranges: [],
          mappings: [],
          helpers: [],
          review: { operation: 'function_get', view: 'metadata', function_id: fn.id },
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
          id: valueId,
          kind: 'value',
          image_id: image.id,
          slice_id: image.selected_slice_id,
          abi: image.target.abi,
        },
      ],
      types: [],
      evidence: [],
    },
  };
  const loaded: LoadedImage[] = [];
  const original = store.readLoadedImage.bind(store);
  store.readLoadedImage = (...args) => {
    const result = original(...args);
    loaded.push(result);
    return result;
  };
  async function run(compute: () => AnalysisComputation) {
    const id = newIdentity('job');
    store.saveJob({
      id,
      project_id: store.project_id,
      input_revision: 2,
      operation: 'function_decompile',
      state: 'running',
      progress: { phase: 'analysis', completed: 0, total: 1 },
      artifacts: [],
      diagnostics: [],
      published_revision: null,
    });
    return runCachedDecompilation(
      {
        store,
        job_id: id,
        identity,
        context: createOperationContext(),
        inline_limit: DEFAULT_BUDGET.output_bytes,
      },
      compute,
    );
  }
  const computed = await run(() => computation);
  const hit = await run(() => assert.fail('A cache hit must not recompute'));
  assert.ok('data' in computed && 'data' in hit);
  assert.equal(hit.data.cache, 'hit');
  assert.deepEqual({ ...hit.data, cache: 'computed' }, computed.data);
  const catalog = await readAnnotationCatalog(
    store,
    2,
    [valueId],
    createOperationContext(),
    () => true,
  );
  assert.equal(catalog?.subject(valueId)?.kind, 'value');
  assert.ok(loaded.length >= 5, 'all cache/catalog validation paths are exercised');
  assert.equal(
    new Set(loaded).size,
    1,
    'catalog validation must reuse one immutable materialization',
  );
  const first = loaded[0]!;
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.target));
  assert.ok(Object.isFrozen(first.headers[0]!.fields));
  assert.throws(() => {
    (first.target.features as string[]).push('forged');
  }, TypeError);
  assert.equal(
    store.transaction(2, (tx) =>
      tx.putImage({
        ...image,
        diagnostics: [
          {
            code: 'unavailable_semantics',
            severity: 'warning',
            message: 'new metadata revision',
            evidence_ids: [],
          },
        ],
      }),
    ).state,
    'committed',
  );
  assert.equal(store.readLoadedImage(image.id, image.selected_slice_id, 2), first);
  const current = store.readLoadedImage(image.id, image.selected_slice_id, 3);
  assert.notEqual(current, first);
  assert.equal(current.diagnostics[0]?.message, 'new metadata revision');
  assert.equal(store.readLoadedImage(image.id, image.selected_slice_id, 2), first);
  assert.throws(() => store.readLoadedImage(image.id, image.selected_slice_id, 4), {
    code: 'stale_revision',
  });
  // Warm materialization cannot bypass the immutable-file SHA-256 check.
  writeFileSync(join(path, 'images', image.sha256), Buffer.alloc(image.bytes.length, 0));
  assert.throws(() => store.readLoadedImage(image.id, image.selected_slice_id, 2), {
    code: 'invalid_input',
  });
});
