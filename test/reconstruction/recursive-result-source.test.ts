import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { CLANG, nativeOracleSkip } from '../support/host-tools.js';
import type { WireEmission } from '../../src/core/index.js';
import { project } from '../service/analysis/support.js';
import { emittedFormals, execute, type SourceCallOracle } from '../emitters/c/support.js';

// A self-call result that reaches only the function's own return exit is not
// result demand: the existing exit_scratch / incidental_result rules apply.

function inputs(emission: WireEmission, values: readonly bigint[]): Map<string, bigint> {
  const formals = emittedFormals(emission);
  assert.equal(formals.length, values.length, emission.text);
  return new Map(formals.map((formal, index) => [formal.statement_id, values[index]!]));
}
function word(memory: ReadonlyMap<bigint, number>, address: bigint, bytes = 8): bigint {
  let value = 0n;
  for (let byte = 0; byte < bytes; byte++)
    value |= BigInt(memory.get(address + BigInt(byte)) ?? 0) << BigInt(byte * 8);
  return value;
}
function store(memory: Map<bigint, number>, address: bigint, value: bigint, bytes = 8): void {
  for (let byte = 0; byte < bytes; byte++)
    memory.set(address + BigInt(byte), Number((value >> BigInt(byte * 8)) & 255n));
}
const rules = (emission: WireEmission): string[] =>
  (emission.local_validation ?? []).flatMap((record) =>
    record.kind === 'presentation' && record.rule ? [record.rule] : [],
  );

test(
  'self-recursive forwarded results: int keeps its 32-bit result, void-like becomes void',
  { skip: nativeOracleSkip(), timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-recursive-result-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, 'recursive-result');
    const compiled = spawnSync(
      CLANG,
      [
        '-target',
        'arm64-apple-macos13.0',
        '-O1',
        '-g0',
        '-fno-builtin',
        '-fno-optimize-sibling-calls',
        resolve('test/reconstruction/recursive-result-source.c'),
        '-o',
        binary,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    const p = await project(t, new Uint8Array(await readFile(binary)));
    const find = (name: string) => {
      const fn = p.functions.find((candidate) => candidate.original_name === `_${name}`);
      assert.ok(fn, name);
      return fn;
    };
    const emitted = async (name: string, emitter: 'c-like' | 'python-like') => {
      const response = await p.decompile(find(name).id, { options: { emitter } });
      assert.ok('data' in response.result);
      return p.payload(response.result).result.data.emission as WireEmission;
    };
    // Source oracle of recursive_compare over little byte strings at A and B.
    const A = 0x5000n,
      B = 0x6000n,
      matched = 0x6800n;
    const bytesAt = (memory: ReadonlyMap<bigint, number>, address: bigint) =>
      memory.get(address) ?? 0;
    const memcmp = (memory: ReadonlyMap<bigint, number>, a: bigint, b: bigint, n: bigint) => {
      for (let index = 0n; index < n; index++) {
        const difference = bytesAt(memory, a + index) - bytesAt(memory, b + index);
        if (difference) return BigInt(difference);
      }
      return 0n;
    };
    const oracle = (
      memory: ReadonlyMap<bigint, number>,
      a: bigint,
      b: bigint,
      n: number,
    ): { result: bigint; increments: bigint } => {
      if (n <= 0) return { result: 0n, increments: 0n };
      const rc =
        bytesAt(memory, a) !== bytesAt(memory, b)
          ? { result: memcmp(memory, a, b, BigInt(n)), increments: 0n }
          : oracle(memory, a + 1n, b + 1n, n - 1);
      return rc.result ? rc : { result: 0n, increments: rc.increments + 1n };
    };
    const cases: readonly [string, string, number][] = [
      ['abc', 'abc', 3],
      ['abd', 'abc', 3],
      ['abc', 'abd', 3],
      ['xbc', 'abc', 3],
      ['abc', 'abc', 0],
      ['abc', 'abc', -5],
    ];
    for (const emitter of ['c-like', 'python-like'] as const) {
      const emission = await emitted('recursive_compare', emitter);
      assert.match(
        emission.text,
        emitter === 'c-like' ? /^uint32_t recursive_compare\(/m : /-> uint32_t:/,
      );
      assert.doesNotMatch(emission.text, /physical_return|physical_inputs/);
      assert.ok(rules(emission).includes('exit_scratch'), emission.text);
      for (const [left, right, count] of cases) {
        const memory = new Map<bigint, number>();
        Buffer.from(left).forEach((byte, index) => memory.set(A + BigInt(index), byte));
        Buffer.from(right).forEach((byte, index) => memory.set(B + BigInt(index), byte));
        store(memory, matched, 40n);
        const expected = oracle(memory, A, B, count);
        const calls = new Map<string, SourceCallOracle>();
        calls.set('memcmp', (args) =>
          BigInt.asUintN(32, memcmp(memory, args[0]!, args[1]!, args[2]!)),
        );
        // The self-call executes the emitted function itself.
        calls.set('recursive_compare', (args) => {
          const nested = execute(
            emission,
            inputs(emission, args),
            memory,
            0n,
            new Map(),
            new Map(),
            calls,
          );
          assert.equal(nested.exit, 'machine_return');
          return nested.values[0]!;
        });
        const observed = execute(
          emission,
          inputs(emission, [A, B, BigInt.asUintN(32, BigInt(count)), matched]),
          memory,
          0n,
          new Map(),
          new Map(),
          calls,
        );
        assert.equal(observed.exit, 'machine_return');
        assert.deepEqual(observed.values, [BigInt.asUintN(32, expected.result)], emission.text);
        assert.equal(word(memory, matched), 40n + expected.increments);
      }
    }
    // recursive_total: a left chain of nodes {left, value}; *total += value
    // after each self-call, innermost first.
    for (const emitter of ['c-like', 'python-like'] as const) {
      const emission = await emitted('recursive_total', emitter);
      assert.match(emission.text, emitter === 'c-like' ? /^void recursive_total\(/m : /-> void:/);
      assert.doesNotMatch(emission.text, /physical_return|physical_inputs/);
      assert.ok(rules(emission).includes('incidental_result'), emission.text);
      const memory = new Map<bigint, number>();
      const nodes = [0x7000n, 0x7100n, 0x7200n],
        values = [5n, 0xffffffffffffff00n, 7n],
        total = 0x7800n;
      nodes.forEach((node, index) => {
        store(memory, node, nodes[index + 1] ?? 0n);
        store(memory, node + 8n, values[index]!);
      });
      store(memory, total, 100n);
      const calls = new Map<string, SourceCallOracle>();
      calls.set('recursive_total', (args) => {
        const nested = execute(
          emission,
          inputs(emission, args),
          memory,
          0n,
          new Map(),
          new Map(),
          calls,
        );
        assert.equal(nested.exit, 'machine_return');
        assert.deepEqual(nested.values, []);
        return [];
      });
      const observed = execute(
        emission,
        inputs(emission, [nodes[0]!, total]),
        memory,
        0n,
        new Map(),
        new Map(),
        calls,
      );
      assert.equal(observed.exit, 'machine_return');
      assert.deepEqual(observed.values, []);
      assert.equal(
        word(memory, total),
        BigInt.asUintN(
          64,
          values.reduce((sum, value) => sum + value, 100n),
        ),
      );
    }
  },
);
