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
  const scan = () => {
    queries.length = 0;
    const context = createOperationContext();
    const result = records({ store, context }, revision, image.id, 'function');
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
});
