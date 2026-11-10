import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperationContext, entityIdentity } from '../../src/core/index.js';
import type { FunctionRecord } from '../../src/core/index.js';
import { SqliteProjectStore } from '../../src/project/store/index.js';
import { records } from '../../src/service/queries/scope.js';
import { fixtureImage } from '../metadata/fixture.js';

test('a repeated record scan makes one dependency read and the same charges', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'open-decomp-record-scans-'));
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
  const functions: FunctionRecord[] = Array.from({ length: 1500 }, (_, index) => {
    const entry = { image_id: image.id, space: 'va' as const, value: 0x1000n + BigInt(index) };
    return {
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
  });
  const committed = store.transaction(1, (tx) => {
    tx.putImage(image);
    for (const fn of functions) tx.putRecord(image.id, 'function', fn);
  });
  assert.equal(committed.state, 'committed');
  const revision = committed.state === 'committed' ? committed.revision : 0;
  const queries: number[] = [];
  const query = store.queryRecords.bind(store);
  store.queryRecords = (input) => {
    queries.push(input.limit);
    return query(input);
  };
  const scan = (at = revision) => {
    queries.length = 0;
    const context = createOperationContext();
    const result = records({ store, context }, at, image.id, 'function');
    return { result, work: context.consumedWork!(), queries: [...queries] };
  };
  const first = scan();
  const second = scan();
  assert.equal(first.result.items.length, 1500);
  assert.deepEqual(second.result, first.result);
  assert.equal(second.work, first.work);
  assert.deepEqual(first.queries, [1000, 1000]);
  assert.deepEqual(second.queries, [1]);
  // The caller owns its array.
  second.result.items.pop();
  assert.equal(scan().result.items.length, 1500);

  // A later revision that wrote no function records (an annotation commit) holds the same
  // records: it is served the kept scan, with the same charges and its own dependency read.
  const annotated = store.applyAnnotations({
    expected_revision: revision,
    author: 'scan-test',
    origin: 'user',
    edits: [
      {
        operation: 'set',
        id: `annotation_${'1'.repeat(64)}`,
        entity_id: functions[0]!.id,
        value: { kind: 'note', value: 'kept' },
        status: 'asserted',
        evidence_ids: [],
      },
    ],
  });
  assert.equal(annotated.state, 'committed');
  const later = scan(revision + 1);
  assert.deepEqual(later.result, first.result);
  assert.equal(later.work, first.work);
  assert.deepEqual(later.queries, [1]);
  // A revision that writes a function record is scanned again and sees it.
  const added: FunctionRecord = {
    ...functions[0]!,
    id: entityIdentity(image.selected_slice_id, 'function', 0x9000n),
    entry: { image_id: image.id, space: 'va', value: 0x9000n },
    ranges: [{ start: { image_id: image.id, space: 'va', value: 0x9000n }, size: 1n }],
  };
  assert.equal(
    store.transaction(revision + 1, (tx) => tx.putRecord(image.id, 'function', added)).state,
    'committed',
  );
  const changed = scan(revision + 2);
  assert.equal(changed.result.items.length, 1501);
  assert.deepEqual(changed.queries, [1000, 1000]);
  // Older revisions keep their own records.
  assert.equal(scan(revision + 1).result.items.length, 1500);
  // A revision the store does not have still fails, kept scan or not.
  assert.throws(() => scan(revision + 5), { code: 'stale_revision' });
});
