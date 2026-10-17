import {
  fingerprint,
  OperationError,
  type CanonicalValue,
  type OperationContext,
} from '../../core/index.js';
import { recoverTypes } from '../../analysis/types/index.js';
import { analyzeCalls, type SuppliedCallContract } from '../../analysis/calls/index.js';
import { observePreparedCallInterfaces } from '../../analysis/calls/observed.js';
import { createCallResultDemandIndex } from '../../analysis/calls/result-demands.js';
import { analyzeValues } from '../../analysis/values/index.js';
import { nativeAnnotations } from './native-annotations.js';
import { callDeclarations, resolveCalls } from './calls.js';
import { boundIR, requirePass } from './passes.js';
import {
  nativeDependencies,
  type NativePreparationInput,
  type PreparedNativeUnit,
} from './native-prepare.js';
import { specializeNativeSSA, type NativeContext } from './native-context.js';
import { createNativeInterfaceIndex, nativeEntryRegisters } from './native-entry.js';
import { parameterRegisters } from './native-abi.js';
import { nativeReturnInterface } from './native-transfer.js';

/** Context preparation never decodes, lifts or reconstructs SSA. Local optional
 * types share the parent's work clock; failure retains the immutable baseline's
 * conservative interface through the worklist's explicit generic fallback. */
export function prepareNativeContext(
  input: NativePreparationInput,
  baseline: PreparedNativeUnit,
  assumptions: NativeContext,
  context: OperationContext,
  libraryContracts: readonly SuppliedCallContract[],
): PreparedNativeUnit {
  if (!baseline.ir) return baseline;
  // Physical snapshots do not establish source inputs. Only baseline semantic
  // reads can turn a proven storage relation into a callee input assumption.
  const interfaces = new Map(baseline.observed_calls.map((call) => [call.call_id, call]));
  const returned = nativeReturnInterface(
    baseline.ir,
    input.components.abi,
    baseline.analysis,
    interfaces,
    context,
    true,
    [],
    false,
    baseline.interface_index,
  );
  const observed = nativeEntryRegisters(
    baseline.ir,
    parameterRegisters(input.components.abi),
    interfaces,
    returned.returns,
    context,
    baseline.interface_index,
  );
  const roots = new Set(observed.map((register) => register.root));
  assumptions = {
    ...assumptions,
    constants: assumptions.constants.filter((item) => roots.has(item.register.root)),
    aliases: assumptions.aliases
      .map((group) => group.filter((register) => roots.has(register.root)))
      .filter((group) => group.length > 1),
  };
  if (!assumptions.constants.length && !assumptions.aliases.length) return baseline;
  let ir = specializeNativeSSA(baseline.ir, assumptions, context);
  if (ir === baseline.ir)
    return {
      ...baseline,
      reasons: [
        ...baseline.reasons,
        'native context has no complete entry binding: conservative generic interface',
      ],
    };
  const values = analyzeValues(ir, {
    max_work: context.remainingWork?.() ?? context.budget.work,
    checkpoint: (work) => context.checkpoint(work),
  });
  requirePass(values.state, values.diagnostics, context);
  const constants = new Map(
    [...values.value.facts].flatMap(([id, fact]) =>
      fact.kind === 'constant' ? [[id, fact.bits] as const] : [],
    ),
  );
  // An exact callback input is an address proof, not permission to invoke it.
  ir = {
    ...ir,
    blocks: ir.blocks.map((block) => ({
      ...block,
      instructions: block.instructions.map((node) => {
        if (node.kind !== 'call' || node.target.kind !== 'indirect') return node;
        const value = constants.get(node.target.value.id);
        return value === undefined
          ? node
          : {
              ...node,
              target: {
                kind: 'direct' as const,
                address: { image_id: input.image.id, space: 'va' as const, value },
              },
            };
      }),
    })),
  };
  const nodes = boundIR(ir, context);
  const calls = resolveCalls(ir, input.image, input.functions, input.references, false, context);
  const declarations = callDeclarations(
    ir,
    input.image,
    input.revision,
    calls,
    input.debug,
    [],
    input.native_types,
    context,
    input.components.abi.layout,
  );
  const limit = Math.floor((context.remainingWork?.() ?? context.budget.work) / 4);
  let used = 0;
  const local: OperationContext = {
    ...context,
    budget: { ...context.budget, work: limit },
    remainingWork: () => Math.max(0, limit - used),
    checkpoint(work) {
      context.checkpoint(0);
      if (used + work > limit)
        throw new OperationError({
          code: 'resource_limit',
          severity: 'warning',
          message: 'Native context type work limit exceeded',
          evidence_ids: baseline.evidence_ids,
          details: { kind: 'limit', resource: 'work', limit, consumed: used + work },
        });
      context.checkpoint(work);
      used += work;
    },
  };
  let types: PreparedNativeUnit['types'] = null;
  let analysis: PreparedNativeUnit['analysis'] = null;
  const reasons = [...baseline.reasons];
  const annotationProofs: string[] = [];
  try {
    const active = baseline.types
      ? nativeAnnotations(input, baseline.ir, baseline.types, calls, local)
      : undefined;
    annotationProofs.push(
      ...(active?.annotations.flatMap((annotation) => annotation.evidence_ids) ?? []),
    );
    types = recoverTypes(ir, input.components.abi, local, {
      image_id: input.image.id,
      slice_id: input.image.selected_slice_id,
      revision: input.revision,
      entry_address: baseline.function.entry,
      debug: input.debug,
      library: input.library,
      max_work: local.remainingWork?.() ?? 0,
      types: active?.types ?? input.native_types,
      annotations: active?.annotations ?? [],
      signatures: active?.declarations.signatures ?? declarations.signatures,
      contracts: [
        ...libraryContracts,
        ...(active?.declarations.contracts ?? declarations.contracts),
      ],
      resolutions: calls.resolutions,
    });
    const failure = types.diagnostics.find(
      (item) => item.code === 'resource_limit' || item.code === 'cancelled',
    );
    if (failure) throw new OperationError(failure);
    analysis = types.calls;
    if (!analysis)
      analysis = analyzeCalls(ir, input.components.abi, local, {
        max_work: local.remainingWork?.() ?? 0,
        contracts: [...libraryContracts, ...declarations.contracts],
        resolutions: calls.resolutions,
      });
  } catch (error) {
    const details = error instanceof OperationError ? error.diagnostic.details : undefined;
    if (
      !(error instanceof OperationError) ||
      error.code !== 'resource_limit' ||
      details?.kind !== 'limit' ||
      details.resource !== 'work' ||
      details.limit > limit
    )
      throw error;
    context.checkpoint(0);
    types = null;
    analysis = null;
    reasons.push(`native context optional type work limit (${limit})`);
  }
  const demand_index = createCallResultDemandIndex(ir, input.components.abi, context);
  const interface_index = createNativeInterfaceIndex(ir, input.components.abi, context);
  const observed_calls = observePreparedCallInterfaces(
    ir,
    input.components.abi,
    analysis,
    context,
    demand_index,
  );
  const dependencies = nativeDependencies(input, ir, context, constants, true, demand_index);
  const indirect = new Set(
    baseline.ir.blocks.flatMap((block) =>
      block.instructions.flatMap((node) =>
        node.kind === 'call' && node.target.kind === 'indirect' ? [node.id] : [],
      ),
    ),
  );
  const callbacks = dependencies.filter((dependency) => indirect.has(dependency.call_id));
  const proof = {
    id: `evidence_${fingerprint([baseline.function.id, assumptions as unknown as CanonicalValue])}`,
    origin: {
      kind: 'analysis' as const,
      analyzer: 'native-context',
      version: '1',
      rule: 'whole proven ABI input assumptions',
    },
    claim:
      `Context assumes complete proven ABI carriers: ${assumptions.constants
        .map(
          ({ register, bits }) =>
            `${register.root}[${register.offset_bits}:${register.width_bits}]=0x${bits.toString(16)}`,
        )
        .join(', ')}; ` +
      `identity aliases: ${assumptions.aliases.map((group) => group.map((register) => register.root).join('=')).join(', ')}; ` +
      `known callback targets: ${callbacks
        .map(
          (dependency) =>
            `${dependency.call_id}=>${dependency.target.id}@${dependency.target.entry.value}`,
        )
        .join(', ')}; ` +
      'different classes remain may-alias; no complete source arity or source field names asserted',
    derived_from: [
      ...new Set([
        ...baseline.evidence_ids,
        ...annotationProofs,
        ...callbacks.flatMap((dependency) => dependency.target.evidence_ids),
      ]),
    ],
    conflicts_with: [],
    revision: input.revision,
  };
  if (proof.claim.length > 8192 || proof.derived_from.length >= 1000)
    return {
      ...baseline,
      reasons: [
        ...baseline.reasons,
        'native context evidence capacity: conservative generic interface',
      ],
    };
  return {
    ...baseline,
    ir,
    types,
    analysis,
    observed_calls,
    nodes,
    required_nodes: nodes,
    blocks: ir.blocks.length,
    context_assumptions: assumptions,
    dependencies,
    reasons,
    demand_index,
    interface_index,
    evidence: [...baseline.evidence, ...(types?.evidence ?? []), proof],
    evidence_ids: [...baseline.evidence_ids, proof.id],
  };
}
