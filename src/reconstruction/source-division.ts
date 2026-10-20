import { bitWidth, integer, type Expression, type IntegerOp, type Value } from '../ir/index.js';
import type { ExpressionRule, RuleSite } from './source-rules.js';

/** The divisor d with floor(x * multiplier / 2^shift) == floor(x / d) for every
 * 0 <= x < 2^bits, or null. Exact closed form: with d = ceil(2^shift/multiplier)
 * and e = multiplier*d - 2^shift >= 0, x*multiplier/2^shift = x/d + x*e/(d*2^shift),
 * so the floors agree iff r + x*e/2^shift < d for x = q*d + r. For each residue r
 * the largest x is binding; over residues the binding cases are r = R = (2^bits-1)
 * mod d (x = 2^bits-1) and, when x can take residue d-1 below that, r = d-1. */
export function exactMagicDivisor(bits: number, multiplier: bigint, shift: number): bigint | null {
  if (multiplier < 1n || shift < 0 || bits < 1) return null;
  const power = 1n << BigInt(shift),
    largest = (1n << BigInt(bits)) - 1n,
    divisor = (power + multiplier - 1n) / multiplier,
    excess = multiplier * divisor - power;
  if (divisor < 1n || divisor > largest) return null;
  const residue = largest % divisor;
  if ((divisor - residue) * power <= largest * excess) return null;
  if (
    residue < divisor - 1n &&
    largest - residue >= divisor &&
    power <= (largest - residue - 1n) * excess
  )
    return null;
  return divisor;
}

/** floor((m*a + c) / 2^shift) == floor(m / d) for every integer lo <= m <= hi,
 * where 0 <= lo <= 1 <= hi, a >= 1, d >= 2 and e = a*d - 2^shift >= 0. Writing
 * m = q*d + r, (m*a + c)/2^shift = q + (q*e + r*a + c)/2^shift, so the floors agree
 * iff 0 <= q*e + r*a + c < 2^shift over every reachable (q, r). That is
 * nondecreasing in q and r: the maximum is at m = hi or at the largest m with
 * residue d-1, the minimum at m = lo or (lo = 1) at m = d. */
function floorsAgree(
  lo: bigint,
  hi: bigint,
  a: bigint,
  power: bigint,
  d: bigint,
  e: bigint,
  c: bigint,
): boolean {
  if (hi < lo) return true;
  const quotient = hi / d,
    residue = hi % d;
  if (quotient * e + residue * a + c >= power) return false;
  if (quotient >= 1n && residue < d - 1n && (quotient - 1n) * e + (d - 1n) * a + c >= power)
    return false;
  if (lo === 0n) return c >= 0n;
  return a + c >= 0n && (d > hi || e + c >= 0n);
}

/** The signed divisor d with floor(x*multiplier / 2^shift) + [x*multiplier < 0]
 * == trunc(x / d) for every `bits`-wide two's-complement x, or null; 2 <= |d| <
 * 2^(bits-1). With a = |multiplier| and d' = ceil(2^shift / a), the non-negative
 * products give floor(m*a/2^shift) and the negative ones -floor((m*a - 1)/2^shift)
 * for m = |x|, which must equal floor(m/d') over m's range on each side
 * (floorsAgree): for multiplier > 0, m in [0, 2^(bits-1)) and [1, 2^(bits-1)];
 * for multiplier < 0 (d = -d'), m in [0, 2^(bits-1)] and [1, 2^(bits-1)). */
export function exactSignedMagicDivisor(
  bits: number,
  multiplier: bigint,
  shift: number,
): bigint | null {
  if (multiplier === 0n || shift < 0 || bits < 2) return null;
  const a = multiplier < 0n ? -multiplier : multiplier,
    power = 1n << BigInt(shift),
    half = 1n << BigInt(bits - 1),
    divisor = (power + a - 1n) / a,
    excess = a * divisor - power;
  if (divisor < 2n || divisor >= half) return null;
  const [nonNegative, negative] = multiplier > 0n ? [half - 1n, half] : [half, half - 1n];
  if (
    !floorsAgree(0n, nonNegative, a, power, divisor, excess, 0n) ||
    !floorsAgree(1n, negative, a, power, divisor, excess, -1n)
  )
    return null;
  return multiplier > 0n ? divisor : -divisor;
}

/** v ≡ floor(x * multiplier / 2^shift) modulo 2^low for every `bits`-wide x
 * (unsigned, or two's complement when `signed`), with low at most v's width. */
interface Scaled {
  readonly x: Value;
  readonly bits: number;
  readonly signed: boolean;
  readonly multiplier: bigint;
  readonly shift: number;
  readonly low: number;
}

type Base = Pick<Scaled, 'x' | 'bits' | 'signed'>;

/** Smallest and largest floor(x*multiplier/2^shift) over x's range (monotone in x). */
function bounds(form: Scaled): readonly [bigint, bigint] {
  const [lo, hi] = form.signed
    ? [-(1n << BigInt(form.bits - 1)), (1n << BigInt(form.bits - 1)) - 1n]
    : [0n, (1n << BigInt(form.bits)) - 1n];
  const first = (lo * form.multiplier) >> BigInt(form.shift),
    last = (hi * form.multiplier) >> BigInt(form.shift);
  return first <= last ? [first, last] : [last, first];
}

/** The `width`-bit value is exactly the integer (unsigned or two's complement). */
function exact(form: Scaled, width: number, signed: boolean): boolean {
  if (form.low < width) return false;
  const [min, max] = bounds(form);
  return signed
    ? min >= -(1n << BigInt(width - 1)) && max < 1n << BigInt(width - 1)
    : min >= 0n && max < 1n << BigInt(width);
}

/** The same integer x: same interpretation and width, one value or low slices
 * of one value. */
const sameBase = (site: RuleSite, left: Base, right: Base): boolean =>
  left.signed === right.signed &&
  left.bits === right.bits &&
  lowRoot(site, left.x).id === lowRoot(site, right.x).id;

const sameForm = (site: RuleSite, left: Scaled, right: Scaled): boolean =>
  sameBase(site, left, right) && left.multiplier === right.multiplier && left.shift === right.shift;

/** Follows low slices (offset-0 extracts, truncations) to the sliced value. */
function lowRoot(site: RuleSite, value: Value): Value {
  let current = site.resolve(value);
  for (let depth = 0; depth < 8; depth++) {
    const definition = site.observe(current.id);
    if (
      !(definition?.kind === 'extract' && definition.offset === 0) &&
      !(definition?.kind === 'cast' && definition.op === 'truncate')
    )
      break;
    current = site.resolve(definition.value);
  }
  return current;
}

/** L such that m ≡ x (x's integer) modulo 2^L, or 0: low slices of one value
 * agree on their common width, a join agrees with its lowest part, and an
 * extension of x matching its interpretation is x exactly. */
function congruence(site: RuleSite, m: Value, base: Base, depth = 0): number {
  site.context.checkpoint(1);
  const width = bitWidth(m.type);
  if (lowRoot(site, m).id === lowRoot(site, base.x).id) return Math.min(width, base.bits);
  if (depth >= 4) return 0;
  const extended = extension(site, m);
  if (extended) {
    const inner = congruence(site, extended.inner, base, depth + 1),
      narrow = bitWidth(extended.inner.type);
    return inner >= narrow &&
      narrow === base.bits &&
      (extended.op === 'sign_extend') === base.signed
      ? width
      : Math.min(inner, narrow);
  }
  const definition = site.observe(site.resolve(m).id);
  if (
    (definition?.kind === 'extract' && definition.offset === 0) ||
    (definition?.kind === 'cast' && definition.op === 'truncate')
  )
    return Math.min(width, congruence(site, definition.value, base, depth + 1));
  if (definition?.kind === 'concat' && definition.values.length)
    return Math.min(
      bitWidth(definition.values[0]!.type),
      congruence(site, definition.values[0]!, base, depth + 1),
    );
  return 0;
}

const shifted = (form: Scaled | null, by: number, low: number): Scaled | null =>
  form && low > 0 ? { ...form, shift: form.shift + by, low } : null;

/** The value as an extension of a narrower q: ext(q), or q joined with the
 * upper part of ext(q) (how register cells spell an extended register). */
function extension(
  site: RuleSite,
  value: Value,
): { inner: Value; op: 'zero_extend' | 'sign_extend' } | null {
  const definition = site.observe(site.resolve(value).id);
  // The low part of a wider extension, still wider than q, extends q too.
  if (definition?.kind === 'extract' && definition.offset === 0) {
    const wider = site.observe(site.resolve(definition.value).id);
    if (
      wider?.kind === 'cast' &&
      (wider.op === 'zero_extend' || wider.op === 'sign_extend') &&
      bitWidth(value.type) > bitWidth(wider.value.type)
    )
      return { inner: wider.value, op: wider.op };
  }
  if (
    definition?.kind === 'cast' &&
    (definition.op === 'zero_extend' || definition.op === 'sign_extend')
  )
    return { inner: definition.value, op: definition.op };
  if (definition?.kind !== 'concat' || definition.values.length !== 2) return null;
  const [low, high] = definition.values as [Value, Value];
  const upper = site.observe(site.resolve(high).id);
  if (upper?.kind !== 'extract' || upper.offset !== bitWidth(low.type)) return null;
  const extended = site.observe(site.resolve(upper.value).id);
  return extended?.kind === 'cast' &&
    (extended.op === 'zero_extend' || extended.op === 'sign_extend') &&
    sameValue(site, extended.value, low)
    ? { inner: low, op: extended.op }
    : null;
}

/** x and its interpretation behind a multiplication operand: through nested
 * extensions of one kind (the first one decides signedness); x itself
 * (unsigned) when not extended. */
function extendedBase(site: RuleSite, factor: Value): Base {
  let x = site.resolve(factor),
    signed: boolean | null = null;
  for (let depth = 0; depth < 4; depth++) {
    const extended = extension(site, x);
    if (!extended || (signed !== null && (extended.op === 'sign_extend') !== signed)) break;
    signed = extended.op === 'sign_extend';
    x = site.resolve(extended.inner);
  }
  return { x, bits: bitWidth(x.type), signed: signed ?? false };
}

/** A join of parts holding consecutive bit ranges of one floor(x*M/2^s): the
 * top part's form shifted back by its offset, every lower part complete. A
 * lower part at shift 0 may multiply another spelling of x: x' ≡ x and M' ≡ M
 * modulo 2^len determine x*M modulo 2^len. */
function joinedForm(
  site: RuleSite,
  parts: readonly Value[],
  operand: (value: Value) => Scaled | null,
): Scaled | null {
  if (!parts.length) return null;
  const offsets: number[] = [];
  let offset = 0;
  for (const part of parts) {
    offsets.push(offset);
    offset += bitWidth(part.type);
  }
  const top = parts[parts.length - 1]!,
    topOffset = offsets[offsets.length - 1]!,
    form = operand(top);
  if (!form || form.shift < topOffset) return null;
  const whole: Scaled = {
    ...form,
    shift: form.shift - topOffset,
    low: topOffset + Math.min(form.low, bitWidth(top.type)),
  };
  for (const [index, part] of parts.slice(0, -1).entries()) {
    const lower = operand(part),
      length = bitWidth(part.type),
      at = whole.shift + offsets[index]!;
    if (!lower || lower.low < length) return null;
    const same =
      sameBase(site, lower, whole) && lower.multiplier === whole.multiplier && lower.shift === at;
    const congruent =
      at === 0 &&
      lower.shift === 0 &&
      congruence(site, lower.x, whole) >= length &&
      BigInt.asUintN(length, lower.multiplier) === BigInt.asUintN(length, whole.multiplier);
    if (!same && !congruent) return null;
  }
  return whole;
}

/** Operand forms already recognized during one site visit (definitions do not
 * change within a visit); bounds repeated work over shared subterms. */
const operandForms = new WeakMap<RuleSite, Map<string, Scaled | null>>();

/** Recognizes floor(x*M/2^s) sequences: a product of an (extended) x with a
 * constant, logical/arithmetic shifts, slices and extensions of it, x added or
 * subtracted (M ± 2^s), and the unsigned add-back form t + ((x - t) >> 1). Each
 * step keeps the exact integer when its range fits the step's width and
 * otherwise only the low bits it provably preserves. */
function scaledOf(site: RuleSite, expression: Expression, width: number, depth = 0): Scaled | null {
  site.context.checkpoint(1);
  if (depth > 10) return null;
  const operand = (value: Value): Scaled | null => {
    const resolved = site.resolve(value),
      definition = site.observe(resolved.id);
    if (!definition || value.type.kind !== 'integer') return null;
    let known = operandForms.get(site);
    if (!known) operandForms.set(site, (known = new Map()));
    const key = `${resolved.id}:${bitWidth(value.type)}`;
    if (known.has(key)) return known.get(key)!;
    const form = scaledOf(site, definition, bitWidth(value.type), depth + 1);
    known.set(key, form);
    return form;
  };
  switch (expression.kind) {
    case 'integer':
      switch (expression.op) {
        case 'mul':
          for (const [factor, scale] of [
            [expression.left, expression.right],
            [expression.right, expression.left],
          ] as const) {
            const constant = site.constant(scale);
            if (constant === null) continue;
            const base = extendedBase(site, factor),
              multiplier = base.signed ? BigInt.asIntN(width, constant) : constant;
            if (multiplier === 0n || base.x.type.kind !== 'integer') continue;
            // ext(x) * K ≡ x * M modulo 2^width for either interpretation.
            return { ...base, multiplier, shift: 0, low: width };
          }
          return null;
        case 'lshr':
        case 'ashr': {
          const count = site.constant(expression.right),
            form = operand(expression.left);
          if (count === null || !form || count >= BigInt(width)) return null;
          const by = Number(count);
          return shifted(
            form,
            by,
            exact(form, width, expression.op === 'ashr') ? width : Math.min(form.low, width) - by,
          );
        }
        case 'add':
        case 'sub':
          return offsetForm(site, expression, width, operand);
        default:
          return null;
      }
    case 'extract': {
      const form = operand(expression.value),
        source = bitWidth(expression.value.type);
      if (!form) return null;
      return shifted(
        form,
        expression.offset,
        exact(form, source, false)
          ? width
          : Math.min(width, Math.min(form.low, source) - expression.offset),
      );
    }
    case 'cast': {
      const form = operand(expression.value),
        source = bitWidth(expression.value.type);
      if (!form) return null;
      if (expression.op === 'truncate') return { ...form, low: Math.min(width, form.low) };
      if (expression.op === 'zero_extend' || expression.op === 'sign_extend')
        return {
          ...form,
          low: exact(form, source, expression.op === 'sign_extend')
            ? width
            : Math.min(form.low, source),
        };
      return null;
    }
    case 'concat':
      return joinedForm(site, expression.values, operand);
    default:
      return null;
  }
}

/** t ± x (multiplier ± 2^s) and the unsigned add-back form t + ((x - t) >> 1),
 * which is floor((x + t)/2) = floor(x*(2^s + M)/2^(s+1)). */
function offsetForm(
  site: RuleSite,
  expression: Extract<Expression, { kind: 'integer' }>,
  width: number,
  operand: (value: Value) => Scaled | null,
): Scaled | null {
  if (expression.op === 'add')
    for (const [high, half] of [
      [expression.left, expression.right],
      [expression.right, expression.left],
    ] as const) {
      const halving = site.observe(site.resolve(half).id);
      if (
        halving?.kind !== 'integer' ||
        halving.op !== 'lshr' ||
        site.constant(halving.right) !== 1n
      )
        continue;
      // The difference may be computed wider and sliced back to this width.
      const differenceValue = lowRoot(site, halving.left),
        difference = site.observe(differenceValue.id);
      if (difference?.kind !== 'integer' || difference.op !== 'sub') continue;
      const t = operand(high),
        subtrahend = t && !t.signed ? operand(difference.right) : null;
      if (!t || !subtrahend || !sameForm(site, t, subtrahend)) continue;
      const known = Math.min(
        congruence(site, difference.left, t),
        subtrahend.low,
        bitWidth(differenceValue.type),
        width,
      );
      // x - t is exact (0 <= x - t <= x < 2^width) when t <= x and x fits.
      const whole = known >= width && t.bits <= width && t.multiplier <= 1n << BigInt(t.shift);
      const low = Math.min(t.low, whole ? width : known - 1);
      if (low <= 0) continue;
      return {
        ...t,
        multiplier: (1n << BigInt(t.shift)) + t.multiplier,
        shift: t.shift + 1,
        low,
      };
    }
  for (const [term, other, sign] of expression.op === 'add'
    ? ([
        [expression.left, expression.right, 1n],
        [expression.right, expression.left, 1n],
      ] as const)
    : ([[expression.left, expression.right, -1n]] as const)) {
    const form = operand(term);
    if (!form) continue;
    const known = congruence(site, other, form),
      multiplier = form.multiplier + sign * (1n << BigInt(form.shift));
    if (known <= 0 || multiplier === 0n) continue;
    return { ...form, multiplier, low: Math.min(form.low, known, width) };
  }
  return null;
}

type DivisionOp = 'udiv' | 'sdiv' | 'urem' | 'srem';

/** v ≡ x OP divisor (C truncating division of x's integer) modulo 2^low. */
interface Division extends Base {
  readonly op: DivisionOp;
  readonly divisor: bigint;
  readonly low: number;
}

const quotientOp = (op: DivisionOp): boolean => op === 'udiv' || op === 'sdiv';

/** n with value == -n (0 - n or neg n), or null. */
function negated(site: RuleSite, value: Value): Value | null {
  const definition = site.observe(site.resolve(value).id);
  if (definition?.kind === 'integer_unary' && definition.op === 'neg') return definition.value;
  return definition?.kind === 'integer' &&
    definition.op === 'sub' &&
    site.constant(definition.left) === 0n
    ? definition.right
    : null;
}

/** The same `width`-bit value as x (identity, or low slices of one value). */
const sameValue = (site: RuleSite, value: Value, x: Value): boolean =>
  bitWidth(value.type) === bitWidth(x.type) && lowRoot(site, value).id === lowRoot(site, x).id;

/** Exact truth of `condition` for x = sample, when it is a signed comparison of
 * x (or -x when `negation`) with a constant, or the sign bit of one of those;
 * else null. Each such truth set is a half-line in x on any interval where -x
 * does not wrap, so testing an interval's endpoints decides it. */
function conditionAt(
  site: RuleSite,
  condition: Value,
  x: Value,
  sample: bigint,
  negation: boolean,
): boolean | null {
  const width = bitWidth(x.type);
  const of = (value: Value): bigint | null => {
    if (sameValue(site, value, x)) return sample;
    const inner = negation ? negated(site, value) : null;
    return inner && sameValue(site, inner, x) ? BigInt.asIntN(width, -sample) : null;
  };
  const definition = site.observe(site.resolve(condition).id);
  if (definition?.kind === 'extract' && definition.offset === width - 1) {
    const subject = bitWidth(definition.value.type) === width ? of(definition.value) : null;
    return subject === null ? null : subject < 0n;
  }
  if (definition?.kind !== 'compare') return null;
  let { op } = definition,
    subject = of(definition.left),
    bound = site.constant(definition.right);
  if (subject === null || bound === null) {
    subject = of(definition.right);
    bound = site.constant(definition.left);
    op = ({ slt: 'sgt', sle: 'sge', sgt: 'slt', sge: 'sle' } as const)[
      op as 'slt' | 'sle' | 'sgt' | 'sge'
    ];
  }
  if (subject === null || bound === null || op === undefined) return null;
  const limit = BigInt.asIntN(width, bound);
  switch (op) {
    case 'slt':
      return subject < limit;
    case 'sle':
      return subject <= limit;
    case 'sgt':
      return subject > limit;
    case 'sge':
      return subject >= limit;
    default:
      return null;
  }
}

/** `condition` is true for every x in each `truthy` interval and false in each
 * `falsy` one (half-line truth sets: endpoints decide). */
function decides(
  site: RuleSite,
  condition: Value,
  x: Value,
  truthy: readonly (readonly [bigint, bigint])[],
  falsy: readonly (readonly [bigint, bigint])[],
  negation: boolean,
): boolean {
  const all = (intervals: typeof truthy, expected: boolean): boolean =>
    intervals.every((interval) =>
      interval.every((sample) => conditionAt(site, condition, x, sample, negation) === expected),
    );
  return all(truthy, true) && all(falsy, false);
}

/** x and k when value == (x < 0 ? 2^k - 1 : 0) exactly for a same-width x:
 * (x >>s (w-1)) >>u (w-k), x >>u (w-1) (k = 1) or (x >>s (w-1)) & (2^k - 1). */
function biasOf(site: RuleSite, value: Value): { x: Value; k: number } | null {
  const width = bitWidth(value.type),
    definition = site.observe(site.resolve(value).id);
  if (definition?.kind !== 'integer') return null;
  const signMask = (operand: Value): Value | null => {
    const mask = site.observe(site.resolve(operand).id);
    return mask?.kind === 'integer' &&
      mask.op === 'ashr' &&
      bitWidth(mask.left.type) === width &&
      site.constant(mask.right) === BigInt(width - 1)
      ? mask.left
      : null;
  };
  if (definition.op === 'lshr') {
    const count = site.constant(definition.right);
    if (count === null || count < 1n || count >= BigInt(width)) return null;
    const x = count >= 2n ? signMask(definition.left) : null;
    if (x) return { x, k: width - Number(count) };
    return count === BigInt(width - 1) ? { x: definition.left, k: 1 } : null;
  }
  if (definition.op === 'and')
    for (const [mask, bits] of [
      [definition.left, definition.right],
      [definition.right, definition.left],
    ] as const) {
      const constant = site.constant(bits),
        x = signMask(mask);
      if (constant === null || !x) continue;
      const k = constant.toString(2).length;
      if (constant === (1n << BigInt(k)) - 1n && k < width - 1) return { x, k };
    }
  return null;
}

/** k when value == (x < 0 ? 2^k - 1 : 0) exactly. */
function biasTerm(site: RuleSite, value: Value, x: Value): number | null {
  const bias = biasOf(site, value);
  return bias && sameValue(site, bias.x, x) ? bias.k : null;
}

/** value ≡ (x < 0 ? 2^k - 1 : 0) modulo 2^k: the bias itself, or any slice at
 * least k wide of x's sign mask x >>s (w-1) (all ones exactly when x < 0). */
function biasModulo(site: RuleSite, value: Value, x: Value, k: number): boolean {
  if (biasTerm(site, value, x) === k) return true;
  const slice = site.observe(site.resolve(value).id);
  if (slice?.kind !== 'extract' || bitWidth(value.type) < k) return false;
  const mask = site.observe(site.resolve(slice.value).id),
    width = bitWidth(x.type);
  return (
    mask?.kind === 'integer' &&
    mask.op === 'ashr' &&
    site.constant(mask.right) === BigInt(width - 1) &&
    sameValue(site, mask.left, x)
  );
}

/** value modulo 2^bits as an integer combination of leaves (keyed by their low
 * root): sums, differences, constant multiples, masks keeping the low bits, and
 * slices or extensions at least `bits` wide; null when not linear. */
function linearLow(
  site: RuleSite,
  value: Value,
  bits: number,
  depth = 0,
): Map<string, { leaf: Value; coefficient: bigint }> | null {
  site.context.checkpoint(1);
  const modulus = 1n << BigInt(bits),
    terms = new Map<string, { leaf: Value; coefficient: bigint }>();
  if (bitWidth(value.type) < bits) return null;
  const add = (from: Map<string, { leaf: Value; coefficient: bigint }>, scale: bigint) => {
    for (const [key, term] of from) {
      const coefficient = BigInt.asUintN(
        bits,
        (terms.get(key)?.coefficient ?? 0n) + scale * term.coefficient,
      );
      if (coefficient === 0n) terms.delete(key);
      else terms.set(key, { leaf: term.leaf, coefficient });
    }
  };
  const leaf = () => {
    const root = lowRoot(site, value);
    terms.set(root.id, { leaf: root, coefficient: 1n });
    return terms;
  };
  if (depth > 6) return leaf();
  const definition = site.observe(site.resolve(value).id);
  const inner = (operand: Value) => linearLow(site, operand, bits, depth + 1);
  if (definition?.kind === 'constant') {
    const constant = BigInt.asUintN(bits, definition.bits);
    if (constant) terms.set('', { leaf: value, coefficient: constant });
    return terms;
  }
  if (
    (definition?.kind === 'extract' && definition.offset === 0) ||
    (definition?.kind === 'cast' &&
      ['truncate', 'zero_extend', 'sign_extend'].includes(definition.op))
  ) {
    const from = inner(definition.value);
    if (!from) return null;
    add(from, 1n);
    return terms;
  }
  if (definition?.kind !== 'integer') return leaf();
  const { op, left, right } = definition;
  if (op === 'add' || op === 'sub') {
    const a = inner(left),
      b = inner(right);
    if (!a || !b) return null;
    add(a, 1n);
    add(b, op === 'add' ? 1n : -1n);
    return terms;
  }
  if (op === 'and' || op === 'mul')
    for (const [term, factor] of [
      [left, right],
      [right, left],
    ] as const) {
      const constant = site.constant(factor);
      if (constant === null) continue;
      if (op === 'and' && constant % modulus !== modulus - 1n) break;
      const from = inner(term);
      if (!from) return null;
      add(from, op === 'and' ? 1n : constant);
      return terms;
    }
  return leaf();
}

/** x and k when value == x + (x < 0 ? 2^k - 1 : 0) exactly, 1 <= k < w: the
 * selected sum `x < 0 ? x + c : x` or the added bias term. */
function biased(site: RuleSite, value: Value): { x: Value; k: number } | null {
  const definition = site.observe(site.resolve(value).id),
    width = bitWidth(value.type);
  if (definition?.kind === 'select') {
    for (const [sum, plain, negative] of [
      [definition.when_true, definition.when_false, true],
      [definition.when_false, definition.when_true, false],
    ] as const) {
      const addition = site.observe(site.resolve(sum).id);
      if (addition?.kind !== 'integer' || addition.op !== 'add') continue;
      for (const [term, addend] of [
        [addition.left, addition.right],
        [addition.right, addition.left],
      ] as const) {
        const constant = site.constant(addend),
          x = site.resolve(plain);
        if (constant === null || !sameValue(site, term, x)) continue;
        const k = (constant + 1n).toString(2).length - 1;
        if (constant + 1n !== 1n << BigInt(k) || k < 1 || k >= width - 1) continue;
        const min = -(1n << BigInt(width - 1)),
          max = (1n << BigInt(width - 1)) - 1n;
        const below = [[min, -1n]] as const,
          above = [[0n, max]] as const;
        if (
          decides(
            site,
            definition.condition,
            x,
            negative ? below : above,
            negative ? above : below,
            false,
          )
        )
          return { x, k };
      }
    }
    return null;
  }
  if (definition?.kind !== 'integer' || definition.op !== 'add') return null;
  for (const [x, bias] of [
    [definition.left, definition.right],
    [definition.right, definition.left],
  ] as const) {
    const k = biasTerm(site, bias, x);
    if (k !== null) return { x: site.resolve(x), k };
  }
  return null;
}

type SignTest = 'negative' | 'positive';

/** Whether [u < 0] is [x < 0] or [x > 0]: u is x (or its sign extension) or an
 * exact two's-complement floor(x*M/2^s) of the same signed x (sign of M). */
function signOf(site: RuleSite, u: Value, base: Scaled, depth: number): SignTest | null {
  const width = bitWidth(u.type);
  if (base.signed && width >= base.bits && congruence(site, u, base) >= width) return 'negative';
  const definition = site.observe(site.resolve(u).id),
    form = definition ? scaledOf(site, definition, width, depth + 1) : null;
  if (!form || !sameBase(site, form, base) || !exact(form, width, true)) return null;
  return form.multiplier > 0n ? 'negative' : 'positive';
}

/** value == scale * [test] exactly: a sign bit moved to bit 0 (scale 1) or
 * replicated (scale -1), through truncations and extensions. */
function signTerm(
  site: RuleSite,
  value: Value,
  base: Scaled,
  depth = 0,
): { scale: 1 | -1; test: SignTest } | null {
  if (depth > 6) return null;
  const definition = site.observe(site.resolve(value).id),
    width = bitWidth(value.type);
  if (!definition) return null;
  if (
    width >= 2 &&
    ((definition.kind === 'extract' && definition.offset === 0) ||
      (definition.kind === 'cast' && definition.op === 'truncate'))
  )
    return signTerm(site, definition.value, base, depth + 1);
  if (definition.kind === 'cast' && definition.op === 'zero_extend') {
    const inner = signTerm(site, definition.value, base, depth + 1);
    return inner?.scale === 1 ? inner : null;
  }
  if (definition.kind === 'cast' && definition.op === 'sign_extend') {
    const inner = signTerm(site, definition.value, base, depth + 1);
    return inner && bitWidth(definition.value.type) === 1 ? { ...inner, scale: -1 } : inner;
  }
  if (definition.kind === 'extract' && width === 1) {
    const source = bitWidth(definition.value.type);
    const test =
      definition.offset === source - 1 ? signOf(site, definition.value, base, depth) : null;
    return test && { scale: 1, test };
  }
  if (
    definition.kind === 'integer' &&
    (definition.op === 'lshr' || definition.op === 'ashr') &&
    site.constant(definition.right) === BigInt(bitWidth(definition.left.type) - 1)
  ) {
    const test = signOf(site, definition.left, base, depth);
    return test && { scale: definition.op === 'lshr' ? 1 : -1, test };
  }
  // scale * [test] & 1 is [test] for either scale.
  if (definition.kind === 'integer' && definition.op === 'and')
    for (const [term, mask] of [
      [definition.left, definition.right],
      [definition.right, definition.left],
    ] as const) {
      if (site.constant(mask) !== 1n) continue;
      const inner = signTerm(site, term, base, depth + 1);
      return inner && { scale: 1, test: inner.test };
    }
  return null;
}

/** The divisor-times-quotient term p == q * c modulo 2^w: a constant multiple
 * (mul, shl) or a sum/difference of multiples of one q (q + (q << k),
 * q - (q << k), (q << k) - q: lea and shift-subtract spellings). */
function product(
  site: RuleSite,
  value: Value,
  depth = 0,
): { quotient: Value; coefficient: bigint } | null {
  const definition = site.observe(site.resolve(value).id),
    width = bitWidth(value.type);
  if (definition?.kind !== 'integer') return null;
  if (definition.op === 'mul')
    for (const [quotient, factor] of [
      [definition.left, definition.right],
      [definition.right, definition.left],
    ] as const) {
      const coefficient = site.constant(factor);
      if (coefficient !== null) return { quotient, coefficient };
    }
  if (definition.op === 'shl') {
    const count = site.constant(definition.right);
    if (count !== null && count < BigInt(width))
      return { quotient: definition.left, coefficient: 1n << count };
  }
  if ((definition.op === 'add' || definition.op === 'sub') && depth < 2) {
    const term = (operand: Value) =>
      product(site, operand, depth + 1) ?? { quotient: operand, coefficient: 1n };
    const left = term(definition.left),
      right = term(definition.right);
    if (sameValue(site, left.quotient, right.quotient))
      return {
        quotient: left.quotient,
        coefficient: BigInt.asUintN(
          width,
          left.coefficient + (definition.op === 'add' ? 1n : -1n) * right.coefficient,
        ),
      };
  }
  return null;
}

function divisionAt(site: RuleSite, value: Value, depth: number): Division | null {
  const definition = site.observe(site.resolve(value).id);
  return definition && value.type.kind === 'integer'
    ? divisionOf(site, definition, bitWidth(value.type), depth + 1)
    : null;
}

/** The quotient or remainder range over x's range. */
function divisionBounds(division: Division): readonly [bigint, bigint] {
  const magnitude = division.divisor < 0n ? -division.divisor : division.divisor;
  if (!division.signed)
    return division.op === 'udiv'
      ? [0n, ((1n << BigInt(division.bits)) - 1n) / magnitude]
      : [0n, magnitude - 1n];
  const half = 1n << BigInt(division.bits - 1);
  return division.op === 'sdiv'
    ? [-(half / magnitude), half / magnitude]
    : [1n - magnitude, magnitude - 1n];
}

function fitsWidth(division: Division, width: number, signed: boolean): boolean {
  const [min, max] = divisionBounds(division);
  return signed
    ? min >= -(1n << BigInt(width - 1)) && max < 1n << BigInt(width - 1)
    : min >= 0n && max < 1n << BigInt(width);
}

/** floor(floor(x/a) / 2^k) = floor(x / (a*2^k)): an unsigned quotient shifted
 * right by k (logical shift, or a slice at offset k of a `source`-bit value). */
function shiftedQuotient(
  inner: Division | null,
  count: bigint,
  source: number,
  width: number,
): Division | null {
  if (inner?.op !== 'udiv' || count < 1n || count >= BigInt(source)) return null;
  const divisor = inner.divisor << count;
  if (divisor >= 1n << BigInt(inner.bits)) return null;
  const whole = inner.low >= source && fitsWidth(inner, source, false);
  const low = whole ? width : Math.min(width, Math.min(inner.low, source) - Number(count));
  return low > 0 ? { ...inner, divisor, low } : null;
}

/** Recognizes a value as x / d or x % d (C truncation) modulo 2^low. */
function divisionOf(
  site: RuleSite,
  expression: Expression,
  width: number,
  depth = 0,
): Division | null {
  site.context.checkpoint(1);
  if (depth > 6) return null;
  const found = divisionStep(site, expression, width, depth);
  if (found) return found;
  const form = scaledOf(site, expression, width);
  // A power-of-two multiplier is a shift, not a division.
  if (
    !form ||
    form.signed ||
    form.shift === 0 ||
    (form.multiplier & (form.multiplier - 1n)) === 0n ||
    form.bits > 64
  )
    return null;
  const divisor = exactMagicDivisor(form.bits, form.multiplier, form.shift);
  return divisor === null || divisor < 2n ? null : { ...form, op: 'udiv', divisor, low: form.low };
}

function divisionStep(
  site: RuleSite,
  expression: Expression,
  width: number,
  depth: number,
): Division | null {
  switch (expression.kind) {
    case 'extract': {
      const inner = divisionAt(site, expression.value, depth),
        source = bitWidth(expression.value.type);
      return expression.offset === 0
        ? inner && { ...inner, low: Math.min(width, inner.low) }
        : shiftedQuotient(inner, BigInt(expression.offset), source, width);
    }
    case 'cast': {
      const inner = divisionAt(site, expression.value, depth),
        source = bitWidth(expression.value.type);
      if (!inner) return null;
      if (expression.op === 'truncate') return { ...inner, low: Math.min(width, inner.low) };
      if (expression.op !== 'zero_extend' && expression.op !== 'sign_extend') return null;
      // The extension of an exact value whose range fits is that value.
      const whole =
        inner.low >= source && fitsWidth(inner, source, expression.op === 'sign_extend');
      return { ...inner, low: whole ? width : Math.min(inner.low, source) };
    }
    case 'integer_unary':
      return expression.op === 'neg'
        ? negatedQuotient(divisionAt(site, expression.value, depth), width)
        : null;
    case 'select':
      return selectedRemainder(site, expression, width);
    case 'integer':
      break;
    default:
      return null;
  }
  const { op, left, right } = expression;
  const constant = site.constant(right);
  switch (op) {
    case 'udiv':
    case 'urem':
    case 'sdiv':
    case 'srem': {
      const signed = op === 'sdiv' || op === 'srem',
        divisor = constant === null ? null : signed ? BigInt.asIntN(width, constant) : constant;
      if (divisor === null || divisor === 0n || (signed && divisor === -1n)) return null;
      return { op, x: site.resolve(left), bits: width, signed, divisor, low: width };
    }
    case 'lshr':
      return constant === null
        ? null
        : shiftedQuotient(divisionAt(site, left, depth), constant, width, width);
    case 'ashr': {
      const sum = biased(site, left);
      return sum && constant === BigInt(sum.k)
        ? { op: 'sdiv', x: sum.x, bits: width, signed: true, divisor: 1n << constant, low: width }
        : null;
    }
    case 'add':
    case 'sub':
      return (
        signedQuotient(site, expression, width) ??
        remainder(site, expression, width, depth) ??
        (op === 'sub' && site.constant(left) === 0n
          ? negatedQuotient(divisionAt(site, right, depth), width)
          : null)
      );
    default:
      return null;
  }
}

/** -(x / d) is x / -d (d not 1, -d representable). */
function negatedQuotient(inner: Division | null, width: number): Division | null {
  if (inner?.op !== 'sdiv' || inner.divisor === 1n) return null;
  if (inner.divisor === -(1n << BigInt(inner.bits - 1))) return null;
  return { ...inner, divisor: -inner.divisor, low: Math.min(width, inner.low) };
}

/** Signed magic quotients: t + [x*M < 0] for t = floor(x*M/2^s), the sign
 * added as a moved sign bit or subtracted as a replicated one (t - (x >> w-1));
 * (x >> w-1) - t is the negated quotient. */
function signedQuotient(
  site: RuleSite,
  expression: Extract<Expression, { kind: 'integer' }>,
  width: number,
): Division | null {
  const orders =
    expression.op === 'add'
      ? ([
          [expression.left, expression.right, 1, false],
          [expression.right, expression.left, 1, false],
        ] as const)
      : ([
          [expression.left, expression.right, -1, false],
          [expression.right, expression.left, -1, true],
        ] as const);
  for (const [term, sign, scale, negate] of orders) {
    const definition = site.observe(site.resolve(term).id),
      t = definition ? scaledOf(site, definition, width) : null;
    if (!t?.signed || t.bits > 64) continue;
    const s = signTerm(site, sign, t);
    if (!s || s.scale !== scale || (s.test === 'negative') !== t.multiplier > 0n) continue;
    const divisor = exactSignedMagicDivisor(t.bits, t.multiplier, t.shift);
    if (divisor === null) continue;
    return {
      op: 'sdiv',
      x: t.x,
      bits: t.bits,
      signed: true,
      divisor: negate ? -divisor : divisor,
      low: Math.min(t.low, width),
    };
  }
  return null;
}

/** x - q*c (or x + q*(-c)) with q ≡ x / c is x % c; and the signed power-of-two
 * remainders x - (biased & -2^k) and (biased & (2^k-1)) - bias. */
function remainder(
  site: RuleSite,
  expression: Extract<Expression, { kind: 'integer' }>,
  width: number,
  depth: number,
): Division | null {
  const all = (1n << BigInt(width)) - 1n;
  const orders =
    expression.op === 'sub'
      ? ([[expression.left, expression.right, -1n]] as const)
      : ([
          [expression.left, expression.right, 1n],
          [expression.right, expression.left, 1n],
        ] as const);
  for (const [minuend, term, sign] of orders) {
    const scaled = product(site, term);
    const quotient = scaled ? divisionAt(site, scaled.quotient, depth) : null;
    if (scaled && quotient && quotientOp(quotient.op)) {
      const divisor = BigInt.asUintN(width, quotient.divisor);
      const known = Math.min(quotient.low, congruence(site, minuend, quotient), width);
      if (
        known > 0 &&
        BigInt.asUintN(width, sign * scaled.coefficient) === BigInt.asUintN(width, -divisor)
      )
        return {
          ...quotient,
          op: quotient.op === 'udiv' ? 'urem' : 'srem',
          low: known,
        };
    }
    if (sign !== -1n) continue;
    // x - (biased & -2^k): biased & -2^k is trunc(x / 2^k) * 2^k.
    const masked = site.observe(site.resolve(term).id);
    if (masked?.kind === 'integer' && masked.op === 'and')
      for (const [sum, maskValue] of [
        [masked.left, masked.right],
        [masked.right, masked.left],
      ] as const) {
        const mask = site.constant(maskValue),
          bias = biased(site, sum);
        if (
          mask !== null &&
          bias &&
          mask === ((all << BigInt(bias.k)) & all) &&
          sameValue(site, minuend, bias.x)
        )
          return powerRemainder(bias.x, bias.k, width);
      }
    // ((x + bias) & (2^k - 1)) - bias: the low k bits of x + bias (any spelling
    // congruent modulo 2^k: a mask, or a k-bit sum), zero-extended, less the bias.
    const bias = biasOf(site, term);
    if (bias && bitWidth(bias.x.type) === width) {
      let low = site.resolve(minuend);
      for (let hops = 0; hops < 4; hops++) {
        const extended = site.observe(low.id);
        if (extended?.kind !== 'cast' || extended.op !== 'zero_extend') break;
        low = site.resolve(extended.value);
      }
      const kept = site.observe(low.id),
        sums: Value[] = bitWidth(low.type) === bias.k ? [low] : [];
      if (kept?.kind === 'integer' && kept.op === 'and')
        for (const [sum, maskValue] of [
          [kept.left, kept.right],
          [kept.right, kept.left],
        ] as const)
          if (site.constant(maskValue) === (1n << BigInt(bias.k)) - 1n) sums.push(sum);
      for (const sum of sums) {
        const terms = linearLow(site, sum, bias.k);
        if (!terms || terms.size !== 2) continue;
        const x = terms.get(lowRoot(site, bias.x).id);
        const other = [...terms.values()].find((entry) => entry !== x);
        if (
          x?.coefficient === 1n &&
          other?.coefficient === 1n &&
          biasModulo(site, other.leaf, bias.x, bias.k)
        )
          return powerRemainder(bias.x, bias.k, width);
      }
    }
  }
  return null;
}

const powerRemainder = (x: Value, k: number, width: number): Division => ({
  op: 'srem',
  x,
  bits: width,
  signed: true,
  divisor: 1n << BigInt(k),
  low: width,
});

/** x > 0 ? x & m : -((-x) & m) (either arm order and any sign test agreeing on
 * x > 0 and on x < 0, x != INT_MIN) is x % 2^k for m = 2^k - 1: both arms are 0
 * at x = 0 and x = INT_MIN. */
function selectedRemainder(
  site: RuleSite,
  expression: Extract<Expression, { kind: 'select' }>,
  width: number,
): Division | null {
  if (width < 2) return null;
  const field = (value: Value): { x: Value; k: number } | null => {
    const definition = site.observe(site.resolve(value).id);
    if (definition?.kind !== 'integer' || definition.op !== 'and') return null;
    for (const [x, maskValue] of [
      [definition.left, definition.right],
      [definition.right, definition.left],
    ] as const) {
      const mask = site.constant(maskValue);
      if (mask === null) continue;
      const k = mask.toString(2).length;
      if (mask === (1n << BigInt(k)) - 1n && k < width - 1) return { x: site.resolve(x), k };
    }
    return null;
  };
  const min = -(1n << BigInt(width - 1)),
    max = (1n << BigInt(width - 1)) - 1n;
  const positive = [[1n, max]] as const,
    negative = [[min + 1n, -1n]] as const;
  for (const [plain, flipped, whenPositive] of [
    [expression.when_true, expression.when_false, true],
    [expression.when_false, expression.when_true, false],
  ] as const) {
    const direct = field(plain),
      outer = negated(site, flipped),
      inner = outer ? field(outer) : null,
      x = inner ? negated(site, inner.x) : null;
    if (!direct || !inner || !x || inner.k !== direct.k || !sameValue(site, x, direct.x)) continue;
    if (
      decides(
        site,
        expression.condition,
        direct.x,
        whenPositive ? positive : negative,
        whenPositive ? negative : positive,
        true,
      )
    )
      return powerRemainder(direct.x, direct.k, width);
  }
  return null;
}

/** The division as an expression at `width`: an existing value computing it
 * behind the site's slices and extensions is reused (exact wiring, no second
 * copy); otherwise a new operation, truncated or extended to match its
 * signedness. */
function divisionExpression(
  site: RuleSite,
  division: Division,
  width: number,
  expression: Expression,
): Expression {
  const id = site.value.id,
    key = `${division.op}:${division.divisor}`;
  let existing: Value | null = null;
  for (let current: Expression | undefined = expression, hops = 0; current && hops < 4; hops++) {
    if (
      !(current.kind === 'extract' && current.offset === 0) &&
      !(current.kind === 'cast' && ['truncate', 'zero_extend', 'sign_extend'].includes(current.op))
    )
      break;
    const value = site.resolve(current.value);
    current = site.observe(value.id);
    if (current?.kind === 'integer' && canonical(site, current, division)) {
      existing = value;
      break;
    }
  }
  const operation = (): Expression => ({
    kind: 'integer',
    op: division.op,
    left: division.x,
    right: site.literal(division.x.type, division.divisor, `magic-divisor:${id}:${key}`),
  });
  if (!existing && division.bits === width) return operation();
  const result =
    existing ??
    site.create(`magic-quotient:${id}:${key}`, integer(division.bits), site.block, operation(), [
      site.value,
    ]);
  if (division.bits === width) return { kind: 'cast', op: 'bitcast', value: result };
  return division.bits < width
    ? { kind: 'cast', op: division.signed ? 'sign_extend' : 'zero_extend', value: result }
    : { kind: 'extract', value: result, offset: 0 };
}

/** The expression already is the division (possibly behind the one extension or
 * low slice divisionExpression would add): rewriting it would only rebuild it. */
function canonical(site: RuleSite, expression: Expression, division: Division): boolean {
  const operation =
    (expression.kind === 'cast' &&
      (expression.op === 'zero_extend' || expression.op === 'sign_extend')) ||
    (expression.kind === 'extract' && expression.offset === 0)
      ? site.observe(site.resolve(expression.value).id)
      : expression;
  return (
    operation?.kind === 'integer' &&
    operation.op === division.op &&
    sameValue(site, operation.left, division.x) &&
    site.constant(operation.right) === BigInt.asUintN(division.bits, division.divisor)
  );
}

/** Rewrites a recognized quotient (or remainder) at its own width, or, where
 * only an operand's low bits are demanded (x << k reads the low w-k bits), an
 * operand recognized modulo those bits. */
function divisionRewrite(site: RuleSite, quotients: boolean): Expression | null {
  const { value, expression } = site;
  if (value.type.kind !== 'integer' || bitWidth(value.type) > 128) return null;
  const width = bitWidth(value.type);
  const found = divisionOf(site, expression, width);
  if (!found) return demandedOperand(site, quotients, width);
  // Low slices or extensions of a value that is itself rewritten: that value is
  // reused once rewritten (divisionExpression); a second copy would duplicate it.
  for (let current: Expression | undefined = expression, hops = 0; current && hops < 4; hops++) {
    if (
      !(current.kind === 'extract' && current.offset === 0) &&
      !(current.kind === 'cast' && ['truncate', 'zero_extend', 'sign_extend'].includes(current.op))
    )
      break;
    const inner = current.value;
    current = site.observe(site.resolve(inner).id);
    const division = current ? divisionOf(site, current, bitWidth(inner.type)) : null;
    if (
      current &&
      division &&
      division.low >= bitWidth(inner.type) &&
      !canonical(site, current, division)
    )
      return null;
  }
  return !canonical(site, expression, found) &&
    found.low >= width &&
    quotientOp(found.op) === quotients
    ? divisionExpression(site, found, width, expression)
    : null;
}

/** x << k reads only the low w-k bits of x: an operand known as a division
 * modulo those bits is that division. */
function demandedOperand(site: RuleSite, quotients: boolean, width: number): Expression | null {
  const { value, expression } = site;
  if (expression.kind !== 'integer' || expression.op !== 'shl') return null;
  const count = site.constant(expression.right);
  if (count === null || count < 1n || count >= BigInt(width)) return null;
  const operandWidth = bitWidth(expression.left.type),
    definition = site.observe(site.resolve(expression.left).id),
    operand = definition ? divisionOf(site, definition, operandWidth) : null;
  if (
    !operand ||
    !definition ||
    canonical(site, definition, operand) ||
    quotientOp(operand.op) !== quotients ||
    operand.low < width - Number(count) ||
    operand.low >= operandWidth
  )
    return null;
  const replacement = site.create(
    `magic-low:${value.id}:${operand.op}:${operand.divisor}`,
    expression.left.type,
    site.block,
    divisionExpression(site, operand, operandWidth, definition),
    [value],
  );
  return { ...expression, left: replacement };
}

const magicDivision: ExpressionRule = {
  name: 'magic_division',
  scope:
    'a quotient computed without a divide instruction is x / d when its exact integer is trunc(x/d) for every x: unsigned floor(x*M/2^s) (multiply-high, shifts, slices, add-back t + ((x-t)>>1) of a 2^w+M multiplier) with d = ceil(2^s/M) passing the closed-form residue bound (exactMagicDivisor); signed floor(x*M/2^s) + [x*M < 0] (sign bit added, or the replicated sign of x subtracted; subtracted from it, the negated divisor) passing the two-sided bound (exactSignedMagicDivisor), |d| < 2^(w-1); (x + (x < 0 ? 2^k-1 : 0)) >> k is x / 2^k; -(x / d) is x / -d; a shifted quotient folds into the divisor. Every step keeps the exact integer while it fits its width and otherwise only its provably preserved low bits; an operand known only modulo 2^b is rewritten only where no other bits are read (x << (w-b))',
  proof: 'own',
  views: ['source'],
  apply: (site) => divisionRewrite(site, true),
};

const divisions: Partial<Record<IntegerOp, 'zero_extend' | 'sign_extend'>> = {
  udiv: 'zero_extend',
  urem: 'zero_extend',
  sdiv: 'sign_extend',
  srem: 'sign_extend',
};

const divisionNarrowing: ExpressionRule = {
  name: 'division_narrowing',
  scope:
    'a W-bit unsigned division/remainder of a zero-extended N-bit x by a constant 0 < c < 2^N is the zero-extended N-bit operation (the quotient is at most x, the remainder below c); a signed one of a sign-extended x by a constant c in [-2^(N-1), 2^(N-1)) other than 0 and -1 is the sign-extended N-bit operation (|quotient| <= |x| and only c = -1 reaches 2^(N-1); |remainder| < |c|)',
  proof: 'own',
  views: ['source'],
  apply(site) {
    const { value, expression } = site;
    if (expression.kind !== 'integer' || value.type.kind !== 'integer') return null;
    const extension = divisions[expression.op];
    if (!extension) return null;
    const dividend = site.observe(site.resolve(expression.left).id),
      divisor = site.constant(expression.right),
      width = value.type.bits;
    if (dividend?.kind !== 'cast' || dividend.op !== extension || divisor === null) return null;
    const x = dividend.value,
      bits = bitWidth(x.type);
    if (bits >= width) return null;
    const signed = BigInt.asIntN(width, divisor);
    const fits =
      extension === 'zero_extend'
        ? divisor !== 0n && divisor < 1n << BigInt(bits)
        : signed !== 0n &&
          signed !== -1n &&
          signed >= -(1n << BigInt(bits - 1)) &&
          signed < 1n << BigInt(bits - 1);
    if (!fits) return null;
    const narrow = site.create(
      `narrowed-division:${value.id}`,
      integer(bits),
      site.block,
      {
        kind: 'integer',
        op: expression.op,
        left: x,
        right: site.literal(x.type, BigInt.asUintN(bits, divisor), `narrowed-divisor:${value.id}`),
      },
      [value],
    );
    return { kind: 'cast', op: extension, value: narrow };
  },
};

const remainderIdiom: ExpressionRule = {
  name: 'remainder_idiom',
  scope:
    'x - q*c (or x + q*(-c), c = 2^k-1 also as q - (q << k)) is x % c when q is a recognized quotient x / c of the same x modulo the same low bits (truncated division satisfies x = (x/c)*c + x%c exactly); signed power-of-two remainders x - ((x + bias) & -2^k), ((x + bias) & (2^k-1)) - bias with bias = (x < 0 ? 2^k-1 : 0), and x > 0 ? x & (2^k-1) : -((-x) & (2^k-1)) (both arms 0 at x = 0 and INT_MIN) are x % 2^k; a remainder known only modulo 2^b is rewritten only where no other bits are read',
  proof: 'own',
  views: ['source'],
  apply: (site) => divisionRewrite(site, false),
};

/** Division rules in pool order: recognized quotients first, then narrowing and
 * the remainders over the quotients they produce. */
export const divisionRules: readonly ExpressionRule[] = [
  magicDivision,
  divisionNarrowing,
  remainderIdiom,
];
