#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { arch, platform, tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const npmPackSchema = z.object({
  id: z.string(), name: z.string(), version: z.string(), filename: z.string(),
  size: z.number().int().positive(), unpackedSize: z.number().int().positive(),
  shasum: z.string().regex(/^[0-9a-f]{40}$/), integrity: z.string().startsWith('sha512-'),
  files: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative(), mode: z.number().int() }).passthrough()),
  bundled: z.array(z.string()),
}).passthrough();
export const releaseManifestSchema = z.object({
  schema_version: z.literal(1),
  created_at: z.string(),
  package: z.object({ name: z.literal('open-decomp'), version: z.string() }),
  artifact: z.object({ filename: z.string(), size: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/), shasum: z.string(), integrity: z.string() }),
  toolchain: z.object({ node: z.string(), npm: z.string(), platform: z.string(), architecture: z.string() }),
  lockfile: z.object({ path: z.literal('package-lock.json'), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  provenance: z.object({ git: z.literal('not asserted; artifact may include uncommitted local changes') }),
  npm_pack: npmPackSchema,
});

/** npm run supplies an explicit JS CLI; never interpolate paths through cmd.exe. */
export async function releaseNpmCli(): Promise<string> {
  const candidate = process.env.npm_execpath;
  if (!candidate || !isAbsolute(candidate) || basename(candidate).toLowerCase() !== 'npm-cli.js') {
    throw new Error('Run this driver through npm run pack:release or npm run verify:installed; an absolute npm_execpath pointing to npm-cli.js is required.');
  }
  const cli = await realpath(candidate);
  assert.ok((await lstat(cli)).isFile(), 'npm_execpath must identify the npm JavaScript CLI');
  return cli;
}

export async function runReleaseNpm(cli: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const result = await execFileAsync(process.execPath, [cli, ...args], { cwd, env, shell: false, maxBuffer: 64 * 1024 * 1024 });
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout;
}

export async function releaseArchiveIdentity(path: string): Promise<{ size: number; sha256: string; shasum: string; integrity: string }> {
  const sha256 = createHash('sha256'), sha1 = createHash('sha1'), sha512 = createHash('sha512');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    sha256.update(bytes); sha1.update(bytes); sha512.update(bytes);
  }
  return { size, sha256: sha256.digest('hex'), shasum: sha1.digest('hex'), integrity: `sha512-${sha512.digest('base64')}` };
}

async function packageRelease(): Promise<void> {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write('Usage: npm run pack:release -- --out DIR\nBuilds a fresh dist, packs bundled production dependencies and writes the tgz plus <tgz>.release.json. DIR must be empty. Does not publish.\n');
    return;
  }
  assert.ok(process.argv.length === 4 && process.argv[2] === '--out' && process.argv[3] && !process.argv[3].startsWith('--') && !process.argv[3].includes('\0'), 'Usage: npm run pack:release -- --out DIR');
  const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
  const npm = await releaseNpmCli();
  const packageBytes = await readFile(join(root, 'package.json'));
  const metadata = z.object({ name: z.literal('open-decomp'), version: z.string(), private: z.literal(true), bundleDependencies: z.literal(true), dependencies: z.record(z.string(), z.string()) }).parse(JSON.parse(packageBytes.toString('utf8')));
  const build = z.object({ compilerOptions: z.object({ outDir: z.string() }) }).parse(JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8')));
  const declaredDist = resolve(root, build.compilerOptions.outDir);
  assert.equal(declaredDist, join(root, 'dist'), 'Only the declared generated repository dist may be cleaned');
  const lock = await readFile(join(root, 'package-lock.json'));
  const lockSha256 = createHash('sha256').update(lock).digest('hex');
  const requestedOutput = resolve(process.argv[3]);
  const fromDist = relative(declaredDist, requestedOutput);
  assert.ok(fromDist === '..' || fromDist.startsWith(`..${sep}`) || isAbsolute(fromDist), 'Release output cannot be inside generated dist');
  await mkdir(requestedOutput, { recursive: true });
  const output = await realpath(requestedOutput);
  const outputFromDist = relative(declaredDist, output);
  assert.ok(outputFromDist === '..' || outputFromDist.startsWith(`..${sep}`) || isAbsolute(outputFromDist), 'Release output cannot resolve inside generated dist');
  assert.deepEqual(await readdir(output), [], 'Release output must be empty; existing files are never removed');
  // dist is the sole declared generated tree, not an operator-supplied path.
  try { assert.equal((await lstat(declaredDist)).isSymbolicLink(), false, 'Generated dist must not be a symlink'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await rm(declaredDist, { recursive: true, force: true });
  const buildOutput = await runReleaseNpm(npm, ['run', 'build'], root);
  if (buildOutput) process.stderr.write(buildOutput);
  const npmVersion = (await runReleaseNpm(npm, ['--version'], root)).trim();
  const staging = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-pack-')));
  const created: string[] = [];
  try {
    const packed = z.array(npmPackSchema).length(1).parse(JSON.parse(await runReleaseNpm(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', staging], root)))[0]!;
    assert.equal(packed.name, metadata.name);
    assert.equal(packed.version, metadata.version);
    assert.ok(basename(packed.filename) === packed.filename && packed.filename.endsWith('.tgz'), 'npm returned an unsafe archive filename');
    for (const dependency of Object.keys(metadata.dependencies)) assert.ok(packed.bundled.includes(dependency), `Missing bundled production dependency: ${dependency}`);
    for (const path of ['dist/src/index.js', 'dist/src/mcp/stdio.js', 'dist/vendor/a64js/src/decode.js']) assert.ok(packed.files.some(file => file.path === path), `Missing compiled runtime: ${path}`);
    assert.ok(packed.files.every(file => !file.path.startsWith('vendor/a64js/src/')), 'Do not distribute duplicate uncompiled a64js runtime');
    assert.deepEqual(await readFile(join(root, 'package.json')), packageBytes, 'Package metadata changed during release');
    assert.equal(createHash('sha256').update(await readFile(join(root, 'package-lock.json'))).digest('hex'), lockSha256, 'Lockfile changed during release');
    const stagedArchive = join(staging, packed.filename);
    const identity = await releaseArchiveIdentity(stagedArchive);
    assert.equal(identity.size, packed.size);
    assert.equal(identity.shasum, packed.shasum);
    assert.equal(identity.integrity, packed.integrity);
    const manifest = releaseManifestSchema.parse({
      schema_version: 1, created_at: new Date().toISOString(),
      package: { name: metadata.name, version: metadata.version }, artifact: { filename: packed.filename, ...identity },
      toolchain: { node: process.version, npm: npmVersion, platform: platform(), architecture: arch() },
      lockfile: { path: 'package-lock.json', sha256: lockSha256 },
      provenance: { git: 'not asserted; artifact may include uncommitted local changes' }, npm_pack: packed,
    });
    const archive = join(output, packed.filename), manifestPath = `${archive}.release.json`;
    // Exclusive creation protects collisions, including files created since preflight.
    await copyFile(stagedArchive, archive, constants.COPYFILE_EXCL);
    created.push(archive);
    const manifestFile = await open(manifestPath, 'wx');
    created.push(manifestPath);
    try { await manifestFile.writeFile(`${JSON.stringify(manifest, null, 2)}\n`); }
    finally { await manifestFile.close(); }
    process.stdout.write(`${JSON.stringify({ scenario: 'release-packed', outcome: 'passed', archive, manifest: manifestPath, ...identity, toolchain: manifest.toolchain, lockfile: manifest.lockfile, files: packed.files.length, bundled: packed.bundled })}\n`);
  } catch (error) {
    for (const path of created) await rm(path, { force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await packageRelease(); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
