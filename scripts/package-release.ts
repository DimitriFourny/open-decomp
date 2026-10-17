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
const archiveFileSchema = z.object({
  path: z.string(), size: z.number().int().nonnegative(), mode: z.number().int(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const bunPackSchema = z.object({
  name: z.string(), version: z.string(), filename: z.string(),
  size: z.number().int().positive(), unpackedSize: z.number().int().positive(),
  files: z.array(archiveFileSchema), bundled: z.array(z.string()),
});
export const releaseManifestSchema = z.object({
  schema_version: z.literal(2),
  created_at: z.string(),
  package: z.object({ name: z.literal('open-decomp'), version: z.string() }),
  source_package: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), production_dependencies: z.record(z.string(), z.string()) }),
  artifact: z.object({ filename: z.string(), size: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/), shasum: z.string(), integrity: z.string() }),
  toolchain: z.object({ node: z.string(), bun: z.string(), platform: z.string(), architecture: z.string() }),
  lockfile: z.object({ path: z.literal('bun.lock'), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  provenance: z.object({ git: z.literal('not asserted; artifact may include uncommitted local changes') }),
  bun_pack: bunPackSchema,
});

/** Bun run supplies its native executable; never interpolate paths through a shell. */
export async function releaseBunCli(): Promise<string> {
  const candidate = process.env.npm_execpath;
  if (!candidate || !isAbsolute(candidate) || !/^bun(?:\.exe)?$/i.test(basename(candidate))) {
    throw new Error('Run this driver through bun run pack:release or bun run verify:installed; an absolute npm_execpath pointing to Bun is required.');
  }
  const cli = await realpath(candidate);
  assert.ok((await lstat(cli)).isFile(), 'npm_execpath must identify the Bun executable');
  return cli;
}

export async function runReleaseBun(cli: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const result = await execFileAsync(cli, [...args], { cwd, env, shell: false, maxBuffer: 64 * 1024 * 1024 });
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

/** Use the host archive utility, not human-oriented Bun pack output, as inventory authority. */
export async function releaseArchiveInventory(archive: string, destination: string): Promise<{ files: z.infer<typeof archiveFileSchema>[]; bundled: string[] }> {
  const options = { shell: false, maxBuffer: 64 * 1024 * 1024 };
  const listing = (await execFileAsync('tar', ['-tzf', archive], options)).stdout.trimEnd().split('\n');
  assert.ok(listing.length > 0 && new Set(listing).size === listing.length, 'Archive entries must be nonempty and unique');
  for (const entry of listing) {
    const path = entry.replace(/\/$/, '');
    assert.ok((path === 'package' && entry.endsWith('/') || path.startsWith('package/')) && !/[\\\x00-\x1f\x7f]/.test(path) && !path.split('/').some(part => part === '..' || part === '.' || part === ''), `Unsafe archive path: ${entry}`);
  }
  const types = (await execFileAsync('tar', ['-tvzf', archive], options)).stdout.trimEnd().split('\n');
  assert.equal(types.length, listing.length, 'Archive listings disagree');
  assert.ok(types.every(entry => entry.startsWith('-') || entry.startsWith('d')), 'Archive may contain only regular files and directories, not links or special files');
  await mkdir(destination);
  await execFileAsync('tar', ['-xpzf', archive, '--no-same-owner', '-C', destination], options);
  const root = join(destination, 'package');
  const files: z.infer<typeof archiveFileSchema>[] = [];
  const bundled = new Set<string>();
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else {
        assert.ok(entry.isFile(), `Archive inventory entry is not a regular file: ${path}`);
        const stat = await lstat(path);
        const name = relative(root, path).split(sep).join('/');
        const bytes = await readFile(path);
        files.push({ path: name, size: stat.size, mode: stat.mode & 0o7777, sha256: createHash('sha256').update(bytes).digest('hex') });
        if (/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(name)) {
          const dependency = z.object({ name: z.string() }).parse(JSON.parse(bytes.toString('utf8')));
          bundled.add(dependency.name);
        }
      }
    }
  }
  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const listedFiles = listing.filter(entry => !entry.endsWith('/')).map(entry => entry.slice('package/'.length)).sort();
  assert.deepEqual(files.map(file => file.path).sort(), listedFiles, 'Extracted inventory differs from archive entries');
  return { files, bundled: [...bundled].sort() };
}

async function assertProductionClosure(root: string, dependencies: Record<string, string>): Promise<void> {
  const metadata = z.object({ name: z.string(), dependencies: z.record(z.string(), z.string()).optional() });
  const visited = new Set<string>();
  async function visit(directory: string, required: Record<string, string>): Promise<void> {
    for (const name of Object.keys(required)) {
      assert.ok(/^(?:@[^/\\]+\/)?[^/\\]+$/.test(name) && name !== '.' && name !== '..', `Unsafe dependency name: ${name}`);
      let ancestor = directory, dependency: string | undefined;
      while (true) {
        const candidate = join(ancestor, 'node_modules', name, 'package.json');
        try { if ((await lstat(candidate)).isFile()) { dependency = candidate; break; } }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (ancestor === root) break;
        ancestor = resolve(ancestor, '..');
        assert.ok(ancestor === root || ancestor.startsWith(`${root}${sep}`), 'Dependency resolution escaped packaged root');
      }
      assert.ok(dependency, `Missing bundled production dependency: ${name}`);
      if (visited.has(dependency)) continue;
      visited.add(dependency);
      const record = metadata.parse(JSON.parse(await readFile(dependency, 'utf8')));
      assert.equal(record.name, name);
      await visit(resolve(dependency, '..'), record.dependencies ?? {});
    }
  }
  await visit(root, dependencies);
}

async function packBunArchive(bun: string, root: string, destination: string): Promise<string> {
  await mkdir(destination);
  await runReleaseBun(bun, ['pm', 'pack', '--destination', destination, '--ignore-scripts', '--quiet'], root);
  const entries = await readdir(destination);
  assert.ok(entries.length === 1 && entries[0]!.endsWith('.tgz'), 'Bun must produce exactly one tgz archive');
  const archive = join(destination, entries[0]!);
  assert.ok((await lstat(archive)).isFile(), 'Bun archive must be a regular file');
  return archive;
}

async function packageRelease(): Promise<void> {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write('Usage: bun run pack:release --out DIR\nBuilds a fresh dist, packs bundled production dependencies and writes the tgz plus <tgz>.release.json. DIR must be empty. Requires the host tar utility. Does not publish.\n');
    return;
  }
  assert.ok(process.argv.length === 4 && process.argv[2] === '--out' && process.argv[3] && !process.argv[3].startsWith('--') && !process.argv[3].includes('\0'), 'Usage: bun run pack:release --out DIR');
  const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
  const bun = await releaseBunCli();
  const packageBytes = await readFile(join(root, 'package.json'));
  const metadata = z.object({ name: z.literal('open-decomp'), version: z.string(), private: z.literal(true), bundleDependencies: z.literal(true), dependencies: z.record(z.string(), z.string()) }).parse(JSON.parse(packageBytes.toString('utf8')));
  const build = z.object({ compilerOptions: z.object({ outDir: z.string() }) }).parse(JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8')));
  const declaredDist = resolve(root, build.compilerOptions.outDir);
  assert.equal(declaredDist, join(root, 'dist'), 'Only the declared generated repository dist may be cleaned');
  const lock = await readFile(join(root, 'bun.lock'));
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
  const buildOutput = await runReleaseBun(bun, ['run', 'build'], root);
  if (buildOutput) process.stderr.write(buildOutput);
  const bunVersion = (await runReleaseBun(bun, ['--version'], root)).trim();
  const staging = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-pack-')));
  const created: string[] = [];
  try {
    const initialArchive = await packBunArchive(bun, root, join(staging, 'initial'));
    const initialInventory = await releaseArchiveInventory(initialArchive, join(staging, 'source'));
    const stagedRoot = join(staging, 'source', 'package');
    await assertProductionClosure(stagedRoot, metadata.dependencies);
    const stagedMetadata = JSON.parse(await readFile(join(stagedRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(stagedMetadata.name, metadata.name);
    assert.equal(stagedMetadata.version, metadata.version);
    // Bun 1.4.3 resolves declared dependencies even when they are bundled.
    // The private distribution is self-contained: retain the real bundle, but
    // declare no registry-resolved dependencies. Source metadata is never edited.
    delete stagedMetadata.dependencies;
    delete stagedMetadata.devDependencies;
    delete stagedMetadata.bundledDependencies;
    stagedMetadata.bundleDependencies = Object.keys(metadata.dependencies);
    const stagedPackage = await open(join(stagedRoot, 'package.json'), 'w');
    try { await stagedPackage.writeFile(`${JSON.stringify(stagedMetadata, null, 2)}\n`); }
    finally { await stagedPackage.close(); }
    const stagedArchive = await packBunArchive(bun, stagedRoot, join(staging, 'final'));
    const inventory = await releaseArchiveInventory(stagedArchive, join(staging, 'inventory'));
    assert.deepEqual(inventory.files.filter(file => file.path !== 'package.json'), initialInventory.files.filter(file => file.path !== 'package.json'), 'Repacking changed the bundled runtime inventory');
    await assertProductionClosure(join(staging, 'inventory', 'package'), metadata.dependencies);
    for (const path of ['dist/src/index.js', 'dist/src/mcp/stdio.js', 'dist/vendor/a64js/src/decode.js']) assert.ok(inventory.files.some(file => file.path === path), `Missing compiled runtime: ${path}`);
    assert.ok(inventory.files.every(file => !file.path.startsWith('vendor/a64js/src/')), 'Do not distribute duplicate uncompiled a64js runtime');
    assert.deepEqual(await readFile(join(root, 'package.json')), packageBytes, 'Package metadata changed during release');
    assert.equal(createHash('sha256').update(await readFile(join(root, 'bun.lock'))).digest('hex'), lockSha256, 'Lockfile changed during release');
    const identity = await releaseArchiveIdentity(stagedArchive);
    const packed = bunPackSchema.parse({ name: metadata.name, version: metadata.version, filename: basename(stagedArchive), size: identity.size, unpackedSize: inventory.files.reduce((size, file) => size + file.size, 0), ...inventory });
    const manifest = releaseManifestSchema.parse({
      schema_version: 2, created_at: new Date().toISOString(),
      package: { name: metadata.name, version: metadata.version },
      source_package: { sha256: createHash('sha256').update(packageBytes).digest('hex'), production_dependencies: metadata.dependencies },
      artifact: { filename: packed.filename, ...identity },
      toolchain: { node: process.version, bun: bunVersion, platform: platform(), architecture: arch() },
      lockfile: { path: 'bun.lock', sha256: lockSha256 },
      provenance: { git: 'not asserted; artifact may include uncommitted local changes' }, bun_pack: packed,
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
