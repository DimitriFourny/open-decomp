import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { openBinary, type BinarySession } from '../../../src/api/index.js';
import { nativeOracleSkip } from '../../support/host-tools.js';

// The trusted fixture is compiled locally and never executed; the product only
// analyzes it. `-fstack-protector-all` makes `guarded` end in a call to the
// noreturn `___stack_chk_fail` import whose return address is the next
// function's entry.
test(
  'a final call to a noreturn import ends the path without a boundary conflict or exit placeholder',
  { skip: nativeOracleSkip(), timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-native-noreturn-'));
    let session: BinarySession | undefined;
    t.after(async () => {
      await session?.close();
      await rm(root, { recursive: true, force: true });
    });
    const binary = join(root, 'native-noreturn');
    const compiled = spawnSync(
      '/usr/bin/clang',
      [
        '-target',
        'arm64-apple-macos13.0',
        '-O1',
        '-g0',
        '-fstack-protector-all',
        resolve('test/service/analysis/native-noreturn-source.c'),
        '-o',
        binary,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    session = await openBinary(binary, { cachePath: join(root, 'cache') });
    for (const emitter of ['c-like', 'python-like'] as const) {
      const source = await session.decompile({ name: '_guarded' }, { emitter, view: 'source' });
      assert.ok('data' in source && source.data.delivery === 'inline');
      const text = source.data.emission.text;
      assert.match(text, /__stack_chk_fail\(\);?\n/);
      assert.doesNotMatch(text, /trap_exit|unknown_exit|__unknown_effect/, text);
      if (emitter === 'c-like')
        assert.match(text, /extern _Noreturn void __stack_chk_fail\(void\);/);
      // The elided terminator keeps its presentation record.
      assert.match(JSON.stringify(source.data.emission), /noreturn_call_exit/);
      assert.ok(
        !JSON.stringify(source.data).includes(
          'Intraprocedural flow reaches another function entry',
        ),
      );
      // Checked view keeps the explicit trap terminator.
      const checked = await session.decompile({ name: '_guarded' }, { emitter, view: 'checked' });
      assert.ok('data' in checked && checked.data.delivery === 'inline');
      assert.match(
        checked.data.emission.text,
        /trap_exit\("Call to a noreturn callee does not return"/,
      );
    }
  },
);
