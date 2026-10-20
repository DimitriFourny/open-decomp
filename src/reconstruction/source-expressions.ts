import type { OperationContext } from '../core/index.js';
import { mapExpression } from '../analysis/effects/index.js';
import {
  bitWidth,
  expressionOperands,
  integer,
  type DataType,
  type Expression,
  type Value,
} from '../ir/index.js';
import { identityOperand } from './expressions.js';
import { LocalValidationSession, validateBitvectorCandidate } from './local-validation.js';
import { viewRules, type ExpressionRule, type RuleSite } from './source-rules.js';

export interface SourceExpressionDemand {
  /** Conservative value closure, extended for newly introduced definitions. */
  readonly values: Set<string>;
  /** Initial definition queue; ownership transfers to one normalization session. */
  readonly pending: string[];
}

/** Work bound of the rule fixpoint: rewrites of one value. Every applied step is
 * itself established, so stopping keeps a correct (less reduced) form. */
const REWRITES_PER_VALUE = 32;

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
  const constant = (value: Value): bigint | null => {
    const expression = observe(resolve(value).id);
    return expression?.kind === 'constant'
      ? BigInt.asUintN(bitWidth(value.type), expression.bits)
      : null;
  };
  const view: RuleSite['view'] = sourceCells ? 'source' : 'checked',
    rules = viewRules(view),
    rewrites = new Map<string, number>();
  const run = (): void => {
    context.checkpoint(0);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      context.checkpoint(1);
      const id = queue[cursor]!;
      queued.delete(id);
      if (validation.rejectedRewrites.has(id) || (rewrites.get(id) ?? 0) >= REWRITES_PER_VALUE)
        continue;
      current = id;
      const original = expressions.get(id)!,
        value = values.get(id)!,
        block = owner.get(id)!;
      let operandsChanged = false;
      const expression = mapExpression(original, (operand) => {
        const resolved = resolve(operand);
        operandsChanged ||= resolved.id !== operand.id;
        return resolved;
      });
      // A join of lanes marks the products feeding it as packing shifts.
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
      const site: RuleSite = {
        value,
        expression,
        block,
        view,
        context,
        observe,
        resolve,
        constant,
        create,
        narrow: (operand, width) =>
          bitWidth(operand.type) === width
            ? operand
            : create(`low-bits:${operand.id}:${width}`, integer(width), block, {
                kind: 'extract',
                value: operand,
                offset: 0,
              }),
        literal: (type, bits, key) => {
          const masked = BigInt.asUintN(bitWidth(type), bits);
          return create(`${key}:${masked}`, type, block, { kind: 'constant', bits: masked }, [
            value,
          ]);
        },
        packingShifts,
        packedSources,
      };
      let rule: ExpressionRule | null = null,
        replacement = expression;
      for (const candidate of rules) {
        const rewritten = candidate.apply(site);
        if (rewritten) {
          rule = candidate;
          replacement = rewritten;
          break;
        }
      }
      if (replacement === expression && !operandsChanged) continue;
      // Operand resolution alone is exact wiring. Structural rules carry their
      // own proof; the independent BDD veto runs while its allowance remains
      // (source view). Bitvector rules keep the original form once it is
      // exhausted; checked sessions keep their per-candidate records. Rules
      // with their own proof (outcome tables, side conditions the BDD does
      // not model) are not re-proved by it.
      const proof = rule?.proof ?? 'structural',
        wiring = sourceCells && proof === 'structural';
      if (proof !== 'own' && (!wiring || !validation.allowance.exhausted)) {
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
        rule?.name &&
        !validation.presentation(
          rule.name,
          id,
          rule.scope,
          expressionOperands(original).map((operand) => operand.id),
        )
      )
        continue;
      if (
        rule?.cell &&
        (expression.kind === 'concat' || expression.kind === 'insert') &&
        replacement.kind === 'integer'
      )
        packedSources.set(id, expression);
      rewrites.set(id, (rewrites.get(id) ?? 0) + 1);
      expressions.set(id, replacement);
      invalidate(id);
      const oldAlias = identityOperand(value.type, original);
      if (oldAlias) identityUsers.get(oldAlias.id)?.delete(id);
      enqueue(id);
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
