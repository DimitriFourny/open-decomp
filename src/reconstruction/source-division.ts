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

/** v == floor(x * multiplier / 2^shift) for the `bits`-wide x, with every
 * intermediate exact (no wrapped product, no lost high quotient bits). */
interface Quotient {
  readonly x: Value;
  readonly bits: number;
  readonly multiplier: bigint;
  readonly shift: number;
}

function largestQuotient(quotient: Quotient): bigint {
  return (((1n << BigInt(quotient.bits)) - 1n) * quotient.multiplier) >> BigInt(quotient.shift);
}

/** Recognizes unsigned multiply-high division sequences: a product of a zero-
 * extended x with a constant, logical shifts and high slices of it, and the
 * add-back form t + ((x - t) >> 1) of a 2^w+M magic multiplier. */
function quotientOf(
  site: RuleSite,
  width: number,
  expression: Expression,
  depth = 0,
): Quotient | null {
  site.context.checkpoint(1);
  if (depth > 8) return null;
  const operand = (value: Value): Quotient | null => {
    const definition = site.observe(site.resolve(value).id);
    return definition ? quotientOf(site, bitWidth(value.type), definition, depth + 1) : null;
  };
  const shifted = (inner: Quotient | null, by: bigint, kept: number): Quotient | null => {
    if (!inner || by < 0n || by > 256n) return null;
    const next = { ...inner, shift: inner.shift + Number(by) };
    return largestQuotient(next) < 1n << BigInt(kept) ? next : null;
  };
  switch (expression.kind) {
    case 'integer': {
      if (expression.op === 'mul') {
        for (const [factor, scale] of [
          [expression.left, expression.right],
          [expression.right, expression.left],
        ] as const) {
          const multiplier = site.constant(scale);
          if (multiplier === null || multiplier < 2n) continue;
          const definition = site.observe(site.resolve(factor).id);
          const x =
            definition?.kind === 'cast' && definition.op === 'zero_extend'
              ? site.resolve(definition.value)
              : site.resolve(factor);
          const quotient = { x, bits: bitWidth(x.type), multiplier, shift: 0 };
          // The full product must not wrap at the multiplication width.
          if (largestQuotient(quotient) < 1n << BigInt(width)) return quotient;
        }
        return null;
      }
      if (expression.op === 'lshr') {
        const count = site.constant(expression.right);
        return count === null ? null : shifted(operand(expression.left), count, width);
      }
      if (expression.op === 'add') {
        // t + ((x - t) >> 1) == (x + t) >> 1 because t <= x.
        for (const [high, half] of [
          [expression.left, expression.right],
          [expression.right, expression.left],
        ] as const) {
          const t = operand(high);
          if (!t || t.bits !== width || t.multiplier >= 1n << BigInt(t.shift)) continue;
          const halving = site.observe(site.resolve(half).id);
          if (
            halving?.kind !== 'integer' ||
            halving.op !== 'lshr' ||
            site.constant(halving.right) !== 1n
          )
            continue;
          const difference = site.observe(site.resolve(halving.left).id);
          if (
            difference?.kind !== 'integer' ||
            difference.op !== 'sub' ||
            site.resolve(difference.left).id !== t.x.id
          )
            continue;
          // The subtrahend is the same multiply-high (possibly another SSA copy).
          const subtrahend = operand(difference.right);
          if (
            subtrahend?.x.id !== t.x.id ||
            subtrahend.multiplier !== t.multiplier ||
            subtrahend.shift !== t.shift
          )
            continue;
          return {
            x: t.x,
            bits: t.bits,
            multiplier: (1n << BigInt(t.shift)) + t.multiplier,
            shift: t.shift + 1,
          };
        }
      }
      return null;
    }
    case 'extract':
      return shifted(operand(expression.value), BigInt(expression.offset), width);
    case 'cast':
      if (expression.op === 'truncate') return shifted(operand(expression.value), 0n, width);
      return expression.op === 'zero_extend' || expression.op === 'bitcast'
        ? operand(expression.value)
        : null;
    default:
      return null;
  }
}

/** A `bits`-wide operation re-expressed at the site's width. */
function atWidth(site: RuleSite, operation: Expression, bits: number, key: string): Expression {
  const width = bitWidth(site.value.type);
  if (bits === width) return operation;
  const narrow = site.create(key, integer(bits), site.block, operation, [site.value]);
  return bits < width
    ? { kind: 'cast', op: 'zero_extend', value: narrow }
    : { kind: 'extract', value: narrow, offset: 0 };
}

const magicDivision: ExpressionRule = {
  name: 'magic_division',
  scope:
    'floor(x*M / 2^s) of a zero-extended x (multiply-high plus shifts, or the add-back form t + ((x-t)>>1) of a 2^w+M multiplier) is x / d exactly when d = ceil(2^s/M) satisfies the closed-form bound on every residue for x < 2^width (exactMagicDivisor); a shifted quotient floor(floor(x/a)/2^k) is x / (a*2^k); products and quotients are checked never to wrap',
  proof: 'own',
  views: ['source'],
  apply(site) {
    const { value, expression } = site;
    if (value.type.kind !== 'integer' || bitWidth(value.type) > 64) return null;
    // floor(floor(x/a)/2^k) = floor(x / (a*2^k)) when the product fits.
    if (expression.kind === 'integer' && expression.op === 'lshr') {
      const count = site.constant(expression.right),
        inner = site.observe(site.resolve(expression.left).id);
      if (count !== null && inner?.kind === 'integer' && inner.op === 'udiv') {
        const divisor = site.constant(inner.right),
          bits = bitWidth(inner.left.type);
        if (divisor === null || divisor === 0n || count >= BigInt(bits)) return null;
        const combined = divisor << count;
        if (combined >= 1n << BigInt(bits) || bits !== bitWidth(value.type)) return null;
        return {
          kind: 'integer',
          op: 'udiv',
          left: inner.left,
          right: site.literal(inner.left.type, combined, `magic-divisor:${value.id}`),
        };
      }
    }
    const quotient = quotientOf(site, bitWidth(value.type), expression);
    // A product without a shift, or a power-of-two multiplier, is not a division.
    if (
      !quotient ||
      quotient.shift === 0 ||
      (quotient.multiplier & (quotient.multiplier - 1n)) === 0n ||
      bitWidth(quotient.x.type) > 64
    )
      return null;
    const divisor = exactMagicDivisor(quotient.bits, quotient.multiplier, quotient.shift);
    if (divisor === null || divisor < 2n) return null;
    return atWidth(
      site,
      {
        kind: 'integer',
        op: 'udiv',
        left: quotient.x,
        right: site.literal(quotient.x.type, divisor, `magic-divisor:${value.id}`),
      },
      quotient.bits,
      `magic-quotient:${value.id}`,
    );
  },
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
    'x - (x / c) * c is x % c for a constant divisor c != 0 (and c != -1 when signed): truncated division satisfies x = (x/c)*c + x%c exactly modulo 2^width; the quotient must divide the identical SSA value x by the identical constant',
  proof: 'own',
  views: ['source'],
  apply(site) {
    const { value, expression } = site;
    if (expression.kind !== 'integer' || expression.op !== 'sub' || value.type.kind !== 'integer')
      return null;
    const width = value.type.bits,
      x = site.resolve(expression.left),
      product = site.observe(site.resolve(expression.right).id);
    if (product?.kind !== 'integer' || product.op !== 'mul') return null;
    for (const [quotientValue, factor] of [
      [product.left, product.right],
      [product.right, product.left],
    ] as const) {
      const quotient = site.observe(site.resolve(quotientValue).id),
        multiplier = site.constant(factor);
      if (
        multiplier === null ||
        quotient?.kind !== 'integer' ||
        (quotient.op !== 'udiv' && quotient.op !== 'sdiv') ||
        site.resolve(quotient.left).id !== x.id ||
        bitWidth(quotient.left.type) !== width
      )
        continue;
      const divisor = site.constant(quotient.right);
      if (
        divisor === null ||
        divisor !== multiplier ||
        divisor === 0n ||
        (quotient.op === 'sdiv' && BigInt.asIntN(width, divisor) === -1n)
      )
        continue;
      return {
        kind: 'integer',
        op: quotient.op === 'udiv' ? 'urem' : 'srem',
        left: x,
        right: quotient.right,
      };
    }
    return null;
  },
};

/** Division rules in pool order: magic sequences first, then narrowing and the
 * remainder identity over the quotients they produce. */
export const divisionRules: readonly ExpressionRule[] = [
  magicDivision,
  divisionNarrowing,
  remainderIdiom,
];
