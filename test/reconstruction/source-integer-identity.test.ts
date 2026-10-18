import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, entityIdentity } from '../../src/core/index.js';
import { integer, type Expression, type IntegerOp, type Value } from '../../src/ir/index.js';
import { identityOperand } from '../../src/reconstruction/expressions.js';
import { LocalValidationSession } from '../../src/reconstruction/local-validation.js';
import { normalizeSourceExpressions } from '../../src/reconstruction/source-expressions.js';
import { slice } from '../ir/support.js';

type Operand = 'x' | 'y' | 'zero' | 'one' | 'ones' | 'unknown';
interface Scenario {
  readonly name: string;
  readonly op: IntegerOp;
  readonly left: Operand;
  readonly right: Operand;
  /** The operand the operation reduces to, or null when it must stay. */
  readonly reduces: Operand | null;
}
const scenarios: readonly Scenario[] = [
  { name: 'x & x', op: 'and', left: 'x', right: 'x', reduces: 'x' },
  { name: 'x | x', op: 'or', left: 'x', right: 'x', reduces: 'x' },
  { name: 'x & ones', op: 'and', left: 'x', right: 'ones', reduces: 'x' },
  { name: 'ones & x', op: 'and', left: 'ones', right: 'x', reduces: 'x' },
  { name: 'x | 0', op: 'or', left: 'x', right: 'zero', reduces: 'x' },
  { name: '0 | x', op: 'or', left: 'zero', right: 'x', reduces: 'x' },
  { name: 'x + 0', op: 'add', left: 'x', right: 'zero', reduces: 'x' },
  { name: 'x - 0', op: 'sub', left: 'x', right: 'zero', reduces: 'x' },
  { name: 'x ^ 0', op: 'xor', left: 'x', right: 'zero', reduces: 'x' },
  { name: 'x * 1', op: 'mul', left: 'x', right: 'one', reduces: 'x' },
  { name: '1 * x', op: 'mul', left: 'one', right: 'x', reduces: 'x' },
  { name: 'x << 0', op: 'shl', left: 'x', right: 'zero', reduces: 'x' },
  { name: 'x >> 0', op: 'lshr', left: 'x', right: 'zero', reduces: 'x' },
  { name: 'x & y stays', op: 'and', left: 'x', right: 'y', reduces: null },
  { name: 'x | y stays', op: 'or', left: 'x', right: 'y', reduces: null },
  { name: '0 - x stays', op: 'sub', left: 'zero', right: 'x', reduces: null },
  {
    name: 'x ^ x stays (an unknown x would be dropped)',
    op: 'xor',
    left: 'x',
    right: 'x',
    reduces: null,
  },
  { name: 'x - x stays', op: 'sub', left: 'x', right: 'x', reduces: null },
  { name: 'x * 0 stays', op: 'mul', left: 'x', right: 'zero', reduces: null },
  { name: 'x & 0 stays', op: 'and', left: 'x', right: 'zero', reduces: null },
  { name: 'x | ones stays', op: 'or', left: 'x', right: 'ones', reduces: null },
  { name: '1 << x stays', op: 'shl', left: 'one', right: 'x', reduces: null },
  {
    name: 'unknown & unknown is the unknown',
    op: 'and',
    left: 'unknown',
    right: 'unknown',
    reduces: 'unknown',
  },
  { name: 'unknown ^ unknown stays', op: 'xor', left: 'unknown', right: 'unknown', reduces: null },
];

for (const view of ['source', 'checked', 'record bound'] as const)
  for (const scenario of scenarios)
    test(`source integer identity (${view}): ${scenario.name}`, () => {
      const values = new Map<string, Value>(),
        expressions = new Map<string, Expression>(),
        owners = new Map<string, string>();
      const make: Parameters<typeof normalizeSourceExpressions>[3] = (
        key,
        type,
        block,
        expression,
      ) => {
        const id = entityIdentity(slice, 'value', ['integer-identity', scenario.name, key]);
        const previous = values.get(id);
        if (previous) return previous;
        const value = { id, type };
        values.set(id, value);
        owners.set(id, block);
        if (expression) expressions.set(id, expression);
        return value;
      };
      const constant = (key: string, bits: bigint) =>
        make(key, integer(32), 'entry', { kind: 'constant', bits });
      const operands: Record<Operand, Value> = {
        x: make('x', integer(32), 'entry'),
        y: make('y', integer(32), 'entry'),
        zero: constant('zero', 0n),
        one: constant('one', 1n),
        ones: constant('ones', 0xffffffffn),
        unknown: make('unknown', integer(32), 'entry', {
          kind: 'indeterminate',
          state: 'unknown',
          reason: 'identity operand',
        }),
      };
      const root = make('root', integer(32), 'entry', {
        kind: 'integer',
        op: scenario.op,
        left: operands[scenario.left],
        right: operands[scenario.right],
      });
      const context = createOperationContext();
      const validation = new LocalValidationSession(
        context,
        view !== 'checked',
        'integer-identity-function',
      );
      if (view === 'record bound')
        for (let index = 0; index < 256; index++)
          validation.presentation(`capacity-${index}`, `${index}`, 'record bound');
      normalizeSourceExpressions(
        values,
        expressions,
        owners,
        make,
        context,
        validation,
        undefined,
        view !== 'checked',
      );
      const rewritten = expressions.get(root.id)!;
      const reduced =
        scenario.reduces !== null && view === 'source'
          ? identityOperand(root.type, rewritten)
          : null;
      if (scenario.reduces !== null && view === 'source')
        assert.equal(reduced?.id, operands[scenario.reduces].id, JSON.stringify(rewritten));
      else assert.equal(rewritten.kind, 'integer', 'the integer operation stays');
      assert.ok(validation.records.every((record) => record.status !== 'rejected'));
      assert.equal(
        validation.records.some(
          (record) =>
            (record.rule === 'integer_identity' || record.rule === 'register_cell_recombination') &&
            (record.subject === root.id || record.subject_ids?.includes(root.id)),
        ),
        scenario.reduces !== null && view === 'source',
        'every reduction is a recorded presentation rewrite',
      );
    });

for (const view of ['source', 'checked'] as const)
  for (const scenario of ['zero-extension', 'sign-extension', 'wide-sign-extension'] as const)
    test(`source extension fold (${view}): sign extension of a ${scenario}`, () => {
      const values = new Map<string, Value>(),
        expressions = new Map<string, Expression>(),
        owners = new Map<string, string>();
      const make: Parameters<typeof normalizeSourceExpressions>[3] = (
        key,
        type,
        block,
        expression,
      ) => {
        const id = entityIdentity(slice, 'value', ['extension-fold', scenario, key]);
        const previous = values.get(id);
        if (previous) return previous;
        const value = { id, type };
        values.set(id, value);
        owners.set(id, block);
        if (expression) expressions.set(id, expression);
        return value;
      };
      const x = make('x', integer(16), 'entry');
      const middle = make('middle', integer(32), 'entry', {
        kind: 'cast',
        op: scenario === 'sign-extension' ? 'sign_extend' : 'zero_extend',
        value: x,
      });
      const root = make('root', integer(64), 'entry', {
        kind: 'cast',
        op: 'sign_extend',
        value: scenario === 'wide-sign-extension' ? x : middle,
      });
      const context = createOperationContext();
      const validation = new LocalValidationSession(
        context,
        view === 'source',
        'extension-fold-function',
      );
      normalizeSourceExpressions(
        values,
        expressions,
        owners,
        make,
        context,
        validation,
        undefined,
        view === 'source',
      );
      const rewritten = expressions.get(root.id)!;
      // Only a zero extension has a clear sign bit: the other operands keep the
      // sign extension (x sign-extended twice is one sign extension of x).
      const folded = view === 'source' && scenario === 'zero-extension';
      assert.equal(
        rewritten.kind === 'cast' && rewritten.op === 'zero_extend' && rewritten.value.id === x.id,
        folded,
        JSON.stringify(rewritten),
      );
      if (!folded) assert.ok(rewritten.kind === 'cast' && rewritten.op === 'sign_extend');
      assert.equal(
        validation.records.some(
          (record) => record.rule === 'extension_fold' && record.subject === root.id,
        ),
        folded,
      );
      assert.ok(validation.records.every((record) => record.status !== 'rejected'));
    });
