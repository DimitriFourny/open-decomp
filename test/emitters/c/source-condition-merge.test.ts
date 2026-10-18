import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { entityIdentity } from '../../../src/core/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { floating, IRBuilder, integer, type SSAForm, type Value } from '../../../src/ir/index.js';
import type { EmissionResult } from '../../../src/emitters/model.js';
import { image, provenance, slice } from '../../ir/support.js';
import { unknownClobbers } from '../../../src/lifters/arm64/semantics.js';
import { emit, execute } from './support.js';

const i8 = integer(8),
  i32 = integer(32),
  i64 = integer(64),
  f64 = floating(64);
const program = (name: string): IRBuilder<'ssa'> =>
  new IRBuilder(slice, entityIdentity(slice, 'function', name), provenance, 'ssa');
const source = { abi: new DarwinArm64Abi(), callees: [], addresses: [] };
const named = (output: EmissionResult, value: Value): boolean =>
  output.identifiers.some((row) => row.entity_id === value.id);
const rules = (output: EmissionResult): string[] =>
  (output.emission.local_validation ?? []).flatMap((record) => (record.rule ? [record.rule] : []));
/** IEEE binary64 inputs: +0, -0, 1, -1, the smallest subnormal, +inf and a quiet NaN. */
const DOUBLES = [
  0n,
  0x8000000000000000n,
  0x3ff0000000000000n,
  0xbff0000000000000n,
  1n,
  0x7ff0000000000000n,
  0x7ff8000000000001n,
];
const asDouble = (bits: bigint): number => new Float64Array(new BigUint64Array([bits]).buffer)[0]!;

for (const language of ['c-like', 'python-like'] as const)
  describe(`source condition merge ${language}`, () => {
    const render = (input: SSAForm, view: 'source' | 'checked' = 'source'): EmissionResult =>
      emit(input, { source }, language, view);

    test('nested FP tests `!(x<0||x>0)` then `!isunordered(x,0)` merge into exactly `x == 0`, NaN included', () => {
      const b = program('merge-fp-zero'),
        entry = b.block('entry', [i64]),
        inner = b.block('inner'),
        hit = b.block('hit'),
        done = b.block('done');
      const x = entry.cast('bitcast', f64, entry.parameters[0]!);
      const zero = entry.cast('bitcast', f64, entry.constant(i64, 0n));
      const either = entry.int(
        'or',
        entry.fpCompare('lt', x, zero),
        entry.fpCompare('gt', x, zero),
      );
      // The PF test is computed with the compare, before the first branch.
      const ordered = entry.unary('not', entry.fpCompare('unordered', x, zero));
      entry.branch(entry.unary('not', either), entry.edge(inner), entry.edge(done));
      inner.branch(ordered, inner.edge(hit), inner.edge(done));
      hit.store(hit.constant(i64, 0x2000n), hit.constant(i8, 1n));
      hit.jump(done);
      done.return([done.constant(i32, 0n)]);
      const input = b.finish(entry, [i32]),
        output = render(input);
      const text = output.emission.text;
      assert.match(text, /if \(?\w+ == 0(?:\.0)?\)? ?\{?:?/, text);
      assert.doesNotMatch(text, /isunordered|\bnot \w+ < |!\(\w+ < /, text);
      assert.ok(rules(output).includes('nested_condition_merge'), text);
      assert.ok(rules(output).includes('merged_condition_flags'), text);
      const parameter = input.blocks[0]!.parameters[0]!;
      for (const bits of DOUBLES) {
        const observed = execute(output.emission, new Map([[parameter.id, bits]]));
        const checked = execute(render(input, 'checked').emission, new Map([[parameter.id, bits]]));
        assert.deepEqual(observed.events, checked.events, `${bits.toString(16)}\n${text}`);
        assert.deepEqual(observed.events, asDouble(bits) === 0 ? ['store'] : []);
      }
    });

    test('nested integer tests merge into one short-circuit conjunction; an else or an intervening statement refuses', () => {
      for (const shape of ['merge', 'between', 'else'] as const) {
        const b = program(`merge-integer-${shape}`),
          entry = b.block('entry', [i32, i32]),
          inner = b.block('inner'),
          hit = b.block('hit'),
          other = shape === 'else' ? b.block('other') : undefined,
          done = b.block('done');
        const [a, c] = entry.parameters as [Value, Value];
        entry.branch(
          entry.compare('ugt', a, entry.constant(i32, 5n)),
          entry.edge(inner),
          entry.edge(done),
        );
        if (shape === 'between') inner.store(inner.constant(i64, 0x2004n), inner.constant(i8, 9n));
        inner.branch(
          inner.compare('ult', c, inner.constant(i32, 9n)),
          inner.edge(hit),
          inner.edge(other ?? done),
        );
        hit.store(hit.constant(i64, 0x2000n), hit.constant(i8, 1n));
        hit.jump(done);
        other?.store(other.constant(i64, 0x2008n), other.constant(i8, 2n));
        other?.jump(done);
        // A shared tail too large to duplicate keeps the arms empty.
        for (let index = 0n; index < 5n; index++)
          done.store(done.constant(i64, 0x2010n + index), done.constant(i8, index));
        done.return([done.constant(i32, 0n)]);
        const input = b.finish(entry, [i32]),
          output = render(input);
        const text = output.emission.text;
        assert.equal(rules(output).includes('nested_condition_merge'), shape === 'merge', text);
        if (shape === 'merge') assert.match(text, language === 'c-like' ? / && / : / and /, text);
        for (const [x, y] of [
          [0n, 0n],
          [6n, 3n],
          [6n, 20n],
          [0xffffffffn, 0n],
        ] as const) {
          const inputs = new Map([
            [a.id, x],
            [c.id, y],
          ]);
          const observed = execute(output.emission, inputs);
          const checked = execute(render(input, 'checked').emission, inputs);
          assert.deepEqual(observed.events, checked.events, text);
          assert.deepEqual(observed.memory, checked.memory, text);
        }
      }
    });

    test('FP arithmetic expands across guard-free paths but never across a call', () => {
      for (const call of [false, true]) {
        const b = program(`fp-inline-${call}`),
          entry = b.block('entry', [i64, i64]),
          next = b.block('next');
        const [p, q] = entry.parameters as [Value, Value];
        const product = entry.fp(
          'mul',
          entry.cast('bitcast', f64, p),
          entry.cast('bitcast', f64, q),
        );
        entry.jump(next);
        if (call)
          next.call(
            { kind: 'direct', address: { image_id: image, space: 'va', value: 0x4000n } },
            [],
            [],
            unknownClobbers,
          );
        next.return([next.cast('bitcast', i64, product)]);
        const input = b.finish(entry, [i64]),
          output = render(input);
        assert.equal(named(output, product), call, output.emission.text);
        if (!call) {
          const inputs = new Map([
            [p.id, 0x4000000000000000n],
            [q.id, 0x4008000000000000n],
          ]);
          assert.deepEqual(execute(output.emission, inputs).values, [0x4018000000000000n]);
        }
      }
    });

    test('a load never crosses a possibly aliasing store, even into a condition', () => {
      const b = program('merge-load-alias'),
        entry = b.block('entry', [i64]),
        hit = b.block('hit'),
        done = b.block('done');
      const pointer = entry.parameters[0]!;
      const loaded = entry.load(i8, entry.constant(i64, 0x1000n));
      entry.store(pointer, entry.constant(i8, 0n));
      entry.branch(
        entry.compare('eq', loaded, entry.constant(i8, 3n)),
        entry.edge(hit),
        entry.edge(done),
      );
      hit.store(hit.constant(i64, 0x2000n), hit.constant(i8, 1n));
      hit.jump(done);
      done.return([done.constant(i32, 0n)]);
      const input = b.finish(entry, [i32]),
        output = render(input);
      assert.ok(named(output, loaded), output.emission.text);
      for (const target of [0x1000n, 0x3000n]) {
        const memory = (): Map<bigint, number> =>
          new Map([
            [0x1000n, 3],
            [0x3000n, 0],
          ]);
        const inputs = new Map([[pointer.id, target]]);
        const observed = execute(output.emission, inputs, memory());
        const checked = execute(render(input, 'checked').emission, inputs, memory());
        assert.deepEqual(observed.events, checked.events);
        assert.deepEqual(observed.memory, checked.memory);
        assert.deepEqual(observed.events, ['load', 'store', 'store']);
      }
    });
  });
