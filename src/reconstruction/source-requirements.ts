import {
  fingerprint,
  OperationError,
  type AddressRange,
  type OperationContext,
  type RegisterDescriptor,
} from '../core/index.js';
import type { Requirement, RequirementSite } from '../core/inference.js';
import type { EmissionInput, EmissionResult } from '../emitters/model.js';
import { registerStateAt, type Expression, type Origin } from '../ir/index.js';
import { fpEnvironmentGuard } from '../lifters/arm64/semantics.js';
import { x86FpEnvironmentGuard } from '../lifters/x86_64/semantics.js';
import type { BlockRegion } from '../presentation/index.js';
import type { Assignment, BoundaryProjection, Reconstruction } from './model.js';
import type { AbiConformanceSite } from './local-validation.js';

export const FP_ENVIRONMENT_REQUIREMENT =
  'FP arithmetic requires nearest-even rounding, gradual underflow and disabled exception traps; FPCR/FPSR/MXCSR status and exceptional environments are not modeled. Each original guard and ordered effect remains in place. Acknowledgment is specific to a requirement, site and exact state epoch, never a promise that unknown calls preserve the environment.';

/** Arithmetic/conversion contracts, not float storage or payload bitcasts. */
export function needsSourceFpEnvironment(expression: Expression): boolean {
  return (
    expression.kind === 'float' ||
    expression.kind === 'float_unary' ||
    expression.kind === 'float_compare' ||
    expression.kind === 'vector_float' ||
    (expression.kind === 'cast' &&
      [
        'signed_to_float',
        'unsigned_to_float',
        'float_to_signed',
        'float_to_unsigned',
        'float_convert',
      ].includes(expression.op))
  );
}

function requirementReferences(sites: readonly RequirementSite[], context: OperationContext) {
  const references = {
    subject_ids: new Set<string>(),
    evidence_ids: new Set<string>(),
    instruction_ids: new Set<string>(),
  };
  for (const [field, maximum] of [
    ['subject_ids', 10000],
    ['evidence_ids', 1000],
    ['instruction_ids', 10000],
  ] as const)
    for (const site of sites)
      for (const id of site[field]) {
        context.checkpoint(1);
        const ids = references[field];
        if (!ids.has(id) && ids.size >= maximum)
          throw new OperationError({
            code: 'resource_limit',
            severity: 'error',
            message: `Source requirement ${field} budget exceeded`,
            evidence_ids: site.evidence_ids,
            entity_id: site.subject_ids[0],
          });
        ids.add(id);
      }
  return {
    subject_ids: [...references.subject_ids],
    evidence_ids: [...references.evidence_ids],
    instruction_ids: [...references.instruction_ids],
  };
}

/** Descriptions may be shared; predicates and state identities may not. This
 * planner never rewrites the CFG, an effect, a clobber set or a call interface. */
export function planSourceRequirements(
  input: EmissionInput,
  blocks: ReadonlyMap<string, BlockRegion>,
  expressions: ReadonlyMap<string, Expression>,
  definitions: ReadonlyMap<string, Assignment>,
  calls: ReadonlyMap<string, BoundaryProjection>,
  returns: ReadonlyMap<string, BoundaryProjection>,
  context: OperationContext,
): readonly Requirement[] {
  const records: Requirement[] = [],
    fpSites: RequirementSite[] = [],
    fpOrigins: Origin[] = [];
  const failures = new Set<string>();
  const guardedEpochs = new Map<string, string | null>();
  const site = (
    origin: Origin,
    state: string,
    related: readonly Origin[] = [],
    predicate?: string,
    supported = true,
  ): RequirementSite => {
    const origins = [origin, ...related];
    return {
      id: `site_${fingerprint([input.function.id, origin.id, state])}`,
      subject_ids: [...new Set(origins.map((item) => item.id))],
      evidence_ids: [...new Set(origins.flatMap((item) => item.provenance.evidence_ids))],
      instruction_ids: [...new Set(origins.flatMap((item) => item.provenance.instruction_ids))],
      state_epoch: state,
      ...(predicate === undefined
        ? {}
        : { predicate_value_id: predicate, supported_predicate_value: supported }),
    };
  };
  const addFpSite = (
    origin: Origin,
    state: string,
    related: readonly Origin[] = [],
    predicate?: string,
    supported = true,
  ): void => {
    if (fpSites.length >= 1000)
      throw new OperationError({
        code: 'resource_limit',
        severity: 'error',
        message: 'Source requirement site budget exceeded',
        evidence_ids: origin.provenance.evidence_ids,
        entity_id: origin.id,
      });
    fpSites.push(site(origin, state, related, predicate, supported));
    fpOrigins.push(origin, ...related);
  };
  const record = (
    kind: Requirement['kind'],
    explanation: string,
    sites: RequirementSite[],
    origins: readonly Origin[],
  ): Requirement => ({
    id: `requirement_${fingerprint([input.function.id, kind, kind === 'fp_environment' ? 'supported-fp' : sites[0]!.id])}`,
    kind,
    status: kind === 'fp_environment' ? 'assumption' : 'unresolved',
    explanation,
    ...requirementReferences(sites, context),
    ranges: origins.flatMap((item) => item.provenance.ranges),
    output_spans: [],
    sites,
  });
  // Recognize only the lifter's exact guard/failure contract and original SSA
  // mask source. Similar-looking user predicates are not environment proofs.
  // The control register's block-exit state is derived along dominators.
  const rows = {
    idom: (id: string) => blocks.get(id)?.dominator ?? null,
    entry: (id: string) => blocks.get(id)?.register_entry ?? [],
    exit: (id: string) => blocks.get(id)?.register_exit ?? [],
  };
  const exitState = (
    block: string,
    matches: (register: RegisterDescriptor) => boolean,
  ): string | undefined => {
    const cell = blocks.get(input.function.entry)?.register_entry.find((binding) => {
      context.checkpoint(1);
      return matches(binding.register);
    })?.register;
    return (
      cell &&
      registerStateAt(rows, block, cell, 'exit', (work) => context.checkpoint(work))?.value.id
    );
  };
  for (const block of blocks.values()) {
    context.checkpoint(1);
    const control = block.control;
    if (control.kind !== 'if') continue;
    const failure = blocks.get(control.when_false.transfer.target);
    if (
      !failure ||
      control.when_true.transfer.target === failure.id ||
      failure.control.kind !== 'unknown' ||
      failure.control.reason !== fpEnvironmentGuard.unsupported_exit ||
      !failure.statements.some(
        (node) =>
          node.kind === 'unknown_effect' && node.reason === fpEnvironmentGuard.unsupported_effect,
      ) ||
      failure.statements.some(
        (node) =>
          node.kind !== 'assign' &&
          (node.kind !== 'unknown_effect' || node.reason !== fpEnvironmentGuard.unsupported_effect),
      )
    )
      continue;
    const comparison = definitions.get(control.condition.id)?.expression;
    if (comparison?.kind !== 'compare' || comparison.op !== 'eq') continue;
    const zero = definitions.get(comparison.right.id)?.expression;
    const masked = definitions.get(comparison.left.id)?.expression;
    if (
      zero?.kind !== 'constant' ||
      zero.bits !== 0n ||
      masked?.kind !== 'integer' ||
      masked.op !== 'and'
    )
      continue;
    const mask = definitions.get(masked.right.id)?.expression;
    if (mask?.kind !== 'constant' || mask.bits !== fpEnvironmentGuard.mask) continue;
    const controlState = exitState(
      block.id,
      (register) => register.root === fpEnvironmentGuard.control_root,
    );
    if (controlState === undefined) continue;
    let state = masked.left;
    const stateOrigins: Origin[] = [];
    for (let depth = 0; depth < 128 && state.id !== controlState; depth++) {
      context.checkpoint(1);
      const definition = definitions.get(state.id),
        alias = definition?.expression;
      if (
        !definition ||
        alias?.kind !== 'cast' ||
        alias.op !== 'bitcast' ||
        state.type.kind !== 'integer' ||
        alias.value.type.kind !== 'integer' ||
        state.type.bits !== alias.value.type.bits
      )
        break;
      stateOrigins.push(definition, { ...definition, id: state.id });
      state = alias.value;
    }
    if (state.id !== controlState) continue;
    const related = [
      definitions.get(control.condition.id)!,
      definitions.get(comparison.left.id)!,
      { ...control, id: control.effect.id },
      { ...control, id: state.id },
      ...stateOrigins,
      ...failure.statements.filter((node) => node.kind === 'unknown_effect'),
      failure.control,
    ];
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
    if (
      !failure ||
      control.when_false.transfer.target === failure.id ||
      failure.control.kind !== 'unknown' ||
      failure.control.reason !== x86FpEnvironmentGuard.unsupported_exit ||
      failure.statements.some((node) => node.kind !== 'assign')
    )
      continue;
    const comparison = definitions.get(control.condition.id)?.expression;
    if (comparison?.kind !== 'compare' || comparison.op !== 'ne') continue;
    const expected = definitions.get(comparison.right.id)?.expression;
    if (expected?.kind !== 'constant' || expected.bits !== x86FpEnvironmentGuard.supported_bits)
      continue;
    const controlState = exitState(
      block.id,
      (register) =>
        register.root === x86FpEnvironmentGuard.control_root &&
        register.offset_bits === x86FpEnvironmentGuard.offset_bits &&
        register.width_bits === x86FpEnvironmentGuard.width_bits,
    );
    if (controlState === undefined) continue;
    let state = comparison.left;
    const stateOrigins: Origin[] = [];
    for (let depth = 0; depth < 128 && state.id !== controlState; depth++) {
      context.checkpoint(1);
      const definition = definitions.get(state.id),
        alias = definition?.expression;
      if (
        !definition ||
        alias?.kind !== 'cast' ||
        alias.op !== 'bitcast' ||
        state.type.kind !== 'integer' ||
        alias.value.type.kind !== 'integer' ||
        state.type.bits !== alias.value.type.bits
      )
        break;
      stateOrigins.push(definition, { ...definition, id: state.id });
      state = alias.value;
    }
    if (
      state.id !== controlState ||
      state.type.kind !== 'integer' ||
      state.type.bits !== x86FpEnvironmentGuard.width_bits
    )
      continue;
    const related = [
      definitions.get(control.condition.id)!,
      { ...control, id: control.effect.id },
      { ...control, id: state.id },
      ...stateOrigins,
      failure.control,
    ];
    addFpSite(control, state.id, related, control.condition.id, false);
    const supported = control.when_false.transfer.target,
      previous = guardedEpochs.get(supported);
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
          records.push(
            record(
              'unresolved',
              expression.reason,
              [site(node, node.result.id, [{ ...node, id: node.result.id }])],
              [node],
            ),
          );
        } else if (needsSourceFpEnvironment(expression)) {
          addFpSite(node, guardedEpochs.get(block.id) ?? `unmodeled:${node.id}`, [
            { ...node, id: node.result.id },
          ]);
        }
      } else if (node.kind === 'unknown_effect') {
        records.push(record('unresolved', node.reason, [site(node, node.effect_in.id)], [node]));
      } else if (node.kind === 'call') {
        const callee = callees.get(node.id);
        const projection = calls.get(node.id);
        if (
          !projection ||
          projection.kind === 'physical' ||
          projection.argument_list_complete === false
        )
          records.push(
            record(
              'unresolved',
              'The call interface is incomplete. Known ordered arguments and results remain explicit; an unresolved remainder is not zero arity, and the original conservative boundary clobbers and effects are retained.',
              [site(node, node.effect_in.id)],
              [node],
            ),
          );
        if (callee?.requirements?.includes('fp_environment')) {
          addFpSite(node, node.effect_in.id);
        }
      }
    }
    const control = block.control;
    if ((control.kind === 'unknown' || control.kind === 'indirect') && !failures.has(control.id))
      records.push(
        record(
          'unresolved',
          control.kind === 'unknown'
            ? control.reason
            : 'Indirect target or source interface remains unresolved; original target, arguments, boundary effects and result uncertainty are retained.',
          [site(control, control.effect.id)],
          [control],
        ),
      );
    if (control.kind === 'return') {
      const projection = returns.get(control.id);
      if (projection?.kind === 'inferred' && projection.outputs.length)
        records.push(
          record(
            'unresolved',
            'The source return list is incomplete. Known primary results remain separate from changed possible ABI return storage, preserved as an immutable-entry overlay rather than an authored aggregate: ' +
              projection.outputs
                .map(
                  ({ register }) =>
                    `${register.root}[${register.offset_bits}:${register.width_bits}]`,
                )
                .join(', '),
            [site(control, control.effect.id)],
            [control],
          ),
        );
    }
  }
  if (fpSites.length)
    records.unshift(record('fp_environment', FP_ENVIRONMENT_REQUIREMENT, fpSites, fpOrigins));
  return records;
}

export interface SourceRequirementPredicate {
  readonly requirement: Requirement;
  readonly site: RequirementSite;
}

/** Original control identity, not predicate equality, distinguishes sites. */
export function sourceRequirementPredicates(
  requirements: readonly Requirement[] | undefined,
): ReadonlyMap<string, SourceRequirementPredicate> {
  const result = new Map<string, SourceRequirementPredicate>();
  for (const requirement of requirements ?? [])
    for (const site of requirement.sites)
      if (site.predicate_value_id !== undefined && site.subject_ids[0])
        result.set(site.subject_ids[0], { requirement, site });
  return result;
}

/** One `abi_conformance` assumption per presentation rule, with one site per
 * applied rewrite. Sites anchor at mapped original statements/controls. */
export function abiConformanceRequirements(
  functionId: string,
  sites: readonly AbiConformanceSite[],
  origin: (id: string) => Origin | undefined,
  context: OperationContext,
): readonly Requirement[] {
  const byRule = new Map<
    string,
    { rule: string; explanation: string; sites: RequirementSite[]; origins: Origin[] }
  >();
  for (const item of sites) {
    context.checkpoint(1 + item.anchor_ids.length);
    const origins = item.anchor_ids.flatMap((id) => origin(id) ?? []);
    if (!origins.length) continue;
    const key = JSON.stringify([item.rule, item.explanation]);
    const row = byRule.get(key) ?? {
      rule: item.rule,
      explanation: item.explanation,
      sites: [],
      origins: [],
    };
    if (row.sites.length >= 1000) continue;
    row.sites.push({
      id: `site_${fingerprint([functionId, 'abi_conformance', item.rule, item.explanation, ...item.anchor_ids])}`,
      subject_ids: [...new Set(origins.map((entry) => entry.id))],
      evidence_ids: [...new Set(origins.flatMap((entry) => entry.provenance.evidence_ids))],
      instruction_ids: [...new Set(origins.flatMap((entry) => entry.provenance.instruction_ids))],
      state_epoch: item.rule,
    });
    row.origins.push(...origins);
    byRule.set(key, row);
  }
  return [...byRule.values()].map((row) => ({
    id: `requirement_${fingerprint([functionId, 'abi_conformance', row.rule, row.explanation])}`,
    kind: 'abi_conformance' as const,
    status: 'assumption' as const,
    explanation: row.explanation,
    ...requirementReferences(row.sites, context),
    ranges: row.origins.flatMap((entry) => entry.provenance.ranges),
    output_spans: [],
    sites: row.sites,
  }));
}

/** Index mappings once. Only actual mapped output sites survive, with exact
 * original provenance and UTF-16 spans; no generated-text interpretation.
 * Mapping references resolve through the emission's own interned tables. */
export function sourceRequirementProofs(
  program: Reconstruction,
  mappings: EmissionResult['emission']['mappings'],
  tables: { readonly ids: readonly string[]; readonly ranges: readonly AddressRange[] },
  context: OperationContext,
  additional: readonly Requirement[] = [],
): readonly Requirement[] {
  const requirements = [...(program.source?.requirements ?? []), ...additional];
  if (!requirements.length) return [];
  const anchors = new Set(
    requirements.flatMap((record) =>
      record.sites.flatMap((site) =>
        record.kind === 'abi_conformance' ? site.subject_ids : [site.subject_ids[0]!],
      ),
    ),
  );
  const bySubject = new Map<string, (typeof mappings)[number][]>();
  // Reconstruction maps every original statement under its own origin ID,
  // even when its expression is inlined. Do not re-expand normalized semantic
  // references or index unrelated subjects for these exact original anchors.
  for (const mapping of mappings) {
    context.checkpoint(1);
    const statement = tables.ids[mapping.semantic_refs[0]!]!;
    if (!anchors.has(statement)) continue;
    const rows = bySubject.get(statement) ?? [];
    rows.push(mapping);
    bySubject.set(statement, rows);
  }
  const liveOrigins = new Set<string>();
  for (const [value, origins] of program.source?.value_origins ?? []) {
    context.checkpoint(1);
    if (program.live.has(value))
      for (const origin of origins) {
        context.checkpoint(1);
        liveOrigins.add(origin);
      }
  }
  const result: Requirement[] = [];
  for (const requirement of requirements) {
    const spans = new Map<string, { start: number; end: number }>();
    const mappedRanges = new Set<string>();
    const rangeKey = (range: Requirement['ranges'][number]): string =>
      `${range.start.image_id}:${range.start.space}:${range.start.value}:${range.size}`;
    const sites = requirement.sites.filter((site) => {
      const result =
        requirement.kind !== 'abi_conformance' && site.predicate_value_id === undefined
          ? site.subject_ids[1]
          : undefined;
      if (
        result &&
        program.values.has(result) &&
        !program.live.has(result) &&
        !liveOrigins.has(result)
      )
        return false;
      let emitted = false;
      const subjectIds =
        requirement.kind === 'abi_conformance' ? site.subject_ids : [site.subject_ids[0]!];
      for (const subject of subjectIds)
        for (const mapping of bySubject.get(subject) ?? []) {
          context.checkpoint(1);
          if (mapping.end <= mapping.start) continue;
          if (!spans.has(`${mapping.start}:${mapping.end}`) && spans.size >= 1000)
            throw new OperationError({
              code: 'resource_limit',
              severity: 'error',
              message: 'Source requirement output span budget exceeded',
              evidence_ids: site.evidence_ids,
              entity_id: site.subject_ids[0],
            });
          emitted = true;
          spans.set(`${mapping.start}:${mapping.end}`, { start: mapping.start, end: mapping.end });
          for (const ref of mapping.range_refs) mappedRanges.add(rangeKey(tables.ranges[ref]!));
        }
      return emitted;
    });
    if (!sites.length) continue;
    if (result.length >= 1000)
      throw new OperationError({
        code: 'resource_limit',
        severity: 'error',
        message: 'Source requirement record budget exceeded',
        evidence_ids: requirement.evidence_ids,
        entity_id: requirement.subject_ids[0],
      });
    const ranges = new Map<string, Requirement['ranges'][number]>();
    for (const range of requirement.ranges) {
      context.checkpoint(1);
      const key = rangeKey(range);
      if (!mappedRanges.has(key) || ranges.has(key)) continue;
      if (ranges.size >= 10000)
        throw new OperationError({
          code: 'resource_limit',
          severity: 'error',
          message: 'Source requirement range budget exceeded',
          evidence_ids: requirement.evidence_ids,
          entity_id: requirement.subject_ids[0],
        });
      ranges.set(key, range);
    }
    result.push({
      ...requirement,
      sites,
      ...requirementReferences(sites, context),
      ranges: [...ranges.values()],
      output_spans: [...spans.values()].sort((a, b) => a.start - b.start || a.end - b.end),
    });
  }
  return result;
}
