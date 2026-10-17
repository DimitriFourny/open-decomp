import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { openBinary, type BinarySession } from '../../../src/api/index.js';
import {
  acknowledgeRequirements,
  emittedFormals,
  execute,
  type SourceCallOracle,
} from '../../emitters/c/support.js';
import { nativeOracleSkip } from '../../support/host-tools.js';
import { project } from './support.js';

const cases = [0n, 1n, 0x7fffffffn, 0x80000000n, 0xffffffffn, 0x1234567887654321n];
const u64 = (value: bigint): bigint => BigInt.asUintN(64, value);
const leaf32 = (value: bigint): bigint => BigInt.asUintN(32, value * 3n + 7n);
const leaf64 = (value: bigint): bigint => u64(value ^ 0xfedcba9876543210n);
function recursive(count: bigint, value: bigint): bigint {
  return count === 0n ? leaf32(value) : u64(recursive(count - 1n, value + 5n) + 1n);
}
function mutualA(count: bigint, value: bigint): bigint {
  return count === 0n ? leaf32(value) : u64(mutualB(count - 1n, value + 3n) + 1n);
}
function mutualB(count: bigint, value: bigint): bigint {
  return count === 0n ? leaf32(value) : u64(mutualA(count - 1n, value + 7n) + 2n);
}
const fp = new DataView(new ArrayBuffer(8));
function bits(value: number, width: 32 | 64 = 64): bigint {
  if (width === 32) {
    fp.setFloat32(0, value, true);
    return BigInt(fp.getUint32(0, true));
  }
  fp.setFloat64(0, value, true);
  return fp.getBigUint64(0, true);
}
function number(value: bigint, width: 32 | 64 = 64): number {
  if (width === 32) {
    fp.setUint32(0, Number(value), true);
    return fp.getFloat32(0, true);
  }
  fp.setBigUint64(0, value, true);
  return fp.getFloat64(0, true);
}
function formals(
  emission: Parameters<typeof execute>[0],
  values: readonly bigint[],
  stack: bigint,
): Map<string, bigint> {
  const result = new Map<string, bigint>();
  const parameters = emittedFormals(emission),
    arguments_ = parameters.filter((parameter) => parameter.name !== 'entry_sp');
  assert.equal(arguments_.length, values.length, emission.text);
  let index = 0;
  for (const parameter of parameters)
    result.set(parameter.statement_id, parameter.name === 'entry_sp' ? stack : values[index++]!);
  return result;
}

// Independent native source oracle + independent parsers/evaluators of BOTH
// emitted dialects. The product receives a -g0 binary and no source prototypes.
// Only the locally compiled trusted fixture is executed; analyzed targets are
// never invoked by the decompiler or the output interpreter.
test(
  'public default native summaries carry nested, recursive, tail, preserved, stack and FP constraints',
  { skip: nativeOracleSkip(), timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-native-summary-'));
    let session: BinarySession | undefined;
    t.after(async () => {
      await session?.close();
      await rm(root, { recursive: true, force: true });
    });
    const binary = join(root, 'native-summary');
    const compiled = spawnSync(
      '/usr/bin/clang',
      [
        '-target',
        'arm64-apple-macos13.0',
        '-O1',
        '-g0',
        '-ffp-contract=off',
        '-fno-builtin',
        '-fno-optimize-sibling-calls',
        resolve('test/service/analysis/native-summary-source.c'),
        '-o',
        binary,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    const native = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    const expected = new Map(
      native.stdout
        .trim()
        .split('\n')
        .map((line) => {
          const [name, index, value] = line.split(' ');
          return [`${name}:${index}`, BigInt(`0x${value}`)] as const;
        }),
    );
    assert.equal(expected.size, cases.length * 11);
    session = await openBinary(binary, { cachePath: join(root, 'cache') });
    const oracles = new Map<string, SourceCallOracle>();
    const register = (
      name: string,
      arity: number,
      oracle: (args: readonly bigint[]) => bigint,
    ): void => {
      oracles.set(`_native_${name}`, (args, context) => {
        assert.equal(
          context.arguments_complete,
          false,
          'Observed native inputs do not establish complete source arity',
        );
        assert.equal(args.length, arity, `No observed argument may be dropped for ${name}`);
        return oracle(args);
      });
    };
    register('leaf32', 1, ([value]) => leaf32(value!));
    register('leaf64', 1, ([value]) => leaf64(value!));
    register('identity', 1, ([value]) => value!);
    register('nested', 1, ([value]) => leaf32(value!) + 0x100000000n);
    register('signed', 1, ([value]) => u64(BigInt.asIntN(32, value!)));
    register('recursive', 2, ([count, value]) => recursive(count!, value!));
    register('mutual_a', 2, ([count, value]) => mutualA(count!, value!));
    register('mutual_b', 2, ([count, value]) => mutualB(count!, value!));
    register('stack_leaf', 10, (args) =>
      u64(args.reduce((sum, value, index) => sum + value * BigInt(index + 1), 0n)),
    );
    register('tail', 1, ([value]) => leaf32(value!));
    // Native observation order is bank order, not an invented interleaved source
    // declaration: integer A/C then independently observed FP B/D.
    register('fp_leaf', 4, ([a, c, b, d]) =>
      bits(Number(a!) + number(b!) + Number(c!) + number(d!, 32)),
    );
    register('vector_leaf', 1, ([value]) => {
      let packed = 0n;
      for (let lane = 0; lane < 4; lane++)
        packed |= BigInt.asUintN(32, (value! >> BigInt(lane * 32)) + 1n) << BigInt(lane * 32);
      return packed;
    });
    const names: Record<string, string> = {
      outer: 'outer',
      signed: 'signed_caller',
      preserved: 'preserved',
      identity: 'identity_caller',
      recursive: 'recursive',
      mutual: 'mutual_a',
      stack: 'stack_caller',
      tail: 'tail_caller',
      tail_body: 'tail',
      fp: 'fp_caller',
      vector: 'vector_caller',
    };
    const environment = new Map([['non-argument entry register', 0n]]);
    const stack = 0x9000n;
    for (const emitter of ['c-like', 'python-like'] as const)
      for (const [name, symbol] of Object.entries(names)) {
        const result = await session.decompile({ name: `_native_${symbol}` }, { emitter });
        assert.ok('data' in result && result.data.delivery === 'inline');
        const emission = result.data.emission;
        assert.doesNotMatch(
          emission.text,
          /bits outside source ABI result/,
          'Architecturally written zero/sign extension must not become unknown upper bits',
        );
        for (const [index, value] of cases.entries()) {
          const args =
            name === 'preserved'
              ? [value, u64(value + 17n)]
              : name === 'recursive' || name === 'mutual'
                ? [3n, value]
                : name === 'fp'
                  ? [BigInt(index), BigInt(index + 3), bits(1.25), bits(2.5, 32)]
                  : name === 'vector'
                    ? [
                        BigInt.asUintN(32, value) |
                          (BigInt.asUintN(32, value >> 32n) << 32n) |
                          (BigInt(index) << 64n) |
                          (BigInt.asUintN(32, ~value) << 96n),
                      ]
                    : [value];
          for (const poison of [0xa5, 0x5a]) {
            const memory = new Map<bigint, number>();
            for (let offset = -512n; offset < 64n; offset++) memory.set(stack + offset, poison);
            const observed = execute(
              emission,
              formals(emission, args, stack),
              memory,
              0n,
              new Map(),
              environment,
              oracles,
              acknowledgeRequirements(emission),
            );
            assert.equal(observed.exit, 'machine_return', `${emitter} ${name} ${index}`);
            assert.deepEqual(
              observed.values,
              [expected.get(`${name}:${index}`)!],
              `${emitter} ${name} ${index}`,
            );
            assert.ok(
              observed.events.includes('call'),
              `${name} must retain its native call effect`,
            );
          }
        }
      }
  },
);

for (const fixture of [
  'macho-arm64-symbols',
  'corpus-symbols.dll',
  'libcorpus-elf-x86_64-symbols.so',
])
  test(`${fixture}: fixture_direct retains its observed passed input in both dialects`, async (t) => {
    const p = await project(t, fixture),
      fn = p.functions.find(
        (candidate) => candidate.original_name?.replace(/^_/, '') === 'fixture_direct',
      );
    assert.ok(fn);
    for (const emitter of ['c-like', 'python-like'] as const) {
      const response = await p.decompile(fn.id, { options: { emitter } });
      assert.ok('data' in response.result);
      const emission = p.payload(response.result).result.data.emission;
      for (const value of cases) {
        let calls = 0;
        const stackOracle: SourceCallOracle = (args) => {
          calls++;
          assert.equal(args.length, 1);
          assert.equal(BigInt.asUintN(32, args[0]!), BigInt.asUintN(32, value));
          return BigInt.asUintN(32, value + 7n);
        };
        const arithmeticOracle: SourceCallOracle = (args) => {
          calls++;
          assert.equal(args.length, 2);
          assert.deepEqual(
            args.map((argument) => BigInt.asUintN(32, argument)),
            [BigInt.asUintN(32, value), 2n],
          );
          return BigInt.asUintN(32, value + 6n) ^ 0x55n;
        };
        const callbacks = new Map<string, SourceCallOracle>();
        for (const callee of p.functions) {
          const name = callee.original_name,
            plain = name?.replace(/^_/, '');
          const oracle =
            plain === 'fixture_stack'
              ? stackOracle
              : plain === 'fixture_arithmetic'
                ? arithmeticOracle
                : null;
          if (!oracle) continue;
          if (name) callbacks.set(name, oracle);
          callbacks.set(`0x${callee.entry.value.toString(16)}`, oracle);
        }
        const memory = new Map<bigint, number>(),
          stack = fixture.startsWith('macho') ? 0x9000n : 0x9008n;
        for (let offset = -256n; offset < 64n; offset++) memory.set(stack + offset, 0);
        const observed = execute(
          emission,
          formals(emission, [value], stack),
          memory,
          0n,
          new Map(),
          new Map([['non-argument entry register', 0n]]),
          callbacks,
        );
        assert.equal(observed.exit, 'machine_return');
        assert.equal(calls, 2);
        assert.deepEqual(observed.values, [
          BigInt.asUintN(32, value + 7n + (BigInt.asUintN(32, value + 6n) ^ 0x55n)),
        ]);
      }
    }
  });
