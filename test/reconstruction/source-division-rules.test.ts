import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, entityIdentity } from '../../src/core/index.js';
import {
  evaluateExpression,
  integer,
  type Expression,
  type IntegerOp,
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
  compare(op: 'slt', left: Value, right: Value): Value;
  select(bits: number, condition: Value, yes: Value, no: Value): Value;
}

function graph(name: string): Graph {
  const values = new Map<string, Value>(),
    expressions = new Map<string, Expression>(),
    owners = new Map<string, string>();
  const make: Parameters<typeof normalizeSourceExpressions>[3] = (key, type, block, expression) => {
    const id = entityIdentity(slice, 'value', ['division-rules', name, key]);
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
    compare: (op: 'slt', left: Value, right: Value) =>
      define(1, { kind: 'compare', op, left, right }),
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
): { op: string; divisor: bigint | null } {
  const g = graph(name);
  const x = g.make('x', integer(bits), 'entry');
  const root = build(g, x);
  const original = new Map(g.expressions);
  const context = createOperationContext();
  normalizeSourceExpressions(
    g.values,
    g.expressions,
    new Map([...g.values.keys()].map((id) => [id, 'entry'])),
    g.make,
    context,
    new LocalValidationSession(context, true, `division-rules-${name}`),
  );
  const top = (1n << BigInt(bits)) - 1n,
    half = 1n << BigInt(bits - 1);
  const samples =
    bits <= 8
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
  if (expression.kind !== 'integer') return { op: expression.kind, divisor: null };
  const divisor = g.expressions.get(expression.right.id);
  return {
    op: expression.op,
    divisor: divisor?.kind === 'constant' ? BigInt.asIntN(bits, divisor.bits) : null,
  };
}

/** Signed magic quotient t + (t >>u (w-1)) (or t - (x >>s (w-1))) where t is
 * ((hi(sext(x) * m) ± x) >>s s). */
function signedMagic(
  bits: number,
  m: bigint,
  adjust: -1 | 0 | 1,
  shift: number,
  sign: 'quotient' | 'dividend',
) {
  return (g: Graph, x: Value): Value => {
    const wide = g.op('mul', g.cast('sign_extend', 2 * bits, x), g.k(2 * bits, m));
    let t = g.extract(bits, wide, bits);
    if (adjust) t = g.op(adjust > 0 ? 'add' : 'sub', t, x);
    if (shift) t = g.op('ashr', t, g.k(bits, BigInt(shift)));
    return sign === 'quotient'
      ? g.op('add', t, g.op('lshr', t, g.k(bits, BigInt(bits - 1))))
      : g.op('sub', t, g.op('ashr', x, g.k(bits, BigInt(bits - 1))));
  };
}

test('signed magic division forms become x / d exactly at 8 and 32 bits', () => {
  // 8-bit x / 7: m = 0x93 (as signed -109), add x, >> 2 (exhaustive, INT8_MIN included).
  assert.deepEqual(check('s8-div7', 8, signedMagic(8, -109n, 1, 2, 'quotient')), {
    op: 'sdiv',
    divisor: 7n,
  });
  assert.deepEqual(check('s8-div7-gcc', 8, signedMagic(8, -109n, 1, 2, 'dividend')), {
    op: 'sdiv',
    divisor: 7n,
  });
  // 8-bit x / -7: m = 0x6d, subtract x, >> 2.
  assert.deepEqual(check('s8-divm7', 8, signedMagic(8, 0x6dn, -1, 2, 'quotient')), {
    op: 'sdiv',
    divisor: -7n,
  });
  assert.deepEqual(check('s32-div7', 32, signedMagic(32, -0x6db6db6dn, 1, 2, 'quotient')), {
    op: 'sdiv',
    divisor: 7n,
  });
  assert.deepEqual(check('s32-div3', 32, signedMagic(32, 0x55555556n, 0, 0, 'dividend')), {
    op: 'sdiv',
    divisor: 3n,
  });
});

test('near-miss signed magic sequences stay as written', () => {
  // Off-by-one multipliers and a sign term of the wrong sign are not divisions.
  for (const [name, build] of [
    ['s8-m-1', signedMagic(8, -110n, 1, 2, 'quotient')],
    ['s8-m+1', signedMagic(8, -108n, 1, 2, 'quotient')],
    ['s32-m-1', signedMagic(32, 0x55555555n, 0, 0, 'dividend')],
    ['s8-divm7-dividend-sign', signedMagic(8, 0x6dn, -1, 2, 'dividend')],
  ] as const) {
    const result = check(name, name.startsWith('s8') ? 8 : 32, build);
    assert.notEqual(result.op, 'sdiv', name);
  }
});

test('signed power-of-two division and remainder forms are exact for every 8-bit dividend', () => {
  // 2^k < 2^(w-1): a divisor of 2^(w-1) has no positive w-bit spelling.
  for (let k = 1; k < 7; k++) {
    const mask = (1n << BigInt(k)) - 1n;
    const biasOf = (g: Graph, x: Value) =>
      g.op('lshr', g.op('ashr', x, g.k(8, 7n)), g.k(8, BigInt(8 - k)));
    const selected = (g: Graph, x: Value) =>
      g.select(8, g.compare('slt', x, g.k(8, 0n)), g.op('add', x, g.k(8, mask)), x);
    assert.deepEqual(
      check(`div-select-${k}`, 8, (g, x) => g.op('ashr', selected(g, x), g.k(8, BigInt(k)))),
      { op: 'sdiv', divisor: 1n << BigInt(k) },
    );
    assert.deepEqual(
      check(`div-srl-${k}`, 8, (g, x) =>
        g.op('ashr', g.op('add', x, biasOf(g, x)), g.k(8, BigInt(k))),
      ),
      { op: 'sdiv', divisor: 1n << BigInt(k) },
    );
    assert.deepEqual(
      check(`div-neg-${k}`, 8, (g, x) =>
        g.op('sub', g.k(8, 0n), g.op('ashr', selected(g, x), g.k(8, BigInt(k)))),
      ),
      { op: 'sdiv', divisor: -(1n << BigInt(k)) },
    );
    assert.deepEqual(
      check(`rem-mask-${k}`, 8, (g, x) =>
        g.op('sub', x, g.op('and', selected(g, x), g.k(8, ~mask))),
      ),
      { op: 'srem', divisor: 1n << BigInt(k) },
    );
    assert.deepEqual(
      check(`rem-gcc-${k}`, 8, (g, x) =>
        g.op('sub', g.op('and', g.op('add', x, biasOf(g, x)), g.k(8, mask)), biasOf(g, x)),
      ),
      { op: 'srem', divisor: 1n << BigInt(k) },
    );
    // csneg: -x < 0 ? x & m : -((-x) & m) (true at INT8_MIN, where both arms are 0)
    assert.deepEqual(
      check(`rem-csneg-${k}`, 8, (g, x) => {
        const negative = g.op('sub', g.k(8, 0n), x);
        return g.select(
          8,
          g.compare('slt', negative, g.k(8, 0n)),
          g.op('and', x, g.k(8, mask)),
          g.op('sub', g.k(8, 0n), g.op('and', negative, g.k(8, mask))),
        );
      }),
      { op: 'srem', divisor: 1n << BigInt(k) },
    );
    // A bias of the wrong size is not a division.
    assert.notEqual(
      check(`div-wrong-bias-${k}`, 8, (g, x) =>
        g.op('ashr', g.op('add', x, biasOf(g, x)), g.k(8, BigInt(k + 1))),
      ).op,
      'sdiv',
    );
  }
  // x / 2^(w-1) (and its remainder) has no positive divisor spelling: unchanged.
  assert.notEqual(
    check('div-select-7', 8, (g, x) =>
      g.op(
        'ashr',
        g.select(8, g.compare('slt', x, g.k(8, 0n)), g.op('add', x, g.k(8, 127n)), x),
        g.k(8, 7n),
      ),
    ).op,
    'sdiv',
  );
});

test('signed magic remainder x - q*d is x % d for every 8-bit dividend', () => {
  assert.deepEqual(
    check('s8-rem7', 8, (g, x) => {
      const q = signedMagic(8, -109n, 1, 2, 'quotient')(g, x);
      // q - (q << 3) + x, the shift-subtract spelling of x - q*7
      return g.op('add', g.op('sub', q, g.op('shl', q, g.k(8, 3n))), x);
    }),
    { op: 'srem', divisor: 7n },
  );
});
