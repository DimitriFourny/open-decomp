import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  createOperationContext,
  DEFAULT_ANALYSIS_OPTIONS,
  entityIdentity,
} from '../../../src/core/index.js';
import { IRBuilder, integer, type SSAForm, type Value } from '../../../src/ir/index.js';
import { structureControlFlow } from '../../../src/presentation/index.js';
import { emitC } from '../../../src/emitters/c/index.js';
import { emitPythonLike } from '../../../src/emitters/python-like/index.js';
import type { EmissionResult } from '../../../src/emitters/model.js';
import { provenance, slice } from '../../ir/support.js';
import { execute } from './support.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';

const i32 = integer(32),
  i64 = integer(64);
const program = (name: string): IRBuilder<'ssa'> =>
  new IRBuilder(slice, entityIdentity(slice, 'function', name), provenance, 'ssa');
const memory = (words: readonly number[] = []): Map<bigint, number> =>
  new Map(
    Array.from({ length: 64 }, (_, index) => [
      0x1000n + BigInt(index),
      index % 4 === 0 ? (words[index / 4] ?? 0) & 255 : 0,
    ]),
  );
const emit = (
  input: SSAForm,
  language: 'c-like' | 'python-like',
  view: 'source' | 'checked' = 'source',
  source = false,
): EmissionResult => {
  const structured = structureControlFlow(input, createOperationContext());
  assert.ok(structured.value);
  return (language === 'python-like' ? emitPythonLike : emitC)(
    {
      function: structured.value,
      ...(source ? { source: { abi: new DarwinArm64Abi(), callees: [], addresses: [] } } : {}),
    },
    { ...DEFAULT_ANALYSIS_OPTIONS, emitter: language, view },
    createOperationContext(),
  );
};
const rules = (output: EmissionResult): string[] =>
  (output.emission.local_validation ?? []).flatMap((record) =>
    record.kind === 'presentation' && record.rule ? [record.rule] : [],
  );
const name = (output: EmissionResult, value: Value): string | undefined =>
  output.identifiers.find((row) => row.entity_id === value.id)?.identifier;

/** `do { acc += *p; p += 4; } while (--n != 0)`, the compiled form of a counted
 * loop whose test reads the counter before its decrement. `guarded` adds the
 * rotated loop's `n == 0` early return, which proves the first test. */
function countedLoop(guarded = true): {
  input: SSAForm;
  count: Value;
  base: Value;
  acc: Value;
  next: Value;
} {
  const b = program(`source-control-counted-${guarded}`),
    entry = b.block('entry', [i32, i64]),
    loop = b.block('loop', [i32, i64, i32]),
    exit = b.block('exit', [i32]);
  const [count, base] = entry.parameters as [Value, Value];
  if (guarded) {
    const zero = b.block('zero');
    entry.branch(
      entry.compare('eq', count, entry.constant(i32, 0n)),
      entry.edge(zero),
      entry.edge(loop, [entry.constant(i32, 0n), base, count]),
    );
    zero.return([zero.constant(i32, 0n)]);
  } else entry.jump(loop, [entry.constant(i32, 0n), base, count]);
  const [acc, pointer, remaining] = loop.parameters as [Value, Value, Value];
  const next = loop.int('add', loop.load(i32, pointer), acc);
  loop.branch(
    loop.compare('ne', remaining, loop.constant(i32, 1n)),
    loop.edge(loop, [
      next,
      loop.int('add', pointer, loop.constant(i64, 4n)),
      loop.int('sub', remaining, loop.constant(i32, 1n)),
    ]),
    loop.edge(exit, [next]),
  );
  exit.return(exit.parameters);
  return { input: b.finish(entry, [i32]), count, base, acc, next };
}

for (const language of ['c-like', 'python-like'] as const)
  describe(language, () => {
    const c = language === 'c-like';
    test('a guarded counted loop prints as for with one coalesced accumulator; checked keeps while(true)', () => {
      const { input, count, base, acc, next } = countedLoop();
      const source = emit(input, language),
        checked = emit(input, language, 'checked');
      const text = source.emission.text;
      assert.doesNotMatch(text, /\bcontinue\b|\bgoto\b|\belse\b/);
      if (c) {
        // init and step print only the induction variables; the accumulator stays in the body.
        assert.match(
          text,
          /\n {2}for \(\w+ = [^,;]+, \w+ = [^,;]+; \(?\w+ != 0(x0)?\)?; \w+ = .+, \w+ = .+\) \{\n/,
        );
        assert.doesNotMatch(text, /\bbreak\b|while \(true\)|\bdo \{/);
      } else assert.match(text, /if .+:\n\s+break\n/);
      assert.match(checked.emission.text, c ? /while \(true\) \{/ : /while True:/);
      assert.match(checked.emission.text, /\bcontinue\b/);
      // The phi and its loop-carried source are one printed variable.
      assert.equal(name(source, acc), name(source, next));
      assert.notEqual(name(checked, acc), name(checked, next));
      assert.ok(rules(source).includes('phi_copy_coalescing'));
      if (c)
        for (const rule of ['loop_form', 'loop_test_restatement', 'for_loop', 'loop_entry_test'])
          assert.ok(rules(source).includes(rule), rule);
      assert.deepEqual(rules(checked), []);
      const words = [5, 7, 11, 13, 17];
      for (const n of [0, 1, 2, 5]) {
        const expected = BigInt(words.slice(0, n).reduce((sum, word) => sum + word, 0));
        for (const output of [source, checked]) {
          const observed = execute(
            output.emission,
            new Map([
              [count.id, BigInt(n)],
              [base.id, 0x1000n],
            ]),
            memory(words),
          );
          assert.deepEqual(observed.values, [expected], `${n}`);
          assert.equal(observed.events.length, n);
        }
      }
    });

    test('source parameter copies reuse only noninterfering formal storage', () => {
      for (const keepOriginal of [false, true]) {
        const b = program(`source-formal-copy-${keepOriginal}`),
          entry = b.block('entry', [i64]),
          loop = b.block('loop', [i64]),
          exit = b.block('exit', [i64]);
        const formal = entry.parameters[0]!,
          counter = loop.parameters[0]!;
        entry.jump(loop, [formal]);
        const next = loop.int('sub', counter, loop.constant(i64, 1n));
        loop.branch(
          loop.compare('ne', next, loop.constant(i64, 0n)),
          loop.edge(loop, [next]),
          loop.edge(exit, [keepOriginal ? formal : next]),
        );
        exit.return(exit.parameters);
        const output = emit(b.finish(entry, [i64]), language, 'source', true);
        assert.equal(name(output, counter) === name(output, formal), !keepOriginal);
        for (const initial of [1n, 2n, 5n])
          assert.deepEqual(execute(output.emission, new Map([[formal.id, initial]])).values, [
            keepOriginal ? initial : 0n,
          ]);
      }
    });

    test('an unguarded bottom test stays do/while: its first test is not established', () => {
      const { input, count, base } = countedLoop(false);
      const source = emit(input, language);
      if (c) {
        assert.match(source.emission.text, /\n {2}do \{\n/);
        assert.doesNotMatch(source.emission.text, /\bfor \(/);
      }
      assert.ok(!rules(source).includes('for_loop'));
      const words = [5, 7, 11];
      for (const n of [1, 3]) {
        const observed = execute(
          source.emission,
          new Map([
            [count.id, BigInt(n)],
            [base.id, 0x1000n],
          ]),
          memory(words),
        );
        assert.deepEqual(observed.values, [BigInt(words.slice(0, n).reduce((a, b) => a + b, 0))]);
      }
    });

    test('a top-tested counter loop prints as for; a step that is not x = x ± c keeps while', () => {
      for (const written of [false, true]) {
        const b = program(`source-control-for-${written}`),
          entry = b.block('entry', [i32]),
          head = b.block('head', [i32]),
          body = b.block('body'),
          exit = b.block('exit');
        const limit = entry.parameters[0]!;
        entry.jump(head, [entry.constant(i32, 0n)]);
        const index = head.parameters[0]!;
        head.branch(head.compare('ult', index, limit), head.edge(body), head.edge(exit));
        const address = body.int(
          'add',
          body.constant(i64, 0x1000n),
          body.cast('zero_extend', i64, index),
        );
        body.store(address, body.int('add', body.load(i32, address), index));
        // `written`: the step is (x + 2) + 1 through an intermediate value, not x + c.
        const bumped = written ? body.int('add', index, body.constant(i32, 2n)) : index;
        body.jump(head, [body.int('add', bumped, body.constant(i32, 1n))]);
        exit.return([]);
        const output = emit(b.finish(entry, []), language);
        const text = output.emission.text;
        if (c && !written) {
          assert.match(text, /\n {2}for \(\w+ = 0(x0)?; \(?\w+ < \w+\)?; \w+ = .+\) \{\n/);
          assert.ok(rules(output).includes('for_loop'));
        } else assert.doesNotMatch(text, /\bfor \(/);
        for (const n of [0n, 1n, 3n]) {
          const observed = execute(output.emission, new Map([[limit.id, n]]), memory());
          const touched = written
            ? [0n, 3n].filter((value) => value < n)
            : [0n, 1n, 2n].filter((value) => value < n);
          for (const value of touched)
            assert.equal(observed.memory.get(0x1000n + value), Number(value), `${written}/${n}`);
        }
      }
    });

    test('a phi still read after its successor is defined keeps a separate variable', () => {
      const b = program('source-control-interference'),
        entry = b.block('entry'),
        loop = b.block('loop', [i32, i32]),
        exit = b.block('exit', [i32]);
      entry.jump(loop, [entry.constant(i32, 0n), entry.constant(i32, 0n)]);
      const [x, sum] = loop.parameters as [Value, Value];
      const step = loop.int('add', x, loop.constant(i32, 1n));
      const total = loop.int('add', sum, loop.int('mul', x, loop.constant(i32, 3n)));
      loop.store(loop.constant(i64, 0x1000n), step);
      loop.branch(
        loop.compare('ne', step, loop.constant(i32, 5n)),
        loop.edge(loop, [step, total]),
        loop.edge(exit, [total]),
      );
      exit.return(exit.parameters);
      const output = emit(b.finish(entry, [i32]), language);
      assert.equal(name(output, sum), name(output, total));
      // x is read after step is written: one variable would observe the new value.
      if (name(output, x) === name(output, step)) {
        // Only legal when x's last read precedes step's definition; it does not here.
        assert.fail('interfering phi and successor were coalesced');
      }
      const observed = execute(output.emission, new Map(), memory());
      assert.deepEqual(observed.values, [30n]);
      assert.equal(observed.memory.get(0x1000n), 5);
    });

    test('a top-tested loop prints its test in the loop header', () => {
      const b = program('source-control-while'),
        entry = b.block('entry', [i32]),
        head = b.block('head', [i32, i32]),
        body = b.block('body'),
        exit = b.block('exit', [i32]);
      const limit = entry.parameters[0]!;
      entry.jump(head, [entry.constant(i32, 0n), entry.constant(i32, 0n)]);
      const [index, sum] = head.parameters as [Value, Value];
      head.branch(head.compare('ne', index, limit), head.edge(body), head.edge(exit, [sum]));
      body.store(body.constant(i64, 0x1000n), index);
      body.jump(head, [
        body.int('add', index, body.constant(i32, 1n)),
        body.int('add', sum, index),
      ]);
      exit.return(exit.parameters);
      const output = emit(b.finish(entry, [i32]), language);
      const text = output.emission.text;
      assert.match(text, c ? /\n {2}while \(.+ != .+\) \{\n/ : /\n {2}while .+ != .+:\n/);
      assert.doesNotMatch(text, /while \(true\)|while True|\bbreak\b|\bcontinue\b|\bgoto\b/);
      for (const n of [0n, 1n, 4n]) {
        const observed = execute(output.emission, new Map([[limit.id, n]]), memory());
        assert.deepEqual(observed.values, [(n * (n - 1n)) / 2n]);
        assert.equal(observed.events.length, Number(n));
      }
    });

    test('a labeled edge into a shared return ends in a copy of the return', () => {
      // The inner loop leaves both loops: a goto in the checked view. (Its
      // continue of the outer loop stays a goto: C has no labeled continue.)
      const b = program('source-control-tails'),
        entry = b.block('entry', [i32]),
        outer = b.block('outer', [i32]),
        inner = b.block('inner', [i32, i32]),
        step = b.block('step', [i32, i32]),
        done = b.block('done', [i32]);
      const limit = entry.parameters[0]!;
      entry.jump(outer, [entry.constant(i32, 0n)]);
      const row = outer.parameters[0]!;
      outer.branch(
        outer.compare('eq', row, outer.constant(i32, 3n)),
        outer.edge(done, [row]),
        outer.edge(inner, [row, outer.constant(i32, 0n)]),
      );
      const [i, j] = inner.parameters as [Value, Value];
      inner.store(inner.constant(i64, 0x1000n), inner.int('add', i, j));
      inner.branch(
        inner.compare('eq', inner.int('add', i, j), limit),
        inner.edge(done, [inner.int('add', j, inner.constant(i32, 100n))]),
        inner.edge(step, [i, j]),
      );
      const [si, sj] = step.parameters as [Value, Value];
      step.branch(
        step.compare('eq', sj, step.constant(i32, 1n)),
        step.edge(outer, [step.int('add', si, step.constant(i32, 1n))]),
        step.edge(inner, [si, step.int('add', sj, step.constant(i32, 1n))]),
      );
      done.return(done.parameters);
      const input = b.finish(entry, [i32]);
      const source = emit(input, language),
        checked = emit(input, language, 'checked');
      const gotos = (text: string): number => text.match(/\bgoto\b/g)?.length ?? 0;
      assert.equal(gotos(source.emission.text), gotos(checked.emission.text) - 1);
      assert.ok(rules(source).includes('return_tail_duplication'));
      // Each printed return maps back to the one original return identity.
      const terminator = input.blocks.find((block) => block.id === done.id)!.terminator.id;
      const reference = source.emission.ids.indexOf(terminator);
      const sites = source.emission.mappings.filter(
        (mapping) =>
          mapping.semantic_refs[0] === reference &&
          /\breturn\b/.test(source.emission.text.slice(mapping.start, mapping.end)),
      );
      assert.ok(sites.length >= 2, 'return copies share the original identity');
      for (const [input, value, stored] of [
        [0n, 100n, 0],
        [1n, 101n, 1],
        [2n, 101n, 2],
        [9n, 3n, 3],
      ] as const)
        for (const output of [source, checked]) {
          const observed = execute(output.emission, new Map([[limit.id, input]]), memory());
          assert.deepEqual(observed.values, [value], `${input}`);
          assert.equal(observed.memory.get(0x1000n), stored);
        }
    });
    test('unsigned widening copies share storage but signed extension stays explicit', () => {
      for (const op of ['zero_extend', 'sign_extend'] as const) {
        const b = program(`source-width-copy-${op}`),
          entry = b.block('entry');
        const byte = entry.load(integer(8), entry.constant(i64, 0x1000n));
        const wide = entry.cast(op, i32, byte);
        entry.store(entry.constant(i64, 0x1004n), wide);
        entry.return([wide]);
        const input = b.finish(entry, [i32]),
          source = emit(input, language);
        if (op === 'zero_extend') {
          assert.equal(name(source, byte), name(source, wide), source.emission.text);
          assert.ok(rules(source).includes('phi_copy_coalescing'));
        } else assert.notEqual(name(source, byte), name(source, wide));
        for (const value of [0, 127, 128, 255]) {
          const observed = execute(source.emission, new Map(), memory([value]));
          const expected =
            op === 'zero_extend'
              ? BigInt(value)
              : BigInt.asUintN(32, BigInt.asIntN(8, BigInt(value)));
          assert.deepEqual(observed.values, [expected]);
          assert.equal(observed.events.length, 2);
        }
      }
    });

    test('multi-use values and exit copies retain explicit loop tests', () => {
      for (const effect of [false, true]) {
        const b = program(`source-chain-${effect}`);
        const entry = b.block('entry', [i32]),
          head = b.block('head', [i32]);
        const second = b.block('second'),
          body = b.block('body');
        const exhausted = b.block('exhausted'),
          done = b.block('done', [i32]);
        const count = entry.parameters[0]!;
        entry.jump(head, [count]);
        const left = head.load(i32, head.constant(i64, 0x1000n));
        if (effect) head.store(head.constant(i64, 0x1008n), left);
        head.branch(
          head.compare('eq', left, head.constant(i32, 0n)),
          head.edge(done, [left]),
          head.edge(second),
        );
        const right = second.load(i32, second.constant(i64, 0x1004n));
        second.branch(
          second.compare('ne', left, right),
          second.edge(done, [left]),
          second.edge(body),
        );
        const remaining = head.parameters[0]!;
        body.branch(
          body.compare('ule', remaining, body.constant(i32, 1n)),
          body.edge(exhausted),
          body.edge(head, [body.int('sub', remaining, body.constant(i32, 1n))]),
        );
        exhausted.return([exhausted.constant(i32, 99n)]);
        done.return(done.parameters);
        const input = b.finish(entry, [i32]),
          source = emit(input, language, 'source', true),
          checked = emit(input, language, 'checked', true);
        assert.doesNotMatch(source.emission.text, /while \(.+ && .+\)/);
        for (const [left, right, n, result, loads] of [
          [0, 7, 2, 0, 1],
          [5, 7, 2, 5, 2],
          [5, 5, 2, 99, 4],
        ]) {
          for (const output of [source, checked]) {
            const observed = execute(
              output.emission,
              new Map([[count.id, BigInt(n!)]]),
              memory([left!, right!]),
            );
            assert.deepEqual(observed.values, [BigInt(result!)]);
            assert.equal(observed.events.length, loads! + (effect ? (loads === 4 ? 2 : 1) : 0));
          }
        }
      }
    });
  });
