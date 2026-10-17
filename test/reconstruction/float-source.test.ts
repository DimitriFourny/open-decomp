import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openBinary, type BinarySession } from '../../src/api/index.js';
import { execute } from '../emitters/c/support.js';

// Only trusted, locally compiled source is executed. Nearest-even, gradual
// underflow, disabled traps, and noncontracted operations are the supported
// environment; this does not test general FPCR/FPSR or exceptional-value behavior.
const cases = [
  [4, 3],
  [-2, 0.5],
  [0, 0],
  [-0, -0],
  [1, -3],
  [2 ** 52 + 1, -(2 ** 52)],
  [2 ** -1022, -(2 ** -1022)],
  [Number.MIN_VALUE, Number.MIN_VALUE],
  [Number.MIN_VALUE * 3, -Number.MIN_VALUE],
  [Number.MAX_VALUE / 4, -Number.MAX_VALUE / 4],
] as const;

function bits(value: number): bigint {
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, value, true);
  return bytes.getBigUint64(0, true);
}

test(
  'source-built Mach-O scalar doubles stay live through public C/Python projection',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-float-regression-'));
    let session: BinarySession | undefined;
    t.after(async () => {
      await session?.close();
      await rm(root, { recursive: true, force: true });
    });
    const source = join(root, 'float.c'), binary = join(root, 'float');
    // Hex storage literals preserve signed zero and subnormal inputs exactly.
    await writeFile(source, `
#include <stdint.h>
#include <stdio.h>
__attribute__((noinline)) double fixture_float(double a, double b) {
  return a * 1.5 + b * 0.5;
}
__attribute__((noinline)) double fixture_float_consumer(double a, double b) {
  return fixture_float(a, b) + 1.0;
}
int main(void) {
  __asm__ volatile("msr fpcr, %0" :: "r"((uint64_t)0));
  const uint64_t inputs[][2] = {
    ${cases.map(([a, b]) => `{0x${bits(a).toString(16)}ULL,0x${bits(b).toString(16)}ULL}`).join(',\n    ')}
  };
  for (unsigned i = 0; i < sizeof(inputs) / sizeof(inputs[0]); i++) {
    union { uint64_t u; double d; } a = {.u=inputs[i][0]}, b = {.u=inputs[i][1]}, result;
    result.d = fixture_float(a.d, b.d);
    printf("%016llx\\n", (unsigned long long)result.u);
  }
  return 0;
}
`);
    const compiled = spawnSync('/usr/bin/clang', [
      '-target', 'arm64-apple-macos13.0', '-O1', '-ffp-contract=off', source, '-o', binary,
    ], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);
    const oracle = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(oracle.status, 0, oracle.stderr);
    const expected = oracle.stdout.trim().split('\n').map((line) => BigInt(`0x${line}`));
    assert.equal(expected.length, cases.length);
    session = await openBinary(binary, { cachePath: join(root, 'cache') });
    for (const emitter of ['c-like', 'python-like'] as const) {
      const result = await session.decompile({ name: '_fixture_float' }, { emitter });
      assert.ok('data' in result && result.data.delivery === 'inline');
      const emission = result.data.emission;
      assert.match(emission.text, /(?:double|ieee64_t)/);
      assert.match(emission.text, /nearest-even/);
      assert.match(emission.text, /fp_mul/);
      assert.match(emission.text, /fp_add/);
      assert.doesNotMatch(emission.text, /vector_[if]\d+x\d+_t/);
      const headerEnd = emitter === 'c-like' ? emission.text.indexOf('{') : emission.text.indexOf(':\n');
      const formals = emission.mappings.filter((mapping) => {
        if (mapping.end > headerEnd) return false;
        return /^(?:double|ieee64_t)\s+arg\d+,?$|^arg\d+\s*:\s*(?:double|ieee64_t),?$/.test(
          emission.text.slice(mapping.start, mapping.end).trim(),
        );
      });
      assert.equal(formals.length, 2, emission.text);
      for (const [index, [a, b]] of cases.entries()) {
        const observed = execute(
          emission,
          new Map([[formals[0]!.statement_id, bits(a)], [formals[1]!.statement_id, bits(b)]]),
          new Map(),
          0n,
          new Map(),
          new Map([['FPCR environment', 0n]]),
        );
        assert.equal(observed.exit, 'machine_return');
        assert.deepEqual(observed.values, [expected[index]!], `${emitter}: ${a}, ${b}`);
        if (index === 0)
          assert.equal(execute(emission, new Map([
            [formals[0]!.statement_id, bits(a)], [formals[1]!.statement_id, bits(b)],
          ])).exit, 'unknown', 'FPCR is not silently assumed by default');
      }
      const consumer = await session.decompile({ name: '_fixture_float_consumer' }, { emitter });
      assert.ok('data' in consumer && consumer.data.delivery === 'inline');
      const consumerText = consumer.data.emission.text;
      assert.ok(consumerText.includes('_fixture_float('));
      assert.match(consumerText, /fp_add/);
      assert.ok(consumerText.includes(emitter === 'c-like'
        ? 'ieee64_t fn__fixture_float_consumer(ieee64_t arg0, ieee64_t arg1)'
        : 'def fn__fixture_float_consumer(arg0: ieee64_t, arg1: ieee64_t) -> ieee64_t:'));
    }
  },
);
