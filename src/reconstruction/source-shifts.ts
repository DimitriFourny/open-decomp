import { bitWidth, integer, type DataType, type Expression, type Value } from '../ir/index.js';

type Make = (
  key: string,
  type: DataType,
  block: string,
  expression?: Expression,
  contributors?: readonly Value[],
) => Value;

export const shiftIdiomScope =
  'a constant rotation whose result is masked to exactly its non-wrapped bits is the plain shift (ror(x,k) & (ones>>k) = x>>k, ror(x,k) & (ones<<(w-k)) = x<<(w-k), rol by the complementary count), a logical shift OR-ed with the sign bit replicated into exactly the vacated top bits is the arithmetic shift, and a bit field lying entirely inside the non-wrapped or the wrapped part of a rotation is the same field of the rotated operand; 0<k<w and every mask must equal the vacated/retained bits exactly, so a true rotate keeps its rotate; the bitfield-move forms are the same exact field algebra, for a field of 8, 16 or 32 bits that starts at bit 0 of its source: a rotation masked to that one non-wrapping run (ror(x,w-k) & (mask(n)<<k), 0<k, k+n<w) is zero_extend(trunc_n(x)) << k, and a field of n bits at k OR-ed with its own top bit (a select of 1/0 on that very source bit) replicated into exactly the bits above it (k+n..w-1) is sign_extend(trunc_n(x)) << k (SXTB/SXTH/SXTW, SBFIZ); the masks must equal the field and the fill exactly';

/** One contiguous run of set bits: [low, high), or null for no bits or a gap. */
function contiguousRun(mask: bigint): { low: number; high: number } | null {
  if (mask === 0n) return null;
  const high = mask.toString(2).length;
  let low = 0;
  while (((mask >> BigInt(low)) & 1n) === 0n) low++;
  return mask === ((1n << BigInt(high - low)) - 1n) << BigInt(low) ? { low, high } : null;
}

/** A value of w bits that is `base[offset, offset+bits)` placed at bit `shift`
 * with every other bit zero, or the plain rotation of a w-bit source. */
type Shape =
  | {
      readonly kind: 'field';
      readonly base: Value;
      readonly offset: number;
      readonly shift: number;
      readonly bits: number;
      /** The field was read through a rotation (the lowering of a bitfield move). */
      readonly rotated: boolean;
    }
  | {
      readonly kind: 'rotation';
      readonly source: Value;
      readonly right: number;
      /** Bits kept by the masks applied so far (bit j of the rotation). */
      readonly mask: bigint;
    };

/** Field widths that have a native C integer type: the extension of any other
 * width prints as masks and xor/subtract pairs, which is longer than the form it
 * replaces. */
const nativeWidth = (bits: number): boolean => bits === 8 || bits === 16 || bits === 32;

/** Operands of rotations by a constant 0<k<w (w = 8/16/32/64): the source view
 * prints those as two shifts that each read the operand, so it must be a
 * printed variable (never a re-evaluated inline expression). */
export function constantRotationOperands(
  expressions: ReadonlyMap<string, Expression>,
): Set<string> {
  const operands = new Set<string>();
  for (const expression of expressions.values()) {
    if (expression.kind !== 'integer' || (expression.op !== 'rol' && expression.op !== 'ror'))
      continue;
    const count = expressions.get(expression.right.id),
      width = bitWidth(expression.left.type);
    if (
      count?.kind === 'constant' &&
      [8, 16, 32, 64].includes(width) &&
      count.bits > 0n &&
      count.bits < BigInt(width)
    )
      operands.add(expression.left.id);
  }
  return operands;
}

/** Exact shift/rotate idioms produced by bitfield-move lowering. Both rewrites
 * are bit-exact for a constant count 0<k<w; a rotate with any other mask is a
 * real rotate and is left alone. Returns the replacement, or null. */
export function foldShiftIdiom(
  value: Value,
  expression: Expression,
  observe: (id: string) => Expression | undefined,
  resolve: (value: Value) => Value,
  constant: (value: Value) => bigint | null,
  create: Make,
  block: string,
): Expression | null {
  if (value.type.kind !== 'integer') return null;
  const width = value.type.bits;

  const ones = (1n << BigInt(width)) - 1n;
  const define = (operand: Value) => observe(resolve(operand).id);
  const count = (amount: number, bits = width): Value =>
    create(
      `shift-count:${value.id}:${amount}:${bits}`,
      integer(bits),
      block,
      { kind: 'constant', bits: BigInt(amount) },
      [value],
    );
  /** The value and bit position a bit is wired from, through slices and
   * extensions (a sign extension's upper bits are its operand's sign bit). */
  const bitOrigin = (operand: Value, offset: number): string => {
    let current = resolve(operand),
      at = offset;
    for (let depth = 0; depth < 8; depth++) {
      const definition = observe(current.id);
      if (definition?.kind === 'extract') at += definition.offset;
      else if (
        definition?.kind === 'cast' &&
        (definition.op === 'truncate' ||
          (definition.op === 'zero_extend' && at < bitWidth(definition.value.type)) ||
          definition.op === 'sign_extend')
      )
        // Truncation keeps the operand's low bits; extensions keep them too
        // and a sign extension repeats the operand's sign bit above it.
        at = Math.min(at, bitWidth(definition.value.type) - 1);
      else break;
      current = resolve(definition.value);
    }
    return `${current.id}:${at}`;
  };
  /** Right-rotation amount 1..w-1 and the rotated operand of a constant rotate. */
  const rotation = (operand: Value): { source: Value; right: number } | null => {
    const definition = define(operand),
      rotated = bitWidth(operand.type);
    if (
      definition?.kind !== 'integer' ||
      (definition.op !== 'ror' && definition.op !== 'rol') ||
      bitWidth(definition.left.type) !== rotated
    )
      return null;
    const amount = constant(definition.right);
    if (amount === null || amount <= 0n || amount >= BigInt(rotated)) return null;
    return {
      source: resolve(definition.left),
      right: definition.op === 'ror' ? Number(amount) : rotated - Number(amount),
    };
  };
  /** The filler `sign ? A : B` under an optional constant mask M: the constant
   * it contributes when the sign is set (B contributes nothing) and its condition. */
  const signSelect = (operand: Value): { fill: bigint; condition: Value } | null => {
    let mask = ones,
      pick = define(operand);
    if (pick?.kind === 'integer' && pick.op === 'and') {
      const left = constant(pick.left),
        right = constant(pick.right);
      if (right !== null && left === null) {
        mask = right;
        pick = define(pick.left);
      } else if (left !== null && right === null) {
        mask = left;
        pick = define(pick.right);
      } else return null;
    }
    if (pick?.kind !== 'select') return null;
    const yes = constant(pick.when_true),
      no = constant(pick.when_false);
    if (yes === null || no === null || (no & mask) !== 0n) return null;
    return { fill: yes & mask, condition: pick.condition };
  };
  /** Whether the 1-bit condition is exactly bit `bit` of `base`. */
  const signTest = (condition: Value, base: Value, bit: number): boolean => {
    const test = define(condition);
    if (bitWidth(condition.type) !== 1) return false;
    if (test?.kind === 'extract')
      return bitOrigin(test.value, test.offset) === bitOrigin(base, bit);
    return (
      test?.kind === 'compare' &&
      test.op === 'slt' &&
      bit === bitWidth(base.type) - 1 &&
      bitWidth(test.left.type) === bitWidth(base.type) &&
      resolve(test.left).id === resolve(base).id &&
      constant(test.right) === 0n
    );
  };
  /** The field as an integer of its own width. */
  const narrowField = (field: Extract<Shape, { kind: 'field' }>): Value =>
    field.offset === 0 && field.bits === bitWidth(field.base.type)
      ? field.base
      : create(
          `bitfield-field:${value.id}:${field.offset}:${field.bits}`,
          integer(field.bits),
          block,
          { kind: 'extract', value: field.base, offset: field.offset },
          [value],
        );
  /** A mask applied to a shape keeps one contiguous run of a field; the masks
   * of a rotation accumulate until the shape is settled. */
  const restrict = (shape: Shape, mask: bigint): Shape | null => {
    if (shape.kind === 'rotation') return { ...shape, mask: shape.mask & mask };
    const kept = contiguousRun(mask & (((1n << BigInt(shape.bits)) - 1n) << BigInt(shape.shift)));
    return (
      kept && {
        kind: 'field',
        base: shape.base,
        offset: shape.offset + kept.low - shape.shift,
        shift: kept.low,
        bits: kept.high - kept.low,
        rotated: shape.rotated,
      }
    );
  };
  /** The field a shape denotes, or null. Bit j of ror(x, r) is x[(j + r) mod w]:
   * a masked run that does not cross the wrap point reads consecutive bits of x. */
  const settle = (shape: Shape | null): Extract<Shape, { kind: 'field' }> | null => {
    if (shape?.kind !== 'rotation') return shape;
    const kept = contiguousRun(shape.mask),
      start = kept && (kept.low + shape.right) % width;
    return kept && start !== null && start + kept.high - kept.low <= width
      ? {
          kind: 'field',
          base: shape.source,
          offset: start,
          shift: kept.low,
          bits: kept.high - kept.low,
          rotated: true,
        }
      : null;
  };
  /** Reads an operand as a bit field placed in a w-bit word, or as a constant
   * rotation under accumulated masks. Any other value is the whole of itself. */
  const shapeOfExpression = (
    definition: Expression | undefined,
    self: Value,
    depth: number,
  ): Shape | null => {
    const bits = bitWidth(self.type),
      whole: Shape = { kind: 'field', base: self, offset: 0, shift: 0, bits, rotated: false };
    if (depth > 8 || !definition) return whole;
    if (definition.kind === 'extract')
      return { ...whole, base: resolve(definition.value), offset: definition.offset };
    if (definition.kind === 'cast' && definition.op === 'zero_extend')
      return { ...whole, base: resolve(definition.value), bits: bitWidth(definition.value.type) };
    if (definition.kind !== 'integer') return whole;
    if (definition.op === 'ror' || definition.op === 'rol') {
      const rotate = rotation(self);
      return rotate ? { kind: 'rotation', ...rotate, mask: ones } : whole;
    }
    if (definition.op === 'and') {
      const left = constant(definition.left),
        right = constant(definition.right);
      if ((left === null) === (right === null)) return whole;
      const inner = shapeOf(left === null ? definition.left : definition.right, depth + 1);
      return inner && restrict(inner, (left ?? right)!);
    }
    if (definition.op === 'shl') {
      const amount = constant(definition.right),
        inner =
          amount !== null && amount > 0n && amount < BigInt(width)
            ? settle(shapeOf(definition.left, depth + 1))
            : null;
      if (!inner || amount === null) return whole;
      const shift = inner.shift + Number(amount);
      return shift >= width ? null : { ...inner, shift, bits: Math.min(inner.bits, width - shift) };
    }
    return whole;
  };
  const shapeOf = (operand: Value, depth: number): Shape | null =>
    shapeOfExpression(define(operand), resolve(operand), depth);

  // A field lying entirely inside the non-wrapped or the wrapped part of a
  // rotation is a field of the rotated operand itself.
  if (expression.kind === 'extract') {
    const rotate = rotation(expression.value);
    if (!rotate) return null;
    const rotated = bitWidth(expression.value.type),
      end = expression.offset + width;
    if (end <= rotated - rotate.right)
      return { kind: 'extract', value: rotate.source, offset: expression.offset + rotate.right };
    if (expression.offset >= rotated - rotate.right && end <= rotated)
      return {
        kind: 'extract',
        value: rotate.source,
        offset: expression.offset - (rotated - rotate.right),
      };
    return null;
  }
  if (expression.kind !== 'integer' || width < 2) return null;

  if (expression.op === 'and') {
    for (const [rotated, maskOperand] of [
      [expression.left, expression.right],
      [expression.right, expression.left],
    ] as const) {
      const mask = constant(maskOperand);
      if (mask === null) continue;
      const rotate = rotation(rotated);
      if (!rotate) {
        // A masked field of a rotation whose mask bits all lie in the
        // non-wrapped part: the same field of the logically shifted operand.
        const field = define(rotated),
          inner = field?.kind === 'extract' ? rotation(field.value) : null;
        if (field?.kind !== 'extract' || !inner || mask === 0n) continue;
        const wide = bitWidth(field.value.type);
        if (field.offset + mask.toString(2).length > wide - inner.right) continue;
        const shifted = create(
          `shift-field:${value.id}:${inner.right}`,
          field.value.type,
          block,
          { kind: 'integer', op: 'lshr', left: inner.source, right: count(inner.right, wide) },
          [value],
        );
        const extracted = create(
          `shift-field:${value.id}:${inner.right}:${field.offset}`,
          value.type,
          block,
          { kind: 'extract', value: shifted, offset: field.offset },
          [value],
        );
        return rotated === expression.left
          ? { kind: 'integer', op: 'and', left: extracted, right: maskOperand }
          : { kind: 'integer', op: 'and', left: maskOperand, right: extracted };
      }
      if (mask === ones >> BigInt(rotate.right))
        return {
          kind: 'integer',
          op: 'lshr',
          left: rotate.source,
          right: count(rotate.right),
        };
      if (mask === ((ones << BigInt(width - rotate.right)) & ones))
        return {
          kind: 'integer',
          op: 'shl',
          left: rotate.source,
          right: count(width - rotate.right),
        };
    }
    // A rotation masked to one non-wrapping run of its bits is that field of
    // the operand, zero-extended and shifted into place.
    const shape = settle(shapeOfExpression(expression, value, 0));
    if (
      !shape?.rotated ||
      shape.offset !== 0 ||
      shape.shift === 0 ||
      shape.shift + shape.bits >= width ||
      !nativeWidth(shape.bits)
    )
      return null;
    return {
      kind: 'integer',
      op: 'shl',
      left: create(
        `bitfield-extension:${value.id}`,
        value.type,
        block,
        { kind: 'cast', op: 'zero_extend', value: narrowField(shape) },
        [value],
      ),
      right: count(shape.shift),
    };
  }

  if (expression.op !== 'or') return null;
  for (const [shifted, filled] of [
    [expression.left, expression.right],
    [expression.right, expression.left],
  ] as const) {
    const logical = define(shifted);
    if (logical?.kind !== 'integer' || logical.op !== 'lshr') continue;
    const amount = constant(logical.right);
    if (amount === null || amount <= 0n || amount >= BigInt(width)) continue;
    const source = resolve(logical.left),
      vacated = (ones << (BigInt(width) - amount)) & ones;
    const filler = signSelect(filled);
    if (!filler || filler.fill !== vacated || !signTest(filler.condition, source, width - 1))
      continue;
    return { kind: 'integer', op: 'ashr', left: source, right: logical.right };
  }

  // A bit field OR-ed with its own top bit replicated into exactly the bits
  // above it: the sign extension of the field, placed at its bit position.
  for (const [other, filled] of [
    [expression.left, expression.right],
    [expression.right, expression.left],
  ] as const) {
    const filler = signSelect(filled),
      shape = filler && settle(shapeOf(other, 0));
    if (!filler || !shape) continue;
    const top = shape.shift + shape.bits;
    if (
      shape.offset !== 0 ||
      !nativeWidth(shape.bits) ||
      top >= width ||
      filler.fill !== (ones & ~((1n << BigInt(top)) - 1n)) ||
      !signTest(filler.condition, shape.base, shape.offset + shape.bits - 1)
    )
      continue;
    const extended: Expression = { kind: 'cast', op: 'sign_extend', value: narrowField(shape) };
    if (shape.shift === 0) return extended;
    return {
      kind: 'integer',
      op: 'shl',
      left: create(`bitfield-extension:${value.id}`, value.type, block, extended, [value]),
      right: count(shape.shift),
    };
  }
  return null;
}
