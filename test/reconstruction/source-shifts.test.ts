import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, entityIdentity } from '../../src/core/index.js';
import { darwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../src/analysis/types/index.js';
import { simplifySSA } from '../../src/analysis/values/index.js';
import {
  OracleMemory,
  evaluateExpression,
  expressionOperands,
  integer,
  type Expression,
  type IntegerOp,
  type RuntimeValue,
  type SSAForm,
  type Value,
} from '../../src/ir/index.js';
import { LocalValidationSession } from '../../src/reconstruction/local-validation.js';
import { normalizeSourceExpressions } from '../../src/reconstruction/source-expressions.js';
import { emit, emittedFormals, execute } from '../emitters/c/support.js';
import { data, evaluate as evaluateLifted, fromWords, lift } from '../lifters/arm64/support.js';
import type { EmissionResult } from '../../src/emitters/model.js';
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
function assertExact(
  outcome: Outcome,
  width: number,
  inputs: readonly bigint[] = samples(width),
): void {
  assert.ok(outcome.validation.records.every((record) => record.status !== 'rejected'));
  for (const a of inputs)
    for (const b of width <= 8 ? [0n, 1n] : [0n, (1n << BigInt(width)) - 1n])
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

// ---------------------------------------------------------------------------
// Lifted bitfield moves (SXT*, SBFIZ/UBFIZ, SBFX), emitted in both dialects.
// ---------------------------------------------------------------------------

const abi = darwinArm64Abi;
const ret = 0xd65f03c0;

function lifted(words: readonly number[]) {
  const graph = fromWords([...words, ret]);
  const registers = lift(graph).ir;
  const ssa = simplifySSA(constructSSA(registers).value as SSAForm).value as SSAForm;
  const types = recoverTypes(ssa, abi, createOperationContext(), {
    image_id: graph.function.entry.image_id,
    slice_id: slice,
    revision: 0,
  });
  return { registers, ssa, source: { abi, callees: [], addresses: [] }, types };
}

/** `SBFM`/`UBFM` Xd/Wd = Xn/Wn, #immr, #imms with d = n = 0. */
const bitfieldMove = (signed: boolean, bits: 32 | 64, immr: number, imms: number): number =>
  ((bits === 64 ? 0x93400000 : 0x13000000) |
    (signed ? 0 : 0x40000000) |
    (immr << 16) |
    (imms << 10)) >>>
  0;

interface Move {
  readonly name: string;
  readonly word: number;
  /** The architectural result for the register input (source-level oracle). */
  readonly oracle: (x: bigint) => bigint;
}
const field = (bits: 32 | 64, signed: boolean, lsb: number, width: number, shift: number) => {
  const wide = BigInt(bits);
  return (x: bigint): bigint => {
    const taken = (x >> BigInt(lsb)) & ((1n << BigInt(width)) - 1n);
    const value = signed ? BigInt.asIntN(width, taken) : taken;
    return BigInt.asUintN(Number(wide), value << BigInt(shift));
  };
};
const moves: readonly Move[] = [
  ['sxtw x0, w0', true, 64, 0, 31, field(64, true, 0, 32, 0)],
  ['sxth x0, w0', true, 64, 0, 15, field(64, true, 0, 16, 0)],
  ['sxtb x0, w0', true, 64, 0, 7, field(64, true, 0, 8, 0)],
  ['sxth w0, w0', true, 32, 0, 15, field(32, true, 0, 16, 0)],
  ['sxtb w0, w0', true, 32, 0, 7, field(32, true, 0, 8, 0)],
  ['sbfiz x0, x0, #5, #32', true, 64, 59, 31, field(64, true, 0, 32, 5)],
  ['sbfiz x0, x0, #2, #32', true, 64, 62, 31, field(64, true, 0, 32, 2)],
  ['sbfiz x0, x0, #3, #8', true, 64, 61, 7, field(64, true, 0, 8, 3)],
  ['sbfiz w0, w0, #8, #16', true, 32, 24, 15, field(32, true, 0, 16, 8)],
  ['sbfiz x0, x0, #16, #16', true, 64, 48, 15, field(64, true, 0, 16, 16)],
  ['ubfiz x0, x0, #5, #32', false, 64, 59, 31, field(64, false, 0, 32, 5)],
  ['ubfiz x0, x0, #3, #8', false, 64, 61, 7, field(64, false, 0, 8, 3)],
  ['ubfiz w0, w0, #4, #8', false, 32, 28, 7, field(32, false, 0, 8, 4)],
  ['ubfiz w0, w0, #8, #16', false, 32, 24, 15, field(32, false, 0, 16, 8)],
].map(([name, signed, bits, immr, imms, oracle]) => ({
  name: name as string,
  word: bitfieldMove(signed as boolean, bits as 32 | 64, immr as number, imms as number),
  oracle: oracle as Move['oracle'],
}));

/** Inputs with bit 31 set, with the top bit of narrower fields set, with junk
 * above the field, and with the field's top bit clear. */
const moveInputs = [
  0n,
  1n,
  0x7fn,
  0x80n,
  0xffn,
  0x7fffn,
  0x8000n,
  0xffffn,
  0x7fffffffn,
  0x80000000n,
  0xffffffffn,
  0x1_8000_0000n,
  0x7fffffff_ffffffffn,
  0x80000000_00000000n,
  0xfedcba98_80000001n,
  0x12345678_90abcdefn,
  0xffffffff_ffffffffn,
];

/** str x0, [x1]: the 64-bit result is observed whole, through memory, so that
 * the return-width presentation of the function never hides upper bits. */
const storeX0 = 0xf9000020;
const object = data;

/** Moves that are not folded: a field that does not start at bit 0 (SBFX/UBFX),
 * a width without a native integer type, or no fill above a placed field. They
 * keep their lowering (the division and signed-shift recognizers read those
 * forms) and stay exact. */
const unfolded: readonly Move[] = (
  [
    ['ubfx x0, x0, #8, #16', false, 64, 8, 23, field(64, false, 8, 16, 0)],
    ['sbfx x0, x0, #8, #16', true, 64, 8, 23, field(64, true, 8, 16, 0)],
    ['sbfx w0, w0, #4, #12', true, 32, 4, 15, field(32, true, 4, 12, 0)],
    ['sbfx x0, x0, #1, #31', true, 64, 1, 31, field(64, true, 1, 31, 0)],
    ['sbfiz w0, w0, #3, #5', true, 32, 29, 4, field(32, true, 0, 5, 3)],
    ['sbfiz w0, w0, #1, #7', true, 32, 31, 6, field(32, true, 0, 7, 1)],
    ['sxtw x0, w0 as sbfx #0, #24', true, 64, 0, 23, field(64, true, 0, 24, 0)],
  ] as const
).map(([name, signed, bits, immr, imms, oracle]) => ({
  name,
  word: bitfieldMove(signed, bits, immr, imms),
  oracle,
}));

const shiftIdiomRecorded = (emission: EmissionResult['emission']): boolean =>
  emission.local_validation?.some(
    (record) =>
      record.kind === 'presentation' &&
      record.rule === 'shift_idiom' &&
      record.status === 'verified',
  ) ?? false;

/** The stored 64-bit register after the lifted bitfield move, executed from the
 * emitted text of one dialect and view. */
function storedResult(
  emission: EmissionResult['emission'],
  value: bigint,
  inputMask: bigint,
): bigint {
  const formals = emittedFormals(emission);
  const memory = new Map(
    Array.from({ length: 8 }, (_, index): [bigint, number] => [object + BigInt(index), 0]),
  );
  const observed = execute(
    emission,
    new Map([
      [formals[0]!.statement_id, value & inputMask],
      [formals[1]!.statement_id, object],
    ]),
    memory,
  );
  assert.equal(observed.exit, 'machine_return', emission.text);
  let stored = 0n;
  for (let index = 7; index >= 0; index--)
    stored = (stored << 8n) | BigInt(observed.memory.get(object + BigInt(index)) ?? 0);
  return stored;
}

function checkMove(move: Move, folds: boolean): void {
  const fixture = lifted([move.word, storeX0]);
  for (const value of moveInputs) {
    const evaluated = evaluateLifted(
      fixture.registers,
      new Map([
        ['arm64:x0', value],
        ['arm64:x1', object],
      ]),
      {
        memory: new OracleMemory([
          { base: data, bytes: new Uint8Array(8), writable: true },
        ]).snapshot(),
      },
    );
    assert.equal(
      new OracleMemory(evaluated.memory).read(object, 64),
      move.oracle(value),
      `lifter x0=0x${value.toString(16)}`,
    );
  }
  for (const language of ['c-like', 'python-like'] as const)
    for (const view of ['source', 'checked'] as const) {
      const { emission } = emit(fixture.ssa, fixture, language, view);
      const label = `${language} ${view} ${move.name}\n${emission.text}`;
      assert.equal(shiftIdiomRecorded(emission), folds && view === 'source', label);
      if (folds && view === 'source')
        assert.doesNotMatch(emission.text, /0xffffffff[0-9a-f]* : 0|else 0|\bror\b/, label);
      const formals = emittedFormals(emission);
      assert.equal(formals.length, 2, label);
      // The source view may declare the operand as its low word (a recorded
      // ABI presentation); the bits it drops must not change the result.
      const declared = new RegExp(
        `\\bu?int(8|16|32|64)_t\\s+${formals[0]!.name}\\b|\\b${formals[0]!.name}: u?int(8|16|32|64)_t`,
      ).exec(emission.text);
      const inputMask = declared
        ? (1n << BigInt(declared[1] ?? declared[2]!)) - 1n
        : (1n << 64n) - 1n;
      for (const value of moveInputs)
        assert.equal(
          storedResult(emission, value, inputMask),
          move.oracle(value),
          `x0=0x${value.toString(16)} ${label}`,
        );
    }
}

for (const move of moves)
  test(`lifted ${move.name} agrees with the architecture and folds to one extension`, () =>
    checkMove(move, true));
for (const move of unfolded)
  test(`lifted ${move.name} agrees with the architecture and keeps its lowering`, () =>
    checkMove(move, false));

// ---------------------------------------------------------------------------
// The generic SBFM/UBFM lowering (src/lifters/arm64/semantics.ts) as IR.
// ---------------------------------------------------------------------------

const fieldMask = (bits: number): bigint => (1n << BigInt(bits)) - 1n;
const rotateConstant = (value: bigint, right: number, width: number): bigint =>
  ((value >> BigInt(right)) | (value << BigInt(width - right))) & fieldMask(width);
const nativeBits = (bits: number): boolean => bits === 8 || bits === 16 || bits === 32;

/** Every single bit and its complement, the runs below each bit, and fixed
 * pseudo-random words: the lowering is bitwise, so these separate every field,
 * sign and fill position. */
function dense(width: number): bigint[] {
  const ones = fieldMask(width);
  const values = new Set<bigint>([0n, ones]);
  for (let bit = 0; bit < width; bit++) {
    values.add(1n << BigInt(bit));
    values.add(ones ^ (1n << BigInt(bit)));
    values.add(fieldMask(bit));
    values.add(ones ^ fieldMask(bit));
  }
  let state = 0x9e3779b97f4a7c15n;
  for (let index = 0; index < 48; index++) {
    state = BigInt.asUintN(64, state * 6364136223846793005n + 1442695040888963407n);
    values.add(state & ones);
  }
  return [...values];
}

/** `bottom = ror(x, r) & rotate(mask(s+1), r)`, `top = sign ? ones : 0`,
 * `(top & ~t) | (bottom & t)` exactly as the lifter lowers SBFM/UBFM. */
function bitfieldLowering(kit: Kit, r: number, s: number, signed: boolean): Value {
  const width = kit.width,
    t = fieldMask(((s - r) & (width - 1)) + 1);
  const rotated = r === 0 ? kit.x : rotateRight(kit, r),
    bottom = kit.int('and', rotated, kit.constant(rotateConstant(fieldMask(s + 1), r, width))),
    top = signed
      ? kit.select(kit.signBit(kit.x, s), kit.constant(kit.ones), kit.constant(0n))
      : kit.constant(0n);
  return kit.int(
    'or',
    kit.int('and', top, kit.constant(kit.ones ^ t)),
    kit.int('and', bottom, kit.constant(t)),
  );
}
const selects = (outcome: Outcome): boolean =>
  reachable(outcome).some((expression) => expression.kind === 'select');
const rotates = (outcome: Outcome): boolean =>
  reachable(outcome).some(
    (expression) =>
      expression.kind === 'integer' && (expression.op === 'ror' || expression.op === 'rol'),
  );

/** Every (immr, imms) of a 16-bit word and a spread of 32/64-bit ones. The
 * aliases that fold: the field starts at bit 0 of its source and has a native
 * width n<w (SXTB/SXTH/SXTW and SBFIZ with a fill above it; UBFIZ). Every other
 * move keeps its lowering, and every move is exact. */
const lowerings: (readonly [number, number, number])[] = [];
for (let r = 0; r < 16; r++) for (let s = 0; s < 16; s++) lowerings.push([16, r, s]);
for (const [r, s] of [
  [0, 7],
  [0, 15],
  [0, 30],
  [0, 31],
  [29, 7],
  [24, 7],
  [16, 15],
  [17, 15],
  [28, 7],
  [1, 7],
  [4, 15],
  [8, 23],
  [31, 6],
  [31, 0],
  [30, 7],
  [8, 15],
  [25, 7],
  [16, 31],
] as const)
  lowerings.push([32, r, s]);
for (const [r, s] of [
  [0, 7],
  [0, 15],
  [0, 31],
  [0, 62],
  [59, 31],
  [62, 31],
  [61, 7],
  [56, 15],
  [48, 15],
  [32, 31],
  [8, 23],
  [1, 30],
  [33, 40],
  [60, 3],
  [63, 0],
  [1, 31],
  [16, 47],
] as const)
  lowerings.push([64, r, s]);

for (const [width, r, s] of lowerings)
  for (const signed of [true, false]) {
    const name = `${signed ? 'SBFM' : 'UBFM'} #${r}, #${s}`;
    const fills = s < r - 1,
      n = s < r ? s + 1 : s - r + 1;
    const folds = nativeBits(n) && n < width && (signed ? fills || (r === 0 && s >= 0) : fills);
    test(`source bitfield move (w=${width}, ${name}) is exact and ${folds ? 'folds to one extension' : 'keeps its lowering'}`, () => {
      const build = (kit: Kit) => bitfieldLowering(kit, r, s, signed);
      const id = `bitfield-${width}-${signed}-${r}-${s}`;
      const outcome = run(id, width, 'source', build);
      assertExact(outcome, width, dense(width));
      if (folds) {
        assert.ok(anyRecorded(outcome), JSON.stringify(outcome.after.get(outcome.root.id)));
        assert.ok(!selects(outcome) && !rotates(outcome), 'no fill select or rotation remains');
      } else if (signed && fills && !(r === 0)) {
        assert.ok(
          selects(outcome) || !nativeBits(n),
          'a field of a non-native width keeps its fill',
        );
      }
      for (const view of ['checked', 'record bound'] as const) {
        const kept = run(id, width, view, build);
        assert.deepEqual(kept.after.get(kept.root.id), kept.before.get(kept.root.id));
        assert.ok(!recorded(kept));
        assertExact(kept, width, dense(width));
      }
    });
  }

/** A byte (n=8) of a 32-bit word with the pieces of SXTB lowering, each broken
 * in one place: the original stays and the value is unchanged. */
const sxtb = (
  kit: Kit,
  options: {
    fill?: bigint;
    signBit?: Value;
    yes?: bigint;
    no?: bigint;
    field?: Value;
    mask?: bigint;
  } = {},
): Value =>
  kit.int(
    'or',
    kit.int(
      'and',
      kit.select(
        options.signBit ?? kit.signBit(kit.x, 7),
        kit.constant(options.yes ?? kit.ones),
        kit.constant(options.no ?? 0n),
      ),
      kit.constant(options.fill ?? 0xffffff00n),
    ),
    kit.int('and', options.field ?? kit.x, kit.constant(options.mask ?? 0xffn)),
  );

const notBitfields: readonly Negative[] = [
  {
    name: 'a fill one bit short (gap above the field)',
    build: (kit) => sxtb(kit, { fill: 0xfffffe00n }),
  },
  { name: 'a fill overlapping the field', build: (kit) => sxtb(kit, { fill: 0xffffff80n }) },
  {
    name: 'a sign bit below the top of the field',
    build: (kit) => sxtb(kit, { signBit: kit.signBit(kit.x, 6) }),
  },
  {
    name: 'a sign bit above the field',
    build: (kit) => sxtb(kit, { signBit: kit.signBit(kit.x, 8) }),
  },
  {
    name: 'a sign bit of another value',
    build: (kit) => sxtb(kit, { signBit: kit.signBit(kit.y, 7) }),
  },
  { name: 'a field of another value', build: (kit) => sxtb(kit, { field: kit.y }) },
  { name: 'a fill of the inverted sign', build: (kit) => sxtb(kit, { yes: 0n, no: kit.ones }) },
  { name: 'a field mask with a hole', build: (kit) => sxtb(kit, { mask: 0xfbn }) },
  {
    name: 'a field of a non-native width',
    build: (kit) => sxtb(kit, { fill: 0xffffff80n, signBit: kit.signBit(kit.x, 6), mask: 0x7fn }),
  },
  {
    name: 'a field that does not start at bit 0 of its source',
    build: (kit) => sxtb(kit, { field: rotateRight(kit, 8), signBit: kit.signBit(kit.x, 15) }),
  },
  {
    name: 'a field that wraps around the rotation',
    build: (kit) => sxtb(kit, { field: rotateRight(kit, 29), signBit: kit.signBit(kit.x, 2) }),
  },
  {
    name: 'a rotation masked across its wrap point',
    build: (kit) => kit.int('and', rotateRight(kit, 29), kit.constant(0xffn)),
  },
  {
    name: 'a rotation masked to a field with a hole',
    build: (kit) => kit.int('and', rotateRight(kit, 5), kit.constant(0x16n)),
  },
  {
    name: 'a rotated field of a non-native width',
    build: (kit) => kit.int('and', rotateRight(kit, 31), kit.constant(0xfen)),
  },
  {
    name: 'a field with no shift (UBFX)',
    build: (kit) => kit.int('and', rotateRight(kit, 8), kit.constant(0xffn)),
  },
];
for (const scenario of notBitfields)
  test(`source bitfield move stays: ${scenario.name}`, () => {
    const outcome = run(`not-bitfield-${scenario.name}`, 32, 'source', scenario.build);
    assert.ok(!recorded(outcome), JSON.stringify(outcome.after.get(outcome.root.id)));
    assertExact(outcome, 32, dense(32));
  });

test('SXTB lowering as the control of the negatives folds to one extension', () => {
  const outcome = run('sxtb-control', 32, 'source', (kit) => sxtb(kit));
  assert.ok(recorded(outcome), JSON.stringify(outcome.after.get(outcome.root.id)));
  assert.ok(!selects(outcome));
  assertExact(outcome, 32, dense(32));
});
