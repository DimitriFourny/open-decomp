import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openBinary, type BinarySession } from '../../src/api/index.js';
import { acknowledgeRequirements, emittedFormals, execute } from '../emitters/c/support.js';
import { CLANG, nativeOracleSkip } from '../support/host-tools.js';
import {
  ARM_CODES,
  X86_CODES,
  conditionArguments,
  conditionFunctions,
  conditionSource,
  floatInputs,
  integerInputs,
  type Target,
} from './condition-flags-fixture.js';

/** Only the host oracle built from the checked-in fixture text executes. */
function compile(args: readonly string[]): void {
  const result = spawnSync(CLANG, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test(
  'every ARM64/x86-64 condition code, conditional-compare chain and FP compare folds to native relations that match the trusted oracle in both dialects',
  { skip: nativeOracleSkip(), timeout: 900_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-condition-flags-'));
    const sessions: BinarySession[] = [];
    t.after(async () => {
      for (const session of sessions) await session.close();
      await rm(root, { recursive: true, force: true });
    });
    const source = join(root, 'conditions.c');
    await writeFile(source, conditionSource());
    compile(['-DCF_ORACLE', '-O2', '-ffp-contract=off', source, '-o', join(root, 'oracle')]);
    const oracle = spawnSync(join(root, 'oracle'), [], { encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(oracle.status, 0, oracle.stderr);
    const expected = new Map<string, bigint>();
    for (const line of oracle.stdout.trim().split('\n')) {
      const [name, i, j, value] = line.split(' ');
      expected.set(`${name} ${i} ${j}`, BigInt(`0x${value}`));
    }
    const binaries: Record<Target, string> = {
      arm64: join(root, 'conditions.dylib'),
      x86_64: join(root, 'conditions.so'),
    };
    compile([
      '-target',
      'arm64-apple-macos13.0',
      '-O2',
      '-dynamiclib',
      source,
      '-o',
      binaries.arm64,
    ]);
    compile([
      '-target',
      'x86_64-unknown-linux-gnu',
      '-O2',
      '-ffreestanding',
      '-fuse-ld=lld',
      '-nostdlib',
      '-shared',
      source,
      '-o',
      binaries.x86_64,
    ]);
    let executions = 0,
      folded = 0;
    const executed = new Set<string>();
    for (const target of ['arm64', 'x86_64'] as const) {
      const session = await openBinary(binaries[target], {
        cachePath: join(root, `${target}-cache`),
      });
      sessions.push(session);
      for (const item of conditionFunctions()) {
        if (!item.targets.includes(target)) continue;
        executed.add(`${target} ${item.name}`);
        const count = item.float ? floatInputs.length : integerInputs.length;
        for (const emitter of ['c-like', 'python-like'] as const) {
          const result = await session.decompile(
            { name: target === 'arm64' ? `_${item.name}` : item.name },
            { emitter },
          );
          assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
          const emission = result.data.emission;
          const text = emission.text;
          const context = `${target} ${item.name} ${emitter}\n${text}`;
          // Relations print natively: no flag helpers, NZCV packing, FP compare
          // helpers or bitwise complements in conditions, except where a
          // condition reads V/OF or PF alone.
          const body = text.slice(text.search(new RegExp(`^.*\\b${item.name}\\(`, 'm')));
          if (!item.helper) {
            assert.doesNotMatch(
              body,
              /\b(?:flag_\w+|insert_bits|fp_(?:eq|ne|lt|le|gt|ge|ordered|unordered))\(/,
              context,
            );
            assert.doesNotMatch(body, /^\s*(?:if|while|elif|return)\b.*~\(/m, context);
            folded++;
          }
          // The ABI numbers integer and FP registers separately: bind the
          // formals of each class, in order, to that class of arguments. A
          // Python-like integer annotation is the caller's range, as a C
          // conversion is.
          const header = body.slice(0, body.indexOf('\n'));
          const formals = emittedFormals(emission).map((formal) => {
            const type = new RegExp(
              emitter === 'c-like' ? `(\\w+)\\s+${formal.name}\\b` : `\\b${formal.name}: (\\w+)`,
            ).exec(header)?.[1];
            assert.ok(type, `${context}\nformal ${formal.name}`);
            return { id: formal.statement_id, type };
          });
          for (let i = 0; i < count; i++)
            for (let j = 0; j < count; j++) {
              const args = conditionArguments(item, i, j);
              const floating = (index: number): boolean =>
                index < 2 ? item.float : item.arms === 'float';
              const floats = args.filter((_, index) => floating(index)),
                integers = args.filter((_, index) => !floating(index));
              const inputs = new Map<string, bigint>();
              for (const formal of formals) {
                if (formal.type === 'double') {
                  inputs.set(formal.id, floats.shift()!);
                  continue;
                }
                const width = /^(u?)int(\d+)_t$/.exec(formal.type);
                assert.ok(width, `${context}\nformal type ${formal.type}`);
                const bits = integers.shift()!;
                inputs.set(
                  formal.id,
                  emitter === 'c-like'
                    ? bits
                    : width[1]
                      ? BigInt.asUintN(Number(width[2]), bits)
                      : BigInt.asIntN(Number(width[2]), bits),
                );
              }
              const observed = execute(
                emission,
                inputs,
                new Map(),
                0n,
                new Map(),
                new Map([['non-argument entry register', 0n]]),
                new Map(),
                acknowledgeRequirements(emission),
              );
              assert.equal(observed.exit, 'machine_return', context);
              assert.deepEqual(
                observed.values,
                [expected.get(`${item.name} ${i} ${j}`)],
                `${context}\ninputs ${args.map((value) => `0x${value.toString(16)}`).join(', ')}`,
              );
              executions++;
            }
        }
      }
    }
    // Every ARM64 code with a compare (all but AL/NV) and every x86 code is
    // consumed by a cset/b.cond/csel/conditional compare or setcc/jcc/cmov.
    for (const code of ARM_CODES)
      for (const form of ['cset', 'cset32', 'branch', 'csel', 'cmn', 'tst', 'fcmp', 'fcsel'])
        assert.ok(executed.has(`arm64 cf_arm_${form}_${code}`), `${form} ${code}`);
    for (const code of X86_CODES)
      for (const form of ['set', 'set32', 'jcc', 'cmov', 'test', 'ucomisd', 'comisd', 'fjcc'])
        assert.ok(executed.has(`x86_64 cf_x86_${form}_${code}`), `${form} ${code}`);
    assert.ok(folded > 500, String(folded));
    assert.ok(executions > 30_000, String(executions));
  },
);
