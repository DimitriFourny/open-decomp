import type {
  AbiProfile,
  Address,
  Diagnostic,
  Evidence,
  FunctionRecord,
  Lifter,
  LoadedImage,
  OperationContext,
  ReferenceRecord,
  RegisterDescriptor,
} from '../../core/index.js';
import { fingerprint, OperationError, U64_LIMIT, type CanonicalValue } from '../../core/index.js';
import type { CallAnalysisResult, SuppliedCallContract } from '../../analysis/calls/index.js';
import { observePreparedCallInterfaces } from '../../analysis/calls/observed.js';
import { recoverDataAddress } from '../../analysis/strings/source-data.js';
import { sourceConstantValues } from '../../reconstruction/source-data.js';
import { inspectRegister, type StackFact } from '../../analysis/stack/index.js';
import { parameterMemoryShapes, refineMemoryShapes, type MemoryShapeTransfer, type SuppliedTypeRecord, type TypeRecoveryResult } from '../../analysis/types/index.js';
import { bitWidth, type DataType, type Expression, type RegisterIR, type SSAForm, type Value } from '../../ir/index.js';
import type { DebugRecovery } from '../../metadata/debug/index.js';
import type { LibraryContracts } from '../../metadata/library-contracts/index.js';
import type {
  InferredCallee,
  SourceAddress,
  SourceEvidence,
} from '../../reconstruction/source-model.js';
import { records } from '../queries/scope.js';
import type { AnalysisScope } from './index.js';
import type { CallScope } from './calls.js';
import { nativeDependencies, prepareNativeUnit, type PreparedNativeUnit } from './native-prepare.js';
import { nativeDependencyWorklist, type NativeInterface, type NativeSummary } from './native-worklist.js';
import { nativeCallInputs, nativeReturnInterface, nativeStackParameters, nativeTypeSlices } from './native-transfer.js';
import { nativeEntryRegisters } from './native-entry.js';
import { pipelineVersions } from './versions.js';
import { nativeArgumentValues } from './native-arguments.js';
import { parameterRegisters } from './native-abi.js';
import { fpEnvironmentGuard } from '../../lifters/arm64/semantics.js';
import { FP_ENVIRONMENT_ASSUMPTION, registerTypeSlices, registerTypes, type StorageCopy } from '../../reconstruction/source-register-types.js';

interface SourceFactsInput {
  readonly scope: AnalysisScope;
  readonly revision: number;
  readonly image: LoadedImage;
  readonly ir: SSAForm;
  readonly instruction_count: number;
  readonly coverage_reasons: readonly string[];
  readonly required_nodes?: number;
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

type ObservedInterface = NativeInterface;

/** Callee-proven locations/types take precedence. Caller-authored physical
 * prefix slots supplement missing locations without closing source arity. */
function mergeNativeInterface(
  proven: NativeInterface | undefined,
  prepared: NativeInterface | undefined,
  abi: AbiProfile,
  context: OperationContext,
): NativeInterface {
  if (!proven) return prepared ?? { parameters: [], returns: [], parameter_state: 'ambiguous', argument_list_complete: false };
  if (!prepared) return proven;
  const registers = new Map<string, { readonly register: RegisterDescriptor; readonly type: DataType }>();
  for (const observed of [prepared, proven])
    for (const [index, register] of observed.parameters.entries()) {
      context.checkpoint(1);
      const previous = registers.get(register.root);
      if (previous && register.bank === 'integer' && previous.register.bank === 'integer' &&
        previous.register.width_bits > register.width_bits) continue;
      registers.set(register.root, { register, type: observed.parameter_types?.[index] ??
        { kind: 'integer', bits: register.width_bits } });
    }
  const ordered = parameterRegisters(abi).flatMap((candidate) => registers.get(candidate.root) ?? []);
  const parameters = ordered.map((item) => item.register);
  const parameter_shapes = proven.parameter_shapes?.map((shape) => {
    const source = proven.parameters[shape.parameter_index];
    return { ...shape, parameter_index: source
      ? parameters.findIndex((register) => register.root === source.root)
      : parameters.length + shape.parameter_index - proven.parameters.length };
  });
  return { ...proven, parameters, parameter_types: ordered.map((item) => item.type),
    ...(parameter_shapes === undefined ? {} : { parameter_shapes }),
    ...(proven.returns.length ? {} : { returns: prepared.returns,
      ...(prepared.return_types === undefined ? {} : { return_types: prepared.return_types }) }),
    argument_list_complete: false };
}

/** Roots count only when they reach semantic observations. Physical snapshots,
 * phi transport, register clobbers, private spills and preservation are not uses. */
function observeParameters(
  ir: SSAForm,
  abi: AbiProfile,
  analysis: CallAnalysisResult,
  context: OperationContext,
  interfaces: ReadonlyMap<string, NativeInterface>,
  seed: boolean,
  demandedReturns: readonly RegisterDescriptor[],
): ObservedInterface {
  const candidates = parameterRegisters(abi),
    byRoot = new Map(candidates.map((register) => [register.root, register]));
  const observed = new Map<string, RegisterDescriptor>();
  const definitions = new Map<string, Expression>();
  const values = new Map<string, Value>();
  const storageCopies: StorageCopy[] = [];
  const byBlock = new Map(ir.blocks.map((block) => [block.id, block]));
  const predecessors = new Map<string, SSAForm['blocks'][number][]>();
  for (const block of ir.blocks) {
    for (const value of block.parameters) values.set(value.id, value);
    for (const node of block.instructions) {
      if ('result' in node) values.set(node.result.id, node.result);
      if (node.kind === 'assign') {
        definitions.set(node.result.id, node.expression);
      }
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
      }
    }
  }
  for (const state of ir.register_states)
    for (const binding of [...state.entry, ...state.exit]) values.set(binding.value.id, binding.value);
  const typedSlices = registerTypeSlices(values, definitions, storageCopies, [], context,
    nativeTypeSlices(ir, interfaces, context));
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
        if ((!contracts.length && !interfaces.has(node.id)) || call?.status === 'conflicting') ambiguous = true;
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
      if (!terminator.tail_call || !interfaces.has(terminator.id)) ambiguous = true;
    } else if (terminator.kind === 'unknown') ambiguous = true;
    else if (terminator.kind === 'return') for (const value of terminator.values) use(value);
  }
  for (const fact of nativeCallInputs(analysis, interfaces, context)) note(fact);
  const { returns, return_types, written_result } = nativeReturnInterface(ir, abi, analysis, interfaces, context, seed, demandedReturns);
  const exits = ir.blocks.filter((block) => block.terminator.kind === 'return');
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
    return_types,
    ...(written_result === undefined ? {} : { written_result }),
    parameter_state: ambiguous ? 'ambiguous' : 'observed',
    argument_list_complete: false,
    stack_parameters: nativeStackParameters(ir, analysis, context),
    assumptions: [...new Set([
      ...(conditionalFpFailures.size ? [FP_ENVIRONMENT_ASSUMPTION] : []),
      ...[...interfaces.values()].flatMap((callee) => callee.assumptions ?? []),
    ])],
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

/** Cached preparation is local SSA/type evidence, never a completed transitive
 * interface. Dependency observations are solved afresh for the exact roots and
 * consumed return slices of this request. Unknown/truncated preparations are not
 * cached. Immutable image + revision + full component/target identity bind all
 * graph, declaration, annotation and dependency-resolution inputs. */
const nativeSummaries = new WeakMap<LoadedImage, {
  readonly identity: string;
  readonly functions: readonly FunctionRecord[];
  readonly references: readonly ReferenceRecord[];
  readonly summaries: Map<string, PreparedNativeUnit>;
  units: number;
}>();

function nativeShapeTransfers(
  unit: PreparedNativeUnit,
  interfaces: ReadonlyMap<string, NativeInterface>,
  context: OperationContext,
): readonly MemoryShapeTransfer[] {
  if (!unit.ir) return [];
  const transfers: MemoryShapeTransfer[] = [];
  for (const [call_id, observed] of interfaces) {
    if (!observed.parameter_shapes?.length) continue;
    const arguments_ = nativeArgumentValues(unit.ir, unit.analysis, call_id, observed, context);
    for (const shape of observed.parameter_shapes) {
      context.checkpoint(1);
      const argument = arguments_.get(shape.parameter_index);
      if (argument) transfers.push({ ...shape, argument, call_id,
        evidence_ids: [...new Set([...unit.evidence_ids, ...shape.parameter_shape.evidence_ids])] });
    }
  }
  return transfers;
}

function observeNativeUnit(
  input: SourceFactsInput,
  unit: PreparedNativeUnit,
  dependencies: ReadonlyMap<string, NativeInterface>,
  context: OperationContext,
  demandedReturns: readonly RegisterDescriptor[],
  seed: boolean,
): NativeInterface {
  if (!unit.ir) return unit.entry_prefix ??
    { parameters: [], returns: [], parameter_state: 'ambiguous', argument_list_complete: false };
  const interfaces = new Map(dependencies);
  for (const observed of unit.observed_calls)
    interfaces.set(observed.call_id, mergeNativeInterface(interfaces.get(observed.call_id), observed, input.components.abi, context));
  let observed: NativeInterface;
  if (unit.analysis) observed = observeParameters(unit.ir, input.components.abi, unit.analysis,
    context, interfaces, seed, demandedReturns);
  else {
    const result = nativeReturnInterface(unit.ir, input.components.abi, null, interfaces, context, seed, demandedReturns);
    const parameters = nativeEntryRegisters(unit.ir, parameterRegisters(input.components.abi), interfaces,
      result.returns, context);
    observed = { ...result, parameters, parameter_types: parameters.map((register) =>
      ({ kind: 'integer' as const, bits: register.width_bits })), parameter_state: 'ambiguous', argument_list_complete: false,
      assumptions: [...new Set([
        ...[...interfaces.values()].flatMap((callee) => callee.assumptions ?? []),
      ])] };
  }
  if (unit.budget_truncated) observed = { ...observed, returns: [], return_types: [],
    written_result: { registers: [], types: [] }, parameter_state: 'ambiguous' };
  if (!unit.types) return observed;
  const transfers = nativeShapeTransfers(unit, interfaces, context);
  const types = transfers.length ? refineMemoryShapes(unit.ir, unit.types, context, {
    slice_id: input.image.selected_slice_id, revision: input.revision,
    max_work: context.remainingWork?.() ?? context.budget.work, transfers,
  }) : unit.types;
  const parameters = [...nativeArgumentValues(unit.ir, unit.analysis, unit.ir.id, observed, context)]
    .map(([parameter_index, value]) => ({ parameter_index, value }));
  return { ...observed, parameter_shapes: parameterMemoryShapes(types, parameters, context,
    { max_work: context.remainingWork?.() ?? context.budget.work }) };
}

/** Optional native dependencies share at most half the actual work remaining
 * after selected-body analysis. Their local limits retain explicit metadata;
 * outer cancellation/deadline/work and selected-path invariants still propagate. */
export function recoverSourceEvidence(input: SourceFactsInput): SourceEvidence {
  const { scope, components, image, revision } = input,
    { context } = scope, abi = components.abi;
  const callees: InferredCallee[] = [], diagnostics: Diagnostic[] = [], evidence: Evidence[] = [];
  const observedCalls = observePreparedCallInterfaces(input.ir, abi, input.types.calls, context);
  callees.push(...observedCalls);
  const dependencies = nativeDependencies(input, input.ir, context);
  const targets = new Map<string, FunctionRecord>();
  for (const dependency of dependencies) targets.set(dependency.target.id, dependency.target);
  const selectedNodes = input.ir.blocks.reduce(
    (count, block) => count + 3 + block.parameters.length + block.instructions.length, 0);
  const capacity = { nodes: context.budget.ir_nodes - selectedNodes,
    blocks: context.budget.blocks - input.ir.blocks.length,
    instructions: context.budget.instructions - input.instruction_count };
  const summaryWorkLimit = Math.floor((context.remainingWork?.() ?? 0) / 2);
  let summaryWork = 0;
  const summaryContext: OperationContext = {
    ...context, budget: { ...context.budget, work: summaryWorkLimit },
    remainingWork: () => Math.max(0, summaryWorkLimit - summaryWork),
    checkpoint(work) {
      context.checkpoint(0);
      if (summaryWork + work > summaryWorkLimit) throw new OperationError({
        code: 'resource_limit', severity: 'warning',
        message: 'Optional native summary work sub-budget exhausted', evidence_ids: [],
        details: { kind: 'limit', resource: 'work', limit: summaryWorkLimit,
          consumed: Math.min(summaryWork + work, Number.MAX_SAFE_INTEGER) },
      });
      context.checkpoint(work);
      summaryWork += work;
    },
  };
  // Recovery stays inside the same optional pool: unfinished dependencies cannot
  // consume the allowance needed to retain proven root inputs and local results.
  const worklistWorkLimit = Math.floor(summaryWorkLimit * 3 / 4);
  let worklistWork = 0;
  const worklistContext: OperationContext = { ...summaryContext,
    budget: { ...summaryContext.budget, work: worklistWorkLimit },
    remainingWork: () => Math.max(0, worklistWorkLimit - worklistWork),
    checkpoint(work) {
      summaryContext.checkpoint(0);
      if (worklistWork + work > worklistWorkLimit) throw new OperationError({
        code: 'resource_limit', severity: 'warning', message: 'Native dependency refinement work limit exceeded',
        evidence_ids: [], details: { kind: 'limit', resource: 'work', limit: worklistWorkLimit,
          consumed: Math.min(worklistWork + work, Number.MAX_SAFE_INTEGER) },
      });
      summaryContext.checkpoint(work); worklistWork += work;
    },
  };
  const libraryContracts: SuppliedCallContract[] = targets.size ? input.library.contracts
    .filter((contract) => contract.abi_state === 'supported' && !contract.conflicts_with.length)
    .map((contract) => ({
      id: contract.id, target: { kind: 'import', image_id: image.id, import_id: contract.import_id },
      signature: contract.abi_signature, noreturn: contract.noreturn, evidence_ids: contract.evidence_ids,
    })) : [];
  const identity = fingerprint({ revision, image: image.sha256, slice: image.selected_slice_id,
    target: image.target, versions: pipelineVersions(image.target, 'c-like'),
    lifter: `${components.lifter.name}/${components.lifter.version}`, abi: `${abi.id}/${abi.version}`,
  } as unknown as CanonicalValue);
  let cached = nativeSummaries.get(image);
  if (!cached || cached.identity !== identity || cached.functions !== input.functions || cached.references !== input.references) {
    cached = { identity, functions: input.functions, references: input.references, summaries: new Map(), units: 0 };
    nativeSummaries.set(image, cached);
  }
  const selected = input.functions.find((fn) => fn.id === input.ir.id);
  const selectedUnit: PreparedNativeUnit | undefined = selected ? {
    function: selected, ir: input.ir, types: input.types, analysis: input.types.calls,
    observed_calls: observedCalls, dependencies, instructions: input.instruction_count, blocks: input.ir.blocks.length,
    nodes: selectedNodes, required_nodes: input.required_nodes ?? selectedNodes, evidence: input.types.evidence,
    evidence_ids: selected.evidence_ids, reasons: input.coverage_reasons, budget_truncated: false,
  } : undefined;
  if (selectedUnit && input.required_nodes !== undefined && input.types.state === 'complete' &&
    selectedUnit.analysis?.state === 'complete' && !selectedUnit.reasons.length && !cached.summaries.has(input.ir.id)) {
    const units = selectedUnit.instructions + selectedUnit.nodes + selectedUnit.evidence.length;
    if (cached.summaries.size < 64 && cached.units + units <= 8192) {
      cached.summaries.set(input.ir.id, selectedUnit); cached.units += units;
    }
  }
  let memory_transfers: readonly MemoryShapeTransfer[] = [];
  let partialUnits: ReadonlyMap<string, PreparedNativeUnit> = new Map();
  let partialSummaries: ReadonlyMap<string, NativeSummary> = new Map();
  const returnDemands = new Map<string, RegisterDescriptor[]>();
  for (const dependency of dependencies) {
    const known = returnDemands.get(dependency.target.id) ?? [];
    known.push(...(dependency.return_demand ?? [])); returnDemands.set(dependency.target.id, known);
  }
  try {
    const result = nativeDependencyWorklist({
      roots: [...targets.values()], context: worklistContext, capacity, max_functions: 64, max_refinements: 64,
      return_demands: returnDemands,
      on_partial(units, summaries) { partialUnits = units; partialSummaries = summaries; },
      ...(selectedUnit ? { preloaded: new Map([[input.ir.id, selectedUnit]]) } : {}),
      load(fn, boundedContext) {
        let unit = cached.summaries.get(fn.id);
        if (unit && (unit.instructions > boundedContext.budget.instructions ||
          unit.blocks > boundedContext.budget.blocks || unit.required_nodes > boundedContext.budget.ir_nodes)) unit = undefined;
        if (unit) {
          boundedContext.checkpoint(1 + unit.dependencies.length + unit.evidence.length);
          context.progress('native_summary_cache', 1, 1);
          return unit;
        }
        unit = prepareNativeUnit(input, fn, boundedContext, libraryContracts);
        if (!unit.budget_truncated && !unit.reasons.length && unit.analysis?.state === 'complete' &&
          !cached.summaries.has(fn.id)) {
          const units = unit.instructions + unit.nodes + unit.evidence.length;
          if (cached.summaries.size < 64 && cached.units + units <= 8192) {
            cached.summaries.set(fn.id, unit); cached.units += units;
          }
        }
        return unit;
      },
      initialize: (unit, boundedContext, demand) => observeNativeUnit(input, unit, new Map(), boundedContext, demand, true),
      observe: (unit, summaries, boundedContext, demand) => observeNativeUnit(input, unit, summaries, boundedContext, demand, false),
      equal: (left, right) => fingerprint(left as unknown as CanonicalValue) === fingerprint(right as unknown as CanonicalValue),
    });
    for (const unit of result.units.values()) evidence.push(...unit.evidence);
    const interfaces = new Map<string, NativeInterface>();
    for (const dependency of dependencies) {
      const summary = result.summaries.get(dependency.target.id);
      const observed = mergeNativeInterface(summary?.observed,
        observedCalls.find((call) => call.call_id === dependency.call_id), abi, summaryContext);
      interfaces.set(dependency.call_id, observed);
      const { parameter_shapes, written_result: _written, ...interface_ } = observed;
      callees.push({ call_id: dependency.call_id, target: dependency.target.entry, ...interface_,
        evidence_ids: summary?.evidence_ids ?? dependency.target.evidence_ids });
      for (const shape of parameter_shapes ?? []) evidence.push(...shape.evidence);
      if (summary?.reasons.length) diagnostics.push({ code: 'unavailable_semantics', severity: 'warning',
        message: `Native callee ${dependency.target.original_name ?? dependency.target.id} remains partial: ${summary.reasons.join('; ')}`,
        entity_id: dependency.target.id, evidence_ids: dependency.target.evidence_ids });
    }
    if (selectedUnit) memory_transfers = nativeShapeTransfers(selectedUnit, interfaces, summaryContext);
  } catch (error) {
    const details = error instanceof OperationError ? error.diagnostic.details : undefined;
    if (!(error instanceof OperationError) || error.code !== 'resource_limit' || details?.kind !== 'limit' ||
      details.resource !== 'work' || details.limit > summaryWorkLimit) throw error;
    context.checkpoint(0);
    diagnostics.push({ code: 'resource_limit', severity: 'warning',
      message: `Native dependency worklist stopped at its work sub-budget (${details.limit}); selected-body analysis remains available and unfinished interfaces remain unresolved`,
      evidence_ids: [], details });
    for (const dependency of dependencies) {
      const unit = partialUnits.get(dependency.target.id),
        prior = partialSummaries.get(dependency.target.id)?.observed ?? unit?.entry_prefix;
      let observed: NativeInterface = { ...prior, parameters: prior?.parameters ?? [], returns: [],
        parameter_state: 'ambiguous', argument_list_complete: false };
      if (unit?.ir) {
        try {
          const returned = nativeReturnInterface(unit.ir, abi, unit.analysis, new Map(), summaryContext, false,
            returnDemands.get(dependency.target.id) ?? []);
          const inputs = nativeEntryRegisters(unit.ir, parameterRegisters(abi), new Map(), returned.returns, summaryContext);
          const parameters = new Map((prior?.parameters ?? []).map((register) => [register.root, register]));
          for (const register of inputs) {
            const previous = parameters.get(register.root);
            if (!previous || previous.width_bits < register.width_bits) parameters.set(register.root, register);
          }
          const ordered = parameterRegisters(abi).flatMap((register) => parameters.get(register.root) ?? []);
          observed = { ...observed, ...returned, parameters: ordered,
            parameter_types: ordered.map((register) => ({ kind: 'integer', bits: register.width_bits })) };
        } catch (recoveryError) {
          const recoveryDetails = recoveryError instanceof OperationError ? recoveryError.diagnostic.details : undefined;
          if (!(recoveryError instanceof OperationError) || recoveryError.code !== 'resource_limit' ||
            recoveryDetails?.kind !== 'limit' || recoveryDetails.resource !== 'work' ||
            recoveryDetails.limit > summaryWorkLimit) throw recoveryError;
          context.checkpoint(0);
        }
        evidence.push(...unit.evidence);
      }
      observed = mergeNativeInterface(observed, observedCalls.find((call) => call.call_id === dependency.call_id), abi, context);
      const { parameter_shapes: _shapes, written_result: _written, ...interface_ } = observed;
      callees.push({ call_id: dependency.call_id, target: dependency.target.entry, ...interface_,
        evidence_ids: unit?.evidence_ids ?? dependency.target.evidence_ids });
    }
  }
  return { abi, callees, diagnostics, evidence, addresses: sourceAddresses(input), memory_transfers,
    call_argument_counts: actualArgumentCounts(input.types.calls, input.library, context) };
}
