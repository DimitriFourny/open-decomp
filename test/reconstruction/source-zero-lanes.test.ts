import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, entityIdentity } from '../../src/core/index.js';
import { mapExpression } from '../../src/analysis/effects/index.js';
import { IRBuilder, integer, type Expression, type Value } from '../../src/ir/index.js';
import { normalizeSourceExpressions } from '../../src/reconstruction/source-expressions.js';
import { LocalValidationSession } from '../../src/reconstruction/local-validation.js';
import { provenance, slice } from '../ir/support.js';
import { emit, execute } from '../emitters/c/support.js';

for (const exhausted of [false, true]) {
  for (const scenario of [
    'concat-zero',
    'concat-zeros',
    'insert-low',
    'insert-high-zero',
    'insert-middle-zero',
    'or-zero',
    'zero-or',
    'shift-zero',
    'shifted-zero',
    'all-zero',
    'unknown-zero',
    'unknown-shift',
    'nonstructural',
    'capacity',
    'checked',
  ] as const) {
    test(`source zero lanes: ${scenario}, BDD ${exhausted ? 'exhausted' : 'available'}`, () => {
      const values = new Map<string, Value>(),
        expressions = new Map<string, Expression>(),
        owners = new Map<string, string>();
      const make: Parameters<typeof normalizeSourceExpressions>[3] = (
        key,
        type,
        block,
        expression,
      ) => {
        const id = entityIdentity(slice, 'value', ['zero-lanes', scenario, key]);
        const previous = values.get(id);
        if (previous) return previous;
        const value = { id, type };
        values.set(id, value);
        owners.set(id, block);
        if (expression) expressions.set(id, expression);
        return value;
      };
      const add = (key: string, width: number, expression: Expression) =>
        make(key, integer(width), 'entry', expression);
      const x = make('x', integer(64), 'entry');
      const low = add('low', 32, { kind: 'extract', value: x, offset: 0 });
      const zero = add('zero', 32, { kind: 'constant', bits: 0n });
      const wideZero = add('wide-zero', 64, { kind: 'cast', op: 'zero_extend', value: zero });
      let root: Value;
      let expected = (a: bigint) => a & 0xffffffffn;
      switch (scenario) {
        case 'concat-zero':
        case 'capacity':
        case 'checked':
          root = add('root', 64, { kind: 'concat', values: [low, zero] });
          break;
        case 'concat-zeros': {
          const byteZero = add('byte-zero', 8, { kind: 'constant', bits: 0n });
          root = add('root', 64, {
            kind: 'concat',
            values: [low, byteZero, byteZero, byteZero, byteZero],
          });
          break;
        }
        case 'insert-low':
          root = add('root', 64, { kind: 'insert', base: wideZero, value: low, offset: 0 });
          break;
        case 'insert-high-zero':
          root = add('root', 64, { kind: 'insert', base: x, value: zero, offset: 32 });
          break;
        case 'insert-middle-zero': {
          const byteZero = add('byte-zero', 8, { kind: 'constant', bits: 0n });
          root = add('root', 64, { kind: 'insert', base: x, value: byteZero, offset: 8 });
          expected = (a) => a & ~0xff00n;
          break;
        }
        case 'or-zero':
        case 'zero-or':
        case 'shift-zero': {
          // Noncontiguous retained lanes must preserve the operand itself,
          // rather than requiring its entire definition to be one slice.
          const masked = add('masked', 64, {
            kind: 'integer',
            op: 'and',
            left: x,
            right: add('mask', 64, { kind: 'constant', bits: 0xff00ff00ff00ff00n }),
          });
          root = add('root', 64, {
            kind: 'integer',
            op: scenario === 'shift-zero' ? 'shl' : 'or',
            left: scenario === 'zero-or' ? wideZero : masked,
            right: scenario === 'zero-or' ? masked : wideZero,
          });
          expected = (a) => a & 0xff00ff00ff00ff00n;
          break;
        }
        case 'shifted-zero': {
          root = add('root', 64, {
            kind: 'integer',
            op: 'shl',
            left: wideZero,
            right: add('count', 64, { kind: 'constant', bits: 32n }),
          });
          expected = () => 0n;
          break;
        }
        case 'all-zero':
          root = add('root', 64, { kind: 'concat', values: [zero, zero] });
          expected = () => 0n;
          break;
        case 'unknown-zero':
        case 'unknown-shift': {
          const unknown = add('unknown', 64, {
            kind: 'indeterminate',
            state: 'unknown',
            reason: 'zero-lane dependency',
          });
          const masked = add('masked-unknown', 64, {
            kind: 'integer',
            op: 'and',
            left: unknown,
            right: wideZero,
          });
          root = add(
            'root',
            64,
            scenario === 'unknown-zero'
              ? { kind: 'integer', op: 'or', left: x, right: masked }
              : { kind: 'integer', op: 'shl', left: wideZero, right: unknown },
          );
          break;
        }
        case 'nonstructural':
          root = add('root', 64, {
            kind: 'integer',
            op: 'shl',
            left: x,
            right: add('count', 64, { kind: 'constant', bits: 1n }),
          });
          expected = (a) => BigInt.asUintN(64, a << 1n);
          break;
      }
      const context = createOperationContext();
      const validation = new LocalValidationSession(
        context,
        scenario !== 'checked',
        'zero-lanes-function',
      );
      if (exhausted) while (!validation.allowance.exhausted) validation.allowance.charge();
      if (scenario === 'capacity')
        for (let i = 0; i < 256; i++)
          validation.presentation(`capacity-${i}`, `${i}`, 'record bound');
      // Reverse order in exhausted cases: new structural proofs must discover
      // constant casts themselves, not rely on earlier BDD-authorized folds.
      if (exhausted) {
        const reversed = [...expressions].reverse();
        expressions.clear();
        for (const [id, expression] of reversed) expressions.set(id, expression);
      }
      normalizeSourceExpressions(
        values,
        expressions,
        owners,
        make,
        context,
        validation,
        undefined,
        scenario !== 'checked',
      );
      const rewritten = expressions.get(root.id)!;
      const refused = [
        'unknown-zero',
        'unknown-shift',
        'nonstructural',
        'capacity',
        'checked',
      ].includes(scenario);
      assert.equal(
        validation.records.some(
          (record) =>
            record.rule === 'register_cell_recombination' &&
            (record.subject === root.id || record.subject_ids?.includes(root.id)),
        ),
        !refused,
      );
      assert.ok(validation.records.every((record) => record.status !== 'rejected'));
      if (scenario === 'capacity') assert.equal(rewritten.kind, 'concat');
      else if (scenario === 'all-zero' || scenario === 'shifted-zero')
        assert.deepEqual(rewritten, { kind: 'constant', bits: 0n });
      else if (scenario === 'insert-middle-zero')
        assert.ok(
          rewritten.kind === 'cast' || (rewritten.kind === 'integer' && rewritten.op === 'and'),
        );
      else if (!refused) assert.equal(rewritten.kind, 'cast');
      if (exhausted && scenario === 'nonstructural')
        assert.ok(rewritten.kind === 'integer' && rewritten.op === 'shl');
      const builder = new IRBuilder(
        slice,
        entityIdentity(slice, 'function', ['zero-lanes', scenario]),
        provenance,
        'ssa',
      );
      const block = builder.block('entry', [integer(64)]);
      const rebuilt = new Map([[x.id, block.parameters[0]!]]);
      const copy = (value: Value): Value => {
        const previous = rebuilt.get(value.id);
        if (previous) return previous;
        const copied = block.assign(value.type, mapExpression(expressions.get(value.id)!, copy));
        rebuilt.set(value.id, copied);
        return copied;
      };
      if (scenario === 'unknown-zero' || scenario === 'unknown-shift') {
        const yes = builder.block('yes'),
          no = builder.block('no');
        block.branch(
          block.compare('eq', copy(root), block.constant(integer(64), 0n)),
          block.edge(yes),
          block.edge(no),
        );
        yes.return([yes.constant(integer(64), 1n)]);
        no.return([no.constant(integer(64), 2n)]);
      } else block.return([copy(root)]);
      const ir = builder.finish(block, [root.type]);
      for (const language of ['c-like', 'python-like'] as const) {
        const output = emit(ir, {}, language);
        for (const input of [0n, 1n, 0x123456789abcdef0n, 0xffffffffffffffffn]) {
          const observed = execute(output.emission, new Map([[block.parameters[0]!.id, input]]));
          if (scenario === 'unknown-zero' || scenario === 'unknown-shift')
            assert.equal(observed.exit, 'unknown');
          else {
            assert.equal(observed.exit, 'machine_return');
            assert.deepEqual(observed.values, [expected(input)]);
          }
          assert.deepEqual(observed.events, []);
        }
      }
    });
  }
}
