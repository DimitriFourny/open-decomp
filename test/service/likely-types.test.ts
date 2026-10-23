import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { expandEmission, openBinary } from '../../src/api/index.js';
import type { BinarySession, DecompileOptions } from '../../src/api/index.js';
import { LIKELY_GATE } from '../../src/core/index.js';
import { CLANG, nativeOracleSkip } from '../support/host-tools.js';

// Trusted source-built fixture, compiled here and never executed; the decompiler receives only
// the -g0 binary. Each function leaves one formal or the result integer-typed under every proven
// rule. The test asserts the contract, not which heuristics currently pass the precision gate:
// a guess is always recorded, and it prints (marked, in both dialects) exactly when
// `LIKELY_GATE` enables its heuristic; otherwise the text is what proven analysis prints.
test(
  'likely type guesses: recorded always, printed marked only through the gate, proven unchanged',
  { skip: nativeOracleSkip(), timeout: 180_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-likely-types-'));
    let session: BinarySession | undefined;
    t.after(async () => {
      await session?.close();
      await rm(root, { recursive: true, force: true });
    });
    const binary = join(root, 'likely-types');
    const compiled = spawnSync(
      CLANG,
      [
        '-target',
        'arm64-apple-macos13.0',
        '-O1',
        '-g0',
        '-fno-builtin',
        '-fno-optimize-sibling-calls',
        resolve('test/service/likely-types-source.c'),
        '-o',
        binary,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    session = await openBinary(binary, { cachePath: join(root, 'cache') });
    const run = async (name: string, options: DecompileOptions = {}) => {
      const result = await session!.decompile({ name: `_${name}` }, options);
      assert.ok('data' in result && result.data.delivery === 'inline', name);
      const emission = result.data.emission;
      const guesses = (expandEmission(emission).inferences ?? []).flatMap((inference) =>
        inference.details.kind === 'guess' && inference.details.subject !== 'argument_list'
          ? [{ inference, ...inference.details }]
          : [],
      );
      return { text: emission.text, guesses, emission };
    };

    const cases = [
      { fn: 'run', subject: 'parameter_type', ordinal: 0, heuristic: 'indirect_call_target' },
      { fn: 'carry', subject: 'parameter_type', ordinal: 0, heuristic: 'carried_word_formal' },
      { fn: 'tag', subject: 'parameter_type', ordinal: 0, heuristic: 'caller_argument_pointer' },
      { fn: 'fetch', subject: 'result_type', ordinal: null, heuristic: 'caller_result_pointer' },
    ] as const;
    for (const { fn, subject, ordinal, heuristic } of cases) {
      const proven = await run(fn);
      assert.equal(proven.guesses.length, 0, `${fn}: proven mode records no guess`);
      assert.doesNotMatch(proven.text, /likely_type/);
      for (const emitter of ['c-like', 'python-like'] as const) {
        const reference = await run(fn, { emitter });
        const likely = await run(fn, { inference: 'likely', emitter });
        const found = likely.guesses.filter((guess) => guess.subject === subject);
        assert.equal(found.length, 1, `${fn}: one ${subject} guess`);
        const guess = found[0]!;
        assert.equal(guess.ordinal, ordinal);
        assert.equal(guess.guessed_type, 'pointer');
        assert.ok(guess.heuristics.includes(heuristic), `${fn}: ${guess.heuristics.join(',')}`);
        assert.equal(guess.inference.status, 'hypothesis');
        const applied = guess.heuristics.some((name) => LIKELY_GATE[name]);
        assert.equal(guess.applied, applied, `${fn}: applied follows the gate`);
        if (applied) {
          assert.match(likely.text, /likely_type\(/, `${fn} ${emitter}: marked`);
          assert.ok(likely.emission.helpers?.some((helper) => helper.name === 'likely_type'));
        } else {
          // A heuristic below the precision gate leaves the proven text untouched.
          assert.equal(likely.text, reference.text, `${fn} ${emitter}: gate keeps proven text`);
        }
      }
    }
    // The callers of `tag` and `fetch` are the evidence: two agreeing sites each.
    const tag = await run('tag', { inference: 'likely' });
    assert.equal(tag.guesses[0]!.sites, 2);
    // No evidence, no guess: integer formals and results stay as they are.
    const plain = await run('plain', { inference: 'likely' });
    assert.equal(plain.guesses.length, 0);
    assert.doesNotMatch(plain.text, /likely_type/);
  },
);

test('the gate table names every heuristic and enables only measured ones', () => {
  // Heuristics measured below 95% (docs/BENCHMARK.md) must stay disabled.
  for (const name of [
    'opaque_word_formal',
    'caller_argument_pointer',
    'caller_result_pointer',
  ] as const)
    assert.equal(LIKELY_GATE[name], false, name);
});
