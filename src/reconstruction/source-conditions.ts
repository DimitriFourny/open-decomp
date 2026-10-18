import type { OperationContext } from '../core/index.js';
import {
  bitWidth,
  expressionOperands,
  integer,
  type DataType,
  type Expression,
  type FloatPredicate,
  type IntegerPredicate,
  type Value,
} from '../ir/index.js';

type Make = (
  key: string,
  type: DataType,
  block: string,
  expression?: Expression,
  contributors?: readonly Value[],
) => Value;

/** One outcome of an integer subtraction left - right: Z (equal), C (no
 * unsigned borrow: left >= right), S = N != V (signed less) and the wrapped
 * sign bit N, which alone is not a relation between the operands. */
interface IntegerRow {
  readonly z: boolean;
  readonly c: boolean;
  readonly s: boolean;
  readonly n: boolean;
}
type FloatRow = 'lt' | 'eq' | 'gt' | 'unordered';
type IntegerBit = 'z' | 'c' | 'n' | 'v' | IntegerPredicate;
type Subject =
  | {
      readonly kind: 'integer';
      readonly left: Value;
      readonly right: Value;
      readonly rows: readonly IntegerRow[];
      readonly atoms: Value[];
      /** Existing one-bit values: each is (or, negated, is the complement of)
       * one outcome bit of this subject. */
      readonly leaves: {
        readonly value: Value;
        readonly bit: IntegerBit;
        readonly negated: boolean;
      }[];
    }
  | {
      readonly kind: 'float';
      readonly left: Value;
      readonly right: Value;
      readonly rows: readonly FloatRow[];
      readonly atoms: Value[];
    }
  | { readonly kind: 'free'; readonly value: Value; readonly rows: readonly boolean[] };
type Formula =
  | { readonly kind: 'constant'; readonly value: boolean }
  | { readonly kind: 'integer'; readonly subject: number; readonly bit: IntegerBit }
  | { readonly kind: 'float'; readonly subject: number; readonly op: FloatPredicate }
  | { readonly kind: 'free'; readonly subject: number }
  | { readonly kind: 'not'; readonly value: Formula }
  | { readonly kind: 'and' | 'or' | 'xor'; readonly left: Formula; readonly right: Formula }
  | {
      readonly kind: 'ite';
      readonly condition: Formula;
      readonly yes: Formula;
      readonly no: Formula;
    };
/** A synthesized one-bit term: an existing value or an expression to bind. */
type Term = { readonly value: Value } | { readonly expression: Expression };

/** Preference order when several predicates agree on every feasible outcome. */
const INTEGER_PREDICATES: readonly IntegerPredicate[] = [
  'eq',
  'ne',
  'ult',
  'uge',
  'ugt',
  'ule',
  'slt',
  'sge',
  'sgt',
  'sle',
];
const SWAPPED_INTEGER: Record<IntegerPredicate, IntegerPredicate> = {
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
const SWAPPED_FLOAT: Record<FloatPredicate, FloatPredicate> = {
  eq: 'eq',
  ne: 'ne',
  lt: 'gt',
  le: 'ge',
  gt: 'lt',
  ge: 'le',
  ordered: 'ordered',
  unordered: 'unordered',
};
/** IEEE outcome sets: every relation except `ne` is false when unordered. */
const FLOAT_TRUE: Record<FloatPredicate, readonly FloatRow[]> = {
  lt: ['lt'],
  le: ['lt', 'eq'],
  gt: ['gt'],
  ge: ['gt', 'eq'],
  eq: ['eq'],
  ne: ['lt', 'gt', 'unordered'],
  ordered: ['lt', 'eq', 'gt'],
  unordered: ['unordered'],
};
const FLAG_BIT = { zero: 'z', carry: 'c', borrow: 'ult', negative: 'n', overflow: 'v' } as const;

function integerTruth(bit: IntegerBit, row: IntegerRow): boolean {
  switch (bit) {
    case 'z':
    case 'eq':
      return row.z;
    case 'ne':
      return !row.z;
    case 'c':
    case 'uge':
      return row.c;
    case 'ult':
      return !row.c;
    case 'ugt':
      return row.c && !row.z;
    case 'ule':
      return !row.c || row.z;
    case 'n':
      return row.n;
    case 'v':
      return row.n !== row.s;
    case 'slt':
      return row.s;
    case 'sge':
      return !row.s;
    case 'sgt':
      return !row.s && !row.z;
    case 'sle':
      return row.s || row.z;
  }
}

class Bound extends Error {}

/** Source view only. A one-bit condition assembled from compare flags (NZCV or
 * EFLAGS bit insertion and extraction, condition-code logic, conditional
 * compare selects, FP compare flags) is re-expressed as direct relational
 * predicates joined by `&&`/`||`. Exact by enumeration: each flag is a function
 * of a few outcomes of its operands (equal, unsigned and signed order and the
 * wrapped sign; for IEEE operands less/equal/greater/unordered). The condition
 * is tabulated over every feasible outcome and every opaque one-bit leaf, and a
 * decomposition is accepted only when it reproduces all rows; otherwise the
 * explicit form stays. Returns the root's replacement expression. */
export function foldSourceCondition(
  value: Value,
  expression: Expression,
  observe: (id: string) => Expression | undefined,
  resolve: (value: Value) => Value,
  create: Make,
  block: string,
  context: OperationContext,
): Expression | null {
  if (value.type.kind !== 'integer') return null;
  const width = value.type.bits;
  if (width > 1) {
    // A select of zero-extended one-bit arms (cset/csinc/setcc forms, constants
    // 0 and 1 included) is the zero extension of a one-bit select.
    if (expression.kind !== 'select' || bitWidth(expression.condition.type) !== 1) return null;
    const arm = (operand: Value): Value | bigint | null => {
      const definition = observe(resolve(operand).id);
      if (definition?.kind === 'constant') {
        const bits = BigInt.asUintN(width, definition.bits);
        return bits <= 1n ? bits : null;
      }
      return definition?.kind === 'cast' &&
        definition.op === 'zero_extend' &&
        bitWidth(definition.value.type) === 1
        ? definition.value
        : null;
    };
    const yes = arm(expression.when_true),
      no = arm(expression.when_false);
    if (yes === null || no === null) return null;
    const condition = resolve(expression.condition);
    const inverted = observe(condition.id);
    const bit = (item: Value | bigint): Value =>
      typeof item === 'bigint'
        ? create(`condition-constant:1:${item}`, integer(1), block, {
            kind: 'constant',
            bits: item,
          })
        : item;
    const narrow =
      yes === 1n && no === 0n
        ? condition
        : yes === 0n && no === 1n && inverted?.kind === 'integer_unary' && inverted.op === 'not'
          ? inverted.value
          : create(
              `condition-select:${condition.id}:${bit(yes).id}:${bit(no).id}`,
              integer(1),
              block,
              { kind: 'select', condition, when_true: bit(yes), when_false: bit(no) },
            );
    return { kind: 'cast', op: 'zero_extend', value: narrow };
  }
  if (!(
    (expression.kind === 'integer' && ['and', 'or', 'xor'].includes(expression.op)) ||
    (expression.kind === 'integer_unary' && expression.op === 'not') ||
    (expression.kind === 'compare' && bitWidth(expression.left.type) === 1) ||
    expression.kind === 'select' ||
    expression.kind === 'extract' ||
    expression.kind === 'flag'
  ))
    return null;
  const subjects: Subject[] = [];
  let nodes = 0,
    interesting = false;
  const constantOf = (operand: Value): bigint | undefined => {
    const definition = observe(resolve(operand).id);
    return definition?.kind === 'constant'
      ? BigInt.asUintN(bitWidth(operand.type), definition.bits)
      : undefined;
  };
  const key = (operand: Value): string => {
    const constant = constantOf(operand);
    return constant === undefined
      ? `v:${resolve(operand).id}`
      : `k:${operand.type.kind}:${bitWidth(operand.type)}:${constant}`;
  };
  const integerRows = (left: Value, right: Value): IntegerRow[] => {
    const rows: IntegerRow[] = [{ z: true, c: true, s: false, n: false }];
    if (key(left) === key(right)) return rows;
    const width = bitWidth(left.type),
      k = constantOf(right),
      sign = 1n << BigInt(width - 1);
    for (const c of [false, true])
      for (const s of [false, true])
        for (const n of [false, true]) {
          // Only exact consequences of a constant right operand remove rows;
          // every other combination stays (conservatively) feasible.
          if (k === 0n && (!c || n !== s)) continue;
          if (k === (1n << BigInt(width)) - 1n && c) continue;
          if (k === sign && s) continue;
          if (k === sign - 1n && !s) continue;
          rows.push({ z: false, c, s, n });
        }
    return rows;
  };
  /** One subject per operand pair; the reversed pair reuses it. */
  const subject = (
    kind: 'integer' | 'float',
    left: Value,
    right: Value,
    atom: Value,
  ): { index: number; swapped: boolean } => {
    const a = key(left),
      b = key(right);
    for (const [index, item] of subjects.entries()) {
      if (item.kind !== kind) continue;
      const x = key(item.left),
        y = key(item.right);
      if ((x === a && y === b) || (x === b && y === a)) {
        interesting = true;
        item.atoms.push(atom);
        return { index, swapped: x !== a };
      }
    }
    subjects.push(
      kind === 'integer'
        ? { kind, left, right, rows: integerRows(left, right), atoms: [atom], leaves: [] }
        : {
            kind,
            left,
            right,
            rows: a === b ? ['eq', 'unordered'] : ['lt', 'eq', 'gt', 'unordered'],
            atoms: [atom],
          },
    );
    return { index: subjects.length - 1, swapped: false };
  };
  const free = (atom: Value): Formula => {
    let index = subjects.findIndex((item) => item.kind === 'free' && item.value.id === atom.id);
    if (index < 0) {
      index = subjects.length;
      subjects.push({ kind: 'free', value: atom, rows: [false, true] });
    }
    return { kind: 'free', subject: index };
  };
  const integerAtom = (
    left: Value,
    right: Value,
    bit: IntegerBit,
    atom: Value,
    negated = false,
  ): Formula => {
    // Z and C are relations of the operands; N and V describe only left - right.
    const relation: IntegerBit = bit === 'z' ? 'eq' : bit === 'c' ? 'uge' : bit;
    const { index, swapped } = subject('integer', left, right, atom);
    if (swapped && (relation === 'n' || relation === 'v')) return free(atom);
    const oriented = swapped ? SWAPPED_INTEGER[relation as IntegerPredicate] : bit;
    (subjects[index] as Subject & { kind: 'integer' }).leaves.push({
      value: atom,
      bit: oriented,
      negated,
    });
    const result: Formula = { kind: 'integer', subject: index, bit: oriented };
    return negated ? { kind: 'not', value: result } : result;
  };
  /** Bit `offset` of `source` through insert/concat/extension wiring; `atom`
   * is an existing value with exactly this bit, when there is one. */
  const bit = (source: Value, offset: number, depth: number, atom?: Value): Formula => {
    context.checkpoint(1);
    if (++nodes > 128 || depth > 48) throw new Bound();
    source = resolve(source);
    const width = bitWidth(source.type);
    if (source.type.kind !== 'integer' || offset >= width) throw new Bound();
    if (width === 1) return formula(source, depth + 1);
    const definition = observe(source.id);
    switch (definition?.kind) {
      case 'constant':
        return { kind: 'constant', value: ((definition.bits >> BigInt(offset)) & 1n) === 1n };
      case 'insert': {
        interesting = true;
        const low = definition.offset;
        return offset >= low && offset < low + bitWidth(definition.value.type)
          ? bit(definition.value, offset - low, depth + 1, atom)
          : bit(definition.base, offset, depth + 1, atom);
      }
      case 'concat': {
        let low = 0;
        for (const part of definition.values) {
          const partWidth = bitWidth(part.type);
          if (offset < low + partWidth) return bit(part, offset - low, depth + 1, atom);
          low += partWidth;
        }
        break;
      }
      case 'extract':
        return bit(definition.value, definition.offset + offset, depth + 1, atom);
      case 'cast': {
        if (definition.value.type.kind !== 'integer') break;
        const inner = bitWidth(definition.value.type);
        if (definition.op === 'truncate' || offset < inner)
          return bit(definition.value, offset, depth + 1, atom);
        if (definition.op === 'zero_extend') return { kind: 'constant', value: false };
        if (definition.op === 'sign_extend')
          return bit(definition.value, inner - 1, depth + 1, atom);
        break;
      }
    }
    const leaf =
      atom ??
      create(`condition-bit:${source.id}:${offset}`, integer(1), block, {
        kind: 'extract',
        value: source,
        offset,
      });
    if (offset !== width - 1) return free(leaf);
    // The sign bit of a wrapped difference is N of that subtraction; the sign
    // bit of any other word is N of its comparison with zero (where V = 0).
    if (definition?.kind === 'integer' && definition.op === 'sub')
      return integerAtom(resolve(definition.left), resolve(definition.right), 'n', leaf);
    const zero = create(`condition-zero:${width}`, source.type, block, {
      kind: 'constant',
      bits: 0n,
    });
    return integerAtom(source, zero, 'n', leaf);
  };
  const formula = (atom: Value, depth: number): Formula => {
    context.checkpoint(1);
    if (++nodes > 128 || depth > 48) throw new Bound();
    atom = resolve(atom);
    const definition = observe(atom.id);
    switch (definition?.kind) {
      case 'constant':
        return { kind: 'constant', value: (definition.bits & 1n) === 1n };
      case 'integer':
        if (definition.op !== 'and' && definition.op !== 'or' && definition.op !== 'xor') break;
        if (definition.op === 'xor') interesting = true;
        return {
          kind: definition.op,
          left: formula(definition.left, depth + 1),
          right: formula(definition.right, depth + 1),
        };
      case 'integer_unary': {
        if (definition.op !== 'not') break;
        const inner = formula(definition.value, depth + 1);
        // An inverted relation is often a single complementary relation, and an
        // inverted connective distributes onto its predicates.
        if (
          inner.kind === 'integer' ||
          inner.kind === 'and' ||
          inner.kind === 'or' ||
          inner.kind === 'not' ||
          (inner.kind === 'float' && ['eq', 'ne', 'ordered', 'unordered'].includes(inner.op))
        )
          interesting = true;
        return { kind: 'not', value: inner };
      }
      case 'compare': {
        if (definition.left.type.kind !== 'integer') break;
        if (bitWidth(definition.left.type) > 1) {
          const left = resolve(definition.left),
            right = resolve(definition.right),
            difference = observe(left.id);
          // The signed sign test of a wrapped difference is N of that
          // subtraction (a folded MI/PL reads back as a flag); x + c is the
          // difference x - (-c).
          const addend =
            difference?.kind === 'integer' && difference.op === 'add'
              ? constantOf(difference.right)
              : undefined;
          if (
            (definition.op === 'slt' || definition.op === 'sge') &&
            constantOf(right) === 0n &&
            difference?.kind === 'integer' &&
            (difference.op === 'sub' || addend !== undefined)
          ) {
            const width = bitWidth(left.type);
            const subtrahend =
              addend === undefined
                ? resolve(difference.right)
                : create(
                    `condition-constant:${width}:${BigInt.asUintN(width, -addend)}`,
                    left.type,
                    block,
                    { kind: 'constant', bits: BigInt.asUintN(width, -addend) },
                  );
            return integerAtom(
              resolve(difference.left),
              subtrahend,
              'n',
              atom,
              definition.op === 'sge',
            );
          }
          return integerAtom(left, right, definition.op, atom);
        }
        if (definition.op !== 'eq' && definition.op !== 'ne') break;
        interesting = true;
        const difference: Formula = {
          kind: 'xor',
          left: formula(definition.left, depth + 1),
          right: formula(definition.right, depth + 1),
        };
        return definition.op === 'ne' ? difference : { kind: 'not', value: difference };
      }
      case 'select':
        interesting = true;
        return {
          kind: 'ite',
          condition: formula(definition.condition, depth + 1),
          yes: formula(definition.when_true, depth + 1),
          no: formula(definition.when_false, depth + 1),
        };
      case 'extract':
        return bit(definition.value, definition.offset, depth + 1, atom);
      case 'cast':
        if (
          !['bitcast', 'truncate', 'zero_extend'].includes(definition.op) ||
          definition.value.type.kind !== 'integer'
        )
          break;
        return bit(definition.value, 0, depth + 1, atom);
      case 'flag': {
        if (constantOf(definition.carry) !== 0n || definition.flag === 'parity') break;
        let left = resolve(definition.left),
          right = resolve(definition.right);
        if (definition.op === 'add') {
          // left + k has the N, Z, C and V flags of left - (-k) for every
          // constant k except 0 (never carries) and the signed minimum.
          if (definition.flag === 'borrow') break;
          if (constantOf(left) !== undefined) [left, right] = [right, left];
          const width = bitWidth(right.type),
            k = constantOf(right);
          if (k === undefined || k === 0n || k === 1n << BigInt(width - 1)) {
            // Otherwise Z and N describe the wrapped sum itself and C is its
            // unsigned wrap below an addend; V has no relational form.
            if (definition.flag === 'overflow') break;
            const sum = create(`condition-sum:${left.id}:${right.id}`, left.type, block, {
              kind: 'integer',
              op: 'add',
              left,
              right,
            });
            const zero = create(`condition-zero:${width}`, left.type, block, {
              kind: 'constant',
              bits: 0n,
            });
            interesting = true;
            return definition.flag === 'carry'
              ? integerAtom(sum, left, 'ult', atom)
              : integerAtom(sum, zero, definition.flag === 'zero' ? 'z' : 'n', atom);
          }
          const negated = BigInt.asUintN(width, -k);
          right = create(`condition-constant:${width}:${negated}`, right.type, block, {
            kind: 'constant',
            bits: negated,
          });
        }
        interesting = true;
        return integerAtom(left, right, FLAG_BIT[definition.flag], atom);
      }
      case 'float_compare': {
        const { index, swapped } = subject(
          'float',
          resolve(definition.left),
          resolve(definition.right),
          atom,
        );
        return {
          kind: 'float',
          subject: index,
          op: swapped ? SWAPPED_FLOAT[definition.op] : definition.op,
        };
      }
    }
    return free(atom);
  };
  let root: Formula;
  try {
    root = formula(value, 0);
  } catch (error) {
    if (error instanceof Bound) return null;
    throw error;
  }
  // Lone leaves and unrelated predicates already print directly; rebuild only
  // flag wiring, selects and logic over shared operands.
  if (!interesting || subjects.length > 8) return null;
  let size = 1;
  for (const item of subjects) size *= item.rows.length;
  if (size > 4096) return null;
  context.checkpoint(size);
  const evaluate = (node: Formula, row: readonly number[]): boolean => {
    switch (node.kind) {
      case 'constant':
        return node.value;
      case 'integer': {
        const item = subjects[node.subject] as Subject & { kind: 'integer' };
        return integerTruth(node.bit, item.rows[row[node.subject]!]!);
      }
      case 'float': {
        const item = subjects[node.subject] as Subject & { kind: 'float' };
        return FLOAT_TRUE[node.op].includes(item.rows[row[node.subject]!]!);
      }
      case 'free':
        return row[node.subject] === 1;
      case 'not':
        return !evaluate(node.value, row);
      case 'and':
        return evaluate(node.left, row) && evaluate(node.right, row);
      case 'or':
        return evaluate(node.left, row) || evaluate(node.right, row);
      case 'xor':
        return evaluate(node.left, row) !== evaluate(node.right, row);
      case 'ite':
        return evaluate(node.condition, row) ? evaluate(node.yes, row) : evaluate(node.no, row);
    }
  };
  // Complete truth table in mixed radix, subject 0 least significant.
  const table: boolean[] = [];
  const assignment = subjects.map(() => 0);
  for (let index = 0; index < size; index++) {
    let rest = index;
    for (const [i, item] of subjects.entries()) {
      assignment[i] = rest % item.rows.length;
      rest = Math.floor(rest / item.rows.length);
    }
    table.push(evaluate(root, assignment));
  }
  /** Content-addressed: a re-run of this fold reuses identical definitions. */
  const bind = (term: Term, contributors?: readonly Value[]): Value => {
    if ('value' in term) return term.value;
    const expression = term.expression;
    const content = [
      expression.kind,
      'op' in expression ? expression.op : '',
      ...expressionOperands(expression).map((operand) => operand.id),
    ];
    return create(
      `condition:${value.id}:${content.join(':')}`,
      integer(1),
      block,
      expression,
      contributors,
    );
  };
  const not = (term: Term, contributors?: readonly Value[]): Term => ({
    expression: { kind: 'integer_unary', op: 'not', value: bind(term, contributors) },
  });
  /** How one subject's outcome set is spelled. Pure: a failed search over
   * decompositions creates no definitions. */
  type Spelling =
    | { readonly kind: 'free'; readonly positive: boolean }
    | { readonly kind: 'integer'; readonly op: IntegerPredicate }
    | { readonly kind: 'sign'; readonly negative: boolean }
    | { readonly kind: 'float'; readonly op: FloatPredicate; readonly negated: boolean }
    | { readonly kind: 'either'; readonly first: FloatPredicate; readonly second: FloatPredicate }
    | { readonly kind: 'leaf'; readonly value: Value; readonly negated: boolean };
  const spell = (index: number, rows: readonly boolean[]): Spelling | null => {
    const item = subjects[index]!;
    if (item.kind === 'free') return { kind: 'free', positive: rows[1]! };
    if (item.kind === 'integer') {
      const op = INTEGER_PREDICATES.find((candidate) =>
        item.rows.every((outcome, i) => integerTruth(candidate, outcome) === rows[i]),
      );
      if (op) return { kind: 'integer', op };
      // N alone (MI/PL) is the sign of the wrapped difference itself.
      const negative = [true, false].find((polarity) =>
        item.rows.every((outcome, i) => (outcome.n === polarity) === rows[i]),
      );
      if (negative !== undefined) return { kind: 'sign', negative };
      // V alone (VS/VC) has no relational form; its own flag value stays.
      for (const leaf of item.leaves)
        for (const negated of [false, true])
          if (
            item.rows.every(
              (outcome, i) =>
                ((integerTruth(leaf.bit, outcome) !== leaf.negated) !== negated) === rows[i],
            )
          )
            return { kind: 'leaf', value: leaf.value, negated };
      return null;
    }
    const holds = (set: readonly FloatRow[], negated = false): boolean =>
      item.rows.every((outcome, i) => (set.includes(outcome) !== negated) === rows[i]);
    const order: readonly FloatPredicate[] =
      item.rows.length === 2
        ? ['unordered', 'ordered']
        : ['lt', 'le', 'gt', 'ge', 'eq', 'ne', 'unordered', 'ordered'];
    for (const op of order) if (holds(FLOAT_TRUE[op])) return { kind: 'float', op, negated: false };
    for (const op of ['lt', 'le', 'gt', 'ge'] as const)
      if (holds(FLOAT_TRUE[op], true)) return { kind: 'float', op, negated: true };
    for (const [first, second] of [
      ['lt', 'gt'],
      ['eq', 'unordered'],
    ] as const)
      if (holds([...FLOAT_TRUE[first], ...FLOAT_TRUE[second]]))
        return { kind: 'either', first, second };
    return null;
  };
  const term = (index: number, spelling: Spelling): Term => {
    const item = subjects[index]!;
    if (item.kind === 'free')
      return spelling.kind === 'free' && spelling.positive
        ? { value: item.value }
        : not({ value: item.value });
    if (item.kind === 'integer') {
      if (spelling.kind === 'integer')
        return {
          expression: { kind: 'compare', op: spelling.op, left: item.left, right: item.right },
        };
      if (spelling.kind === 'leaf')
        return spelling.negated ? not({ value: spelling.value }) : { value: spelling.value };
      const width = bitWidth(item.left.type);
      // The wrapped difference; minus a negative constant reads as a sum.
      const k = constantOf(item.right);
      const sum = k !== undefined && k > 1n << BigInt(width - 1);
      const addend = sum
        ? create(
            `condition-constant:${width}:${BigInt.asUintN(width, -k)}`,
            item.right.type,
            block,
            {
              kind: 'constant',
              bits: BigInt.asUintN(width, -k),
            },
          )
        : item.right;
      const difference = create(
        `condition-difference:${item.left.id}:${addend.id}:${sum}`,
        item.left.type,
        block,
        { kind: 'integer', op: sum ? 'add' : 'sub', left: item.left, right: addend },
      );
      const zero = create(`condition-zero:${width}`, item.left.type, block, {
        kind: 'constant',
        bits: 0n,
      });
      return {
        expression: {
          kind: 'compare',
          op: spelling.kind === 'sign' && spelling.negative ? 'slt' : 'sge',
          left: difference,
          right: zero,
        },
      };
    }
    // Existing compare values keep their original FP environment site.
    const compare = (op: FloatPredicate): Term => {
      const existing = item.atoms.find((atom) => {
        const definition = observe(atom.id);
        return (
          definition?.kind === 'float_compare' &&
          definition.op === op &&
          resolve(definition.left).id === item.left.id &&
          resolve(definition.right).id === item.right.id
        );
      });
      return existing
        ? { value: existing }
        : { expression: { kind: 'float_compare', op, left: item.left, right: item.right } };
    };
    if (spelling.kind === 'either')
      return {
        expression: {
          kind: 'integer',
          op: 'or',
          left: bind(compare(spelling.first), item.atoms),
          right: bind(compare(spelling.second), item.atoms),
        },
      };
    const op = (spelling as Spelling & { kind: 'float' }).op;
    return (spelling as Spelling & { kind: 'float' }).negated
      ? not(compare(op), item.atoms)
      : compare(op);
  };
  type Plan =
    | { readonly kind: 'constant'; readonly truth: boolean }
    | { readonly kind: 'test'; readonly subject: number; readonly spelling: Spelling }
    | {
        readonly kind: 'and' | 'or';
        readonly subject: number;
        readonly spelling: Spelling;
        readonly rest: Plan;
      };
  let attempts = 0;
  /** Shannon decomposition, preferring operand order: split on a subject
   * whose outcomes fall into exactly two classes, one with a constant
   * cofactor, giving `P && h` or `P || h`; backtrack over the split subject. */
  const plan = (fixed: readonly (number | undefined)[]): Plan | null => {
    context.checkpoint(1);
    if (++attempts > 256) return null;
    const open = subjects.flatMap((_, i) => (fixed[i] === undefined ? [i] : []));
    const cofactor = (variable: number, choice: number): string => {
      const current = fixed.map((item) => item ?? 0);
      current[variable] = choice;
      const rest = open.filter((i) => i !== variable);
      let text = '';
      const walk = (position: number): void => {
        context.checkpoint(1);
        if (position === rest.length) {
          let index = 0;
          for (let i = subjects.length - 1; i >= 0; i--)
            index = index * subjects[i]!.rows.length + current[i]!;
          text += table[index] ? '1' : '0';
          return;
        }
        const i = rest[position]!;
        for (let choice = 0; choice < subjects[i]!.rows.length; choice++) {
          current[i] = choice;
          walk(position + 1);
        }
      };
      walk(0);
      return text;
    };
    const zero = (text: string): boolean => !text.includes('1'),
      one = (text: string): boolean => !text.includes('0');
    let dependent = false;
    for (const variable of open) {
      const cofactors = subjects[variable]!.rows.map((_, choice) => cofactor(variable, choice));
      const classes = [...new Set(cofactors)];
      if (classes.length === 1) continue;
      dependent = true;
      if (classes.length > 2) continue;
      const [a, b] = classes as [string, string];
      // f = P ? h : 0 is P && h; f = P ? 1 : h is P || h.
      const [chosen, op] = zero(b)
        ? [a, 'and' as const]
        : zero(a)
          ? [b, 'and' as const]
          : one(a)
            ? [a, 'or' as const]
            : one(b)
              ? [b, 'or' as const]
              : [null, null];
      if (!chosen) continue;
      const spelling = spell(
        variable,
        cofactors.map((text) => text === chosen),
      );
      if (!spelling) continue;
      const tail = op === 'and' ? chosen : chosen === a ? b : a;
      if (op === 'and' ? one(tail) : zero(tail))
        return { kind: 'test', subject: variable, spelling };
      const next = [...fixed];
      next[variable] = cofactors.indexOf(tail);
      const rest = plan(next);
      if (rest) return { kind: op, subject: variable, spelling, rest };
    }
    if (dependent) return null;
    let index = 0;
    for (let i = subjects.length - 1; i >= 0; i--)
      index = index * subjects[i]!.rows.length + (fixed[i] ?? 0);
    return { kind: 'constant', truth: table[index]! };
  };
  const build = (step: Plan): Term => {
    if (step.kind === 'constant')
      return { expression: { kind: 'constant', bits: step.truth ? 1n : 0n } };
    const test = term(step.subject, step.spelling);
    if (step.kind === 'test') return test;
    const item = subjects[step.subject]!;
    return {
      expression: {
        kind: 'integer',
        op: step.kind,
        left: bind(test, item.kind === 'free' ? undefined : item.atoms),
        right: bind(build(step.rest)),
      },
    };
  };
  const decomposition = plan(subjects.map(() => undefined));
  if (!decomposition) return null;
  const result = build(decomposition);
  // A float compare root binds to its own definition, so that the definition
  // carries the original compare sites as origins (FP environment coverage).
  const replacement: Expression =
    'expression' in result && result.expression.kind === 'float_compare'
      ? {
          kind: 'cast',
          op: 'bitcast',
          value: bind(
            result,
            subjects.flatMap((entry) => (entry.kind === 'float' ? entry.atoms : [])),
          ),
        }
      : 'value' in result
        ? { kind: 'cast', op: 'bitcast', value: result.value }
        : result.expression;
  // A fold of an already folded root reproduces it; report no change.
  const same =
    replacement.kind === expression.kind &&
    ('op' in replacement ? replacement.op : '') === ('op' in expression ? expression.op : '') &&
    expressionOperands(replacement).every(
      (operand, i) => resolve(operand).id === resolve(expressionOperands(expression)[i]!).id,
    ) &&
    expressionOperands(replacement).length === expressionOperands(expression).length;
  if (same) return null;
  if (replacement.kind === 'cast' && resolve(replacement.value).id === value.id) return null;
  return replacement;
}
