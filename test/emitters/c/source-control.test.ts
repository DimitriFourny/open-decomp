import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  createOperationContext,
  DEFAULT_ANALYSIS_OPTIONS,
  entityIdentity,
} from '../../../src/core/index.js';
import {
  IRBuilder,
  integer,
  type BlockBuilder,
  type SSAForm,
  type Value,
} from '../../../src/ir/index.js';
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

    test('a bottom test after an inner branch is a do/while; x >> c range tests restate to x != 0', () => {
      for (const [op, bound, restated] of [
        ['lshr', 1n, true],
        ['ashr', 1n, true],
        ['lshr', 2n, false],
      ] as const) {
        const b = program(`source-control-shift-${op}-${bound}`),
          entry = b.block('entry', [i32]),
          head = b.block('head', [i32, i32]),
          odd = b.block('odd'),
          even = b.block('even'),
          latch = b.block('latch', [i32]),
          exit = b.block('exit', [i32]);
        const n = entry.parameters[0]!;
        entry.jump(head, [n, entry.constant(i32, 0n)]);
        const [x, acc] = head.parameters as [Value, Value];
        head.branch(
          head.compare('ne', head.int('and', x, head.constant(i32, 1n)), head.constant(i32, 0n)),
          head.edge(odd),
          head.edge(even),
        );
        odd.store(odd.constant(i64, 0x1000n), x);
        odd.jump(latch, [odd.int('add', acc, odd.constant(i32, 3n))]);
        even.jump(latch, [even.int('add', acc, even.constant(i32, 1n))]);
        const sum = latch.parameters[0]!;
        // Exit once x <= bound (unsigned); otherwise repeat with x >> 1.
        latch.branch(
          latch.compare('ule', x, latch.constant(i32, bound)),
          latch.edge(exit, [sum]),
          latch.edge(head, [latch.int(op, x, latch.constant(i32, 1n)), sum]),
        );
        exit.return(exit.parameters);
        const output = emit(b.finish(entry, [i32]), language);
        const text = output.emission.text;
        if (c && restated) {
          assert.match(text, /\n {2}do \{\n[^]*\n {2}\} while \(\(?\w+ != 0(x0)?\)?\);\n/);
          assert.doesNotMatch(text, /while \(true\)|\bbreak\b/);
        } else assert.match(text, c ? /while \(true\) \{/ : /while True:/);
        assert.equal(rules(output).includes('loop_test_restatement'), c && restated);
        for (const start of [0n, 1n, 2n, 6n, 13n]) {
          let value = start,
            expected = 0n;
          for (;;) {
            expected += value & 1n ? 3n : 1n;
            if (value <= bound) break;
            value >>= 1n;
          }
          const observed = execute(output.emission, new Map([[n.id, start]]), memory());
          assert.deepEqual(observed.values, [expected], `${op}/${bound}/${start}`);
        }
      }
    });

    test('a loop exit edge with copies prints them after the loop only when it is the sole exit', () => {
      for (const second of [false, true]) {
        const b = program(`source-control-exit-copies-${second}`),
          entry = b.block('entry', [i32, i64]),
          loop = b.block('loop', [i64, i32, i64]),
          more = b.block('more'),
          exit = b.block('exit', [i32]);
        const [count, base] = entry.parameters as [Value, Value];
        entry.jump(loop, [base, count, entry.constant(i64, 0n)]);
        const [pointer, remaining, acc] = loop.parameters as [Value, Value, Value];
        const word = loop.load(i32, pointer);
        const next = loop.int('add', acc, loop.cast('zero_extend', i64, word));
        // `second`: a zero word leaves the loop early, a second edge to its continuation.
        if (second)
          loop.branch(
            loop.compare('eq', word, loop.constant(i32, 0n)),
            loop.edge(exit, [loop.constant(i32, 7n)]),
            loop.edge(more),
          );
        else loop.jump(more);
        more.branch(
          more.compare('ne', remaining, more.constant(i32, 1n)),
          more.edge(loop, [
            more.int('add', pointer, more.constant(i64, 4n)),
            more.int('sub', remaining, more.constant(i32, 1n)),
            next,
          ]),
          more.edge(exit, [more.cast('truncate', i32, next)]),
        );
        exit.return(exit.parameters);
        const output = emit(b.finish(entry, [i32]), language);
        const text = output.emission.text;
        assert.equal(rules(output).includes('loop_exit_copies'), c && !second);
        if (c && !second) {
          // The exit copy runs once, after the loop's test fails.
          assert.match(text, /\n {2}\} while \(\(?\w+ != 0(x0)?\)?\);\n {2}\w+ = .+;\n {2}return /);
          assert.doesNotMatch(text, /while \(true\)|\bbreak\b/);
        } else assert.match(text, c ? /while \(true\) \{/ : /while True:/);
        for (const words of [[5], [5, 7, 11], [5, 0, 11]]) {
          const expected =
            second && words.includes(0) ? 7n : BigInt(words.reduce((a, b) => a + b, 0));
          const observed = execute(
            output.emission,
            new Map([
              [count.id, BigInt(words.length)],
              [base.id, 0x1000n],
            ]),
            memory(words),
          );
          assert.deepEqual(observed.values, [expected], `${second}/${words.join(',')}`);
        }
      }
    });

    test('a top-tested loop prints its exit copies after the loop', () => {
      const b = program('source-control-while-exit-copies'),
        entry = b.block('entry', [i32]),
        head = b.block('head', [i32, i64]),
        body = b.block('body'),
        exit = b.block('exit', [i32]);
      const limit = entry.parameters[0]!;
      entry.jump(head, [entry.constant(i32, 0n), entry.constant(i64, 0n)]);
      const [index, sum] = head.parameters as [Value, Value];
      head.branch(
        head.compare('ne', index, limit),
        head.edge(body),
        head.edge(exit, [head.cast('truncate', i32, sum)]),
      );
      body.store(body.constant(i64, 0x1000n), index);
      body.jump(head, [
        body.int('add', index, body.constant(i32, 1n)),
        body.int('add', sum, body.cast('zero_extend', i64, index)),
      ]);
      exit.return(exit.parameters);
      const output = emit(b.finish(entry, [i32]), language);
      const text = output.emission.text;
      assert.match(
        text,
        c
          ? /\n {2}while \(.+ != .+\) \{\n[^]*\n {2}\}\n {2}\w+ = .+;\n {2}return /
          : /\n {2}while .+ != .+:\n[^]*\n {2}\w+ = .+\n {2}return /,
      );
      assert.doesNotMatch(text, /while \(true\)|while True|\bbreak\b|\bcontinue\b|\bgoto\b/);
      assert.ok(rules(output).includes('loop_exit_copies'));
      for (const n of [0n, 1n, 4n]) {
        const observed = execute(output.emission, new Map([[limit.id, n]]), memory());
        assert.deepEqual(observed.values, [(n * (n - 1n)) / 2n]);
      }
    });

    test('a do/while is refused when an exit copy reads a repeat copy moved before the test', () => {
      const b = program('source-control-exit-reads-repeat'),
        entry = b.block('entry', [i32, i64]),
        loop = b.block('loop', [i64, i32, i32]),
        exit = b.block('exit', [i32]);
      const [count, base] = entry.parameters as [Value, Value];
      entry.jump(loop, [base, count, entry.constant(i32, 0n)]);
      const [pointer, remaining, acc] = loop.parameters as [Value, Value, Value];
      const next = loop.int('add', acc, loop.load(i32, pointer));
      // The exit copy reads the counter phi, which the repeat edge decrements.
      loop.branch(
        loop.compare(
          'ne',
          loop.int('and', next, loop.constant(i32, 0xffn)),
          loop.constant(i32, 0n),
        ),
        loop.edge(loop, [
          loop.int('add', pointer, loop.constant(i64, 4n)),
          loop.int('sub', remaining, loop.constant(i32, 1n)),
          next,
        ]),
        loop.edge(exit, [loop.int('add', remaining, next)]),
      );
      exit.return(exit.parameters);
      const output = emit(b.finish(entry, [i32]), language);
      assert.match(output.emission.text, c ? /while \(true\) \{/ : /while True:/);
      assert.doesNotMatch(output.emission.text, /\bdo \{/);
      // Memory words are single bytes.
      for (const words of [[0], [1, 0xff], [3, 5, 0xf8]]) {
        const total = words.reduce((a, b) => a + b, 0);
        const observed = execute(
          output.emission,
          new Map([
            [count.id, 10n],
            [base.id, 0x1000n],
          ]),
          memory(words),
        );
        assert.deepEqual(observed.values, [BigInt(10 - words.length + 1 + total)]);
      }
    });

    test('a labeled edge into a shared return ends in a copy of the return', () => {
      // The inner loop leaves both loops: a goto in the checked view. A
      // transfer to the outer header is the inner loop's exact lexical exit.
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
      assert.doesNotMatch(source.emission.text, /\bgoto\b/);
      assert.match(checked.emission.text, /\bgoto\b/);
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

    test('shared loop latches follow their predecessors instead of preceding labeled tests', () => {
      const b = program('source-loop-latch-order'),
        entry = b.block('entry', [i32]),
        head = b.block('head'),
        choose = b.block('choose'),
        adjust = b.block('adjust'),
        test = b.block('test'),
        left = b.block('left'),
        right = b.block('right'),
        latch = b.block('latch'),
        done = b.block('done');
      const count = entry.parameters[0]!;
      entry.store(entry.constant(i64, 0x1000n), count);
      entry.jump(head);
      const remaining = head.load(i32, head.constant(i64, 0x1000n));
      head.branch(
        head.compare('eq', remaining, head.constant(i32, 0n)),
        head.edge(done),
        head.edge(choose),
      );
      choose.branch(
        choose.compare('eq', remaining, choose.constant(i32, 2n)),
        choose.edge(test),
        choose.edge(adjust),
      );
      adjust.store(adjust.constant(i64, 0x1004n), remaining);
      adjust.jump(test);
      test.branch(
        test.compare('ugt', remaining, test.constant(i32, 1n)),
        test.edge(left),
        test.edge(right),
      );
      left.store(left.constant(i64, 0x1008n), left.constant(i32, 11n));
      left.jump(latch);
      right.store(right.constant(i64, 0x1008n), right.constant(i32, 22n));
      right.jump(latch);
      latch.store(
        latch.constant(i64, 0x1000n),
        latch.int('sub', remaining, latch.constant(i32, 1n)),
      );
      latch.jump(head);
      done.return([done.load(i32, done.constant(i64, 0x1008n))]);
      const input = b.finish(entry, [i32]),
        source = emit(input, language),
        checked = emit(input, language, 'checked');
      assert.doesNotMatch(source.emission.text, /\bgoto\b/);
      for (const initial of [0n, 1n, 2n, 5n]) {
        const args = new Map([[count.id, initial]]);
        const actual = execute(source.emission, args, memory());
        const expected = execute(checked.emission, args, memory());
        assert.deepEqual(actual.values, expected.values);
        assert.deepEqual(actual.memory, expected.memory);
        assert.deepEqual(actual.events, expected.events);
      }
    });

    test('jointly owned loop entries and continuations reach a layout fixed point', () => {
      const b = program('source-owned-loop-continuations'),
        entry = b.block('entry', [i32]),
        choose = b.block('choose'),
        large = b.block('large', [i32, i32]),
        after = b.block('after', [i32, i32]),
        small = b.block('small', [i32, i32]),
        done = b.block('done', [i32]);
      const count = entry.parameters[0]!;
      entry.branch(
        entry.compare('eq', count, entry.constant(i32, 0n)),
        entry.edge(done, [entry.constant(i32, 0n)]),
        entry.edge(choose),
      );
      choose.branch(
        choose.compare('ugt', count, choose.constant(i32, 3n)),
        choose.edge(large, [count, choose.constant(i32, 0n)]),
        choose.edge(small, [count, choose.constant(i32, 0n)]),
      );
      const [left, total] = large.parameters as [Value, Value];
      large.store(large.constant(i64, 0x1000n), left);
      const next = large.int('sub', left, large.constant(i32, 1n)),
        sum = large.int('add', total, left);
      large.branch(
        large.compare('ugt', next, large.constant(i32, 3n)),
        large.edge(large, [next, sum]),
        large.edge(after, [next, sum]),
      );
      const [remaining, partial] = after.parameters as [Value, Value];
      after.branch(
        after.compare('eq', remaining, after.constant(i32, 0n)),
        after.edge(done, [partial]),
        after.edge(small, [remaining, partial]),
      );
      const [last, previous] = small.parameters as [Value, Value];
      small.store(small.constant(i64, 0x1004n), last);
      const final = small.int('add', previous, last),
        decremented = small.int('sub', last, small.constant(i32, 1n));
      small.branch(
        small.compare('eq', decremented, small.constant(i32, 0n)),
        small.edge(done, [final]),
        small.edge(small, [decremented, final]),
      );
      done.return(done.parameters);
      const input = b.finish(entry, [i32]),
        source = emit(input, language),
        checked = emit(input, language, 'checked');
      assert.doesNotMatch(source.emission.text, /\bgoto\b/);
      for (const initial of [0n, 1n, 3n, 4n, 7n]) {
        const args = new Map([[count.id, initial]]);
        const actual = execute(source.emission, args, memory());
        const expected = execute(checked.emission, args, memory());
        assert.deepEqual(actual.values, [(initial * (initial + 1n)) / 2n]);
        assert.deepEqual(actual.values, expected.values);
        assert.deepEqual(actual.memory, expected.memory);
        assert.deepEqual(actual.events, expected.events);
        assert.equal(actual.events.length, Number(initial));
      }
    });

    test('nested exits duplicate only small tails, otherwise propagate one exit flag', () => {
      for (const stores of [1, 6]) {
        const b = program(`source-nested-exit-${stores}`),
          entry = b.block('entry', [i32]),
          outer = b.block('outer', [i32]),
          inner = b.block('inner', [i32]),
          step = b.block('step'),
          done = b.block('done', [i32]);
        const stop = entry.parameters[0]!;
        entry.jump(outer, [entry.constant(i32, 0n)]);
        const row = outer.parameters[0]!;
        outer.branch(
          outer.compare('eq', row, outer.constant(i32, 3n)),
          outer.edge(done, [row]),
          outer.edge(inner, [outer.constant(i32, 0n)]),
        );
        const column = inner.parameters[0]!;
        inner.store(inner.constant(i64, 0x1000n), row);
        inner.branch(inner.compare('eq', row, stop), inner.edge(done, [column]), inner.edge(step));
        step.branch(
          step.compare('eq', column, step.constant(i32, 1n)),
          step.edge(outer, [step.int('add', row, step.constant(i32, 1n))]),
          step.edge(inner, [step.int('add', column, step.constant(i32, 1n))]),
        );
        for (let index = 0; index < stores; index++)
          done.store(done.constant(i64, 0x1004n + BigInt(index * 4)), done.parameters[0]!);
        done.return(done.parameters);
        const input = b.finish(entry, [i32]),
          source = emit(input, language),
          checked = emit(input, language, 'checked');
        assert.doesNotMatch(source.emission.text, /\bgoto\b/);
        assert.ok(
          rules(source).includes(
            stores === 1 ? 'return_tail_duplication' : 'multi_level_loop_exit',
          ),
        );
        assert.equal(source.emission.text.includes('loop_exit_'), stores > 4);
        for (const value of [0n, 1n, 2n, 9n]) {
          const args = new Map([[stop.id, value]]);
          const expected = execute(checked.emission, args, memory());
          const actual = execute(source.emission, args, memory());
          assert.deepEqual(actual.values, expected.values);
          assert.deepEqual(actual.events, expected.events);
          assert.deepEqual(actual.memory, expected.memory);
          assert.equal(actual.events.length, (value < 3n ? Number(value) * 2 + 1 : 6) + stores);
        }
        for (const output of [source, checked]) {
          const onlyLoopStore = new Map(
            Array.from({ length: 4 }, (_, index) => [0x1000n + BigInt(index), 0] as const),
          );
          const fault = execute(output.emission, new Map([[stop.id, 0n]]), onlyLoopStore);
          assert.equal(fault.exit, 'fault');
          assert.deepEqual(fault.events, ['store', 'store']);
          assert.equal(fault.memory.size, 4);
        }
      }
    });

    test('switch-in-loop exits propagate before the following ordered effects', () => {
      const b = program('source-switch-loop-exit'),
        entry = b.block('entry', [i32]),
        head = b.block('head', [i32]),
        step = b.block('step'),
        done = b.block('done', [i32]);
      const count = entry.parameters[0]!;
      entry.jump(head, [count]);
      const remaining = head.parameters[0]!;
      head.terminate({
        kind: 'switch',
        value: remaining,
        cases: [
          { bits: 0n, edge: head.edge(done, [head.constant(i32, 77n)]) },
          { bits: 2n, edge: head.edge(done, [head.constant(i32, 88n)]) },
        ],
        otherwise: head.edge(step),
      });
      step.store(step.constant(i64, 0x1000n), remaining);
      step.jump(head, [step.int('sub', remaining, step.constant(i32, 1n))]);
      for (let index = 0; index < 6; index++)
        done.store(done.constant(i64, 0x1004n + BigInt(index * 4)), done.parameters[0]!);
      done.return(done.parameters);
      const input = b.finish(entry, [i32]),
        source = emit(input, language),
        checked = emit(input, language, 'checked');
      assert.doesNotMatch(source.emission.text, /\bgoto\b/);
      assert.equal(rules(source).includes('multi_level_loop_exit'), c);
      for (const initial of [0n, 1n, 2n, 4n]) {
        const args = new Map([[count.id, initial]]);
        const actual = execute(source.emission, args, memory());
        const expected = execute(checked.emission, args, memory());
        assert.deepEqual(actual.values, expected.values);
        assert.deepEqual(actual.memory, expected.memory);
        assert.deepEqual(actual.events, expected.events);
      }
    });

    test('two-entry cyclic regions retain real labeled transfers', () => {
      const b = program('source-irreducible'),
        entry = b.block('entry', [integer(1), i32]),
        left = b.block('left', [i32]),
        right = b.block('right', [i32]),
        done = b.block('done', [i32]);
      const [choose, count] = entry.parameters as [Value, Value];
      entry.branch(choose, entry.edge(left, [count]), entry.edge(right, [count]));
      for (const [block, next, marker] of [
        [left, right, 11n],
        [right, left, 22n],
      ] as const) {
        block.store(block.constant(i64, 0x1000n), block.constant(i32, marker));
        const remaining = block.int('sub', block.parameters[0]!, block.constant(i32, 1n));
        block.branch(
          block.compare('eq', remaining, block.constant(i32, 0n)),
          block.edge(done, [block.constant(i32, marker)]),
          block.edge(next, [remaining]),
        );
      }
      done.return(done.parameters);
      const input = b.finish(entry, [i32]),
        source = emit(input, language),
        checked = emit(input, language, 'checked');
      assert.match(source.emission.text, /\bgoto\b/);
      assert.ok(!rules(source).includes('multi_level_loop_exit'));
      for (const start of [0n, 1n])
        for (const length of [1n, 2n, 5n]) {
          const args = new Map([
            [choose.id, start],
            [count.id, length],
          ]);
          const actual = execute(source.emission, args, memory());
          const expected = execute(checked.emission, args, memory());
          assert.deepEqual(actual.values, expected.values);
          assert.deepEqual(actual.events, expected.events);
          assert.deepEqual(actual.memory, expected.memory);
        }
    });

    test('removing a duplicated tail home also removes its owned return continuation', () => {
      const b = program('source-control-owned-return-tail'),
        entry = b.block('entry', [i32, i32]),
        head = b.block('head', [i32, i32, i64]),
        add = b.block('add'),
        step = b.block('step'),
        done = b.block('done', [i32]),
        // Separate returns keep every loop exit single: no exit is shared.
        finished = b.block('finished', [i32]),
        overflow = b.block('overflow'),
        zero = b.block('zero');
      const [count, stop] = entry.parameters as [Value, Value];
      entry.branch(
        entry.compare('eq', count, entry.constant(i32, 0n)),
        entry.edge(zero),
        entry.edge(head, [count, entry.constant(i32, 0n), entry.constant(i64, 0x1000n)]),
      );
      zero.return([zero.constant(i32, 0n)]);
      const [remaining, sum, pointer] = head.parameters as [Value, Value, Value];
      const loaded = head.load(i32, pointer);
      head.branch(head.compare('eq', loaded, stop), head.edge(done, [sum]), head.edge(add));
      const next = add.int('add', sum, loaded);
      add.branch(
        add.compare('ugt', next, add.constant(i32, 10n)),
        add.edge(overflow),
        add.edge(step),
      );
      step.branch(
        step.compare('ne', remaining, step.constant(i32, 1n)),
        step.edge(head, [
          step.int('sub', remaining, step.constant(i32, 1n)),
          next,
          step.int('add', pointer, step.constant(i64, 4n)),
        ]),
        step.edge(finished, [next]),
      );
      overflow.jump(done, [overflow.int('xor', next, remaining)]);
      done.return(done.parameters);
      finished.return(finished.parameters);
      const input = b.finish(entry, [i32]),
        source = emit(input, language),
        checked = emit(input, language, 'checked');
      // Each early return has its own reachable edge, with no orphan
      // continuation; the overflow exit breaks to the shared return.
      assert.ok(
        (source.emission.text.match(/\breturn\b/g)?.length ?? 0) <= 4,
        source.emission.text,
      );
      assert.doesNotMatch(source.emission.text, /\n( *)return\b[^\n]*\n\1return\b|\bgoto\b/);
      for (const [n, sentinel, words, value, loads] of [
        [0, 99, [], 0, 0],
        [3, 99, [1, 2, 3], 6, 3],
        [3, 0, [1, 0, 3], 1, 2],
        [2, 99, [8, 5], 12, 2],
        [1, 99, [10], 10, 1],
        [3, 99, [0, 0, 0], 0, 3],
      ] as const) {
        for (const output of [source, checked]) {
          const observed = execute(
            output.emission,
            new Map([
              [count.id, BigInt(n)],
              [stop.id, BigInt(sentinel)],
            ]),
            memory(words),
          );
          assert.deepEqual(observed.values, [BigInt(value)]);
          assert.deepEqual(observed.events, Array<string>(loads).fill('load'));
        }
      }
      for (const output of [source, checked]) {
        const fault = execute(
          output.emission,
          new Map([
            [count.id, 1n],
            [stop.id, 99n],
          ]),
          new Map(),
        );
        assert.equal(fault.exit, 'fault');
        assert.deepEqual(fault.events, ['load']);
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

    /** `for (i < n) { v = a[i]; if (v == stop) break; sum += v; if (sum > 10) return sum ^ i; } return sum;`
     * as compiled: the two loop exits and the overflow path all jump to one return. */
    const multiExit = (name: string, effects = false) => {
      const b = program(name),
        entry = b.block('entry', [i32, i32]),
        loop = b.block('loop', [i64, i64]),
        body = b.block('body'),
        step = b.block('step'),
        over = b.block('over', [i64, i64]);
      const done = effects
        ? [b.block('done-a', [i64]), b.block('done-b', [i64])]
        : [b.block('done', [i64])];
      const [count, stop] = entry.parameters as [Value, Value];
      entry.jump(loop, [entry.constant(i64, 0n), entry.constant(i64, 0n)]);
      const [acc, index] = loop.parameters as [Value, Value];
      loop.branch(
        loop.compare('uge', index, loop.cast('zero_extend', i64, count)),
        loop.edge(done[0]!, [acc]),
        loop.edge(body),
      );
      const element = body.load(
        i32,
        body.int(
          'add',
          body.constant(i64, 0x1000n),
          body.int('mul', index, body.constant(i64, 4n)),
        ),
      );
      body.branch(
        body.compare('eq', element, stop),
        body.edge(done[effects ? 1 : 0]!, [acc]),
        body.edge(step),
      );
      const sum = step.int('add', acc, step.cast('zero_extend', i64, element));
      step.branch(
        step.compare('ugt', sum, step.constant(i64, 10n)),
        step.edge(over, [sum, index]),
        step.edge(loop, [sum, step.int('add', index, step.constant(i64, 1n))]),
      );
      over.jump(done[0]!, [over.int('xor', over.parameters[0]!, over.parameters[1]!)]);
      done.forEach((block, at) => {
        if (effects) block.store(block.constant(i64, 0x1020n), block.constant(i32, BigInt(at + 1)));
        block.return(block.parameters);
      });
      return { input: b.finish(entry, [i64]), count, stop };
    };
    const reference = (words: readonly number[], count: number, stop: number): bigint => {
      let sum = 0n;
      for (let i = 0; i < count; i++) {
        const value = BigInt(words[i] ?? 0);
        if (value === BigInt(stop)) break;
        sum += value;
        if (sum > 10n) return sum ^ BigInt(i);
      }
      return sum;
    };
    const exitInputs: readonly (readonly [number, number, readonly number[]])[] = [
      [0, 9, []],
      [3, 9, [1, 2, 3]],
      [3, 2, [1, 2, 3]],
      [3, 9, [8, 5, 1]],
      [3, 9, [1, 10, 3]],
    ];

    test('loop exits reaching one return share it; the overflow exit moves onto its edge', () => {
      const { input, count, stop } = multiExit('source-exit-merge');
      const source = emit(input, language),
        checked = emit(input, language, 'checked');
      assert.equal(source.emission.text.match(/\breturn\b/g)?.length, 1, source.emission.text);
      assert.doesNotMatch(source.emission.text, /\bgoto\b/);
      for (const [n, limit, words] of exitInputs)
        for (const output of [source, checked]) {
          const observed = execute(
            output.emission,
            new Map([
              [count.id, BigInt(n)],
              [stop.id, BigInt(limit)],
            ]),
            memory(words),
          );
          assert.deepEqual(observed.values, [reference(words, n, limit)], `${n} ${limit}`);
        }
    });

    test('loop exits with different effects before their returns keep both returns', () => {
      const { input, count, stop } = multiExit('source-exit-effects', true);
      const source = emit(input, language);
      assert.ok((source.emission.text.match(/\breturn\b/g)?.length ?? 0) >= 2);
      for (const [n, limit, words] of exitInputs) {
        const observed = execute(
          source.emission,
          new Map([
            [count.id, BigInt(n)],
            [stop.id, BigInt(limit)],
          ]),
          memory(words),
        );
        assert.deepEqual(observed.values, [reference(words, n, limit)], `${n} ${limit}`);
      }
    });

    test('case arms print without braces unless an arm declares', () => {
      const b = program('source-switch-braces'),
        entry = b.block('entry', [i32]),
        first = b.block('first'),
        second = b.block('second'),
        other = b.block('other');
      const selector = entry.parameters[0]!;
      entry.terminate({
        kind: 'switch',
        value: selector,
        cases: [
          { bits: 1n, edge: entry.edge(first) },
          { bits: 2n, edge: entry.edge(second) },
        ],
        otherwise: entry.edge(other),
      });
      for (const [block, marker] of [
        [first, 11n],
        [second, 22n],
        [other, 33n],
      ] as const) {
        block.store(block.constant(i64, 0x1000n), block.constant(i32, marker));
        block.return([block.constant(i32, marker)]);
      }
      const input = b.finish(entry, [i32]),
        source = emit(input, language, 'source', true),
        checked = emit(input, language, 'checked', true);
      const text = source.emission.text;
      if (c) {
        assert.match(text, /case 1:\n\s+\S/);
        assert.match(text, /default:\n\s+\S/);
        assert.doesNotMatch(text, /(?:case \d+|default): \{/);
        // Every opening brace is closed: the switch's and the function's.
        assert.equal(text.match(/\{/g)?.length, text.match(/\}/g)?.length);
        assert.equal(text.match(/\{/g)?.length, 2);
        // The checked view keeps its braced arms.
        assert.match(checked.emission.text, /case 0x1: \{/);
      }
      for (const value of [0n, 1n, 2n, 3n]) {
        const args = new Map([[selector.id, value]]);
        const actual = execute(source.emission, args, memory());
        const expected = execute(checked.emission, args, memory());
        assert.deepEqual(actual.values, expected.values);
        assert.deepEqual(actual.memory, expected.memory);
      }
    });

    test('a case arm holding a loop keeps its braces', () => {
      const b = program('source-switch-loop-braces'),
        entry = b.block('entry', [i32]),
        spin = b.block('spin', [i32]),
        done = b.block('done', [i32]),
        other = b.block('other');
      const selector = entry.parameters[0]!;
      entry.terminate({
        kind: 'switch',
        value: selector,
        cases: [{ bits: 1n, edge: entry.edge(spin, [selector]) }],
        otherwise: entry.edge(other),
      });
      const remaining = spin.parameters[0]!;
      spin.branch(
        spin.compare('eq', remaining, spin.constant(i32, 0n)),
        spin.edge(done, [remaining]),
        spin.edge(spin, [spin.int('sub', remaining, spin.constant(i32, 1n))]),
      );
      done.return(done.parameters);
      other.return([other.constant(i32, 9n)]);
      const text = emit(b.finish(entry, [i32]), language, 'source', true).emission.text;
      if (c) assert.match(text, /case 1: \{/);
    });

    /** Source and checked views agree on every input: values, events, memory. */
    const agree = (
      source: EmissionResult,
      checked: EmissionResult,
      inputs: readonly ReadonlyMap<string, bigint>[],
      words: readonly number[] = [],
    ): void => {
      for (const args of inputs) {
        const actual = execute(source.emission, args, memory(words));
        const expected = execute(checked.emission, args, memory(words));
        assert.deepEqual(actual.values, expected.values, source.emission.text);
        assert.deepEqual(actual.events, expected.events);
        assert.deepEqual(actual.memory, expected.memory);
      }
    };
    /** A continuation too large to copy: six stores of its parameter. */
    const continuation = (block: BlockBuilder): void => {
      for (let index = 0; index < 6; index++)
        block.store(block.constant(i64, 0x1010n + BigInt(index * 4)), block.parameters[0]!);
      block.return(block.parameters);
    };

    test('a shared return between a goto and its target is copied onto every edge', () => {
      const b = program('source-goto-path-tail'),
        entry = b.block('entry', [i32, i32]),
        first = b.block('first'),
        second = b.block('second'),
        fail = b.block('fail', [i32]),
        join = b.block('join', [i32]);
      const [a, d] = entry.parameters as [Value, Value];
      entry.branch(
        entry.compare('eq', a, entry.constant(i32, 0n)),
        entry.edge(join, [d]),
        entry.edge(first),
      );
      first.branch(
        first.compare('eq', a, first.constant(i32, 1n)),
        first.edge(second),
        first.edge(fail, [first.constant(i32, 2n)]),
      );
      second.store(second.constant(i64, 0x1000n), a);
      second.branch(
        second.compare('eq', d, second.constant(i32, 2n)),
        second.edge(join, [a]),
        second.edge(fail, [second.constant(i32, 3n)]),
      );
      fail.store(fail.constant(i64, 0x1004n), fail.parameters[0]!);
      fail.return(fail.parameters);
      continuation(join);
      const input = b.finish(entry, [i32]),
        source = emit(input, language),
        checked = emit(input, language, 'checked');
      assert.doesNotMatch(source.emission.text, /\bgoto\b|while \(0\)|while True/);
      assert.match(checked.emission.text, /\bgoto\b/);
      assert.equal(source.emission.text.match(/\breturn\b/g)?.length, 3, source.emission.text);
      agree(
        source,
        checked,
        [0n, 1n, 5n].flatMap((x) =>
          [2n, 4n].map(
            (y) =>
              new Map([
                [a.id, x],
                [d.id, y],
              ]),
          ),
        ),
      );
    });

    /** Every combination of the given argument values. */
    const grid = (values: readonly Value[], choices: readonly bigint[]): Map<string, bigint>[] =>
      values.reduce<Map<string, bigint>[]>(
        (rows, value) =>
          rows.flatMap((row) => choices.map((bits) => new Map([...row, [value.id, bits]]))),
        [new Map()],
      );
    const choices = [0n, 1n, 2n, 5n];

    test('&& operands leaving for one statement print as if/else', () => {
      const b = program('source-shared-and'),
        entry = b.block('entry', [i32, i32]),
        second = b.block('second'),
        other = b.block('other'),
        join = b.block('join', [i32]);
      const [a, d] = entry.parameters as [Value, Value];
      entry.branch(
        entry.compare('eq', a, entry.constant(i32, 0n)),
        entry.edge(second),
        entry.edge(other),
      );
      second.branch(
        second.compare('eq', d, second.constant(i32, 0n)),
        second.edge(join, [second.constant(i32, 7n)]),
        second.edge(other),
      );
      other.store(other.constant(i64, 0x1000n), a);
      other.jump(join, [d]);
      continuation(join);
      const input = b.finish(entry, [i32]),
        source = emit(input, language),
        checked = emit(input, language, 'checked'),
        text = source.emission.text;
      assert.doesNotMatch(text, /\bgoto\b|\blabel\b|while \(0\)|while True/);
      assert.match(checked.emission.text, /\bgoto\b/);
      assert.ok(rules(source).includes('shared_condition_arm'), text);
      assert.ok(!rules(checked).includes('shared_condition_arm'));
      assert.match(
        text,
        c ? /if \(.+ && .+\) \{\n[^]*\} else \{\n/ : /if .+ and .+:\n[^]*\n {2}else:\n/,
      );
      agree(source, checked, grid([a, d], choices));
    });

    test('|| operands entering one statement print as if/else', () => {
      const b = program('source-shared-or'),
        entry = b.block('entry', [i32, i32]),
        second = b.block('second'),
        then = b.block('then'),
        otherwise = b.block('otherwise'),
        join = b.block('join', [i32]);
      const [a, d] = entry.parameters as [Value, Value];
      entry.branch(
        entry.compare('eq', a, entry.constant(i32, 0n)),
        entry.edge(then),
        entry.edge(second),
      );
      second.branch(
        second.compare('eq', d, second.constant(i32, 0n)),
        second.edge(then),
        second.edge(otherwise),
      );
      then.store(then.constant(i64, 0x1000n), a);
      then.jump(join, [a]);
      otherwise.store(otherwise.constant(i64, 0x1004n), d);
      otherwise.jump(join, [d]);
      continuation(join);
      const input = b.finish(entry, [i32]),
        source = emit(input, language),
        checked = emit(input, language, 'checked'),
        text = source.emission.text;
      assert.doesNotMatch(text, /\bgoto\b|\blabel\b|while \(0\)|while True/);
      assert.ok(rules(source).includes('shared_condition_arm'), text);
      assert.match(
        text,
        c ? /if \(.+ \|\| .+\) \{\n[^]*\} else \{\n/ : /if .+ or .+:\n[^]*\n {2}else:\n/,
      );
      agree(source, checked, grid([a, d], choices));
    });

    test('a shared arm may hold another shared-arm condition', () => {
      const b = program('source-shared-nested'),
        entry = b.block('entry', [i32, i32, i32]),
        s2 = b.block('s2'),
        f1 = b.block('f1'),
        x = b.block('x'),
        s3 = b.block('s3'),
        f2 = b.block('f2'),
        y = b.block('y'),
        join = b.block('join', [i32]);
      const [a, d, e] = entry.parameters as [Value, Value, Value];
      entry.branch(entry.compare('eq', a, entry.constant(i32, 0n)), entry.edge(s2), entry.edge(x));
      s2.branch(s2.compare('eq', d, s2.constant(i32, 0n)), s2.edge(f1), s2.edge(x));
      f1.store(f1.constant(i64, 0x1000n), a);
      f1.jump(join, [a]);
      x.branch(x.compare('eq', e, x.constant(i32, 0n)), x.edge(s3), x.edge(y));
      s3.branch(s3.compare('eq', a, s3.constant(i32, 1n)), s3.edge(f2), s3.edge(y));
      f2.store(f2.constant(i64, 0x1004n), d);
      f2.jump(join, [d]);
      y.store(y.constant(i64, 0x1008n), e);
      y.jump(join, [e]);
      continuation(join);
      const input = b.finish(entry, [i32]),
        source = emit(input, language),
        checked = emit(input, language, 'checked'),
        text = source.emission.text;
      assert.doesNotMatch(text, /\bgoto\b|\blabel\b|while \(0\)|while True/);
      assert.equal(text.match(c ? /\} else \{/g : /\belse:/g)?.length, 2, text);
      agree(source, checked, grid([a, d, e], choices));
    });

    test('a shared else arm may end in a return', () => {
      const b = program('source-shared-return'),
        entry = b.block('entry', [i32, i32, i32]),
        s2 = b.block('s2'),
        f = b.block('f'),
        x = b.block('x'),
        early = b.block('early', [i32]),
        join = b.block('join', [i32]);
      const [a, d, e] = entry.parameters as [Value, Value, Value];
      entry.branch(entry.compare('eq', a, entry.constant(i32, 0n)), entry.edge(s2), entry.edge(x));
      s2.branch(s2.compare('eq', d, s2.constant(i32, 0n)), s2.edge(f), s2.edge(x));
      f.store(f.constant(i64, 0x1000n), a);
      f.jump(join, [d]);
      x.branch(x.compare('eq', e, x.constant(i32, 0n)), x.edge(early, [a]), x.edge(join, [e]));
      continuation(early);
      continuation(join);
      const input = b.finish(entry, [i32]),
        source = emit(input, language),
        checked = emit(input, language, 'checked'),
        text = source.emission.text;
      assert.doesNotMatch(text, /\bgoto\b|\blabel\b|while \(0\)|while True/);
      assert.ok(rules(source).includes('shared_condition_arm'), text);
      assert.match(text, c ? /\} else \{\n(?:.*\n)*? +return\b/ : /\belse:\n(?:.*\n)*? +return\b/);
      agree(source, checked, grid([a, d, e], choices));
    });

    test('a shared-arm rewrite keeps the returned constants of the tail copies around it', () => {
      // `early` is a small return tail entered with the constant 7 by two
      // edges, so the source view copies it into both arms and each copy
      // returns 7 directly (no carrier assignment). Rewriting the later
      // short-circuit test as if/else rebuilds the regions on its path and
      // must keep those copies, or their returns lose the constant.
      const b = program('source-shared-return-constant'),
        entry = b.block('entry', [i32, i32, i32, i32]),
        h = b.block('h'),
        k = b.block('k'),
        s2 = b.block('s2'),
        f = b.block('f'),
        x = b.block('x'),
        early = b.block('early', [i32]),
        join = b.block('join', [i32]);
      const [a, d, e, g] = entry.parameters as [Value, Value, Value, Value];
      entry.branch(
        entry.compare('eq', g, entry.constant(i32, 0n)),
        entry.edge(early, [entry.constant(i32, 7n)]),
        entry.edge(h),
      );
      h.branch(
        h.compare('eq', e, h.constant(i32, 1n)),
        h.edge(early, [h.constant(i32, 7n)]),
        h.edge(k),
      );
      k.branch(k.compare('eq', a, k.constant(i32, 0n)), k.edge(s2), k.edge(x));
      s2.branch(s2.compare('eq', d, s2.constant(i32, 0n)), s2.edge(f), s2.edge(x));
      f.store(f.constant(i64, 0x1000n), a);
      f.jump(join, [d]);
      x.store(x.constant(i64, 0x1004n), e);
      x.jump(join, [e]);
      early.return(early.parameters);
      continuation(join);
      const input = b.finish(entry, [i32]),
        source = emit(input, language, 'source', true),
        checked = emit(input, language, 'checked', true),
        text = source.emission.text;
      assert.ok(rules(source).includes('shared_condition_arm'), text);
      assert.ok(rules(source).includes('return_constant'), text);
      agree(source, checked, grid([a, d, e, g], choices));
    });

    test('operands leaving for different statements keep no shared arm', () => {
      const b = program('source-shared-diverge'),
        entry = b.block('entry', [i32, i32]),
        second = b.block('second'),
        first = b.block('first'),
        other = b.block('other'),
        join = b.block('join', [i32]);
      const [a, d] = entry.parameters as [Value, Value];
      entry.branch(
        entry.compare('eq', a, entry.constant(i32, 0n)),
        entry.edge(second),
        entry.edge(first),
      );
      second.branch(
        second.compare('eq', d, second.constant(i32, 0n)),
        second.edge(join, [second.constant(i32, 7n)]),
        second.edge(other),
      );
      first.store(first.constant(i64, 0x1000n), a);
      first.jump(join, [a]);
      other.store(other.constant(i64, 0x1004n), d);
      other.jump(join, [d]);
      continuation(join);
      const input = b.finish(entry, [i32]),
        source = emit(input, language),
        checked = emit(input, language, 'checked');
      assert.ok(!rules(source).includes('shared_condition_arm'), source.emission.text);
      agree(source, checked, grid([a, d], choices));
    });

    test('a goto past code an operand prints as a goto to its label, never a run-once block', () => {
      const b = program('source-forward-goto'),
        entry = b.block('entry', [i32, i32]),
        second = b.block('second'),
        other = b.block('other'),
        join = b.block('join', [i32]);
      const [a, d] = entry.parameters as [Value, Value];
      entry.branch(
        entry.compare('eq', a, entry.constant(i32, 0n)),
        entry.edge(second),
        entry.edge(other),
      );
      // A printed statement before the second test: no shared-arm operand.
      second.store(second.constant(i64, 0x1008n), d);
      second.branch(
        second.compare('eq', d, second.constant(i32, 0n)),
        second.edge(join, [second.constant(i32, 7n)]),
        second.edge(other),
      );
      other.store(other.constant(i64, 0x1000n), a);
      other.jump(join, [d]);
      continuation(join);
      const input = b.finish(entry, [i32]),
        source = emit(input, language),
        checked = emit(input, language, 'checked'),
        text = source.emission.text;
      assert.match(text, /\bgoto\b/, text);
      assert.match(text, c ? /^\s*\w+:;$/m : /^\s*label \w+:$/m, text);
      assert.doesNotMatch(text, /while \(0\)|while True/);
      assert.ok(!rules(source).includes('shared_condition_arm'));
      agree(source, checked, grid([a, d], choices));
    });

    test('a loop whose two exits each have one edge follows the exit that cannot move', () => {
      const b = program('source-exit-tie'),
        entry = b.block('entry', [i32]),
        head = b.block('head', [i32, i64]),
        step = b.block('step'),
        missing = b.block('missing'),
        found = b.block('found', [i32]);
      const count = entry.parameters[0]!;
      entry.jump(head, [count, entry.constant(i64, 0x1000n)]);
      const [remaining, pointer] = head.parameters as [Value, Value];
      const loaded = head.load(i32, pointer);
      head.branch(
        head.compare('eq', loaded, head.constant(i32, 0n)),
        head.edge(found, [remaining]),
        head.edge(step),
      );
      step.branch(
        step.compare('eq', remaining, step.constant(i32, 1n)),
        step.edge(missing),
        step.edge(head, [
          step.int('sub', remaining, step.constant(i32, 1n)),
          step.int('add', pointer, step.constant(i64, 4n)),
        ]),
      );
      missing.return([missing.constant(i32, 12n)]);
      continuation(found);
      const input = b.finish(entry, [i32]),
        source = emit(input, language),
        checked = emit(input, language, 'checked');
      assert.doesNotMatch(source.emission.text, /\bgoto\b/);
      agree(
        source,
        checked,
        [1n, 2n, 3n].map((n) => new Map([[count.id, n]])),
        [5, 0, 7],
      );
    });
  });
