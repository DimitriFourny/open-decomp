import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, entityIdentity } from '../../src/core/index.js';
import { mapExpression } from '../../src/analysis/effects/index.js';
import { IRBuilder, integer, type Expression, type Value } from '../../src/ir/index.js';
import { normalizeSourceExpressions } from '../../src/reconstruction/source-expressions.js';
import { LocalValidationSession } from '../../src/reconstruction/local-validation.js';
import { provenance, slice } from '../ir/support.js';
import { emit, execute } from '../emitters/c/support.js';

for (const kind of ['concat', 'insert'] as const)
  for (const order of ['reader-first', 'packing-first', 'late-reader'] as const)
    test(`packed ${kind}: ${order} exact slice excludes unrelated unknown bits`, () => {
      const values = new Map<string, Value>(),
        expressions = new Map<string, Expression>(),
        owners = new Map<string, string>();
      const make: Parameters<typeof normalizeSourceExpressions>[3] = (
        key,
        type,
        block,
        expression,
      ) => {
        const id = entityIdentity(slice, 'value', ['packed-slices', kind, order, key]);
        const previous = values.get(id);
        if (previous) return previous;
        const value = { id, type };
        values.set(id, value);
        owners.set(id, block);
        if (expression) expressions.set(id, expression);
        return value;
      };
      const input = make('input', integer(32), 'entry');
      const other = make('other', integer(32), 'entry');
      const unknown = make('unknown', integer(64), 'entry', {
        kind: 'indeterminate',
        state: 'unknown',
        reason: 'unestablished upper carrier',
      });
      const high = make('high', integer(32), 'entry', {
        kind: 'extract',
        value: unknown,
        offset: 32,
      });
      const packed = make('packed', integer(64), 'entry');
      const packing = (value: Value): Expression =>
        kind === 'concat'
          ? { kind: 'concat', values: [value, high] }
          : { kind: 'insert', base: unknown, value, offset: 0 };
      const extraction = (): Expression => ({ kind: 'extract', value: packed, offset: 0 });
      const root = make('root', integer(32), 'entry');
      if (order === 'reader-first') expressions.set(root.id, extraction());
      expressions.set(packed.id, packing(input));
      if (order === 'packing-first') expressions.set(root.id, extraction());
      const context = createOperationContext(),
        validation = new LocalValidationSession(context);
      const normalization = normalizeSourceExpressions(
        values,
        expressions,
        owners,
        make,
        context,
        validation,
      );
      if (order === 'late-reader') {
        expressions.set(root.id, extraction());
        normalization.changed(root.id);
        normalization.run();
      }
      assert.equal(
        expressions.get(packed.id)?.kind,
        'integer',
        'full-width masked presentation is retained',
      );
      assert.ok(
        validation.records.some(
          (record) => record.rule === 'register_cell_recombination' && record.subject === packed.id,
        ),
      );
      assert.ok(validation.records.every((record) => record.status !== 'rejected'));
      const check = (result: Value, expected: bigint) => {
        const b = new IRBuilder(
          slice,
          entityIdentity(slice, 'function', ['packed-slices', kind, order, result.id]),
          provenance,
          'ssa',
        );
        const block = b.block('entry', [integer(32), integer(32)]);
        const copied = new Map([
          [input.id, block.parameters[0]!],
          [other.id, block.parameters[1]!],
        ]);
        const copy = (value: Value): Value => {
          const previous = copied.get(value.id);
          if (previous) return previous;
          const result = block.assign(value.type, mapExpression(expressions.get(value.id)!, copy));
          copied.set(value.id, result);
          return result;
        };
        block.return([copy(result)]);
        const ir = b.finish(block, [result.type]);
        for (const language of ['c-like', 'python-like'] as const) {
          const { emission } = emit(ir, {}, language);
          assert.doesNotMatch(emission.text, /unknown_value/);
          const observed = execute(
            emission,
            new Map([
              [block.parameters[0]!.id, 0x12345678n],
              [block.parameters[1]!.id, 0x98765432n],
            ]),
          );
          assert.equal(observed.exit, 'machine_return');
          assert.deepEqual(observed.values, [expected]);
          assert.deepEqual(observed.events, []);
        }
      };
      check(root, 0x12345678n);
      // A later external replacement must not reuse the old packed structure.
      expressions.set(packed.id, packing(other));
      normalization.changed(packed.id);
      normalization.run();
      const later = make('later', integer(32), 'entry', extraction());
      normalization.changed(later.id);
      normalization.run();
      check(later, 0x98765432n);
    });
