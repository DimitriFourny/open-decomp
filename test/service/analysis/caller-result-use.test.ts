import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { openBinary } from '../../../src/api/index.js';
import type { BinarySession } from '../../../src/api/index.js';
import { CLANG, nativeOracleSkip } from '../../support/host-tools.js';

// Trusted source-built fixture, compiled here and never executed; the decompiler receives only
// the -g0 binary. `post_call` leaves a call result in the result register while a store
// follows, so its body alone makes it void-like (`incidental_result`); only the positive
// result use of its direct caller `use_post` keeps the value. `post_ignored` has the same body
// but its caller never reads the register, and `bump` is a real void function.
test(
  'caller result-use evidence keeps a void-like result that a direct caller reads',
  { skip: nativeOracleSkip(), timeout: 180_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-caller-result-'));
    let session: BinarySession | undefined;
    t.after(async () => {
      await session?.close();
      await rm(root, { recursive: true, force: true });
    });
    const binary = join(root, 'caller-result');
    const compiled = spawnSync(
      CLANG,
      [
        '-target',
        'arm64-apple-macos13.0',
        '-O1',
        '-g0',
        '-fno-builtin',
        '-fno-optimize-sibling-calls',
        resolve('test/service/analysis/caller-result-use-source.c'),
        '-o',
        binary,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    session = await openBinary(binary, { cachePath: join(root, 'cache') });
    const run = async (name: string, emitter: 'c-like' | 'python-like') => {
      const result = await session!.decompile({ name }, { emitter, view: 'source' });
      assert.ok('data' in result && result.data.delivery === 'inline', name);
      return result.data;
    };
    const callerUse = (data: Awaited<ReturnType<typeof run>>) =>
      (data.emission.inferences ?? []).filter(
        (item) => item.details.kind === 'rewrite' && item.details.rule === 'caller_result_use',
      );
    const caller = await run('_use_post', 'c-like');
    const metadata = await session.getFunction(caller.function_id);
    assert.ok('data' in metadata && metadata.data.view === 'metadata');
    const [range] = metadata.data.function.ranges;
    assert.ok(range);
    const start = BigInt(range.start.value),
      end = start + BigInt(range.size);

    for (const emitter of ['c-like', 'python-like'] as const) {
      // The result is read by `use_post`: an integer result, not `void`, and a record names
      // the reading call site (an address inside `use_post`).
      const kept = await run('_post_call', emitter);
      const signature =
        emitter === 'c-like'
          ? /^u?int(?:8|16|32|64)_t post_call\(/m
          : /^def post_call\([^)]*\) -> u?int(?:8|16|32|64)_t:$/m;
      assert.match(kept.emission.text, signature, kept.emission.text);
      assert.doesNotMatch(kept.emission.text, /\bvoid\b/);
      assert.match(kept.emission.text, /\breturn\b/);
      const records = callerUse(kept);
      assert.equal(records.length, 1, 'one caller_result_use record');
      const details = records[0]!.details;
      assert.ok(details.kind === 'rewrite' && details.validation_status === 'verified');
      const named = /^call at (0x[0-9a-f]+) reads arm64:x0:0:32$/.exec(details.reason ?? '');
      assert.ok(named, `record names the call site: ${details.reason}`);
      const site = BigInt(named[1]!);
      assert.ok(site >= start && site < end, 'the site is inside use_post');

      // A plain result needs no evidence; the same body whose only caller ignores the
      // register, and a real void function, stay `void` with no record.
      const scale = await run('_scale', emitter);
      assert.doesNotMatch(scale.emission.text, /\bvoid\b/);
      assert.equal(callerUse(scale).length, 0);
      for (const name of ['_post_ignored', '_bump']) {
        const ignored = await run(name, emitter);
        assert.match(
          ignored.emission.text,
          emitter === 'c-like' ? /^void \w+\(/m : /\) -> void:$/m,
          ignored.emission.text,
        );
        assert.equal(callerUse(ignored).length, 0, name);
      }
    }
  },
);
