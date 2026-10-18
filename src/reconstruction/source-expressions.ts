import type { OperationContext } from '../core/index.js';
import { mapExpression } from '../analysis/effects/index.js';
import {
  bitWidth,
  evaluateExpression,
  expressionOperands,
  integer,
  sameType,
  type DataType,
  type Expression,
  type Value,
} from '../ir/index.js';
import { identityOperand, integerIdentity } from './expressions.js';
import { LocalValidationSession, validateBitvectorCandidate } from './local-validation.js';
import { recombineBitSlices } from './source-bit-slices.js';
import { foldSourceCondition } from './source-conditions.js';

export interface SourceExpressionDemand {
  /** Conservative value closure, extended for newly introduced definitions. */
  readonly values: Set<string>;
  /** Initial definition queue; ownership transfers to one normalization session. */
  readonly pending: string[];
}

/** Conservative structural demand before normalization. Follow every phi input
 * even when the destination already has a source alias: this is a superset,
 * not the final demand after rewriting/identity elimination. */
export function sourceExpressionDemand(
  roots: Iterable<Value>,
  expressions: ReadonlyMap<string, Expression>,
  incoming: ReadonlyMap<string, readonly Value[]>,
  context: OperationContext,
): SourceExpressionDemand {
  context.checkpoint(0);
  const demand = new Set<string>(),
    pending: string[] = [];
  const queue: { operands: readonly Value[]; sources: readonly Value[] }[] = [];
  const add = (value: Value): void => {
    context.checkpoint(1);
    if (!demand.has(value.id)) {
      demand.add(value.id);
      const expression = expressions.get(value.id),
        operands = expression ? expressionOperands(expression) : [],
        sources = incoming.get(value.id) ?? [];
      if (expression) pending.push(value.id);
      // Structural leaves are discovered/charged above, but have no dependency
      // traversal to schedule. Retain exact-stage edges rather than look up the
      // same expression/phi definitions again while draining the closure.
      if (operands.length || sources.length) queue.push({ operands, sources });
    }
  };
  for (const root of roots) add(root);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    context.checkpoint(1);
    const item = queue[cursor]!;
    for (const operand of item.operands) add(operand);
    for (const source of item.sources) add(source);
  }
  return { values: demand, pending };
}

/** ABI packing/unpacking is a pure view. Reduce adjacent cells back to the
 * source value without expanding DAGs or substituting mutable phi variables.
 * The returned session belongs to these exact reconstruction maps/context:
 * notify changed() after external identity rewrites, then drain with run(). */
export function normalizeSourceExpressions(
  values: ReadonlyMap<string, Value>,
  expressions: Map<string, Expression>,
  owner: ReadonlyMap<string, string>,
  make: (
    key: string,
    type: DataType,
    block: string,
    expression?: Expression,
    contributors?: readonly Value[],
  ) => Value,
  context: OperationContext,
  validation = new LocalValidationSession(context),
  selection?: SourceExpressionDemand,
  sourceCells = true,
): { changed(id: string): void; run(): void } {
  // Dependencies include every inspected definition, not just direct operands:
  // identity chains, scales, storage views and constant-folding inputs can all
  // expose another rewrite when their definitions change.
  const demand = selection?.values,
    queue = selection?.pending ?? [...expressions.keys()];
  const known = new Set(queue),
    queued = new Set(queue),
    users = new Map<string, Set<string>>();
  const packingShifts = new Set<string>();
  // Masked insert lowering is a full-width presentation. Keep its exact slice
  // structure available to later extracts: distributing an extract over the
  // lowered mask would otherwise introduce `unknown & 0` dependencies in a
  // slice that originally came entirely from the inserted value.
  const packedSources = new Map<string, Expression>();
  let current = '';
  const enqueue = (id: string): void => {
    if (!queued.has(id)) {
      queued.add(id);
      queue.push(id);
    }
  };
  const observe = (id: string): Expression | undefined => {
    if (demand && !demand.has(id)) {
      demand.add(id);
      if (expressions.has(id)) changed(id);
    }
    if (current) {
      const readers = users.get(id) ?? new Set<string>();
      readers.add(current);
      users.set(id, readers);
    }
    return expressions.get(id);
  };
  // Reconstruction-local memoization only. Reverse identity edges invalidate all
  // cached prefixes when a terminal or an intermediate definition is rewritten.
  // Cycles deliberately stay uncached: resolution retains its starting member.
  const resolutions = new Map<string, Value>(),
    identityUsers = new Map<string, Set<string>>();
  const invalidate = (id: string): void => {
    context.checkpoint(0);
    // Newly published aliases often have no previous readers or cached fact.
    // They still enter the normalization queue; there is no state to traverse.
    if (!resolutions.has(id) && !users.has(id) && !identityUsers.has(id)) return;
    const pending = [id],
      seen = new Set<string>();
    while (pending.length) {
      context.checkpoint(1);
      const changed = pending.pop()!;
      if (seen.has(changed)) continue;
      seen.add(changed);
      resolutions.delete(changed);
      for (const user of users.get(changed) ?? []) {
        context.checkpoint(1);
        enqueue(user);
      }
      for (const user of identityUsers.get(changed) ?? []) pending.push(user);
    }
  };
  const changed = (id: string): void => {
    if (demand && !demand.has(id)) {
      context.checkpoint(0);
      return;
    }
    known.add(id);
    enqueue(id);
    invalidate(id);
  };
  const create: typeof make = (...args) => {
    const value = make(...args);
    demand?.add(value.id);
    // The former Map iterator visited definitions inserted by make(). Preserve
    // that behavior even when a rejected candidate created the definition.
    if (!known.has(value.id) && expressions.has(value.id)) changed(value.id);
    return value;
  };
  const resolve = (value: Value): Value => {
    context.checkpoint(1);
    const cached = resolutions.get(value.id);
    if (cached) {
      observe(value.id);
      return cached;
    }
    const path: Value[] = [],
      seen = new Set<string>();
    for (;;) {
      if (seen.has(value.id)) return value;
      seen.add(value.id);
      const previous = resolutions.get(value.id);
      if (previous) {
        value = previous;
        break;
      }
      path.push(value);
      const expression = observe(value.id),
        operand = expression && identityOperand(value.type, expression);
      if (!operand) break;
      const aliases = identityUsers.get(operand.id) ?? new Set<string>();
      aliases.add(value.id);
      identityUsers.set(operand.id, aliases);
      value = operand;
      context.checkpoint(1);
    }
    context.checkpoint(path.length);
    for (const prefix of path) resolutions.set(prefix.id, value);
    return value;
  };
  const narrow = (value: Value, width: number, block: string): Value =>
    bitWidth(value.type) === width
      ? value
      : create(`low-bits:${value.id}:${width}`, integer(width), block, {
          kind: 'extract',
          value,
          offset: 0,
        });
  const constant = (value: Value): bigint | null => {
    const expression = observe(resolve(value).id);
    return expression?.kind === 'constant'
      ? BigInt.asUintN(bitWidth(value.type), expression.bits)
      : null;
  };
  const factor = (value: Value, coefficient: bigint, block: string): Value =>
    create(
      `integer-factor:${value.id}:${coefficient}`,
      value.type,
      block,
      { kind: 'constant', bits: BigInt.asUintN(bitWidth(value.type), coefficient) },
      [value],
    );
  const scaled = (value: Value): { value: Value; coefficient: bigint } | null => {
    const expression = observe(resolve(value).id);
    if (expression?.kind !== 'integer') return null;
    if (expression.op === 'mul') {
      const left = constant(expression.left),
        right = constant(expression.right);
      if (right !== null) return { value: resolve(expression.left), coefficient: right };
      if (left !== null) return { value: resolve(expression.right), coefficient: left };
    }
    if (expression.op === 'shl') {
      const count = constant(expression.right);
      if (count !== null)
        return {
          value: resolve(expression.left),
          coefficient: count >= BigInt(bitWidth(value.type)) ? 0n : 1n << count,
        };
    }
    return null;
  };
  const run = (): void => {
    context.checkpoint(0);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      context.checkpoint(1);
      const id = queue[cursor]!;
      queued.delete(id);
      if (validation.rejectedRewrites.has(id)) continue;
      current = id;
      const original = expressions.get(id)!,
        value = values.get(id)!;
      let operandsChanged = false;
      const expression = mapExpression(original, (operand) => {
        const resolved = resolve(operand);
        operandsChanged ||= resolved.id !== operand.id;
        return resolved;
      });
      let replacement: Expression = expression;
      let cellRewrite = false;
      if (
        sourceCells &&
        (expression.kind === 'concat' ||
          (expression.kind === 'integer' && ['or', 'xor'].includes(expression.op)))
      ) {
        for (const operand of expressionOperands(expression)) {
          const definition = observe(operand.id);
          if (
            definition?.kind === 'integer' &&
            ['mul', 'shl'].includes(definition.op) &&
            !packingShifts.has(operand.id)
          ) {
            packingShifts.add(operand.id);
            changed(operand.id);
          }
        }
      }
      if (expression.kind === 'cast' && value.type.kind === 'integer') {
        if (
          ['truncate', 'zero_extend', 'sign_extend'].includes(expression.op) &&
          sameType(value.type, expression.value.type)
        )
          replacement = { kind: 'cast', op: 'bitcast', value: expression.value };
        else if (expression.op === 'truncate')
          replacement = { kind: 'extract', value: expression.value, offset: 0 };
      }
      if (expression.kind === 'integer' && value.type.kind === 'integer') {
        const block = owner.get(id)!;
        if (expression.op === 'mul' && packingShifts.has(id)) {
          const coefficient = constant(expression.right);
          if (
            coefficient !== null &&
            coefficient > 1n &&
            (coefficient & (coefficient - 1n)) === 0n
          ) {
            replacement = {
              kind: 'integer',
              op: 'shl',
              left: expression.left,
              right: factor(value, BigInt(coefficient.toString(2).length - 1), block),
            };
            cellRewrite = true;
          }
        } else if (expression.op === 'shl' && !packingShifts.has(id)) {
          const count = constant(expression.right);
          if (count !== null)
            replacement = {
              kind: 'integer',
              op: 'mul',
              left: expression.left,
              right: factor(value, count >= BigInt(value.type.bits) ? 0n : 1n << count, block),
            };
        } else if (expression.op === 'add') {
          const left = scaled(expression.left),
            right = scaled(expression.right);
          // Match only x + k*x (in either order), not arbitrary expression
          // reassociation. SSA identity keeps repeated effectful definitions
          // distinct, and no operand or shared DAG is duplicated.
          const matched =
            right?.value.id === expression.left.id
              ? right
              : left?.value.id === expression.right.id
                ? left
                : null;
          if (matched)
            replacement = {
              kind: 'integer',
              op: 'mul',
              left: matched.value,
              right: factor(value, matched.coefficient + 1n, block),
            };
        }
      }
      if (expression.kind === 'extract') {
        const observed = observe(expression.value.id),
          source = packedSources.get(expression.value.id) ?? observed,
          width = bitWidth(value.type);
        if (expression.offset === 0 && sameType(value.type, expression.value.type))
          replacement = { kind: 'cast', op: 'bitcast', value: expression.value };
        else if (source?.kind === 'extract')
          replacement = {
            kind: 'extract',
            value: source.value,
            offset: source.offset + expression.offset,
          };
        else if (
          source?.kind === 'cast' &&
          (source.op === 'zero_extend' || source.op === 'sign_extend') &&
          expression.offset + width <= bitWidth(source.value.type)
        )
          replacement = { kind: 'extract', value: source.value, offset: expression.offset };
        else if (
          source?.kind === 'insert' &&
          expression.offset >= source.offset &&
          expression.offset + width <= source.offset + bitWidth(source.value.type)
        )
          replacement = {
            kind: 'extract',
            value: source.value,
            offset: expression.offset - source.offset,
          };
        else if (
          expression.offset === 0 &&
          source?.kind === 'integer' &&
          ['add', 'sub', 'mul', 'and', 'or', 'xor'].includes(source.op)
        ) {
          const block = owner.get(id)!;
          replacement = {
            ...source,
            left: narrow(source.left, width, block),
            right: narrow(source.right, width, block),
          };
        } else if (source?.kind === 'concat') {
          let offset = 0;
          for (const part of source.values) {
            context.checkpoint(1);
            if (
              expression.offset >= offset &&
              expression.offset + width <= offset + bitWidth(part.type)
            ) {
              replacement = { kind: 'extract', value: part, offset: expression.offset - offset };
              break;
            }
            offset += bitWidth(part.type);
          }
        }
      }
      if (!sourceCells && expression.kind === 'concat' && expression.values.length) {
        let offset = 0,
          base: Value | null = null,
          complete = true;
        for (const part of expression.values) {
          const extraction = observe(part.id);
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
        if (complete && base && sameType(value.type, base.type))
          replacement = { kind: 'cast', op: 'bitcast', value: base };
        else if (
          expression.values.slice(1).every((part) => {
            const definition = observe(part.id);
            return definition?.kind === 'constant' && definition.bits === 0n;
          })
        )
          replacement = { kind: 'cast', op: 'zero_extend', value: expression.values[0]! };
      }
      if (expression.kind === 'flag' && expression.op === 'add' && expression.flag === 'zero') {
        const right = observe(expression.right.id),
          carry = observe(expression.carry.id);
        if (right?.kind === 'constant' && carry?.kind === 'constant' && carry.bits === 0n) {
          const compared = create(
            `zero-add:${id}`,
            expression.left.type,
            owner.get(id)!,
            { kind: 'constant', bits: BigInt.asUintN(bitWidth(expression.left.type), -right.bits) },
            [value],
          );
          replacement = { kind: 'compare', op: 'eq', left: expression.left, right: compared };
        }
      }
      // Source view: compare flags and their condition-code consumers become
      // direct relational predicates; exact by outcome enumeration.
      const condition = sourceCells
        ? foldSourceCondition(value, expression, observe, resolve, create, owner.get(id)!, context)
        : null;
      if (condition) replacement = condition;
      const recombined =
        sourceCells && !condition
          ? recombineBitSlices(
              value,
              expression,
              observe,
              create,
              owner.get(id)!,
              context,
              packingShifts,
            )
          : null;
      if (recombined) {
        replacement = recombined;
        cellRewrite = true;
      }
      // Source view only: exact same-type identities (x&x, x|x, ones&x and the
      // constant neutral elements) leave the operand itself.
      let identity = false;
      if (sourceCells && replacement.kind === 'integer' && value.type.kind === 'integer') {
        const operand = integerIdentity(
          value.type,
          replacement,
          constant(replacement.left),
          constant(replacement.right),
          true,
        );
        if (operand) {
          replacement = { kind: 'cast', op: 'bitcast', value: operand };
          identity = true;
        }
      }
      // A sign extension of a strictly narrower zero extension never sees a set
      // sign bit: it is the zero extension of the original operand.
      let extensionFold = false;
      if (sourceCells && replacement.kind === 'cast' && replacement.op === 'sign_extend') {
        const inner = observe(replacement.value.id);
        if (
          inner?.kind === 'cast' &&
          inner.op === 'zero_extend' &&
          bitWidth(inner.value.type) < bitWidth(replacement.value.type)
        ) {
          replacement = { kind: 'cast', op: 'zero_extend', value: inner.value };
          extensionFold = true;
        }
      }
      const operands = expressionOperands(replacement);
      context.checkpoint(operands.length);
      if (
        operands.length &&
        operands.every((operand) => observe(operand.id)?.kind === 'constant')
      ) {
        const evaluated = evaluateExpression(value.type, replacement, (operand) => {
          const constant = observe(operand.id)!;
          return constant.kind === 'constant'
            ? { kind: 'bits', bits: constant.bits }
            : { kind: 'unknown', reason: 'nonconstant source operand' };
        });
        if (evaluated.kind === 'bits') replacement = { kind: 'constant', bits: evaluated.bits };
      }
      // Revisit this value for multi-step reductions as well as its readers.
      if (replacement !== expression || operandsChanged) {
        // The wiring rule has already proved every bit and ordered opaque
        // dependency structurally. Shared BDD exhaustion must not undo that
        // proof; retain the independent veto while it still has an allowance.
        // Source view: exact wiring is not a speculative candidate either:
        // same-type identity operand resolution, and slice/extension reselection
        // that relocates existing bits without arithmetic. Nonstructural rewrites
        // (arithmetic, narrowing, folding) keep the conservative exhausted
        // fallback; checked sessions keep their original per-candidate records.
        const wiring =
          recombined !== null ||
          (sourceCells &&
            (replacement === expression ||
              replacement.kind === 'extract' ||
              (replacement.kind === 'cast' && replacement.op === 'bitcast')));
        // A condition fold is proved by its own exhaustive outcome table; the
        // bitvector checker models neither ordered compares nor selects.
        if (!condition && (!wiring || !validation.allowance.exhausted)) {
          if (validation.skipExhaustedBitvector(id)) continue;
          const checked = validation.check('bitvector', id, 'source expression rewrite', () =>
            validateBitvectorCandidate(
              value,
              original,
              replacement,
              expressions,
              validation.allowance,
            ),
          );
          if (checked.status === 'rejected') {
            validation.rejectedRewrites.add(id);
            continue;
          }
        }
        if (
          condition &&
          !validation.presentation(
            'condition_flags',
            id,
            'compare flags and their condition-code consumers (NZCV/EFLAGS bits, conditional compares, cset/csel/setcc/cmov selects, FP compare flags) as native relational predicates joined by && and ||; exact over every feasible equal/unsigned/signed/wrapped-sign outcome and IEEE less/equal/greater/unordered outcome; a condition depending on the wrapped sign or overflow alone keeps its flag helper',
            expressionOperands(original).map((operand) => operand.id),
          )
        )
          continue;
        if (
          cellRewrite &&
          !validation.presentation(
            'register_cell_recombination',
            id,
            'bounded integer DAG wiring preserves every bit and ordered opaque dependencies; contiguous slices, zero extension, masked inserts and power-of-two packing shifts only',
            expressionOperands(original).map((operand) => operand.id),
          )
        )
          continue;
        if (
          identity &&
          !validation.presentation(
            'integer_identity',
            id,
            'same-width integer operation with a proven neutral operand or two identical operands (x&x, x|x, x&ones, x|0, x+0, x^0, x*1, x<<0) is exactly that operand; operands that could carry an unknown (x^x, x-x, x*0) are never dropped',
            expressionOperands(original).map((operand) => operand.id),
          )
        )
          continue;
        if (
          extensionFold &&
          !validation.presentation(
            'extension_fold',
            id,
            'sign extension of a strictly narrower zero extension: the sign bit is zero, so it is the zero extension of the original operand',
            expressionOperands(original).map((operand) => operand.id),
          )
        )
          continue;
        if (
          cellRewrite &&
          (expression.kind === 'concat' || expression.kind === 'insert') &&
          replacement.kind === 'integer'
        )
          packedSources.set(id, expression);
        expressions.set(id, replacement);
        invalidate(id);
        const oldAlias = identityOperand(value.type, original);
        if (oldAlias) identityUsers.get(oldAlias.id)?.delete(id);
        enqueue(id);
      }
    }
    queue.length = 0;
    current = '';
  };
  run();
  return {
    changed(id: string): void {
      // Internal rewrites are equivalent. An external replacement invalidates
      // retained structure on that value and on every view that inspected it.
      packedSources.delete(id);
      for (const user of users.get(id) ?? []) packedSources.delete(user);
      changed(id);
    },
    run,
  };
}
