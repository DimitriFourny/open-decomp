import type { OperationContext, RegisterDescriptor } from '../core/index.js';
import { expressionOperands, type Expression, type Value } from '../ir/index.js';
import type { ControlArm, Region } from '../presentation/index.js';
import type { Reconstruction } from './model.js';
import { sourceRequirementPredicates } from './source-requirements.js';

export const SOURCE_FP_ENVIRONMENT =
  'Assume nearest-even rounding, gradual underflow and masked FP traps at every recorded operation/guard epoch, including after calls. FP status flags are not observed. Native C FP requires IEC 60559 storage, no excess precision or fast-math, and -ffp-contract=off. Original guards and unsupported exits remain in checked view and metadata; explicit environment writes retain guards.';

export interface SourceFpPresentation {
  readonly body: Region;
  /** The same presentation of another layout of the same blocks (guard ownership
   * is a CFG fact: the failure block is terminal and entered only by its guard). */
  readonly rewrite: (body: Region) => Region;
  readonly guards: ReadonlySet<string>;
  /** Unsupported-environment failure blocks of `guards`, not printed. */
  readonly omitted: ReadonlySet<string>;
  /** Call-clobber outputs whose only demand was an omitted guard condition. */
  readonly unobserved: ReadonlySet<string>;
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
    omitted = new Set<string>(),
    unobserved = new Set<string>(),
    expressions = new Set<Expression>();
  const unchanged = {
    body: program.function.body,
    rewrite: (body: Region) => body,
    guards,
    omitted,
    unobserved,
    expressions,
  };
  const validation = program.local_validation_session;
  if (program.view !== 'source' || !program.source || !validation) return unchanged;
  // Literals are the typed constants plus the integer-typed constants that join
  // an established FP value as bitcast operands, phi copies or select arms; each
  // prints as its exact IEEE value only where a float is expected.
  const literals = new Map<string, Expression>();
  const literal = (id: string): void => {
    const expression = program.expressions.get(id);
    if (expression?.kind === 'constant') literals.set(id, expression);
  };
  const floating = program.source.float_values;
  for (const [id] of floating ?? []) {
    context.checkpoint(1);
    literal(id);
    const expression = program.expressions.get(id);
    if (expression?.kind === 'cast' && expression.op === 'bitcast') literal(expression.value.id);
    if (expression?.kind === 'select') {
      literal(expression.when_true.id);
      literal(expression.when_false.id);
    }
  }
  for (const copies of program.transfers.values())
    for (const copy of copies) {
      context.checkpoint(1);
      if (floating?.has(copy.destination.id)) literal(copy.source.id);
    }
  // A literal stored to an FP slot local joins the component like a phi copy.
  if (program.source.float_locals?.size)
    for (const block of program.blocks.values())
      for (const node of block.statements) {
        context.checkpoint(1);
        const local = node.kind === 'store' ? program.source.locals.get(node.id) : undefined;
        if (node.kind === 'store' && local && program.source.float_locals.has(local.id))
          literal(node.value.id);
      }
  if (
    literals.size &&
    validation.presentation(
      'fp_literal',
      program.function.id,
      'exact finite IEEE binary32/binary64 value spelled as a round-tripping decimal; no arithmetic or environment assumption; nonfinite payloads retain bit patterns',
      [...literals.keys()].slice(0, 64),
    )
  )
    for (const expression of literals.values()) expressions.add(expression);
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
  // The last effect of a block that ends in an unresolved exit cannot change the
  // environment of any recorded operation: no modeled code executes after it.
  const terminalEffects = new Set<string>(),
    terminalBlocks = new Set<string>();
  for (const block of program.blocks.values()) {
    context.checkpoint(1);
    for (const [index, node] of block.statements.entries()) {
      if (node.kind === 'write_register' && environment(node.register)) return unchanged;
      // Opaque instructions can write control state. Recognized guard failures
      // are the only opaque effects removed by the conditional presentation.
      if (
        node.kind === 'unknown_effect' &&
        node.register_outputs.some((binding) => environment(binding.register)) &&
        !guardSubjects.has(node.id)
      ) {
        if (block.control.kind !== 'unknown' || index !== block.statements.length - 1)
          return unchanged;
        terminalEffects.add(node.id);
        terminalBlocks.add(block.id);
      }
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
        !guardSubjects.has(block.control.id) &&
        !terminalBlocks.has(block.id)
      )
        return unchanged;
  if (
    terminalEffects.size &&
    !validation.presentation(
      'fp_terminal_effect',
      program.function.id,
      'opaque effect that is the last statement of a block ending in an unresolved exit: no modeled operation or exit overlay executes after it, so its possible environment writes change no recorded epoch; the effect and the unresolved exit stay printed',
      [...terminalEffects].slice(0, 64),
    )
  )
    return unchanged;
  const terminal = (id: string): boolean => {
    const kind = program.blocks.get(id)?.control.kind;
    return kind !== undefined && kind !== 'jump' && kind !== 'if' && kind !== 'switch';
  };
  for (const block of program.blocks.values()) {
    const control = block.control;
    const requirement = predicates.get(control.id);
    if (control.kind !== 'if' || !requirement) continue;
    const no = requirement.site.supported_predicate_value ? control.when_false : control.when_true;
    if (predecessors.get(no.transfer.target) !== 1 || !terminal(no.transfer.target)) continue;
    // Only the planner's exact MXCSR guard tests the unsupported state.
    if (
      !validation.presentation(
        'fp_environment_guard',
        control.id,
        requirement.site.supported_predicate_value
          ? 'exact lifter environment guard; unknown entry/call epoch, no explicit environment writer; unsupported arm is exclusively owned; supported edge and copies unchanged'
          : 'exact lifter x86 MXCSR[6:16] guard (all exceptions masked, DAZ off, round to nearest, FTZ off); unknown entry/call epoch, no explicit MXCSR control writer (exception-status MXCSR[0:6] writes are disjoint); unsupported arm is exclusively owned; supported edge and copies unchanged',
        requirement.site.subject_ids,
        `Conditional on ${requirement.requirement.id} at ${requirement.site.id}, epoch ${requirement.site.state_epoch}; original guard and failure remain in checked view and requirement metadata`,
      )
    )
      continue;
    guards.add(control.id);
    omitted.add(no.transfer.target);
  }
  // An omitted guard no longer reads its condition. Values whose every demand
  // came through it are unobserved; a call clobber among them is not printed.
  if (guards.size) {
    const remaining = new Map<string, number>(),
      copies = new Map<string, Value[]>(),
      outputs = new Set<string>(),
      pending: Value[] = [];
    for (const row of program.transfers.values())
      for (const copy of row) {
        const list = copies.get(copy.destination.id) ?? [];
        list.push(copy.source);
        copies.set(copy.destination.id, list);
      }
    for (const boundary of program.calls.values())
      for (const binding of boundary.outputs) outputs.add(binding.value.id);
    const release = (value: Value): void => {
      const count = (remaining.get(value.id) ?? program.use_counts.get(value.id) ?? 0) - 1;
      remaining.set(value.id, count);
      if (count === 0) pending.push(value);
    };
    for (const block of program.blocks.values())
      if (block.control.kind === 'if' && guards.has(block.control.id))
        release(block.control.condition);
    for (let cursor = 0; cursor < pending.length; cursor++) {
      context.checkpoint(1);
      const value = pending[cursor]!,
        expression = program.expressions.get(value.id);
      if (outputs.has(value.id)) unobserved.add(value.id);
      if (expression) for (const operand of expressionOperands(expression)) release(operand);
      else for (const source of copies.get(value.id) ?? []) release(source);
    }
  }
  // An omitted failure block prints nothing: it leaves its sequence, so the
  // lexical first/last statement of a list (a loop's test position) is real.
  const rewrite = (region: Region): Region => {
    context.checkpoint(1);
    if (region.kind === 'sequence') {
      const regions = region.regions
        .map(rewrite)
        .filter((child) => child.kind !== 'sequence' || child.regions.length > 0);
      return regions.length === 1 ? regions[0]! : { ...region, regions };
    }
    if (region.kind === 'loop') return { ...region, body: rewrite(region.body) };
    if (omitted.has(region.id)) return { kind: 'sequence', regions: [] };
    const control = region.control;
    const requirement = predicates.get(control.id);
    if (control.kind === 'if' && requirement && guards.has(control.id)) {
      const [yes, no] = requirement.site.supported_predicate_value
        ? [control.when_true, control.when_false]
        : [control.when_false, control.when_true];
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
      // Blocks laid out after the failure block in its arm are entered by labels only.
      const regions = [block, ...[no.body, yes.body].flatMap((item) => (item ? [rewrite(item)] : []))]
        .filter((child) => child.kind !== 'sequence' || child.regions.length > 0);
      return regions.length === 1 ? block : { kind: 'sequence', regions };
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
  // A promoted local slot is private storage: its stores are as observable as
  // the loads that read it back, no more.
  const slotStores = new Map<string, string[]>();
  const slotOfLoad = new Map<string, string>();
  for (const block of program.blocks.values()) {
    for (const node of block.statements) {
      if (!program.retained.has(node.id)) continue;
      const local = program.source.locals.get(node.id);
      if (local && node.kind === 'store') {
        const row = slotStores.get(local.id) ?? [];
        row.push(node.value.id);
        slotStores.set(local.id, row);
      } else if (local && node.kind === 'load') slotOfLoad.set(node.result.id, local.id);
      else if (node.kind === 'store' || node.kind === 'write_register') mark(node.value.id);
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
  // Comparisons yield one bit of the value order and float-to-integer
  // conversions of a NaN are undefined: neither observes arithmetic payloads,
  // whatever consumes their results.
  const payloadFree = (expression: Expression): boolean =>
    expression.kind === 'float_compare' ||
    (expression.kind === 'cast' &&
      (expression.op === 'float_to_signed' || expression.op === 'float_to_unsigned'));
  for (const [id, expression] of program.expressions)
    if (
      program.live.has(id) &&
      expression.kind !== 'float' &&
      expression.kind !== 'float_unary' &&
      !payloadFree(expression) &&
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
    if (expression && !payloadFree(expression))
      for (const value of expressionOperands(expression)) mark(value.id);
    for (const parent of incoming.get(id) ?? []) mark(parent);
    const slot = slotOfLoad.get(id);
    if (slot) for (const stored of slotStores.get(slot) ?? []) mark(stored);
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
      (expression.kind !== 'float_compare' &&
        !(expression.kind === 'cast' && payloadFree(expression)) &&
        !program.source.float_values?.has(id)) ||
      expressionOperands(expression).some(
        (value) => value.type.kind === 'float' && !program.source!.float_values?.has(value.id),
      )
    )
      continue;
    if (!program.live.has(id)) continue;
    // A condition fold derives new relations of the same compared operands; it
    // is covered exactly when every compare it was derived from is a site.
    const origins = program.source.value_origins?.get(id) ?? [];
    const derived =
      expression.kind === 'float_compare' &&
      origins.length > 0 &&
      origins.every((origin) => {
        const source = program.expressions.get(origin);
        return (
          sites.has(origin) &&
          source?.kind === 'float_compare' &&
          ((source.left.id === expression.left.id && source.right.id === expression.right.id) ||
            (source.left.id === expression.right.id && source.right.id === expression.left.id))
        );
      });
    if (!sites.has(id) && !derived) continue;
    if (
      payloadFree(expression) ||
      // Negation and absolute value only change the sign bit, payload included.
      (expression.kind === 'float_unary' && expression.op !== 'sqrt') ||
      (!sensitive.has(id) &&
        ((expression.kind === 'float' && ['add', 'sub', 'mul', 'div'].includes(expression.op)) ||
          (expression.kind === 'float_unary' && expression.op === 'sqrt') ||
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
      'typed IEEE scalar operations (arithmetic, negation, absolute value, square root, comparisons, integer/float conversions) and exact finite literals under recorded per-site default environment; no payload-sensitive arithmetic consumers; fused and exceptional-dialect operations, vector operations and Python binary32/division/square-root/float-to-integer retain helpers',
      candidates.map(([id]) => id).slice(0, 64),
    )
  ) {
    validation.requireAbi(
      'fp_native_operations',
      [program.function.id],
      'Native C arithmetic follows IEC 60559, including infinities and NaNs, in IEEE binary32/binary64 with no excess precision, no fast-math and FP contraction disabled (-ffp-contract=off). Negation and absolute value change only the sign bit; float-to-integer conversion truncates toward zero and, as in the IR, is undefined for NaN, infinities and out-of-range values. Source floating results are consumed as values, not inspected for arithmetic NaN payloads; local payload-sensitive consumers retain helpers. The recorded fp_environment requirement applies at every operation, including after calls.',
    );
    for (const [, expression] of candidates) expressions.add(expression);
  }
  return { body, rewrite, guards, omitted, unobserved, expressions };
}
