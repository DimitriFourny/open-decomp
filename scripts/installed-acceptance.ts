#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { arch, platform, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { readMcpFixture } from './mcp-workflow.js';
import { releaseArchiveIdentity, releaseManifestSchema, releaseNpmCli, runReleaseNpm } from './package-release.js';
import { runReleaseAcceptance } from './release-acceptance.js';

const host = { node: process.version, platform: platform(), architecture: arch() };
const fixtureManifestSchema = z.object({
  images: z.array(z.object({ path: z.string().regex(/^fixtures\/bin\/[^/\\]+$/) })),
  malformed: z.array(z.object({ path: z.string().regex(/^fixtures\/malformed\/[^/\\]+$/) })),
});

// This is a Node module, not another MCP client. Only the installed public API
// and copied immutable binary inputs are visible to this separate process.
const installedProbe = String.raw`
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as app from 'open-decomp';
const [fixtures, expectedEntry] = process.argv.slice(2);
assert.equal(import.meta.resolve('open-decomp'), expectedEntry);
console.log(JSON.stringify({ scenario: 'installed-root-import', outcome: 'passed', entry: import.meta.resolve('open-decomp'), node: process.version, platform: process.platform, architecture: process.arch }));
for (const target of [
  { file: 'macho-arm64-symbols', Loader: app.MachOLoader, Decoder: app.Arm64Decoder, architecture: 'arm64', mode: 'a64', address: 0x100000574n, size: 20n, count: 5 },
  { file: 'corpus-symbols.dll', Loader: app.PELoader, Decoder: app.X86Decoder, architecture: 'x86_64', mode: 'long64', address: 0x180001030n, size: 9n, count: 4 },
]) {
  const data = await readFile(join(fixtures, target.file));
  const sha256 = app.contentHash(data), context = app.createOperationContext();
  const image = new target.Loader().load({ image_id: app.imageIdentity(sha256), sha256, bytes: new app.ImmutableBytes(data), slice_id: null }, context);
  assert.equal(image.target.architecture, target.architecture);
  const decoder = new target.Decoder();
  try {
    const result = decoder.decode({ image, mode: target.mode, features: image.target.features, regions: [{ start: { image_id: image.id, space: 'va', value: target.address }, size: target.size }] }, context);
    assert.equal(result.coverage.state, 'complete');
    assert.deepEqual(result.gaps, []);
    assert.equal(result.instructions.length, target.count);
    assert.ok(result.instructions.every(instruction => instruction.validity === 'valid' && instruction.payload?.architecture === target.architecture));
    assert.equal(result.instructions.at(-1).flow.kind, 'return');
    if (target.architecture === 'arm64') assert.equal(result.instructions[3].payload.canonical_encoding, 'EOR_32_log_shift');
    else assert.deepEqual(result.instructions.map(instruction => instruction.payload.mnemonic), ['lea', 'add', 'xor', 'ret']);
    console.log(JSON.stringify({ scenario: 'installed-real-decoder', outcome: 'passed', architecture: target.architecture, fixture: target.file, sha256, instructions: result.instructions.length, decoder: decoder.name, version: decoder.version }));
  } finally { decoder.dispose(); }
}
for (const [name, format, language, fragment] of [
  ['__ZN7fixture3barEi', 'macho', 'c++-itanium', 'fixture::bar'],
  ['?bar@fixture@@YAHH@Z', 'pe', 'c++-msvc', 'fixture::bar'],
  ['$sSi1soiyS2i_SitFZ', 'macho', 'swift', 'Swift.Int'],
]) {
  const result = await app.demangleName(name, format, app.createOperationContext());
  assert.equal(result.original_name, name);
  assert.equal(result.language, language);
  assert.equal(result.status, 'demangled', JSON.stringify(result));
  assert.ok(result.display_name?.includes(fragment), JSON.stringify(result));
  assert.deepEqual(result.diagnostics, []);
  console.log(JSON.stringify({ scenario: 'installed-real-wasm-demangler', outcome: 'passed', ...result }));
}
`;

async function installedAcceptance(): Promise<void> {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write('Usage: npm run verify:installed -- --artifact FILE --fixtures fixtures/bin\nRequires FILE.release.json beside the tgz. Installs offline into a disposable external root with an empty cache, checks the installed public API/decoders/demanglers and runs the maintained MCP release suite using copied fixtures. Never executes target binaries.\n');
    return;
  }
  let artifactArgument: string | undefined, fixtureArgument: string | undefined;
  const seen = new Set<string>();
  for (let index = 2; index < process.argv.length; index++) {
    const flag = process.argv[index]!;
    assert.ok(flag === '--artifact' || flag === '--fixtures', `Unknown argument: ${flag}`);
    assert.ok(!seen.has(flag), `Duplicate argument: ${flag}`);
    seen.add(flag);
    const value = process.argv[++index];
    assert.ok(value && !value.startsWith('--') && !value.includes('\0'), `Missing or malformed ${flag}`);
    if (flag === '--artifact') artifactArgument = value;
    else fixtureArgument = value;
  }
  assert.ok(artifactArgument && fixtureArgument, 'Usage: npm run verify:installed -- --artifact FILE --fixtures fixtures/bin');
  const npm = await releaseNpmCli();
  const artifact = await realpath(resolve(artifactArgument));
  assert.ok((await lstat(artifact)).isFile() && artifact.endsWith('.tgz'), 'Artifact must be an actual npm tgz file');
  const manifestPath = `${artifact}.release.json`;
  const manifest = releaseManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  assert.equal(manifest.artifact.filename, basename(artifact));
  assert.equal(manifest.npm_pack.filename, manifest.artifact.filename);
  assert.equal(manifest.npm_pack.name, manifest.package.name);
  assert.equal(manifest.npm_pack.version, manifest.package.version);
  assert.equal(manifest.npm_pack.size, manifest.artifact.size);
  assert.equal(manifest.npm_pack.integrity, manifest.artifact.integrity);
  assert.equal(manifest.npm_pack.shasum, manifest.artifact.shasum);
  const sourceFixtures = await realpath(resolve(fixtureArgument));
  const sourceManifestBytes = await readFile(join(dirname(sourceFixtures), 'manifest.json'));
  const sourceManifest = fixtureManifestSchema.parse(JSON.parse(sourceManifestBytes.toString('utf8')));
  const sourceRoot = await realpath(fileURLToPath(new URL('../', import.meta.url)));
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-installed-')));
  try {
    const outsideSource = relative(sourceRoot, temporary);
    assert.ok(outsideSource === '..' || outsideSource.startsWith(`..${sep}`) || isAbsolute(outsideSource), 'Installation must be outside the source checkout; configure an external OS temporary directory');
    const install = join(temporary, 'install'), cache = join(temporary, 'empty-npm-cache'), inputs = join(temporary, 'inputs');
    const fixtures = join(inputs, 'bin');
    await mkdir(install);
    await mkdir(cache);
    await mkdir(fixtures, { recursive: true });
    await mkdir(join(inputs, 'malformed'));
    await writeFile(join(inputs, 'manifest.json'), sourceManifestBytes, { flag: 'wx' });
    const fixtureIdentities: { path: string; sha256: string; size: number }[] = [];
    for (const record of [...sourceManifest.images, ...sourceManifest.malformed]) {
      const path = record.path.slice('fixtures/'.length);
      const bytes = await readMcpFixture(sourceFixtures, path);
      await writeFile(join(inputs, path), bytes, { flag: 'wx', mode: 0o600 });
      fixtureIdentities.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
    }
    const copiedArtifact = join(temporary, basename(artifact));
    await copyFile(artifact, copiedArtifact);
    const identity = await releaseArchiveIdentity(copiedArtifact);
    assert.equal(identity.size, manifest.artifact.size);
    assert.equal(identity.sha256, manifest.artifact.sha256);
    assert.equal(identity.shasum, manifest.artifact.shasum);
    assert.equal(identity.integrity, manifest.artifact.integrity);
    const npmVersion = (await runReleaseNpm(npm, ['--version'], install)).trim();
    process.stdout.write(`${JSON.stringify({ scenario: 'installed-artifact-identity', outcome: 'passed', artifact, manifest: manifestPath, ...identity, host: { ...host, npm: npmVersion }, built_with: manifest.toolchain, lockfile: manifest.lockfile, fixture_manifest_sha256: createHash('sha256').update(sourceManifestBytes).digest('hex'), fixtures: fixtureIdentities })}\n`);
    await writeFile(join(install, 'package.json'), JSON.stringify({ name: 'open-decomp-installed-acceptance', private: true, type: 'module' }), { flag: 'wx' });
    const userConfig = join(temporary, 'user.npmrc'), globalConfig = join(temporary, 'global.npmrc');
    await writeFile(userConfig, '', { flag: 'wx' });
    await writeFile(globalConfig, '', { flag: 'wx' });
    // No inherited NODE_OPTIONS, NODE_PATH, npm configuration or source loaders.
    const environment: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|TEMP|TMP|LOCALAPPDATA|APPDATA)$/i.test(name)) environment[name] = value;
    }
    assert.deepEqual(await readdir(cache), [], 'Offline installation must start with an empty cache');
    const installOutput = await runReleaseNpm(npm, ['install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--no-update-notifier', '--package-lock=false', '--cache', cache, '--userconfig', userConfig, '--globalconfig', globalConfig, '--', copiedArtifact], install, environment);
    if (installOutput) process.stderr.write(installOutput);
    const installedPackage = join(install, 'node_modules', manifest.package.name);
    const installedMetadata = z.object({ name: z.string(), version: z.string(), bin: z.object({ 'open-decomp': z.string() }) }).parse(JSON.parse(await readFile(join(installedPackage, 'package.json'), 'utf8')));
    assert.equal(installedMetadata.name, manifest.package.name);
    assert.equal(installedMetadata.version, manifest.package.version);
    assert.equal(installedMetadata.bin['open-decomp'].replace(/^\.\//, ''), 'dist/src/mcp/stdio.js');
    for (const file of manifest.npm_pack.files) {
      assert.ok(file.path !== '' && !file.path.includes('\\') && !isAbsolute(file.path) && !file.path.split('/').some(part => part === '..' || part === '.'), `Unsafe npm inventory path: ${file.path}`);
      const installedFile = join(installedPackage, file.path);
      const actual = await realpath(installedFile), inside = relative(install, actual);
      assert.ok(inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside), `Installed file escapes isolated root: ${file.path}`);
      const stat = await lstat(actual);
      assert.ok(stat.isFile(), `Installed inventory entry is not a file: ${file.path}`);
      assert.equal(stat.size, file.size, `Installed size differs from npm inventory: ${file.path}`);
    }
    const serverEntry = join(installedPackage, 'dist', 'src', 'mcp', 'stdio.js');
    const publicEntry = pathToFileURL(join(installedPackage, 'dist', 'src', 'index.js')).href;
    process.stdout.write(`${JSON.stringify({ scenario: 'empty-cache-offline-install', outcome: 'passed', host, package: installedMetadata.name, version: installedMetadata.version, inventory_files: manifest.npm_pack.files.length, artifact_sha256: identity.sha256 })}\n`);
    const probe = join(install, 'installed-probe.mjs');
    await writeFile(probe, installedProbe, { flag: 'wx' });
    const probeProcess = spawn(process.execPath, [probe, fixtures, publicEntry], { cwd: install, env: environment, shell: false, stdio: 'inherit' });
    await new Promise<void>((resolveProbe, reject) => {
      probeProcess.once('error', reject);
      probeProcess.once('exit', (code, signal) => {
        if (code === 0) resolveProbe();
        else reject(new Error(`Installed API/decoder/demangler probe failed (exit=${code}, signal=${signal})`));
      });
    });
    // SDK and typed client-side validation are developer assets; the application
    // and every server/worker run strictly from the installed package and inputs.
    await runReleaseAcceptance({ serverEntry, fixtures, serverCwd: install, serverEnv: environment, temporaryRoot: temporary });
    process.stdout.write(`${JSON.stringify({ scenario: 'installed-acceptance-complete', outcome: 'passed', artifact, artifact_sha256: identity.sha256, integrity: identity.integrity, host: { ...host, npm: npmVersion }, mcp: 'complete-maintained-release-suite' })}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

try { await installedAcceptance(); }
catch (error) {
  console.error(error);
  process.stdout.write(`${JSON.stringify({ scenario: 'installed-acceptance-complete', outcome: 'failed', host, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
