import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { openBinary, type BinarySession } from '../../../src/api/index.js';
import type { WireEmission } from '../../../src/core/index.js';
import {
  acknowledgeRequirements,
  emittedFormals,
  execute,
  type SourceCallOracle,
} from '../../emitters/c/support.js';
import { nativeOracleSkip } from '../../support/host-tools.js';

const u64 = (value: bigint): bigint => BigInt.asUintN(64, value);
const mix = (value: bigint): bigint => u64(value ^ 0x5a5a5a5a5a5a5a5an);

/** Top-level argument texts of every call to `name` in emitted text (not its
 * `extern` declaration). */
function callArguments(text: string, name: string): string[][] {
  const calls: string[][] = [];
  for (const match of text.matchAll(new RegExp(`\\b${name}\\(`, 'g'))) {
    if (/^\s*extern\b/.test(text.slice(text.lastIndexOf('\n', match.index) + 1))) continue;
    const args: string[] = [];
    let depth = 0,
      start = match.index + match[0].length;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (char === '(') depth++;
      else if (char === ')' && depth-- === 0) {
        args.push(text.slice(start, index).trim());
        break;
      } else if (char === ',' && depth === 0) {
        args.push(text.slice(start, index).trim());
        start = index + 1;
      }
    }
    calls.push(args.filter((arg) => arg.length > 0));
  }
  return calls;
}

// Trusted, locally compiled fixture (the only binary that executes); the
// product receives a -g0 image without prototypes for the native functions.
test(
  'native call interfaces close through tail-call recursion, reachable indirect calls, variadic joins and void results',
  { skip: nativeOracleSkip(), timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-call-interfaces-'));
    let session: BinarySession | undefined;
    t.after(async () => {
      await session?.close();
      await rm(root, { recursive: true, force: true });
    });
    const binary = join(root, 'call-interfaces');
    const compiled = spawnSync(
      '/usr/bin/clang',
      [
        '-target',
        'arm64-apple-macos13.0',
        '-O2',
        '-g0',
        '-fno-builtin',
        resolve('test/service/analysis/native-call-interfaces-source.c'),
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
    session = await openBinary(binary, { cachePath: join(root, 'cache') });
    const decompile = async (name: string, emitter: 'c-like' | 'python-like') => {
      const result = await session!.decompile({ name: `_${name}` }, { emitter, view: 'source' });
      assert.ok('data' in result && result.data.delivery === 'inline');
      return result.data.emission;
    };
    const run = (
      emission: WireEmission,
      args: readonly bigint[],
      oracles: ReadonlyMap<string, SourceCallOracle>,
      memory = new Map<bigint, number>(),
    ) => {
      const formals = emittedFormals(emission);
      assert.deepEqual(
        formals.map((formal) => formal.name).filter((name) => name === 'entry_sp'),
        [],
        emission.text,
      );
      assert.equal(formals.length, args.length, emission.text);
      const observed = execute(
        emission,
        new Map(formals.map((formal, index) => [formal.statement_id, args[index]!])),
        memory,
        0n,
        new Map(),
        new Map([['non-argument entry register', 0n]]),
        oracles,
        acknowledgeRequirements(emission),
      );
      assert.equal(observed.exit, 'machine_return', emission.text);
      return observed.values;
    };
    const oracle = (
      name: string,
      arity: number,
      complete: boolean,
      body: (args: readonly bigint[]) => bigint,
    ): ReadonlyMap<string, SourceCallOracle> => {
      const call: SourceCallOracle = (args, context) => {
        assert.equal(args.length, arity, `${name} keeps every observed argument`);
        assert.equal(context.arguments_complete, complete, `${name} arity closure`);
        return body(args);
      };
      return new Map([
        [name, call],
        [`_${name}`, call],
      ]);
    };
    for (const emitter of ['c-like', 'python-like'] as const) {
      // The append/grow group passes op and p1 through two tail calls; grow's
      // own call to reserve leaves the other argument registers live, so the
      // group closes only coinductively and only because reserve is closed.
      const append = await decompile('native_append_caller', emitter);
      for (const value of [0n, 1n, 0x7fffffffn, 0x1234567887654321n])
        assert.deepEqual(
          run(
            append,
            [0x5000n, value],
            oracle('native_append', 3, true, ([ops, op, p1]) => u64(ops! + op! * 3n + p1!)),
          ),
          [u64(0x5000n + value * 3n + 5n + 1n)],
          `${emitter} append ${value}`,
        );
      // An indirect call reached only by computed values (after another call
      // clobbered the argument registers) adds no input; one that unused
      // argument registers still reach keeps the list open.
      for (const [name, complete, body] of [
        ['apply', true, (value: bigint) => u64(mix(mix(value)) + 3n)],
        ['apply_open', false, (value: bigint) => u64(mix(u64(value + 1n)) + 3n)],
      ] as const) {
        const caller = await decompile(`native_${name}_caller`, emitter);
        for (const [index, value] of [
          0n,
          1n,
          0x7fffffffn,
          0xffffffffn,
          0x1234567887654321n,
        ].entries())
          assert.deepEqual(
            run(
              caller,
              [0x4000n, value],
              oracle(`native_${name}`, 2, complete, ([fn, v]) => {
                assert.equal(fn, 0x4000n);
                return body(v!);
              }),
            ),
            [expected.get(`${name}:${index}`)!],
            `${emitter} ${name} ${index}`,
          );
      }
      // A void body whose last call result stays in x0 returns nothing, and
      // its callers do not consume that stale register.
      const release = await decompile('native_release', emitter);
      assert.match(
        release.text,
        emitter === 'c-like' ? /^void native_release\(/m : /^def native_release\(.*\) -> void:/m,
      );
      const releaseCaller = await decompile('native_release_caller', emitter);
      assert.doesNotMatch(releaseCaller.text, /=\s*native_release\(/);
      const memory = new Map<bigint, number>();
      for (let byte = 0n; byte < 16n; byte++) memory.set(0x6000n + byte, byte === 8n ? 0x34 : 0);
      assert.deepEqual(
        run(releaseCaller, [0x6000n], oracle('native_release', 1, true, () => 0xdeadn), memory),
        [0x34n],
      );
      // Darwin variadic stack arguments stored in both predecessors of one
      // shared fprintf call resolve completely: the path is one value stored
      // on both edges, the code a value the join's x21 parameter carries.
      const report = await decompile('native_report', emitter);
      assert.doesNotMatch(report.text, /unknown_argument_remainder|unknown_arguments|entry_sp/);
      const printed = callArguments(report.text, 'fprintf');
      assert.equal(printed.length, 1, report.text);
      assert.equal(printed[0]!.length, 4, report.text);
      // Darwin open reads its stack mode when every possible flag sets O_CREAT.
      const created = await decompile('native_create', emitter);
      const opened = callArguments(created.text, 'open');
      assert.equal(opened.length, 1, created.text);
      assert.equal(opened[0]!.length, 3, created.text);
      assert.match(opened[0]![2]!, /0x180|384/, created.text);
    }
  },
);
