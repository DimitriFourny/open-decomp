import { OperationError, type OperationContext } from '../core/index.js';
import { mapExpression } from '../analysis/effects/index.js';
import {
  bitWidth,
  expressionOperands,
  sameType,
  type Expression,
  type Origin,
  type Value,
} from '../ir/index.js';

export interface LocalValidationRecord {
  readonly kind: 'bitvector' | 'parallel-copy' | 'stack-promotion' | 'control' | 'presentation';
  /** Source-view presentation rule (only for `presentation`). */
  readonly rule?: string;
  readonly subject: string;
  readonly subject_ids?: readonly string[];
  readonly status: 'verified' | 'unverified' | 'rejected';
  readonly scope: string;
  readonly reason?: string;
  readonly counterexample?: Readonly<Record<string, string>>;
}

/** One ABI-conformance assumption a source-view rewrite rests on. `anchor_ids[0]`
 * is an original statement/control identity mapped in the emitted text. */
export interface AbiConformanceSite {
  readonly rule: string;
  readonly anchor_ids: readonly string[];
  readonly explanation: string;
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
  /** Bitvector proof obligations (see proofShape) already verified with this
   * allowance: one function's session. Keys are leaf-renamed formulas, never IR ids. */
  readonly provedShapes = new Set<string>();
  constructor(
    readonly context: OperationContext,
    private readonly limit = Math.min(8000, Math.floor((context.remainingWork?.() ?? 8000) / 64)),
  ) {}

  get exhausted(): boolean {
    return this.work >= this.limit;
  }

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
 * Bits are ordered most-significant first and interleaved across symbolic leaves:
 * a ripple carry into bit i then reuses the carry BDD of bit i-1 as a subgraph,
 * so a w-bit addition costs O(w) nodes instead of O(w^2) (least-significant-first).
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
    return Array.from({ length: width }, (_, bit) => this.node((63 - bit) * 64 + index, 0, 1));
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
        inputs[variable % 64] =
          inputs[variable % 64]! | (1n << BigInt(63 - Math.floor(variable / 64)));
    }
    const result: Record<string, string> = {};
    for (const [id, index] of this.variables) {
      this.tick();
      result[id] = `0x${inputs[index]!.toString(16)}`;
    }
    return result;
  }
}

/** Thrown inside one node's compilation when the BDD does not model it; an
 * abstracting compiler turns that node into an opaque leaf instead, any other
 * compiler reports the fragment as unsupported. */
class Opaque extends Unsupported {}

/** Same-type bitcasts are the identity: matching through them is exact. */
function resolveIdentity(
  value: Value,
  lookup: (id: string) => Expression | undefined,
  tick: () => void,
): Value {
  const seen = new Set<string>();
  for (;;) {
    tick();
    if (seen.has(value.id)) return value;
    seen.add(value.id);
    const expression = lookup(value.id);
    if (
      expression?.kind !== 'cast' ||
      expression.op !== 'bitcast' ||
      !sameType(value.type, expression.value.type)
    )
      return value;
    value = expression.value;
  }
}

/** Expands definitions into BDD bit vectors. An abstracting compiler (given a
 * set of values to `abstract`) turns those values, and nodes the BDD does not
 * model (division, rotation, selects, ordered compares, wide intermediates),
 * into symbolic leaves: equality for every leaf value implies equality for the
 * actual ones, so a verified result is a proof. A counterexample is concrete
 * only when every leaf is a true input (`abstracted` stays false). Leaves are
 * keyed by the identity-resolved value or by the node's operator over identity-
 * resolved operands, so both sides of a comparison share them (congruence). */
class Compiler {
  private readonly visiting = new Set<string>();
  private readonly memo = new Map<string, number[]>();
  /** Leaves this compiler read, by key, with the values whose cones they stand for. */
  readonly leaves = new Map<string, readonly Value[]>();
  /** Some leaf stands for a definition rather than a true input. */
  abstracted = false;
  /** Some leaf was one of the requested abstractions (expanding it may differ). */
  truncated = false;
  constructor(
    readonly bits: Bits,
    readonly lookup: (id: string) => Expression | undefined,
    readonly state: ReadonlyMap<string, number[]> = new Map(),
    private readonly abstract?: ReadonlySet<string>,
  ) {}

  private leaf(key: string, width: number, cone: readonly Value[], abstract: boolean): number[] {
    if (width > 64) throw new Unsupported('symbolic leaf width bound exceeded');
    this.leaves.set(key, cone);
    this.abstracted ||= abstract;
    return this.bits.input(key, width);
  }

  value(value: Value, depth = 0): number[] {
    this.bits.tick();
    const abstracting = this.abstract !== undefined;
    if (abstracting) value = resolveIdentity(value, this.lookup, () => this.bits.tick());
    const state = this.state.get(value.id);
    if (state) return state;
    const previous = this.memo.get(value.id);
    if (previous) return previous;
    const expression = this.lookup(value.id);
    let result: number[];
    if (!expression) result = this.leaf(value.id, bitWidth(value.type), [], false);
    else if (
      this.abstract?.has(value.id) &&
      expression.kind !== 'constant' &&
      expression.kind !== 'indeterminate'
    ) {
      this.truncated = true;
      result = this.leaf(value.id, bitWidth(value.type), [value], true);
    } else {
      if (depth > 12 || this.memo.size > 128 || this.visiting.has(value.id))
        throw new Unsupported('expression expansion bound or cycle');
      this.visiting.add(value.id);
      try {
        result = this.expression(value, expression, depth);
      } catch (error) {
        if (!(error instanceof Opaque) || !abstracting) throw error;
        // An unmodeled operator over the same resolved operands is one leaf.
        const resolved = mapExpression(expression, (operand) =>
          resolveIdentity(operand, this.lookup, () => this.bits.tick()),
        );
        const key = JSON.stringify([bitWidth(value.type), resolved], (_, item: unknown) =>
          typeof item === 'bigint'
            ? item.toString()
            : item && typeof item === 'object' && 'id' in item && 'type' in item
              ? item.id
              : item,
        );
        result = this.leaf(key, bitWidth(value.type), expressionOperands(resolved), true);
      }
      this.visiting.delete(value.id);
    }
    this.memo.set(value.id, result);
    return result;
  }

  expression(value: Value, expression: Expression, depth = 0): number[] {
    this.bits.tick();
    const width = bitWidth(value.type),
      b = this.bits;
    if (expression.kind === 'indeterminate')
      throw new Unsupported('unsupported expression indeterminate');
    if (value.type.kind !== 'integer' || width < 1 || width > 64)
      throw new Opaque('only integer fragments of 1..64 bits are supported');
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
        if (!['bitcast', 'truncate', 'zero_extend', 'sign_extend'].includes(expression.op)) break;
        const x = get(expression.value);
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
        if (expression.op !== 'not' && expression.op !== 'neg') break;
        const x = fit(get(expression.value));
        if (expression.op === 'not') return x.map((v) => b.not(v));
        return b.add(
          x.map((v) => b.not(v)),
          b.constant(0n, width),
          1,
        );
      }
      case 'integer': {
        if (
          !['and', 'or', 'xor', 'add', 'sub', 'shl', 'lshr', 'ashr', 'mul'].includes(expression.op)
        )
          break;
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
        if (rawRight.some((v) => v > 1))
          throw new Opaque('only constant shifts/multipliers are supported');
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
    throw new Opaque(
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
  // Reduced ordered BDDs over one unique table are canonical: equal functions
  // are the same node. The first differing bit yields the counterexample;
  // OR-ing every difference could blow up when leaves are wired differently.
  for (let i = 0; i < expected.length; i++) {
    bits.tick();
    if (expected[i] !== actual[i])
      return {
        ...record,
        status: 'rejected',
        counterexample: bits.witness(bits.apply('xor', expected[i]!, actual[i]!)),
      };
  }
  return { ...record, status: 'verified' };
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
  /** A session owns one function. Identical verified premises can describe
   * many subjects without consuming one validation record per occurrence. */
  private readonly verifiedGroups = new Map<
    string,
    { readonly subjects: Set<string>; readonly chunks: string[][] }
  >();
  private readonly abiGroups = new Map<
    string,
    { readonly subjects: Set<string>; readonly chunks: string[][] }
  >();
  constructor(
    context: OperationContext,
    private readonly aggregateBitvectors = false,
    private readonly functionSubject?: string,
  ) {
    this.allowance = new ValidationAllowance(context);
  }

  private skippedBitvectors = 0;
  private skippedRecord: number | undefined;

  /** Source-only candidate admission: after shared work runs out, retain the
   * original form instead of repeatedly attempting a guaranteed-failing proof. */
  skipExhaustedBitvector(subject: string): boolean {
    if (!this.aggregateBitvectors || !this.allowance.exhausted) return false;
    this.allowance.context.checkpoint(0);
    this.skippedBitvectors++;
    // Index256 is the existing terminal limitation-record slot, not extra proof
    // capacity. If present, preserve its record-bound limitation in the summary.
    this.skippedRecord ??= Math.min(this.records.length, 256);
    this.records[this.skippedRecord] = {
      kind: 'bitvector',
      subject: this.functionSubject ?? subject,
      status: 'unverified',
      scope: 'source bitvector candidates not attempted; original forms retained',
      reason: `${this.skippedRecord === 256 ? 'local validation record bound exceeded; ' : ''}${this.skippedBitvectors} later candidates were not attempted because the local validation allowance was exhausted`,
    };
    return true;
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
    let record = subjectIds ? { ...checked, subject_ids: subjectIds.slice(0, 64) } : checked;
    if (
      this.aggregateBitvectors &&
      kind === 'bitvector' &&
      record.status === 'verified' &&
      record.counterexample === undefined
    ) {
      if (this.recordVerified(record, subjectIds ?? record.subject_ids)) return record;
      record = {
        ...record,
        status: 'unverified',
        reason: 'local validation record bound exceeded',
      };
    }
    const key = JSON.stringify([
      record.kind,
      record.subject,
      record.rule ?? null,
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

  /** Record one source-view presentation rewrite whose side conditions the
   * caller has already checked. Returns false (record bound reached) when the
   * rewrite may not be applied; the caller must then keep the checked form. */
  presentation(
    rule: string,
    subject: string,
    scope: string,
    subjectIds?: readonly string[],
    reason?: string,
  ): boolean {
    if (
      this.recordVerified(
        {
          kind: 'presentation',
          rule,
          subject,
          scope,
          status: 'verified',
          ...(reason ? { reason } : {}),
        },
        subjectIds,
      )
    )
      return true;
    this.check('presentation', subject, scope, () => ({
      kind: 'presentation',
      rule,
      subject,
      scope,
      status: 'unverified',
      reason: 'local validation record bound exceeded',
    }));
    return false;
  }

  /** Batch only established premises; proof execution and every unsuccessful
   * result remain independent of this metadata storage decision. */
  private recordVerified(record: LocalValidationRecord, subjectIds?: readonly string[]): boolean {
    this.allowance.context.checkpoint(1 + (subjectIds?.length ?? 0));
    // Reasons can carry exact effect contracts. Different contracts must never
    // share a record even when their rule and prose scope coincide.
    const key = JSON.stringify([
      record.kind,
      record.rule ?? null,
      record.scope,
      record.reason ?? null,
    ]);
    const previous = this.verifiedGroups.get(key);
    const subjects = new Set([record.subject, ...(subjectIds ?? [])]);
    const missing = [...subjects].filter((id) => !previous?.subjects.has(id));
    if (!missing.length) return true;
    const last = previous?.chunks.at(-1);
    const available = last ? 64 - last.length : 0;
    const required = Math.ceil(Math.max(0, missing.length - available) / 64);
    // Admission is atomic: never authorize only a prefix of a rewrite's refs.
    if (this.records.length + required > 256 && required > 0) return false;
    const group = previous ?? { subjects: new Set<string>(), chunks: [] };
    this.verifiedGroups.set(key, group);
    let chunk = last;
    for (const id of missing) {
      if (!chunk || chunk.length === 64) {
        chunk = [];
        group.chunks.push(chunk);
        this.records.push({ ...record, subject_ids: chunk });
      }
      chunk.push(id);
      group.subjects.add(id);
    }
    return true;
  }

  /** ABI-conformance assumptions of applied rewrites, published as requirements. */
  readonly abiConformance: AbiConformanceSite[] = [];
  requireAbi(rule: string, anchorIds: readonly string[], explanation: string): void {
    this.allowance.context.checkpoint(anchorIds.length);
    const key = JSON.stringify([rule, explanation]);
    const group = this.abiGroups.get(key) ?? { subjects: new Set<string>(), chunks: [] };
    if (!anchorIds.length) return;
    this.abiGroups.set(key, group);
    let chunk = group.chunks.at(-1);
    for (const id of anchorIds) {
      if (group.subjects.has(id)) continue;
      if (!chunk || chunk.length === 64) {
        chunk = [];
        group.chunks.push(chunk);
        this.abiConformance.push({ rule, anchor_ids: chunk, explanation });
      }
      chunk.push(id);
      group.subjects.add(id);
    }
  }
}
/** A rewrite is first checked with every subterm common to both sides as one
 * leaf, then over the whole bounded cone. Rewrites (operand resolution, wiring,
 * narrowing, identities) relate the sides through their own nodes, so the
 * first check is usually the proof and never expands shared arithmetic. A
 * counterexample is reported only over true inputs; a proof that drops or adds
 * a dependency is accepted only when no dropped/added cone can carry an
 * indeterminate value, the same rule as expanding the whole cone. */
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
  const lookup = (id: string): Expression | undefined => expressions.get(id);
  return bounded(record, () => {
    // Congruence: the same operator over identity-equal operands needs no BDD.
    const step = (): void => allowance.context.checkpoint(1);
    const resolve = (operand: Value): Value => resolveIdentity(operand, lookup, step);
    const shape = (expression: Expression): string =>
      JSON.stringify(mapExpression(expression, resolve), (_, item: unknown) =>
        typeof item === 'bigint'
          ? item.toString()
          : item && typeof item === 'object' && 'id' in item && 'type' in item
            ? item.id
            : item,
      );
    if (shape(original) === shape(candidate)) return { ...record, status: 'verified' };
    const cone = (expression: Expression): Set<string> => {
      const seen = new Set<string>(),
        pending = expressionOperands(expression).map(resolve);
      while (pending.length && seen.size < 128) {
        step();
        const operand = pending.pop()!;
        if (seen.has(operand.id)) continue;
        seen.add(operand.id);
        const definition = lookup(operand.id);
        if (definition) pending.push(...expressionOperands(definition).map(resolve));
      }
      return seen;
    };
    const theirs = cone(candidate),
      shared = new Set([...cone(original)].filter((id) => theirs.has(id)));
    // One proof per rule class: a formula over renamed leaves that was verified
    // once in this session is the same formula for every later instance.
    const formula = proofShape(value, original, candidate, shared, lookup, step);
    const accept = (
      left: ReadonlyMap<string, readonly Value[]>,
      right: ReadonlyMap<string, readonly Value[]>,
    ): LocalValidationRecord => {
      const changed = [
        ...[...left].filter(([key]) => !right.has(key)),
        ...[...right].filter(([key]) => !left.has(key)),
      ].flatMap(([, cone]) => cone);
      return mayBeIndeterminate(changed, lookup, step)
        ? { ...record, status: 'unverified', reason: 'unsupported expression indeterminate' }
        : { ...record, status: 'verified' };
    };
    if (formula && allowance.provedShapes.has(formula.key))
      return accept(formula.left, formula.right);
    const bits = new Bits(allowance);
    for (const abstract of [shared, new Set<string>()]) {
      const left = new Compiler(bits, lookup, undefined, abstract),
        right = new Compiler(bits, lookup, undefined, abstract);
      const checked = compare(
        bits,
        left.expression(value, original),
        right.expression(value, candidate),
        record,
      );
      if (checked.status === 'verified') {
        if (formula && abstract === shared) allowance.provedShapes.add(formula.key);
        return accept(left.leaves, right.leaves);
      }
      if (!left.truncated && !right.truncated)
        return left.abstracted || right.abstracted
          ? { ...record, status: 'unverified', reason: 'counterexample over an unmodeled subterm' }
          : checked;
    }
    throw new Unsupported('expression expansion bound or cycle');
  });
}

/** Bounded search of the cones of `values` for an indeterminate definition;
 * exceeding the bound counts as possibly indeterminate. */
function mayBeIndeterminate(
  values: readonly Value[],
  lookup: (id: string) => Expression | undefined,
  tick: () => void,
): boolean {
  const pending = [...values],
    seen = new Set<string>();
  while (pending.length) {
    tick();
    const value = pending.pop()!;
    if (seen.has(value.id)) continue;
    if (seen.size >= 128) return true;
    seen.add(value.id);
    const expression = lookup(value.id);
    if (expression?.kind === 'indeterminate') return true;
    if (expression) pending.push(...expressionOperands(expression));
  }
  return false;
}

/** The exact formula the first (shared-leaf) BDD check compiles, as a string
 * over leaves renamed in first-occurrence order, or null when any expanded node
 * is outside the plainly modeled subset (its compilation would then depend on
 * an opaque decision). Equal strings are the same proof obligation. */
function proofShape(
  value: Value,
  original: Expression,
  candidate: Expression,
  shared: ReadonlySet<string>,
  lookup: (id: string) => Expression | undefined,
  step: () => void,
): {
  key: string;
  left: Map<string, readonly Value[]>;
  right: Map<string, readonly Value[]>;
} | null {
  const names = new Map<string, string>(),
    entries: string[] = [];
  const side = (root: Expression, leaves: Map<string, readonly Value[]>): string | null => {
    const memo = new Map<string, string>(),
      visiting = new Set<string>();
    const node = (target: Value, expression: Expression, depth: number): string | null => {
      step();
      const width = bitWidth(target.type);
      if (target.type.kind !== 'integer' || width < 1 || width > 64) return null;
      const operands: string[] = [];
      const operand = (item: Value): boolean => {
        const name = visit(item, depth + 1);
        if (name !== null) operands.push(name);
        return name !== null;
      };
      let label: string;
      switch (expression.kind) {
        case 'constant':
          return `#${BigInt.asUintN(width, expression.bits)}:${width}`;
        case 'cast':
          if (!['bitcast', 'truncate', 'zero_extend', 'sign_extend'].includes(expression.op))
            return null;
          label = expression.op;
          break;
        case 'extract':
          label = `extract@${expression.offset}`;
          break;
        case 'insert':
          label = `insert@${expression.offset}`;
          break;
        case 'concat':
          label = 'concat';
          break;
        case 'integer_unary':
          if (expression.op !== 'not' && expression.op !== 'neg') return null;
          label = expression.op;
          break;
        case 'integer': {
          const scaled = ['shl', 'lshr', 'ashr', 'mul'].includes(expression.op);
          if (!scaled && !['and', 'or', 'xor', 'add', 'sub'].includes(expression.op)) return null;
          if (
            scaled &&
            lookup(resolveIdentity(expression.right, lookup, step).id)?.kind !== 'constant'
          )
            return null;
          label = expression.op;
          break;
        }
        case 'compare':
          if (expression.op !== 'eq' && expression.op !== 'ne') return null;
          label = expression.op;
          break;
        case 'flag':
          if (expression.flag !== 'zero' || expression.op !== 'add') return null;
          label = 'zero_add';
          break;
        default:
          return null;
      }
      if (!expressionOperands(expression).every(operand)) return null;
      entries.push(`${label}:${width}(${operands.join(',')})`);
      return `N${entries.length - 1}`;
    };
    const visit = (target: Value, depth: number): string | null => {
      step();
      target = resolveIdentity(target, lookup, step);
      const expression = lookup(target.id),
        width = bitWidth(target.type);
      if (
        !expression ||
        (shared.has(target.id) &&
          expression.kind !== 'constant' &&
          expression.kind !== 'indeterminate')
      ) {
        if (width > 64) return null;
        leaves.set(target.id, expression ? [target] : []);
        let name = names.get(target.id);
        if (!name) names.set(target.id, (name = `L${names.size}:${width}`));
        return name;
      }
      const previous = memo.get(target.id);
      if (previous) return previous;
      if (depth > 12 || memo.size > 128 || visiting.has(target.id)) return null;
      visiting.add(target.id);
      const name = node(target, expression, depth);
      visiting.delete(target.id);
      if (name !== null) memo.set(target.id, name);
      return name;
    };
    return node(value, root, 0);
  };
  const left = new Map<string, readonly Value[]>(),
    right = new Map<string, readonly Value[]>();
  const a = side(original, left),
    b = a === null ? null : side(candidate, right);
  return b === null ? null : { key: `${entries.join(';')}|${a}=${b}`, left, right };
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
    // Moves of whole variables are checked by identity: track which initial
    // variable each destination holds. Anything else (an inline expression, a
    // narrowing view) takes the bit-level simulation below.
    const step = (): void => allowance.context.checkpoint(1);
    const held = new Map<string, string>();
    const initialOf = (value: Value, live: boolean): string | undefined => {
      for (const seen = new Set<string>(); ;) {
        step();
        const current = live ? held.get(value.id) : undefined;
        if (current !== undefined) return current;
        if (seen.has(value.id)) return undefined;
        seen.add(value.id);
        const expression = lookup(value.id);
        if (!expression) return value.id;
        if (
          expression.kind !== 'cast' ||
          expression.op !== 'bitcast' ||
          !sameType(value.type, expression.value.type)
        )
          return undefined;
        value = expression.value;
      }
    };
    let identities = true;
    for (const move of moves) {
      const source =
        typeof move.source === 'string' ? held.get(move.source) : initialOf(move.source, true);
      if (source === undefined) {
        identities = false;
        break;
      }
      held.set(move.destination, source);
    }
    if (
      identities &&
      expected.every((copy) => {
        const wanted = initialOf(copy.source, false);
        return (
          wanted !== undefined &&
          wanted === (held.get(copy.destination.id) ?? initialOf(copy.destination, false))
        );
      })
    )
      return { ...record, status: 'verified' };
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
