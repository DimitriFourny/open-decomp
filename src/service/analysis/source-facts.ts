import type { AbiProfile, AbiType, Address, FunctionRecord, Lifter, LoadedImage, OperationContext, ReferenceRecord, RegisterDescriptor } from '../../core/index.js';
import { U64_LIMIT } from '../../core/index.js';
import { analyzeCalls, type CallAnalysisResult, type SuppliedCallContract } from '../../analysis/calls/index.js';
import { constructSSA } from '../../analysis/ssa/index.js';
import { simplifySSA } from '../../analysis/values/index.js';
import { inspectRegister, type StackFact } from '../../analysis/stack/index.js';
import type { SuppliedTypeRecord, TypeRecoveryResult } from '../../analysis/types/index.js';
import type { RegisterIR, SSAForm, Value } from '../../ir/index.js';
import type { DebugRecovery } from '../../metadata/debug/index.js';
import type { LibraryContracts } from '../../metadata/library-contracts/index.js';
import type { InferredCallee, SourceAddress, SourceEvidence } from '../../reconstruction/source-model.js';
import { loadFunctionGraph, records } from '../queries/scope.js';
import type { AnalysisScope } from './index.js';
import { callDeclarations, resolveCalls, type CallScope } from './calls.js';
import { boundIR, requirePass } from './passes.js';

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
const addressKey = (address: Address): string => `${address.image_id}:${address.space}:${address.value}`;

/** Enumerate register capabilities through the selected ABI, never register names
 * or the host. Integer and floating banks have independent allocation sequences. */
function parameterRegisters(abi: AbiProfile): readonly RegisterDescriptor[] {
  const registers = new Map<string, RegisterDescriptor>();
  for (const type of [{ kind: 'pointer' }, { kind: 'float', bits: 64 }] as const) {
    const parameters: AbiType[] = Array.from({ length: 16 }, () => type);
    const layout = abi.classifyCall({ returns: { kind: 'void' }, parameters, variadic: false, fixed_parameter_count: parameters.length });
    for (const parameter of layout.parameters) for (const location of parameter.locations) if (location.kind === 'register' && !registers.has(location.register.root)) registers.set(location.register.root, location.register);
  }
  return [...registers.values()];
}

/** Roots count only when they reach semantic observations. Physical snapshots,
 * phi transport, register clobbers, private spills and preservation are not uses. */
function observeParameters(ir: SSAForm, abi: AbiProfile, analysis: CallAnalysisResult, context: OperationContext): Pick<InferredCallee, 'parameters' | 'returns' | 'parameter_state'> {
  const candidates = parameterRegisters(abi), byRoot = new Map(candidates.map(register => [register.root, register]));
  const observed = new Map<string, RegisterDescriptor>();
  let ambiguous = analysis.state !== 'complete' || analysis.stack.accesses.some(access => access.kind === 'read' && (access.region === 'incoming_candidate' || access.region === 'mixed'));
  const note = (fact: StackFact | undefined): void => {
    for (const register of fact?.incoming_registers ?? []) {
      context.checkpoint(1);
      const candidate = byRoot.get(register.root);
      if (abi.preserved.some(preserved => preserved.root === register.root)) continue;
      if (!candidate) { if (register.role === 'general') ambiguous = true; continue; }
      const prior = observed.get(register.root);
      const width = Math.max(prior?.width_bits ?? 0, register.offset_bits + register.width_bits);
      observed.set(register.root, { ...candidate, width_bits: Math.min(candidate.width_bits, width) });
    }
  };
  const use = (value: Value): void => note(analysis.stack.values.get(value.id));
  const calls = new Map(analysis.calls.map(call => [call.node_id, call]));
  for (const block of ir.blocks) {
    if (!analysis.stack.snapshots.has(block.terminator.id)) continue;
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
        const contracts = call?.contracts.filter(contract => contract.status === 'established' && contract.layout.state === 'complete') ?? [];
        if (!contracts.length || call?.status === 'conflicting') ambiguous = true;
        for (const contract of contracts) {
          for (const parameter of contract.parameters) for (const location of parameter.locations) note(location.fact);
          if (contract.layout.argument_count === null) ambiguous = true;
        }
      } else if (node.kind === 'unknown_effect') ambiguous = true;
    }
    const terminator = block.terminator;
    if (terminator.kind === 'branch') use(terminator.condition);
    else if (terminator.kind === 'switch') use(terminator.value);
    else if (terminator.kind === 'indirect') { use(terminator.target); ambiguous = true; }
    else if (terminator.kind === 'unknown') ambiguous = true;
    else if (terminator.kind === 'return') for (const value of terminator.values) use(value);
  }
  // Return only actually written primary-result slices, common to every exit.
  // An unchanged incoming register or unrelated caller-saved output is no proof.
  const primary = abi.classifyCall({ returns: { kind: 'pointer' }, parameters: [], variadic: false, fixed_parameter_count: 0 }).returns.find(location => location.kind === 'register');
  const exits = ir.blocks.filter(block => block.terminator.kind === 'return');
  const entryBindings = ir.register_states.find(row => row.block === ir.entry)?.entry ?? [];
  let returns: RegisterDescriptor[] = [];
  if (primary?.kind === 'register' && exits.length) {
    const slices = ir.register_states.find(row => row.block === exits[0]!.id)?.exit ?? [];
    returns = slices.filter(binding => binding.register.root === primary.register.root && binding.register.offset_bits === 0 && exits.every(exit => {
      context.checkpoint(1);
      const snapshot = analysis.stack.snapshots.get(exit.terminator.id);
      if (!snapshot) return false;
      const fact = inspectRegister(snapshot, binding.register);
      const incoming = entryBindings.find(item => item.register.id === binding.register.id);
      const output = ir.register_states.find(row => row.block === exit.id)?.exit.find(item => item.register.id === binding.register.id);
      return output !== undefined && output.value.id !== incoming?.value.id && fact.initialization !== 'uninitialized';
    })).map(binding => binding.register);
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
  return { parameters: candidates.flatMap(candidate => observed.has(candidate.root) ? [observed.get(candidate.root)!] : []), returns, parameter_state: ambiguous ? 'ambiguous' : 'observed' };
}

/** Existing nominal library rules may close a variadic prefix. Zero open flags
 * require no mode on the supported POSIX/CRT ABIs; unknown/nonzero flags do not
 * acquire a guessed target-specific flag mask or invented trailing arguments. */
function actualArgumentCounts(analysis: CallAnalysisResult | null, library: LibraryContracts, context: OperationContext): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const call of analysis?.calls ?? []) {
    context.checkpoint(1);
    if (call.status === 'conflicting') continue;
    const observations = call.contracts.filter(observation => observation.status === 'established');
    if (!observations.length) continue;
    const proven = new Set<number>();
    let complete = true;
    for (const observation of observations) {
      const contract = library.contracts.find(item => item.id === observation.contract.id || `${item.id}:entry` === observation.contract.id);
      if (!contract || contract.conflicts_with.length || contract.variadic_rule?.kind !== 'open_flags') { complete = false; break; }
      const flags = observation.parameters.find(parameter => parameter.index === contract.variadic_rule!.argument)?.locations;
      if (flags?.length !== 1 || flags[0]!.fact.value.kind !== 'constant' || flags[0]!.fact.value.bits !== 0n) { complete = false; break; }
      proven.add(contract.abi_signature.fixed_parameter_count);
    }
    if (complete && proven.size === 1) counts.set(call.node_id, [...proven][0]!);
  }
  return counts;
}

/** Read only address-qualified, file-backed, immutable data sections. Mach-O
 * __TEXT contains both code and cstrings: instruction flags, not segment execute
 * permission, distinguish its data sections (the same rule as the string index). */
function stringAt(image: LoadedImage, address: Address, context: OperationContext): string | undefined {
  if (address.image_id !== image.id) return undefined;
  const translated = image.address_map.translate(address, 'va');
  if (translated.kind !== 'mapped') return undefined;
  const section = image.sections.find(section => section.kind === 'section' && section.file_range !== null && section.permissions.includes('read') && !section.permissions.includes('write')
    && (image.target.format === 'macho' ? (section.flags & 0x80000400n) === 0n && (section.flags & 255n) !== 8n : !section.permissions.includes('execute'))
    && translated.address.value >= section.virtual_range.start.value && translated.address.value < section.virtual_range.start.value + section.virtual_range.size);
  if (!section?.file_range) return undefined;
  const offset = translated.address.value - section.virtual_range.start.value;
  const remaining = section.file_range.size - offset;
  if (remaining <= 0n) return undefined;
  const file = image.address_map.translate(translated.address, 'file');
  if (file.kind !== 'mapped') return undefined;
  const limit = Number(remaining < 4096n ? remaining : 4096n);
  let length = 0;
  while (length < limit && image.bytes.at(Number(file.address.value) + length) !== 0) { context.checkpoint(1); length++; }
  if (length === limit || length === 0) return undefined;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(image.bytes.read(file.address.value, length));
    return /^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}\t\r\n]+$/u.test(text) ? text : undefined;
  } catch { return undefined; }
}

function sourceAddresses(input: SourceFactsInput): readonly SourceAddress[] {
  const { image, scope, revision } = input, context = scope.context;
  const candidates = new Map<string, Address>();
  for (const fact of input.types.calls?.stack.values.values() ?? []) {
    context.checkpoint(1);
    const address: Address | undefined = fact.value.kind === 'address' ? fact.value.address : fact.value.kind === 'constant' && fact.value.bits >= 0n && fact.value.bits < U64_LIMIT ? { image_id: image.id, space: 'va', value: fact.value.bits } : undefined;
    if (address) candidates.set(addressKey(address), address);
  }
  for (const block of input.ir.blocks) for (const node of block.instructions) if (node.kind === 'assign' && node.expression.kind === 'address') candidates.set(addressKey(node.expression.address), node.expression.address);
  // ABI pointer arguments may consist only of split register cells in SSA.
  // Their observed whole value still identifies a literal, without turning
  // arbitrary integer constants or writable pointer slots into source strings.
  for (const call of input.types.calls?.calls ?? []) for (const contract of call.contracts) {
    context.checkpoint(1);
    if (contract.status !== 'established') continue;
    for (const parameter of contract.parameters) {
      if (contract.contract.signature.parameters?.[parameter.index]?.kind !== 'pointer') continue;
      for (const location of parameter.locations) {
        context.checkpoint(1);
        const value = location.fact.value;
        const address: Address | undefined = value.kind === 'address' ? value.address : value.kind === 'constant' && value.bits >= 0n && value.bits < U64_LIMIT ? { image_id: image.id, space: 'va', value: value.bits } : undefined;
        if (address) candidates.set(addressKey(address), address);
      }
    }
  }
  const names = new Map<string, Set<string>>();
  for (const symbol of records(scope, revision, image.id, 'symbol').items) {
    context.checkpoint(1);
    if (!symbol.address || !candidates.has(addressKey(symbol.address))) continue;
    const annotations = scope.store.readAnnotations(symbol.id, revision).filter(annotation => annotation.value.kind === 'name' && annotation.status !== 'retracted');
    const asserted = new Set(annotations.flatMap(annotation => annotation.status === 'asserted' && annotation.value.kind === 'name' ? [annotation.value.value] : []));
    const name = asserted.size === 1 ? [...asserted][0] : annotations.length ? undefined : symbol.display_name ?? symbol.original_name;
    if (name) { const key = addressKey(symbol.address), values = names.get(key) ?? new Set<string>(); values.add(name); names.set(key, values); }
  }
  const result: SourceAddress[] = [];
  for (const [key, address] of candidates) {
    context.checkpoint(1);
    const aliases = names.get(key), name = aliases?.size === 1 ? [...aliases][0] : undefined;
    const string = stringAt(image, address, context);
    if (name !== undefined || string !== undefined) result.push({ address, ...(name === undefined ? {} : { name }), ...(string === undefined ? {} : { string }) });
  }
  return result;
}

/** Single-level native observation. Each unique exact native target is lifted and
 * analyzed once, with the operation's cumulative work/cancellation and remaining
 * instruction/IR/block budgets. Nothing is persisted as a proven prototype. */
export function recoverSourceEvidence(input: SourceFactsInput): SourceEvidence {
  const { scope, components, image, revision } = input, { context } = scope, abi = components.abi;
  const callees: InferredCallee[] = [], targets = new Map<string, { fn: FunctionRecord; call_ids: string[] }>();
  const nodes = new Map(input.ir.blocks.flatMap(block => block.instructions).map(node => [node.id, node]));
  const importedCalls = new Set(image.imports.flatMap(imported => (input.calls.calls_by_subject.get(imported.id) ?? []).map(use => use.call_id)));
  for (const fn of input.functions) for (const use of input.calls.calls_by_subject.get(fn.id) ?? []) {
    context.checkpoint(1);
    if (importedCalls.has(use.call_id)) continue;
    if (use.target.kind !== 'address' || addressKey(use.target.address) !== addressKey(fn.entry)) continue;
    const node = nodes.get(use.call_id);
    if (node?.kind !== 'call' || node.target.kind !== 'direct' || addressKey(node.target.address) !== addressKey(fn.entry)) continue;
    const key = addressKey(fn.entry), target = targets.get(key) ?? { fn, call_ids: [] };
    target.call_ids.push(use.call_id); targets.set(key, target);
  }
  let remainingNodes = context.budget.ir_nodes - input.ir.blocks.reduce((count, block) => count + 3 + block.parameters.length + block.instructions.length, 0);
  let remainingBlocks = context.budget.blocks - input.ir.blocks.length, remainingInstructions = context.budget.instructions - input.instruction_count;
  const libraryContracts: SuppliedCallContract[] = input.library.contracts.filter(contract => contract.abi_state === 'supported' && !contract.conflicts_with.length).map(contract => ({ id: contract.id, target: { kind: 'import', image_id: image.id, import_id: contract.import_id }, signature: contract.abi_signature, noreturn: contract.noreturn, evidence_ids: contract.evidence_ids }));
  for (const { fn, call_ids } of targets.values()) {
    context.checkpoint(1);
    let observed: Pick<InferredCallee, 'parameters' | 'returns' | 'parameter_state'> = { parameters: [], returns: [], parameter_state: 'ambiguous' };
    if (remainingNodes > 0 && remainingBlocks > 0 && remainingInstructions > 0 && fn.id !== input.ir.id) {
      const boundedContext: OperationContext = { ...context, budget: { ...context.budget, ir_nodes: remainingNodes, blocks: remainingBlocks, instructions: remainingInstructions } };
      const graph = loadFunctionGraph({ ...scope, context: boundedContext }, revision, { image, function: fn });
      remainingInstructions -= graph.instructions.length;
      if (graph.coverage.state === 'complete') {
        const passOptions = { max_work: context.budget.work, max_ir_nodes: remainingNodes, max_blocks: remainingBlocks, checkpoint: (work: number) => context.checkpoint(work) };
        const lifted = components.lifter.lift(graph, abi, boundedContext); boundIR(lifted.ir, boundedContext);
        const constructed = constructSSA(lifted.ir, passOptions); requirePass(constructed.state, constructed.diagnostics, context);
        if (constructed.value.form === 'ssa') {
          boundIR(constructed.value, boundedContext);
          const simplified = simplifySSA(constructed.value, passOptions); requirePass(simplified.state, simplified.diagnostics, context);
          const ir = simplified.value; boundIR(ir, boundedContext);
          remainingNodes -= ir.blocks.reduce((count, block) => count + 3 + block.parameters.length + block.instructions.length, 0); remainingBlocks -= ir.blocks.length;
          const calls = resolveCalls(ir, image, input.functions, input.references, false, context);
          const declarations = callDeclarations(ir, image, revision, calls, input.debug, [], input.native_types, context, abi.layout);
          const analysis = analyzeCalls(ir, abi, context, { max_work: context.budget.work, contracts: [...libraryContracts, ...declarations.contracts], resolutions: calls.resolutions });
          requirePass(analysis.state, analysis.diagnostics, context);
          observed = observeParameters(ir, abi, analysis, context);
        }
      }
    }
    for (const call_id of new Set(call_ids)) callees.push({ call_id, ...observed, evidence_ids: fn.evidence_ids });
  }
  return { abi, callees, addresses: sourceAddresses(input), call_argument_counts: actualArgumentCounts(input.types.calls, input.library, context) };
}
