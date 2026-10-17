import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredDecompilation } from '../../src/project/cache/index.js';
import { project } from '../service/analysis/support.js';
import { execute } from '../emitters/c/support.js';

type StoredEmission = StoredDecompilation['data']['emission'];
type StoredMapping = StoredEmission['mappings'][number];

// Independent source oracle: fixtures/source/corpus.c fixture_stack_args uses
// unsigned 64-bit inputs and a + 2*b + ... + 10*j. All input bit patterns and
// wraparound are defined by C; no native target or arbitrary input is executed.
const cases = [
  Array.from({ length: 10 }, (_, index) => BigInt(index + 1)),
  Array<bigint>(10).fill(0n),
  Array<bigint>(10).fill(0xffffffffffffffffn),
  Array.from({ length: 10 }, (_, index) => 0x8000000000000000n + BigInt(index)),
  [0n, 1n, 0x7fffffffffffffffn, 0x8000000000000000n, 0xffffffffffffffffn,
    0x100000000n, 0xffffffffn, 0x123456789abcdef0n, 0xfedcba9876543210n, 0xffffffffffffffffn],
  ...Array.from({ length: 10 }, (_, active) =>
    Array.from({ length: 10 }, (_, index) => index === active ? 0xffffffffffffffffn : 0n)),
  ...Array.from({ length: 10 }, (_, active) =>
    Array.from({ length: 10 }, (_, index) => index === active ? 0x8000000000000000n : 0n)),
];

for (const fixture of ['macho-arm64-symbols', 'macho-arm64-stripped'])
  test(`${fixture}: default public output recovers ten actual incoming weighted-sum inputs`, async (t) => {
    const p = await project(t, fixture);
    const fn = p.functions.find((candidate) => candidate.entry.value === 0x100000640n);
    assert.ok(fn);
    for (const emitter of ['c-like', 'python-like'] as const) {
      // Deliberately use public defaults: no signature, source, debug facts or
      // raised analysis budget is supplied to function_decompile.
      const result: StoredDecompilation = p.payload((await p.decompile(fn.id, { options: { emitter } })).result).result;
      assert.equal(result.state, 'complete');
      const emission: StoredEmission = result.data.emission;
      const headerEnd: number = emitter === 'python-like'
        ? emission.text.search(/\)\s*(?:-> [^\n]+)?:/)
        : emission.text.indexOf('{');
      const formals: StoredEmission['mappings'] = emission.mappings.filter((mapping: StoredMapping) =>
        mapping.end <= headerEnd && /\barg\d+\b/.test(emission.text.slice(mapping.start, mapping.end)),
      );
      assert.equal(formals.length, 10, emission.text);
      assert.doesNotMatch(emission.text, /\bstack_frame\b/, 'entry bytes are not private uninitialized storage');
      for (const args of cases) {
        const inputs = new Map<string, bigint>(formals.map((mapping: StoredMapping, index: number): [string, bigint] =>
          [mapping.statement_id, args[index]!]));
        const observation = execute(emission, inputs);
        const expected = BigInt.asUintN(64,
          args.reduce((sum, value, index) => sum + BigInt(index + 1) * value, 0n));
        assert.equal(observation.exit, 'machine_return');
        assert.deepEqual(observation.values, [expected]);
        assert.deepEqual(observation.events, [], 'incoming values need no fabricated local-memory reads');
        if (args === cases[0]) assert.equal(expected, 385n);
      }
    }
  });
