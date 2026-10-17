import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  ImmutableBytes,
  cacheIdentitySchema,
  contentHash,
  createOperationContext,
  entityIdentity,
  imageIdentity,
  newIdentity,
  toolSchemas,
  type CacheIdentity,
  type Job,
  type OperationContext,
} from '../../src/core/index.js';
import { MachOLoader } from '../../src/loaders/macho/index.js';
import { AnnotationService } from '../../src/project/annotations/index.js';
import { SqliteProjectStore } from '../../src/project/store/index.js';
import {
  createAnalysisReadset,
  readAnalysisArtifact,
  runCachedDecompilation,
  validateAnalysisReadset,
} from '../../src/project/cache/index.js';
import { prepareQueryImport } from '../../src/service/queries/prepare.js';
import { executeDecompilation } from '../../src/service/analysis/index.js';

// Actual source runtime + real SQLite, no repository test runner or analyzed execution.
// node --import tsx scripts/bench/incremental-dependencies.ts /new/retained/output-dir
const output = resolve(process.argv[2]!);
assert.ok(process.argv[2]);
await mkdir(output, { recursive: false });
const path = join(output, 'project');
const raw = await readFile('fixtures/bin/macho-arm64-symbols'),
  sha256 = contentHash(raw);
const image = new MachOLoader().load(
  { bytes: new ImmutableBytes(raw), sha256, image_id: imageIdentity(sha256), slice_id: null },
  createOperationContext(),
);
let store = SqliteProjectStore.open(path, 'create');
const checks: string[] = [];
try {
  await store.importImage({
    bytes: image.bytes,
    sha256,
    selected_slice_id: image.selected_slice_id,
  });
  const prepared = await prepareQueryImport(image, {
    revision: 2,
    context: createOperationContext(),
  });
  assert.equal(
    store.transaction(1, (tx) => {
      tx.putImage(prepared.image);
      prepared.publish(tx);
    }).state,
    'committed',
  );
  const functions = store.queryRecords({
    revision: 2,
    image_id: image.id,
    kind: 'function',
    limit: 1000,
  }).items;
  const a = functions.find((fn) => fn.original_name === '_fixture_arithmetic')!,
    b = functions.find((fn) => fn.original_name === '_fixture_maximum')!;
  assert.ok(a && b);
  function job(revision: number): Job {
    const value: Job = {
      id: newIdentity('job'),
      project_id: store.project_id,
      input_revision: revision,
      operation: 'function_decompile',
      state: 'running',
      progress: { phase: 'running', completed: 0, total: null },
      diagnostics: [],
      artifacts: [],
      published_revision: null,
    };
    store.saveJob(value);
    return value;
  }
  async function decompile(id: string, context?: OperationContext) {
    const args = toolSchemas.function_decompile.input.parse({
      project_id: store.project_id,
      revision: store.snapshot().revision,
      function_id: id,
    });
    const current = job(args.revision);
    const result = await executeDecompilation(args, {
      store,
      job_id: current.id,
      context: context ?? createOperationContext({ budget: args.budget }),
    });
    assert.ok('data' in result);
    const artifact = store.readJob(current.id)!.artifacts[0]!;
    const payload = readAnalysisArtifact(store, artifact, createOperationContext());
    return { result, artifact, payload };
  }
  function unrelatedNote() {
    const revision = store.snapshot().revision;
    const result = new AnnotationService(store).apply(
      {
        expected_revision: revision,
        author: 'incremental-safety-oracle',
        origin: 'user',
        edits: [
          {
            operation: 'set',
            id: newIdentity('annotation'),
            entity_id: a.id,
            value: { kind: 'note', value: `Unrelated review at ${revision}` },
            status: 'asserted',
            evidence_ids: [],
          },
        ],
      },
      createOperationContext(),
    );
    assert.equal(result.state, 'committed');
  }
  const baseline = await decompile(b.id);
  assert.ok(baseline.payload.dependencies);
  const originalBytes = store.readArtifactBytes(baseline.artifact);
  const initialIdentity = cacheIdentitySchema.parse(baseline.payload.identity);
  unrelatedNote();
  const nextIdentity: CacheIdentity = {
    ...initialIdentity,
    annotation_revision: store.snapshot().revision,
    evidence_revision: store.snapshot().revision,
  };
  assert.equal(store.findArtifact(initialIdentity), null);
  assert.deepEqual(store.findHistoricalArtifact(initialIdentity), baseline.artifact);
  assert.equal(store.findArtifact(nextIdentity), null);
  assert.ok(store.findReuseCandidates(nextIdentity, 8).length > 0);
  const mismatches: CacheIdentity[] = [
    {
      ...nextIdentity,
      target: {
        ...nextIdentity.target,
        features: [...nextIdentity.target.features, 'different-feature'],
      },
    },
    {
      ...nextIdentity,
      slice_id: `${nextIdentity.slice_id.slice(0, -1)}${nextIdentity.slice_id.endsWith('0') ? '1' : '0'}`,
    },
    ...Object.keys(nextIdentity.versions).map((component) => ({
      ...nextIdentity,
      versions: { ...nextIdentity.versions, [component]: 'different-component' },
    })),
    {
      ...nextIdentity,
      options: {
        ...nextIdentity.options,
        include_evidence: !nextIdentity.options.include_evidence,
      },
    },
    ...Object.keys(nextIdentity.budget).map((capacity) => ({
      ...nextIdentity,
      budget: {
        ...nextIdentity.budget,
        [capacity]: nextIdentity.budget[capacity as keyof typeof nextIdentity.budget] + 1,
      },
    })),
  ];
  for (const mismatch of mismatches) assert.equal(store.findReuseCandidates(mismatch, 8).length, 0);
  checks.push(
    `${mismatches.length} full target/slice/component/options/budget scope mismatches miss; global identity remains exact`,
  );
  const beforeFiles = await readdir(join(path, 'artifacts'));
  const current = job(nextIdentity.annotation_revision),
    controller = new AbortController();
  const context = createOperationContext({
    signal: controller.signal,
    onProgress(phase) {
      if (phase === 'dependency-reuse') {
        store.saveJob({ ...current, state: 'cancelled' });
        controller.abort();
      }
    },
  });
  const args = toolSchemas.function_decompile.input.parse({
    project_id: store.project_id,
    revision: nextIdentity.annotation_revision,
    function_id: b.id,
  });
  await assert.rejects(executeDecompilation(args, { store, job_id: current.id, context }), {
    code: 'cancelled',
  });
  assert.equal(store.findArtifact(nextIdentity), null);
  assert.deepEqual(await readdir(join(path, 'artifacts')), beforeFiles);
  assert.equal(store.readJob(current.id)?.state, 'cancelled');
  checks.push(
    'Cancellation during validated reuse publishes no artifact/catalog/file and leaves cancelled job terminal',
  );
  const stale = job(store.snapshot().revision);
  let changedRevision = false;
  const staleContext = createOperationContext({
    onProgress(phase) {
      if (phase === 'dependency-reuse' && !changedRevision) {
        changedRevision = true;
        unrelatedNote();
      }
    },
  });
  await assert.rejects(
    executeDecompilation(args, { store, job_id: stale.id, context: staleContext }),
    { code: 'stale_revision' },
  );
  assert.equal(store.findArtifact(nextIdentity), null);
  assert.deepEqual(await readdir(join(path, 'artifacts')), beforeFiles);
  checks.push(
    'Revision change during reuse validation prevents stale artifact/catalog publication',
  );
  const reused = await decompile(b.id);
  assert.equal(reused.result.data.cache, 'hit');
  assert.notEqual(reused.artifact.id, baseline.artifact.id);
  assert.deepEqual(store.readArtifactBytes(baseline.artifact), originalBytes);
  checks.push(
    'Validated unchanged result republished with new revision/identity and immutable original history',
  );
  await store.close();
  store = SqliteProjectStore.open(path, 'resume');
  unrelatedNote();
  const reopened = await decompile(b.id);
  assert.equal(reopened.result.data.cache, 'hit');
  checks.push('Reopen retains indexed candidate history and complete readsets');
  unrelatedNote();
  const artifactPath = join(path, 'artifacts', reopened.artifact.id),
    saved = await readFile(artifactPath);
  const changed = Buffer.from(saved);
  changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
  await writeFile(artifactPath, changed);
  await assert.rejects(decompile(b.id), { code: 'invalid_input' });
  await writeFile(artifactPath, saved);
  checks.push('Historical candidate artifact SHA256 tamper fails closed before publication');
  const imagePath = join(path, 'images', image.sha256),
    imageSaved = await readFile(imagePath);
  const imageChanged = Buffer.from(imageSaved);
  imageChanged[imageChanged.length - 1] = imageChanged[imageChanged.length - 1]! ^ 1;
  await writeFile(imagePath, imageChanged);
  await assert.rejects(decompile(b.id), { code: 'invalid_input' });
  await writeFile(imagePath, imageSaved);
  checks.push('Imported image tamper fails despite retained immutable metadata cache');

  // Durable source/type/proof and unknown->known frontier dependencies use the
  // same collector/validator as the actual decompilation above, including absence.
  const missingType = entityIdentity(
    image.selected_slice_id,
    'incremental-negative-type',
    'missing',
  );
  const missingProof = newIdentity('evidence');
  const missingFunction = entityIdentity(
    image.selected_slice_id,
    'incremental-negative-function',
    'missing',
  );
  let revision = store.snapshot().revision;
  let dependencies = createAnalysisReadset(store, revision, createOperationContext());
  dependencies.store.readType(missingType, revision);
  dependencies.store.readSignature(missingFunction, revision);
  dependencies.store.readEvidence([missingProof], revision);
  dependencies.recordAnnotationScope([b.id], [missingType]);
  dependencies.recordFunctionQuery(image.id, { ...b.entry, value: b.entry.value + 1n }, []);
  let ledger = dependencies.finish();
  assert.equal(validateAnalysisReadset(store, revision, ledger, createOperationContext()), true);
  assert.equal(
    store.transaction(revision, (tx) =>
      tx.putType(missingType, { kind: 'integer', bits: 32, signed: false }, []),
    ).state,
    'committed',
  );
  assert.equal(
    validateAnalysisReadset(store, revision + 1, ledger, createOperationContext()),
    false,
  );
  checks.push('Absent durable type insertion invalidates a previously complete negative readset');
  const sharedType = entityIdentity(
    image.selected_slice_id,
    'incremental-shared-type',
    'previously-absent',
  );
  const declaration = newIdentity('annotation');
  revision = store.snapshot().revision;
  dependencies = createAnalysisReadset(store, revision, createOperationContext());
  dependencies.recordAnnotationScope([b.id], [sharedType]);
  ledger = dependencies.finish();
  assert.equal(
    new AnnotationService(store).apply(
      {
        expected_revision: revision,
        author: 'incremental-safety-oracle',
        origin: 'llm',
        edits: [
          {
            operation: 'set',
            id: declaration,
            entity_id: a.id,
            value: {
              kind: 'type',
              type_id: sharedType,
              definition: { kind: 'integer', bits: 32, signed: false },
            },
            status: 'hypothesis',
            evidence_ids: [],
          },
        ],
      },
      createOperationContext(),
    ).state,
    'committed',
  );
  assert.equal(
    validateAnalysisReadset(store, revision + 1, ledger, createOperationContext()),
    false,
  );
  revision = store.snapshot().revision;
  dependencies = createAnalysisReadset(store, revision, createOperationContext());
  dependencies.recordAnnotationScope([b.id], [sharedType]);
  ledger = dependencies.finish();
  assert.equal(
    new AnnotationService(store).apply(
      {
        expected_revision: revision,
        author: 'incremental-safety-oracle',
        origin: 'llm',
        edits: [{ operation: 'retract', id: declaration }],
      },
      createOperationContext(),
    ).state,
    'committed',
  );
  assert.equal(
    validateAnalysisReadset(store, revision + 1, ledger, createOperationContext()),
    false,
  );
  checks.push(
    'Absent shared declaration insertion and hypothesis retraction invalidate scoped type reads without promoting the hypothesis',
  );
  revision = store.snapshot().revision;
  dependencies = createAnalysisReadset(store, revision, createOperationContext());
  dependencies.store.readEvidence([missingProof], revision);
  ledger = dependencies.finish();
  assert.equal(
    store.transaction(revision, (tx) =>
      tx.putEvidence({
        id: missingProof,
        origin: {
          kind: 'analysis',
          analyzer: 'incremental-safety-oracle',
          version: '1',
          rule: 'positive-negative proof closure',
        },
        claim: 'Durable reviewed test proof',
        derived_from: [],
        conflicts_with: [],
        revision: revision + 1,
      }),
    ).state,
    'committed',
  );
  assert.equal(
    validateAnalysisReadset(store, revision + 1, ledger, createOperationContext()),
    false,
  );
  checks.push('Absent proof insertion invalidates a negative proof read');
  revision = store.snapshot().revision;
  dependencies = createAnalysisReadset(store, revision, createOperationContext());
  dependencies.recordFunction(image.id, missingFunction, null);
  dependencies.recordFunctionQuery(image.id, a.entry, [a]);
  ledger = dependencies.finish();
  assert.equal(
    store.transaction(revision, (tx) =>
      tx.putRecord(image.id, 'function', {
        ...a,
        id: missingFunction,
        original_name: null,
        display_name: null,
        boundary: 'candidate',
      }),
    ).state,
    'committed',
  );
  assert.equal(
    validateAnalysisReadset(store, revision + 1, ledger, createOperationContext()),
    false,
  );
  checks.push(
    'Previously absent native function identity and newly ambiguous entry frontier invalidate the readset',
  );
  // A real previous computation can deliberately be persisted in the pre-ledger
  // artifact format. It must remain exact-revision-only, never guessed/backfilled.
  const legacyRevision = store.snapshot().revision;
  const legacyIdentity = {
    ...initialIdentity,
    annotation_revision: legacyRevision,
    evidence_revision: legacyRevision,
  };
  const legacyJob = job(legacyRevision);
  const legacy = await runCachedDecompilation(
    {
      store,
      job_id: legacyJob.id,
      identity: legacyIdentity,
      context: createOperationContext(),
      inline_limit: 65536,
    },
    () => ({
      result: { ...baseline.payload.result, revision: legacyRevision },
      catalog: baseline.payload.catalog,
    }),
  );
  assert.ok('data' in legacy && legacy.data.cache === 'computed');
  unrelatedNote();
  const oldIdentity = {
    ...legacyIdentity,
    annotation_revision: store.snapshot().revision,
    evidence_revision: store.snapshot().revision,
  };
  // All older ledger candidates are now invalidated by the native frontier edit;
  // the newest legacy artifact has no ledger and was not indexed for reuse.
  assert.equal(
    store
      .findReuseCandidates(oldIdentity, 8)
      .some((candidate) => candidate.id === legacy.artifacts[0]!.id),
    false,
  );
  const afterLegacy = await decompile(b.id);
  assert.equal(afterLegacy.result.data.cache, 'computed');
  checks.push(
    'Actual old-format semantic artifact without a ledger is a conservative cross-revision miss',
  );
  const sourceType = entityIdentity(image.selected_slice_id, 'incremental-source-type', 'signed32');
  const sourceProof = newIdentity('evidence');
  revision = store.snapshot().revision;
  assert.equal(
    store.transaction(revision, (tx) => {
      tx.putEvidence({
        id: sourceProof,
        origin: {
          kind: 'analysis',
          analyzer: 'incremental-safety-oracle',
          version: '1',
          rule: 'reviewed fixtures/source/corpus.c fixture_maximum signature',
        },
        claim: 'fixture_maximum is signed int32 max of two signed int32 arguments',
        derived_from: [missingProof],
        conflicts_with: [],
        revision: revision + 1,
      });
      tx.putType(sourceType, { kind: 'integer', bits: 32, signed: true }, [sourceProof]);
      tx.putSignature(b.id, {
        abi: image.target.abi,
        return_type: sourceType,
        parameters: ['a', 'b'].map((name) => ({
          id: entityIdentity(image.selected_slice_id, 'incremental-source-parameter', [b.id, name]),
          name,
          type_id: sourceType,
        })),
        variadic: false,
        noreturn: false,
        evidence_ids: [sourceProof],
      });
    }).state,
    'committed',
  );
  const sourceTyped = await decompile(b.id);
  assert.equal(sourceTyped.result.data.cache, 'computed');
  assert.equal(sourceTyped.payload.result.data.signature?.return_type, sourceType);
  assert.equal(sourceTyped.payload.result.data.signature?.parameters.length, 2);
  checks.push(
    'Adding previously absent durable signature/type refines the actual selected body result',
  );
  revision = store.snapshot().revision;
  assert.equal(
    store.transaction(revision, (tx) =>
      tx.putEvidence({
        id: missingProof,
        origin: {
          kind: 'analysis',
          analyzer: 'incremental-safety-oracle',
          version: '1',
          rule: 'reviewed durable proof update',
        },
        claim: 'Reviewed proof dependency was updated without changing source signature',
        derived_from: [],
        conflicts_with: [],
        revision: revision + 1,
      }),
    ).state,
    'committed',
  );
  const proofChanged = await decompile(b.id);
  assert.equal(proofChanged.result.data.cache, 'computed');
  assert.ok(
    proofChanged.payload.catalog.evidence.some(
      (proof) =>
        proof.id === missingProof &&
        proof.claim === 'Reviewed proof dependency was updated without changing source signature',
    ),
  );
  checks.push(
    'Changed reachable proof closure invalidates and republishes the actual signature result',
  );
  console.log(JSON.stringify({ output, checks }, null, 2));
} finally {
  await store.close();
  await writeFile(
    join(output, 'results.json'),
    JSON.stringify({ schema: 'open-decomp/incremental-safety/1', checks }, null, 2),
  );
}
