import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteProjectStore } from '../../../src/project/store/index.js';
import { fixtureImage } from '../../metadata/fixture.js';

test('a warm loaded image still checks the stored file on every read', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'open-decomp-image-integrity-'));
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
  assert.equal(store.transaction(1, (tx) => tx.putImage(image)).state, 'committed');
  const read = () => store.readLoadedImage(image.id, image.selected_slice_id);
  const loaded = read();
  // Warm reads compare the file with the verified bytes instead of hashing it again.
  assert.equal(read(), loaded);
  const file = join(path, 'images', image.sha256);
  const original = readFileSync(file);
  const tampered = Buffer.from(original);
  tampered[tampered.length >> 1]! ^= 0xff;
  chmodSync(file, 0o600);
  writeFileSync(file, tampered);
  assert.throws(read, /Stored image integrity check failed/);
  writeFileSync(file, original);
  assert.equal(read(), loaded);
});
