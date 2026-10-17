import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openBinary } from '../../src/api/index.js';
import { toolSchemas } from '../../src/core/index.js';
import type { ToolResult } from '../../src/core/index.js';

const execute = promisify(execFile);
const runner = fileURLToPath(new URL('./run-command.ts', import.meta.url));

test(
  'explicit slice and cache root isolate and reuse a real selected project',
  { timeout: 120_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-cli-slice-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, 'binary with spaces');
    await copyFile(resolve('fixtures/bin/macho-arm64-symbols'), binary);
    const cache = join(root, 'cache with spaces');
    const session = await openBinary(binary, { cachePath: cache });
    const slice = session.image.selected_slice_id,
      defaultProject = session.projectPath;
    await session.close();
    let selectedProject: string | undefined;
    for (const reused of [false, true]) {
      const { stdout, stderr } = await execute(
        process.execPath,
        [
          '--import',
          'tsx',
          runner,
          'functions',
          '--cache',
          cache,
          '--slice',
          slice,
          '--name',
          'not_a_real_symbol',
          '--json',
          '--',
          binary,
        ],
        { timeout: 60_000, killSignal: 'SIGKILL' },
      ).catch((error) => {
        // Exhausting a partial native index is a semantic result, not a process failure.
        assert.equal(error.code, 2, error.stderr);
        return { stdout: String(error.stdout), stderr: String(error.stderr) };
      });
      const output = JSON.parse(stdout) as {
        project_path: string;
        reused: boolean;
        result: { pages: ToolResult<'functions_find'>[] };
      };
      assert.equal(output.reused, reused, stderr);
      assert.ok(output.project_path.startsWith(`${cache}/`));
      assert.ok(output.project_path.endsWith(`.${slice}`));
      assert.notEqual(output.project_path, defaultProject);
      if (selectedProject !== undefined) assert.equal(output.project_path, selectedProject);
      selectedProject = output.project_path;
      assert.equal(output.result.pages.length, 1);
      toolSchemas.functions_find.output.parse(output.result.pages[0]);
    }
  },
);
