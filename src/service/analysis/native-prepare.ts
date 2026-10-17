import { fingerprint, OperationError, type AbiProfile, type Evidence, type FunctionRecord, type Lifter, type LoadedImage, type OperationContext, type ReferenceRecord } from '../../core/index.js';
import { constructSSA } from '../../analysis/ssa/index.js';
import { simplifySSA } from '../../analysis/values/index.js';
import { recoverTypes, type SuppliedTypeRecord, type TypeRecoveryResult } from '../../analysis/types/index.js';
import { observePreparedCallInterfaces } from '../../analysis/calls/observed.js';
import { createCallResultDemandIndex, observeCallResultDemands, type CallResultDemandIndex } from '../../analysis/calls/result-demands.js';
import type { CallAnalysisResult, SuppliedCallContract } from '../../analysis/calls/index.js';
import { analyzeCalls } from '../../analysis/calls/index.js';
import type { RegisterIR, SSAForm, Value } from '../../ir/index.js';
import type { DebugRecovery } from '../../metadata/debug/index.js';
import type { LibraryContracts } from '../../metadata/library-contracts/index.js';
import type { InferredCallee } from '../../reconstruction/source-model.js';
import { sourceConstantValues } from '../../reconstruction/source-data.js';
import { loadFunctionGraph } from '../queries/scope.js';
import type { AnalysisScope } from './index.js';
import { callDeclarations, nativeCallIndex, resolveCalls } from './calls.js';
import { boundIR, requirePass } from './passes.js';
import type { NativeDependency, NativeInterface, NativeSummaryUnit } from './native-worklist.js';
import { nativeRegisterPrefix } from './native-register-prefix.js';
import { parameterRegisters } from './native-abi.js';
import { nativeCallContext, type NativeContext } from './native-context.js';
import { nativeAnnotations } from './native-annotations.js';
import type { AnalysisReadset } from '../../project/cache/dependencies.js';

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
}
export interface PreparedNativeUnit extends NativeSummaryUnit {
  readonly ir: SSAForm | null;
  readonly types: TypeRecoveryResult | null;
  readonly analysis: CallAnalysisResult | null;
  readonly observed_calls: readonly InferredCallee[];
  readonly entry_prefix?: NativeInterface;
  readonly context_assumptions?: NativeContext;
  readonly dependency_readset?: AnalysisReadset;
  readonly demand_index?: CallResultDemandIndex;
}

/** Resolve exact direct calls and discovery-established direct tails only. The
 * graph loader remains intraprocedural; this list drives the separate worklist. */
export function nativeDependencies(
  input: Pick<NativePreparationInput, 'image' | 'functions' | 'references' | 'components' | 'scope' | 'revision' | 'native_types'>,
  ir: RegisterIR | SSAForm,
  context: OperationContext,
  knownConstants?: ReadonlyMap<string, bigint>,
  recoverContexts = true,
  demandIndex?: CallResultDemandIndex,
): readonly NativeDependency[] {
  const index = nativeCallIndex(input.image, input.functions, input.references, context);
  const demand = ir.form === 'ssa' ? observeCallResultDemands(ir, input.components.abi, context, [], demandIndex) : new Map();
  const result: NativeDependency[] = [];
  const definitions = new Map(ir.blocks.flatMap((block) => block.instructions.flatMap((node) =>
    node.kind === 'assign' ? [[node.result.id, node.expression] as const] : [])));
  const sourceConstant = sourceConstantValues(definitions, context, input.image.id);
  const constant = (value: Value) => knownConstants?.get(value.id) ?? sourceConstant(value);
  const scope = fingerprint([input.scope.store.project_id, input.revision, input.image.sha256,
    input.native_types.map((record) => [record.id, record.status, record.evidence_ids])]);
  const callerProofs = input.functions.find((fn) => fn.id === ir.id)?.evidence_ids ?? [];
  const states = ir.form === 'ssa' ? new Map(ir.register_states.map((state) => [state.block, state])) : new Map();
  for (const block of ir.blocks) {
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (node.kind !== 'call') continue;
      const value = node.target.kind === 'indirect' ? constant(node.target.value) : undefined;
      const address = node.target.kind === 'direct' ? node.target.address : value !== undefined
        ? { image_id: input.image.id, space: 'va' as const, value } : undefined;
      if (!address) continue;
      const key = `${address.image_id}:${address.space}:${address.value}`;
      if (index.imports_by_address.has(key)) continue;
      const targets = index.functions_by_address.get(key) ?? [];
      input.scope.dependencies?.recordFunctionQuery(input.image.id, address, targets);
      for (const target of targets) input.scope.dependencies?.recordFunction(input.image.id, target.id, target);
      if (targets.length === 1) {
        const assumptions = recoverContexts ? nativeCallContext(node.register_inputs, parameterRegisters(input.components.abi),
          definitions, scope, context, input.image.id, knownConstants) : undefined;
        result.push({ call_id: node.id, target: targets[0]!, return_demand: demand.get(node.id) ?? [],
          evidence_ids: [...new Set([...callerProofs, ...node.provenance.evidence_ids])],
          original_subject_ids: [ir.id, node.id, ...node.provenance.instruction_ids],
          ...(assumptions ? { assumptions } : {}) });
      }
    }
    const control = block.terminator;
    if (control.kind !== 'indirect' || !control.tail_call) continue;
    const target = constant(control.target);
    if (target === undefined) continue;
    const key = `${input.image.id}:va:${target}`;
    if (index.imports_by_address.has(key)) continue;
    const targets = index.functions_by_address.get(key) ?? [];
    input.scope.dependencies?.recordFunctionQuery(input.image.id, { image_id: input.image.id, space: 'va', value: target }, targets);
    for (const fn of targets) input.scope.dependencies?.recordFunction(input.image.id, fn.id, fn);
    if (targets.length === 1) {
      const assumptions = recoverContexts ? nativeCallContext(states.get(block.id)?.exit ?? [], parameterRegisters(input.components.abi),
        definitions, scope, context, input.image.id, knownConstants) : undefined;
      result.push({ call_id: control.id, target: targets[0]!,
        evidence_ids: [...new Set([...callerProofs, ...control.provenance.evidence_ids])],
        original_subject_ids: [ir.id, control.id, ...control.provenance.instruction_ids],
        ...(assumptions ? { assumptions } : {}) });
    }
  }
  return result;
}

/** Prepare one body once. Optional source type/stack recovery has its own local
 * work allowance, leaving room for useful SSA-backed prefix/return observations
 * and dependency refinement if that expensive optional stage is incomplete. */
export function prepareNativeUnit(
  input: NativePreparationInput,
  fn: FunctionRecord,
  context: OperationContext,
  libraryContracts: readonly SuppliedCallContract[],
): PreparedNativeUnit {
  const { image, revision, components, scope } = input, abi = components.abi;
  input.scope.dependencies?.recordFunction(input.image.id, fn.id, fn);
  const graph = loadFunctionGraph({ ...scope, context }, revision, { image, function: fn });
  const evidence: readonly Evidence[] = graph.evidence ?? [];
  const base = { function: fn, instructions: graph.instructions.length, blocks: graph.blocks.length,
    evidence, evidence_ids: graph.function.evidence_ids,
    budget_truncated: graph.gaps.some((gap) => gap.reason === 'budget') };
  if (!graph.instructions.length || !graph.blocks.length) return { ...base, nodes: 0, required_nodes: 0,
    dependencies: [], ir: null, types: null, analysis: null, observed_calls: [], reasons: graph.coverage.reasons };
  const lifted = components.lifter.lift(graph, abi, context);
  const liftedNodes = boundIR(lifted.ir, context);
  const entry_prefix = nativeRegisterPrefix(lifted.ir, parameterRegisters(abi), context);
  let requiredNodes = liftedNodes, ir: SSAForm, nodes: number;
  const ssaLimit = Math.floor((context.remainingWork?.() ?? context.budget.work) * 3 / 4);
  let ssaWork = 0;
  const ssaContext: OperationContext = { ...context, budget: { ...context.budget, work: ssaLimit },
    remainingWork: () => Math.max(0, ssaLimit - ssaWork),
    checkpoint(work) {
      context.checkpoint(0);
      if (ssaWork + work > ssaLimit) throw new OperationError({ code: 'resource_limit', severity: 'warning',
        message: 'Native dependency SSA preparation work limit exceeded', evidence_ids: fn.evidence_ids,
        details: { kind: 'limit', resource: 'work', limit: ssaLimit, consumed: ssaWork + work } });
      context.checkpoint(work); ssaWork += work;
    },
  };
  const passOptions = { max_work: ssaLimit, max_ir_nodes: context.budget.ir_nodes,
    max_blocks: context.budget.blocks, checkpoint: (work: number) => ssaContext.checkpoint(work) };
  try {
    const constructed = constructSSA(lifted.ir, passOptions);
    requirePass(constructed.state, constructed.diagnostics, ssaContext);
    if (constructed.value.form !== 'ssa') throw new OperationError({ code: 'internal_error', severity: 'error',
      message: 'Native dependency preparation did not produce SSA', evidence_ids: fn.evidence_ids });
    requiredNodes = Math.max(requiredNodes, boundIR(constructed.value, ssaContext));
    const simplified = simplifySSA(constructed.value, passOptions);
    requirePass(simplified.state, simplified.diagnostics, ssaContext);
    ir = simplified.value;
    nodes = boundIR(ir, ssaContext);
    requiredNodes = Math.max(requiredNodes, nodes);
  } catch (error) {
    const details = error instanceof OperationError ? error.diagnostic.details : undefined;
    if (!(error instanceof OperationError) || error.code !== 'resource_limit' || details?.kind !== 'limit' ||
      details.resource !== 'work' || details.limit > ssaLimit) throw error;
    context.checkpoint(0);
    return { ...base, blocks: Math.max(base.blocks, lifted.ir.blocks.length),
      nodes: liftedNodes, required_nodes: requiredNodes, ir: null,
      types: null, analysis: null, observed_calls: [], entry_prefix,
      dependencies: nativeDependencies(input, lifted.ir, context),
      reasons: [...graph.coverage.reasons, `native SSA preparation work limit (${details.limit})`] };
  }
  const calls = resolveCalls(ir, image, input.functions, input.references, false, context);
  const declarations = callDeclarations(ir, image, revision, calls, input.debug, [], input.native_types, context, abi.layout);
  const workLimit = Math.floor((context.remainingWork?.() ?? context.budget.work) / 4);
  let used = 0;
  const local: OperationContext = { ...context, budget: { ...context.budget, work: workLimit },
    remainingWork: () => Math.max(0, workLimit - used),
    checkpoint(work) {
      context.checkpoint(0);
      if (used + work > workLimit) throw new OperationError({ code: 'resource_limit', severity: 'warning',
        message: 'Native dependency optional type/stack work limit exceeded', evidence_ids: fn.evidence_ids,
        details: { kind: 'limit', resource: 'work', limit: workLimit, consumed: used + work } });
      context.checkpoint(work); used += work;
    } };
  let types: TypeRecoveryResult | null = null;
  const reasons: string[] = [...graph.coverage.reasons];
  try {
    types = recoverTypes(ir, abi, local, { image_id: image.id, slice_id: image.selected_slice_id, revision,
      entry_address: fn.entry, debug: input.debug, library: input.library, max_work: workLimit,
      types: input.native_types, signatures: declarations.signatures,
      contracts: [...libraryContracts, ...declarations.contracts], resolutions: calls.resolutions });
    const failure = types.diagnostics.find((diagnostic) => diagnostic.code === 'cancelled' || diagnostic.code === 'resource_limit');
    if (failure) throw new OperationError(failure);
    const active = nativeAnnotations(input, ir, types, calls, local);
    if (active.annotations.length || active.types.length !== input.native_types.length) {
      types = recoverTypes(ir, abi, local, { image_id: image.id, slice_id: image.selected_slice_id, revision,
        entry_address: fn.entry, debug: input.debug, library: input.library,
        max_work: local.remainingWork?.() ?? 0, types: active.types, annotations: active.annotations,
        signatures: active.declarations.signatures,
        contracts: [...libraryContracts, ...active.declarations.contracts], resolutions: calls.resolutions });
      const failure = types.diagnostics.find((item) => item.code === 'cancelled' || item.code === 'resource_limit');
      if (failure) throw new OperationError(failure);
    }
    if (types.state !== 'complete') reasons.push(
      `native optional type/stack semantics incomplete: ${types.diagnostics[0]?.message ?? 'no complete type representation'}`);
  } catch (error) {
    const details = error instanceof OperationError ? error.diagnostic.details : undefined;
    if (!(error instanceof OperationError) || error.code !== 'resource_limit' ||
      details?.kind !== 'limit' || details.resource !== 'work' || details.limit > workLimit) throw error;
    context.checkpoint(0);
    reasons.push(`native optional type/stack work limit (${workLimit})`);
    types = null;
  }
  let analysis = types?.calls ?? null;
  if (!analysis) {
    try {
      analysis = analyzeCalls(ir, abi, local, { max_work: local.remainingWork?.() ?? 0,
        contracts: [...libraryContracts, ...declarations.contracts], resolutions: calls.resolutions });
      const failure = analysis.diagnostics.find((diagnostic) => diagnostic.code === 'cancelled' || diagnostic.code === 'resource_limit');
      if (failure) throw new OperationError(failure);
    } catch (error) {
      const details = error instanceof OperationError ? error.diagnostic.details : undefined;
      if (!(error instanceof OperationError) || error.code !== 'resource_limit' || details?.kind !== 'limit' ||
        details.resource !== 'work' || details.limit > workLimit) throw error;
      context.checkpoint(0);
      reasons.push(`native physical call/stack work limit (${details.limit})`);
      analysis = null;
    }
  }
  const demand_index = createCallResultDemandIndex(ir, abi, context);
  const observed_calls = observePreparedCallInterfaces(ir, abi, analysis, context, demand_index);
  const dependencies = nativeDependencies(input, ir, context, undefined, true, demand_index);
  return { ...base, blocks: Math.max(base.blocks, lifted.ir.blocks.length, ir.blocks.length),
    nodes, required_nodes: requiredNodes, ir, types, analysis, observed_calls, dependencies, reasons, demand_index };
}
