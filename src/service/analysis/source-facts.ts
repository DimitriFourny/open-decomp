import type {
  AbiProfile,
  AbiType,
  Address,
  FunctionRecord,
  Lifter,
  LoadedImage,
  OperationContext,
  ReferenceRecord,
  RegisterDescriptor,
} from '../../core/index.js';
import { U64_LIMIT } from '../../core/index.js';
import {
  analyzeCalls,
  type CallAnalysisResult,
  type SuppliedCallContract,
} from '../../analysis/calls/index.js';
import { observeIndirectCallInterfaces } from '../../analysis/calls/observed.js';
import { constructSSA } from '../../analysis/ssa/index.js';
import { simplifySSA } from '../../analysis/values/index.js';
import { recoverDataAddress } from '../../analysis/strings/source-data.js';
import { sourceConstantValues } from '../../reconstruction/source-data.js';
import { inspectRegister, type StackFact } from '../../analysis/stack/index.js';
import type { SuppliedTypeRecord, TypeRecoveryResult } from '../../analysis/types/index.js';
import { bitWidth, sameType, type DataType, type Expression, type RegisterIR, type SSAForm, type Value } from '../../ir/index.js';
import type { DebugRecovery } from '../../metadata/debug/index.js';
import type { LibraryContracts } from '../../metadata/library-contracts/index.js';
import type {
  InferredCallee,
  SourceAddress,
  SourceEvidence,
} from '../../reconstruction/source-model.js';
import { loadFunctionGraph, records } from '../queries/scope.js';
import type { AnalysisScope } from './index.js';
import { callDeclarations, resolveCalls, type CallScope } from './calls.js';
import { boundIR, requirePass } from './passes.js';
import { fpEnvironmentGuard } from '../../lifters/arm64/semantics.js';
import { FP_ENVIRONMENT_ASSUMPTION, registerTypeSlices, registerTypes, unchangedStorage, type StorageCopy } from '../../reconstruction/source-register-types.js';

interface SourceFactsInput {
  readonly scope: AnalysisScope;
  readonly revision: number;
  readonly image: LoadedImage;
  readonly ir: SSAForm;
  readonly instruction_count: number;
  readonly functions: readonly FunctionRecord[];
  readonly references: readonly ReferenceRecord[];
  readonly calls: CallScope;
  readonly types: TypeRecoveryResult;
  readonly library: LibraryContracts;
  readonly debug: DebugRecovery;
  readonly components: { readonly abi: AbiProfile; readonly lifter: Lifter<RegisterIR> };
  readonly native_types: readonly SuppliedTypeRecord[];
}
const addressKey = (address: Address): string =>
  `${address.image_id}:${address.space}:${address.value}`;

/** Enumerate register capabilities through the selected ABI, never register names
 * or the host. Integer and floating banks have independent allocation sequences. */
function parameterRegisters(abi: AbiProfile): readonly RegisterDescriptor[] {
  const registers = new Map<string, RegisterDescriptor>();
  for (const type of [{ kind: 'pointer' }, { kind: 'float', bits: 64 }] as const) {
    const parameters: AbiType[] = Array.from({ length: 16 }, () => type);
    const layout = abi.classifyCall({
      returns: { kind: 'void' },
      parameters,
      variadic: false,
      fixed_parameter_count: parameters.length,
    });
    for (const parameter of layout.parameters)
      for (const location of parameter.locations)
        if (location.kind === 'register' && !registers.has(location.register.root))
          registers.set(location.register.root, { ...location.register, width_bits: location.width_bits });
  }
  return [...registers.values()];
}
type ObservedInterface = Pick<
  InferredCallee,
  'parameters' | 'returns' | 'parameter_state' | 'parameter_types' | 'return_types' | 'assumptions'
>;

/** Roots count only when they reach semantic observations. Physical snapshots,
 * phi transport, register clobbers, private spills and preservation are not uses. */
function observeParameters(
  ir: SSAForm,
  abi: AbiProfile,
  analysis: CallAnalysisResult,
  context: OperationContext,
): ObservedInterface {
  const candidates = parameterRegisters(abi),
    byRoot = new Map(candidates.map((register) => [register.root, register]));
  const observed = new Map<string, RegisterDescriptor>();
  const definitions = new Map<string, Expression>();
  const values = new Map<string, Value>();
  const storageCopies: StorageCopy[] = [];
  const storageSources = new Map<string, Value[]>();
  const byBlock = new Map(ir.blocks.map((block) => [block.id, block]));
  const predecessors = new Map<string, SSAForm['blocks'][number][]>();
  for (const block of ir.blocks) {
    for (const value of block.parameters) values.set(value.id, value);
    for (const node of block.instructions) {
      if ('result' in node) values.set(node.result.id, node.result);
      if (node.kind === 'assign') definitions.set(node.result.id, node.expression);
    }
    const control = block.terminator;
    const edges = control.kind === 'jump' ? [control.edge]
      : control.kind === 'branch' ? [control.when_true, control.when_false]
        : control.kind === 'switch' ? [...control.cases.map((item) => item.edge), control.otherwise] : [];
    for (const edge of edges) {
      const parents = predecessors.get(edge.target) ?? [];
      parents.push(block);
      predecessors.set(edge.target, parents);
      for (const [index, source] of edge.arguments.entries()) {
        const destination = byBlock.get(edge.target)!.parameters[index]!;
        storageCopies.push({ source, destination });
        const sources = storageSources.get(destination.id) ?? [];
        sources.push(source);
        storageSources.set(destination.id, sources);
      }
    }
  }
  for (const state of ir.register_states)
    for (const binding of [...state.entry, ...state.exit]) values.set(binding.value.id, binding.value);
  const typedSlices = registerTypeSlices(values, definitions, storageCopies, [], context);
  const entryBindings = ir.register_states.find((row) => row.block === ir.entry)?.entry ?? [];
  // This is the lifter's precise FPCR failure boundary, not a blanket exemption
  // for unknown instructions. Its supported-path observations remain conditional.
  const conditionalFpFailures = new Set<string>();
  if (abi.architecture === 'arm64')
    for (const block of ir.blocks) {
      if (block.terminator.kind !== 'unknown' ||
          block.terminator.reason !== fpEnvironmentGuard.unsupported_exit ||
          !block.instructions.some((node) => node.kind === 'unknown_effect' &&
            node.reason === fpEnvironmentGuard.unsupported_effect) ||
          block.instructions.some((node) => node.kind !== 'assign' &&
            (node.kind !== 'unknown_effect' || node.reason !== fpEnvironmentGuard.unsupported_effect))) continue;
      const parents = predecessors.get(block.id);
      if (!parents?.length || !parents.every((parent) => {
        const branch = parent.terminator;
        if (branch.kind !== 'branch' || branch.when_false.target !== block.id ||
            branch.when_true.target === block.id) return false;
        const comparison = definitions.get(branch.condition.id);
        if (comparison?.kind !== 'compare' || comparison.op !== 'eq') return false;
        const zero = definitions.get(comparison.right.id), masked = definitions.get(comparison.left.id);
        if (zero?.kind !== 'constant' || zero.bits !== 0n ||
            masked?.kind !== 'integer' || masked.op !== 'and') return false;
        const mask = definitions.get(masked.right.id);
        const controls = analysis.stack.values.get(masked.left.id)?.incoming_registers;
        return mask?.kind === 'constant' && mask.bits === fpEnvironmentGuard.mask &&
          controls !== undefined && controls.length > 0 &&
          controls.every((register) => register.root === fpEnvironmentGuard.control_root);
      })) continue;
      conditionalFpFailures.add(block.id);
    }
  let ambiguous =
    analysis.state !== 'complete' ||
    analysis.stack.accesses.some(
      (access) =>
        access.kind === 'read' &&
        (access.region === 'incoming_candidate' || access.region === 'mixed'),
    );
  const note = (fact: StackFact | undefined): void => {
    for (const register of fact?.incoming_registers ?? []) {
      context.checkpoint(1);
      const candidate = byRoot.get(register.root);
      if (abi.preserved.some((preserved) => preserved.root === register.root)) continue;
      if (!candidate) {
        if (register.role === 'general' &&
            (register.bank === 'integer' || register.bank === 'float' || register.bank === 'vector'))
          ambiguous = true;
        continue;
      }
      const prior = observed.get(register.root);
      const width = Math.max(prior?.width_bits ?? 0, register.offset_bits + register.width_bits);
      observed.set(register.root, {
        ...candidate,
        width_bits: Math.min(candidate.width_bits, width),
      });
    }
  };
  const use = (value: Value): void => note(analysis.stack.values.get(value.id));
  const calls = new Map(analysis.calls.map((call) => [call.node_id, call]));
  for (const block of ir.blocks) {
    if (!analysis.stack.snapshots.has(block.terminator.id)) continue;
    if (conditionalFpFailures.has(block.id)) continue;
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (node.kind === 'load') use(node.address);
      else if (node.kind === 'store') {
        use(node.address);
        // A private spill is observed through its subsequent loads, not its save.
        if (analysis.stack.values.get(node.address.id)?.value.kind !== 'stack') use(node.value);
      } else if (node.kind === 'call') {
        for (const argument of node.arguments) use(argument);
        if (node.target.kind === 'indirect') use(node.target.value);
        const call = calls.get(node.id);
        const contracts =
          call?.contracts.filter(
            (contract) => contract.status === 'established' && contract.layout.state === 'complete',
          ) ?? [];
        if (!contracts.length || call?.status === 'conflicting') ambiguous = true;
        for (const contract of contracts) {
          for (const parameter of contract.parameters)
            for (const location of parameter.locations) note(location.fact);
          if (contract.layout.argument_count === null) ambiguous = true;
        }
      } else if (node.kind === 'unknown_effect') ambiguous = true;
    }
    const terminator = block.terminator;
    if (terminator.kind === 'branch') use(terminator.condition);
    else if (terminator.kind === 'switch') use(terminator.value);
    else if (terminator.kind === 'indirect') {
      use(terminator.target);
      ambiguous = true;
    } else if (terminator.kind === 'unknown') ambiguous = true;
    else if (terminator.kind === 'return') for (const value of terminator.values) use(value);
  }
  // Return only actually written primary-result slices, common to every exit.
  // An unchanged incoming register or unrelated caller-saved output is no proof.
  const primary = abi
    .classifyCall({
      returns: { kind: 'pointer' },
      parameters: [],
      variadic: false,
      fixed_parameter_count: 0,
    })
    .returns.find((location) => location.kind === 'register');
  const exits = ir.blocks.filter((block) => block.terminator.kind === 'return');
  let returns: RegisterDescriptor[] = [];
  if (primary?.kind === 'register' && exits.length) {
    const slices = ir.register_states.find((row) => row.block === exits[0]!.id)?.exit ?? [];
    returns = slices
      .filter(
        (binding) =>
          binding.register.root === primary.register.root &&
          binding.register.offset_bits === 0 &&
          exits.every((exit) => {
            context.checkpoint(1);
            const snapshot = analysis.stack.snapshots.get(exit.terminator.id);
            if (!snapshot) return false;
            const fact = inspectRegister(snapshot, binding.register);
            const incoming = entryBindings.find((item) => item.register.id === binding.register.id);
            const output = ir.register_states
              .find((row) => row.block === exit.id)
              ?.exit.find((item) => item.register.id === binding.register.id);
            return (
              output !== undefined &&
              !unchangedStorage(output.value, incoming?.value.id, definitions, storageSources, context) &&
              fact.initialization !== 'uninitialized'
            );
          }),
      )
      .map((binding) => binding.register);
  }
  const floatingPrimary = abi.classifyCall({
    returns: { kind: 'float', bits: 64 }, parameters: [], variadic: false, fixed_parameter_count: 0,
  }).returns.find((location) => location.kind === 'register');
  let floatingType: DataType | null = null;
  if (floatingPrimary?.kind === 'register' && exits.length) {
    const bindings = ir.register_states.find((row) => row.block === exits[0]!.id)?.exit ?? [];
    floatingType = registerTypes(bindings, floatingPrimary.register.root,
      floatingPrimary.register.offset_bits, typedSlices, context, true).find((candidate) =>
        exits.every((exit) => registerTypes(
          ir.register_states.find((row) => row.block === exit.id)?.exit ?? [],
          floatingPrimary.register.root, floatingPrimary.register.offset_bits, typedSlices, context, true,
        ).some((type) => sameType(type, candidate)))) ?? null;
    const first = bindings.find((binding) => binding.register.root === floatingPrimary.register.root &&
      binding.register.offset_bits === floatingPrimary.register.offset_bits);
    if (first && floatingType) returns = [{ ...first.register, width_bits: bitWidth(floatingType) }];
  }
  for (const exit of exits) {
    const snapshot = analysis.stack.snapshots.get(exit.terminator.id);
    if (snapshot) for (const register of returns) note(inspectRegister(snapshot, register));
  }
  const missingBanks = new Set<string>();
  for (const candidate of candidates) {
    if (!observed.has(candidate.root)) missingBanks.add(candidate.bank);
    else if (missingBanks.has(candidate.bank)) ambiguous = true;
  }
  const inputTypes = new Map<string, DataType>();
  const parameters = candidates.flatMap((candidate) => {
    const observedRegister = observed.get(candidate.root);
    if (!observedRegister) return [];
    const type = (candidate.bank === 'float' || candidate.bank === 'vector')
      ? registerTypes(entryBindings, candidate.root, candidate.offset_bits, typedSlices, context)[0]
      : undefined;
    if (type) inputTypes.set(candidate.root, type);
    return [{ ...observedRegister, width_bits: type ? bitWidth(type) : observedRegister.width_bits }];
  });
  return {
    parameters,
    parameter_types: parameters.map((register): DataType =>
      inputTypes.get(register.root) ?? { kind: 'integer', bits: register.width_bits }),
    returns,
    return_types: returns.map((register): DataType =>
      floatingType ?? { kind: 'integer', bits: register.width_bits }),
    parameter_state: ambiguous ? 'ambiguous' : 'observed',
    ...(conditionalFpFailures.size ? { assumptions: [FP_ENVIRONMENT_ASSUMPTION] } : {}),
  };
}

/** Existing nominal library rules may close a variadic prefix. Zero open flags
 * require no mode on the supported POSIX/CRT ABIs; unknown/nonzero flags do not
 * acquire a guessed target-specific flag mask or invented trailing arguments. */
function actualArgumentCounts(
  analysis: CallAnalysisResult | null,
  library: LibraryContracts,
  context: OperationContext,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const call of analysis?.calls ?? []) {
    context.checkpoint(1);
    if (call.status === 'conflicting') continue;
    const observations = call.contracts.filter(
      (observation) => observation.status === 'established',
    );
    if (!observations.length) continue;
    const proven = new Set<number>();
    let complete = true;
    for (const observation of observations) {
      const contract = library.contracts.find(
        (item) =>
          item.id === observation.contract.id || `${item.id}:entry` === observation.contract.id,
      );
      if (
        !contract ||
        contract.conflicts_with.length ||
        contract.variadic_rule?.kind !== 'open_flags'
      ) {
        complete = false;
        break;
      }
      const flags = observation.parameters.find(
        (parameter) => parameter.index === contract.variadic_rule!.argument,
      )?.locations;
      if (
        flags?.length !== 1 ||
        flags[0]!.fact.value.kind !== 'constant' ||
        flags[0]!.fact.value.bits !== 0n
      ) {
        complete = false;
        break;
      }
      proven.add(contract.abi_signature.fixed_parameter_count);
    }
    if (complete && proven.size === 1) counts.set(call.node_id, [...proven][0]!);
  }
  return counts;
}

function sourceAddresses(input: SourceFactsInput): readonly SourceAddress[] {
  const { image, scope, revision } = input,
    context = scope.context;
  const candidates = new Map<string, Address>();
  const expressions = new Map(
    input.ir.blocks.flatMap((block) => block.instructions.flatMap((node) =>
      node.kind === 'assign' ? [[node.result.id, node.expression] as const] : [])),
  );
  const constant = sourceConstantValues(expressions, context, image.id);
  for (const block of input.ir.blocks)
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (node.kind !== 'assign' || node.result.type.kind !== 'integer' ||
        node.result.type.bits !== image.target.address_bits) continue;
      const bits = constant(node.result);
      if (bits !== undefined && bits < U64_LIMIT) {
        const address: Address = { image_id: image.id, space: 'va', value: bits };
        candidates.set(addressKey(address), address);
      }
    }
  for (const fact of input.types.calls?.stack.values.values() ?? []) {
    context.checkpoint(1);
    const address: Address | undefined =
      fact.value.kind === 'address'
        ? fact.value.address
        : fact.value.kind === 'constant' && fact.value.bits >= 0n && fact.value.bits < U64_LIMIT
          ? { image_id: image.id, space: 'va', value: fact.value.bits }
          : undefined;
    if (address) candidates.set(addressKey(address), address);
  }
  for (const block of input.ir.blocks)
    for (const node of block.instructions)
      if (node.kind === 'assign' && node.expression.kind === 'address')
        candidates.set(addressKey(node.expression.address), node.expression.address);
  // ABI pointer arguments may consist only of split register cells in SSA.
  // Their observed whole value still identifies a literal, without turning
  // arbitrary integer constants or writable pointer slots into source strings.
  for (const call of input.types.calls?.calls ?? [])
    for (const contract of call.contracts) {
      context.checkpoint(1);
      if (contract.status !== 'established') continue;
      for (const parameter of contract.parameters) {
        if (contract.contract.signature.parameters?.[parameter.index]?.kind !== 'pointer') continue;
        for (const location of parameter.locations) {
          context.checkpoint(1);
          const value = location.fact.value;
          const address: Address | undefined =
            value.kind === 'address'
              ? value.address
              : value.kind === 'constant' && value.bits >= 0n && value.bits < U64_LIMIT
                ? { image_id: image.id, space: 'va', value: value.bits }
                : undefined;
          if (address) candidates.set(addressKey(address), address);
        }
      }
    }
  const names = new Map<string, Set<string>>();
  const symbols = records(scope, revision, image.id, 'symbol').items.map((symbol) => {
    context.checkpoint(1);
    if (!symbol.address) return symbol;
    const start = symbol.address;
    let relevant = candidates.has(addressKey(start));
    if (!relevant && symbol.kind === 'object' && symbol.size !== null)
      for (const candidate of candidates.values()) {
        context.checkpoint(1);
        if (candidate.image_id === start.image_id && candidate.space === start.space &&
          candidate.value >= start.value && candidate.value < start.value + symbol.size) {
          relevant = true;
          break;
        }
      }
    if (!relevant) return symbol;
    const annotations = scope.store
      .readAnnotations(symbol.id, revision)
      .filter(
        (annotation) => annotation.value.kind === 'name' && annotation.status !== 'retracted',
      );
    const asserted = new Set(
      annotations.flatMap((annotation) =>
        annotation.status === 'asserted' && annotation.value.kind === 'name'
          ? [annotation.value.value]
          : [],
      ),
    );
    const name =
      asserted.size === 1
        ? [...asserted][0]
        : annotations.length
          ? undefined
          : (symbol.display_name ?? symbol.original_name);
    if (name) {
      const key = addressKey(symbol.address),
        values = names.get(key) ?? new Set<string>();
      values.add(name);
      names.set(key, values);
    }
    return { ...symbol, original_name: name ?? null, display_name: null };
  });
  const result: SourceAddress[] = [];
  for (const [key, address] of candidates) {
    context.checkpoint(1);
    const aliases = names.get(key),
      name = aliases?.size === 1 ? [...aliases][0] : undefined;
    const recovered = recoverDataAddress(image, address, context, symbols);
    if (recovered)
      result.push({
        ...recovered,
        ...(name === undefined ? {} : { name }),
      });
    else if (name !== undefined) result.push({ address, name });
  }
  return result;
}

/** Single-level native observation. Each unique exact native target is lifted and
 * analyzed once, with the operation's cumulative work/cancellation and remaining
 * instruction/IR/block budgets. Nothing is persisted as a proven prototype. */
export function recoverSourceEvidence(input: SourceFactsInput): SourceEvidence {
  const { scope, components, image, revision } = input,
    { context } = scope,
    abi = components.abi;
  const callees: InferredCallee[] = [],
    targets = new Map<string, { fn: FunctionRecord; call_ids: string[] }>();
  callees.push(...observeIndirectCallInterfaces(input.ir, abi, input.types.calls, context));
  const nodes = new Map(
    input.ir.blocks.flatMap((block) => block.instructions).map((node) => [node.id, node]),
  );
  const importedCalls = new Set(
    image.imports.flatMap((imported) =>
      (input.calls.calls_by_subject.get(imported.id) ?? []).map((use) => use.call_id),
    ),
  );
  for (const fn of input.functions)
    for (const use of input.calls.calls_by_subject.get(fn.id) ?? []) {
      context.checkpoint(1);
      if (importedCalls.has(use.call_id)) continue;
      if (use.target.kind !== 'address' || addressKey(use.target.address) !== addressKey(fn.entry))
        continue;
      const node = nodes.get(use.call_id);
      if (
        node?.kind !== 'call' ||
        node.target.kind !== 'direct' ||
        addressKey(node.target.address) !== addressKey(fn.entry)
      )
        continue;
      const key = addressKey(fn.entry),
        target = targets.get(key) ?? { fn, call_ids: [] };
      target.call_ids.push(use.call_id);
      targets.set(key, target);
    }
  let remainingNodes =
    context.budget.ir_nodes -
    input.ir.blocks.reduce(
      (count, block) => count + 3 + block.parameters.length + block.instructions.length,
      0,
    );
  let remainingBlocks = context.budget.blocks - input.ir.blocks.length,
    remainingInstructions = context.budget.instructions - input.instruction_count;
  const libraryContracts: SuppliedCallContract[] = input.library.contracts
    .filter((contract) => contract.abi_state === 'supported' && !contract.conflicts_with.length)
    .map((contract) => ({
      id: contract.id,
      target: { kind: 'import', image_id: image.id, import_id: contract.import_id },
      signature: contract.abi_signature,
      noreturn: contract.noreturn,
      evidence_ids: contract.evidence_ids,
    }));
  for (const { fn, call_ids } of targets.values()) {
    context.checkpoint(1);
    let observed: ObservedInterface = {
      parameters: [],
      returns: [],
      parameter_state: 'ambiguous',
    };
    if (
      remainingNodes > 0 &&
      remainingBlocks > 0 &&
      remainingInstructions > 0 &&
      fn.id !== input.ir.id
    ) {
      const boundedContext: OperationContext = {
        ...context,
        budget: {
          ...context.budget,
          ir_nodes: remainingNodes,
          blocks: remainingBlocks,
          instructions: remainingInstructions,
        },
      };
      const graph = loadFunctionGraph({ ...scope, context: boundedContext }, revision, {
        image,
        function: fn,
      });
      remainingInstructions -= graph.instructions.length;
      if (graph.coverage.state === 'complete') {
        const passOptions = {
          max_work: context.budget.work,
          max_ir_nodes: remainingNodes,
          max_blocks: remainingBlocks,
          checkpoint: (work: number) => context.checkpoint(work),
        };
        const lifted = components.lifter.lift(graph, abi, boundedContext);
        boundIR(lifted.ir, boundedContext);
        const constructed = constructSSA(lifted.ir, passOptions);
        requirePass(constructed.state, constructed.diagnostics, context);
        if (constructed.value.form === 'ssa') {
          boundIR(constructed.value, boundedContext);
          const simplified = simplifySSA(constructed.value, passOptions);
          requirePass(simplified.state, simplified.diagnostics, context);
          const ir = simplified.value;
          boundIR(ir, boundedContext);
          remainingNodes -= ir.blocks.reduce(
            (count, block) => count + 3 + block.parameters.length + block.instructions.length,
            0,
          );
          remainingBlocks -= ir.blocks.length;
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
          const analysis = analyzeCalls(ir, abi, context, {
            max_work: context.budget.work,
            contracts: [...libraryContracts, ...declarations.contracts],
            resolutions: calls.resolutions,
          });
          requirePass(analysis.state, analysis.diagnostics, context);
          observed = observeParameters(ir, abi, analysis, context);
        }
      }
    }
    for (const call_id of new Set(call_ids))
      callees.push({ call_id, ...observed, evidence_ids: fn.evidence_ids });
  }
  return {
    abi,
    callees,
    addresses: sourceAddresses(input),
    call_argument_counts: actualArgumentCounts(input.types.calls, input.library, context),
  };
}
