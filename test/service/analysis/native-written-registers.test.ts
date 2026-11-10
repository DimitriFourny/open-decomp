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
import { gccOracleSkip } from '../../support/host-tools.js';

const fp = new DataView(new ArrayBuffer(8));
const bits = (value: number): bigint => {
  fp.setFloat64(0, value, true);
  return fp.getBigUint64(0, true);
};
const number = (value: bigint): number => {
  fp.setBigUint64(0, value, true);
  return fp.getFloat64(0, true);
};
const scale = (value: bigint): bigint => BigInt.asUintN(32, value * 3n + 1n);
const cases = [0n, 1n, 0x7fffffffn, 0x80000000n, 0xffffffffn];

// Trusted, locally compiled fixture (the only binary that executes). gcc -O2 keeps
// caller values in caller-saved registers across calls to local callees that never
// write them; the source view must print those values, and only those.
test(
  'calls to callees with complete written-register sets keep the caller-saved values they leave unwritten',
  { skip: gccOracleSkip(), timeout: 180_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-written-registers-'));
    let session: BinarySession | undefined;
    t.after(async () => {
      await session?.close();
      await rm(root, { recursive: true, force: true });
    });
    const binary = join(root, 'written-registers');
    const compiled = spawnSync(
      'gcc',
      [
        '-O2',
        '-g0',
        '-DWRITTEN_ORACLE',
        resolve('test/service/analysis/native-written-registers-source.c'),
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
        .filter((line) => !line.startsWith('asm '))
        .map((line) => {
          const [name, index, value] = line.split(' ');
          return [`${name}:${index}`, BigInt(`0x${value}`)] as const;
        }),
    );
    session = await openBinary(binary, { cachePath: join(root, 'cache') });
    const decompile = async (name: string, emitter: 'c-like' | 'python-like') => {
      const result = await session!.decompile({ name }, { emitter, view: 'source' });
      assert.ok('data' in result && result.data.delivery === 'inline');
      return result.data.emission;
    };
    const run = (
      emission: WireEmission,
      args: readonly bigint[],
      oracles: ReadonlyMap<string, SourceCallOracle>,
    ): readonly bigint[] => {
      const formals = emittedFormals(emission);
      assert.equal(formals.length, args.length, emission.text);
      const observed = execute(
        emission,
        new Map(formals.map((formal, index) => [formal.statement_id, args[index]!])),
        new Map(),
        0n,
        new Map(),
        new Map(),
        oracles,
        acknowledgeRequirements(emission),
      );
      assert.equal(observed.exit, 'machine_return', emission.text);
      return observed.values as readonly bigint[];
    };
    const callOracle = (name: string, body: (args: readonly bigint[]) => bigint) =>
      new Map<string, SourceCallOracle>([
        [
          name,
          (args) => {
            assert.equal(args.length, 1, `${name} takes one argument`);
            return body(args);
          },
        ],
      ]);
    for (const emitter of ['c-like', 'python-like'] as const) {
      for (const [name, callee, body] of [
        ['ipa_keep_arg', 'ipa_scale', ([value]: readonly bigint[]) => scale(value!)],
        ['ipa_nested', 'ipa_twice', ([value]: readonly bigint[]) => scale(scale(value!))],
      ] as const) {
        const emission = await decompile(name, emitter);
        assert.doesNotMatch(emission.text, /call clobbers/, emission.text);
        for (const [index, x] of cases.entries())
          assert.deepEqual(
            run(emission, [x, cases[(index + 2) % 5]!], callOracle(callee, body)),
            [expected.get(`${name.slice(4)}:${index}`)!],
            `${emitter} ${name} ${index}`,
          );
      }
      const keepFp = await decompile('ipa_keep_fp', emitter);
      assert.doesNotMatch(keepFp.text, /call clobbers/, keepFp.text);
      for (let index = 0; index < 5; index++)
        assert.deepEqual(
          run(
            keepFp,
            [bits(index * 1.5 - 2), bits(index + 0.25)],
            callOracle('ipa_half', ([value]) => bits(number(value!) * 0.5)),
          ),
          [expected.get(`keep_fp:${index}`)!],
          `${emitter} ipa_keep_fp ${index}`,
        );
      // Hand-written callees: r11 written on one path only, r11b alone, r10 plus a
      // tail transfer into the one-path writer, r9 saved and restored through the
      // stack (no restore proof). Each such register stays a call clobber; r8,
      // which none of them writes, is the caller's value.
      for (const [name, clobbered] of [
        ['caller_one_path', ['r11']],
        ['caller_low_byte', ['r11']],
        ['caller_tail', ['r10']],
        ['caller_spill', ['r9']],
      ] as const) {
        const text = (await decompile(name, emitter)).text;
        for (const register of clobbered)
          assert.match(text, new RegExp(`call clobbers ${register}\\b`), `${name}\n${text}`);
        assert.doesNotMatch(text, /call clobbers r8\b/, `${name}\n${text}`);
        if (name === 'caller_tail') assert.doesNotMatch(text, /call clobbers r9\b/, text);
      }
    }
  },
);
