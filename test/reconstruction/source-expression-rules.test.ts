import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, entityIdentity } from '../../src/core/index.js';
import {
  evaluateExpression,
  integer,
  type Expression,
  type IntegerOp,
  type IntegerPredicate,
  type RuntimeValue,
  type Value,
} from '../../src/ir/index.js';
import { LocalValidationSession } from '../../src/reconstruction/local-validation.js';
import { normalizeSourceExpressions } from '../../src/reconstruction/source-expressions.js';
import { slice } from '../ir/support.js';

/** A small IR DAG over one input x, normalized by the source rule pool. */
interface Graph {
  readonly values: Map<string, Value>;
  readonly expressions: Map<string, Expression>;
  readonly make: Parameters<typeof normalizeSourceExpressions>[3];
  k(bits: number, value: bigint): Value;
  op(op: IntegerOp, left: Value, right: Value): Value;
  cast(op: 'sign_extend' | 'zero_extend' | 'truncate', bits: number, value: Value): Value;
  extract(bits: number, value: Value, offset: number): Value;
  compare(op: IntegerPredicate, left: Value, right: Value): Value;
  not(value: Value): Value;
  concat(bits: number, values: readonly Value[]): Value;
  select(bits: number, condition: Value, yes: Value, no: Value): Value;
}

function graph(name: string): Graph {
  const values = new Map<string, Value>(),
    expressions = new Map<string, Expression>(),
    owners = new Map<string, string>();
  const make: Parameters<typeof normalizeSourceExpressions>[3] = (key, type, block, expression) => {
    const id = entityIdentity(slice, 'value', ['expression-rules', name, key]);
    const previous = values.get(id);
    if (previous) return previous;
    const value = { id, type };
    values.set(id, value);
    owners.set(id, block);
    if (expression) expressions.set(id, expression);
    return value;
  };
  let counter = 0;
  const define = (bits: number, expression: Expression) =>
    make(`v${counter++}`, integer(bits), 'entry', expression);
  return {
    values,
    expressions,
    make,
    k: (bits: number, value: bigint) =>
      define(bits, { kind: 'constant', bits: BigInt.asUintN(bits, value) }),
    op: (op: IntegerOp, left: Value, right: Value) =>
      define(left.type.kind === 'integer' ? left.type.bits : 0, {
        kind: 'integer',
        op,
        left,
        right,
      }),
    cast: (op: 'sign_extend' | 'zero_extend' | 'truncate', bits: number, value: Value) =>
      define(bits, { kind: 'cast', op, value }),
    extract: (bits: number, value: Value, offset: number) =>
      define(bits, { kind: 'extract', value, offset }),
    compare: (op: IntegerPredicate, left: Value, right: Value) =>
      define(1, { kind: 'compare', op, left, right }),
    not: (value: Value) => define(1, { kind: 'integer_unary', op: 'not', value }),
    concat: (bits: number, values: readonly Value[]) => define(bits, { kind: 'concat', values }),
    select: (bits: number, condition: Value, yes: Value, no: Value) =>
      define(bits, { kind: 'select', condition, when_true: yes, when_false: no }),
  };
}

function evaluate(
  expressions: ReadonlyMap<string, Expression>,
  root: Value,
  input: Value,
  x: bigint,
): bigint {
  const memo = new Map<string, RuntimeValue>();
  const get = (value: Value): RuntimeValue => {
    if (value.id === input.id) return { kind: 'bits', bits: x };
    const known = memo.get(value.id);
    if (known) return known;
    const result = evaluateExpression(value.type, expressions.get(value.id)!, get);
    memo.set(value.id, result);
    return result;
  };
  const result = get(root);
  assert.equal(result.kind, 'bits');
  return result.kind === 'bits' ? result.bits : 0n;
}

/** Normalizes, checks the rewritten root equals the original on every sample,
 * and returns the root's final operation and constant divisor (if any). */
function check(
  name: string,
  bits: number,
  build: (g: Graph, x: Value) => Value,
): { op: string; divisor: bigint | null; records: readonly string[] } {
  const g = graph(name);
  const x = g.make('x', integer(bits), 'entry');
  const root = build(g, x);
  const original = new Map(g.expressions);
  const context = createOperationContext();
  const session = new LocalValidationSession(context, true, `expression-rules-${name}`);
  normalizeSourceExpressions(
    g.values,
    g.expressions,
    new Map([...g.values.keys()].map((id) => [id, 'entry'])),
    g.make,
    context,
    session,
  );
  const records = session.records.flatMap((record) =>
    record.kind === 'presentation' && record.rule ? [record.rule] : [],
  );
  const top = (1n << BigInt(bits)) - 1n,
    half = 1n << BigInt(bits - 1);
  const samples =
    bits <= 16
      ? Array.from({ length: 1 << bits }, (_, index) => BigInt(index))
      : [0n, 1n, 2n, 6n, 7n, 8n, 9n, half - 1n, half, half + 1n, top, top - 6n, top - 7n].concat(
          Array.from({ length: 200 }, (_, index) => (BigInt(index) * 0x9e3779b97f4a7c15n) & top),
        );
  for (const sample of samples)
    assert.equal(
      evaluate(g.expressions, root, x, sample),
      evaluate(original, root, x, sample),
      `${name}: x=${BigInt.asIntN(bits, sample)}`,
    );
  let expression = g.expressions.get(root.id)!;
  while (expression.kind === 'cast' && expression.op === 'bitcast')
    expression = g.expressions.get(expression.value.id)!;
  if (expression.kind === 'compare') return { op: expression.op, divisor: null, records };
  if (expression.kind !== 'integer') return { op: expression.kind, divisor: null, records };
  const divisor = g.expressions.get(expression.right.id);
  return {
    op: expression.op,
    divisor: divisor?.kind === 'constant' ? BigInt.asIntN(bits, divisor.bits) : null,
    records,
  };
}

// Every check compares the normalized DAG with the original on every input of
// the stated width (16 bits and below: exhaustively).

test('constant products fold modulo 2^width and stay products', () => {
  for (const bits of [8, 16]) {
    assert.deepEqual(
      check(`mul-mul-${bits}`, bits, (g, x) =>
        g.op('mul', g.op('mul', x, g.k(bits, 5n)), g.k(bits, 2n)),
      ).divisor,
      10n,
    );
    // (x + x*2) << 3 is x*24 (lea chains)
    assert.equal(
      check(`lea-${bits}`, bits, (g, x) =>
        g.op('shl', g.op('add', x, g.op('mul', x, g.k(bits, 2n))), g.k(bits, 3n)),
      ).divisor,
      24n,
    );
    assert.equal(
      check(`shl-mul-${bits}`, bits, (g, x) =>
        g.op('mul', g.op('shl', x, g.k(bits, 2n)), g.k(bits, 3n)),
      ).divisor,
      12n,
    );
    assert.equal(check(`x-plus-x-${bits}`, bits, (g, x) => g.op('add', x, x)).divisor, 2n);
  }
  // A product that wraps to a negative-reading multiplier keeps its form.
  const wrapped = check('wrap', 8, (g, x) => g.op('mul', g.op('mul', x, g.k(8, 100n)), g.k(8, 2n)));
  assert.ok(wrapped.divisor === 100n || wrapped.divisor === 2n, String(wrapped.divisor));
  // 300 mod 256 = 44 reads as a multiplier.
  assert.equal(
    check('wrap-fold', 8, (g, x) => g.op('mul', g.op('mul', x, g.k(8, 100n)), g.k(8, 3n))).divisor,
    44n,
  );
});

test('masks combine, constants move right and 0 - x is negation', () => {
  const mask = check('mask', 8, (g, x) =>
    g.op('and', g.op('and', x, g.k(8, 0x3fn)), g.k(8, 0x1en)),
  );
  assert.equal(mask.divisor, 0x1en);
  assert.equal(check('right', 8, (g, x) => g.op('add', g.k(8, 34n), x)).divisor, 34n);
  assert.equal(check('neg', 8, (g, x) => g.op('sub', g.k(8, 0n), x)).op, 'integer_unary');
});

test('two tests of one value against zero become one signed comparison', () => {
  const predicates = ['eq', 'ne', 'slt', 'sle', 'sgt', 'sge'] as const;
  for (const bits of [8, 16])
    for (const first of [...predicates, 'sign', 'not sign'] as const)
      for (const second of predicates)
        for (const op of ['or', 'and'] as const) {
          const result = check(`zero-${bits}-${first}-${second}-${op}`, bits, (g, x) => {
            const zero = g.k(bits, 0n);
            const left =
              first === 'sign'
                ? g.extract(1, x, bits - 1)
                : first === 'not sign'
                  ? g.not(g.extract(1, x, bits - 1))
                  : g.compare(first, x, zero);
            return g.op(op, left, g.compare(second, x, g.k(bits, 0n)));
          });
          const masks: Record<string, number> = {
            eq: 2,
            ne: 5,
            slt: 1,
            sle: 3,
            sgt: 4,
            sge: 6,
            sign: 1,
            'not sign': 6,
          };
          const outcomes =
            op === 'or' ? masks[first]! | masks[second]! : masks[first]! & masks[second]!;
          // Always/never: other rules may fold it; the values are checked above.
          if (outcomes !== 0 && outcomes !== 7)
            assert.equal(masks[result.op], outcomes, `${first} ${op} ${second}: ${result.op}`);
        }
  // The sign bit of the low 8 bits of a wider value, beside a test of that slice.
  check('zero-slice', 16, (g, x) => {
    const low = g.extract(8, x, 0);
    return g.op('or', g.compare('eq', low, g.k(8, 0n)), g.extract(1, x, 7));
  });
});

test('a join of a recomputed low byte and the upper slices of its value is the value', () => {
  // concat(lo8(y) recomputed as t*10 + d at 8 bits, y[8:16]) with y = x*10 + sext(d)
  const result = check('recomputed', 16, (g, x) => {
    const d = g.extract(8, x, 8);
    const y = g.op('add', g.cast('sign_extend', 16, d), g.op('mul', x, g.k(16, 10n)));
    const low = g.op('add', d, g.op('mul', g.extract(8, x, 0), g.k(8, 10n)));
    return g.concat(16, [low, g.extract(8, y, 8)]);
  });
  assert.ok(result.records.includes('recomputed_low_part'), result.records.join());
  // A different low byte is not the value's: the join stays.
  const kept = check('not-recomputed', 16, (g, x) => {
    const d = g.extract(8, x, 8);
    const y = g.op('add', g.cast('sign_extend', 16, d), g.op('mul', x, g.k(16, 10n)));
    const low = g.op('add', d, g.op('mul', g.extract(8, x, 0), g.k(8, 9n)));
    return g.concat(16, [low, g.extract(8, y, 8)]);
  });
  assert.ok(!kept.records.includes('recomputed_low_part'));
});
