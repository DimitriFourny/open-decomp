// SPDX-License-Identifier: MIT
// Developer-only setup: reviewed repository pins, never target-selected URLs or target execution.
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PinnedInput {
  readonly id: string;
  readonly archive: {
    readonly url: string;
    readonly filename: string;
    readonly sizeBytes: number;
    readonly sha3_256: string;
    readonly sha256: string;
  };
  readonly binary: {
    readonly member: string;
    readonly path: string;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly format: 'macho' | 'pe';
    readonly architecture: 'arm64' | 'x86_64';
  };
}
interface InputManifest {
  readonly schemaVersion: number;
  readonly inputs: readonly PinnedInput[];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const inputRoot = join(root, '.local/benchmark-inputs');
const maximumBytes = 8 * 1024 * 1024;
const downloadDeadlineMs = 120_000;
const extractionDeadlineMs = 30_000;

function verifyArchive(bytes: Buffer, pin: PinnedInput): void {
  assert.equal(bytes.length, pin.archive.sizeBytes, `${pin.id}: archive size mismatch`);
  assert.equal(createHash('sha3-256').update(bytes).digest('hex'), pin.archive.sha3_256,
    `${pin.id}: archive SHA3-256 differs from the published pin`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.archive.sha256, `${pin.id}: archive SHA256 mismatch`);
}

// Cached files are also bounded: read at most the expected length plus one byte.
async function readArchive(path: string, expectedBytes: number): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    assert.ok(stat.isFile() && stat.size === expectedBytes, `Cached archive has unexpected type/size: ${path}`);
    const bytes = Buffer.alloc(expectedBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    assert.equal(length, expectedBytes, `Cached archive changed while reading: ${path}`);
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

async function download(pin: PinnedInput): Promise<Buffer> {
  const response = await fetch(pin.archive.url, {
    redirect: 'error', signal: AbortSignal.timeout(downloadDeadlineMs),
  });
  assert.equal(response.status, 200, `${pin.id}: download returned HTTP ${response.status}`);
  assert.ok(response.body, `${pin.id}: download has no response body`);
  const reader = response.body.getReader();
  let complete = false;
  try {
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null) {
      assert.equal(Number(declaredLength), pin.archive.sizeBytes, `${pin.id}: download Content-Length mismatch`);
    }
    const bytes = Buffer.alloc(pin.archive.sizeBytes);
    let length = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      assert.ok(chunk.value.byteLength <= bytes.length - length, `${pin.id}: download exceeds pinned size`);
      bytes.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
    assert.equal(length, bytes.length, `${pin.id}: truncated download`);
    verifyArchive(bytes, pin);
    complete = true;
    return bytes;
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function verifyBinary(bytes: Buffer, pin: PinnedInput): void {
  assert.equal(bytes.length, pin.binary.sizeBytes, `${pin.id}: extracted binary size mismatch`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.binary.sha256, `${pin.id}: extracted binary SHA256 mismatch`);
  if (pin.binary.format === 'macho') {
    assert.equal(pin.binary.architecture, 'arm64');
    assert.equal(bytes.readUInt32LE(0), 0xfeedfacf, 'Expected thin little-endian Mach-O64');
    assert.equal(bytes.readUInt32LE(4), 0x0100000c, 'Expected arm64 Mach-O');
    assert.equal(bytes.readUInt32LE(12), 2, 'Expected Mach-O executable');
  } else {
    assert.equal(pin.binary.architecture, 'x86_64');
    assert.equal(bytes.readUInt16LE(0), 0x5a4d, 'Expected PE DOS signature');
    const pe = bytes.readUInt32LE(0x3c);
    assert.ok(pe <= bytes.length - 26, 'PE header is outside pinned binary');
    assert.equal(bytes.readUInt32LE(pe), 0x4550, 'Expected PE signature');
    assert.equal(bytes.readUInt16LE(pe + 4), 0x8664, 'Expected x86-64 PE');
    assert.equal(bytes.readUInt16LE(pe + 24), 0x20b, 'Expected PE32+');
  }
}

async function main(): Promise<void> {
  assert.equal(process.argv.length, 2, 'Usage: node --import tsx scripts/bench/fetch-inputs.ts (no arguments)');
  assert.ok((process.platform === 'darwin' && process.arch === 'arm64') ||
    (process.platform === 'win32' && process.arch === 'x64'), 'Supported setup hosts: macOS arm64 and Windows x86-64');
  let extractor: string;
  if (process.platform === 'darwin') extractor = '/usr/bin/unzip';
  else {
    assert.ok(process.env.SystemRoot, 'Windows setup requires SystemRoot and inbox tar.exe with ZIP support');
    extractor = join(process.env.SystemRoot, 'System32', 'tar.exe');
  }
  // This is trusted, reviewed repository metadata, not an input-supplied manifest.
  const manifest = JSON.parse(await readFile(new URL('./inputs.json', import.meta.url), 'utf8')) as InputManifest;
  assert.equal(manifest.schemaVersion, 1, 'Unsupported input manifest');
  assert.equal(manifest.inputs.length, 2, 'Expected the two reviewed SQLite pins');
  await mkdir(join(inputRoot, 'archives'), { recursive: true });
  const staging = await mkdtemp(join(inputRoot, '.prepare-'));
  try {
    for (const pin of manifest.inputs) {
      assert.ok(Number.isSafeInteger(pin.archive.sizeBytes) && pin.archive.sizeBytes > 0 &&
        pin.archive.sizeBytes <= maximumBytes, `${pin.id}: archive pin exceeds setup bound`);
      assert.ok(Number.isSafeInteger(pin.binary.sizeBytes) && pin.binary.sizeBytes >= 64 &&
        pin.binary.sizeBytes <= maximumBytes, `${pin.id}: binary pin exceeds setup bound`);
      const archivePath = join(inputRoot, 'archives', pin.archive.filename);
      let bytes: Buffer;
      try { bytes = await readArchive(archivePath, pin.archive.sizeBytes); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        bytes = await download(pin);
        const temporaryArchive = join(staging, pin.archive.filename);
        await writeFile(temporaryArchive, bytes, { flag: 'wx', mode: 0o600 });
        await rename(temporaryArchive, archivePath);
      }
      // Recheck cached/downloaded bytes before the OS utility sees the archive.
      verifyArchive(bytes, pin);
      const args: string[] = [process.platform === 'darwin' ? '-p' : '-xOf', archivePath, pin.binary.member];
      const result: SpawnSyncReturns<Buffer> = spawnSync(extractor, args, {
        stdio: ['ignore', 'pipe', 'pipe'], timeout: extractionDeadlineMs,
        killSignal: 'SIGKILL', maxBuffer: pin.binary.sizeBytes + 1, windowsHide: true,
      });
      if (result.error) throw new Error(`${pin.id}: extraction requires ${extractor}: ${result.error.message}`);
      assert.equal(result.status, 0,
        `${pin.id}: extraction failed (status ${result.status}, signal ${result.signal}): ${result.stderr?.toString('utf8').slice(0, 2048)}`);
      assert.ok(Buffer.isBuffer(result.stdout), `${pin.id}: extractor returned no binary bytes`);
      verifyBinary(result.stdout, pin);
      const temporaryBinary = join(staging, pin.binary.member);
      await writeFile(temporaryBinary, result.stdout, { flag: 'wx', mode: 0o600 });
      const binaryPath = resolve(root, pin.binary.path);
      await mkdir(dirname(binaryPath), { recursive: true });
      await rename(temporaryBinary, binaryPath);
      console.log(JSON.stringify({ input: pin.id, path: binaryPath, size_bytes: pin.binary.sizeBytes,
        sha256: pin.binary.sha256, format: pin.binary.format, architecture: pin.binary.architecture,
        archive_sha3_256: pin.archive.sha3_256, extractor, extraction_arguments: args }));
    }
  } finally { await rm(staging, { recursive: true, force: true }); }
}

main().catch((error: unknown) => {
  console.error(`Pinned benchmark input preparation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
