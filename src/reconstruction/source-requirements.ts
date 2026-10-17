import { fingerprint, OperationError, type OperationContext } from '../core/index.js';
import type { Requirement, RequirementSite } from '../core/inference.js';
import type { EmissionInput, EmissionResult } from '../emitters/model.js';
import type { Expression, Origin } from '../ir/index.js';
import { fpEnvironmentGuard } from '../lifters/arm64/semantics.js';
import { x86FpEnvironmentGuard } from '../lifters/x86_64/semantics.js';
import type { BlockRegion } from '../presentation/index.js';
import type { Assignment, BoundaryProjection, Reconstruction } from './model.js';

export const FP_ENVIRONMENT_REQUIREMENT =
  'FP arithmetic requires nearest-even rounding, gradual underflow and disabled exception traps; FPCR/FPSR/MXCSR status and exceptional environments are not modeled. Each original guard and ordered effect remains in place. Acknowledgment is specific to a requirement, site and exact state epoch, never a promise that unknown calls preserve the environment.';

/** Arithmetic/conversion contracts, not float storage or payload bitcasts. */
export function needsSourceFpEnvironment(expression: Expression): boolean {
  return expression.kind === 'float' || expression.kind === 'float_unary' ||
    expression.kind === 'float_compare' || expression.kind === 'vector_float' ||
    (expression.kind === 'cast' && ['signed_to_float', 'unsigned_to_float',
      'float_to_signed', 'float_to_unsigned', 'float_convert'].includes(expression.op));
}

function requirementReferences(sites: readonly RequirementSite[], context: OperationContext) {
  const references = { subject_ids: new Set<string>(), evidence_ids: new Set<string>(), instruction_ids: new Set<string>() };
  for (const [field, maximum] of [['subject_ids', 10000], ['evidence_ids', 1000], ['instruction_ids', 10000]] as const)
    for (const site of sites)
      for (const id of site[field]) {
        context.checkpoint(1);
        const ids = references[field];
        if (!ids.has(id) && ids.size >= maximum)
          throw new OperationError({ code: 'resource_limit', severity: 'error', message: `Source requirement ${field} budget exceeded`,
            evidence_ids: site.evidence_ids, entity_id: site.subject_ids[0] });
        ids.add(id);
      }
  return { subject_ids: [...references.subject_ids], evidence_ids: [...references.evidence_ids],
    instruction_ids: [...references.instruction_ids] };
}

/** Descriptions may be shared; predicates and state identities may not. This
 * planner never rewrites the CFG, an effect, a clobber set or a call interface. */
export function planSourceRequirements(
  input: EmissionInput,
  blocks: ReadonlyMap<string, BlockRegion>,
  expressions: ReadonlyMap<string, Expression>,
  definitions: ReadonlyMap<string, Assignment>,
  calls: ReadonlyMap<string, BoundaryProjection>,
  context: OperationContext,
): readonly Requirement[] {
  const records: Requirement[] = [], fpSites: RequirementSite[] = [], fpOrigins: Origin[] = [];
  const failures = new Set<string>();
  const guardedEpochs = new Map<string, string | null>();
  const site = (origin: Origin, state: string, related: readonly Origin[] = [], predicate?: string, supported = true): RequirementSite => {
    const origins = [origin, ...related];
    return {
      id: `site_${fingerprint([input.function.id, origin.id, state])}`,
      subject_ids: [...new Set(origins.map((item) => item.id))],
      evidence_ids: [...new Set(origins.flatMap((item) => item.provenance.evidence_ids))],
      instruction_ids: [...new Set(origins.flatMap((item) => item.provenance.instruction_ids))],
      state_epoch: state,
      ...(predicate === undefined ? {} : { predicate_value_id: predicate, supported_predicate_value: supported }),
    };
  };
  const addFpSite = (origin: Origin, state: string, related: readonly Origin[] = [], predicate?: string, supported = true): void => {
    if (fpSites.length >= 1000)
      throw new OperationError({ code: 'resource_limit', severity: 'error', message: 'Source requirement site budget exceeded',
        evidence_ids: origin.provenance.evidence_ids, entity_id: origin.id });
    fpSites.push(site(origin, state, related, predicate, supported));
    fpOrigins.push(origin, ...related);
  };
  const record = (kind: Requirement['kind'], explanation: string, sites: RequirementSite[], origins: readonly Origin[]): Requirement => ({
    id: `requirement_${fingerprint([input.function.id, kind, kind === 'fp_environment' ? 'supported-fp' : sites[0]!.id])}`,
    kind, status: kind === 'fp_environment' ? 'assumption' : 'unresolved', explanation,
    ...requirementReferences(sites, context),
    ranges: origins.flatMap((item) => item.provenance.ranges), output_spans: [], sites,
  });
  // Recognize only the lifter's exact guard/failure contract and original SSA
  // mask source. Similar-looking user predicates are not environment proofs.
  for (const block of blocks.values()) {
    context.checkpoint(1);
    const control = block.control;
    if (control.kind !== 'if') continue;
    const failure = blocks.get(control.when_false.transfer.target);
    if (!failure || control.when_true.transfer.target === failure.id ||
        failure.control.kind !== 'unknown' || failure.control.reason !== fpEnvironmentGuard.unsupported_exit ||
        !failure.statements.some((node) => node.kind === 'unknown_effect' && node.reason === fpEnvironmentGuard.unsupported_effect) ||
        failure.statements.some((node) => node.kind !== 'assign' &&
          (node.kind !== 'unknown_effect' || node.reason !== fpEnvironmentGuard.unsupported_effect))) continue;
    const comparison = definitions.get(control.condition.id)?.expression;
    if (comparison?.kind !== 'compare' || comparison.op !== 'eq') continue;
    const zero = definitions.get(comparison.right.id)?.expression;
    const masked = definitions.get(comparison.left.id)?.expression;
    if (zero?.kind !== 'constant' || zero.bits !== 0n || masked?.kind !== 'integer' || masked.op !== 'and') continue;
    const mask = definitions.get(masked.right.id)?.expression;
    if (mask?.kind !== 'constant' || mask.bits !== fpEnvironmentGuard.mask) continue;
    let controlState: string | undefined;
    for (const binding of block.register_exit) {
      context.checkpoint(1);
      if (binding.register.root === fpEnvironmentGuard.control_root) {
        controlState = binding.value.id;
        break;
      }
    }
    if (controlState === undefined) continue;
    let state = masked.left;
    const stateOrigins: Origin[] = [];
    for (let depth = 0; depth < 128 && state.id !== controlState; depth++) {
      context.checkpoint(1);
      const definition = definitions.get(state.id), alias = definition?.expression;
      if (!definition || alias?.kind !== 'cast' || alias.op !== 'bitcast' ||
          state.type.kind !== 'integer' || alias.value.type.kind !== 'integer' ||
          state.type.bits !== alias.value.type.bits) break;
      stateOrigins.push(definition, { ...definition, id: state.id });
      state = alias.value;
    }
    if (state.id !== controlState) continue;
    const related = [definitions.get(control.condition.id)!, definitions.get(comparison.left.id)!,
      { ...control, id: control.effect.id }, { ...control, id: state.id },
      ...stateOrigins, ...failure.statements.filter((node) => node.kind === 'unknown_effect'), failure.control];
    addFpSite(control, state.id, related, control.condition.id);
    const supported = control.when_true.transfer.target;
    const previous = guardedEpochs.get(supported);
    guardedEpochs.set(supported, previous === undefined || previous === state.id ? state.id : null);
    failures.add(failure.control.id);
    for (const node of failure.statements) failures.add(node.id);
  }
  // x86 guards test the BAD state and branch true to failure, unlike ARM's
  // supported-state predicate. Keep that orientation explicit at every site.
  for (const block of blocks.values()) {
    context.checkpoint(1);
    const control = block.control;
    if (control.kind !== 'if') continue;
    const failure = blocks.get(control.when_true.transfer.target);
    if (!failure || control.when_false.transfer.target === failure.id ||
        failure.control.kind !== 'unknown' || failure.control.reason !== x86FpEnvironmentGuard.unsupported_exit ||
        failure.statements.some((node) => node.kind !== 'assign')) continue;
    const comparison = definitions.get(control.condition.id)?.expression;
    if (comparison?.kind !== 'compare' || comparison.op !== 'ne') continue;
    const expected = definitions.get(comparison.right.id)?.expression;
    if (expected?.kind !== 'constant' || expected.bits !== x86FpEnvironmentGuard.supported_bits) continue;
    let controlState: string | undefined;
    for (const binding of block.register_exit) {
      context.checkpoint(1);
      if (binding.register.root === x86FpEnvironmentGuard.control_root &&
          binding.register.offset_bits === x86FpEnvironmentGuard.offset_bits &&
          binding.register.width_bits === x86FpEnvironmentGuard.width_bits) {
        controlState = binding.value.id; break;
      }
    }
    if (controlState === undefined) continue;
    let state = comparison.left;
    const stateOrigins: Origin[] = [];
    for (let depth = 0; depth < 128 && state.id !== controlState; depth++) {
      context.checkpoint(1);
      const definition = definitions.get(state.id), alias = definition?.expression;
      if (!definition || alias?.kind !== 'cast' || alias.op !== 'bitcast' ||
          state.type.kind !== 'integer' || alias.value.type.kind !== 'integer' ||
          state.type.bits !== alias.value.type.bits) break;
      stateOrigins.push(definition, { ...definition, id: state.id }); state = alias.value;
    }
    if (state.id !== controlState || state.type.kind !== 'integer' ||
        state.type.bits !== x86FpEnvironmentGuard.width_bits) continue;
    const related = [definitions.get(control.condition.id)!, { ...control, id: control.effect.id },
      { ...control, id: state.id }, ...stateOrigins, failure.control];
    addFpSite(control, state.id, related, control.condition.id, false);
    const supported = control.when_false.transfer.target, previous = guardedEpochs.get(supported);
    guardedEpochs.set(supported, previous === undefined || previous === state.id ? state.id : null);
    failures.add(failure.control.id);
    for (const node of failure.statements) failures.add(node.id);
  }
  const callees = new Map(input.source?.callees.map((callee) => [callee.call_id, callee]) ?? []);
  for (const block of blocks.values()) {
    for (const node of block.statements) {
      context.checkpoint(1);
      if (failures.has(node.id)) continue;
      if (node.kind === 'assign') {
        const expression = expressions.get(node.result.id) ?? node.expression;
        if (expression.kind === 'indeterminate') {
          records.push(record('unresolved', expression.reason,
            [site(node, node.result.id, [{ ...node, id: node.result.id }])], [node]));
        } else if (needsSourceFpEnvironment(expression)) {
          addFpSite(node, guardedEpochs.get(block.id) ?? `unmodeled:${node.id}`, [{ ...node, id: node.result.id }]);
        }
      } else if (node.kind === 'unknown_effect') {
        records.push(record('unresolved', node.reason, [site(node, node.effect_in.id)], [node]));
      } else if (node.kind === 'call') {
        const callee = callees.get(node.id);
        const projection = calls.get(node.id);
        if (!projection || projection.kind === 'physical' || projection.argument_list_complete === false)
          records.push(record('unresolved',
            'The call interface is incomplete. Known ordered arguments and results remain explicit; an unresolved remainder is not zero arity, and the original conservative boundary clobbers and effects are retained.',
            [site(node, node.effect_in.id)], [node]));
        if (callee?.requirements?.includes('fp_environment')) {
          addFpSite(node, node.effect_in.id);
        }
      }
    }
    const control = block.control;
    if ((control.kind === 'unknown' || control.kind === 'indirect') && !failures.has(control.id))
      records.push(record('unresolved', control.kind === 'unknown' ? control.reason :
        'Indirect target or source interface remains unresolved; original target, arguments, boundary effects and result uncertainty are retained.',
      [site(control, control.effect.id)], [control]));
  }
  if (fpSites.length) records.unshift(record('fp_environment', FP_ENVIRONMENT_REQUIREMENT, fpSites, fpOrigins));
  return records;
}

export interface SourceRequirementPredicate {
  readonly requirement: Requirement;
  readonly site: RequirementSite;
}

/** Original control identity, not predicate equality, distinguishes sites. */
export function sourceRequirementPredicates(requirements: readonly Requirement[] | undefined):
  ReadonlyMap<string, SourceRequirementPredicate> {
  const result = new Map<string, SourceRequirementPredicate>();
  for (const requirement of requirements ?? [])
    for (const site of requirement.sites)
      if (site.predicate_value_id !== undefined && site.subject_ids[0])
        result.set(site.subject_ids[0], { requirement, site });
  return result;
}

/** Index mappings once. Only actual mapped output sites survive, with exact
 * original provenance and UTF-16 spans; no generated-text interpretation. */
export function sourceRequirementProofs(
  program: Reconstruction,
  mappings: EmissionResult['emission']['mappings'],
  context: OperationContext,
  metadata?: (bytes: number) => void,
): readonly Requirement[] {
  const requirements = program.source?.requirements ?? [];
  if (!requirements.length) return [];
  const anchors = new Set(requirements.flatMap((record) => record.sites.map((site) => site.subject_ids[0]!)));
  const bySubject = new Map<string, typeof mappings[number][]>();
  // Reconstruction maps every original statement under its own origin ID,
  // even when its expression is inlined. Do not re-expand normalized semantic
  // references or index unrelated subjects for these exact original anchors.
  for (const mapping of mappings) {
    context.checkpoint(1);
    if (!anchors.has(mapping.statement_id)) continue;
    const rows = bySubject.get(mapping.statement_id) ?? [];
    rows.push(mapping); bySubject.set(mapping.statement_id, rows);
  }
  const liveOrigins = new Set<string>();
  for (const [value, origins] of program.source?.value_origins ?? []) {
    context.checkpoint(1);
    if (program.live.has(value))
      for (const origin of origins) { context.checkpoint(1); liveOrigins.add(origin); }
  }
  const result: Requirement[] = [];
  for (const requirement of requirements) {
    const spans = new Map<string, { start: number; end: number }>();
    const mappedRanges = new Set<string>();
    const rangeKey = (range: Requirement['ranges'][number]): string =>
      `${range.start.image_id}:${range.start.space}:${range.start.value}:${range.size}`;
    const sites = requirement.sites.filter((site) => {
      const result = site.predicate_value_id === undefined ? site.subject_ids[1] : undefined;
      if (result && program.values.has(result) && !program.live.has(result) && !liveOrigins.has(result)) return false;
      let emitted = false;
      for (const mapping of bySubject.get(site.subject_ids[0]!) ?? []) {
        context.checkpoint(1);
        if (mapping.end <= mapping.start) continue;
        if (!spans.has(`${mapping.start}:${mapping.end}`) && spans.size >= 1000)
          throw new OperationError({ code: 'resource_limit', severity: 'error', message: 'Source requirement output span budget exceeded',
            evidence_ids: site.evidence_ids, entity_id: site.subject_ids[0] });
        emitted = true;
        spans.set(`${mapping.start}:${mapping.end}`, { start: mapping.start, end: mapping.end });
        for (const range of mapping.ranges) mappedRanges.add(rangeKey(range));
      }
      return emitted;
    });
    if (!sites.length) continue;
    if (result.length >= 1000)
      throw new OperationError({ code: 'resource_limit', severity: 'error', message: 'Source requirement record budget exceeded',
        evidence_ids: requirement.evidence_ids, entity_id: requirement.subject_ids[0] });
    const ranges = new Map<string, Requirement['ranges'][number]>();
    for (const range of requirement.ranges) {
      context.checkpoint(1);
      const key = rangeKey(range);
      if (!mappedRanges.has(key) || ranges.has(key)) continue;
      if (ranges.size >= 10000)
        throw new OperationError({ code: 'resource_limit', severity: 'error', message: 'Source requirement range budget exceeded',
          evidence_ids: requirement.evidence_ids, entity_id: requirement.subject_ids[0] });
      ranges.set(key, range);
    }
    const record: Requirement = { ...requirement, sites, ...requirementReferences(sites, context),
      ranges: [...ranges.values()],
      output_spans: [...spans.values()].sort((a, b) => a.start - b.start || a.end - b.end),
    };
    if (metadata) {
      const pending: unknown[] = [record];
      while (pending.length) {
        context.checkpoint(1);
        const item = pending.pop();
        if (typeof item === 'string') metadata(Buffer.byteLength(item) + 8);
        else if (typeof item === 'bigint' || typeof item === 'number') metadata(32);
        else if (Array.isArray(item)) { metadata(2 + item.length); pending.push(...item); }
        else if (item && typeof item === 'object') {
          for (const [key, value] of Object.entries(item)) { metadata(key.length + 4); pending.push(value); }
        } else metadata(5);
      }
    }
    result.push(record);
  }
  return result;
}
