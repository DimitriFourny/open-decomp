import { OperationError, type OperationContext } from '../core/index.js';
import { bitWidth, type Expression, type Origin, type Value } from '../ir/index.js';

export interface LocalValidationRecord {
  readonly kind: 'bitvector' | 'parallel-copy' | 'stack-promotion' | 'control';
  readonly subject: string;
  readonly subject_ids?: readonly string[];
  readonly status: 'verified' | 'unverified' | 'rejected';
  readonly scope: string;
  readonly reason?: string;
  readonly counterexample?: Readonly<Record<string, string>>;
}

export function rejectTranslation(record: LocalValidationRecord, origin: Origin): never {
  throw new OperationError({
    code: 'unavailable_semantics',
    severity: 'error',
    message: `Local ${record.kind} translation rejected (${record.subject}): ${JSON.stringify(record.counterexample)}`,
    entity_id: origin.id,
    ...(origin.provenance.ranges[0] ? { address: origin.provenance.ranges[0].start } : {}),
    evidence_ids: origin.provenance.evidence_ids,
  });
}

class Unsupported extends Error {}
/** Local limits are deliberately separate from the shared operation limits. Only
 * this exception is caught; cancellation/deadline/outer exhaustion propagate. */
export class ValidationAllowance {
  private work = 0;
  constructor(
    readonly context: OperationContext,
    private readonly limit = Math.min(8000, Math.floor((context.remainingWork?.() ?? 8000) / 64)),
  ) {}

  charge(): void {
    if (this.work >= this.limit) {
      this.context.checkpoint(0);
      throw new Unsupported('local validation work allowance exhausted');
    }
    this.context.checkpoint(1);
    this.work++;
  }
}

/** Reduced ordered BDDs, independent of the IR interpreter and expression folder.
 * Bits are ordered least-significant first and interleaved across symbolic leaves.
 * No process-global cache or cache keyed by a mutable IR map is used. */
class Bits {
  private readonly nodes: { variable: number; low: number; high: number }[] = [
    { variable: Infinity, low: 0, high: 0 },
    { variable: Infinity, low: 1, high: 1 },
  ];
  private readonly unique = new Map<string, number>();
  private readonly memo = new Map<string, number>();
  readonly variables = new Map<string, number>();
  private operations = 0;
  constructor(private readonly allowance: ValidationAllowance) {}

  tick(): void {
    this.allowance.charge();
    if (++this.operations > 12_000) throw new Unsupported('local BDD complexity bound exceeded');
  }

  node(variable: number, low: number, high: number): number {
    this.tick();
    if (low === high) return low;
    const key = `${variable}:${low}:${high}`,
      previous = this.unique.get(key);
    if (previous !== undefined) return previous;
    const id = this.nodes.length;
    this.nodes.push({ variable, low, high });
    this.unique.set(key, id);
    return id;
  }

  input(id: string, width: number): number[] {
    let index = this.variables.get(id);
    if (index === undefined) {
      index = this.variables.size;
      if (index >= 64) throw new Unsupported('symbolic leaf bound exceeded');
      this.variables.set(id, index);
    }
    return Array.from({ length: width }, (_, bit) => this.node(bit * 64 + index, 0, 1));
  }

  apply(op: 'and' | 'or' | 'xor', a: number, b: number): number {
    this.tick();
    if (a > b) [a, b] = [b, a];
    if (op === 'and' && (a === 0 || a === b)) return a;
    if (op === 'and' && a === 1) return b;
    if (op === 'or' && (a === 1 || a === b)) return a;
    if (op === 'or' && a === 0) return b;
    if (op === 'xor' && a === b) return 0;
    if (op === 'xor' && a === 0) return b;
    const key = `${op}:${a}:${b}`,
      previous = this.memo.get(key);
    if (previous !== undefined) return previous;
    const x = this.nodes[a]!,
      y = this.nodes[b]!,
      variable = Math.min(x.variable, y.variable);
    const result = this.node(
      variable,
      this.apply(op, x.variable === variable ? x.low : a, y.variable === variable ? y.low : b),
      this.apply(op, x.variable === variable ? x.high : a, y.variable === variable ? y.high : b),
    );
    this.memo.set(key, result);
    return result;
  }

  not(a: number): number {
    return this.apply('xor', a, 1);
  }

  constant(bits: bigint, width: number): number[] {
    return Array.from({ length: width }, (_, i) => {
      this.tick();
      return Number((bits >> BigInt(i)) & 1n);
    });
  }

  add(a: readonly number[], b: readonly number[], carry = 0): number[] {
    return a.map((x, i) => {
      const y = b[i] ?? 0,
        sum = this.apply('xor', x, y);
      const bit = this.apply('xor', sum, carry);
      carry = this.apply('or', this.apply('and', x, y), this.apply('and', sum, carry));
      return bit;
    });
  }

  witness(root: number): Readonly<Record<string, string>> {
    const assignments = new Map<number, boolean>();
    while (root > 1) {
      this.tick();
      const node = this.nodes[root]!;
      assignments.set(node.variable, node.low === 0);
      root = node.low === 0 ? node.high : node.low;
    }
    const inputs = Array<bigint>(this.variables.size).fill(0n);
    for (const [variable, set] of assignments) {
      this.tick();
      if (set)
        inputs[variable % 64] = inputs[variable % 64]! | (1n << BigInt(Math.floor(variable / 64)));
    }
    const result: Record<string, string> = {};
    for (const [id, index] of this.variables) {
      this.tick();
      result[id] = `0x${inputs[index]!.toString(16)}`;
    }
    return result;
  }
}

class Compiler {
  private readonly visiting = new Set<string>();
  private readonly memo = new Map<string, number[]>();
  constructor(
    readonly bits: Bits,
    readonly lookup: (id: string) => Expression | undefined,
    readonly state: ReadonlyMap<string, number[]> = new Map(),
  ) {}

  value(value: Value, depth = 0): number[] {
    this.bits.tick();
    if (bitWidth(value.type) > 64) throw new Unsupported('symbolic leaf width bound exceeded');
    const state = this.state.get(value.id);
    if (state) return state;
    const previous = this.memo.get(value.id);
    if (previous) return previous;
    if (depth > 24 || this.memo.size > 128 || this.visiting.has(value.id))
      throw new Unsupported('expression expansion bound or cycle');
    this.visiting.add(value.id);
    const expression = this.lookup(value.id);
    const result = expression
      ? this.expression(value, expression, depth + 1)
      : this.bits.input(value.id, bitWidth(value.type));
    this.visiting.delete(value.id);
    this.memo.set(value.id, result);
    return result;
  }

  expression(value: Value, expression: Expression, depth = 0): number[] {
    this.bits.tick();
    const width = bitWidth(value.type),
      b = this.bits;
    if (value.type.kind !== 'integer' || width < 1 || width > 64)
      throw new Unsupported('only integer fragments of 1..64 bits are supported');
    const get = (v: Value) => this.value(v, depth + 1);
    const fit = (v: readonly number[], fill = 0) =>
      Array.from({ length: width }, (_, i) => {
        b.tick();
        return v[i] ?? fill;
      });
    switch (expression.kind) {
      case 'constant':
        return b.constant(expression.bits, width);
      case 'cast': {
        const x = get(expression.value);
        if (!['bitcast', 'truncate', 'zero_extend', 'sign_extend'].includes(expression.op)) break;
        return fit(x, expression.op === 'sign_extend' ? x.at(-1)! : 0);
      }
      case 'extract':
        return fit(get(expression.value).slice(expression.offset));
      case 'concat':
        return fit(expression.values.flatMap(get));
      case 'insert': {
        const x = fit(get(expression.base)),
          inserted = get(expression.value);
        for (let i = 0; i < inserted.length && i + expression.offset < width; i++)
          x[i + expression.offset] = inserted[i]!;
        return x;
      }
      case 'integer_unary': {
        const x = fit(get(expression.value));
        if (expression.op === 'not') return x.map((v) => b.not(v));
        if (expression.op === 'neg')
          return b.add(
            x.map((v) => b.not(v)),
            b.constant(0n, width),
            1,
          );
        break;
      }
      case 'integer': {
        const x = fit(get(expression.left)),
          rawRight = get(expression.right),
          y = fit(rawRight);
        if (expression.op === 'and' || expression.op === 'or' || expression.op === 'xor')
          return x.map((v, i) => b.apply(expression.op as 'and' | 'or' | 'xor', v, y[i]!));
        if (expression.op === 'add') return b.add(x, y);
        if (expression.op === 'sub')
          return b.add(
            x,
            y.map((v) => b.not(v)),
            1,
          );
        if (['shl', 'lshr', 'ashr', 'mul'].includes(expression.op)) {
          if (rawRight.some((v) => v > 1))
            throw new Unsupported('only constant shifts/multipliers are supported');
          let constant = 0n;
          rawRight.forEach((v, i) => {
            if (v) constant |= 1n << BigInt(i);
          });
          if (expression.op === 'mul') {
            let result = b.constant(0n, width);
            for (let i = 0; i < width; i++)
              if ((constant >> BigInt(i)) & 1n)
                result = b.add(result, fit([...Array<number>(i).fill(0), ...x]));
            return result;
          }
          const count = Number(constant > BigInt(width) ? BigInt(width) : constant);
          if (expression.op === 'shl') return fit([...Array<number>(count).fill(0), ...x]);
          return fit(x.slice(count), expression.op === 'ashr' ? x.at(-1)! : 0);
        }
        break;
      }
      case 'compare': {
        if (expression.op !== 'eq' && expression.op !== 'ne') break;
        const x = get(expression.left),
          y = get(expression.right);
        let difference = 0;
        x.forEach((v, i) => {
          difference = b.apply('or', difference, b.apply('xor', v, y[i]!));
        });
        return fit([expression.op === 'eq' ? b.not(difference) : difference]);
      }
      case 'flag': {
        if (expression.flag !== 'zero' || expression.op !== 'add') break;
        const x = get(expression.left),
          y = get(expression.right),
          carry = get(expression.carry)[0]!;
        const sum = b.add(b.add(x, y), [carry]);
        let any = 0;
        for (const bit of sum) any = b.apply('or', any, bit);
        return fit([b.not(any)]);
      }
    }
    throw new Unsupported(
      `unsupported expression ${expression.kind}${'op' in expression ? `/${expression.op}` : ''}`,
    );
  }
}

function compare(
  bits: Bits,
  expected: readonly number[],
  actual: readonly number[],
  record: Omit<LocalValidationRecord, 'status'>,
): LocalValidationRecord {
  if (expected.length !== actual.length)
    return {
      ...record,
      status: 'rejected',
      counterexample: { width: `${expected.length} != ${actual.length}` },
    };
  let difference = 0;
  expected.forEach((v, i) => {
    difference = bits.apply('or', difference, bits.apply('xor', v, actual[i]!));
  });
  return difference === 0
    ? { ...record, status: 'verified' }
    : { ...record, status: 'rejected', counterexample: bits.witness(difference) };
}
function bounded(
  record: Omit<LocalValidationRecord, 'status'>,
  action: () => LocalValidationRecord,
): LocalValidationRecord {
  try {
    return action();
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error;
    return { ...record, status: 'unverified', reason: error.message };
  }
}

export class LocalValidationSession {
  readonly records: LocalValidationRecord[] = [];
  /** Conservative vetoes, not proof-cache entries: after a counterexample no
   * later pass may reapply any rewrite of this value because proof ran out.
   * At most 256 checking actions can reject before the record bound stops work. */
  readonly rejectedRewrites = new Set<string>();
  readonly allowance: ValidationAllowance;
  /** Identical outcomes (e.g. each step of a multi-step rewrite of one subject)
   * state one fact, so they are published once. */
  readonly #recorded = new Set<string>();
  constructor(context: OperationContext) {
    this.allowance = new ValidationAllowance(context);
  }

  check(
    kind: LocalValidationRecord['kind'],
    subject: string,
    scope: string,
    action: () => LocalValidationRecord,
    subjectIds?: readonly string[],
  ): LocalValidationRecord {
    this.allowance.context.checkpoint(0);
    if (this.records.length >= 256) {
      const record: LocalValidationRecord = {
        kind,
        subject,
        scope,
        status: 'unverified',
        reason: 'local validation record bound exceeded',
      };
      if (this.records.length === 256)
        this.records.push({
          ...record,
          subject: '*',
          scope: 'all remaining local translation candidates in this emission',
        });
      return record;
    }
    const checked = bounded({ kind, subject, scope }, action);
    const record = subjectIds ? { ...checked, subject_ids: subjectIds.slice(0, 64) } : checked;
    const key = JSON.stringify([
      record.kind,
      record.subject,
      record.scope,
      record.status,
      record.reason ?? null,
      record.counterexample ?? null,
      record.subject_ids ?? null,
    ]);
    if (this.#recorded.has(key)) return record;
    this.#recorded.add(key);
    this.records.push(record);
    return record;
  }
}
export function validateBitvectorCandidate(
  value: Value,
  original: Expression,
  candidate: Expression,
  expressions: ReadonlyMap<string, Expression>,
  allowance: ValidationAllowance,
): LocalValidationRecord {
  const record = {
    kind: 'bitvector' as const,
    subject: value.id,
    scope: 'local pure integer rewrite; not whole-function equivalence',
  };
  return bounded(record, () => {
    const bits = new Bits(allowance),
      compiler = new Compiler(bits, (id) => expressions.get(id));
    return compare(
      bits,
      compiler.expression(value, original),
      compiler.expression(value, candidate),
      record,
    );
  });
}

export interface PlannedMove {
  readonly destination: string;
  readonly source: Value | string;
}
export function validateParallelMoves(
  subject: string,
  expected: readonly { readonly destination: Value; readonly source: Value }[],
  moves: readonly PlannedMove[],
  lookup: (id: string) => Expression | undefined,
  allowance: ValidationAllowance,
): LocalValidationRecord {
  const record = {
    kind: 'parallel-copy' as const,
    subject,
    scope: 'actual sequential move plan versus simultaneous edge values',
  };
  return bounded(record, () => {
    if (expected.length > 64 || moves.length > 128)
      return { ...record, status: 'unverified', reason: 'parallel-copy plan bound exceeded' };
    const bits = new Bits(allowance),
      initial = new Compiler(bits, lookup),
      state = new Map<string, number[]>();
    const wanted = expected.map((copy) => initial.value(copy.source));
    for (const move of moves) {
      bits.tick();
      const value =
        typeof move.source === 'string'
          ? state.get(move.source)
          : new Compiler(bits, lookup, state).value(move.source);
      if (!value)
        return {
          ...record,
          status: 'rejected',
          counterexample: { temporary: String(move.source), reason: 'read before capture' },
        };
      state.set(move.destination, value);
    }
    for (let i = 0; i < expected.length; i++) {
      const copy = expected[i]!,
        actual = state.get(copy.destination.id) ?? initial.value(copy.destination);
      const result = compare(bits, wanted[i]!, actual, record);
      if (result.status !== 'verified') return result;
    }
    return { ...record, status: 'verified' };
  });
}

export function validateControlTarget(
  subject: string,
  expected: string,
  actual: string | null,
): LocalValidationRecord {
  return {
    kind: 'control',
    subject,
    scope: 'rendered edge destination only; not condition or whole-function equivalence',
    ...(expected === actual
      ? { status: 'verified' as const }
      : {
          status: 'rejected' as const,
          counterexample: { expected, actual: actual ?? 'no destination' },
        }),
  };
}
