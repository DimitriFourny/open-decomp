import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { nativeOracleSkip } from '../support/host-tools.js';
import { openBinary, type BinarySession, type ToolResult } from '../../src/api/index.js';
import type { WireEmission } from '../../src/core/index.js';
import { acknowledgeRequirements, emittedFormals, execute } from '../emitters/c/support.js';

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
  { skip: nativeOracleSkip(), timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-float-regression-'));
    let session: BinarySession | undefined;
    t.after(async () => {
      await session?.close();
      await rm(root, { recursive: true, force: true });
    });
    const source = join(root, 'float.c'),
      binary = join(root, 'float');
    // Hex storage literals preserve signed zero and subnormal inputs exactly.
    await writeFile(
      source,
      `
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
    union { uint64_t u; double d; } a = {.u=inputs[i][0]}, b = {.u=inputs[i][1]}, result, consumer;
    result.d = fixture_float(a.d, b.d);
    consumer.d = fixture_float_consumer(a.d, b.d);
    printf("%016llx %016llx\\n", (unsigned long long)result.u, (unsigned long long)consumer.u);
  }
  return 0;
}
`,
    );
    const compiled = spawnSync(
      '/usr/bin/clang',
      ['-target', 'arm64-apple-macos13.0', '-O1', '-ffp-contract=off', source, '-o', binary],
      { encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    const oracle = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(oracle.status, 0, oracle.stderr);
    const expected = oracle.stdout
      .trim()
      .split('\n')
      .map((line) => line.split(' ').map((value) => BigInt(`0x${value}`)));
    assert.equal(expected.length, cases.length);
    session = await openBinary(binary, { cachePath: join(root, 'cache') });
    for (const emitter of ['c-like', 'python-like'] as const) {
      const result: ToolResult<'function_decompile'> = await session.decompile(
        { name: '_fixture_float' },
        { emitter },
      );
      assert.ok('data' in result && result.data.delivery === 'inline');
      const emission: WireEmission = result.data.emission;
      // The source view prints no FP-environment note; the premise is a recorded requirement.
      assert.doesNotMatch(emission.text, /nearest-even/);
      assert.ok(emission.requirements?.some((item) => item.kind === 'fp_environment'));
      assert.ok(
        emission.requirements?.some((item) =>
          item.sites.some((site) => site.state_epoch === 'fp_default_environment'),
        ),
      );
      const formals = emittedFormals(emission).filter((formal) => formal.name !== 'entry_sp');
      assert.equal(formals.length, 2, emission.text);
      for (const [index, [a, b]] of cases.entries()) {
        const observed = execute(
          emission,
          new Map([
            [formals[0]!.statement_id, bits(a)],
            [formals[1]!.statement_id, bits(b)],
          ]),
          new Map(),
          0n,
          new Map(),
          new Map(),
          new Map(),
          acknowledgeRequirements(emission),
        );
        assert.equal(observed.exit, 'machine_return');
        assert.deepEqual(observed.values, [expected[index]![0]!], `${emitter}: ${a}, ${b}`);
        if (index === 0) {
          // Source view states the FPCR premise once as an explicit requirement
          // (not silently) covering every original guard site; the checked view
          // keeps those guards, so an unacknowledged environment stays unknown.
          const environments =
            emission.requirements?.filter((item) => item.kind === 'fp_environment') ?? [];
          assert.equal(environments.length, 1, 'FPCR is not silently assumed by default');
          assert.equal(environments[0]!.status, 'assumption');
          const guards = environments[0]!.sites.filter((site) => site.predicate_value_id).length;
          assert.ok(guards > 0, emission.text);
          const checked: ToolResult<'function_decompile'> = await session.decompile(
            { name: '_fixture_float' },
            { emitter, view: 'checked' },
          );
          assert.ok('data' in checked && checked.data.delivery === 'inline');
          const checkedEmission: WireEmission = checked.data.emission;
          assert.equal(
            checkedEmission.text.match(/requirement_predicate\(/g)?.length,
            guards,
            checkedEmission.text,
          );
          const checkedInputs = new Map(
            emittedFormals(checkedEmission)
              .filter((formal) => formal.name !== 'entry_sp')
              .map((formal, argument) => [formal.statement_id, bits(argument ? b : a)] as const),
          );
          assert.equal(
            execute(checkedEmission, checkedInputs).exit,
            'unknown',
            'FPCR is not silently assumed by the checked view',
          );
          const acknowledged = execute(
            checkedEmission,
            checkedInputs,
            new Map(),
            0n,
            new Map(),
            new Map(),
            new Map(),
            acknowledgeRequirements(checkedEmission),
          );
          assert.equal(acknowledged.exit, 'machine_return');
          assert.deepEqual(acknowledged.values, [expected[index]![0]!]);
        }
      }
      const consumer: ToolResult<'function_decompile'> = await session.decompile(
        { name: '_fixture_float_consumer' },
        { emitter },
      );
      assert.ok('data' in consumer && consumer.data.delivery === 'inline');
      const consumerEmission: WireEmission = consumer.data.emission;
      const consumerFormals = emittedFormals(consumerEmission);
      const calls = new Map<string, (args: readonly bigint[]) => bigint>();
      calls.set('fixture_float', (args) => {
        assert.equal(args.length, 2);
        const bytes = new DataView(new ArrayBuffer(8));
        bytes.setBigUint64(0, args[0]!, true);
        const a = bytes.getFloat64(0, true);
        bytes.setBigUint64(0, args[1]!, true);
        return bits(a * 1.5 + bytes.getFloat64(0, true) * 0.5);
      });
      const environment = new Map<string, bigint>();
      environment.set('non-argument entry register', 0n);
      for (const [index, [a, b]] of cases.entries()) {
        const inputs = new Map<string, bigint>();
        let sourceIndex = 0;
        for (const formal of consumerFormals) {
          if (formal.name === 'entry_sp') inputs.set(formal.statement_id, 0x9000n);
          else {
            assert.ok(sourceIndex < 2, `Unexpected source input ${formal.name}`);
            inputs.set(formal.statement_id, sourceIndex++ === 0 ? bits(a) : bits(b));
          }
        }
        assert.equal(sourceIndex, 2);
        const memory = new Map<bigint, number>();
        for (let offset = -256; offset < 0; offset++) memory.set(0x9000n + BigInt(offset), 0xa5);
        const observed = execute(
          consumerEmission,
          inputs,
          memory,
          0n,
          new Map(),
          environment,
          calls,
          acknowledgeRequirements(consumerEmission),
        );
        assert.equal(observed.exit, 'machine_return');
        assert.deepEqual(observed.values, [expected[index]![1]!]);
        assert.deepEqual(observed.source_calls, [
          { name: 'fixture_float', arguments: [bits(a), bits(b)] },
        ]);
      }
    }
  },
);

test(
  'source-built Mach-O: a local fesetround wrapper keeps its caller FP guards; an ordinary callee preserves the environment',
  { skip: nativeOracleSkip(), timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-fp-writer-'));
    let session: BinarySession | undefined;
    t.after(async () => {
      await session?.close();
      await rm(root, { recursive: true, force: true });
    });
    const source = join(root, 'writer.c'),
      binary = join(root, 'writer');
    // Compiled, never executed: the decompiler receives only the binary.
    await writeFile(
      source,
      `
#include <fenv.h>
#include <unistd.h>
__attribute__((noinline)) void fixture_set_upward(void) { fesetround(FE_UPWARD); }
__attribute__((noinline)) int fixture_ordinary(void) { return getpid(); }
__attribute__((noinline)) double fixture_writer_caller(double a, double b) {
  double x = a * b;
  fixture_set_upward();
  return x + b;
}
__attribute__((noinline)) double fixture_plain_caller(double a, double b) {
  double x = a * b;
  fixture_ordinary();
  return x + b;
}
int main(void) {
  volatile double a = 1.5, b = 2.5;
  return (int)(fixture_writer_caller(a, b) + fixture_plain_caller(a, b));
}
`,
    );
    const compiled = spawnSync(
      '/usr/bin/clang',
      [
        '-target',
        'arm64-apple-macos13.0',
        '-O1',
        '-ffp-contract=off',
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
      const text = async (name: string): Promise<string> => {
        const result: ToolResult<'function_decompile'> = await session!.decompile(
          { name },
          { emitter },
        );
        assert.ok('data' in result && result.data.delivery === 'inline', name);
        return result.data.emission.text;
      };
      // The wrapper's summary shows a changed FPCR (a writer-import call on its
      // exit path), so the caller keeps the guard of every FP operation.
      const writer = await text('_fixture_writer_caller');
      assert.match(writer, /fixture_set_upward\(/, writer);
      assert.equal([...writer.matchAll(/requirement_predicate\(/g)].length, 2, writer);
      // getpid preserves FPCR (AAPCS64 6.1.2): the default environment is assumed.
      const plain = await text('_fixture_plain_caller');
      assert.match(plain, /fixture_ordinary\(/, plain);
      assert.doesNotMatch(plain, /requirement_predicate\(/, plain);
    }
  },
);
