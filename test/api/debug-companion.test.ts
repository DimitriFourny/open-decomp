import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { BinaryOpenError, FunctionSelectionError, openBinary } from '../../src/api/index.js';
import type { BinarySession, ToolResult } from '../../src/api/index.js';

const FIXTURES = resolve('test/metadata/debug/fixtures/elf');

async function setup(t: TestContext, ...names: string[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-debug-')));
  for (const name of names) await copyFile(join(FIXTURES, name), join(root, name));
  const sessions: BinarySession[] = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, sessions };
}
function text(result: ToolResult<'function_decompile'>): string {
  assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
  return result.data.emission.text;
}

test(
  'a stripped ELF opened with its debug file gets names, prototypes, structures and globals',
  { timeout: 120000 },
  async (t) => {
    const { root, sessions } = await setup(t, 'shapes-stripped', 'shapes.debug');
    const options = { analysisCache: false, openJob: false } as const;
    const bare = await openBinary(join(root, 'shapes-stripped'), options);
    sessions.push(bare);
    assert.equal(bare.image.debug?.source, 'none');
    await assert.rejects(bare.decompile({ name: 'registry_add' }), FunctionSelectionError);
    const session = await openBinary(join(root, 'shapes-stripped'), {
      ...options,
      debugPath: join(root, 'shapes.debug'),
    });
    sessions.push(session);
    // The pair is its own project next to the bare one.
    assert.notEqual(session.projectPath, bare.projectPath);
    assert.match(session.projectPath, /\.default\.debug-[0-9a-f]{64}$/);
    assert.equal((await readdir(join(session.projectPath, 'debug'))).length, 1);
    const debug = session.image.debug!;
    assert.equal(debug.source, 'companion');
    assert.equal(debug.matched_by, 'build-id');
    assert.equal(debug.functions, 8);
    const add = text(await session.decompile({ name: 'registry_add' }));
    assert.match(add, /void registry_add\(registry_t\* reg, shape\* s\)/);
    assert.match(add, /struct registry_t \{ shape\* head; uint64_t count; int64_t total_area; \}/);
    assert.match(add, /reg->count = reg->count \+ 1;/);
    const visit = text(await session.decompile({ name: 'registry_visit' }));
    assert.match(visit, /int32_t registry_visit\(registry_t\* reg, void\* cookie\)/);
    // -O0 locals take their declared names from their frame homes.
    assert.match(visit, /uint32_t visited;/);
    const main = text(await session.decompile({ name: 'main' }));
    assert.match(main, /extern registry_t global_registry;/);
    assert.match(main, /global_registry\.total_area/);
  },
);

test('a debug file of another build is rejected before any project is published', async (t) => {
  const { root, sessions } = await setup(t, 'shapes-stripped', 'shapes-gz');
  await assert.rejects(
    async () => {
      sessions.push(
        await openBinary(join(root, 'shapes-stripped'), {
          analysisCache: false,
          openJob: false,
          debugPath: join(root, 'shapes-gz'),
        }),
      );
    },
    (error: unknown) =>
      error instanceof BinaryOpenError && /build ID .* does not match/.test(error.message),
  );
});

test(
  'embedded ELF DWARF reports its summary and types the decompilation',
  { timeout: 120000 },
  async (t) => {
    const { root, sessions } = await setup(t, 'shapes-g');
    const session = await openBinary(join(root, 'shapes-g'), {
      analysisCache: false,
      openJob: false,
    });
    sessions.push(session);
    const debug = session.image.debug!;
    assert.equal(debug.source, 'embedded');
    assert.equal(debug.status, 'partial');
    assert.equal(debug.matched_by, null);
    assert.equal(debug.companion_sha256, null);
    assert.ok(debug.lines > 0 && debug.variables > 0);
    const area = text(await session.decompile({ name: 'shape_area' }));
    assert.match(area, /^int64_t shape_area\(shape\* s\) \{$/m);
  },
);

test(
  'a PE opened with its PDB gets names, prototypes, structures, globals and local names',
  { timeout: 120000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-pdb-')));
    const sessions: BinarySession[] = [];
    t.after(async () => {
      await Promise.all(sessions.map((session) => session.close()));
      await rm(root, { recursive: true, force: true });
    });
    for (const name of ['shapes-O0.exe', 'shapes-O0.pdb', 'shapes-O2.pdb'])
      await copyFile(join(FIXTURES, '../pe', name), join(root, name));
    const options = { analysisCache: false, openJob: false } as const;
    const bare = await openBinary(join(root, 'shapes-O0.exe'), options);
    sessions.push(bare);
    assert.equal(bare.image.debug?.source, 'none');
    await assert.rejects(bare.decompile({ name: 'registry_visit' }), FunctionSelectionError);
    const session = await openBinary(join(root, 'shapes-O0.exe'), {
      ...options,
      debugPath: join(root, 'shapes-O0.pdb'),
    });
    sessions.push(session);
    const debug = session.image.debug!;
    assert.equal(debug.source, 'companion');
    assert.equal(debug.matched_by, 'guid-age');
    assert.equal(debug.pdb?.age, 1);
    assert.equal(debug.functions, 10);
    assert.ok(debug.lines > 0 && debug.variables > 0);
    const visit = text(await session.decompile({ name: 'registry_visit' }));
    assert.match(visit, /int32_t registry_visit\(registry\* reg, void\* cookie\)/);
    assert.match(visit, /uint32_t visited;/);
    const main = text(await session.decompile({ name: 'shapes_main' }));
    assert.match(main, /extern registry global_registry;/);
    await assert.rejects(
      async () => {
        sessions.push(
          await openBinary(join(root, 'shapes-O0.exe'), {
            ...options,
            debugPath: join(root, 'shapes-O2.pdb'),
          }),
        );
      },
      (error: unknown) =>
        error instanceof BinaryOpenError &&
        /does not match the image's PDB reference/.test(error.message),
    );
  },
);
