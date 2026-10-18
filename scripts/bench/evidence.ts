// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface EvidenceAsset {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
interface EvidenceManifest {
  readonly schema: number;
  readonly store_env: string;
  readonly default_store: string;
  readonly assets: readonly EvidenceAsset[];
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const evidenceManifest = JSON.parse(
  readFileSync(new URL('./evidence-assets.json', import.meta.url), 'utf8'),
) as EvidenceManifest;
assert.equal(evidenceManifest.schema, 1, 'Unsupported evidence manifest');

export function evidenceStore(): string {
  return resolve(
    process.env[evidenceManifest.store_env] ?? resolve(repo, evidenceManifest.default_store),
  );
}

export class MissingEvidenceError extends Error {
  constructor(asset: EvidenceAsset, path: string) {
    super(
      `Missing evidence archive: ${path}. Run: node --import tsx scripts/bench/fetch-evidence.ts --only ${basename(asset.path)} (with exactly one of --from DIR or --url-base URL).`,
    );
    this.name = 'MissingEvidenceError';
  }
}

/** Hash in bounded chunks; consumers verify each resolved asset once per process. */
export function verifyEvidenceAsset(path: string, asset: EvidenceAsset): void {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && stat.size === asset.bytes, `${asset.path}: evidence size mismatch`);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let length = 0;
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      length += count;
      assert.ok(length <= asset.bytes, `${asset.path}: evidence exceeds pinned size`);
      hash.update(buffer.subarray(0, count));
    }
    assert.equal(length, asset.bytes, `${asset.path}: evidence changed while reading`);
    assert.equal(hash.digest('hex'), asset.sha256, `${asset.path}: evidence SHA256 mismatch`);
  } finally {
    closeSync(fd);
  }
}

const verified = new Set<string>();
export function evidencePath(repoRelativePath: string): string {
  const asset = evidenceManifest.assets.find((entry) => entry.path === repoRelativePath);
  assert.ok(asset, `Unknown evidence archive: ${repoRelativePath}`);
  const path = resolve(evidenceStore(), asset.path);
  if (!verified.has(path)) {
    try {
      verifyEvidenceAsset(path, asset);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        throw new MissingEvidenceError(asset, path);
      throw error;
    }
    verified.add(path);
  }
  return path;
}
