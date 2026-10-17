import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { entityIdentity, type AnnotationEdit } from '../../../src/core/index.js';
import { SqliteProjectStore } from '../../../src/project/store/index.js';
import { fixtureImage } from '../../metadata/fixture.js';

async function project(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'open-decomp-history-')),
    state = { path, store: SqliteProjectStore.open(path, 'create') };
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
  return { state, image, subject: image.exports[0]!.id };
}

const firstId = `annotation_${'1'.repeat(64)}`,
  secondId = `annotation_${'2'.repeat(64)}`,
  thirdId = `annotation_${'3'.repeat(64)}`;

test('historical image reads exclude unpublished and later loader metadata', async (t) => {
  const { state, image } = await project(t);
  assert.equal(state.store.transaction(1, (tx) => tx.putImage(image)).state, 'committed');
  assert.throws(() => state.store.readLoadedImage(image.id, image.selected_slice_id, 1), {
    code: 'not_found',
  });
  const later = {
    ...image,
    diagnostics: [
      ...image.diagnostics,
      {
        code: 'unavailable_semantics' as const,
        severity: 'info' as const,
        message: 'Later loader interpretation',
        evidence_ids: [],
      },
    ],
  };
  assert.equal(state.store.transaction(2, (tx) => tx.putImage(later)).state, 'committed');
  assert.deepEqual(
    state.store.readLoadedImage(image.id, image.selected_slice_id, 2).diagnostics,
    image.diagnostics,
  );
  assert.deepEqual(
    state.store.readLoadedImage(image.id, image.selected_slice_id).diagnostics,
    later.diagnostics,
  );
  assert.throws(() => state.store.readLoadedImage(image.id, image.selected_slice_id, 4), {
    code: 'stale_revision',
  });
  await state.store.close();
  state.store = SqliteProjectStore.open(state.path, 'resume');
  assert.deepEqual(
    state.store.readLoadedImage(image.id, image.selected_slice_id, 2).diagnostics,
    image.diagnostics,
  );
  assert.deepEqual(
    state.store.readLoadedImage(image.id, image.selected_slice_id, 3).diagnostics,
    later.diagnostics,
  );
});

test('annotation pages and history retain actors, retractions and removals across atomic batches and reopen', async (t) => {
  const { state, image, subject } = await project(t);
  const edits: AnnotationEdit[] = [
    {
      operation: 'set',
      id: firstId,
      entity_id: subject,
      value: { kind: 'note', value: 'first hypothesis' },
      status: 'hypothesis',
      evidence_ids: [],
    },
    {
      operation: 'set',
      id: secondId,
      entity_id: subject,
      value: { kind: 'name', value: 'second_name' },
      status: 'asserted',
      evidence_ids: [],
    },
  ];
  assert.equal(
    state.store.applyAnnotations({ expected_revision: 1, author: 'creator', origin: 'user', edits })
      .state,
    'committed',
  );
  const historical = state.store.queryAnnotations({ revision: 2, limit: 10 }).items;
  assert.equal(
    state.store.applyAnnotations({
      expected_revision: 2,
      author: 'reviewer',
      origin: 'llm',
      edits: [
        {
          operation: 'set',
          id: firstId,
          entity_id: subject,
          value: { kind: 'note', value: 'revised assertion' },
          status: 'asserted',
          evidence_ids: [],
        },
        { operation: 'retract', id: secondId },
      ],
    }).state,
    'committed',
  );
  assert.equal(state.store.snapshot().revision, 3);
  assert.deepEqual(state.store.queryAnnotations({ revision: 2, limit: 10 }).items, historical);
  const query = { revision: 3, limit: 1 },
    first = state.store.queryAnnotations(query);
  assert.ok(first.next_cursor);
  const second = state.store.queryAnnotations({ ...query, cursor: first.next_cursor });
  assert.deepEqual(
    [...first.items, ...second.items].map((item) => [item.id, item.status]),
    [
      [firstId, 'asserted'],
      [secondId, 'retracted'],
    ],
  );
  assert.equal(second.next_cursor, null);
  assert.throws(
    () => state.store.queryAnnotations({ ...query, cursor: first.next_cursor!, ids: [] }),
    { code: 'stale_cursor' },
  );
  assert.throws(
    () => state.store.queryAnnotations({ ...query, cursor: first.next_cursor!, entity_ids: [] }),
    { code: 'stale_cursor' },
  );
  assert.deepEqual(state.store.queryAnnotations({ revision: 3, limit: 10, ids: [] }).items, []);
  assert.deepEqual(
    state.store.queryAnnotations({ revision: 3, limit: 10, ids: [firstId], entity_ids: [subject] })
      .items,
    first.items,
  );
  assert.equal(
    state.store.applyAnnotations({
      expected_revision: 3,
      author: 'remover',
      origin: 'user',
      edits: [{ operation: 'remove', id: firstId }],
    }).state,
    'committed',
  );
  assert.throws(
    () => state.store.queryAnnotations({ ...query, revision: 4, cursor: first.next_cursor! }),
    { code: 'stale_cursor' },
  );
  const history = state.store.queryAnnotationHistory({ id: firstId, revision: 4, limit: 10 }).items;
  assert.deepEqual(
    history.map((item) => [item.revision, item.operation, item.actor]),
    [
      [2, 'set', { author: 'creator', origin: 'user' }],
      [3, 'set', { author: 'reviewer', origin: 'llm' }],
      [4, 'remove', { author: 'remover', origin: 'user' }],
    ],
  );
  assert.deepEqual(history[0]!.annotation?.value, { kind: 'note', value: 'first hypothesis' });
  assert.equal(history[2]!.annotation, null);
  assert.deepEqual(
    state.store
      .queryAnnotationHistory({ id: secondId, revision: 4, limit: 10 })
      .items.map((item) => item.operation),
    ['set', 'retract'],
  );
  const otherSubject = entityIdentity(image.selected_slice_id, 'unrelated-subject', 'other');
  const rejected = state.store.applyAnnotations({
    expected_revision: 4,
    author: 'bad-batch',
    origin: 'llm',
    edits: [
      {
        operation: 'set',
        id: thirdId,
        entity_id: subject,
        value: { kind: 'note', value: 'must roll back' },
        status: 'asserted',
        evidence_ids: [],
      },
      {
        operation: 'set',
        id: firstId,
        entity_id: otherSubject,
        value: { kind: 'note', value: 'must not reattach' },
        status: 'asserted',
        evidence_ids: [],
      },
    ],
  });
  assert.equal(rejected.state, 'rejected');
  assert.equal(state.store.snapshot().revision, 4);
  assert.deepEqual(
    state.store.queryAnnotations({ revision: 4, limit: 10 }).items.map((item) => item.id),
    [secondId],
  );
  assert.equal(
    state.store.applyAnnotations({
      expected_revision: 3,
      author: 'stale',
      origin: 'user',
      edits: [{ operation: 'remove', id: secondId }],
    }).state,
    'conflict',
  );
  await state.store.close();
  state.store = SqliteProjectStore.open(state.path, 'resume');
  assert.deepEqual(
    state.store.queryAnnotationHistory({ id: firstId, revision: 4, limit: 10 }).items,
    history,
  );
  const page = state.store.queryAnnotationHistory({ id: firstId, revision: 4, limit: 2 });
  assert.ok(page.next_cursor);
  assert.deepEqual(
    [
      ...page.items,
      ...state.store.queryAnnotationHistory({
        id: firstId,
        revision: 4,
        limit: 2,
        cursor: page.next_cursor,
      }).items,
    ],
    history,
  );
  assert.throws(
    () =>
      state.store.queryAnnotationHistory({
        id: secondId,
        revision: 4,
        limit: 2,
        cursor: page.next_cursor!,
      }),
    { code: 'stale_cursor' },
  );
  assert.throws(() => state.store.queryAnnotations({ revision: 4, limit: 1001 }), {
    code: 'invalid_input',
  });
});

test('schema-1 migration preserves old snapshots without inventing historical removal authors', async (t) => {
  const { state, subject, image } = await project(t);
  const set: AnnotationEdit = {
    operation: 'set',
    id: firstId,
    entity_id: subject,
    value: { kind: 'note', value: 'legacy note' },
    status: 'asserted',
    evidence_ids: [],
  };
  state.store.applyAnnotations({
    expected_revision: 1,
    author: 'old-author',
    origin: 'user',
    edits: [set],
  });
  state.store.applyAnnotations({
    expected_revision: 2,
    author: 'unrecorded-in-v1',
    origin: 'llm',
    edits: [{ operation: 'remove', id: firstId }],
  });
  const identity = state.store.project_id;
  await state.store.close();
  // Recreate the v1 layout, before removal actors, semantic catalog indexing and normalized image facts.
  const legacy = new DatabaseSync(join(state.path, 'project.sqlite'));
  legacy.exec(
    'DROP TABLE annotation_removals; DROP TABLE analysis_artifacts; DROP TABLE loaded_image_records; PRAGMA user_version=1;',
  );
  legacy.close();
  state.store = SqliteProjectStore.open(state.path, 'resume');
  assert.equal(state.store.project_id, identity);
  assert.equal(state.store.snapshot().revision, 3);
  assert.equal(state.store.readAnnotations(subject, 2)[0]!.author, 'old-author');
  assert.deepEqual(state.store.readAnnotations(subject, 3), []);
  assert.deepEqual(state.store.readImage(image.id).read(0n, 2), Uint8Array.of(0x4d, 0x5a));
  const history = state.store.queryAnnotationHistory({ id: firstId, revision: 3, limit: 10 }).items;
  assert.deepEqual(
    history.map((item) => item.actor),
    [{ author: 'old-author', origin: 'user' }, null],
  );
  state.store.applyAnnotations({
    expected_revision: 3,
    author: 'new-author',
    origin: 'llm',
    edits: [set],
  });
  state.store.applyAnnotations({
    expected_revision: 4,
    author: 'new-remover',
    origin: 'user',
    edits: [{ operation: 'remove', id: firstId }],
  });
  await state.store.close();
  state.store = SqliteProjectStore.open(state.path, 'resume');
  assert.deepEqual(
    state.store
      .queryAnnotationHistory({ id: firstId, revision: 5, limit: 10 })
      .items.map((item) => item.actor),
    [
      { author: 'old-author', origin: 'user' },
      null,
      { author: 'new-author', origin: 'llm' },
      { author: 'new-remover', origin: 'user' },
    ],
  );
});
