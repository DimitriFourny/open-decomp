import type { OperationContext } from '../core/index.js';
import {
  bitWidth,
  expressionOperands,
  sameType,
  type Expression,
  type Instruction,
  type Value,
} from '../ir/index.js';
import type { BlockRegion, Control, ParallelTransfer } from '../presentation/index.js';

/** One x86 divide whose divide-error guards are exactly the trap conditions of
 * the narrow C operation (`classifyDivisionTraps`). */
export interface DivisionTrap {
  /** Each guard `if` -> the block it continues to. */
  readonly guards: ReadonlyMap<string, string>;
  /** The two trap blocks, entered only from their guards. */
  readonly omitted: ReadonlySet<string>;
  /** The block computing the division (between the two guards). */
  readonly block: string;
  /** Narrowed definitions: each low half of the wide quotient or remainder
   * becomes the `bits`-wide operation of `dividend` and `divisor`. */
  readonly results: readonly { readonly value: Value; readonly expression: Expression }[];
  /** Other low slices of the wide quotient or remainder: slices of a result. */
  readonly slices: readonly { readonly value: Value; readonly expression: Expression }[];
  readonly signed: boolean;
  readonly bits: number;
}

/** Presentation record scope of `division_trap`. */
export const DIVISION_TRAP_SCOPE =
  'x86 divide-error guards of a division whose double-width dividend is the sign (zero) extension of an N-bit value and whose divisor is the same extension of an N-bit value: they trap exactly when the divisor is zero or (signed) the dividend is the minimum and the divisor -1, the inputs on which the N-bit quotient and remainder operators of the dialect trap (C-like: signed only at N = 32 and 64, whose int32_t/int64_t operands are not promoted; Python-like: unsigned only), and otherwise the low halves of the wide quotient and remainder are the N-bit truncating quotient and remainder; the guards and trap blocks print nothing and the division prints as a statement where it is defined';

type Division = Extract<Expression, { kind: 'integer' }> & {
  readonly op: 'sdiv' | 'udiv' | 'srem' | 'urem';
};

/** Source view: x86 `div`/`idiv` lifts a double-width dividend `N = hi:lo` and
 * divisor `D = ext(b)` into two guards (`D == 0 || (N == MIN && D == -1)`, then
 * `q != ext(trunc q)`) with a trap block each. When `N` is the sign (zero)
 * extension of a `bits`-wide value `a` (`hi` is `a >> (bits-1)` arithmetic, or
 * 0), `N != MIN` and the quotient |a / b| <= |a| fits 2*bits, so the guards trap
 * exactly when `b == 0` or (signed) `a == MIN && b == -1`, and otherwise the low
 * halves of the wide quotient and remainder are the `bits`-wide truncating
 * quotient and remainder of `a` and `b` (|a % b| < |b|). Those are exactly the
 * inputs on which the C operation `a / b` (`a % b`) of `bits`-bit operands has
 * no defined value, and the C-like dialect defines them to trap as the machine
 * does. Only signed 32- and 64-bit divisions qualify: narrower C operands are
 * promoted to `int`, where `MIN / -1` does not overflow. */
export function classifyDivisionTraps(
  blocks: ReadonlyMap<string, BlockRegion>,
  transfers: readonly { readonly transfer: ParallelTransfer; readonly block: BlockRegion }[],
  values: ReadonlyMap<string, Value>,
  expressions: ReadonlyMap<string, Expression>,
  context: OperationContext,
  signedTraps: boolean,
): readonly DivisionTrap[] {
  const trapBlocks: BlockRegion[] = [];
  for (const block of blocks.values()) {
    context.checkpoint(1);
    if (block.control.kind === 'trap' && block.statements.length === 0) trapBlocks.push(block);
  }
  if (trapBlocks.length < 2) return [];
  const entries = new Map<string, ParallelTransfer[]>(),
    sources = new Map<ParallelTransfer, BlockRegion>();
  for (const item of transfers) {
    context.checkpoint(1);
    const list = entries.get(item.transfer.target) ?? [];
    list.push(item.transfer);
    entries.set(item.transfer.target, list);
    sources.set(item.transfer, item.block);
  }
  const resolve = (value: Value): Value => {
    for (let depth = 0; depth < 16; depth++) {
      context.checkpoint(1);
      const expression = expressions.get(value.id);
      if (
        expression?.kind !== 'cast' ||
        expression.op !== 'bitcast' ||
        !sameType(expression.value.type, value.type)
      )
        break;
      value = expression.value;
    }
    return value;
  };
  const definition = (value: Value): Expression | undefined => expressions.get(resolve(value).id);
  const constant = (value: Value): bigint | null => {
    const expression = definition(value);
    return expression?.kind === 'constant'
      ? BigInt.asUintN(bitWidth(value.type), expression.bits)
      : null;
  };
  /** One value, or structurally identical pure definitions (two reads of one
   * register join the same cells in separate nodes). */
  const same = (left: Value, right: Value, depth = 0): boolean => {
    left = resolve(left);
    right = resolve(right);
    if (left.id === right.id) return true;
    if (depth > 3 || !sameType(left.type, right.type)) return false;
    const a = expressions.get(left.id),
      b = expressions.get(right.id);
    if (!a || !b || a.kind !== b.kind || a.kind === 'indeterminate') return false;
    if (a.kind === 'constant') return a.bits === (b as typeof a).bits;
    const shape = (expression: Expression): string =>
      JSON.stringify(expression, (key, item: unknown) =>
        typeof item === 'bigint'
          ? String(item)
          : item && typeof item === 'object' && 'id' in item
            ? null
            : item,
      );
    if (shape(a) !== shape(b)) return false;
    const x = expressionOperands(a),
      y = expressionOperands(b);
    return (
      x.length === y.length && x.every((operand, index) => same(operand, y[index]!, depth + 1))
    );
  };
  /** The `bits`-wide value `x` with `value == ext(x)` (sign extension when
   * `signed`, else zero extension), also through low slices at least `bits`
   * wide of such an extension; or null. */
  const extended = (value: Value, bits: number, signed: boolean, depth = 0): Value | null => {
    const expression = definition(value);
    if (
      expression?.kind === 'cast' &&
      expression.op === (signed ? 'sign_extend' : 'zero_extend') &&
      bitWidth(expression.value.type) === bits
    )
      return expression.value;
    return depth < 4 &&
      bitWidth(value.type) >= bits &&
      ((expression?.kind === 'cast' && expression.op === 'truncate') ||
        (expression?.kind === 'extract' && expression.offset === 0))
      ? extended(expression.value, bits, signed, depth + 1)
      : null;
  };
  /** A constant 0, or bits of a zero extension above its operand. */
  const zero = (value: Value): boolean => {
    if (constant(value) === 0n) return true;
    const expression = definition(value);
    if (expression?.kind !== 'extract') return false;
    const source = definition(expression.value);
    return (
      source?.kind === 'cast' &&
      source.op === 'zero_extend' &&
      expression.offset >= bitWidth(source.value.type)
    );
  };
  /** The low half `a` of a dividend `hi:lo` whose high half is `ext(a)`'s. */
  const dividend = (value: Value, bits: number, signed: boolean): Value | null => {
    const direct = extended(value, bits, signed);
    if (direct) return direct;
    const expression = definition(value);
    let low: Value | null = null,
      high: Value | null = null;
    if (expression?.kind === 'insert' && expression.offset === bits) {
      const base = definition(expression.base);
      if (
        base?.kind === 'cast' &&
        (base.op === 'zero_extend' || base.op === 'sign_extend') &&
        bitWidth(base.value.type) === bits
      )
        low = base.value;
      high = bitWidth(expression.value.type) === bits ? expression.value : null;
    } else if (expression?.kind === 'concat' && expression.values.length === 2) {
      [low, high] = expression.values as [Value, Value];
      if (bitWidth(low.type) !== bits || bitWidth(high.type) !== bits) return null;
    }
    if (!low || !high) return null;
    if (!signed) return zero(high) ? low : null;
    const fill = definition(high);
    return fill?.kind === 'integer' &&
      fill.op === 'ashr' &&
      same(fill.left, low) &&
      constant(fill.right) === BigInt(bits - 1)
      ? low
      : null;
  };
  /** `x == k` (either order) for the given operand and constant. */
  const equals = (value: Value, operand: Value, k: bigint): boolean => {
    const expression = definition(value);
    if (expression?.kind !== 'compare' || expression.op !== 'eq') return false;
    const width = bitWidth(operand.type),
      bits = BigInt.asUintN(width, k);
    return (
      (same(expression.left, operand) && constant(expression.right) === bits) ||
      (same(expression.right, operand) && constant(expression.left) === bits)
    );
  };
  /** Both operands of a commutative 1-bit `op`, or null. */
  const pair = (value: Value, op: 'and' | 'or'): readonly [Value, Value] | null => {
    const expression = definition(value);
    return expression?.kind === 'integer' && expression.op === op && bitWidth(value.type) === 1
      ? [expression.left, expression.right]
      : null;
  };
  /** The first guard's condition: `D == 0`, or signed `D == 0 || (N == MIN && D == -1)`. */
  const zeroGuard = (condition: Value, n: Value, d: Value, signed: boolean): boolean => {
    if (!signed) return equals(condition, d, 0n);
    const or = pair(condition, 'or');
    if (!or) return false;
    const wide = bitWidth(n.type),
      minimum = 1n << BigInt(wide - 1);
    return [or, [or[1], or[0]] as const].some(([zero, overflow]) => {
      const and = pair(overflow, 'and');
      return (
        equals(zero, d, 0n) &&
        and !== null &&
        [and, [and[1], and[0]] as const].some(
          ([first, second]) => equals(first, n, minimum) && equals(second, d, -1n),
        )
      );
    });
  };
  /** The arm of an `if` into a trap block it alone enters, and the other arm. */
  const trapArm = (
    control: Control,
  ): { trap: BlockRegion; kept: ParallelTransfer; onTrue: boolean } | null => {
    if (control.kind !== 'if') return null;
    for (const [arm, other, onTrue] of [
      [control.when_true, control.when_false, true],
      [control.when_false, control.when_true, false],
    ] as const) {
      const target = blocks.get(arm.transfer.target);
      if (
        target?.control.kind === 'trap' &&
        target.statements.length === 0 &&
        arm.transfer.copies.length === 0 &&
        entries.get(target.id)?.length === 1 &&
        other.transfer.target !== target.id
      )
        return { trap: target, kept: other.transfer, onTrue };
    }
    return null;
  };
  const found: DivisionTrap[] = [];
  const claimed = new Set<string>();
  for (const block of blocks.values()) {
    context.checkpoint(1);
    // The block between the guards: the quotient-overflow guard ends it.
    const overflow = trapArm(block.control);
    if (!overflow || block.control.kind !== 'if') continue;
    const test = definition(block.control.condition);
    if (test?.kind !== 'compare' || test.op !== (overflow.onTrue ? 'ne' : 'eq')) continue;
    // q != ext(trunc q) in either operand order.
    let quotient: Value | null = null;
    for (const [wide, narrow] of [
      [test.left, test.right],
      [test.right, test.left],
    ] as const) {
      const division = definition(wide);
      const extension = definition(narrow);
      if (
        division?.kind !== 'integer' ||
        (division.op !== 'sdiv' && division.op !== 'udiv') ||
        extension?.kind !== 'cast' ||
        extension.op !== (division.op === 'sdiv' ? 'sign_extend' : 'zero_extend')
      )
        continue;
      const low = definition(extension.value);
      if (
        ((low?.kind === 'cast' && low.op === 'truncate') ||
          (low?.kind === 'extract' && low.offset === 0)) &&
        same(low.value, wide) &&
        bitWidth(extension.value.type) * 2 === bitWidth(wide.type)
      ) {
        quotient = resolve(wide);
        break;
      }
    }
    if (!quotient) continue;
    const division = definition(quotient) as Division;
    const signed = division.op === 'sdiv',
      wide = bitWidth(quotient.type),
      bits = wide / 2;
    if (![8, 16, 32, 64].includes(bits) || (signed && (!signedTraps || bits < 32))) continue;
    const n = division.left,
      d = division.right;
    const a = dividend(n, bits, signed),
      b = extended(d, bits, signed);
    if (!a || !b) continue;
    // The zero-divisor guard: the only edge into this block.
    const incoming = entries.get(block.id) ?? [];
    if (incoming.length !== 1 || incoming[0]!.copies.length !== 0) continue;
    const previous = sources.get(incoming[0]!)!;
    const zero = trapArm(previous.control);
    if (
      !zero ||
      previous.control.kind !== 'if' ||
      zero.kept !== incoming[0] ||
      zero.trap.id === overflow.trap.id ||
      claimed.has(previous.id) ||
      claimed.has(block.id)
    )
      continue;
    // The lifter branches to the trap on a true condition.
    if (!zero.onTrue || !zeroGuard(previous.control.condition, n, d, signed)) continue;
    // Every read of the wide quotient and remainder: the overflow test and
    // low-half truncations in this block, nothing else (checked below).
    const remainderOp = signed ? 'srem' : 'urem';
    const results: { value: Value; expression: Expression }[] = [];
    const wideValues = new Set<string>([quotient.id]);
    for (const node of block.statements) {
      context.checkpoint(1);
      if (node.kind !== 'assign') continue;
      const expression = expressions.get(node.result.id);
      if (
        expression?.kind === 'integer' &&
        expression.op === remainderOp &&
        same(expression.left, n) &&
        same(expression.right, d)
      )
        wideValues.add(node.result.id);
    }
    for (const node of block.statements) {
      context.checkpoint(1);
      if (node.kind !== 'assign' || bitWidth(node.result.type) !== bits) continue;
      const expression = expressions.get(node.result.id);
      if (
        !(
          (expression?.kind === 'cast' && expression.op === 'truncate') ||
          (expression?.kind === 'extract' && expression.offset === 0)
        ) ||
        !wideValues.has(resolve(expression.value).id)
      )
        continue;
      const source = resolve(expression.value);
      results.push({
        value: node.result,
        expression: {
          kind: 'integer',
          op: source.id === quotient.id ? division.op : remainderOp,
          left: a,
          right: b,
        },
      });
    }
    if (!results.length) continue;
    // Other low slices of the wide values (folded through the truncations)
    // read the narrowed result instead.
    const primary = new Map<string, Value>();
    for (const result of results) {
      const expression = expressions.get(result.value.id) as Extract<
        Expression,
        { kind: 'cast' | 'extract' }
      >;
      const source = resolve(expression.value).id;
      if (!primary.has(source)) primary.set(source, result.value);
    }
    const resultIds = new Set(results.map((item) => item.value.id)),
      overflowTest = resolve(block.control.condition).id;
    const slices: { value: Value; expression: Expression }[] = [];
    let sliced = true;
    for (const [id, expression] of expressions) {
      context.checkpoint(1);
      if (resultIds.has(id) || id === overflowTest || wideValues.has(id)) continue;
      if (!expressionOperands(expression).some((operand) => wideValues.has(operand.id))) continue;
      const value = values.get(id),
        offset =
          expression.kind === 'extract'
            ? expression.offset
            : expression.kind === 'cast' && expression.op === 'truncate'
              ? 0
              : null;
      const source =
        offset === null ? undefined : primary.get((expression as { value: Value }).value.id);
      if (!value || offset === null || !source || offset + bitWidth(value.type) > bits) {
        sliced = false;
        break;
      }
      slices.push({
        value,
        expression:
          bitWidth(value.type) === bits
            ? { kind: 'cast', op: 'bitcast', value: source }
            : { kind: 'extract', value: source, offset },
      });
    }
    if (!sliced) continue;
    const allowed = new Set<string>([
      overflowTest,
      ...resultIds,
      ...slices.map((item) => item.value.id),
    ]);
    if (!onlyReadBy(wideValues, allowed, blocks, expressions, context)) continue;
    claimed.add(previous.id);
    claimed.add(block.id);
    found.push({
      guards: new Map([
        [previous.control.id, block.id],
        [block.control.id, overflow.kept.target],
      ]),
      omitted: new Set([zero.trap.id, overflow.trap.id]),
      block: block.id,
      results,
      slices,
      signed,
      bits,
    });
  }
  return found;
}

/** Whether every operand read of `values` anywhere in the function is by a
 * definition in `allowed` (or a bitcast alias of a value, which is followed). */
function onlyReadBy(
  values: ReadonlySet<string>,
  allowed: ReadonlySet<string>,
  blocks: ReadonlyMap<string, BlockRegion>,
  expressions: ReadonlyMap<string, Expression>,
  context: OperationContext,
): boolean {
  const reads = (operands: readonly Value[]): boolean => operands.some((v) => values.has(v.id));
  for (const [id, expression] of expressions) {
    context.checkpoint(1);
    if (!allowed.has(id) && !values.has(id) && reads(expressionOperands(expression))) return false;
  }
  const bindings = (list: readonly { readonly value: Value }[]): Value[] =>
    list.map((binding) => binding.value);
  const nodeOperands = (node: Instruction): Value[] => {
    switch (node.kind) {
      case 'assign':
      case 'read_register':
      case 'memory_fence':
        return [];
      case 'write_register':
        return [node.value];
      case 'load':
        return [node.address, ...bindings(node.register_inputs)];
      case 'store':
        return [node.address, node.value, ...bindings(node.register_inputs)];
      case 'call':
        return [
          ...node.arguments,
          ...(node.target.kind === 'indirect' ? [node.target.value] : []),
          ...bindings(node.register_inputs),
        ];
      case 'unknown_effect':
        return bindings(node.register_inputs);
    }
  };
  for (const block of blocks.values()) {
    context.checkpoint(block.statements.length + 1);
    for (const node of block.statements) if (reads(nodeOperands(node))) return false;
    if (reads(bindings(block.register_exit)) || reads(bindings(block.register_entry))) return false;
    const control = block.control;
    const operands: Value[] = [];
    switch (control.kind) {
      case 'if':
        operands.push(control.condition);
        for (const arm of [control.when_true, control.when_false])
          operands.push(...arm.transfer.copies.map((copy) => copy.source));
        break;
      case 'switch':
        operands.push(control.value);
        for (const arm of [...control.cases.map((item) => item.arm), control.otherwise])
          operands.push(...arm.transfer.copies.map((copy) => copy.source));
        break;
      case 'jump':
        operands.push(...control.transfer.copies.map((copy) => copy.source));
        break;
      case 'return':
        operands.push(...control.values);
        break;
      case 'indirect':
        operands.push(control.target);
        break;
      default:
        break;
    }
    if (reads(operands)) return false;
  }
  return true;
}
