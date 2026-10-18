import { bitWidth, integer, type DataType, type Expression, type Value } from '../ir/index.js';

type Make = (
  key: string,
  type: DataType,
  block: string,
  expression?: Expression,
  contributors?: readonly Value[],
) => Value;

export const shiftIdiomScope =
  'a constant rotation whose result is masked to exactly its non-wrapped bits is the plain shift (ror(x,k) & (ones>>k) = x>>k, ror(x,k) & (ones<<(w-k)) = x<<(w-k), rol by the complementary count), a logical shift OR-ed with the sign bit replicated into exactly the vacated top bits is the arithmetic shift, and a bit field lying entirely inside the non-wrapped or the wrapped part of a rotation is the same field of the rotated operand; 0<k<w and every mask must equal the vacated/retained bits exactly, so a true rotate keeps its rotate';

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
    return null;
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
    // The filler is `sign ? A : B` under an optional constant mask M.
    let mask = ones,
      pick = define(filled);
    if (pick?.kind === 'integer' && pick.op === 'and') {
      const left = constant(pick.left),
        right = constant(pick.right);
      if (right !== null && left === null) {
        mask = right;
        pick = define(pick.left);
      } else if (left !== null && right === null) {
        mask = left;
        pick = define(pick.right);
      } else continue;
    }
    if (pick?.kind !== 'select') continue;
    const yes = constant(pick.when_true),
      no = constant(pick.when_false),
      test = define(pick.condition);
    if (yes === null || no === null || (yes & mask) !== vacated || (no & mask) !== 0n) continue;
    const sign =
      (test?.kind === 'extract' &&
        test.offset === width - 1 &&
        bitWidth(test.value.type) === width &&
        resolve(test.value).id === source.id) ||
      (test?.kind === 'compare' &&
        test.op === 'slt' &&
        bitWidth(test.left.type) === width &&
        resolve(test.left).id === source.id &&
        constant(test.right) === 0n);
    if (!sign || bitWidth(pick.condition.type) !== 1) continue;
    return { kind: 'integer', op: 'ashr', left: source, right: logical.right };
  }
  return null;
}
