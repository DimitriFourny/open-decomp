import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { openBinary } from '../../../src/api/index.js';
import { CLANG, nativeOracleSkip } from '../../support/host-tools.js';

// A request's output may depend on its own budget but never on what earlier requests of the
// same process happened to do. Image-scoped indexes and selected-local graphs are built or
// kept once per process; the request that built one must not be charged more work than a
// request that reused it, or the callee-loading reserve (half of the work left after the
// selected body) lands differently and later decisions differ: different callees become
// partial, so different structure names appear. The work budgets sweep the range in which
// the reserve cut-off of this call tree falls. Each session is a fresh sidecar process, so
// "cold" means no in-process cache and no persisted summary of any kind.
const budgets = [80_000, 84_000, 88_000, 92_000, 96_000, 100_000, 104_000, 108_000];

test(
  'a decompilation is identical whether the process served other requests first or not',
  { skip: nativeOracleSkip(), timeout: 300_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-request-determinism-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, 'determinism');
    const compiled = spawnSync(
      CLANG,
      [
        '-target',
        'arm64-apple-macos13.0',
        '-O1',
        '-g0',
        '-fno-inline',
        resolve('test/service/analysis/request-determinism-source.c'),
        '-o',
        binary,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    let sessions = 0;
    const run = async (order: readonly string[], work: number): Promise<string[]> => {
      const session = await openBinary(binary, { cachePath: join(root, `cache-${sessions++}`) });
      try {
        const texts: string[] = [];
        for (const name of order) {
          const result = await session.decompile({ name }, { emitter: 'c-like', budget: { work } });
          texts.push(
            'data' in result && result.data.delivery === 'inline'
              ? result.data.emission.text
              : `unavailable: ${result.state}`,
          );
        }
        return texts;
      } finally {
        await session.close();
      }
    };
    for (const work of budgets) {
      const [cold] = await run(['root'], work);
      assert.ok(cold !== undefined);
      // The same request again, and after another function warmed the same process.
      const repeated = await run(['root', 'root'], work);
      const afterOther = await run(['mid_three', 'root'], work);
      assert.equal(repeated[1], cold, `work ${work}: repeated request`);
      assert.equal(afterOther[1], cold, `work ${work}: request after another function`);
    }
  },
);
