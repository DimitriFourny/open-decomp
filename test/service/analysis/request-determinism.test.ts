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

// A callee whose only reason is `unresolved control flow` (an indirect call) is retained in
// process and persisted, so later requests reuse it. They must produce the text and charge
// the work of a request that prepared everything itself, whatever ran before it.
test(
  'a callee with an unresolved indirect call is reused with identical output and work',
  { skip: nativeOracleSkip(), timeout: 300_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-retained-reasons-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, 'retained');
    const compiled = spawnSync(
      CLANG,
      [
        '-target',
        'arm64-apple-macos13.0',
        '-O1',
        '-g0',
        '-fno-inline',
        resolve('test/service/analysis/retained-reasons-source.c'),
        '-o',
        binary,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    let sessions = 0;
    const run = async (cache: string, names: readonly string[]) => {
      const session = await openBinary(binary, { cachePath: join(root, cache) });
      try {
        const results: { text: string; work: unknown }[] = [];
        for (const name of names) {
          const result = await session.decompile({ name }, { emitter: 'c-like' });
          assert.ok('data' in result && result.data.delivery === 'inline', name);
          results.push({ text: result.data.emission.text, work: result.data.work });
        }
        return results;
      } finally {
        await session.close();
      }
    };
    // Reference: each function alone in a fresh cache.
    const cold = new Map<string, { text: string; work: unknown }>();
    for (const name of ['user_a', 'user_b', 'user_c'])
      cold.set(name, (await run(`cold-${sessions++}`, [name]))[0]!);
    for (const { work } of cold.values()) assert.notEqual(work, undefined);
    // In process: the functions after the first reuse what it retained.
    const together = await run('warm', ['user_b', 'user_a', 'user_c']);
    // Persisted: a new process reuses the rows the previous one wrote.
    await run('persisted', ['user_b']);
    const persisted = await run('persisted', ['user_c']);
    const expectations: [string, { text: string; work: unknown }][] = [
      ['user_b', together[0]!],
      ['user_a', together[1]!],
      ['user_c', together[2]!],
    ];
    for (const [name, got] of expectations) {
      assert.equal(got.text, cold.get(name)!.text, `${name}: text after other requests`);
      assert.deepEqual(got.work, cold.get(name)!.work, `${name}: work after other requests`);
    }
    assert.equal(persisted[0]!.text, cold.get('user_c')!.text, 'user_c: text from persisted rows');
  },
);
