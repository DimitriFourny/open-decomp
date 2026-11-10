import type { OperationContext } from '../core/index.js';
import {
  bitWidth,
  evaluateExpression,
  expressionOperands,
  sameType,
  type DataType,
  type Expression,
  type IntegerPredicate,
  type Value,
} from '../ir/index.js';
import { integerIdentity } from './expressions.js';
import { recombineBitSlices, wholeValueConcat } from './source-bit-slices.js';
import { foldSourceCondition } from './source-conditions.js';
import { divisionRules } from './source-division.js';
import { foldShiftIdiom, shiftIdiomScope } from './source-shifts.js';

export type Make = (
  key: string,
  type: DataType,
  block: string,
  expression?: Expression,
  contributors?: readonly Value[],
) => Value;

/** One normalization site: a value whose operands are already identity-resolved. */
export interface RuleSite {
  readonly value: Value;
  /** The current definition with identity-resolved operands. */
  readonly expression: Expression;
  readonly block: string;
  readonly view: 'source' | 'checked';
  readonly context: OperationContext;
  /** Reads a definition and records it as a dependency of this site. */
  observe(id: string): Expression | undefined;
  /** Follows same-type bitcasts to their origin. */
  resolve(value: Value): Value;
  /** The proven constant of a value (after identity resolution), or null. */
  constant(value: Value): bigint | null;
  /** A definition derived from (and recorded as depending on) this site. */
  create: Make;
  /** The low `width` bits of `value` (itself when already that wide). */
  narrow(value: Value, width: number): Value;
  /** A constant of `type` derived from this site. */
  literal(type: DataType, bits: bigint, key: string): Value;
  /** Multiplications/shifts that pack lanes of a register-cell join. */
  readonly packingShifts: Set<string>;
  /** Exact pre-lowering join of a lowered masked insert, by value. */
  readonly packedSources: ReadonlyMap<string, Expression>;
}

/** How a rule's result is established before it is applied:
 * - `structural`: exact bit wiring (identity resolution, slice/extension
 *   reselection, recombination). The independent BDD check may veto it while
 *   its allowance remains; it is applied once the allowance is exhausted.
 * - `bitvector`: arithmetic restatement the BDD check must not refute; once
 *   the allowance is exhausted the original form is kept.
 * - `own`: the rule's side conditions are its proof (exhaustive outcome tables,
 *   exact identities with width/sign side conditions, each pinned by
 *   counterexample tests at the boundaries); the BDD does not model it. */
export type RuleProof = 'structural' | 'bitvector' | 'own';

export interface ExpressionRule {
  /** Presentation record rule id, or null for unrecorded exact wiring. */
  readonly name: string | null;
  readonly scope: string;
  readonly proof: RuleProof;
  readonly views: readonly RuleSite['view'][];
  /** Packing/cell rewrite: keep the exact pre-lowering join for later slices. */
  readonly cell?: boolean;
  apply(site: RuleSite): Expression | null;
}

const bitcast = (value: Value): Expression => ({ kind: 'cast', op: 'bitcast', value });

/** x*k or x<<k with a constant k: the scaled value and its coefficient. */
function scaled(site: RuleSite, value: Value): { value: Value; coefficient: bigint } | null {
  const expression = site.observe(site.resolve(value).id);
  if (expression?.kind !== 'integer') return null;
  if (expression.op === 'mul') {
    const left = site.constant(expression.left),
      right = site.constant(expression.right);
    if (right !== null) return { value: site.resolve(expression.left), coefficient: right };
    if (left !== null) return { value: site.resolve(expression.right), coefficient: left };
  }
  if (expression.op === 'shl') {
    const count = site.constant(expression.right);
    if (count !== null)
      return {
        value: site.resolve(expression.left),
        coefficient: count >= BigInt(bitWidth(value.type)) ? 0n : 1n << count,
      };
  }
  return null;
}

/** x + k*x (either order) over one SSA value x: never reassociation of others. */
function selfScaledSum(
  site: RuleSite,
  expression: Extract<Expression, { kind: 'integer' }>,
): { value: Value; coefficient: bigint } | null {
  const left = scaled(site, expression.left),
    right = scaled(site, expression.right);
  return right?.value.id === expression.left.id
    ? right
    : left?.value.id === expression.right.id
      ? left
      : null;
}

/** k must read as a multiplier: 2 <= k < 2^(width-1), never a negated/wrapped one. */
const multiplier = (base: Value, coefficient: bigint, width: number): boolean =>
  bitWidth(base.type) === width && coefficient >= 2n && coefficient < 1n << BigInt(width - 1);

const constantFold: ExpressionRule = {
  name: null,
  scope: 'every operand is a constant: the IR evaluation of the operation',
  proof: 'bitvector',
  views: ['source', 'checked'],
  apply(site) {
    const operands = expressionOperands(site.expression);
    site.context.checkpoint(operands.length);
    if (
      site.expression.kind === 'constant' ||
      !operands.length ||
      !operands.every((operand) => site.observe(operand.id)?.kind === 'constant')
    )
      return null;
    const evaluated = evaluateExpression(site.value.type, site.expression, (operand) => {
      const constant = site.observe(operand.id)!;
      return constant.kind === 'constant'
        ? { kind: 'bits', bits: constant.bits }
        : { kind: 'unknown', reason: 'nonconstant source operand' };
    });
    // Undefined operations (division by zero) stay explicit.
    return evaluated.kind === 'bits' ? { kind: 'constant', bits: evaluated.bits } : null;
  },
};

const conditionFlags: ExpressionRule = {
  name: 'condition_flags',
  scope:
    'compare flags and their condition-code consumers (NZCV/EFLAGS bits, conditional compares, cset/csel/setcc/cmov selects, FP compare flags) as native relational predicates joined by && and ||; exact over every feasible equal/unsigned/signed/wrapped-sign outcome and IEEE less/equal/greater/unordered outcome; a condition depending on the wrapped sign or overflow alone keeps its flag helper',
  proof: 'own',
  views: ['source'],
  apply: (site) =>
    foldSourceCondition(
      site.value,
      site.expression,
      site.observe,
      site.resolve,
      site.create,
      site.block,
      site.context,
    ),
};

const cellRecombination: ExpressionRule = {
  name: 'register_cell_recombination',
  scope:
    'bounded integer DAG wiring preserves every bit and ordered opaque dependencies; contiguous slices, zero extension, masked inserts and power-of-two packing shifts only',
  proof: 'structural',
  views: ['source'],
  cell: true,
  apply: (site) =>
    recombineBitSlices(
      site.value,
      site.expression,
      site.observe,
      site.create,
      site.block,
      site.context,
      site.packingShifts,
    ),
};

/** Same-width extensions/truncations are the operand; a truncation is the low slice. */
const castWiring: ExpressionRule = {
  name: null,
  scope: 'same-width extension or truncation is the operand; a truncation is its low slice',
  proof: 'structural',
  views: ['source', 'checked'],
  apply({ value, expression }) {
    if (expression.kind !== 'cast' || value.type.kind !== 'integer') return null;
    if (
      ['truncate', 'zero_extend', 'sign_extend'].includes(expression.op) &&
      sameType(value.type, expression.value.type)
    )
      return bitcast(expression.value);
    return expression.op === 'truncate'
      ? { kind: 'extract', value: expression.value, offset: 0 }
      : null;
  },
};

const packingShift: ExpressionRule = {
  name: 'register_cell_recombination',
  scope:
    'bounded integer DAG wiring preserves every bit and ordered opaque dependencies; contiguous slices, zero extension, masked inserts and power-of-two packing shifts only',
  proof: 'bitvector',
  views: ['source'],
  cell: true,
  apply(site) {
    const { value, expression } = site;
    if (
      expression.kind !== 'integer' ||
      expression.op !== 'mul' ||
      value.type.kind !== 'integer' ||
      !site.packingShifts.has(value.id)
    )
      return null;
    const coefficient = site.constant(expression.right);
    if (coefficient === null || coefficient <= 1n || (coefficient & (coefficient - 1n)) !== 0n)
      return null;
    return {
      kind: 'integer',
      op: 'shl',
      left: expression.left,
      right: site.literal(
        value.type,
        BigInt(coefficient.toString(2).length - 1),
        `integer-factor:${value.id}`,
      ),
    };
  },
};

/** Checked view: constant shifts read as multiplications by 2^k. */
const checkedShiftProduct: ExpressionRule = {
  name: null,
  scope: 'x << k for a constant k is x * 2^k modulo 2^width',
  proof: 'bitvector',
  views: ['checked'],
  apply(site) {
    const { value, expression } = site;
    if (expression.kind !== 'integer' || expression.op !== 'shl' || value.type.kind !== 'integer')
      return null;
    const count = site.constant(expression.right);
    if (count === null) return null;
    return {
      kind: 'integer',
      op: 'mul',
      left: expression.left,
      right: site.literal(
        value.type,
        count >= BigInt(value.type.bits) ? 0n : 1n << count,
        `integer-factor:${value.id}`,
      ),
    };
  },
};

/** Checked view: x + k*x over one value is x * (k + 1). */
const checkedScaledSum: ExpressionRule = {
  name: null,
  scope: 'x + k*x over one SSA value x is x * (k + 1) modulo 2^width',
  proof: 'bitvector',
  views: ['checked'],
  apply(site) {
    const { value, expression } = site;
    if (expression.kind !== 'integer' || expression.op !== 'add' || value.type.kind !== 'integer')
      return null;
    const matched = selfScaledSum(site, expression);
    return matched
      ? {
          kind: 'integer',
          op: 'mul',
          left: matched.value,
          right: site.literal(value.type, matched.coefficient + 1n, `integer-factor:${value.id}`),
        }
      : null;
  },
};

const strengthReducedMultiply: ExpressionRule = {
  name: 'strength_reduced_multiply',
  scope:
    'x + x, x + (x << k), x + x*c, (x << k) - x and x*c - x over one SSA value x of the result width are x*2, x*(2^k + 1), x*(c + 1), x*(2^k - 1) and x*(c - 1): distributivity modulo 2^width, so the printed width-bit product equals the sum or difference; both operands are the identical value x (no operand is duplicated or dropped), and the folded constant must lie in [2, 2^(width-1)) so it reads as a multiplier',
  proof: 'own',
  views: ['source'],
  apply(site) {
    const { value, expression } = site;
    if (expression.kind !== 'integer' || value.type.kind !== 'integer') return null;
    const width = value.type.bits;
    let matched: { value: Value; coefficient: bigint } | null = null;
    if (expression.op === 'add') {
      const sum = selfScaledSum(site, expression);
      if (sum) matched = { value: sum.value, coefficient: sum.coefficient + 1n };
      else if (expression.left.id === expression.right.id)
        matched = { value: expression.left, coefficient: 2n };
    } else if (expression.op === 'sub') {
      const product = site.observe(expression.left.id);
      const minuend =
        product?.kind === 'integer' && (product.op === 'mul' || product.op === 'shl')
          ? scaled(site, expression.left)
          : null;
      if (minuend?.value.id === expression.right.id)
        matched = { value: minuend.value, coefficient: minuend.coefficient - 1n };
    }
    if (!matched) return null;
    const coefficient = BigInt.asUintN(width, matched.coefficient);
    return multiplier(matched.value, coefficient, width)
      ? {
          kind: 'integer',
          op: 'mul',
          left: matched.value,
          right: site.literal(value.type, coefficient, `integer-factor:${value.id}`),
        }
      : null;
  },
};

/** (x*c1)*c2, (x*c1) << k and (x << k)*c of one value are x times the product of
 * the constants: multiplication modulo 2^width is associative and x << k is
 * x * 2^k. Only an operand that is itself a product folds, and the folded
 * constant must read as a multiplier. */
const constantProduct: ExpressionRule = {
  name: 'constant_product',
  scope:
    '(x*c1)*c2, (x*c1) << k and (x << k)*c of one SSA value x at the result width are x*(c1*c2), x*(c1*2^k) and x*(2^k*c) modulo 2^width (associativity of modular multiplication; x << k is x*2^k for k < width); one operand is a constant-scaled product of x, and the folded constant lies in [2, 2^(width-1))',
  proof: 'own',
  views: ['source'],
  apply(site) {
    const { value, expression } = site;
    if (
      expression.kind !== 'integer' ||
      value.type.kind !== 'integer' ||
      (expression.op !== 'mul' && expression.op !== 'shl') ||
      site.packingShifts.has(value.id)
    )
      return null;
    const width = value.type.bits;
    const constant =
      expression.op === 'shl'
        ? (() => {
            const count = site.constant(expression.right);
            return count === null || count >= BigInt(width) ? null : 1n << count;
          })()
        : site.constant(expression.right);
    if (constant === null) return null;
    const inner = site.observe(site.resolve(expression.left).id);
    if (
      inner?.kind !== 'integer' ||
      (inner.op !== 'mul' && inner.op !== 'shl') ||
      site.packingShifts.has(site.resolve(expression.left).id) ||
      (expression.op === 'shl' && inner.op === 'shl')
    )
      return null;
    const product = scaled(site, expression.left);
    if (!product || bitWidth(product.value.type) !== width) return null;
    const coefficient = BigInt.asUintN(width, product.coefficient * constant);
    return multiplier(product.value, coefficient, width)
      ? {
          kind: 'integer',
          op: 'mul',
          left: product.value,
          right: site.literal(value.type, coefficient, `integer-factor:${value.id}`),
        }
      : null;
  },
};

/** (x & c1) & c2 is x & (c1 & c2): conjunction is associative. */
const combinedMask: ExpressionRule = {
  name: 'combined_mask',
  scope:
    '(x & c1) & c2 for constants c1, c2 at one width is x & (c1 & c2): bitwise conjunction is associative and commutative',
  proof: 'own',
  views: ['source'],
  apply(site) {
    const { value, expression } = site;
    if (expression.kind !== 'integer' || expression.op !== 'and' || value.type.kind !== 'integer')
      return null;
    const outer = site.constant(expression.right);
    if (outer === null) return null;
    const inner = site.observe(site.resolve(expression.left).id);
    if (inner?.kind !== 'integer' || inner.op !== 'and') return null;
    const [masked, mask] =
      site.constant(inner.right) !== null
        ? [inner.left, site.constant(inner.right)!]
        : site.constant(inner.left) !== null
          ? [inner.right, site.constant(inner.left)!]
          : [null, null];
    if (!masked || mask === null || site.constant(masked) !== null) return null;
    return {
      kind: 'integer',
      op: 'and',
      left: masked,
      right: site.literal(value.type, outer & mask, `combined-mask:${value.id}`),
    };
  },
};

/** Whether `part` provably equals the low `bits` bits of `whole`: a low slice
 * of it, the same constant modulo 2^bits, or the same add/sub/mul/and/or/xor
 * (or shift left by a constant below `bits`) of operands that are themselves
 * the low bits of the whole operation's operands (carries and partial products
 * only move upward), through extensions of a value at least `bits` wide. */
function lowBitsOf(site: RuleSite, part: Value, whole: Value, bits: number, depth = 0): boolean {
  site.context.checkpoint(1);
  part = site.resolve(part);
  whole = site.resolve(whole);
  if (part.id === whole.id) return bitWidth(part.type) >= bits;
  if (depth > 8) return false;
  const constant = site.constant(part);
  if (constant !== null) {
    const other = site.constant(whole);
    return other !== null && BigInt.asUintN(bits, constant) === BigInt.asUintN(bits, other);
  }
  const p = site.observe(part.id),
    w = site.observe(whole.id);
  if (
    p &&
    ((p.kind === 'extract' && p.offset === 0) || (p.kind === 'cast' && p.op === 'truncate')) &&
    bitWidth(part.type) >= bits &&
    lowBitsOf(site, p.value, whole, bits, depth + 1)
  )
    return true;
  if (
    w &&
    ((w.kind === 'cast' && ['zero_extend', 'sign_extend', 'truncate'].includes(w.op)) ||
      (w.kind === 'extract' && w.offset === 0)) &&
    bitWidth(w.value.type) >= bits
  )
    return lowBitsOf(site, part, w.value, bits, depth + 1);
  if (
    p?.kind !== 'integer' ||
    w?.kind !== 'integer' ||
    p.op !== w.op ||
    bitWidth(part.type) < bits ||
    bitWidth(whole.type) < bits
  )
    return false;
  if (['add', 'sub', 'mul', 'and', 'or', 'xor'].includes(p.op))
    return (
      lowBitsOf(site, p.left, w.left, bits, depth + 1) &&
      lowBitsOf(site, p.right, w.right, bits, depth + 1)
    );
  if (p.op === 'shl') {
    const count = site.constant(p.right);
    return (
      count !== null &&
      count < BigInt(bits) &&
      site.constant(w.right) === count &&
      lowBitsOf(site, p.left, w.left, bits, depth + 1)
    );
  }
  return false;
}

/** concat(L, slices [k, w) of v) where L is the low k bits of v recomputed at
 * k bits (an x86 8-bit operation merged back into its register) is the low w
 * bits of v. */
const recomputedLowPart: ExpressionRule = {
  name: 'recomputed_low_part',
  scope:
    'a join whose lowest part provably equals the low k bits of a value v (the same modular add/sub/mul/bitwise operations over the low bits of the same operands) and whose other parts are the consecutive slices of v from bit k is the low bits of v',
  proof: 'own',
  views: ['source'],
  apply(site) {
    const { value, expression } = site;
    if (
      expression.kind !== 'concat' ||
      expression.values.length < 2 ||
      value.type.kind !== 'integer'
    )
      return null;
    const [low, ...rest] = expression.values as [Value, ...Value[]];
    let base: Value | null = null,
      offset = bitWidth(low.type);
    for (const part of rest) {
      const definition = site.observe(site.resolve(part).id);
      if (
        definition?.kind !== 'extract' ||
        definition.offset !== offset ||
        (base && site.resolve(base).id !== site.resolve(definition.value).id)
      )
        return null;
      base = definition.value;
      offset += bitWidth(part.type);
    }
    if (
      !base ||
      offset !== bitWidth(value.type) ||
      bitWidth(base.type) < offset ||
      !lowBitsOf(site, low, base, bitWidth(low.type))
    )
      return null;
    return sameType(value.type, base.type)
      ? bitcast(base)
      : { kind: 'extract', value: base, offset: 0 };
  },
};

/** Outcomes of comparing x with 0 (signed): less 1, equal 2, greater 4. */
const SIGNED_ZERO_OUTCOMES: Partial<Record<IntegerPredicate, number>> = {
  eq: 2,
  ne: 5,
  slt: 1,
  sle: 3,
  sgt: 4,
  sge: 6,
};

/** a || b and a && b of two tests of one value against zero (signed
 * comparisons, equality, or its sign bit: bit w-1 is x < 0) are the one
 * comparison holding exactly on the union or intersection of their
 * less/equal/greater outcomes (-O0 `jle` after `cmp x, 0` lifts as ZF || SF). */
const signedZeroTests: ExpressionRule = {
  name: 'signed_zero_test',
  scope:
    'a disjunction or conjunction of two tests of one value x against zero, each a signed comparison, an equality, or the sign bit (bit w-1 of x is 1 exactly when x < 0 signed), is the single signed comparison with zero whose less/equal/greater outcomes are their union or intersection, exact over all three outcomes',
  proof: 'own',
  views: ['source'],
  apply(site) {
    const { value, expression } = site;
    if (
      expression.kind !== 'integer' ||
      (expression.op !== 'or' && expression.op !== 'and') ||
      bitWidth(value.type) !== 1
    )
      return null;
    /** A test of the low `bits` bits of `root` against zero: its outcomes and,
     * from a comparison, that `bits`-bit operand. */
    type Test = { root: string; bits: number; operand: Value | null; outcomes: number };
    const test = (operand: Value, depth = 0): Test | null => {
      const definition = site.observe(site.resolve(operand).id);
      if (definition?.kind === 'integer_unary' && definition.op === 'not' && depth < 4) {
        const inner = test(definition.value, depth + 1);
        return inner && { ...inner, outcomes: 7 ^ inner.outcomes };
      }
      if (
        definition?.kind === 'extract' &&
        definition.value.type.kind === 'integer' &&
        [8, 16, 32, 64].includes(definition.offset + 1)
      )
        return {
          root: site.resolve(definition.value).id,
          bits: definition.offset + 1,
          operand:
            definition.offset + 1 === definition.value.type.bits
              ? site.resolve(definition.value)
              : null,
          outcomes: 1,
        };
      if (definition?.kind !== 'compare' || site.constant(definition.right) !== 0n) return null;
      const outcomes = SIGNED_ZERO_OUTCOMES[definition.op];
      if (outcomes === undefined) return null;
      const x = site.resolve(definition.left),
        slice = site.observe(x.id);
      return {
        root: slice?.kind === 'extract' && slice.offset === 0 ? site.resolve(slice.value).id : x.id,
        bits: bitWidth(x.type),
        operand: x,
        outcomes,
      };
    };
    const left = test(expression.left),
      right = test(expression.right);
    if (!left || !right || left.root !== right.root || left.bits !== right.bits) return null;
    const x = left.operand ?? right.operand;
    if (!x) return null;
    const outcomes =
      expression.op === 'or' ? left.outcomes | right.outcomes : left.outcomes & right.outcomes;
    // Always or never: x may be indeterminate, so the tests stay.
    if (outcomes === 0 || outcomes === 7) return null;
    const op = (Object.keys(SIGNED_ZERO_OUTCOMES) as IntegerPredicate[]).find(
      (key) => SIGNED_ZERO_OUTCOMES[key] === outcomes,
    )!;
    return {
      kind: 'compare',
      op,
      left: x,
      right: site.literal(x.type, 0n, `signed-zero:${value.id}`),
    };
  },
};

/** 0 - x is -x: two's-complement negation modulo 2^width. */
const zeroMinus: ExpressionRule = {
  name: 'zero_minus_negation',
  scope: "0 - x is -x modulo 2^width (two's-complement negation is subtraction from zero)",
  proof: 'own',
  views: ['source'],
  apply(site) {
    const { expression } = site;
    return expression.kind === 'integer' &&
      expression.op === 'sub' &&
      site.constant(expression.left) === 0n &&
      site.constant(expression.right) === null
      ? { kind: 'integer_unary', op: 'neg', value: expression.right }
      : null;
  },
};

/** c OP x for a commutative OP is x OP c: the constant reads on the right. */
const constantRight: ExpressionRule = {
  name: 'constant_operand_right',
  scope:
    'c + x (c below 0x1000), c * x, c & x, c | x and c ^ x with a constant c and a non-constant x are x + c, x * c, x & c, x | c and x ^ c: the operations are commutative over bit vectors',
  proof: 'own',
  views: ['source'],
  apply(site) {
    const { expression } = site;
    const constant = expression.kind === 'integer' ? site.constant(expression.left) : null;
    if (
      expression.kind !== 'integer' ||
      !['add', 'mul', 'and', 'or', 'xor'].includes(expression.op) ||
      constant === null ||
      site.constant(expression.right) !== null ||
      // A large addend reads as a base address (`0x1000 + index`).
      (expression.op === 'add' && constant >= 0x1000n)
    )
      return null;
    return { ...expression, left: expression.right, right: expression.left };
  },
};

/** Slices of slices, extensions, inserts and joins select the same bits directly. */
const sliceWiring: ExpressionRule = {
  name: null,
  scope: 'a slice of a slice, extension, inserted lane or join part is that slice of its origin',
  proof: 'structural',
  views: ['source', 'checked'],
  apply(site) {
    const { value, expression } = site;
    if (expression.kind !== 'extract') return null;
    const observed = site.observe(expression.value.id),
      source = site.packedSources.get(expression.value.id) ?? observed,
      width = bitWidth(value.type);
    if (expression.offset === 0 && sameType(value.type, expression.value.type))
      return bitcast(expression.value);
    if (source?.kind === 'extract')
      return { kind: 'extract', value: source.value, offset: source.offset + expression.offset };
    if (
      source?.kind === 'cast' &&
      (source.op === 'zero_extend' || source.op === 'sign_extend') &&
      expression.offset + width <= bitWidth(source.value.type)
    )
      return { kind: 'extract', value: source.value, offset: expression.offset };
    if (
      source?.kind === 'insert' &&
      expression.offset >= source.offset &&
      expression.offset + width <= source.offset + bitWidth(source.value.type)
    )
      return { kind: 'extract', value: source.value, offset: expression.offset - source.offset };
    if (source?.kind === 'concat') {
      let offset = 0;
      for (const part of source.values) {
        site.context.checkpoint(1);
        if (
          expression.offset >= offset &&
          expression.offset + width <= offset + bitWidth(part.type)
        )
          return { kind: 'extract', value: part, offset: expression.offset - offset };
        offset += bitWidth(part.type);
      }
    }
    return null;
  },
};

/** select(sign bit, K1, K2), optionally masked by a constant: the vacated-bit
 * fill of an arithmetic shift lowered as a logical shift. */
function signFill(site: RuleSite, operand: Value): boolean {
  let definition = site.observe(site.resolve(operand).id);
  if (definition?.kind === 'integer' && definition.op === 'and') {
    const masked =
      site.constant(definition.right) !== null
        ? definition.left
        : site.constant(definition.left) !== null
          ? definition.right
          : null;
    definition = masked ? site.observe(site.resolve(masked).id) : undefined;
  }
  if (
    definition?.kind !== 'select' ||
    site.constant(definition.when_true) === null ||
    site.constant(definition.when_false) === null
  )
    return false;
  const test = site.observe(site.resolve(definition.condition).id);
  return test?.kind === 'extract' && test.offset === bitWidth(test.value.type) - 1;
}

/** The low bits of add/sub/mul/and/or/xor (and of a shift left by a count below
 * the narrow width) depend only on the low bits of the operands: carries and
 * partial products only propagate upward. */
function narrowLowBits(site: RuleSite): Expression | null {
  const { value, expression } = site;
  if (expression.kind !== 'extract' || expression.offset !== 0) return null;
  const source = site.packedSources.get(expression.value.id) ?? site.observe(expression.value.id),
    width = bitWidth(value.type);
  if (source?.kind !== 'integer') return null;
  // A sign-filled logical shift is an arithmetic shift at its own width (the
  // shift idiom folds it there); narrowing it first would split the idiom.
  if (
    site.view === 'source' &&
    source.op === 'or' &&
    (signFill(site, source.left) || signFill(site, source.right))
  )
    return null;
  const narrowable =
    ['add', 'sub', 'mul', 'and', 'or', 'xor'].includes(source.op) ||
    (site.view === 'source' &&
      source.op === 'shl' &&
      (site.constant(source.right) ?? BigInt(width)) < BigInt(width));
  return narrowable
    ? {
        ...source,
        left: site.narrow(source.left, width),
        right: site.narrow(source.right, width),
      }
    : null;
}

const lowBitsScope =
  'the low w bits of x+y, x-y, x*y, x&y, x|y, x^y and x<<c (c<w) are the w-bit operation of the low w bits of the operands: carries and partial products only propagate toward higher bits';

const lowBitsNarrowing: ExpressionRule = {
  name: 'low_bits_narrowing',
  scope: lowBitsScope,
  proof: 'own',
  views: ['source'],
  apply: narrowLowBits,
};

/** Checked view: the same narrowing, each candidate re-proved by the BDD. */
const checkedLowBitsNarrowing: ExpressionRule = {
  name: null,
  scope: lowBitsScope,
  proof: 'bitvector',
  views: ['checked'],
  apply: narrowLowBits,
};

/** Checked view: a join of consecutive slices of one value is that value; a join
 * whose upper parts are constant zero is the zero extension of its lowest part. */
const checkedJoin: ExpressionRule = {
  name: null,
  scope: 'a join of consecutive slices of one value is that value; zero upper parts extend',
  proof: 'bitvector',
  views: ['checked'],
  apply(site) {
    const { value, expression } = site;
    if (expression.kind !== 'concat' || !expression.values.length) return null;
    let offset = 0,
      base: Value | null = null,
      complete = true;
    for (const part of expression.values) {
      const extraction = site.observe(part.id);
      if (
        extraction?.kind !== 'extract' ||
        extraction.offset !== offset ||
        (base && base.id !== extraction.value.id)
      ) {
        complete = false;
        break;
      }
      base = extraction.value;
      offset += bitWidth(part.type);
    }
    if (complete && base && sameType(value.type, base.type)) return bitcast(base);
    return expression.values.slice(1).every((part) => {
      const definition = site.observe(part.id);
      return definition?.kind === 'constant' && definition.bits === 0n;
    })
      ? { kind: 'cast', op: 'zero_extend', value: expression.values[0]! }
      : null;
  },
};

/** The zero flag of x + c with no carry-in is x == -c. */
const zeroSumFlag: ExpressionRule = {
  name: null,
  scope: 'the zero flag of x + c without carry is x == -c modulo 2^width',
  proof: 'bitvector',
  views: ['source', 'checked'],
  apply(site) {
    const { value, expression } = site;
    if (expression.kind !== 'flag' || expression.op !== 'add' || expression.flag !== 'zero')
      return null;
    const right = site.observe(expression.right.id),
      carry = site.observe(expression.carry.id);
    if (right?.kind !== 'constant' || carry?.kind !== 'constant' || carry.bits !== 0n) return null;
    return {
      kind: 'compare',
      op: 'eq',
      left: expression.left,
      right: site.create(
        `zero-add:${value.id}`,
        expression.left.type,
        site.block,
        { kind: 'constant', bits: BigInt.asUintN(bitWidth(expression.left.type), -right.bits) },
        [value],
      ),
    };
  },
};

const wholeJoin: ExpressionRule = {
  name: null,
  scope: 'the slices of one value joined back in order are that value (zero-extended)',
  proof: 'structural',
  views: ['source'],
  apply: (site) => wholeValueConcat(site.value, site.expression, site.observe),
};

const shiftIdiom: ExpressionRule = {
  name: 'shift_idiom',
  scope: shiftIdiomScope,
  proof: 'own',
  views: ['source'],
  apply: (site) =>
    foldShiftIdiom(
      site.value,
      site.expression,
      site.observe,
      site.resolve,
      site.constant,
      site.create,
      site.block,
    ),
};

const integerIdentityRule: ExpressionRule = {
  name: 'integer_identity',
  scope:
    'same-width integer operation with a proven neutral operand or two identical operands (x&x, x|x, x&ones, x|0, x+0, x^0, x*1, x<<0) is exactly that operand; operands that could carry an unknown (x^x, x-x, x*0) are never dropped',
  proof: 'structural',
  views: ['source'],
  apply(site) {
    const { value, expression } = site;
    if (expression.kind !== 'integer' || value.type.kind !== 'integer') return null;
    const operand = integerIdentity(
      value.type,
      expression,
      site.constant(expression.left),
      site.constant(expression.right),
      true,
    );
    return operand ? bitcast(operand) : null;
  },
};

const extensionFold: ExpressionRule = {
  name: 'extension_fold',
  scope:
    'sign extension of a strictly narrower zero extension: the sign bit is zero, so it is the zero extension of the original operand',
  proof: 'bitvector',
  views: ['source'],
  apply(site) {
    const { expression } = site;
    if (expression.kind !== 'cast' || expression.op !== 'sign_extend') return null;
    const inner = site.observe(expression.value.id);
    return inner?.kind === 'cast' &&
      inner.op === 'zero_extend' &&
      bitWidth(inner.value.type) < bitWidth(expression.value.type)
      ? { kind: 'cast', op: 'zero_extend', value: inner.value }
      : null;
  },
};

const swapped: Record<IntegerPredicate, IntegerPredicate> = {
  eq: 'eq',
  ne: 'ne',
  ult: 'ugt',
  ule: 'uge',
  ugt: 'ult',
  uge: 'ule',
  slt: 'sgt',
  sle: 'sge',
  sgt: 'slt',
  sge: 'sle',
};

/** Comparisons read with the variable on the left and the narrowest operands:
 * c OP x is x OP' c; a comparison of two equal-width zero (sign) extensions is the
 * unsigned (signed) or equality comparison of the operands, and of one extension
 * with a constant inside the narrow range is the comparison with the narrowed
 * constant. Extensions are injective and preserve that order exactly. */
const compareCanonical: ExpressionRule = {
  name: 'compare_canonical',
  scope:
    'c OP x is x OP-swapped c; zext(a) OP zext(b) for equality/unsigned OP and sext(a) OP sext(b) for equality/signed OP are a OP b (extensions are injective and order-preserving); one side a constant representable in the narrow width (unsigned for zero, signed for sign extension) compares with its narrowed constant',
  proof: 'own',
  views: ['source'],
  apply(site) {
    const { value, expression } = site;
    if (expression.kind !== 'compare') return null;
    const left = site.constant(expression.left),
      right = site.constant(expression.right);
    if (left !== null && right === null)
      return {
        kind: 'compare',
        op: swapped[expression.op],
        left: expression.right,
        right: expression.left,
      };
    const extension = (operand: Value) => {
      const definition = site.observe(site.resolve(operand).id);
      return definition?.kind === 'cast' &&
        (definition.op === 'zero_extend' || definition.op === 'sign_extend')
        ? { op: definition.op, value: definition.value }
        : null;
    };
    const equality = expression.op === 'eq' || expression.op === 'ne',
      signed = expression.op.startsWith('s');
    const a = extension(expression.left);
    if (!a || (!equality && signed !== (a.op === 'sign_extend'))) return null;
    const narrow = bitWidth(a.value.type);
    if (right !== null) {
      const wide = bitWidth(expression.right.type);
      const representable =
        a.op === 'zero_extend'
          ? right < 1n << BigInt(narrow)
          : BigInt.asIntN(wide, right) >= -(1n << BigInt(narrow - 1)) &&
            BigInt.asIntN(wide, right) < 1n << BigInt(narrow - 1);
      if (!representable) return null;
      return {
        kind: 'compare',
        op: expression.op,
        left: a.value,
        right: site.literal(
          a.value.type,
          BigInt.asUintN(narrow, right),
          `narrowed-compare:${value.id}`,
        ),
      };
    }
    const b = extension(expression.right);
    return b && b.op === a.op && sameType(a.value.type, b.value.type)
      ? { kind: 'compare', op: expression.op, left: a.value, right: b.value }
      : null;
  },
};

/** The single expression rule pool, in priority order: the first rule that
 * applies at a site rewrites it, and the site is revisited to a fixpoint. */
export const EXPRESSION_RULES: readonly ExpressionRule[] = [
  conditionFlags,
  recomputedLowPart,
  cellRecombination,
  constantFold,
  castWiring,
  packingShift,
  checkedShiftProduct,
  checkedScaledSum,
  strengthReducedMultiply,
  constantProduct,
  ...divisionRules,
  sliceWiring,
  lowBitsNarrowing,
  checkedLowBitsNarrowing,
  checkedJoin,
  zeroSumFlag,
  wholeJoin,
  shiftIdiom,
  compareCanonical,
  integerIdentityRule,
  extensionFold,
  combinedMask,
  signedZeroTests,
  zeroMinus,
  constantRight,
];

/** Rules of one view, in pool order. */
export function viewRules(view: RuleSite['view']): readonly ExpressionRule[] {
  return EXPRESSION_RULES.filter((rule) => rule.views.includes(view));
}
