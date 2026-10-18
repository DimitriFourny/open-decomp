import type { OperationContext } from '../core/index.js';
import {
  bitWidth,
  integer,
  sameType,
  type DataType,
  type Expression,
  type Value,
} from '../ir/index.js';

interface Bit {
  readonly value: Value;
  readonly offset: number;
}
type Lane = Bit | 0 | 1;
type Make = (
  key: string,
  type: DataType,
  block: string,
  expression?: Expression,
  contributors?: readonly Value[],
) => Value;

/** Exact, bounded wiring analysis, not arithmetic equivalence or ABI inference.
 * Opaque SSA leaves retain identity and ordered indeterminate dependencies. */
export function recombineBitSlices(
  result: Value,
  expression: Expression,
  observe: (id: string) => Expression | undefined,
  make: Make,
  block: string,
  context: OperationContext,
  packingShifts: Set<string>,
): Expression | null {
  if (
    result.type.kind !== 'integer' ||
    bitWidth(result.type) > 128 ||
    !['concat', 'insert', 'integer'].includes(expression.kind) ||
    (expression.kind === 'integer' && !['or', 'xor'].includes(expression.op))
  )
    return null;
  const equal = (a: Lane, b: Lane): boolean =>
    a === b ||
    (typeof a === 'object' &&
      typeof b === 'object' &&
      a.value.id === b.value.id &&
      a.offset === b.offset);
  const trace = (root: Expression): { bits: Lane[]; leaves: string[] } | null => {
    let work = 0;
    const leaves: string[] = [],
      seen = new Set<string>(),
      active = new Set<string>();
    const visit = (value: Value, definition = observe(value.id), depth = 0): Lane[] | null => {
      context.checkpoint(1);
      const width = bitWidth(value.type);
      if (
        ++work > 128 ||
        depth > 24 ||
        width > 128 ||
        value.type.kind !== 'integer' ||
        active.has(value.id)
      )
        return null;
      active.add(value.id);
      const leafStart = leaves.length;
      const get = (operand: Value) => visit(operand, observe(operand.id), depth + 1);
      const fit = (bits: Lane[]): Lane[] => Array.from({ length: width }, (_, i) => bits[i] ?? 0);
      let bits: Lane[] | null = null;
      if (definition?.kind === 'constant')
        bits = Array.from(
          { length: width },
          (_, i) => Number((definition.bits >> BigInt(i)) & 1n) as 0 | 1,
        );
      else if (definition?.kind === 'extract') {
        const source = get(definition.value);
        if (source) bits = fit(source.slice(definition.offset));
      } else if (
        definition?.kind === 'cast' &&
        ['bitcast', 'truncate', 'zero_extend', 'sign_extend'].includes(definition.op)
      ) {
        const source = get(definition.value);
        if (source)
          bits =
            definition.op === 'sign_extend'
              ? Array.from({ length: width }, (_, i) => source[i] ?? source.at(-1)!)
              : fit(source);
      } else if (definition?.kind === 'concat') {
        bits = [];
        for (const part of definition.values) {
          const source = get(part);
          if (!source) {
            bits = null;
            break;
          }
          bits.push(...source);
        }
        if (bits) bits = fit(bits);
      } else if (definition?.kind === 'insert') {
        const base = get(definition.base),
          inserted = get(definition.value);
        if (base && inserted) {
          bits = fit(base);
          for (let i = 0; i < inserted.length && i + definition.offset < width; i++)
            bits[i + definition.offset] = inserted[i]!;
        }
      } else if (definition?.kind === 'integer') {
        const right = observe(definition.right.id);
        let count: bigint | null = null;
        if (right?.kind === 'constant') {
          const n = BigInt.asUintN(bitWidth(definition.right.type), right.bits);
          if (definition.op === 'shl' || definition.op === 'lshr') count = n;
          else if (definition.op === 'mul' && n > 0n && (n & (n - 1n)) === 0n)
            count = BigInt(n.toString(2).length - 1);
        }
        if (count !== null) {
          const source = get(definition.left);
          if (source) {
            const shift = Number(count > BigInt(width) ? BigInt(width) : count);
            bits =
              definition.op === 'lshr'
                ? fit(fit(source).slice(shift))
                : fit([...Array<Lane>(shift).fill(0), ...source]);
          }
        } else if (['or', 'xor', 'and'].includes(definition.op)) {
          const left = get(definition.left),
            right = get(definition.right);
          if (left && right) {
            bits = [];
            for (let i = 0; i < width; i++) {
              const a = left[i] ?? 0,
                b = right[i] ?? 0;
              if (equal(a, b)) bits.push(definition.op === 'xor' ? 0 : a);
              else if ((definition.op === 'or' || definition.op === 'xor') && (a === 0 || b === 0))
                bits.push(a === 0 ? b : a);
              else if (definition.op === 'and' && (a === 0 || b === 0)) bits.push(0);
              else if (definition.op === 'and' && (a === 1 || b === 1)) bits.push(a === 1 ? b : a);
              else {
                bits = null;
                break;
              }
            }
          }
        }
      }
      active.delete(value.id);
      if (bits) return bits;
      // Unsupported arithmetic is an indivisible leaf, not its exploratory
      // operands. Restore the dependency prefix before publishing that leaf.
      while (leaves.length > leafStart) seen.delete(leaves.pop()!);
      if (definition && ['extract', 'cast', 'concat', 'insert'].includes(definition.kind))
        return null;
      if (!seen.has(value.id)) {
        seen.add(value.id);
        leaves.push(value.id);
      }
      return Array.from({ length: width }, (_, offset) => ({ value, offset }));
    };
    const bits = visit(result, root);
    return bits ? { bits, leaves } : null;
  };
  const original = trace(expression);
  if (!original) return null;
  const { bits } = original;
  const slice = (lanes: Lane[], key: string): Value | null => {
    const first = lanes[0];
    if (typeof first !== 'object') {
      if (!lanes.every((lane) => typeof lane === 'number')) return null;
      let constant = 0n;
      lanes.forEach((lane, i) => {
        if (lane === 1) constant |= 1n << BigInt(i);
      });
      return make(`${key}:constant`, integer(lanes.length), block, {
        kind: 'constant',
        bits: constant,
      });
    }
    if (
      !lanes.every(
        (lane, i) =>
          typeof lane === 'object' &&
          lane.value.id === first.value.id &&
          lane.offset === first.offset + i,
      )
    )
      return null;
    if (first.offset === 0 && bitWidth(first.value.type) === lanes.length) return first.value;
    return make(`${key}:slice`, integer(lanes.length), block, {
      kind: 'extract',
      value: first.value,
      offset: first.offset,
    });
  };
  let candidate: Expression | null = null;
  const first = bits[0];
  if (typeof first === 'object' && first.value.id !== result.id && first.offset === 0) {
    let used = 0;
    while (used < bits.length) {
      const lane = bits[used]!;
      if (typeof lane !== 'object' || lane.value.id !== first.value.id || lane.offset !== used)
        break;
      used++;
    }
    const tail = bits.slice(used);
    const zero = tail.every((lane) => lane === 0);
    const signed = tail.length > 0 && tail.every((lane) => equal(lane, bits[used - 1]!));
    if (zero || signed) {
      const whole = slice(bits.slice(0, used), `cell-whole:${result.id}`)!;
      candidate = {
        kind: 'cast',
        op: sameType(result.type, whole.type) ? 'bitcast' : zero ? 'zero_extend' : 'sign_extend',
        value: whole,
      };
    }
  }
  if (!candidate && (expression.kind === 'concat' || expression.kind === 'insert')) {
    const bases = new Map<string, Value>();
    bits.forEach((lane, i) => {
      if (
        typeof lane === 'object' &&
        lane.offset === i &&
        bitWidth(lane.value.type) === bits.length
      )
        bases.set(lane.value.id, lane.value);
    });
    for (const base of bases.values()) {
      const matches = (lane: Lane, i: number) =>
        typeof lane === 'object' && lane.value.id === base.id && lane.offset === i;
      const start = bits.findIndex((lane, i) => !matches(lane, i));
      if (start < 0) continue;
      let end = bits.length;
      while (end > start && matches(bits[end - 1]!, end - 1)) end--;
      const inserted = slice(bits.slice(start, end), `cell-insert:${result.id}`);
      if (!inserted) continue;
      const mask = make(`cell-mask:${result.id}`, result.type, block, {
        kind: 'constant',
        bits: BigInt.asUintN(bits.length, ~(((1n << BigInt(end - start)) - 1n) << BigInt(start))),
      });
      const kept = make(`cell-kept:${result.id}`, result.type, block, {
        kind: 'integer',
        op: 'and',
        left: base,
        right: mask,
      });
      let packed = make(`cell-extended:${result.id}`, result.type, block, {
        kind: 'cast',
        op: 'zero_extend',
        value: inserted,
      });
      if (start) {
        const count = make(`cell-count:${result.id}`, result.type, block, {
          kind: 'constant',
          bits: BigInt(start),
        });
        packed = make(`cell-shift:${result.id}`, result.type, block, {
          kind: 'integer',
          op: 'shl',
          left: packed,
          right: count,
        });
        packingShifts.add(packed.id);
      }
      candidate = { kind: 'integer', op: 'or', left: kept, right: packed };
      break;
    }
  }
  if (!candidate) return null;
  let rewritten = trace(candidate);
  if (
    candidate.kind === 'integer' &&
    candidate.op === 'or' &&
    (!rewritten || original.leaves.some((leaf, i) => leaf !== rewritten!.leaves[i]))
  ) {
    candidate = { ...candidate, left: candidate.right, right: candidate.left };
    rewritten = trace(candidate);
  }
  return rewritten &&
    original.leaves.length === rewritten.leaves.length &&
    original.leaves.every((leaf, i) => leaf === rewritten.leaves[i]) &&
    bits.every((bit, i) => equal(bit, rewritten.bits[i]!))
    ? candidate
    : null;
}
