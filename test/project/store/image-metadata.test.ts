import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LoadedImage } from '../../../src/core/index.js';
import { SqliteProjectStore } from '../../../src/project/store/index.js';
import { decodeStored, encodeStored } from '../../../src/project/store/encoding.js';
import { fixtureImage } from '../../metadata/fixture.js';

async function project(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'open-decomp-image-metadata-'));
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
  return { state, image };
}

function metadata(image: LoadedImage) {
  const { bytes: _bytes, address_map: _map, ...value } = image;
  return value;
}

function largeHeaders(image: LoadedImage, count: number, fields: number): LoadedImage {
  const text = 'x'.repeat(8190);
  return {
    ...image,
    headers: Array.from({ length: count }, (_, index) => ({
      ...image.headers[0]!,
      name: `large-header-${index}`,
      fields: Array.from({ length: fields }, (_, field) => ({
        kind: 'text' as const,
        name: `field-${field}`,
        value: `${text}${index}`,
      })),
    })),
  };
}

test('metadata larger than one record survives reopen, historical reads and replacement within one transaction', async (t) => {
  const { state, image } = await project(t),
    large = largeHeaders(image, 3, 700);
  assert.equal(state.store.transaction(1, (tx) => tx.putImage(large)).state, 'committed');
  assert.equal(
    state.store.transaction(2, (tx) => {
      tx.putImage(large);
      tx.putImage(image);
    }).state,
    'committed',
  );
  await state.store.close();
  state.store = SqliteProjectStore.open(state.path, 'resume');
  assert.deepEqual(
    metadata(state.store.readLoadedImage(image.id, image.selected_slice_id, 2)),
    metadata(large),
  );
  assert.deepEqual(
    metadata(state.store.readLoadedImage(image.id, image.selected_slice_id)),
    metadata(image),
  );
  assert.deepEqual(state.store.readImage(image.id).read(0n, 2), Uint8Array.of(0x4d, 0x5a));
});

test('individual-record and aggregate byte limits roll back image facts and preserve the last published revision', async (t) => {
  const { state, image } = await project(t);
  assert.equal(state.store.transaction(1, (tx) => tx.putImage(image)).state, 'committed');
  const oversizedRecord = {
    ...image,
    headers: [{ ...image.headers[0]!, name: 'x'.repeat(16 * 1024 * 1024) }],
  };
  for (const oversized of [oversizedRecord, largeHeaders(image, 9, 1000)]) {
    const result = state.store.transaction(2, (tx) => tx.putImage(oversized));
    assert.equal(result.state, 'rejected');
    if (result.state !== 'rejected') assert.fail('Oversized metadata was published');
    assert.equal(result.diagnostics[0]?.code, 'resource_limit');
    assert.equal(state.store.snapshot().revision, 2);
    assert.deepEqual(
      metadata(state.store.readLoadedImage(image.id, image.selected_slice_id)),
      metadata(image),
    );
  }
  await state.store.close();
  state.store = SqliteProjectStore.open(state.path, 'resume');
  assert.deepEqual(
    metadata(state.store.readLoadedImage(image.id, image.selected_slice_id)),
    metadata(image),
  );
});

for (const [name, mutation] of [
  [
    'missing ordered fact',
    "DELETE FROM loaded_image_records WHERE collection='headers' AND ordinal=0",
  ],
  [
    'unlisted fact',
    "INSERT INTO loaded_image_records SELECT image_id,slice_id,revision,collection,1000000,payload FROM loaded_image_records WHERE collection='headers' AND ordinal=0",
  ],
  [
    'oversized fact',
    "UPDATE loaded_image_records SET payload=zeroblob(16777217) WHERE collection='headers' AND ordinal=0",
  ],
] as const)
  test(`a ${name} cannot be read as a complete image snapshot`, async (t) => {
    const { state, image } = await project(t);
    assert.equal(state.store.transaction(1, (tx) => tx.putImage(image)).state, 'committed');
    await state.store.close();
    const db = new DatabaseSync(join(state.path, 'project.sqlite'));
    try {
      db.exec(mutation);
    } finally {
      db.close();
    }
    state.store = SqliteProjectStore.open(state.path, 'resume');
    assert.throws(() => state.store.readLoadedImage(image.id, image.selected_slice_id), {
      code: 'invalid_input',
    });
  });

test('schema-3 migration preserves every historical loaded image and its ordered evidence', async (t) => {
  const { state, image } = await project(t);
  const later = {
    ...image,
    diagnostics: [
      ...image.diagnostics,
      {
        code: 'unavailable_semantics' as const,
        severity: 'info' as const,
        message: 'Later interpretation',
        evidence_ids: [],
      },
    ],
  };
  assert.equal(state.store.transaction(1, (tx) => tx.putImage(image)).state, 'committed');
  assert.equal(state.store.transaction(2, (tx) => tx.putImage(later)).state, 'committed');
  const snapshot = state.store.snapshot();
  await state.store.close();
  const db = new DatabaseSync(join(state.path, 'project.sqlite'));
  try {
    db.prepare('UPDATE loaded_images SET payload=? WHERE revision=2').run(
      encodeStored(metadata(image)),
    );
    db.prepare('UPDATE loaded_images SET payload=? WHERE revision=3').run(
      encodeStored(metadata(later)),
    );
    db.exec(
      'DROP TABLE loaded_image_records; DROP TABLE analysis_reuse; DROP TABLE native_summaries; DROP TABLE discovery_frontiers; DROP INDEX records_scope_revision; DROP INDEX loaded_images_revision; PRAGMA user_version=3;',
    );
  } finally {
    db.close();
  }
  state.store = SqliteProjectStore.open(state.path, 'resume');
  assert.equal(state.store.project_id, snapshot.project_id);
  assert.equal(state.store.snapshot().revision, snapshot.revision);
  assert.deepEqual(
    metadata(state.store.readLoadedImage(image.id, image.selected_slice_id, 2)),
    metadata(image),
  );
  assert.deepEqual(
    metadata(state.store.readLoadedImage(image.id, image.selected_slice_id, 3)),
    metadata(later),
  );
  await state.store.close();
  state.store = SqliteProjectStore.open(state.path, 'resume');
  assert.deepEqual(
    metadata(state.store.readLoadedImage(image.id, image.selected_slice_id, 2)),
    metadata(image),
  );
});

test('failed migration rolls back both previously converted snapshots and the new schema', async (t) => {
  const { state, image } = await project(t);
  assert.equal(state.store.transaction(1, (tx) => tx.putImage(image)).state, 'committed');
  assert.equal(state.store.transaction(2, (tx) => tx.putImage(image)).state, 'committed');
  await state.store.close();
  const path = join(state.path, 'project.sqlite'),
    db = new DatabaseSync(path);
  try {
    db.prepare('UPDATE loaded_images SET payload=? WHERE revision=2').run(
      encodeStored(metadata(image)),
    );
    db.prepare('UPDATE loaded_images SET payload=? WHERE revision=3').run(
      encodeStored({ ...metadata(image), id: `image_${'0'.repeat(64)}` }),
    );
    db.exec(
      'DROP TABLE loaded_image_records; DROP TABLE analysis_reuse; DROP TABLE discovery_frontiers; DROP INDEX records_scope_revision; DROP INDEX loaded_images_revision; PRAGMA user_version=3;',
    );
  } finally {
    db.close();
  }
  assert.throws(() => SqliteProjectStore.open(state.path, 'resume'), { code: 'invalid_input' });
  const reopened = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(reopened.prepare('PRAGMA user_version').get()?.['user_version'], 3);
    assert.deepEqual(
      decodeStored(
        reopened.prepare('SELECT payload FROM loaded_images WHERE revision=2').get()?.['payload'],
      ),
      metadata(image),
    );
    assert.equal(
      reopened
        .prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='loaded_image_records'")
        .get()?.['count'],
      0,
    );
  } finally {
    reopened.close();
  }
});
