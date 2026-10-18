import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openBinary, type BinarySession } from '../../../src/api/index.js';
import { emittedFormals, execute } from '../../emitters/c/support.js';
import { nativeOracleSkip } from '../../support/host-tools.js';

// Compile trusted source for analysis only. Never execute the analyzed binary;
// both emitted dialects run in the independent bitvector/call oracle.
test(
  'proven invocation constants remain actuals before source-only arity prefix checking',
  { skip: nativeOracleSkip(), timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'native-arity-context-'));
    let session: BinarySession | undefined;
    t.after(async () => {
      await session?.close();
      await rm(root, { recursive: true, force: true });
    });
    const source = join(root, 'arity.c'),
      binary = join(root, 'arity');
    await writeFile(
      source,
      `#include <stdint.h>
__attribute__((noinline)) uint64_t prefix_three(uint64_t a, uint64_t b, uint64_t c) { return a+b+c; }
__attribute__((noinline)) uint64_t prefix_caller(uint64_t b, uint64_t c) { return prefix_three(7,b,c); }
int main(void) { return 0; }
`,
    );
    const compiled = spawnSync(
      '/usr/bin/clang',
      [
        '-target',
        'arm64-apple-macos13.0',
        '-O1',
        '-g0',
        '-fno-optimize-sibling-calls',
        source,
        '-o',
        binary,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    session = await openBinary(binary, { cachePath: join(root, 'cache') });
    for (const emitter of ['c-like', 'python-like'] as const) {
      const result = await session.decompile(
        { name: '_prefix_caller' },
        { emitter, view: 'source' },
      );
      assert.ok('data' in result && result.data.delivery === 'inline');
      const emission = result.data.emission;
      assert.doesNotMatch(emission.text, /unknown_argument|entry_sp/);
      assert.ok(
        emission.inferences?.some(
          (item) => item.details.kind === 'rewrite' && item.details.rule === 'arity_closure',
        ),
      );
      const formals = emittedFormals(emission);
      assert.equal(formals.length, 2);
      for (const value of [0n, 1n, 0xffffffffffffffffn]) {
        let calls = 0;
        const observed = execute(
          emission,
          new Map([
            [formals[0]!.statement_id, value],
            [formals[1]!.statement_id, 13n],
          ]),
          new Map(),
          0n,
          new Map(),
          new Map(),
          new Map([
            [
              'prefix_three',
              (args, context) => {
                calls++;
                assert.deepEqual(args, [7n, value, 13n]);
                assert.equal(context.arguments_complete, true);
                return BigInt.asUintN(64, args[0]! + args[1]! + args[2]!);
              },
            ],
          ]),
        );
        assert.equal(calls, 1);
        assert.deepEqual(observed.values, [BigInt.asUintN(64, value + 20n)]);
      }
      const checked = await session.decompile(
        { name: '_prefix_caller' },
        { emitter, view: 'checked' },
      );
      assert.ok('data' in checked && checked.data.delivery === 'inline');
      assert.match(checked.data.emission.text, /unknown_argument/);
      assert.ok(
        !checked.data.emission.inferences?.some(
          (item) => item.details.kind === 'rewrite' && item.details.rule === 'arity_closure',
        ),
      );
    }
  },
);
