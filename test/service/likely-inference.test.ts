import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { expandEmission, openBinary } from '../../src/api/index.js';
import type { BinarySession, DecompileOptions } from '../../src/api/index.js';
import { CLANG, nativeOracleSkip } from '../support/host-tools.js';

// Trusted source-built fixture, compiled here and never executed; the decompiler receives only
// the -g0 binary. `hub` and `hub2` stay open under every proven rule (they pass unobserved
// argument registers into an indirect call), which is exactly what the likely heuristics guess.
test(
  'likely inference: opt-in, separately cached, marked and recorded; disagreement stays open',
  { skip: nativeOracleSkip(), timeout: 180_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-likely-'));
    let session: BinarySession | undefined;
    t.after(async () => {
      await session?.close();
      await rm(root, { recursive: true, force: true });
    });
    const binary = join(root, 'likely');
    const compiled = spawnSync(
      CLANG,
      [
        '-target',
        'arm64-apple-macos13.0',
        '-O1',
        '-g0',
        '-fno-builtin',
        '-fno-optimize-sibling-calls',
        resolve('test/service/likely-inference-source.c'),
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
        inference.details.kind === 'guess' && inference.details.subject === 'argument_list'
          ? [{ inference, ...inference.details }]
          : [],
      );
      return { result, text: emission.text, guesses, emission };
    };

    // Default is proven: no marker, no guess, the open list is explicit, and an explicit
    // `proven` is byte-identical to omitting the option.
    const first = await run('caller_a');
    assert.match(first.text, /hub\([^)]*\.\.\.\)/);
    assert.doesNotMatch(first.text, /likely_arity/);
    assert.equal(first.guesses.length, 0);
    const proven = await run('caller_a', { inference: 'proven' });
    assert.equal(proven.text, first.text);
    assert.equal(first.result.data.cache, 'computed');
    assert.equal(proven.result.data.cache, 'hit', 'explicit proven is the default row');

    // Both dialects: the closed call is marked, the open marker is gone, and one guess record
    // names the heuristics, the arity and the agreeing call sites. The call record never claims
    // a complete arity.
    for (const emitter of ['c-like', 'python-like'] as const) {
      const likely = await run('caller_a', { inference: 'likely', emitter });
      assert.match(likely.text, /likely_arity\(hub\([^)]*\)\)/, likely.text);
      assert.doesNotMatch(likely.text, /hub\([^)]*\.\.\./);
      assert.equal(likely.guesses.length, 1);
      const [guess] = likely.guesses;
      assert.deepEqual(guess!.heuristics, ['callee_reads', 'caller_consensus']);
      assert.equal(guess!.applied, true);
      assert.equal(guess!.arity, 1);
      assert.equal(guess!.sites, 2);
      assert.equal(guess!.inference.status, 'hypothesis');
      const call = (expandEmission(likely.emission).inferences ?? []).find(
        (inference) =>
          inference.details.kind === 'call' && inference.details.call_id === guess!.call_id,
      );
      assert.ok(call && call.details.kind === 'call' && call.details.arity_complete === false);
      assert.ok(
        likely.emission.helpers?.some((helper) => helper.name === 'likely_arity'),
        'the marker is a documented helper',
      );
    }

    // Cache separation: the likely request after a proven one is computed, not a proven hit;
    // repeating it hits its own row; the proven row is untouched.
    const again = await run('caller_a', { inference: 'likely' });
    assert.equal(again.result.data.cache, 'hit');
    const provenAgain = await run('caller_a');
    assert.equal(provenAgain.text, first.text);
    assert.equal(provenAgain.result.data.cache, 'hit');
    const fresh = await run('caller_b', { inference: 'likely' });
    assert.equal(fresh.result.data.cache, 'computed');

    // Disagreement: the callers of hub2 prepare different prefixes, so caller consensus
    // abstains. The callee body alone still supports the one site that prepares what it
    // reads; the site that prepares more keeps its explicit open remainder.
    const agree = await run('split_a', { inference: 'likely' });
    assert.equal(agree.guesses.length, 1);
    assert.deepEqual(agree.guesses[0]!.heuristics, ['callee_reads']);
    assert.match(agree.text, /likely_arity\(hub2\(/);
    const split = await run('split_b', { inference: 'likely' });
    assert.equal(split.guesses.length, 0);
    assert.doesNotMatch(split.text, /likely_arity/);
    assert.match(split.text, /hub2\([^)]*, \.\.\.\)/);
  },
);
