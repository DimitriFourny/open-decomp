import type {
  AbiProfile,
  Address,
  CacheIdentity,
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
import {
  observePreparedCallInterfaces,
  observePreparedTailInterfaces,
} from '../../analysis/calls/observed.js';
import { createCallResultDemandIndex } from '../../analysis/calls/result-demands.js';
import {
  recoverDataAddress,
  recoverDataBytes,
  recoverImportBindings,
} from '../../analysis/strings/source-data.js';
import { sourceConstantValues } from '../../reconstruction/source-data.js';
import { cSourceName } from '../../metadata/symbols/c-names.js';
import { inspectRegister, type StackFact } from '../../analysis/stack/index.js';
import {
  parameterMemoryShapes,
  refineMemoryShapes,
  type MemoryShapeTransfer,
  type SuppliedTypeRecord,
  type TypeRecoveryResult,
} from '../../analysis/types/index.js';
import {
  bitWidth,
  expressionOperands,
  type DataType,
  type Expression,
  type Instruction,
  type RegisterIR,
  type SSAForm,
  type Value,
} from '../../ir/index.js';
import type { DebugRecovery } from '../../metadata/debug/index.js';
import type { LibraryContracts } from '../../metadata/library-contracts/index.js';
import type {
  CallerResultDemand,
  InferredCallee,
  SourceAddress,
  SourceEvidence,
} from '../../reconstruction/source-model.js';
import { callerResultDemands } from './caller-result-use.js';
import {
  createNativeUnitPersistence,
  preparedSize,
  type NativeUnitPersistence,
  type PreparedUnitEntry,
} from './native-summaries.js';
import { records } from '../queries/scope.js';
import type { AnalysisScope } from './index.js';
import type { CallScope } from './calls.js';
import {
  nativeDependencies,
  prepareNativeUnit,
  type NativePreparationInput,
  type PreparedNativeUnit,
} from './native-prepare.js';
import {
  budgetReason,
  nativeDependencyWorklist,
  type NativeInterface,
  type NativeSummary,
  type NativeSummaryCapacity,
} from './native-worklist.js';
import {
  inheritGenericResult,
  nativeCallInputs,
  nativeIncomingStackEscapes,
  nativeReturnInterface,
  nativeStackParameters,
  nativeTypeSlices,
} from './native-transfer.js';
import {
  createNativeInterfaceIndex,
  nativeEntryRegisters,
  type NativeInterfaceIndex,
} from './native-entry.js';
import { pipelineVersions } from './versions.js';
import {
  nativeArgumentIndex,
  nativeArgumentValues,
  type NativeArgumentIndex,
} from './native-arguments.js';
import { parameterRegisters } from './native-abi.js';
import { fpEnvironmentGuard } from '../../lifters/arm64/semantics.js';
import { x86FpEnvironmentGuard } from '../../lifters/x86_64/semantics.js';
import {
  registerTypeSlices,
  registerTypes,
  type StorageCopy,
} from '../../reconstruction/source-register-types.js';
import { needsSourceFpEnvironment } from '../../reconstruction/source-requirements.js';
import { nativeContextKey } from './native-context.js';
import { prepareNativeContext } from './native-context-prepare.js';
import { constantCandidates, variadicRuleCalls, variadicRuleFacts } from './source-variadic.js';
import { registerConstantCandidates } from './source-literal-candidates.js';
import { nativeLibraryTails } from './native-library-tails.js';
import { objcSourceFacts } from './objc-messages.js';
import { calleeReadsGuess, likelyArities } from './likely-arity.js';
import { nativeVariadicInterface } from './native-variadic.js';
import { likelyTypes } from './likely-types.js';

export interface SourceFactsInput {
  readonly scope: AnalysisScope;
  readonly identity?: CacheIdentity;
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
  readonly observable_register_masks?: ReadonlyMap<string, bigint>;
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
  if (!proven)
    return (
      prepared ?? {
        parameters: [],
        returns: [],
        parameter_state: 'ambiguous',
        argument_list_complete: false,
      }
    );
  if (!prepared) return proven;
  const registers = new Map<
    string,
    { readonly register: RegisterDescriptor; readonly type: DataType }
  >();
  for (const observed of [prepared, proven])
    for (const [index, register] of observed.parameters.entries()) {
      context.checkpoint(1);
      const previous = registers.get(register.root);
      if (
        previous &&
        register.bank === 'integer' &&
        previous.register.bank === 'integer' &&
        previous.register.width_bits > register.width_bits
      )
        continue;
      registers.set(register.root, {
        register,
        type: observed.parameter_types?.[index] ?? { kind: 'integer', bits: register.width_bits },
      });
    }
  const ordered = parameterRegisters(abi).flatMap(
    (candidate) => registers.get(candidate.root) ?? [],
  );
  const parameters = ordered.map((item) => item.register);
  const parameter_shapes = proven.parameter_shapes?.map((shape) => {
    const source = proven.parameters[shape.parameter_index];
    return {
      ...shape,
      parameter_index: source
        ? parameters.findIndex((register) => register.root === source.root)
        : parameters.length + shape.parameter_index - proven.parameters.length,
    };
  });
  return {
    ...proven,
    parameters,
    parameter_types: ordered.map((item) => item.type),
    ...(parameter_shapes === undefined ? {} : { parameter_shapes }),
    ...(proven.returns.length
      ? {}
      : {
          returns: prepared.returns,
          ...(prepared.return_types === undefined ? {} : { return_types: prepared.return_types }),
        }),
    argument_list_complete: false,
  };
}

/** Failure blocks of the lifter's precise FPCR/MXCSR environment guards, not a
 * blanket exemption for unknown instructions. Supported-path observations remain
 * conditional. ARM guards test the supported FPCR state and branch false to a
 * failure with the guard's unknown effect; x86 guards test the unsupported
 * MXCSR[6:16] state and branch true to a failure without effects. Every
 * predecessor must be such a guard of the entry/call control state. */
export function fpEnvironmentFailures(
  ir: SSAForm,
  abi: AbiProfile,
  definitions: ReadonlyMap<string, Expression>,
  predecessors: ReadonlyMap<string, readonly SSAForm['blocks'][number][]>,
  facts: ReadonlyMap<string, StackFact>,
): ReadonlySet<string> {
  const failures = new Set<string>();
  const x86 = abi.architecture === 'x86_64';
  for (const block of ir.blocks) {
    if (
      block.terminator.kind !== 'unknown' ||
      (x86
        ? block.terminator.reason !== x86FpEnvironmentGuard.unsupported_exit ||
          block.instructions.some((node) => node.kind !== 'assign')
        : block.terminator.reason !== fpEnvironmentGuard.unsupported_exit ||
          !block.instructions.some(
            (node) =>
              node.kind === 'unknown_effect' &&
              node.reason === fpEnvironmentGuard.unsupported_effect,
          ) ||
          block.instructions.some(
            (node) =>
              node.kind !== 'assign' &&
              (node.kind !== 'unknown_effect' ||
                node.reason !== fpEnvironmentGuard.unsupported_effect),
          ))
    )
      continue;
    const parents = predecessors.get(block.id);
    if (
      !parents?.length ||
      !parents.every((parent) => {
        const branch = parent.terminator;
        if (
          branch.kind !== 'branch' ||
          (x86 ? branch.when_true : branch.when_false).target !== block.id ||
          (x86 ? branch.when_false : branch.when_true).target === block.id
        )
          return false;
        const comparison = definitions.get(branch.condition.id);
        if (x86) {
          if (comparison?.kind !== 'compare' || comparison.op !== 'ne') return false;
          const expected = definitions.get(comparison.right.id);
          const controls = facts.get(comparison.left.id)?.incoming_registers;
          return (
            expected?.kind === 'constant' &&
            expected.bits === x86FpEnvironmentGuard.supported_bits &&
            comparison.left.type.kind === 'integer' &&
            comparison.left.type.bits === x86FpEnvironmentGuard.width_bits &&
            controls !== undefined &&
            controls.length > 0 &&
            controls.every(
              (register) =>
                register.root === x86FpEnvironmentGuard.control_root &&
                register.offset_bits === x86FpEnvironmentGuard.offset_bits &&
                register.width_bits === x86FpEnvironmentGuard.width_bits,
            )
          );
        }
        if (comparison?.kind !== 'compare' || comparison.op !== 'eq') return false;
        const zero = definitions.get(comparison.right.id),
          masked = definitions.get(comparison.left.id);
        if (
          zero?.kind !== 'constant' ||
          zero.bits !== 0n ||
          masked?.kind !== 'integer' ||
          masked.op !== 'and'
        )
          return false;
        const mask = definitions.get(masked.right.id);
        const controls = facts.get(masked.left.id)?.incoming_registers;
        return (
          mask?.kind === 'constant' &&
          mask.bits === fpEnvironmentGuard.mask &&
          controls !== undefined &&
          controls.length > 0 &&
          controls.every((register) => register.root === fpEnvironmentGuard.control_root)
        );
      })
    )
      continue;
    failures.add(block.id);
  }
  return failures;
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
  assumedEntry = false,
  interfaceIndex?: NativeInterfaceIndex,
  assumedParameters: readonly RegisterDescriptor[] = [],
): ObservedInterface {
  const candidates = parameterRegisters(abi),
    byRoot = new Map(candidates.map((register) => [register.root, register]));
  const observed = new Map<string, RegisterDescriptor>();
  // Source-only invocation refinement: substituted constants/identity aliases
  // remain actual ABI inputs and must not create a fictitious gap in the prefix.
  for (const register of assumedParameters) observed.set(register.root, register);
  const definitions = new Map<string, Expression>();
  const values = new Map<string, Value>();
  const storageCopies: StorageCopy[] = [];
  const byBlock = new Map(ir.blocks.map((block) => [block.id, block]));
  const predecessors = new Map<string, SSAForm['blocks'][number][]>();
  let localFpEnvironment = false;
  for (const block of ir.blocks) {
    for (const value of block.parameters) values.set(value.id, value);
    for (const node of block.instructions) {
      if ('result' in node) values.set(node.result.id, node.result);
      if (node.kind === 'assign') {
        definitions.set(node.result.id, node.expression);
        localFpEnvironment ||= needsSourceFpEnvironment(node.expression);
      }
    }
    const control = block.terminator;
    const edges =
      control.kind === 'jump'
        ? [control.edge]
        : control.kind === 'branch'
          ? [control.when_true, control.when_false]
          : control.kind === 'switch'
            ? [...control.cases.map((item) => item.edge), control.otherwise]
            : [];
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
    for (const binding of [...state.entry, ...state.exit])
      values.set(binding.value.id, binding.value);
  const typedSlices = registerTypeSlices(
    values,
    definitions,
    storageCopies,
    [],
    context,
    nativeTypeSlices(ir, interfaces, context, interfaceIndex),
  );
  const entryBindings = ir.register_states.find((row) => row.block === ir.entry)?.entry ?? [];
  const conditionalFpFailures = fpEnvironmentFailures(
    ir,
    abi,
    definitions,
    predecessors,
    analysis.stack.values,
  );
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
        if (
          register.role === 'general' &&
          (register.bank === 'integer' || register.bank === 'float' || register.bank === 'vector')
        )
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
  const spills: StackFact[] = [];
  const calls = new Map(analysis.calls.map((call) => [call.node_id, call]));
  // A call whose callee interface is unresolved, open or recursive may read any
  // argument storage. It can observe this function's own incoming arguments only
  // through a path from an entry argument register that no semantic use has
  // already made a parameter: an argument register at the call whose value may
  // depend on such an entry value (directly, through phis or computed), a
  // missing binding, a private spill of such a value, or a stack pointer that is
  // not below entry SP (the callee's stack arguments would be our incoming
  // ones). Without such a path the callee sees only observed parameters and
  // values this body computed, so it adds no input; ABI conformance is assumed.
  const opaque = new Set<string>();
  const entryRoots = new Map(
    entryBindings
      .filter((binding) => byRoot.has(binding.register.root))
      .map((binding) => [binding.value.id, binding.register.root]),
  );
  const phiSources = new Map<string, Value[]>();
  for (const copy of storageCopies) {
    const list = phiSources.get(copy.destination.id) ?? [];
    list.push(copy.source);
    phiSources.set(copy.destination.id, list);
  }
  const mayHoldUnobserved = (start: Value): boolean => {
    const pending = [start],
      seen = new Set<string>();
    while (pending.length) {
      context.checkpoint(1);
      const value = pending.pop()!;
      if (seen.has(value.id)) continue;
      seen.add(value.id);
      const root = entryRoots.get(value.id);
      if ((root !== undefined && !observed.has(root)) || seen.size > 256) return true;
      const expression = definitions.get(value.id);
      if (expression) pending.push(...expressionOperands(expression));
      else pending.push(...(phiSources.get(value.id) ?? []));
    }
    return false;
  };
  const passesUnobserved = (node: Extract<Instruction, { kind: 'call' }>): boolean => {
    const sp = analysis.stack.snapshots.get(node.id)?.stack_pointer.value;
    if (sp?.kind !== 'stack' || sp.offset >= 0n) return true;
    if (
      spills.some((fact) =>
        fact.incoming_registers.some(
          (register) => byRoot.has(register.root) && !observed.has(register.root),
        ),
      )
    )
      return true;
    return candidates.some((candidate) => {
      const cells = node.register_inputs.filter(
        (binding) => binding.register.root === candidate.root,
      );
      return !cells.length || cells.some((binding) => mayHoldUnobserved(binding.value));
    });
  };
  const callNodes = new Map<string, Extract<Instruction, { kind: 'call' }>>();
  for (const block of ir.blocks) {
    if (!analysis.stack.snapshots.has(block.terminator.id)) continue;
    if (conditionalFpFailures.has(block.id)) continue;
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (node.kind === 'load') use(node.address);
      else if (node.kind === 'store') {
        use(node.address);
        // A private spill is observed through its subsequent loads, not its save.
        const fact = analysis.stack.values.get(node.value.id);
        if (analysis.stack.values.get(node.address.id)?.value.kind !== 'stack') note(fact);
        else if (fact) spills.push(fact);
      } else if (node.kind === 'call') {
        for (const argument of node.arguments) use(argument);
        if (node.target.kind === 'indirect') use(node.target.value);
        const call = calls.get(node.id);
        const contracts =
          call?.contracts.filter(
            (contract) => contract.status === 'established' && contract.layout.state === 'complete',
          ) ?? [];
        callNodes.set(node.id, node);
        if (call?.status === 'conflicting') ambiguous = true;
        else if (!contracts.length && !interfaces.has(node.id)) {
          if (node.target.kind === 'indirect') opaque.add(node.id);
          else ambiguous = true;
        }
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
  for (const id of opaque) if (passesUnobserved(callNodes.get(id)!)) ambiguous = true;
  const { returns, return_types, written_result } = nativeReturnInterface(
    ir,
    abi,
    analysis,
    interfaces,
    context,
    seed,
    demandedReturns,
    assumedEntry,
    interfaceIndex,
  );
  const exits = ir.blocks.filter((block) => block.terminator.kind === 'return');
  for (const exit of exits) {
    const snapshot = analysis.stack.snapshots.get(exit.terminator.id);
    if (snapshot) for (const register of returns) note(inspectRegister(snapshot, register));
  }
  // A computed-address stack read (for example through a `va_list`) may load a
  // spilled argument register that no exact load observes: its arity stays open.
  if (
    analysis.stack.accesses.some((access) => access.kind === 'read' && access.region === 'dynamic')
  )
    for (const fact of spills)
      for (const register of fact.incoming_registers) {
        context.checkpoint(1);
        if (byRoot.has(register.root) && !observed.has(register.root)) ambiguous = true;
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
    const type =
      candidate.bank === 'float' || candidate.bank === 'vector'
        ? registerTypes(
            entryBindings,
            candidate.root,
            candidate.offset_bits,
            typedSlices,
            context,
          )[0]
        : undefined;
    if (type) inputTypes.set(candidate.root, type);
    return [
      { ...observedRegister, width_bits: type ? bitWidth(type) : observedRegister.width_bits },
    ];
  });
  const variadicStack = nativeIncomingStackEscapes(ir, abi, analysis, context);
  const stack_parameters = nativeStackParameters(ir, analysis, context, interfaceIndex);
  // Complete by callee reads: nothing outside the observed register prefix can
  // be read, directly or through a callee/tail target whose own list is closed.
  // Only calls an unobserved entry argument may reach (and tail transfers) rely
  // on their callee's closure; the worklist inherits arity completeness from
  // exactly those. Recursive groups close only by the worklist's coinductive
  // check. Complete reads, not caller-written extent, bound arity.
  const closedCallee = (callee: NativeInterface | undefined): boolean =>
    callee?.argument_list_closure !== undefined &&
    callee.parameter_state !== 'ambiguous' &&
    !callee.variadic_stack;
  const reaching: string[] = [];
  for (const block of ir.blocks) {
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (
        node.kind !== 'call' ||
        calls
          .get(node.id)
          ?.contracts.some(
            (contract) =>
              contract.status === 'established' &&
              contract.layout.state === 'complete' &&
              contract.layout.argument_count !== null,
          ) === true ||
        (callNodes.has(node.id) && !passesUnobserved(callNodes.get(node.id)!))
      )
        continue;
      reaching.push(node.id);
    }
    if (block.terminator.kind === 'indirect') reaching.push(block.terminator.id);
  }
  const closure =
    !ambiguous &&
    !variadicStack &&
    !stack_parameters.length &&
    reaching.every((id) => closedCallee(interfaces.get(id)));
  // Opt-in heuristic basis (`callee_reads`): the same closure, except that an
  // unobserved argument forwarded into an indirect call or indirect tail is taken
  // not to be read by its unknown target.
  const indirectTargets = new Set<string>();
  for (const [id, node] of callNodes) if (node.target.kind === 'indirect') indirectTargets.add(id);
  for (const block of ir.blocks)
    if (block.terminator.kind === 'indirect' && block.terminator.tail_call)
      indirectTargets.add(block.terminator.id);
  const likelyClosure =
    !closure &&
    !ambiguous &&
    !variadicStack &&
    !stack_parameters.length &&
    reaching.every((id) => {
      const callee = interfaces.get(id);
      return (
        indirectTargets.has(id) ||
        closedCallee(callee) ||
        (callee?.likely_closure === true &&
          callee.parameter_state !== 'ambiguous' &&
          !callee.variadic_stack)
      );
    });
  return {
    parameters,
    parameter_types: parameters.map(
      (register): DataType =>
        inputTypes.get(register.root) ?? { kind: 'integer', bits: register.width_bits },
    ),
    returns,
    ...(return_types === undefined ? {} : { return_types }),
    ...(written_result === undefined ? {} : { written_result }),
    parameter_state: ambiguous ? 'ambiguous' : 'observed',
    argument_list_complete: false,
    stack_parameters,
    ...(closure ? { argument_list_closure: 'callee_reads' as const } : {}),
    ...(likelyClosure ? { likely_closure: true as const } : {}),
    ...(reaching.length ? { argument_reaching_calls: reaching } : {}),
    ...(variadicStack ? { variadic_stack: true as const } : {}),
    requirements: [
      ...new Set([
        ...(conditionalFpFailures.size || localFpEnvironment ? ['fp_environment' as const] : []),
        ...[...interfaces.values()].flatMap((callee) => callee.requirements ?? []),
      ]),
    ],
  };
}

/** The value a register-cell reassembly (`concat` of consecutive `extract`s of
 * one value, lowest part first) re-presents unchanged; otherwise `value`. */
function wholeValue(value: Value, expressions: ReadonlyMap<string, Expression>): Value {
  for (let depth = 0; depth < 8; depth++) {
    const expression = expressions.get(value.id);
    if (expression?.kind !== 'concat' || !expression.values.length) return value;
    let offset = 0,
      source: Value | undefined;
    for (const part of expression.values) {
      const piece = expressions.get(part.id);
      if (piece?.kind !== 'extract' || piece.offset !== offset) return value;
      if (source && source.id !== piece.value.id) return value;
      source = piece.value;
      offset += bitWidth(part.type);
    }
    if (!source || bitWidth(source.type) !== offset) return value;
    value = source;
  }
  return value;
}

/** Most bytes of an indexed read-only table the source facts carry: enough for
 * the complete small tables and the printed prefix of larger ones. */
const TABLE_BYTES_READ = 64n;

function sourceAddresses(
  input: SourceFactsInput,
  formatPointers: readonly bigint[],
): readonly SourceAddress[] {
  const { image, scope, revision } = input,
    context = scope.context;
  const candidates = new Map<string, Address>();
  const expressions = new Map(
    input.ir.blocks.flatMap((block) =>
      block.instructions.flatMap((node) =>
        node.kind === 'assign' ? [[node.result.id, node.expression] as const] : [],
      ),
    ),
  );
  const constant = sourceConstantValues(expressions, context, image.id);
  const literalWidths = new Map<string, number>();
  const tableBases = new Set<string>();
  const writes: { address: bigint; size: bigint }[] = [];
  for (const block of input.ir.blocks)
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (node.kind === 'store') {
        const address = constant(node.address);
        if (address !== undefined)
          writes.push({ address, size: BigInt(Math.ceil(bitWidth(node.value.type) / 8)) });
      }
      if (node.kind === 'load' || node.kind === 'store') {
        // Constants added to a variable offset address indexed storage: each is a table base.
        const leaves: Value[] = [];
        const flatten = (original: Value, depth: number): void => {
          const value = wholeValue(original, expressions);
          const sum = expressions.get(value.id);
          if (
            sum?.kind === 'integer' &&
            sum.op === 'add' &&
            depth < 4 &&
            constant(value) === undefined
          ) {
            flatten(sum.left, depth + 1);
            flatten(sum.right, depth + 1);
          } else leaves.push(value);
        };
        flatten(node.address, 0);
        // Constant leaves sum to the base (an ADRP page and its low offset are two).
        let total = 0n,
          known = 0;
        for (const leaf of leaves) {
          const value = constant(leaf);
          if (value === undefined) continue;
          total += value;
          known++;
        }
        total = BigInt.asUintN(64, total);
        if (known > 0 && known < leaves.length && total < U64_LIMIT)
          tableBases.add(addressKey({ image_id: image.id, space: 'va', value: total }));
      }
      if (
        node.kind !== 'load' ||
        node.access.volatile ||
        (node.result.type.kind !== 'integer' && node.result.type.kind !== 'float')
      )
        continue;
      const width = bitWidth(node.result.type),
        bits = constant(node.address);
      if (
        width % 8 ||
        bits === undefined ||
        bits >= U64_LIMIT ||
        bits % BigInt(node.access.alignment) !== 0n
      )
        continue;
      const address: Address = { image_id: image.id, space: 'va', value: bits };
      const key = addressKey(address);
      candidates.set(key, address);
      literalWidths.set(key, Math.max(literalWidths.get(key) ?? 0, width / 8));
    }
  for (const block of input.ir.blocks)
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (
        node.kind !== 'assign' ||
        node.result.type.kind !== 'integer' ||
        node.result.type.bits !== image.target.address_bits
      )
        continue;
      const bits = constant(node.result);
      if (bits !== undefined && bits < U64_LIMIT) {
        const address: Address = { image_id: image.id, space: 'va', value: bits };
        candidates.set(addressKey(address), address);
      }
    }
  // Pointer-width constants of register cells, phis, tail exits and calls,
  // per incoming edge and through bounded value sets; see the module.
  for (const address of registerConstantCandidates({
    ir: input.ir,
    image,
    expressions,
    constant,
    candidates: constantCandidates(input.ir, input.types.calls?.stack ?? null, context),
    context,
  }))
    candidates.set(addressKey(address), address);
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
  // Every possible format pointer of an established format rule names a
  // candidate literal; string facts still require exact immutable bytes.
  for (const value of formatPointers) {
    context.checkpoint(1);
    if (value >= U64_LIMIT) continue;
    const address: Address = { image_id: image.id, space: 'va', value };
    candidates.set(addressKey(address), address);
  }
  // Any call's observed argument registers and stack values, whatever its
  // contract: a constant that addresses a string is a literal wherever it is
  // used. Registers are tracked as cells; cells that tile a whole pointer-width
  // register form its constant.
  for (const call of input.types.calls?.calls ?? []) {
    const cells = new Map<string, { offset: number; width: number; bits: bigint }[]>();
    for (const { register, fact } of call.register_candidates) {
      context.checkpoint(1);
      if (fact.value.kind !== 'constant') continue;
      const row = cells.get(register.root) ?? [];
      row.push({
        offset: register.offset_bits,
        width: register.width_bits,
        bits: BigInt.asUintN(register.width_bits, fact.value.bits),
      });
      cells.set(register.root, row);
    }
    for (const row of cells.values()) {
      row.sort((left, right) => left.offset - right.offset || right.width - left.width);
      let cursor = 0,
        whole = 0n;
      for (const cell of row)
        if (cell.offset === cursor) {
          whole |= cell.bits << BigInt(cell.offset);
          cursor += cell.width;
        }
      if (cursor === image.target.address_bits)
        candidates.set(addressKey({ image_id: image.id, space: 'va', value: whole }), {
          image_id: image.id,
          space: 'va',
          value: whole,
        });
    }
    for (const fact of call.explicit_arguments) {
      context.checkpoint(1);
      if (fact.value.kind === 'address')
        candidates.set(addressKey(fact.value.address), fact.value.address);
      else if (
        fact.value.kind === 'constant' &&
        fact.value.bits >= 0n &&
        fact.value.bits < U64_LIMIT
      ) {
        const address: Address = { image_id: image.id, space: 'va', value: fact.value.bits };
        candidates.set(addressKey(address), address);
      }
    }
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
  const sourceNames = new Map<string, string>();
  const symbols = records(scope, revision, image.id, 'symbol').items.map((symbol) => {
    context.checkpoint(1);
    if (!symbol.address) return symbol;
    const start = symbol.address;
    let relevant = candidates.has(addressKey(start));
    if (!relevant && symbol.kind === 'object' && symbol.size !== null)
      for (const candidate of candidates.values()) {
        context.checkpoint(1);
        if (
          candidate.image_id === start.image_id &&
          candidate.space === start.space &&
          candidate.value >= start.value &&
          candidate.value < start.value + symbol.size
        ) {
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
      sourceNames.set(
        `${addressKey(symbol.address)}:${name}`,
        annotations.length ? name : cSourceName(image.target.format, name),
      );
      const key = addressKey(symbol.address),
        values = names.get(key) ?? new Set<string>();
      values.add(name);
      names.set(key, values);
    }
    return { ...symbol, original_name: name ?? null, display_name: null };
  });
  // Entries of the image's functions: a constant equal to one names the function.
  // A symbol's name (above) wins; otherwise the function's own name, under the
  // same annotation rules, and nothing when annotations leave it unresolved.
  const functionEntries = new Map<string, boolean>();
  for (const fn of input.functions) {
    context.checkpoint(1);
    if (fn.boundary === 'conflicting') continue;
    const key = addressKey(fn.entry);
    if (!candidates.has(key)) continue;
    functionEntries.set(key, fn.id === input.ir.id);
    if (names.has(key)) continue;
    const annotations = scope.store
      .readAnnotations(fn.id, revision)
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
          : (fn.display_name ?? fn.original_name ?? undefined);
    if (!name) continue;
    sourceNames.set(
      `${key}:${name}`,
      annotations.length ? name : cSourceName(image.target.format, name),
    );
    names.set(key, new Set([name]));
  }
  const slotImports = recoverImportBindings(
    image,
    candidates,
    (id) => {
      const annotations = scope.store
        .readAnnotations(id, revision)
        .filter(
          (annotation) => annotation.value.kind === 'name' && annotation.status !== 'retracted',
        );
      return {
        asserted: annotations.flatMap((annotation) =>
          annotation.status === 'asserted' && annotation.value.kind === 'name'
            ? [annotation.value.value]
            : [],
        ),
        annotated: annotations.length > 0,
      };
    },
    context,
  );
  const result: SourceAddress[] = [];
  for (const [key, address] of candidates) {
    context.checkpoint(1);
    const aliases = names.get(key),
      name = aliases?.size === 1 ? [...aliases][0] : undefined;
    const recovered = recoverDataAddress(image, address, context, symbols);
    const imported = slotImports.get(key);
    if (imported) {
      // Slot bytes are loader inputs, never the values later read: neither a
      // string nor constant bytes may be recovered from them.
      const {
        string: _s,
        string_byte_length: _l,
        string_encoding: _e,
        string_start: _t,
        ...slot
      } = recovered ?? { address };
      const object = recovered?.object;
      result.push({
        ...slot,
        object: {
          address,
          byte_length: BigInt(image.target.address_bits / 8),
          offset: 0n,
          mutable: object?.mutable ?? true,
          kind: 'bytes',
          evidence_ids: [...new Set([...(object?.evidence_ids ?? []), ...imported.evidence_ids])],
        },
        import: imported,
      });
      continue;
    }
    const byteLength = literalWidths.get(key);
    const constantBytes =
      byteLength !== undefined &&
      !writes.some(
        (write) =>
          write.address < address.value + BigInt(byteLength) &&
          write.address + write.size > address.value,
      )
        ? recoverDataBytes(image, address, byteLength, context)
        : undefined;
    const spelling =
      recovered && (name ?? recovered.name)
        ? sourceNames.get(
            `${addressKey(recovered.object?.address ?? address)}:${name ?? recovered.name}`,
          )
        : undefined;
    const entry = functionEntries.get(key);
    const object = recovered?.object;
    const extent = object && (object.byte_length ?? object.span_bound);
    const objectBytes =
      !entry &&
      object &&
      !object.mutable &&
      object.kind === 'bytes' &&
      tableBases.has(key) &&
      extent
        ? recoverDataBytes(
            image,
            object.address,
            Number(extent < TABLE_BYTES_READ ? extent : TABLE_BYTES_READ),
            context,
          )
        : undefined;
    if (recovered)
      result.push({
        ...recovered,
        ...(constantBytes === undefined ? {} : { constant_bytes: constantBytes }),
        ...(objectBytes === undefined ? {} : { object_bytes: objectBytes }),
        ...(name === undefined ? {} : { name }),
        ...(spelling === undefined ? {} : { source_name: spelling }),
      });
    else if (entry !== undefined || name !== undefined) {
      const functionSpelling = name === undefined ? undefined : sourceNames.get(`${key}:${name}`);
      result.push({
        address,
        ...(name === undefined ? {} : { name }),
        ...(functionSpelling === undefined ? {} : { source_name: functionSpelling }),
        ...(entry === undefined ? {} : { function_entry: { self: entry } }),
      });
    }
  }
  return result;
}

/** Prepared callee units (local SSA/type evidence, never a completed transitive
 * interface), shared by every request at the same immutable image revision and
 * component/target/native-type identity — not by budget, capacity or root.
 * Dependency observations are still solved afresh per request.
 *
 * Charge-exact reuse. Every work limit inside preparation (`prepareNativeUnit`) is set
 * from the worklist allowance remaining when it is set: SSA takes 3/4 of it, optional
 * type/stack work 1/4, nested analyses are bounded by what their enclosing limit has
 * left, and the variadic footprint sees no remaining-work figure at all (so its
 * structuring and validation allowance are fixed). Limits only stop work, and every
 * stop marks the unit `limited`, also where a nested pass turned it into a partial
 * result. A preparation that charged W under allowance A and is not `limited`
 * therefore returns the same unit, charges the same W and makes the same reads in the
 * same order under every allowance of at least min(A, 4W + 3) (each limit then
 * exceeds all work charged after it was set) and under every capacity it fits.
 *
 * Only such units are retained (`reusablePreparation`), with `allowance` =
 * min(A, 4W + 3). A reuse happens only when the load's allowance is at least that and
 * the replayed charge (W on the load's context, then the recorded reads with their
 * capture charges) fits every enclosing allowance; it returns the recorded unit. So a
 * load leaves exactly what preparing it would, and a request's result and work never
 * depend on what earlier requests in this process (or a persisted row) prepared. */
type PreparedUnitCache = {
  readonly identity: string;
  readonly functions: readonly FunctionRecord[];
  readonly references: readonly ReferenceRecord[];
  /** Least recently used first. */
  readonly entries: Map<string, PreparedUnitEntry>;
  /** The persisted tier behind `entries`; absent when the store offers none. */
  readonly persistence?: NativeUnitPersistence;
  size: number;
};
const preparedUnits = new WeakMap<LoadedImage, PreparedUnitCache>();
/** Retained prepared size (instructions + IR nodes + evidence + traced reads) per
 * image. Measured on SQLite at roughly 1 KiB of heap per unit, so ~256 MiB. */
const MAX_PREPARED_UNIT_SIZE = 1 << 18;
const reusablePreparation = (unit: PreparedNativeUnit): boolean =>
  !unit.budget_truncated &&
  !unit.limited &&
  !unit.reasons.length &&
  unit.analysis?.state === 'complete';

function nativeSelectedNodes(ir: SSAForm): number {
  return ir.blocks.reduce(
    (count, block) => count + 3 + block.parameters.length + block.instructions.length,
    0,
  );
}

/** Dependency capacity left after the selected body; part of the cache identity. */
function nativeCapacity(input: SourceFactsInput, context: OperationContext): NativeSummaryCapacity {
  return {
    nodes: context.budget.ir_nodes - nativeSelectedNodes(input.ir),
    blocks: context.budget.blocks - input.ir.blocks.length,
    instructions: context.budget.instructions - input.instruction_count,
  };
}

/** Supported, unopposed library import contracts for native dependency bodies. */
export function nativeLibraryContracts(
  input: Pick<NativePreparationInput, 'image' | 'library'>,
): SuppliedCallContract[] {
  return input.library.contracts
    .filter((contract) => contract.abi_state === 'supported' && !contract.conflicts_with.length)
    .map((contract) => ({
      id: contract.id,
      target: { kind: 'import', image_id: input.image.id, import_id: contract.import_id },
      signature: contract.abi_signature,
      noreturn: contract.noreturn,
      evidence_ids: contract.evidence_ids,
    }));
}

/** The process-wide prepared-unit cache of this image revision and component identity. */
export function preparedUnitCache(input: NativePreparationInput): PreparedUnitCache {
  // Disabled caching neither reads nor leaves a process-wide cache behind.
  if (input.scope.analysis_cache === false)
    return {
      identity: '',
      functions: input.functions,
      references: input.references,
      entries: new Map(),
      size: 0,
    };
  const { components, image, revision } = input,
    abi = components.abi;
  const identity = fingerprint({
    revision,
    image: image.sha256,
    slice: image.selected_slice_id,
    target: image.target,
    versions: pipelineVersions(image.target, 'c-like'),
    lifter: `${components.lifter.name}/${components.lifter.version}`,
    abi: `${abi.id}/${abi.version}`,
    native_types: input.native_types,
  } as unknown as CanonicalValue);
  let prepared = preparedUnits.get(image);
  if (
    !prepared ||
    prepared.identity !== identity ||
    prepared.functions !== input.functions ||
    prepared.references !== input.references
  ) {
    const persistence = createNativeUnitPersistence(input, identity);
    prepared = {
      identity,
      functions: input.functions,
      references: input.references,
      entries: new Map(),
      ...(persistence ? { persistence } : {}),
      size: 0,
    };
    preparedUnits.set(image, prepared);
  }
  return prepared;
}

/** Load one native body: reuse a prepared unit only where preparing it here would
 * provably return it (charging its work and replaying its reads), else prepare it.
 * `fits(work, reads)` states whether that charge fits every enclosing allowance. */
export function nativeUnitLoader(
  input: NativePreparationInput,
  cache: PreparedUnitCache,
  libraryContracts: readonly SuppliedCallContract[],
  fits: (work: number, reads: number) => boolean,
): (fn: FunctionRecord, boundedContext: OperationContext) => PreparedNativeUnit {
  const { scope } = input,
    abi = input.components.abi;
  // With analysis caching off a unit is prepared for this request alone: nothing is
  // reused, retained or persisted.
  if (scope.analysis_cache === false)
    return (fn, boundedContext) => prepareNativeUnit(input, fn, boundedContext, libraryContracts);
  const { persistence } = cache;
  /** Keep `entry` in the process tier, evicting least recently used entries to fit. */
  const retain = (id: string, entry: PreparedUnitEntry): boolean => {
    if (entry.size > MAX_PREPARED_UNIT_SIZE) return false;
    for (const [other, old] of cache.entries) {
      if (cache.size + entry.size <= MAX_PREPARED_UNIT_SIZE) break;
      cache.entries.delete(other);
      cache.size -= old.size;
    }
    cache.entries.set(id, entry);
    cache.size += entry.size;
    return true;
  };
  const reuse = (fn: FunctionRecord, boundedContext: OperationContext) => {
    let entry = cache.entries.get(fn.id);
    // A unit this process has not prepared may be one an earlier process persisted. It is
    // used exactly as if it had been prepared here, so the checks below are the same.
    if (!entry && persistence) {
      entry = persistence.load(fn);
      if (entry && !retain(fn.id, entry)) entry = undefined;
    }
    const allowance = boundedContext.remainingWork?.();
    if (
      !entry ||
      allowance === undefined ||
      allowance < entry.allowance ||
      entry.unit.instructions >= boundedContext.budget.instructions ||
      entry.unit.blocks >= boundedContext.budget.blocks ||
      entry.unit.required_nodes >= boundedContext.budget.ir_nodes ||
      (scope.dependencies !== undefined && entry.trace === undefined)
    )
      return undefined;
    const reads = scope.dependencies ? scope.dependencies.traceCharges(entry.trace!) : 0;
    // Charges that fit every enclosing allowance cannot fail, so neither can the
    // interleaved charges of a fresh preparation; otherwise prepare for real.
    if (reads === undefined || !fits(entry.work, reads)) return undefined;
    scope.dependencies?.replayTrace(entry.trace!);
    boundedContext.checkpoint(entry.work);
    cache.entries.delete(fn.id);
    cache.entries.set(fn.id, entry);
    scope.context.progress('native_summary_cache', 1, 1);
    // The interface index builds lazily on first query and charges that query's
    // clock; a fresh preparation hands out an unbuilt one, so must a reuse.
    return entry.unit.ir && entry.unit.interface_index
      ? {
          ...entry.unit,
          interface_index: createNativeInterfaceIndex(entry.unit.ir, abi, boundedContext),
        }
      : entry.unit;
  };
  const prepare = (fn: FunctionRecord, boundedContext: OperationContext) => {
    const allowance = boundedContext.remainingWork?.();
    let work = 0;
    const measured: OperationContext = {
      ...boundedContext,
      checkpoint(amount) {
        boundedContext.checkpoint(amount);
        work += amount;
      },
    };
    const run = () => prepareNativeUnit(input, fn, measured, libraryContracts);
    const { value: unit, trace } = scope.dependencies
      ? scope.dependencies.traced(run)
      : { value: run(), trace: undefined };
    if (allowance !== undefined && reusablePreparation(unit)) {
      const prior = cache.entries.get(fn.id);
      if (prior) {
        cache.entries.delete(fn.id);
        cache.size -= prior.size;
      }
      const entry: PreparedUnitEntry = {
        unit,
        work,
        ...(trace ? { trace } : {}),
        allowance: Math.min(allowance, 4 * work + 3, prior?.allowance ?? allowance),
        size: preparedSize(unit, trace),
      };
      // Persist only what is retained, and only what the project does not already hold
      // at an allowance this one cannot improve.
      if (retain(fn.id, entry) && (prior?.stored === undefined || entry.allowance < prior.stored))
        persistence?.save(fn, entry);
    }
    return unit;
  };
  return (fn, boundedContext) => reuse(fn, boundedContext) ?? prepare(fn, boundedContext);
}

/** `indexed`: the unit IR's argument index when the caller already built it;
 * otherwise it is built at the first call with parameter shapes. */
function nativeShapeTransfers(
  unit: PreparedNativeUnit,
  interfaces: ReadonlyMap<string, NativeInterface>,
  context: OperationContext,
  indexed?: NativeArgumentIndex,
): readonly MemoryShapeTransfer[] {
  if (!unit.ir) return [];
  const transfers: MemoryShapeTransfer[] = [];
  for (const [call_id, observed] of interfaces) {
    if (!observed.parameter_shapes?.length) continue;
    indexed ??= nativeArgumentIndex(unit.ir, context);
    const arguments_ = nativeArgumentValues(indexed, unit.analysis, call_id, observed, context);
    for (const shape of observed.parameter_shapes) {
      context.checkpoint(1);
      const argument = arguments_.get(shape.parameter_index);
      if (argument)
        transfers.push({
          ...shape,
          argument,
          call_id,
          evidence_ids: [...new Set([...unit.evidence_ids, ...shape.parameter_shape.evidence_ids])],
        });
    }
  }
  return transfers;
}

/** Calls an unobserved entry argument of this body may reach when no dependency
 * interface is known: dependency interfaces only add observed parameters, so
 * this is a superset of every later observation's `argument_reaching_calls`. */
function nativeArgumentReaching(
  input: SourceFactsInput,
  unit: PreparedNativeUnit,
  context: OperationContext,
): ReadonlySet<string> {
  if (!unit.ir || !unit.analysis) return new Set(unit.dependencies.map((item) => item.call_id));
  const interfaces = new Map<string, NativeInterface>();
  for (const observed of unit.observed_calls)
    interfaces.set(
      observed.call_id,
      mergeNativeInterface(undefined, observed, input.components.abi, context),
    );
  return new Set(
    observeParameters(
      unit.ir,
      input.components.abi,
      unit.analysis,
      context,
      interfaces,
      false,
      [],
      unit.context_assumptions !== undefined,
      unit.interface_index,
    ).argument_reaching_calls,
  );
}

function observeNativeUnit(
  input: SourceFactsInput,
  unit: PreparedNativeUnit,
  dependencies: ReadonlyMap<string, NativeInterface>,
  context: OperationContext,
  demandedReturns: readonly RegisterDescriptor[],
  seed: boolean,
): NativeInterface {
  if (!unit.ir)
    return (
      unit.entry_prefix ?? {
        parameters: [],
        returns: [],
        parameter_state: 'ambiguous',
        argument_list_complete: false,
      }
    );
  const interfaces = new Map(dependencies);
  for (const observed of unit.observed_calls)
    interfaces.set(
      observed.call_id,
      mergeNativeInterface(
        interfaces.get(observed.call_id),
        observed,
        input.components.abi,
        context,
      ),
    );
  let observed: NativeInterface;
  if (unit.analysis)
    observed = observeParameters(
      unit.ir,
      input.components.abi,
      unit.analysis,
      context,
      interfaces,
      seed,
      demandedReturns,
      unit.context_assumptions !== undefined,
      unit.interface_index,
    );
  else {
    const result = nativeReturnInterface(
      unit.ir,
      input.components.abi,
      null,
      interfaces,
      context,
      seed,
      demandedReturns,
      unit.context_assumptions !== undefined,
      unit.interface_index,
    );
    const parameters = nativeEntryRegisters(
      unit.ir,
      parameterRegisters(input.components.abi),
      interfaces,
      result.returns,
      context,
      unit.interface_index,
    );
    const localFpEnvironment = unit.ir.blocks.some((block) =>
      block.instructions.some((node) => {
        context.checkpoint(1);
        return node.kind === 'assign' && needsSourceFpEnvironment(node.expression);
      }),
    );
    observed = {
      ...result,
      parameters,
      parameter_types: parameters.map((register) => ({
        kind: 'integer' as const,
        bits: register.width_bits,
      })),
      parameter_state: 'ambiguous',
      argument_list_complete: false,
      requirements: [
        ...new Set([
          ...(localFpEnvironment ? ['fp_environment' as const] : []),
          ...[...interfaces.values()].flatMap((callee) => callee.requirements ?? []),
        ]),
      ],
    };
  }
  if (unit.context_assumptions) {
    const assumed = [
      ...unit.context_assumptions.constants.map((item) => item.register),
      ...unit.context_assumptions.aliases.flat(),
    ];
    observed = mergeNativeInterface(
      observed,
      {
        parameters: assumed,
        returns: [],
        parameter_state: 'observed',
        argument_list_complete: false,
      },
      input.components.abi,
      context,
    );
    observed = {
      ...inheritGenericResult(observed, unit.generic_result),
      context_assumptions: unit.context_assumptions,
    };
  }
  if (unit.analysis && !unit.budget_truncated) {
    const libraryTails = nativeLibraryTails(
      unit.ir,
      input.image,
      input.functions,
      input.references,
      input.library,
      input.components.abi,
      context,
    );
    if (
      unit.context_assumptions ||
      libraryTails.length ||
      [...interfaces.values()].some((callee) => callee.source_interface)
    ) {
      const sourceInterfaces = new Map(
        [...interfaces].map(([id, callee]) => [id, callee.source_interface ?? callee]),
      );
      for (const tail of libraryTails)
        sourceInterfaces.set(tail.call_id, {
          ...tail,
          written_result: { registers: tail.returns, types: tail.return_types ?? [] },
        });
      const sourceObserved = observeParameters(
        unit.ir,
        input.components.abi,
        unit.analysis,
        context,
        sourceInterfaces,
        seed,
        demandedReturns,
        unit.context_assumptions !== undefined,
        unit.interface_index,
        unit.context_assumptions
          ? [
              ...unit.context_assumptions.constants.map((item) => item.register),
              ...unit.context_assumptions.aliases.flat(),
            ]
          : [],
      );
      if (sourceObserved.argument_list_closure)
        observed = {
          ...observed,
          source_interface: {
            ...mergeNativeInterface(
              inheritGenericResult(sourceObserved, unit.generic_result),
              observed,
              input.components.abi,
              context,
            ),
            argument_list_closure: [...sourceInterfaces.values()].some(
              (callee) => callee.argument_list_closure === 'library_contract',
            )
              ? 'library_contract'
              : 'callee_reads',
          },
        };
    }
  }
  // The body's `va_start` footprint (S8): callers bind its named prefix and
  // treat every other location by the variadic convention (source view only).
  // A context closure of the source interface keeps it too: the footprint
  // states which arguments are named for every caller.
  if (unit.variadic) {
    const variadic = nativeVariadicInterface(unit.variadic, observed.parameters);
    observed = {
      ...observed,
      variadic,
      ...(observed.source_interface
        ? { source_interface: { ...observed.source_interface, variadic } }
        : {}),
    };
  }
  if (unit.budget_truncated) {
    const { argument_list_closure: _closure, ...truncated } = observed;
    observed = {
      ...truncated,
      returns: [],
      return_types: [],
      written_result: { registers: [], types: [] },
      parameter_state: 'ambiguous',
    };
  }
  if (!unit.types) return observed;
  const indexed = nativeArgumentIndex(unit.ir, context);
  const transfers = nativeShapeTransfers(unit, interfaces, context, indexed);
  const types = transfers.length
    ? refineMemoryShapes(unit.ir, unit.types, context, {
        slice_id: input.image.selected_slice_id,
        revision: input.revision,
        max_work: context.remainingWork?.() ?? context.budget.work,
        transfers,
      })
    : unit.types;
  const parameters = [
    ...nativeArgumentValues(indexed, unit.analysis, unit.ir.id, observed, context),
  ].map(([parameter_index, value]) => ({ parameter_index, value }));
  return {
    ...observed,
    parameter_shapes: parameterMemoryShapes(types, parameters, context, {
      max_work: context.remainingWork?.() ?? context.budget.work,
    }),
  };
}

/** Optional native dependencies share at most half the actual work remaining
 * after selected-body analysis. Their local limits retain explicit metadata;
 * outer cancellation/deadline/work and selected-path invariants still propagate. */
export function recoverSourceEvidence(input: SourceFactsInput): SourceEvidence {
  const { scope, components, image, revision } = input,
    { context } = scope,
    abi = components.abi;
  const diagnostics: Diagnostic[] = [],
    evidence: Evidence[] = [];
  const demand_index = createCallResultDemandIndex(input.ir, abi, context);
  const observedCalls = observePreparedCallInterfaces(
    input.ir,
    abi,
    input.types.calls,
    context,
    demand_index,
  );
  // Exactly one record per call: a native dependency record already merges the
  // local observation for its call and replaces it.
  const callees = new Map<string, InferredCallee>(
    observedCalls.map((call) => [call.call_id, call]),
  );
  const sourceCallees = new Map(
    nativeLibraryTails(
      input.ir,
      image,
      input.functions,
      input.references,
      input.library,
      abi,
      context,
    ).map((callee) => [callee.call_id, callee]),
  );
  // Argument prefixes at unresolved indirect exits, for the exits the source
  // reconstruction proves to be tail calls (`classifyIndirectTails`).
  for (const tail of observePreparedTailInterfaces(input.ir, abi, context, demand_index))
    sourceCallees.set(tail.call_id, tail);
  let dependencies = nativeDependencies(input, input.ir, context, undefined, false, demand_index);
  const targets = new Map<string, FunctionRecord>();
  for (const dependency of dependencies) targets.set(dependency.target.id, dependency.target);
  const selectedNodes = nativeSelectedNodes(input.ir);
  const capacity = nativeCapacity(input, context);
  const summaryWorkLimit = Math.floor((context.remainingWork?.() ?? 0) / 2);
  let summaryWork = 0;
  const summaryContext: OperationContext = {
    ...context,
    budget: { ...context.budget, work: summaryWorkLimit },
    remainingWork: () => Math.max(0, summaryWorkLimit - summaryWork),
    // Charging the parent checks cancellation/deadline before the charge, so the local
    // limit needs a separate parent check only on the path that throws it; this keeps
    // one parent call per charge instead of doubling at every nesting level.
    checkpoint(work) {
      if (summaryWork + work > summaryWorkLimit) {
        context.checkpoint(0);
        throw new OperationError({
          code: 'resource_limit',
          severity: 'warning',
          message: 'Optional native summary work sub-budget exhausted',
          evidence_ids: [],
          details: {
            kind: 'limit',
            resource: 'work',
            limit: summaryWorkLimit,
            consumed: Math.min(summaryWork + work, Number.MAX_SAFE_INTEGER),
          },
        });
      }
      context.checkpoint(work);
      summaryWork += work;
    },
  };
  // Recovery stays inside the same optional pool: unfinished dependencies cannot
  // consume the allowance needed to retain proven root inputs and local results.
  const worklistWorkLimit = Math.floor((summaryWorkLimit * 3) / 4);
  let worklistWork = 0;
  const worklistContext: OperationContext = {
    ...summaryContext,
    budget: { ...summaryContext.budget, work: worklistWorkLimit },
    remainingWork: () => Math.max(0, worklistWorkLimit - worklistWork),
    checkpoint(work) {
      if (worklistWork + work > worklistWorkLimit) {
        summaryContext.checkpoint(0);
        throw new OperationError({
          code: 'resource_limit',
          severity: 'warning',
          message: 'Native dependency refinement work limit exceeded',
          evidence_ids: [],
          details: {
            kind: 'limit',
            resource: 'work',
            limit: worklistWorkLimit,
            consumed: Math.min(worklistWork + work, Number.MAX_SAFE_INTEGER),
          },
        });
      }
      summaryContext.checkpoint(work);
      worklistWork += work;
    },
  };
  const libraryContracts = targets.size ? nativeLibraryContracts(input) : [];
  const cache = preparedUnitCache(input);
  // Complete units of this request (the selected body first), in preparation order and
  // bounded as before. They are the only prepared bodies this request may cite as
  // result-use evidence, so that evidence never depends on other requests.
  const requestUnits = new Map<string, PreparedNativeUnit>();
  let requestUnitSize = 0;
  const admit = (id: string, unit: PreparedNativeUnit): void => {
    const size = preparedSize(unit);
    if (!requestUnits.has(id) && requestUnits.size < 64 && requestUnitSize + size <= 8192) {
      requestUnits.set(id, unit);
      requestUnitSize += size;
    }
  };
  const selected = input.functions.find((fn) => fn.id === input.ir.id);
  const selectedUnit: PreparedNativeUnit | undefined = selected
    ? {
        function: selected,
        ir: input.ir,
        types: input.types,
        analysis: input.types.calls,
        observed_calls: observedCalls,
        dependencies,
        instructions: input.instruction_count,
        blocks: input.ir.blocks.length,
        nodes: selectedNodes,
        required_nodes: input.required_nodes ?? selectedNodes,
        evidence: input.types.evidence,
        evidence_ids: selected.evidence_ids,
        reasons: input.coverage_reasons,
        budget_truncated: false,
        limited: false,
        arity_complete:
          input.coverage_reasons.length === 0 &&
          input.types.calls?.state === 'complete' &&
          input.types.calls.stack.state === 'complete',
        demand_index,
        interface_index: createNativeInterfaceIndex(input.ir, abi, summaryContext),
        ...(scope.dependencies ? { dependency_readset: scope.dependencies.finish() } : {}),
      }
    : undefined;
  if (
    selectedUnit &&
    input.required_nodes !== undefined &&
    input.types.state === 'complete' &&
    selectedUnit.analysis?.state === 'complete' &&
    !selectedUnit.reasons.length
  )
    admit(input.ir.id, selectedUnit);
  const loadUnit = nativeUnitLoader(
    input,
    cache,
    libraryContracts,
    (work, reads) =>
      work <= (summaryContext.remainingWork?.() ?? 0) &&
      work + reads <= (context.remainingWork?.() ?? 0),
  );
  const likelyMode = input.identity?.options.inference === 'likely';
  const calleeReadsCalls = new Set<string>();
  const nativeSummaries = new Map<string, NativeInterface>();
  let likely_arity: SourceEvidence['likely_arity'];
  let likely_types: SourceEvidence['likely_types'];
  let memory_transfers: readonly MemoryShapeTransfer[] = [];
  let function_returns: SourceEvidence['function_returns'];
  let partialUnits: ReadonlyMap<string, PreparedNativeUnit> = new Map();
  let partialSummaries: ReadonlyMap<string, NativeSummary> = new Map();
  const summarized = new Set<string>();
  const returnDemands = new Map<string, RegisterDescriptor[]>();
  for (const dependency of dependencies) {
    const known = returnDemands.get(dependency.target.id) ?? [];
    known.push(...(dependency.return_demand ?? []));
    returnDemands.set(dependency.target.id, known);
  }
  try {
    // Constant/identity discovery is optional native work too, not an extra
    // unmetered pass before the existing shared half-remaining allowance.
    dependencies = nativeDependencies(
      input,
      input.ir,
      worklistContext,
      undefined,
      true,
      demand_index,
    );
    const result = nativeDependencyWorklist({
      roots: [],
      root_dependencies: dependencies,
      context: worklistContext,
      capacity,
      max_functions: 64,
      max_refinements: 64,
      max_contexts_per_function: 4,
      max_contexts: 64,
      specialize: (baseline, assumptions, boundedContext) =>
        prepareNativeContext(input, baseline, assumptions, boundedContext, libraryContracts),
      on_partial(units, summaries) {
        partialUnits = units;
        partialSummaries = summaries;
      },
      ...(selectedUnit ? { preloaded: new Map([[input.ir.id, selectedUnit]]) } : {}),
      load(fn, boundedContext) {
        let unit = loadUnit(fn, boundedContext);
        if (scope.dependencies) unit = { ...unit, dependency_readset: scope.dependencies.finish() };
        if (reusablePreparation(unit)) admit(fn.id, unit);
        return unit;
      },
      argument_reaching: (unit, boundedContext) =>
        nativeArgumentReaching(input, unit, boundedContext),
      initialize: (unit, boundedContext, demand) =>
        observeNativeUnit(input, unit, new Map(), boundedContext, demand, true),
      observe: (unit, summaries, boundedContext, demand) =>
        observeNativeUnit(input, unit, summaries, boundedContext, demand, false),
      equal: (left, right) =>
        fingerprint(left as unknown as CanonicalValue) ===
        fingerprint(right as unknown as CanonicalValue),
    });
    partialUnits = result.units;
    for (const unit of result.units.values()) evidence.push(...unit.evidence);
    const interfaces = new Map<string, NativeInterface>();
    for (const dependency of dependencies) {
      const key =
        result.context_keys.get(nativeContextKey(dependency.target.id, dependency.assumptions)) ??
        dependency.target.id;
      const summary = result.summaries.get(key);
      const observed = mergeNativeInterface(
        summary?.observed,
        observedCalls.find((call) => call.call_id === dependency.call_id),
        abi,
        summaryContext,
      );
      interfaces.set(dependency.call_id, observed);
      if (summary) nativeSummaries.set(dependency.call_id, summary.observed);
      if (
        likelyMode &&
        calleeReadsGuess(
          summary,
          observedCalls.find((call) => call.call_id === dependency.call_id),
        )
      )
        calleeReadsCalls.add(dependency.call_id);
      const {
        parameter_shapes,
        written_result: _written,
        argument_reaching_calls: _reaching,
        argument_list_closure,
        source_interface,
        ...interface_
      } = observed;
      const proofIds = [...(summary?.evidence_ids ?? dependency.target.evidence_ids)];
      if (dependency.assumptions) {
        const readsetHash = scope.dependencies?.readsetFingerprint(scope.dependencies.finish());
        const proof: Evidence = {
          id: `evidence_${fingerprint([image.id, revision, dependency.call_id, key, 'context-use'])}`,
          origin: {
            kind: 'analysis',
            analyzer: 'native-context',
            version: '1',
            rule: 'proven whole ABI caller context use',
          },
          claim:
            `Original semantic subjects ${(dependency.original_subject_ids ?? [input.ir.id, dependency.call_id]).join(', ')}; ` +
            `callee ${dependency.target.id}; requested ${nativeContextKey(dependency.target.id, dependency.assumptions)}; ` +
            `effective ${key}; constants ${dependency.assumptions.constants
              .map(
                ({ register, bits }) =>
                  `${register.root}[${register.offset_bits}:${register.width_bits}]=${bits}`,
              )
              .join(', ')}; ` +
            `identity aliases ${dependency.assumptions.aliases.map((group) => group.map((register) => register.root).join('=')).join(', ')}; ` +
            `type/evidence scope ${dependency.assumptions.type_evidence_scope}; ` +
            `complete positive/negative dependency scope ${readsetHash ?? 'unavailable (no reuse ledger)'}; ` +
            `result storage ${observed.returns.map((register) => `${register.root}:${register.width_bits}`).join(', ')}; ` +
            'input assumptions do not establish complete source arity, disjoint aliases, object bounds, or source field names',
          derived_from: [...new Set([...proofIds, ...(dependency.evidence_ids ?? [])])],
          conflicts_with: [],
          revision,
        };
        evidence.push(proof);
        proofIds.push(proof.id);
      }
      callees.set(dependency.call_id, {
        call_id: dependency.call_id,
        target: dependency.target.entry,
        target_subject_id: dependency.target.id,
        ...interface_,
        // Optional source metadata can remain partial (for example absent DWARF)
        // while the bounded machine call/stack summary proves complete reads.
        ...(argument_list_closure && summary?.arity_complete ? { argument_list_closure } : {}),
        evidence_ids: proofIds,
      });
      if (source_interface && summary?.arity_complete) {
        const { argument_reaching_calls: _sourceReaching, ...sourceInterface } = source_interface;
        sourceCallees.set(dependency.call_id, {
          ...sourceInterface,
          call_id: dependency.call_id,
          target: dependency.target.entry,
          target_subject_id: dependency.target.id,
          evidence_ids: proofIds,
        });
      }
      summarized.add(dependency.call_id);
      for (const shape of parameter_shapes ?? []) evidence.push(...shape.evidence);
      if (summary?.reasons.length)
        diagnostics.push({
          // A callee cut by a bounded share is a budget limit, not unsupported semantics.
          code: summary.reasons.some(budgetReason) ? 'resource_limit' : 'unavailable_semantics',
          severity: 'warning',
          message: `Native callee ${dependency.target.original_name ?? dependency.target.id} remains partial: ${summary.reasons.join('; ')}`,
          entity_id: dependency.target.id,
          evidence_ids: dependency.target.evidence_ids,
          details: {
            kind: 'callee_partial',
            callee: dependency.target.original_name ?? dependency.target.id,
          },
        });
    }
    if (likelyMode) {
      const likely = likelyArities(
        {
          input,
          selected: selectedUnit,
          load: loadUnit,
          context: summaryContext,
          capacity: result.remaining,
          callees,
          summaries: nativeSummaries,
        },
        calleeReadsCalls,
      );
      likely_arity = likely.guesses;
      diagnostics.push(...likely.diagnostics);
      const typed = likelyTypes({
        input,
        selected: selectedUnit,
        load: loadUnit,
        context: summaryContext,
        capacity: result.remaining,
        callees,
        summaries: nativeSummaries,
      });
      likely_types = typed.types;
      diagnostics.push(...typed.diagnostics);
    }
    if (selectedUnit)
      memory_transfers = nativeShapeTransfers(selectedUnit, interfaces, summaryContext);
    function_returns = nativeReturnInterface(
      input.ir,
      abi,
      input.types.calls,
      interfaces,
      summaryContext,
      false,
      [],
      false,
      selectedUnit?.interface_index,
    ).written_result;
  } catch (error) {
    const details = error instanceof OperationError ? error.diagnostic.details : undefined;
    if (
      !(error instanceof OperationError) ||
      error.code !== 'resource_limit' ||
      details?.kind !== 'limit' ||
      details.resource !== 'work' ||
      details.limit > summaryWorkLimit
    )
      throw error;
    context.checkpoint(0);
    diagnostics.push({
      code: 'resource_limit',
      severity: 'warning',
      message: `Native dependency worklist stopped at its work sub-budget (${details.limit}); selected-body analysis remains available and unfinished interfaces remain unresolved`,
      evidence_ids: [],
      details,
    });
    for (const dependency of dependencies) {
      // A record finished before the cut keeps its established facts; the
      // conservative fallback only covers calls the summary loop never reached.
      if (summarized.has(dependency.call_id)) continue;
      const unit = partialUnits.get(dependency.target.id),
        prior = partialSummaries.get(dependency.target.id)?.observed ?? unit?.entry_prefix;
      let observed: NativeInterface = {
        ...prior,
        parameters: prior?.parameters ?? [],
        returns: [],
        parameter_state: 'ambiguous',
        argument_list_complete: false,
      };
      if (unit?.ir) {
        try {
          const returned = nativeReturnInterface(
            unit.ir,
            abi,
            unit.analysis,
            new Map(),
            summaryContext,
            false,
            returnDemands.get(dependency.target.id) ?? [],
            false,
            unit.interface_index,
          );
          const inputs = nativeEntryRegisters(
            unit.ir,
            parameterRegisters(abi),
            new Map(),
            returned.returns,
            summaryContext,
            unit.interface_index,
          );
          const parameters = new Map(
            (prior?.parameters ?? []).map((register) => [register.root, register]),
          );
          for (const register of inputs) {
            const previous = parameters.get(register.root);
            if (!previous || previous.width_bits < register.width_bits)
              parameters.set(register.root, register);
          }
          const ordered = parameterRegisters(abi).flatMap(
            (register) => parameters.get(register.root) ?? [],
          );
          observed = {
            ...observed,
            ...returned,
            parameters: ordered,
            parameter_types: ordered.map((register) => ({
              kind: 'integer',
              bits: register.width_bits,
            })),
          };
        } catch (recoveryError) {
          const recoveryDetails =
            recoveryError instanceof OperationError ? recoveryError.diagnostic.details : undefined;
          if (
            !(recoveryError instanceof OperationError) ||
            recoveryError.code !== 'resource_limit' ||
            recoveryDetails?.kind !== 'limit' ||
            recoveryDetails.resource !== 'work' ||
            recoveryDetails.limit > summaryWorkLimit
          )
            throw recoveryError;
          context.checkpoint(0);
        }
      }
      // The callee record cites this unit's graph-refined function proofs even when
      // SSA preparation stopped, so its graph evidence is published either way.
      if (unit) evidence.push(...unit.evidence);
      // The escape is a property of the prepared body; a context-specialized
      // dependency is keyed by its context, not by the function identity.
      const body =
        unit ?? partialUnits.get(nativeContextKey(dependency.target.id, dependency.assumptions));
      const variadicStack =
        body?.ir &&
        body.analysis &&
        nativeIncomingStackEscapes(body.ir, abi, body.analysis, context)
          ? body
          : undefined;
      if (variadicStack) {
        observed = { ...observed, variadic_stack: true };
        if (!unit) evidence.push(...variadicStack.evidence);
      }
      observed = mergeNativeInterface(
        observed,
        observedCalls.find((call) => call.call_id === dependency.call_id),
        abi,
        context,
      );
      // Unfinished worklists never close an argument list.
      const {
        parameter_shapes: _shapes,
        written_result: _written,
        argument_list_closure: _closure,
        argument_reaching_calls: _reaching,
        source_interface: _sourceInterface,
        ...interface_
      } = observed;
      callees.set(dependency.call_id, {
        call_id: dependency.call_id,
        target: dependency.target.entry,
        target_subject_id: dependency.target.id,
        ...interface_,
        evidence_ids: (unit ?? variadicStack)?.evidence_ids ?? dependency.target.evidence_ids,
      });
    }
  }
  // Positive result-use evidence only. Reuse units already prepared by native
  // analysis; the incoming-caller scan below runs only on the planner's demand.
  // A self-call result that reaches only this function's own return exit is
  // circular: under the result-storage premise the self-call is one of the
  // callers, so this function's own unit contributes only semantic demand.
  const functionReturnDemands = new Map<string, RegisterDescriptor>();
  const preparedUnits = new Set([...partialUnits.values(), ...requestUnits.values()]);
  for (const unit of preparedUnits) {
    context.checkpoint(1);
    const own = unit.function.id === input.ir.id;
    for (const dependency of unit.dependencies) {
      context.checkpoint(1);
      if (dependency.target.id !== input.ir.id) continue;
      for (const register of (own ? dependency.return_demand_semantic : dependency.return_demand) ??
        []) {
        functionReturnDemands.set(
          `${register.root}:${register.offset_bits}:${register.width_bits}`,
          register,
        );
      }
      if (scope.dependencies && unit.dependency_readset)
        scope.dependencies.replay(unit.dependency_readset);
    }
  }
  // Incoming caller sites are scanned only when the planner asks for them.
  let callerDemand: CallerResultDemand | null | undefined;
  const callerDemands = (scanContext: OperationContext): CallerResultDemand | undefined =>
    (callerDemand ??= callerResultDemands(input, preparedUnits, scanContext) ?? null) ?? undefined;
  const ruleCalls = variadicRuleCalls(input.ir, input.types.calls, input.library, context);
  const objc = objcSourceFacts({
    ir: input.ir,
    image,
    revision,
    functions: input.functions,
    references: input.references,
    abi,
    context,
    callees,
    addresses: sourceAddresses(
      input,
      ruleCalls.flatMap((call) => (call.kind === 'open_flags' ? [] : call.values)),
    ),
  });
  for (const callee of objc.callees) sourceCallees.set(callee.call_id, callee);
  evidence.push(...objc.evidence);
  const addresses = objc.addresses;
  const variadic = variadicRuleFacts(ruleCalls, addresses, abi, context);
  return {
    abi,
    callees: [...callees.values()],
    source_callees: [...sourceCallees.values()],
    diagnostics,
    evidence,
    addresses,
    executable_ranges: image.mappings
      .filter((mapping) => mapping.permissions.includes('execute'))
      .map((mapping) => ({ start: mapping.va, end: mapping.va + mapping.memory_size })),
    ...(objc.facts ? { objc: objc.facts } : {}),
    memory_transfers,
    function_return_demands: [...functionReturnDemands.values()],
    caller_result_demands: callerDemands,
    ...(function_returns === undefined ? {} : { function_returns }),
    ...(likely_arity === undefined ? {} : { likely_arity }),
    ...(likely_types === undefined ? {} : { likely_types }),
    call_argument_counts: variadic.counts,
    call_argument_signatures: variadic.signatures,
  };
}
