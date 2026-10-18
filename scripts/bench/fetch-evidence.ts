// SPDX-License-Identifier: MIT
// Developer-only setup: reviewed pins, no archive extraction or target execution.
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  evidenceManifest,
  evidenceStore,
  verifyEvidenceAsset,
  type EvidenceAsset,
} from './evidence.js';

const usage =
  'Usage: node --import tsx scripts/bench/fetch-evidence.ts [--from DIR | --url-base URL] [--only NAME]';

async function download(base: string, asset: EvidenceAsset, destination: string): Promise<void> {
  const url = new URL(asset.path, base.endsWith('/') ? base : `${base}/`);
  assert.ok(url.protocol === 'https:' || url.protocol === 'http:', 'Expected an HTTP(S) URL base');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  assert.equal(response.status, 200, `${asset.path}: download returned HTTP ${response.status}`);
  assert.ok(response.body, `${asset.path}: download has no response body`);
  const reader = response.body.getReader();
  let complete = false;
  try {
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null)
      assert.equal(Number(declaredLength), asset.bytes, `${asset.path}: Content-Length mismatch`);
    const file = await open(destination, 'wx', 0o600);
    try {
      let length = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        assert.ok(length <= asset.bytes, `${asset.path}: download exceeds pinned size`);
        await file.writeFile(chunk.value);
      }
      assert.equal(length, asset.bytes, `${asset.path}: truncated download`);
      complete = true;
    } finally {
      await file.close();
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function main(): Promise<void> {
  const flags = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    const value = process.argv[index + 1];
    assert.ok(
      flag && ['--from', '--url-base', '--only'].includes(flag) && value && !value.startsWith('--'),
      usage,
    );
    assert.ok(!flags.has(flag), `Duplicate ${flag}. ${usage}`);
    flags.set(flag, value);
  }
  assert.ok(!(flags.has('--from') && flags.has('--url-base')), usage);
  const only = flags.get('--only');
  const assets = evidenceManifest.assets.filter(
    (asset) => only === undefined || asset.path === only || basename(asset.path) === only,
  );
  assert.ok(assets.length > 0, `Unknown evidence asset: ${only}`);
  if (only !== undefined) assert.equal(assets.length, 1, `Ambiguous evidence asset: ${only}`);
  const source = flags.get('--from') ?? join(homedir(), 'Documents/open-decomp-evidence-archives');
  const sourceRoot = resolve(
    source === '~'
      ? homedir()
      : source.startsWith('~/')
        ? join(homedir(), source.slice(2))
        : source,
  );
  const store = evidenceStore();
  await mkdir(store, { recursive: true });
  const staging = await mkdtemp(join(store, '.fetch-'));
  try {
    for (const asset of assets) {
      const destination = join(store, asset.path);
      try {
        verifyEvidenceAsset(destination, asset);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        const temporary = join(staging, basename(asset.path));
        const urlBase = flags.get('--url-base');
        if (urlBase !== undefined) await download(urlBase, asset, temporary);
        else await copyFile(join(sourceRoot, asset.path), temporary);
        verifyEvidenceAsset(temporary, asset);
        await mkdir(dirname(destination), { recursive: true });
        await rename(temporary, destination);
      }
      console.log(JSON.stringify({ path: destination, bytes: asset.bytes, sha256: asset.sha256 }));
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

await main();
