import assert from 'node:assert/strict';
import test from 'node:test';
import { emittedFormals, execute } from '../../emitters/c/support.js';
import { project } from './support.js';

// Independent oracle: fixtures/source/corpus.c:16 and corpus.h's unary typedef:
// u32 fixture_indirect(unary fn, u32 a) { return fn(a) + 1; }
// The analyzer receives only the existing binary, never this prototype.
const arguments_ = [0n, 1n, 35n, 0x7fffffffn, 0x80000000n, 0xffffffffn];
const targets = [0x6000n, 0x7000n];
const callback = (target: bigint, argument: bigint): bigint =>
  BigInt.asUintN(32, target === targets[0] ? argument * 3n + 7n : argument ^ 0xa5a5a5a5n);

for (const fixture of [
  'macho-arm64-symbols',
  'macho-arm64-stripped',
  'corpus-symbols.dll',
  'libcorpus-elf-x86_64-symbols.so',
])
  test(`${fixture}: callback argument prefix and consumed result survive default source projection`, async (t) => {
    const p = await project(t, fixture);
    const fn = p.functions.find(
      (candidate) =>
        candidate.original_name?.replace(/^_/, '') === 'fixture_indirect' ||
        (fixture === 'macho-arm64-stripped' && candidate.entry.value === 0x100000608n),
    );
    assert.ok(fn);
    for (const emitter of ['c-like', 'python-like'] as const) {
      const response = await p.decompile(fn.id, { options: { emitter } });
      assert.ok('data' in response.result);
      const full = p.payload(response.result).result;
      const emission = full.data.emission;
      // The open arity is spelled by the function-pointer type; the call prints its one
      // proven argument only.
      assert.match(
        emission.text,
        emitter === 'c-like'
          ? /\(\*\)\([^)]*, \.\.\.\)\)\w+\)\([^.\n]*\)/
          : /function_pointer\(\w+, "[^"]*\(\*\)\([^"]*, \.\.\.\)"\)\([^.\n]*\)/,
      );
      const declared = emittedFormals(emission);
      const formals = declared.filter((formal) => formal.name !== 'entry_sp');
      assert.equal(
        formals.length,
        2,
        'The callback target and independent value input must both remain observable',
      );
      const entryStack = declared.find((formal) => formal.name === 'entry_sp');
      for (const target of targets)
        for (const argument of arguments_) {
          const memory = new Map<bigint, number>([[0x9000n, 0]]);
          // Fixed trusted machine environment for any conservatively retained
          // frame saves. It supplies no source/callback prototype or result.
          const stack = fixture.startsWith('macho-') ? 0x10000n : 0x10008n;
          for (let offset = -256n; offset < 256n; offset++) memory.set(stack + offset, 0);
          let invoked = 0;
          const oracle = (
            values: readonly bigint[],
            context?: { readonly arguments_complete: boolean },
          ) => {
            // This test oracle independently knows the fixture's unary source
            // contract. It does not turn incomplete machine evidence into a
            // production prototype or discard uncertainty by default.
            assert.equal(context?.arguments_complete, false);
            assert.deepEqual(
              values.map((value) => BigInt.asUintN(32, value)),
              [argument],
            );
            invoked++;
            memory.set(0x9000n, Number(argument & 255n));
            return callback(target, argument);
          };
          const inputs = new Map([
            [formals[0]!.statement_id, target],
            [formals[1]!.statement_id, argument],
          ]);
          if (entryStack) inputs.set(entryStack.statement_id, stack);
          const observation = execute(
            emission,
            inputs,
            memory,
            0n,
            new Map(),
            new Map([['non-argument entry register', 0n]]),
            new Map([[`0x${target.toString(16)}`, oracle]]),
          );
          assert.equal(observation.exit, 'machine_return');
          assert.deepEqual(observation.values, [
            BigInt.asUintN(32, callback(target, argument) + 1n),
          ]);
          assert.equal(invoked, 1);
          assert.deepEqual(
            observation.events.filter((event) => event === 'call'),
            ['call'],
          );
          assert.equal(observation.calls.length, 1);
          assert.equal(observation.calls[0]!.target, target);
          assert.deepEqual(
            observation.calls[0]!.arguments.map((value) => BigInt.asUintN(32, value)),
            [argument],
          );
          assert.equal(observation.calls[0]!.arguments_complete, false);
          assert.equal(observation.memory.get(0x9000n), Number(argument & 255n));
        }
    }
  });
