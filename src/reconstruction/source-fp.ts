import type { OperationContext, RegisterDescriptor } from '../core/index.js';
import { expressionOperands, type Expression } from '../ir/index.js';
import type { ControlArm, Region } from '../presentation/index.js';
import type { Reconstruction } from './model.js';
import { sourceRequirementPredicates } from './source-requirements.js';

export const SOURCE_FP_ENVIRONMENT =
  'Assume nearest-even rounding, gradual underflow and masked FP traps at every recorded operation/guard epoch, including after calls. FP status flags are not observed. Native C FP requires IEC 60559 storage, no excess precision or fast-math, and -ffp-contract=off. Original guards and unsupported exits remain in checked view and metadata; explicit environment writes retain guards.';

export interface SourceFpPresentation {
  readonly body: Region;
  readonly guards: ReadonlySet<string>;
  readonly expressions: ReadonlySet<Expression>;
}

/** A default environment is a precondition at each recorded epoch, not a fact
 * about arbitrary writes. Only entry state, call clobbers and their unchanged
 * transports qualify. A computed/loaded control state retains explicit guards. */
export function sourceFpPresentation(
  program: Reconstruction,
  context: OperationContext,
): SourceFpPresentation {
  const guards = new Set<string>(),
    expressions = new Set<Expression>();
  const unchanged = { body: program.function.body, guards, expressions };
  const validation = program.local_validation_session;
  if (program.view !== 'source' || !program.source || !validation) return unchanged;
  const literals: [string, Expression][] = [];
  for (const [id] of program.source.float_values ?? []) {
    context.checkpoint(1);
    const expression = program.expressions.get(id);
    if (expression?.kind === 'constant') literals.push([id, expression]);
  }
  if (
    literals.length &&
    validation.presentation(
      'fp_literal',
      program.function.id,
      'exact finite IEEE binary32/binary64 value spelled as a round-tripping decimal; no arithmetic or environment assumption; nonfinite payloads retain bit patterns',
      literals.map(([id]) => id).slice(0, 64),
    )
  )
    for (const [, expression] of literals) expressions.add(expression);
  if (!program.source.requirements?.some((item) => item.kind === 'fp_environment'))
    return unchanged;
  const predicates = sourceRequirementPredicates(program.source.requirements);
  const guardSubjects = new Set<string>();
  for (const { site } of predicates.values())
    for (const id of site.subject_ids) guardSubjects.add(id);
  const environment = (register: RegisterDescriptor): boolean =>
    register.root === 'arm64:fpcr' ||
    (register.root === 'x86_64:mxcsr' &&
      register.offset_bits < 16 &&
      register.offset_bits + register.width_bits > 6);
  const epochs = new Set<string>();
  const incoming = new Map<string, string[]>();
  const predecessors = new Map<string, number>();
  const arms = (region: Extract<Region, { kind: 'block' }>): readonly ControlArm[] => {
    const control = region.control;
    return control.kind === 'if'
      ? [control.when_true, control.when_false]
      : control.kind === 'switch'
        ? [...control.cases.map((item) => item.arm), control.otherwise]
        : [];
  };
  for (const binding of program.blocks.get(program.function.entry)!.register_entry)
    if (environment(binding.register)) epochs.add(binding.value.id);
  for (const block of program.blocks.values()) {
    context.checkpoint(1);
    for (const node of block.statements) {
      if (node.kind === 'write_register' && environment(node.register)) return unchanged;
      // Opaque instructions can write control state. Recognized guard failures
      // are the only opaque effects removed by the conditional presentation.
      if (
        node.kind === 'unknown_effect' &&
        node.register_outputs.some((binding) => environment(binding.register)) &&
        !guardSubjects.has(node.id)
      )
        return unchanged;
      if (node.kind === 'call')
        for (const binding of node.register_outputs)
          if (environment(binding.register)) epochs.add(binding.value.id);
    }
    for (const transfer of block.control.kind === 'jump'
      ? [block.control.transfer]
      : arms(block).map((arm) => arm.transfer)) {
      predecessors.set(transfer.target, (predecessors.get(transfer.target) ?? 0) + 1);
      for (const copy of transfer.copies) {
        const row = incoming.get(copy.destination.id) ?? [];
        row.push(copy.source.id);
        incoming.set(copy.destination.id, row);
      }
    }
  }
  const assumedEpoch = (id: string, active = new Set<string>()): boolean => {
    context.checkpoint(1);
    if (epochs.has(id)) return true;
    if (active.has(id) || active.size >= 128) return false;
    active.add(id);
    const expression = program.expressions.get(id);
    const parents =
      expression?.kind === 'cast' && expression.op === 'bitcast'
        ? [expression.value.id]
        : incoming.get(id);
    const accepted = !!parents?.length && parents.every((parent) => assumedEpoch(parent, active));
    active.delete(id);
    if (accepted) epochs.add(id);
    return accepted;
  };
  for (const { site } of predicates.values()) if (!assumedEpoch(site.state_epoch)) return unchanged;
  for (const block of program.blocks.values())
    for (const binding of block.register_exit)
      if (
        environment(binding.register) &&
        !assumedEpoch(binding.value.id) &&
        !guardSubjects.has(block.control.id)
      )
        return unchanged;
  const omitted = new Set<string>();
  const failureOnly = (region: Region | undefined, id: string): boolean =>
    !region ||
    (region.kind === 'block'
      ? region.id === id
      : region.kind === 'sequence' && region.regions.every((child) => failureOnly(child, id)));
  for (const block of program.blocks.values()) {
    const control = block.control;
    const requirement = predicates.get(control.id);
    if (control.kind !== 'if' || !requirement) continue;
    const no = requirement.site.supported_predicate_value ? control.when_false : control.when_true;
    if (predecessors.get(no.transfer.target) !== 1 || !failureOnly(no.body, no.transfer.target))
      continue;
    if (
      !validation.presentation(
        'fp_environment_guard',
        control.id,
        'exact lifter environment guard; unknown entry/call epoch, no explicit environment writer; unsupported arm is exclusively owned; supported edge and copies unchanged',
        requirement.site.subject_ids,
        `Conditional on ${requirement.requirement.id} at ${requirement.site.id}, epoch ${requirement.site.state_epoch}; original guard and failure remain in checked view and requirement metadata`,
      )
    )
      continue;
    guards.add(control.id);
    omitted.add(no.transfer.target);
  }
  const rewrite = (region: Region): Region => {
    context.checkpoint(1);
    if (region.kind === 'sequence') return { ...region, regions: region.regions.map(rewrite) };
    if (region.kind === 'loop') return { ...region, body: rewrite(region.body) };
    if (omitted.has(region.id)) return { kind: 'sequence', regions: [] };
    const control = region.control;
    const requirement = predicates.get(control.id);
    if (control.kind === 'if' && requirement && guards.has(control.id)) {
      const yes = requirement.site.supported_predicate_value
        ? control.when_true
        : control.when_false;
      const block: Region = {
        ...region,
        control: {
          kind: 'jump',
          id: control.id,
          provenance: control.provenance,
          effect: control.effect,
          transfer: yes.transfer,
        },
      };
      return yes.body ? { kind: 'sequence', regions: [block, rewrite(yes.body)] } : block;
    }
    const arm = (item: ControlArm): ControlArm =>
      item.body ? { ...item, body: rewrite(item.body) } : item;
    return control.kind === 'if'
      ? {
          ...region,
          control: {
            ...control,
            when_true: arm(control.when_true),
            when_false: arm(control.when_false),
          },
        }
      : control.kind === 'switch'
        ? {
            ...region,
            control: {
              ...control,
              cases: control.cases.map((item) => ({ ...item, arm: arm(item.arm) })),
              otherwise: arm(control.otherwise),
            },
          }
        : region;
  };
  const body = rewrite(program.function.body);
  // Any escape of arithmetic bits makes NaN payload canonicalization observable.
  // Propagate that restriction backwards through all pure computations and phi
  // transports. Float results and FP comparisons observe values, not payloads.
  const sensitive = new Set<string>(),
    pending: string[] = [];
  const mark = (id: string): void => {
    if (!sensitive.has(id)) {
      sensitive.add(id);
      pending.push(id);
    }
  };
  for (const block of program.blocks.values()) {
    for (const node of block.statements) {
      if (!program.retained.has(node.id)) continue;
      if (node.kind === 'store' || node.kind === 'write_register') mark(node.value.id);
    }
  }
  for (const bindings of [...program.physical_inputs.values(), ...program.physical_exits.values()])
    for (const binding of bindings) mark(binding.value.id);
  for (const boundary of [
    ...program.calls.values(),
    ...program.returns.values(),
    ...[...program.tails.values()].map((tail) => tail.boundary),
  ]) {
    for (const value of boundary.arguments) mark(value.id);
    for (const binding of [...boundary.inputs, ...boundary.outputs]) mark(binding.value.id);
    for (const value of boundary.results) if (value.type.kind !== 'float') mark(value.id);
  }
  for (const [id, expression] of program.expressions)
    if (
      program.live.has(id) &&
      expression.kind !== 'float' &&
      expression.kind !== 'float_unary' &&
      expression.kind !== 'float_compare' &&
      !(expression.kind === 'cast' && expression.op === 'bitcast') &&
      expression.kind !== 'select' &&
      !(
        expression.kind === 'cast' &&
        ['float_convert', 'signed_to_float', 'unsigned_to_float'].includes(expression.op)
      )
    )
      for (const value of expressionOperands(expression)) mark(value.id);
  for (let i = 0; i < pending.length; i++) {
    context.checkpoint(1);
    const id = pending[i]!;
    const expression = program.expressions.get(id);
    if (expression) for (const value of expressionOperands(expression)) mark(value.id);
    for (const parent of incoming.get(id) ?? []) mark(parent);
  }
  const sites = new Set(
    program.source.requirements
      ?.filter((item) => item.kind === 'fp_environment')
      .flatMap((item) => item.sites.flatMap((site) => site.subject_ids)),
  );
  const candidates: [string, Expression][] = [];
  for (const [id, expression] of program.expressions) {
    context.checkpoint(1);
    if (
      (expression.kind !== 'float_compare' && !program.source.float_values?.has(id)) ||
      expressionOperands(expression).some(
        (value) => value.type.kind === 'float' && !program.source!.float_values?.has(value.id),
      )
    )
      continue;
    if (!program.live.has(id) || !sites.has(id)) continue;
    if (
      (expression.kind === 'float_compare' &&
        ['eq', 'ne', 'lt', 'le', 'gt', 'ge'].includes(expression.op)) ||
      (!sensitive.has(id) &&
        ((expression.kind === 'float' && ['add', 'sub', 'mul', 'div'].includes(expression.op)) ||
          (expression.kind === 'cast' &&
            ['signed_to_float', 'unsigned_to_float', 'float_convert'].includes(expression.op))))
    )
      candidates.push([id, expression]);
  }
  if (
    candidates.length &&
    validation.presentation(
      'fp_native_operations',
      program.function.id,
      'typed IEEE scalar operations and exact finite literals under recorded per-site default environment; no payload-sensitive arithmetic consumers; float-to-integer, fused and exceptional-dialect operations retain helpers',
      candidates.map(([id]) => id).slice(0, 64),
    )
  ) {
    validation.requireAbi(
      'fp_native_operations',
      [program.function.id],
      'Native C arithmetic follows IEC 60559, including infinities and NaNs, in IEEE binary32/binary64 with no excess precision, no fast-math and FP contraction disabled (-ffp-contract=off). Source floating results are consumed as values, not inspected for arithmetic NaN payloads; local payload-sensitive consumers retain helpers. The recorded fp_environment requirement applies at every operation, including after calls.',
    );
    for (const [, expression] of candidates) expressions.add(expression);
  }
  return { body, guards, expressions };
}
