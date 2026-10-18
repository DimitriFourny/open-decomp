import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  evidenceManifest,
  evidencePath,
  evidenceStore,
  MissingEvidenceError,
  verifyEvidenceAsset,
} from '../../scripts/bench/evidence.js';
import { evidenceArchiveSkip } from './host-tools.js';

test('evidence resolver reports missing assets and rejects corruption instead of skipping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-decomp-evidence-test-'));
  const previous = process.env['OPEN_DECOMP_EVIDENCE_DIR'];
  process.env['OPEN_DECOMP_EVIDENCE_DIR'] = root;
  try {
    assert.equal(evidenceStore(), root);
    assert.throws(() => evidencePath('../outside.tar.gz'), /Unknown evidence archive/);
    const asset = evidenceManifest.assets[0]!;
    assert.throws(() => evidencePath(asset.path), MissingEvidenceError);
    assert.match(String(evidenceArchiveSkip(asset.path)), /fetch-evidence\.ts --only/);
    const destination = join(root, asset.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, 'invalid');
    assert.throws(() => evidenceArchiveSkip(asset.path), /evidence size mismatch/);
    await writeFile(destination, Buffer.alloc(asset.bytes));
    assert.throws(() => evidencePath(asset.path), /evidence SHA256 mismatch/);

    const bytes = Buffer.from('pinned test bytes');
    const pin = {
      path: 'test-asset',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    await writeFile(destination, bytes);
    verifyEvidenceAsset(destination, pin);
    await writeFile(destination, Buffer.alloc(bytes.length));
    assert.throws(() => verifyEvidenceAsset(destination, pin), /evidence SHA256 mismatch/);
  } finally {
    if (previous === undefined) delete process.env['OPEN_DECOMP_EVIDENCE_DIR'];
    else process.env['OPEN_DECOMP_EVIDENCE_DIR'] = previous;
    await rm(root, { recursive: true, force: true });
  }
});
