import {
  fingerprint,
  OperationError,
  type AbiProfile,
  type Evidence,
  type FunctionRecord,
  type Lifter,
  type LoadedImage,
  type OperationContext,
  type ReferenceRecord,
} from '../../core/index.js';
import { constructSSA } from '../../analysis/ssa/index.js';
import { abiObservableRegisterMasks } from '../../analysis/ssa/observable-masks.js';
import { simplifySSA } from '../../analysis/values/index.js';
import {
  recoverTypes,
  type SuppliedTypeRecord,
  type TypeRecoveryResult,
} from '../../analysis/types/index.js';
import { observePreparedCallInterfaces } from '../../analysis/calls/observed.js';
import {
  createCallResultDemandIndex,
  observeCallResultDemands,
  type CallResultDemandIndex,
} from '../../analysis/calls/result-demands.js';
import type { CallAnalysisResult, SuppliedCallContract } from '../../analysis/calls/index.js';
import { analyzeCalls } from '../../analysis/calls/index.js';
import type { RegisterIR, SSAForm, Value } from '../../ir/index.js';
import type { DebugRecovery } from '../../metadata/debug/index.js';
import type { LibraryContracts } from '../../metadata/library-contracts/index.js';
import type { InferredCallee } from '../../reconstruction/source-model.js';
import { sourceConstantValues } from '../../reconstruction/source-data.js';
import { loadFunctionGraph } from '../queries/scope.js';
import type { AnalysisScope } from './index.js';
import {
  applyEnvironmentWriters,
  callDeclarations,
  nativeCallIndex,
  resolveCalls,
} from './calls.js';
import { boundIR, requirePass } from './passes.js';
import type { NativeDependency, NativeInterface, NativeSummaryUnit } from './native-worklist.js';
import { nativeRegisterPrefix } from './native-register-prefix.js';
import { parameterRegisters } from './native-abi.js';
import { nativeCallContext, type NativeContext } from './native-context.js';
import { nativeAnnotations } from './native-annotations.js';
import type { AnalysisReadset } from '../../project/cache/dependencies.js';
import { createNativeInterfaceIndex, type NativeInterfaceIndex } from './native-entry.js';
import { nativeVariadicFootprint, type NativeVariadicFootprint } from './native-variadic.js';

export interface NativePreparationInput {
  readonly scope: AnalysisScope;
  readonly image: LoadedImage;
  readonly revision: number;
  readonly functions: readonly FunctionRecord[];
  readonly references: readonly ReferenceRecord[];
  readonly debug: DebugRecovery;
  readonly library: LibraryContracts;
  readonly native_types: readonly SuppliedTypeRecord[];
  readonly components: { readonly abi: AbiProfile; readonly lifter: Lifter<RegisterIR> };
  readonly observable_register_masks?: ReadonlyMap<string, bigint>;
}
export interface PreparedNativeUnit extends NativeSummaryUnit {
  readonly ir: SSAForm | null;
  readonly types: TypeRecoveryResult | null;
  readonly analysis: CallAnalysisResult | null;
  readonly observed_calls: readonly InferredCallee[];
  /** An allowance-derived work limit stopped part of this preparation: the SSA
   * limit, the optional type/stack or physical call/stack limit, or the local limit
   * reached anywhere inside an optional stage (also where a nested pass turned it
   * into a partial result, as structuring does in the variadic footprint). The unit
   * then depends on the allowance it was prepared under and is never retained. */
  readonly limited: boolean;
  readonly entry_prefix?: NativeInterface;
  readonly context_assumptions?: NativeContext;
  /** On a context unit: the context-free result of the baseline body, proven on
   * every baseline exit (`prepareNativeContext`). The context's exits are a
   * subset, so its storage classification holds for them too
   * (`inheritGenericResult` in `observeNativeUnit`). Never persisted: context
   * units are rebuilt from their baseline. */
  readonly generic_result?: Pick<NativeInterface, 'returns' | 'return_types' | 'written_result'>;
  readonly dependency_readset?: AnalysisReadset;
  readonly demand_index?: CallResultDemandIndex;
  readonly interface_index?: NativeInterfaceIndex;
  /** The body's `va_start` footprint (`nativeVariadicFootprint`), when classified. */
  readonly variadic?: NativeVariadicFootprint;
}

/** Resolve exact direct calls and discovery-established direct tails only. The
 * graph loader remains intraprocedural; this list drives the separate worklist. */
export function nativeDependencies(
  input: Pick<
    NativePreparationInput,
    'image' | 'functions' | 'references' | 'components' | 'scope' | 'revision' | 'native_types'
  >,
  ir: RegisterIR | SSAForm,
  context: OperationContext,
  knownConstants?: ReadonlyMap<string, bigint>,
  recoverContexts = true,
  demandIndex?: CallResultDemandIndex,
): readonly NativeDependency[] {
  const index = nativeCallIndex(input.image, input.functions, input.references, context);
  const demand =
    ir.form === 'ssa'
      ? observeCallResultDemands(ir, input.components.abi, context, [], demandIndex)
      : undefined;
  const result: NativeDependency[] = [];
  const definitions = new Map(
    ir.blocks.flatMap((block) =>
      block.instructions.flatMap((node) =>
        node.kind === 'assign' ? [[node.result.id, node.expression] as const] : [],
      ),
    ),
  );
  const sourceConstant = sourceConstantValues(definitions, context, input.image.id);
  const constant = (value: Value) => knownConstants?.get(value.id) ?? sourceConstant(value);
  // Content-derived, like every entity and evidence ID: the project is named by its
  // bytes and slice, never by its random project ID (which made context evidence IDs,
  // and the emitter's reference interning and work, differ between equal projects).
  const scope = fingerprint([
    input.image.selected_slice_id,
    input.revision,
    input.image.sha256,
    input.native_types.map((record) => [record.id, record.status, record.evidence_ids]),
  ]);
  const callerProofs = input.functions.find((fn) => fn.id === ir.id)?.evidence_ids ?? [];
  const states =
    ir.form === 'ssa'
      ? new Map(ir.register_states.map((state) => [state.block, state]))
      : new Map();
  for (const block of ir.blocks) {
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (node.kind !== 'call') continue;
      const value = node.target.kind === 'indirect' ? constant(node.target.value) : undefined;
      const address =
        node.target.kind === 'direct'
          ? node.target.address
          : value !== undefined
            ? { image_id: input.image.id, space: 'va' as const, value }
            : undefined;
      if (!address) continue;
      const key = `${address.image_id}:${address.space}:${address.value}`;
      if (index.imports_by_address.has(key)) continue;
      const targets = index.functions_by_address.get(key) ?? [];
      input.scope.dependencies?.recordFunctionQuery(input.image.id, address, targets);
      for (const target of targets)
        input.scope.dependencies?.recordFunction(input.image.id, target.id, target);
      if (targets.length === 1) {
        const assumptions = recoverContexts
          ? nativeCallContext(
              node.register_inputs,
              parameterRegisters(input.components.abi),
              definitions,
              scope,
              context,
              input.image.id,
              knownConstants,
            )
          : undefined;
        result.push({
          call_id: node.id,
          target: targets[0]!,
          return_demand: demand?.all.get(node.id) ?? [],
          return_demand_semantic: demand?.semantic.get(node.id) ?? [],
          evidence_ids: [...new Set([...callerProofs, ...node.provenance.evidence_ids])],
          original_subject_ids: [ir.id, node.id, ...node.provenance.instruction_ids],
          ...(assumptions ? { assumptions } : {}),
        });
      }
    }
    const control = block.terminator;
    if (control.kind !== 'indirect' || !control.tail_call) continue;
    const target = constant(control.target);
    if (target === undefined) continue;
    const key = `${input.image.id}:va:${target}`;
    if (index.imports_by_address.has(key)) continue;
    const targets = index.functions_by_address.get(key) ?? [];
    input.scope.dependencies?.recordFunctionQuery(
      input.image.id,
      { image_id: input.image.id, space: 'va', value: target },
      targets,
    );
    for (const fn of targets) input.scope.dependencies?.recordFunction(input.image.id, fn.id, fn);
    if (targets.length === 1) {
      const assumptions = recoverContexts
        ? nativeCallContext(
            states.get(block.id)?.exit ?? [],
            parameterRegisters(input.components.abi),
            definitions,
            scope,
            context,
            input.image.id,
            knownConstants,
          )
        : undefined;
      result.push({
        call_id: control.id,
        target: targets[0]!,
        evidence_ids: [...new Set([...callerProofs, ...control.provenance.evidence_ids])],
        original_subject_ids: [ir.id, control.id, ...control.provenance.instruction_ids],
        ...(assumptions ? { assumptions } : {}),
      });
    }
  }
  return result;
}

/** The graph and lift of one body (`liftNativeUnit`). No limit of its own is set from
 * the allowance, so it is the same value, with the same work and reads, under every
 * allowance and capacity that affords it. */
export interface NativeLift {
  readonly base: Pick<
    PreparedNativeUnit,
    'function' | 'instructions' | 'blocks' | 'evidence' | 'evidence_ids' | 'budget_truncated'
  >;
  /** The graph's coverage reasons. */
  readonly reasons: readonly string[];
  /** Absent for an empty graph. */
  readonly lifted?: {
    /** With environment writers applied. */
    readonly ir: RegisterIR;
    readonly nodes: number;
    readonly entry_prefix: NativeInterface;
  };
}
/** The lifted body in SSA, constructed, simplified and verified within its work limit. */
export interface NativeSSA {
  readonly ir: SSAForm;
  readonly nodes: number;
  /** Peak nodes over the lift and every SSA stage. */
  readonly required_nodes: number;
}
/** SSA stopped at its work limit `limit`, having needed `required_nodes` until then. */
export interface NativeSSALimit {
  readonly limit: number;
  readonly required_nodes: number;
}
/** The allowance-independent prefix of `prepareNativeUnit`: graph, lift, entry prefix
 * and SSA. Only the SSA limit derives from the allowance, and a limit only stops work:
 * an SSA that completed with work W under its limit returns the same IR, with the same
 * work, under every limit of at least W. */
export interface NativePrefix {
  readonly lift: NativeLift;
  /** Absent for an empty graph. */
  readonly ssa?: NativeSSA | NativeSSALimit;
}

/** Load and lift one body. */
export function liftNativeUnit(
  input: NativePreparationInput,
  fn: FunctionRecord,
  context: OperationContext,
): NativeLift {
  const { image, revision, components, scope } = input,
    abi = components.abi;
  input.scope.dependencies?.recordFunction(input.image.id, fn.id, fn);
  const graph = loadFunctionGraph({ ...scope, context }, revision, { image, function: fn });
  const evidence: readonly Evidence[] = graph.evidence ?? [];
  const base = {
    function: fn,
    instructions: graph.instructions.length,
    blocks: graph.blocks.length,
    evidence,
    evidence_ids: graph.function.evidence_ids,
    budget_truncated: graph.gaps.some((gap) => gap.reason === 'budget'),
  };
  const reasons = graph.coverage.reasons;
  if (!graph.instructions.length || !graph.blocks.length) return { base, reasons };
  const lifted = components.lifter.lift(graph, abi, context);
  const ir = applyEnvironmentWriters(
    lifted.ir,
    image,
    input.functions,
    input.references,
    abi,
    context,
  );
  const nodes = boundIR(ir, context);
  const entry_prefix = nativeRegisterPrefix(ir, parameterRegisters(abi), context);
  return { base, reasons, lifted: { ir, nodes, entry_prefix } };
}

/** The SSA work limit a preparation sets on `context` after the lift: 3/4 of what remains. */
export function nativeSSALimit(context: OperationContext): number {
  return Math.floor(((context.remainingWork?.() ?? context.budget.work) * 3) / 4);
}

/** SSA of a lifted body under `nativeSSALimit(context)`; reaching that limit is a result. */
export function nativeSSA(
  input: NativePreparationInput,
  fn: FunctionRecord,
  lifted: NonNullable<NativeLift['lifted']>,
  context: OperationContext,
): NativeSSA | NativeSSALimit {
  const abi = input.components.abi;
  let requiredNodes = lifted.nodes;
  const ssaLimit = nativeSSALimit(context);
  let ssaWork = 0;
  const ssaContext: OperationContext = {
    ...context,
    budget: { ...context.budget, work: ssaLimit },
    remainingWork: () => Math.max(0, ssaLimit - ssaWork),
    // Parent charges check cancellation/deadline first; the extra parent check is
    // needed only before throwing the local limit (one parent call per charge).
    checkpoint(work) {
      if (ssaWork + work > ssaLimit) {
        context.checkpoint(0);
        throw new OperationError({
          code: 'resource_limit',
          severity: 'warning',
          message: 'Native dependency SSA preparation work limit exceeded',
          evidence_ids: fn.evidence_ids,
          details: { kind: 'limit', resource: 'work', limit: ssaLimit, consumed: ssaWork + work },
        });
      }
      context.checkpoint(work);
      ssaWork += work;
    },
  };
  const passOptions = {
    max_work: ssaLimit,
    max_ir_nodes: context.budget.ir_nodes,
    max_blocks: context.budget.blocks,
    checkpoint: (work: number) => ssaContext.checkpoint(work),
  };
  try {
    const constructed = constructSSA(lifted.ir, {
      ...passOptions,
      observable_register_masks:
        input.observable_register_masks ?? abiObservableRegisterMasks(abi, ssaContext),
    });
    requirePass(constructed.state, constructed.diagnostics, ssaContext);
    if (constructed.value.form !== 'ssa')
      throw new OperationError({
        code: 'internal_error',
        severity: 'error',
        message: 'Native dependency preparation did not produce SSA',
        evidence_ids: fn.evidence_ids,
      });
    requiredNodes = Math.max(requiredNodes, boundIR(constructed.value, ssaContext));
    const simplified = simplifySSA(constructed.value, passOptions);
    requirePass(simplified.state, simplified.diagnostics, ssaContext);
    const ir = simplified.value;
    const nodes = boundIR(ir, ssaContext);
    return { ir, nodes, required_nodes: Math.max(requiredNodes, nodes) };
  } catch (error) {
    const details = error instanceof OperationError ? error.diagnostic.details : undefined;
    if (
      !(error instanceof OperationError) ||
      error.code !== 'resource_limit' ||
      details?.kind !== 'limit' ||
      details.resource !== 'work' ||
      details.limit > ssaLimit
    )
      throw error;
    context.checkpoint(0);
    return { limit: details.limit, required_nodes: requiredNodes };
  }
}

/** Lift one body and build its SSA. */
export function prepareNativePrefix(
  input: NativePreparationInput,
  fn: FunctionRecord,
  context: OperationContext,
): NativePrefix {
  const lift = liftNativeUnit(input, fn, context);
  return lift.lifted ? { lift, ssa: nativeSSA(input, fn, lift.lifted, context) } : { lift };
}

/** Prepare one body once, from its `prefix` when the caller has it. Optional source
 * type/stack recovery has its own local work allowance, leaving room for useful
 * SSA-backed prefix/return observations and dependency refinement if that expensive
 * optional stage is incomplete. */
export function prepareNativeUnit(
  input: NativePreparationInput,
  fn: FunctionRecord,
  context: OperationContext,
  libraryContracts: readonly SuppliedCallContract[],
  prefix: NativePrefix = prepareNativePrefix(input, fn, context),
): PreparedNativeUnit {
  const { image, revision, components } = input,
    abi = components.abi;
  const { base, reasons: coverageReasons, lifted } = prefix.lift;
  const ssa = prefix.ssa;
  if (!lifted || !ssa)
    return {
      ...base,
      nodes: 0,
      required_nodes: 0,
      dependencies: [],
      ir: null,
      types: null,
      analysis: null,
      observed_calls: [],
      reasons: coverageReasons,
      limited: false,
    };
  const liftedIR = lifted.ir,
    entry_prefix = lifted.entry_prefix;
  if (!('ir' in ssa))
    return {
      ...base,
      blocks: Math.max(base.blocks, liftedIR.blocks.length),
      nodes: lifted.nodes,
      required_nodes: ssa.required_nodes,
      ir: null,
      types: null,
      analysis: null,
      observed_calls: [],
      entry_prefix,
      dependencies: nativeDependencies(input, liftedIR, context),
      reasons: [...coverageReasons, `native SSA preparation work limit (${ssa.limit})`],
      limited: true,
    };
  const { ir, nodes, required_nodes: requiredNodes } = ssa;
  // Set whenever a preparation limit throws, even where a nested pass catches it.
  let limited = false;
  const calls = resolveCalls(ir, image, input.functions, input.references, false, context);
  const declarations = callDeclarations(
    ir,
    image,
    revision,
    calls,
    input.debug,
    [],
    input.native_types,
    context,
    abi.layout,
  );
  const workLimit = Math.floor((context.remainingWork?.() ?? context.budget.work) / 4);
  let used = 0;
  const local: OperationContext = {
    ...context,
    budget: { ...context.budget, work: workLimit },
    remainingWork: () => Math.max(0, workLimit - used),
    checkpoint(work) {
      if (used + work > workLimit) {
        context.checkpoint(0);
        limited = true;
        throw new OperationError({
          code: 'resource_limit',
          severity: 'warning',
          message: 'Native dependency optional type/stack work limit exceeded',
          evidence_ids: fn.evidence_ids,
          details: { kind: 'limit', resource: 'work', limit: workLimit, consumed: used + work },
        });
      }
      context.checkpoint(work);
      used += work;
    },
  };
  let types: TypeRecoveryResult | null = null;
  const reasons: string[] = [...coverageReasons];
  try {
    types = recoverTypes(ir, abi, local, {
      image_id: image.id,
      slice_id: image.selected_slice_id,
      revision,
      entry_address: fn.entry,
      debug: input.debug,
      library: input.library,
      max_work: workLimit,
      types: input.native_types,
      signatures: declarations.signatures,
      contracts: [...libraryContracts, ...declarations.contracts],
      resolutions: calls.resolutions,
    });
    const failure = types.diagnostics.find(
      (diagnostic) => diagnostic.code === 'cancelled' || diagnostic.code === 'resource_limit',
    );
    if (failure) throw new OperationError(failure);
    const active = nativeAnnotations(input, ir, types, calls, local);
    if (active.annotations.length || active.types.length !== input.native_types.length) {
      types = recoverTypes(ir, abi, local, {
        image_id: image.id,
        slice_id: image.selected_slice_id,
        revision,
        entry_address: fn.entry,
        debug: input.debug,
        library: input.library,
        max_work: local.remainingWork?.() ?? 0,
        types: active.types,
        annotations: active.annotations,
        signatures: active.declarations.signatures,
        contracts: [...libraryContracts, ...active.declarations.contracts],
        resolutions: calls.resolutions,
      });
      const failure = types.diagnostics.find(
        (item) => item.code === 'cancelled' || item.code === 'resource_limit',
      );
      if (failure) throw new OperationError(failure);
    }
    if (types.state !== 'complete')
      reasons.push(
        `native optional type/stack semantics incomplete: ${types.diagnostics[0]?.message ?? 'no complete type representation'}`,
      );
  } catch (error) {
    const details = error instanceof OperationError ? error.diagnostic.details : undefined;
    if (
      !(error instanceof OperationError) ||
      error.code !== 'resource_limit' ||
      details?.kind !== 'limit' ||
      details.resource !== 'work' ||
      details.limit > workLimit
    )
      throw error;
    context.checkpoint(0);
    limited = true;
    reasons.push(`native optional type/stack work limit (${workLimit})`);
    types = null;
  }
  let analysis = types?.calls ?? null;
  if (!analysis) {
    try {
      analysis = analyzeCalls(ir, abi, local, {
        max_work: local.remainingWork?.() ?? 0,
        contracts: [...libraryContracts, ...declarations.contracts],
        resolutions: calls.resolutions,
      });
      const failure = analysis.diagnostics.find(
        (diagnostic) => diagnostic.code === 'cancelled' || diagnostic.code === 'resource_limit',
      );
      if (failure) throw new OperationError(failure);
    } catch (error) {
      const details = error instanceof OperationError ? error.diagnostic.details : undefined;
      if (
        !(error instanceof OperationError) ||
        error.code !== 'resource_limit' ||
        details?.kind !== 'limit' ||
        details.resource !== 'work' ||
        details.limit > workLimit
      )
        throw error;
      context.checkpoint(0);
      limited = true;
      reasons.push(`native physical call/stack work limit (${details.limit})`);
      analysis = null;
    }
  }
  // Optional too: a footprint the local allowance (or a reconstruction bound)
  // cannot afford stays unknown, and the body keeps its physical interface. The
  // footprint sees no remaining-work figure, so no limit inside it (structuring,
  // the local validation allowance) derives from the allowance: only the local
  // limit can stop it, and that marks the unit limited.
  let variadic: NativeVariadicFootprint | null = null;
  try {
    if (!base.budget_truncated) {
      const { remainingWork: _hidden, ...footprint } = local;
      variadic = nativeVariadicFootprint(ir, types, abi, analysis, footprint);
    }
  } catch (error) {
    const details = error instanceof OperationError ? error.diagnostic.details : undefined;
    if (
      !(error instanceof OperationError) ||
      error.code !== 'resource_limit' ||
      (details?.kind === 'limit' && details.limit > workLimit)
    )
      throw error;
    context.checkpoint(0);
    limited = true;
  }
  const demand_index = createCallResultDemandIndex(ir, abi, context);
  const interface_index = createNativeInterfaceIndex(ir, abi, context);
  const observed_calls = observePreparedCallInterfaces(ir, abi, analysis, context, demand_index);
  const dependencies = nativeDependencies(input, ir, context, undefined, true, demand_index);
  return {
    ...base,
    blocks: Math.max(base.blocks, liftedIR.blocks.length, ir.blocks.length),
    nodes,
    required_nodes: requiredNodes,
    ir,
    types,
    analysis,
    observed_calls,
    dependencies,
    reasons,
    limited,
    arity_complete:
      // A limit may have cut the footprint stage, which can hide a `...`.
      !limited &&
      // Discovery reports an indirect call as unresolved control flow, but the
      // call returns and the lifted graph is still complete. Unknown and
      // non-tail indirect terminators (other than the lifter's conditional FP
      // environment guard failures) make the observed interface ambiguous, so
      // they never close an argument list.
      coverageReasons.every((reason) => reason === 'unresolved control flow') &&
      analysis?.state === 'complete' &&
      analysis.stack.state === 'complete',
    demand_index,
    interface_index,
    ...(variadic ? { variadic } : {}),
  };
}
