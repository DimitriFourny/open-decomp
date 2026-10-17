import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exerciseSourceQuality, prepareSourceQuality } from './source-quality-harness.js';

// No debug/source/prototypes are provided to any consumer. Only newly compiled,
// checked-in trusted source runs natively; emitted output runs in the independent
// text evaluator shared with the pre-pass stack/FP/SQLite/control regressions.
test(
  'CLI, BinarySession API and SDK stdio MCP preserve source return/memory/call/branch behavior in both dialects',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 360000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-public-source-quality-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixture = await prepareSourceQuality(root);
    for (const consumer of ['cli', 'api', 'mcp'] as const) {
      await t.test(consumer, async () => {
        await exerciseSourceQuality(fixture, consumer);
      });
    }
  },
);
