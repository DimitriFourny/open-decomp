import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, entityIdentity } from '../../src/core/index.js';
import {
  evaluateExpression,
  expressionOperands,
  integer,
  type Expression,
  type IntegerOp,
  type RuntimeValue,
  type Value,
} from '../../src/ir/index.js';
import { LocalValidationSession } from '../../src/reconstruction/local-validation.js';
import { normalizeSourceExpressions } from '../../src/reconstruction/source-expressions.js';
import { slice } from '../ir/support.js';

type View = 'source' | 'checked' | 'record bound';

interface Kit {
  readonly width: number;
  readonly x: Value;
  readonly y: Value;
  readonly ones: bigint;
  constant(bits: bigint, width?: number): Value;
  int(op: IntegerOp, left: Value, right: Value): Value;
  select(condition: Value, whenTrue: Value, whenFalse: Value): Value;
  signBit(value: Value, offset?: number): Value;
  negative(value: Value): Value;
  extract(value: Value, offset: number, width: number): Value;
}

interface Outcome {
  readonly root: Value;
  readonly before: ReadonlyMap<string, Expression>;
  readonly after: ReadonlyMap<string, Expression>;
  readonly validation: LocalValidationSession;
  readonly x: Value;
  readonly y: Value;
}

function run(name: string, width: number, view: View, build: (kit: Kit) => Value): Outcome {
  const values = new Map<string, Value>(),
    expressions = new Map<string, Expression>(),
    owners = new Map<string, string>();
  let serial = 0;
  const make: Parameters<typeof normalizeSourceExpressions>[3] = (key, type, block, expression) => {
    const id = entityIdentity(slice, 'value', ['shift-idiom', name, key]);
    const previous = values.get(id);
    if (previous) return previous;
    const value = { id, type };
    values.set(id, value);
    owners.set(id, block);
    if (expression) expressions.set(id, expression);
    return value;
  };
  const fresh = (type: Value['type'], expression: Expression): Value =>
    make(`node-${serial++}`, type, 'entry', expression);
  const x = make('x', integer(width), 'entry'),
    y = make('y', integer(width), 'entry');
  const kit: Kit = {
    width,
    x,
    y,
    ones: (1n << BigInt(width)) - 1n,
    constant: (bits, bitWidth = width) => fresh(integer(bitWidth), { kind: 'constant', bits }),
    int: (op, left, right) => fresh(left.type, { kind: 'integer', op, left, right }),
    select: (condition, when_true, when_false) =>
      fresh(when_true.type, { kind: 'select', condition, when_true, when_false }),
    signBit: (value, offset = width - 1) => fresh(integer(1), { kind: 'extract', value, offset }),
    extract: (value, offset, bits) => fresh(integer(bits), { kind: 'extract', value, offset }),
    negative: (value) =>
      fresh(integer(1), {
        kind: 'compare',
        op: 'slt',
        left: value,
        right: fresh(value.type, { kind: 'constant', bits: 0n }),
      }),
  };
  const root = build(kit);
  const before = new Map(expressions);
  const context = createOperationContext();
  const validation = new LocalValidationSession(context, view !== 'checked', 'shift-function');
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
  return { root, before, after: expressions, validation, x, y };
}

/** Value of the root for one assignment of the two free leaves. */
function evaluate(
  outcome: Outcome,
  definitions: ReadonlyMap<string, Expression>,
  x: bigint,
  y: bigint,
): bigint {
  const get = (value: Value): RuntimeValue => {
    if (value.id === outcome.x.id) return { kind: 'bits', bits: x };
    if (value.id === outcome.y.id) return { kind: 'bits', bits: y };
    const definition = definitions.get(value.id);
    assert.ok(definition, 'every non-leaf operand is defined');
    return evaluateExpression(value.type, definition, get);
  };
  const result = get(outcome.root);
  assert.equal(result.kind, 'bits');
  return result.kind === 'bits' ? result.bits : 0n;
}

function samples(width: number): bigint[] {
  if (width <= 8) return Array.from({ length: 1 << width }, (_, index) => BigInt(index));
  const ones = (1n << BigInt(width)) - 1n;
  return [
    0n,
    1n,
    2n,
    ones,
    ones >> 1n,
    (ones >> 1n) + 1n,
    0x123456789abcdef0n & ones,
    0xfedcba9876543210n & ones,
  ];
}

/** The root as a shift: the normalizer prints a constant left shift as a
 * multiplication by a power of two, which is the same presentation. */
const rootShift = (outcome: Outcome): { op: string; count: bigint | null } => {
  const expression = outcome.after.get(outcome.root.id)!;
  if (expression.kind !== 'integer') return { op: expression.kind, count: null };
  const operand = outcome.after.get(expression.right.id);
  const bits = operand?.kind === 'constant' ? operand.bits : null;
  if (expression.op === 'mul' && bits !== null && bits > 0n && (bits & (bits - 1n)) === 0n)
    return { op: 'shl', count: BigInt(bits.toString(2).length - 1) };
  return { op: expression.op, count: bits };
};
const anyRecorded = (outcome: Outcome): boolean =>
  outcome.validation.records.some(
    (record) => record.kind === 'presentation' && record.rule === 'shift_idiom',
  );
/** Definitions reachable from the root in the rewritten graph. */
function reachable(outcome: Outcome): Expression[] {
  const seen = new Set<string>(),
    result: Expression[] = [],
    pending = [outcome.root];
  for (let value = pending.pop(); value; value = pending.pop()) {
    const expression = outcome.after.get(value.id);
    if (!expression || seen.has(value.id)) continue;
    seen.add(value.id);
    result.push(expression);
    pending.push(...expressionOperands(expression));
  }
  return result;
}
const recorded = (outcome: Outcome): boolean =>
  outcome.validation.records.some(
    (record) =>
      record.kind === 'presentation' &&
      record.rule === 'shift_idiom' &&
      record.status === 'verified' &&
      (record.subject === outcome.root.id || record.subject_ids?.includes(outcome.root.id)),
  );
/** The rewrite never changes a value, in any view. */
function assertExact(outcome: Outcome, width: number): void {
  assert.ok(outcome.validation.records.every((record) => record.status !== 'rejected'));
  for (const a of samples(width))
    for (const b of width <= 8 ? [0n, 1n] : [0n])
      assert.equal(
        evaluate(outcome, outcome.after, a, b),
        evaluate(outcome, outcome.before, a, b),
        `x=${a}`,
      );
}

interface Positive {
  readonly name: string;
  readonly op: 'lshr' | 'shl' | 'ashr';
  readonly count: (width: number, k: number) => number;
  readonly build: (kit: Kit, k: number) => Value;
}
const rotateLeft = (kit: Kit, k: number) => kit.int('rol', kit.x, kit.constant(BigInt(k)));
const rotateRight = (kit: Kit, k: number) => kit.int('ror', kit.x, kit.constant(BigInt(k)));
const low = (kit: Kit, k: number) => kit.ones >> BigInt(k);
const high = (kit: Kit, k: number) => (kit.ones << BigInt(k)) & kit.ones;
const signFill = (kit: Kit, k: number, test: Value = kit.signBit(kit.x)) =>
  kit.int(
    'and',
    kit.select(test, kit.constant(kit.ones), kit.constant(0n)),
    kit.constant(high(kit, kit.width - k)),
  );
const logicalShift = (kit: Kit, k: number) => kit.int('lshr', kit.x, kit.constant(BigInt(k)));

const positives: readonly Positive[] = [
  {
    name: 'ror(x,k) & (ones>>k) is x>>k',
    op: 'lshr',
    count: (_w, k) => k,
    build: (kit, k) => kit.int('and', rotateRight(kit, k), kit.constant(low(kit, k))),
  },
  {
    name: '(ones>>k) & ror(x,k) is x>>k',
    op: 'lshr',
    count: (_w, k) => k,
    build: (kit, k) => kit.int('and', kit.constant(low(kit, k)), rotateRight(kit, k)),
  },
  {
    name: 'ror(x,k) & (ones<<(w-k)) is x<<(w-k)',
    op: 'shl',
    count: (w, k) => w - k,
    build: (kit, k) => kit.int('and', rotateRight(kit, k), kit.constant(high(kit, kit.width - k))),
  },
  {
    name: 'rol(x,k) & (ones<<k) is x<<k',
    op: 'shl',
    count: (_w, k) => k,
    build: (kit, k) => kit.int('and', rotateLeft(kit, k), kit.constant(high(kit, k))),
  },
  {
    name: 'rol(x,k) & (ones>>(w-k)) is x>>(w-k)',
    op: 'lshr',
    count: (w, k) => w - k,
    build: (kit, k) => kit.int('and', rotateLeft(kit, k), kit.constant(low(kit, kit.width - k))),
  },
  {
    name: 'sign fill | ror & mask is x>>k (arithmetic)',
    op: 'ashr',
    count: (_w, k) => k,
    build: (kit, k) =>
      kit.int(
        'or',
        signFill(kit, k),
        kit.int('and', rotateRight(kit, k), kit.constant(low(kit, k))),
      ),
  },
  {
    name: 'ror & mask | sign fill (operands swapped)',
    op: 'ashr',
    count: (_w, k) => k,
    build: (kit, k) =>
      kit.int(
        'or',
        kit.int('and', rotateRight(kit, k), kit.constant(low(kit, k))),
        signFill(kit, k),
      ),
  },
  {
    name: 'sign fill via x<0 compare | x>>k',
    op: 'ashr',
    count: (_w, k) => k,
    build: (kit, k) => kit.int('or', signFill(kit, k, kit.negative(kit.x)), logicalShift(kit, k)),
  },
  {
    name: 'unmasked select of exactly the vacated bits | x>>k',
    op: 'ashr',
    count: (_w, k) => k,
    build: (kit, k) =>
      kit.int(
        'or',
        kit.select(kit.signBit(kit.x), kit.constant(high(kit, kit.width - k)), kit.constant(0n)),
        logicalShift(kit, k),
      ),
  },
];

for (const width of [8, 64])
  for (const scenario of positives)
    for (const k of width === 8 ? [1, 3, 7] : [1, 16, 48, 63])
      test(`source shift idiom (w=${width}, k=${k}): ${scenario.name}`, () => {
        const name = `${scenario.name}-${width}-${k}`;
        const source = run(name, width, 'source', (kit) => scenario.build(kit, k));
        const shift = rootShift(source);
        assert.equal(shift.op, scenario.op, JSON.stringify(source.after.get(source.root.id)));
        assert.equal(shift.count, BigInt(scenario.count(width, k)));
        assert.ok(recorded(source), 'the rewrite is a recorded presentation rule');
        assertExact(source, width);
        // The checked view and a full record budget leave the rotate untouched.
        for (const view of ['checked', 'record bound'] as const) {
          const kept = run(name, width, view, (kit) => scenario.build(kit, k));
          assert.deepEqual(
            kept.after.get(kept.root.id),
            kept.before.get(kept.root.id),
            `${view} keeps the original expression`,
          );
          assert.ok(!recorded(kept));
          assertExact(kept, width);
        }
      });

interface Negative {
  readonly name: string;
  readonly build: (kit: Kit) => Value;
}
const k = 5;
const wrongSignFill = (
  kit: Kit,
  mask: bigint,
  yes = kit.ones,
  no = 0n,
  test = kit.signBit(kit.x),
) =>
  kit.int(
    'or',
    kit.int('and', kit.select(test, kit.constant(yes), kit.constant(no)), kit.constant(mask)),
    logicalShift(kit, k),
  );
const negatives: readonly Negative[] = [
  {
    name: 'mask one bit too wide',
    build: (kit) =>
      kit.int(
        'and',
        rotateRight(kit, k),
        kit.constant((kit.ones >> BigInt(k)) | (1n << BigInt(kit.width - k))),
      ),
  },
  {
    name: 'mask one bit too narrow',
    build: (kit) =>
      kit.int('and', rotateRight(kit, k), kit.constant((kit.ones >> BigInt(k)) >> 1n)),
  },
  {
    name: 'mask belonging to another count',
    build: (kit) => kit.int('and', rotateRight(kit, k), kit.constant(kit.ones >> BigInt(k + 2))),
  },
  {
    name: 'full mask is a real rotate',
    build: (kit) => kit.int('and', rotateRight(kit, k), kit.constant(kit.ones)),
  },
  {
    name: 'rotate by zero',
    build: (kit) => kit.int('and', rotateRight(kit, 0), kit.constant(kit.ones >> BigInt(k))),
  },
  {
    name: 'rotate by the width',
    build: (kit) =>
      kit.int('and', rotateRight(kit, kit.width), kit.constant(kit.ones >> BigInt(k))),
  },
  { name: 'bare rotate', build: (kit) => rotateRight(kit, k) },
  {
    name: 'rotate masked by a variable',
    build: (kit) => kit.int('and', rotateRight(kit, k), kit.y),
  },
  {
    name: 'rotate by a variable count',
    build: (kit) =>
      kit.int('and', kit.int('ror', kit.x, kit.y), kit.constant(kit.ones >> BigInt(k))),
  },
  {
    name: 'sign-fill mask one bit too wide',
    build: (kit) => wrongSignFill(kit, high(kit, kit.width - k - 1)),
  },
  {
    name: 'sign-fill mask one bit too narrow',
    build: (kit) => wrongSignFill(kit, high(kit, kit.width - k + 1)),
  },
  {
    name: 'sign fill tested on the wrong bit',
    build: (kit) =>
      wrongSignFill(kit, high(kit, kit.width - k), kit.ones, 0n, kit.signBit(kit.x, kit.width - 2)),
  },
  {
    name: 'sign fill tested on another value',
    build: (kit) => wrongSignFill(kit, high(kit, kit.width - k), kit.ones, 0n, kit.signBit(kit.y)),
  },
  {
    name: 'inverted select arms',
    build: (kit) => wrongSignFill(kit, high(kit, kit.width - k), 0n, kit.ones),
  },
  {
    name: 'nonzero fill for a clear sign',
    build: (kit) =>
      wrongSignFill(kit, high(kit, kit.width - k), kit.ones, 1n << BigInt(kit.width - 1)),
  },
  {
    name: 'sign fill joined with a shifted other value',
    build: (kit) =>
      kit.int('or', signFill(kit, k), kit.int('lshr', kit.y, kit.constant(BigInt(k)))),
  },
  {
    name: 'sign fill joined with a different shift count',
    build: (kit) => kit.int('or', signFill(kit, k), logicalShift(kit, k + 1)),
  },
  {
    name: 'sign fill joined with a zero shift',
    build: (kit) => kit.int('or', signFill(kit, k), logicalShift(kit, 0)),
  },
];

for (const width of [8, 64])
  for (const scenario of negatives)
    test(`source shift idiom stays (w=${width}): ${scenario.name}`, () => {
      const outcome = run(`${scenario.name}-${width}`, width, 'source', scenario.build);
      assert.ok(!recorded(outcome), JSON.stringify(outcome.after.get(outcome.root.id)));
      assertExact(outcome, width);
    });

interface Field {
  readonly name: string;
  readonly op: 'ror' | 'rol';
  /** Offset and width of the field; null when it straddles the wrap point. */
  readonly field: (width: number, k: number) => readonly [number, number];
  /** Offset of the same field in the rotated operand, or null when it must stay. */
  readonly source: (width: number, k: number) => number | null;
}
const fields: readonly Field[] = [
  {
    name: 'ror low field in the non-wrapped part',
    op: 'ror',
    field: (w, k) => [0, w - k],
    source: (_w, k) => k,
  },
  {
    name: 'ror one bit in the non-wrapped part',
    op: 'ror',
    field: () => [0, 1],
    source: (_w, k) => k,
  },
  {
    name: 'ror field in the wrapped part',
    op: 'ror',
    field: (w, k) => [w - k, k],
    source: () => 0,
  },
  { name: 'ror last bit', op: 'ror', field: (w) => [w - 1, 1], source: (_w, k) => k - 1 },
  {
    name: 'rol low field in the wrapped part',
    op: 'rol',
    field: (_w, k) => [0, k],
    source: (w, k) => w - k,
  },
  {
    name: 'rol field in the non-wrapped part',
    op: 'rol',
    field: (w, k) => [k, w - k],
    source: () => 0,
  },
  {
    name: 'ror field straddling the wrap point',
    op: 'ror',
    field: (w, k) => [0, w - k + 1],
    source: () => null,
  },
  {
    name: 'rol field straddling the wrap point',
    op: 'rol',
    field: (_w, k) => [0, k + 1],
    source: () => null,
  },
  { name: 'ror whole value', op: 'ror', field: (w) => [0, w], source: () => null },
];

for (const width of [8, 64])
  for (const scenario of fields)
    for (const count of width === 8 ? [1, 3, 7] : [1, 16, 47, 63]) {
      const [offset, bits] = scenario.field(width, count);
      if (offset + bits > width || bits === width) continue;
      test(`source shift idiom (w=${width}, k=${count}): ${scenario.name}`, () => {
        const build = (kit: Kit) =>
          kit.extract(kit.int(scenario.op, kit.x, kit.constant(BigInt(count))), offset, bits);
        const outcome = run(`${scenario.name}-${width}-${count}`, width, 'source', build);
        const rewritten = outcome.after.get(outcome.root.id)!;
        const expected = scenario.source(width, count);
        if (expected === null) {
          assert.ok(!recorded(outcome), JSON.stringify(rewritten));
          assert.equal(rewritten.kind, 'extract');
          assert.equal(
            outcome.after.get((rewritten as { value: Value }).value.id)?.kind,
            'integer',
          );
        } else {
          assert.ok(recorded(outcome), JSON.stringify(rewritten));
          assert.deepEqual(rewritten.kind === 'extract' && [rewritten.value.id, rewritten.offset], [
            outcome.x.id,
            expected,
          ]);
        }
        assertExact(outcome, width);
        for (const view of ['checked', 'record bound'] as const) {
          const kept = run(`${scenario.name}-${width}-${count}`, width, view, build);
          assert.deepEqual(kept.after.get(kept.root.id), kept.before.get(kept.root.id));
          assert.ok(!recorded(kept));
        }
      });
    }

interface MaskedField {
  readonly name: string;
  readonly op: 'ror' | 'rol';
  readonly offset: number;
  readonly bits: number;
  /** Mask bit length for this width and count; the rewrite needs offset+length <= non-wrapped bits. */
  readonly length: (width: number, k: number) => number;
  readonly rewrites: (width: number, k: number) => boolean;
}
const maskedFields: readonly MaskedField[] = [
  {
    name: 'ror field mask inside the non-wrapped part',
    op: 'ror',
    offset: 0,
    bits: 6,
    length: (w, k) => w - k,
    rewrites: () => true,
  },
  {
    name: 'ror field mask reaching the wrapped part',
    op: 'ror',
    offset: 0,
    bits: 6,
    length: (w, k) => w - k + 1,
    rewrites: () => false,
  },
  {
    name: 'ror offset field mask inside the non-wrapped part',
    op: 'ror',
    offset: 1,
    bits: 6,
    length: (w, k) => w - k - 1,
    rewrites: () => true,
  },
  {
    name: 'ror offset field mask one bit into the wrapped part',
    op: 'ror',
    offset: 1,
    bits: 6,
    length: (w, k) => w - k,
    rewrites: () => false,
  },
  {
    name: 'rol field mask inside the non-wrapped part',
    op: 'rol',
    offset: 0,
    bits: 6,
    length: (_w, k) => k,
    rewrites: () => true,
  },
  {
    name: 'rol field mask reaching the wrapped part',
    op: 'rol',
    offset: 0,
    bits: 6,
    length: (_w, k) => k + 1,
    rewrites: () => false,
  },
];
for (const scenario of maskedFields)
  for (const count of [2, 3]) {
    const width = 8;
    const length = scenario.length(width, count);
    if (length < 1 || length > scenario.bits) continue;
    test(`source shift idiom: ${scenario.name} (k=${count})`, () => {
      const mask = (1n << BigInt(length)) - 1n;
      const build = (kit: Kit) =>
        kit.int(
          'and',
          kit.extract(
            kit.int(scenario.op, kit.x, kit.constant(BigInt(count))),
            scenario.offset,
            scenario.bits,
          ),
          kit.constant(mask, scenario.bits),
        );
      const outcome = run(`${scenario.name}-${count}`, width, 'source', build);
      // Any node of the graph: a field lying wholly in the non-wrapped part is
      // rewritten on the extract itself, the others on the masking `and`.
      assert.equal(anyRecorded(outcome), scenario.rewrites(width, count));
      assert.equal(
        reachable(outcome).some(
          (expression) =>
            (expression.kind === 'integer' && expression.op === 'ror') ||
            (expression.kind === 'integer' && expression.op === 'rol'),
        ),
        !scenario.rewrites(width, count),
      );
      assertExact(outcome, width);
      const kept = run(`${scenario.name}-${count}`, width, 'checked', build);
      assert.deepEqual(kept.after.get(kept.root.id), kept.before.get(kept.root.id));
    });
  }
