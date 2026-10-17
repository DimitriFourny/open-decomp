import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  contentHash,
  createOperationContext,
  entityIdentity,
  newIdentity,
  type AnnotationBatch,
  type AnnotationEdit,
  type Evidence,
  type Job,
  type LoadedImage,
  type OperationContext,
  type RecoveredType,
} from '../../../src/core/index.js';
import {
  AnnotationService,
  createTrustedSemanticCatalog,
  resolveDurableSubject,
} from '../../../src/project/annotations/index.js';
import { SqliteProjectStore } from '../../../src/project/store/index.js';
import { fixtureImage } from '../../metadata/fixture.js';

async function project(t: TestContext, image: LoadedImage = fixtureImage('metadata.dll')) {
  const path = mkdtempSync(join(tmpdir(), 'open-decomp-annotations-'));
  const state = { path, store: SqliteProjectStore.open(path, 'create') };
  t.after(async () => {
    await state.store.close();
    rmSync(path, { recursive: true, force: true });
  });
  await state.store.importImage({
    bytes: image.bytes,
    sha256: image.sha256,
    selected_slice_id: image.selected_slice_id,
  });
  assert.equal(
    state.store.transaction(1, (tx) => {
      tx.putImage(image);
      for (const proof of image.evidence) tx.putEvidence(proof);
    }).state,
    'committed',
  );
  return { state, image, subject: image.exports[0]!.id };
}

function batch(revision: number, edits: readonly AnnotationEdit[]): AnnotationBatch {
  return { expected_revision: revision, author: 'analyst', origin: 'user', edits };
}
function note(id: string, entity_id: string, text = 'durable note'): AnnotationEdit {
  return {
    operation: 'set',
    id,
    entity_id,
    value: { kind: 'note', value: text },
    status: 'hypothesis',
    evidence_ids: [],
  };
}

test('semantic validation, stale revisions, cancellation and budgets cannot partially apply a batch', async (t) => {
  const { state, image, subject } = await project(t),
    service = new AnnotationService(state.store);
  const first = newIdentity('annotation'),
    invalid = newIdentity('annotation');
  const missing = entityIdentity(image.selected_slice_id, 'missing', 1);
  const valid = note(first, subject);
  const invalidEdits: AnnotationEdit[] = [
    note(invalid, missing),
    {
      operation: 'set',
      id: invalid,
      entity_id: subject,
      value: {
        kind: 'type',
        type_id: missing,
        definition: { kind: 'pointer', bits: 64, to: subject },
      },
      status: 'asserted',
      evidence_ids: [],
    },
    {
      operation: 'set',
      id: invalid,
      entity_id: subject,
      value: { kind: 'name', value: 'int64_t' },
      status: 'asserted',
      evidence_ids: [`evidence_${'e'.repeat(64)}`],
    },
    {
      operation: 'set',
      id: invalid,
      entity_id: subject,
      value: {
        kind: 'signature',
        value: {
          abi: 'windows-x64',
          return_type: missing,
          parameters: [],
          variadic: false,
          noreturn: false,
          evidence_ids: [],
        },
      },
      status: 'asserted',
      evidence_ids: [],
    },
  ];
  for (const edit of invalidEdits) {
    const result = service.apply(batch(2, [valid, edit]), createOperationContext());
    assert.equal(result.state, 'rejected');
    assert.equal(state.store.snapshot().revision, 2);
    assert.deepEqual(state.store.queryAnnotations({ revision: 2, limit: 100 }).items, []);
    assert.deepEqual(
      state.store.queryAnnotationHistory({ id: first, revision: 2, limit: 100 }).items,
      [],
    );
  }
  assert.deepEqual(service.apply(batch(1, [valid]), createOperationContext()), {
    state: 'conflict',
    expected_revision: 1,
    current_revision: 2,
  });
  const exhausted = service.apply(
    batch(2, [valid]),
    createOperationContext({ budget: { work: 1 } }),
  );
  assert.equal(exhausted.state, 'rejected');
  if (exhausted.state === 'rejected')
    assert.equal(exhausted.diagnostics[0]!.code, 'resource_limit');
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    service.apply(batch(2, [valid]), createOperationContext({ signal: controller.signal })).state,
    'rejected',
  );
  assert.equal(
    service.apply(
      batch(2, [note(first, subject, 'x'.repeat(2000))]),
      createOperationContext({ budget: { output_bytes: 1024 } }),
    ).state,
    'rejected',
  );
  assert.equal(state.store.snapshot().revision, 2);
  const result = service.apply(batch(2, [valid]), createOperationContext());
  assert.equal(result.state, 'committed');
  if (result.state !== 'committed') throw new Error('Expected commit');
  assert.equal(result.revision, 3);
  assert.equal(result.previous_revision, 2);
  assert.equal(result.invalidate_before_revision, 3);
  const proof = state.store.readEvidence(result.annotations[0]!.evidence_ids, 3)[0]!;
  assert.deepEqual(proof.origin, {
    kind: 'assertion',
    author: 'analyst',
    agent: 'user',
    status: 'hypothesis',
  });
  assert.equal(proof.revision, 3);
});

test('same-batch declarations allow recursive pointers, preserve contradictions, and never become durable type facts', async (t) => {
  const { state, image, subject } = await project(t),
    service = new AnnotationService(state.store);
  const object = entityIdentity(image.selected_slice_id, 'source-type', 'object'),
    pointer = entityIdentity(image.selected_slice_id, 'source-type', 'pointer');
  const field = entityIdentity(image.selected_slice_id, 'source-field', 'next');
  const ids = [newIdentity('annotation'), newIdentity('annotation'), newIdentity('annotation')];
  const edits: AnnotationEdit[] = [
    {
      operation: 'set',
      id: ids[0]!,
      entity_id: subject,
      value: {
        kind: 'type',
        type_id: object,
        definition: {
          kind: 'structure',
          size: 8n,
          alignment: 8,
          fields: [{ id: field, name: 'next', offset: 0n, type_id: pointer }],
        },
      },
      status: 'asserted',
      evidence_ids: [],
    },
    {
      operation: 'set',
      id: ids[1]!,
      entity_id: subject,
      value: {
        kind: 'type',
        type_id: pointer,
        definition: { kind: 'pointer', bits: 64, to: object },
      },
      status: 'asserted',
      evidence_ids: [],
    },
    {
      operation: 'set',
      id: ids[2]!,
      entity_id: subject,
      value: {
        kind: 'type',
        type_id: object,
        definition: { kind: 'integer', bits: 64, signed: false },
      },
      status: 'hypothesis',
      evidence_ids: [],
    },
  ];
  assert.equal(service.apply(batch(2, edits), createOperationContext()).state, 'committed');
  assert.equal(state.store.snapshot().revision, 3);
  const view = service.active(3, createOperationContext());
  assert.deepEqual(
    view.types
      .filter((type) => type.id === object)
      .map((type) => type.definition.kind)
      .sort(),
    ['integer', 'structure'],
  );
  assert.equal(state.store.readType(object, 3), null);
  assert.equal(state.store.readType(pointer, 3), null);
  await state.store.close();
  state.store = SqliteProjectStore.open(state.path, 'resume');
  assert.deepEqual(new AnnotationService(state.store).active(3, createOperationContext()), view);
  assert.equal(
    new AnnotationService(state.store).apply(
      batch(
        3,
        ids.map((id) => ({ operation: 'remove', id })),
      ),
      createOperationContext(),
    ).state,
    'committed',
  );
  assert.deepEqual(
    new AnnotationService(state.store).active(4, createOperationContext()).types,
    [],
  );
  assert.equal(state.store.readType(object, 4), null);
});

test('catalogs are exact project/revision capabilities and persist referenced semantic evidence atomically', async (t) => {
  const { state, image, subject } = await project(t),
    service = new AnnotationService(state.store);
  const semanticId = entityIdentity(image.selected_slice_id, 'ssa-value', 'real-host-subject');
  const proof: Evidence = {
    id: newIdentity('evidence'),
    origin: { kind: 'analysis', analyzer: 'test-semantic-host', version: '1', rule: 'known value' },
    claim: 'An explicit trusted semantic subject',
    derived_from: [],
    conflicts_with: [],
    revision: 2,
  };
  const catalog = createTrustedSemanticCatalog(
    state.store,
    2,
    {
      subjects: [
        {
          id: semanticId,
          kind: 'value',
          image_id: image.id,
          slice_id: image.selected_slice_id,
          abi: image.target.abi,
        },
      ],
      evidence: [proof],
    },
    createOperationContext(),
  );
  assert.equal(resolveDurableSubject(state.store, semanticId, 2, createOperationContext()), null);
  assert.equal(
    resolveDurableSubject(state.store, subject, 2, createOperationContext())!.kind,
    'export',
  );
  const edit: AnnotationEdit = {
    operation: 'set',
    id: newIdentity('annotation'),
    entity_id: semanticId,
    value: { kind: 'name', value: 'struct NotAType' },
    status: 'asserted',
    evidence_ids: [proof.id],
  };
  assert.equal(service.apply(batch(2, [edit]), createOperationContext()).state, 'rejected');
  assert.equal(
    service.apply(batch(2, [edit]), createOperationContext(), catalog).state,
    'committed',
  );
  assert.deepEqual(state.store.readEvidence([proof.id], 3), [proof]);
  assert.deepEqual(service.active(3, createOperationContext()).types, []);
  assert.equal(
    service.apply(
      batch(3, [note(newIdentity('annotation'), semanticId)]),
      createOperationContext(),
      catalog,
    ).state,
    'rejected',
  );
  await state.store.close();
  state.store = SqliteProjectStore.open(state.path, 'resume');
  assert.deepEqual(state.store.readEvidence([proof.id], 3), [proof]);
  assert.deepEqual(state.store.readAnnotations(semanticId, 3)[0]!.evidence_ids, [proof.id]);
  const other = await project(t);
  assert.equal(
    new AnnotationService(other.state.store).apply(
      batch(2, [edit]),
      createOperationContext(),
      catalog,
    ).state,
    'rejected',
  );
});

test('nested signature evidence and declaration references must exist in the snapshot', async (t) => {
  const { state, image, subject } = await project(t),
    service = new AnnotationService(state.store);
  const typeId = entityIdentity(image.selected_slice_id, 'source-type', 'u64');
  const declaration: AnnotationEdit = {
    operation: 'set',
    id: newIdentity('annotation'),
    entity_id: subject,
    value: {
      kind: 'type',
      type_id: typeId,
      definition: { kind: 'integer', bits: 64, signed: false },
    },
    status: 'asserted',
    evidence_ids: [],
  };
  const signature: AnnotationEdit = {
    operation: 'set',
    id: newIdentity('annotation'),
    entity_id: subject,
    value: {
      kind: 'signature',
      value: {
        abi: image.target.abi,
        return_type: typeId,
        parameters: [],
        variadic: false,
        noreturn: false,
        evidence_ids: [newIdentity('evidence')],
      },
    },
    status: 'asserted',
    evidence_ids: [],
  };
  assert.equal(
    service.apply(batch(2, [signature, declaration]), createOperationContext()).state,
    'rejected',
  );
  assert.equal(state.store.snapshot().revision, 2);
  if (signature.operation !== 'set' || signature.value.kind !== 'signature')
    throw new Error('Expected signature');
  assert.equal(
    service.apply(
      batch(2, [
        {
          ...signature,
          value: { kind: 'signature', value: { ...signature.value.value, evidence_ids: [] } },
        },
        declaration,
      ]),
      createOperationContext(),
    ).state,
    'committed',
  );
  assert.equal(state.store.readSignature(subject, 3), null);
  assert.equal(
    service
      .active(3, createOperationContext())
      .annotations.filter((annotation) => annotation.value.kind === 'signature').length,
    1,
  );
});

test('trusted completion hooks share rollback with evidence, annotations, and terminal durable jobs', async (t) => {
  const { state, subject } = await project(t),
    service = new AnnotationService(state.store);
  const id = newIdentity('annotation');
  const job: Job = {
    id: newIdentity('job'),
    project_id: state.store.project_id,
    input_revision: 2,
    operation: 'annotations_apply',
    state: 'running',
    progress: { phase: 'validate', completed: 0, total: 1 },
    artifacts: [],
    diagnostics: [],
    published_revision: null,
  };
  state.store.saveJob(job);
  const controller = new AbortController();
  const result = service.apply(
    batch(2, [note(id, subject)]),
    createOperationContext({ signal: controller.signal }),
    undefined,
    () => {
      state.store.saveJob({ ...job, state: 'completed' });
      controller.abort();
    },
  );
  assert.equal(result.state, 'rejected');
  assert.equal(state.store.snapshot().revision, 2);
  assert.equal(state.store.readJob(job.id)!.state, 'running');
  if (result.state === 'rejected') assert.equal(result.diagnostics[0]!.code, 'cancelled');
  assert.deepEqual(state.store.readAnnotations(subject, 2), []);
  assert.equal(
    service.apply(batch(2, [note(id, subject)]), createOperationContext(), undefined, () => {
      state.store.saveJob({ ...job, state: 'completed' });
    }).state,
    'committed',
  );
  await state.store.close();
  state.store = SqliteProjectStore.open(state.path, 'resume');
  assert.equal(state.store.readJob(job.id)!.state, 'completed');
  assert.equal(state.store.snapshot().revision, 3);
  assert.equal(state.store.readAnnotations(subject, 3)[0]!.id, id);
});

test('work exhaustion after transaction writes rolls back rather than retaining assertion evidence', async (t) => {
  const { state, subject } = await project(t),
    service = new AnnotationService(state.store);
  const id = newIdentity('annotation'),
    base = createOperationContext();
  // Exhaust the shared context in the trusted commit boundary, after real SQLite writes.
  const context: OperationContext = { ...base };
  const result = service.apply(batch(2, [note(id, subject)]), context, undefined, () =>
    base.checkpoint(base.budget.work + 1),
  );
  assert.equal(result.state, 'rejected');
  if (result.state === 'rejected') assert.equal(result.diagnostics[0]!.code, 'resource_limit');
  assert.equal(state.store.snapshot().revision, 2);
  assert.deepEqual(state.store.queryAnnotationHistory({ id, revision: 2, limit: 10 }).items, []);
});

test('lineage never moves notes or permits a removed annotation ID to attach to a successor', async (t) => {
  const { state, image, subject } = await project(t);
  const id = newIdentity('annotation'),
    successor = entityIdentity(image.selected_slice_id, 'replacement-export', subject);
  assert.equal(
    new AnnotationService(state.store).apply(
      batch(2, [note(id, subject)]),
      createOperationContext(),
    ).state,
    'committed',
  );
  assert.equal(
    state.store.transaction(3, (tx) => {
      tx.putRecord(image.id, 'export', { ...image.exports[0]!, id: successor });
      tx.putLineage({
        revision: 4,
        reason: 'replacement',
        previous: [subject],
        next: [successor],
        evidence_ids: [],
      });
    }).state,
    'committed',
  );
  assert.deepEqual(state.store.readAnnotations(successor, 4), []);
  assert.equal(state.store.readAnnotations(subject, 4)[0]!.id, id);
  assert.deepEqual(state.store.readLineage(subject, 4)[0]!.next, [successor]);
  assert.equal(
    new AnnotationService(state.store).apply(
      batch(4, [{ operation: 'remove', id }]),
      createOperationContext(),
    ).state,
    'committed',
  );
  assert.equal(
    new AnnotationService(state.store).apply(
      batch(5, [note(id, successor)]),
      createOperationContext(),
    ).state,
    'rejected',
  );
  assert.equal(state.store.snapshot().revision, 5);
  await state.store.close();
  state.store = SqliteProjectStore.open(state.path, 'resume');
  assert.deepEqual(state.store.readAnnotations(successor, 5), []);
  const history = state.store.queryAnnotationHistory({ id, revision: 5, limit: 10 }).items;
  assert.deepEqual(
    history.map((entry) => [entry.operation, entry.entity_id, entry.actor]),
    [
      ['set', subject, { author: 'analyst', origin: 'user' }],
      ['remove', subject, { author: 'analyst', origin: 'user' }],
    ],
  );
  assert.equal(
    contentHash(state.store.readImage(image.id).read(0n, image.bytes.length)),
    image.sha256,
  );
});

test('filtered annotation views keep local alternatives and only referenced shared declarations', async (t) => {
  const { state, image, subject } = await project(t),
    service = new AnnotationService(state.store);
  const other = image.sections[0]!.id;
  const word = entityIdentity(image.selected_slice_id, 'scoped-type', 'word');
  const pointer = entityIdentity(image.selected_slice_id, 'scoped-type', 'pointer');
  const unused = entityIdentity(image.selected_slice_id, 'scoped-type', 'unused');
  const declaration = (
    entity_id: string,
    type_id: string,
    definition: RecoveredType,
  ): AnnotationEdit => ({
    operation: 'set',
    id: newIdentity('annotation'),
    entity_id,
    value: { kind: 'type', type_id, definition },
    status: 'asserted',
    evidence_ids: [],
  });
  const local = declaration(subject, word, { kind: 'integer', bits: 64, signed: false });
  const signature: AnnotationEdit = {
    operation: 'set',
    id: newIdentity('annotation'),
    entity_id: subject,
    status: 'asserted',
    evidence_ids: [],
    value: {
      kind: 'signature',
      value: {
        abi: image.target.abi,
        return_type: word,
        parameters: [
          {
            id: entityIdentity(image.selected_slice_id, 'scoped-parameter', 0),
            name: null,
            type_id: pointer,
          },
        ],
        variadic: false,
        noreturn: false,
        evidence_ids: [],
      },
    },
  };
  assert.equal(
    service.apply(
      batch(2, [
        local,
        signature,
        declaration(other, word, { kind: 'float', bits: 64 }),
        declaration(other, pointer, { kind: 'pointer', bits: 64, to: word }),
        declaration(other, unused, { kind: 'float', bits: 32 }),
      ]),
      createOperationContext(),
    ).state,
    'committed',
  );
  const view = service.active(3, createOperationContext(), { entity_ids: [subject] });
  assert.deepEqual(
    view.annotations.map((annotation) => annotation.id).sort(),
    [local.id, signature.id].sort(),
  );
  assert.deepEqual(view.types.map((type) => type.id).sort(), [word, pointer].sort());
  assert.deepEqual(view.types.find((type) => type.id === word)!.definition, {
    kind: 'integer',
    bits: 64,
    signed: false,
  });
  assert.deepEqual(view.types.find((type) => type.id === pointer)!.definition, {
    kind: 'pointer',
    bits: 64,
    to: word,
  });
  const empty = service.active(3, createOperationContext(), { entity_ids: [] });
  assert.deepEqual(empty.annotations, []);
  assert.deepEqual(empty.types, []);
  assert.deepEqual(
    service
      .active(3, createOperationContext())
      .types.filter((type) => type.id === word)
      .map((type) => type.definition.kind)
      .sort(),
    ['float', 'integer'],
  );
  assert.equal(
    service.apply(
      batch(3, [declaration(subject, word, { kind: 'float', bits: 32 })]),
      createOperationContext(),
    ).state,
    'committed',
  );
  const alternatives = service
    .active(4, createOperationContext(), { entity_ids: [subject] })
    .types.filter((type) => type.id === word)
    .map((type) => type.definition);
  assert.deepEqual(
    alternatives.sort((a, b) => a.kind.localeCompare(b.kind)),
    [
      { kind: 'float', bits: 32 },
      { kind: 'integer', bits: 64, signed: false },
    ],
  );
});
