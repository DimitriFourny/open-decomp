import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { StoredDecompilation } from '../../src/project/cache/index.js';
import { project } from '../service/analysis/support.js';
import { checkExecutableSource, type ExecutableSourceCase } from './source-executable.js';

type StoredEmission = StoredDecompilation['data']['emission'];
const arithmetic: readonly ExecutableSourceCase[] = [[0n, 1n], [0xffffffffn, 3n], [123456789n, 987654321n]].map(([a, b]) => ({
  arguments: [a!, b!], expected: BigInt.asUintN(32, a! + 3n * b!) ^ 0x55n,
}));
const widths: readonly ExecutableSourceCase[] = [[0xffffffffn, 1n, 0n], [0xffffffffn, 0xffffffffn, 32n], [1n, 3n, 64n]].map(([a, b, shift]) => ({
  arguments: [a!, b!, shift!], expected: (BigInt.asUintN(32, a!) + BigInt.asUintN(32, b!)) >> (shift! & 63n),
}));
const stacks: readonly ExecutableSourceCase[] = [Array.from({ length: 10 }, (_, index) => BigInt(index + 1)), Array<bigint>(10).fill(0xffffffffffffffffn)].map((values) => ({
  arguments: values, expected: BigInt.asUintN(64, values.reduce((sum, value, index) => sum + value * BigInt(index + 1), 0n)),
}));
const loops: readonly ExecutableSourceCase[] = [[], [1n], [1n, 2n, 3n, 4n], [0xffffffffn, 1n, 5n]].map((values): ExecutableSourceCase => ({
  arguments: [0x2000n, BigInt(values.length)],
  expected: BigInt.asUintN(32, values.reduce((sum, value) => sum + value, 0n)),
  memory: { bits: 32, values },
}));
const memories: readonly ExecutableSourceCase[] = [[0n, 0n], [7n, 11n], [0xffffffffffffffffn, 1n], [0x8000000000000000n, 0xffffffffffffffffn]].map(([value, delta]): ExecutableSourceCase => {
  const expected = BigInt.asUintN(64, value! + delta!);
  return { arguments: [0x2000n, delta!], expected,
    memory: { bits: 64, values: [value!], expected: [expected] } };
});

// These exact bodies come from trusted fixtures/source/corpus.c. The wrapper
// appends real helper definitions and independent observations; it never rewrites
// generated functions, executes an analyzed arbitrary target, or substitutes IR.
test('declared integer/structured-memory C and Python executable subset passes real syntax and runtime checks', { timeout: 120000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'open-decomp-source-identifiers-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const p = await project(t, 'macho-arm64-symbols');
  for (const fixture of [
    { address: 0x100000574n, cases: arithmetic },
    { address: 0x100000630n, cases: widths },
    { address: 0x100000640n, cases: stacks },
    { address: 0x100000594n, cases: loops },
    { address: 0x1000005c0n, cases: memories },
  ]) {
    const fn = p.functions.find((candidate) => candidate.entry.value === fixture.address);
    assert.ok(fn);
    for (const emitter of ['c-like', 'python-like'] as const) {
      const response = await p.decompile(fn.id, { options: { emitter } });
      const result: StoredDecompilation = p.payload(response.result).result;
      const emission: StoredEmission = result.data.emission;
      checkExecutableSource(emission, fixture.cases, directory);
    }
  }
});
