import { fingerprint, type AbiCallLayout, type AbiLocation, type AbiProfile, type AbiSignature, type Address, type CanonicalValue, type Diagnostic, type EntityId, type OperationContext, type RegisterDescriptor } from '../../core/index.js';
import { expressionOperands } from '../../ir/index.js';
import type { SSAForm, Value } from '../../ir/index.js';
import { AnalysisBudget } from '../ssa/budget.js';
import { inspectRegister, inspectStackMemory, recoverStack, type StackFact, type StackRecoveryOptions, type StackRecoveryResult, type StackSnapshot } from '../stack/index.js';

export type ContractTarget = { readonly kind: 'address'; readonly address: Address }
  | { readonly kind: 'import'; readonly image_id: string; readonly import_id: string };
export interface SuppliedFunctionContract {
  readonly id: string;
  readonly signature: AbiSignature;
  readonly noreturn?: boolean;
  readonly evidence_ids: readonly string[];
}
export interface SuppliedCallContract extends SuppliedFunctionContract { readonly target: ContractTarget }
export interface SuppliedCallResolution {
  readonly call_id: EntityId;
  readonly target: ContractTarget;
  readonly status: 'established' | 'candidate';
  readonly evidence_ids: readonly string[];
  /** Storage is provenance only: never a callable address or a matching key. */
  readonly pointer_storage?: Address;
}
export interface CallAnalysisOptions extends StackRecoveryOptions {
  readonly contracts?: readonly SuppliedCallContract[];
  readonly function_contracts?: readonly SuppliedFunctionContract[];
  readonly resolutions?: readonly SuppliedCallResolution[];
}
export interface LocationObservation {
  readonly location: AbiLocation;
  readonly fact: StackFact;
  /** Present for by-reference aggregate locations, independently of pointer initialization. */
  readonly pointee: StackFact | null;
  readonly stack_offset: bigint | null;
}
export interface ContractObservation {
  readonly contract: SuppliedFunctionContract;
  readonly status: 'candidate' | 'established' | 'conflicting';
  /** Return/call boundary observed; null means no actual return exists. */
  readonly boundary_id: EntityId | null;
  readonly layout: AbiCallLayout;
  readonly parameters: readonly { readonly index: number; readonly locations: readonly LocationObservation[] }[];
  readonly hidden_result: LocationObservation | null;
  readonly returns: readonly LocationObservation[];
}
export interface CallFact {
  readonly node_id: EntityId;
  readonly targets: readonly SuppliedCallResolution[];
  readonly status: 'unresolved' | 'candidate' | 'established' | 'conflicting';
  readonly contracts: readonly (ContractObservation & { readonly contract: SuppliedCallContract })[];
  /** Candidates never establish arity, parameter types, or initialized arguments. */
  readonly register_candidates: readonly { readonly register: RegisterDescriptor; readonly fact: StackFact }[];
  readonly explicit_arguments: readonly StackFact[];
  readonly noreturn: 'unknown' | 'yes' | 'no' | 'conflicting';
  readonly evidence_ids: readonly string[];
}
export interface CallAnalysisResult {
  readonly state: 'complete' | 'partial'; readonly diagnostics: readonly Diagnostic[]; readonly work: number;
  readonly stack: StackRecoveryResult;
  readonly calls: readonly CallFact[];
  readonly function_contracts: readonly ContractObservation[];
  readonly parameter_candidates: readonly { readonly register: RegisterDescriptor; readonly uses: readonly EntityId[] }[];
  readonly return_candidates: readonly { readonly node_id: EntityId; readonly registers: StackSnapshot['registers']; readonly explicit_values: readonly StackFact[] }[];
  readonly function_contract_status: 'unknown' | 'established' | 'conflicting';
}
const unknown: StackFact = Object.freeze({ value: { kind: 'unknown' as const }, initialization: 'unknown', value_ids: [], evidence_ids: [], incoming_registers: [] });
function targetKey(target: ContractTarget): string {
  return target.kind === 'address' ? fingerprint([target.kind, target.address.image_id, target.address.space, target.address.value]) : fingerprint([target.kind, target.image_id, target.import_id]);
}
function contractKey(contract: SuppliedFunctionContract): string {
  return fingerprint({ ...contract.signature, calling_convention: contract.signature.calling_convention ?? 'default', prototyped: contract.signature.prototyped ?? true } as unknown as CanonicalValue);
}
function conflicting(contracts: readonly SuppliedFunctionContract[]): boolean {
  return new Set(contracts.map(contractKey)).size > 1 || new Set(contracts.flatMap(contract => contract.noreturn === undefined ? [] : [contract.noreturn])).size > 1;
}

/** Nonrewriting ABI observations, not prototype inference. Contracts are explicit
 * typed inputs; names never establish signatures. Exact image/address-space keys
 * or image-qualified import identities match targets, never pointer-storage slots.
 * Proven indirect address values and supplied established resolutions are supported;
 * writable-slot contents, arbitrary constants and candidate resolutions are not proofs.
 * All matching conflicting contracts/targets survive. Layouts come exclusively from
 * classifyCall (including fixed/anonymous varargs, aggregates and hidden results).
 * One established import identity may qualify one direct callable/stub address;
 * distinct established addresses or distinct import identities remain conflicts.
 * A layout does not initialize registers, home slots, outgoing bytes or pointees.
 * Unknown parameter count stays null; register candidates never become parameters.
 * Return facts describe actual SSA output/clobber values, not invented call results.
 * Noreturn is reported only from unopposed established supplied contracts; effects
 * and CFG remain untouched even when continuation contradicts the supplied claim.
 * IR calls expose callee-entry SP: the x86 lifter explicitly pushes the hardware
 * return address before the call and restores caller SP afterward. Thus +40 is
 * used directly, never adjusted twice; Darwin has no push. No vararg-count guessing.
 * Total work is shared with stack recovery (default one million units). Supplied
 * aggregate layouts are traversed with a depth bound of 64; pointee observations
 * beyond 65536 bytes stay unknown. External memory contents are never read here.
 */
export function analyzeCalls(input: SSAForm, abi: AbiProfile, context: OperationContext, options: CallAnalysisOptions = {}): CallAnalysisResult {
  const stack = recoverStack(input, abi, context, options);
  const budget = new AnalysisBudget({ ...options, max_work: Math.max(0, (options.max_work ?? 1_000_000) - stack.work), checkpoint: work => context.checkpoint(work) });
  const empty = { stack, calls: [], function_contracts: [], parameter_candidates: [], return_candidates: [], function_contract_status: 'unknown' as const };
  if (stack.state === 'partial') return { ...empty, state: 'partial', diagnostics: stack.diagnostics, work: stack.work };
  try {
    budget.charge(0);
    const diagnostics: Diagnostic[] = [];
    const report = (message: string, evidence_ids: readonly string[]): void => { diagnostics.push({ code: 'unavailable_semantics', severity: 'warning', message, evidence_ids: [...evidence_ids] }); };
    const boundContract = (contract: SuppliedFunctionContract): void => {
      const pending = [{ type: contract.signature.returns, depth: 0 }, ...(contract.signature.parameters ?? []).map(type => ({ type, depth: 0 }))];
      while (pending.length) {
        budget.charge(); const { type, depth } = pending.pop()!;
        if (depth > 64) budget.charge(budget.limit + 1);
        if (type.kind === 'aggregate') for (const field of type.fields) { budget.charge(); pending.push({ type: field.type, depth: depth + 1 }); }
      }
    };
    const contracts = new Map<string, SuppliedCallContract[]>();
    for (const contract of options.contracts ?? []) {
      budget.charge(); boundContract(contract);
      const key = targetKey(contract.target), list = contracts.get(key) ?? []; list.push(contract); contracts.set(key, list);
    }
    for (const contract of options.function_contracts ?? []) boundContract(contract);
    const resolutions = new Map<EntityId, SuppliedCallResolution[]>();
    for (const resolution of options.resolutions ?? []) {
      budget.charge(); const list = resolutions.get(resolution.call_id) ?? []; list.push(resolution); resolutions.set(resolution.call_id, list);
    }
    const fact = (value: Value): StackFact => stack.values.get(value.id) ?? unknown;
    const observe = (location: AbiLocation, snapshot: StackSnapshot): LocationObservation => {
      budget.charge();
      const sp = snapshot.stack_pointer.value;
      const base = sp.kind === 'stack' ? sp.offset : null;
      let value = unknown, offset: bigint | null = null;
      if (location.kind === 'register') value = inspectRegister(snapshot, location.register, location.width_bits);
      else if (location.kind === 'stack' || 'stack_offset' in location.pointer) {
        const relative = location.kind === 'stack' ? location.offset : 'stack_offset' in location.pointer ? location.pointer.stack_offset : 0n;
        const size = location.kind === 'stack' ? location.size : 8n;
        if (base !== null && size <= 65_536n) { offset = base + relative; budget.charge(Number(size)); value = inspectStackMemory(snapshot, offset, size); }
      } else value = inspectRegister(snapshot, location.pointer);
      let pointee: StackFact | null = null;
      if (location.kind === 'indirect') {
        pointee = unknown;
        if (value.value.kind === 'stack' && location.size <= 65_536n) { budget.charge(Number(location.size)); pointee = inspectStackMemory(snapshot, value.value.offset, location.size); }
      }
      return { location, fact: value, pointee, stack_offset: offset };
    };
    const classify = (contract: SuppliedFunctionContract, snapshot: StackSnapshot, output: StackSnapshot, status: ContractObservation['status'], boundary_id: EntityId | null): ContractObservation => {
      budget.charge((contract.signature.parameters?.length ?? 0) + 1);
      const layout = abi.classifyCall(contract.signature);
      diagnostics.push(...layout.diagnostics);
      return { contract, status, boundary_id, layout, parameters: layout.parameters.map(parameter => ({ index: parameter.index, locations: parameter.locations.map(location => observe(location, snapshot)) })),
        hidden_result: layout.hidden_result ? observe(layout.hidden_result, snapshot) : null,
        returns: layout.returns.map(location => observe(location, output)) };
    };
    const calls: CallFact[] = [];
    const candidates = new Map<string, { register: RegisterDescriptor; uses: Set<EntityId> }>();
    const returns: CallAnalysisResult['return_candidates'][number][] = [];
    const noteUses = (values: readonly Value[], node: EntityId): void => {
      for (const value of values) for (const register of fact(value).incoming_registers) {
        budget.charge();
        if (register.root === abi.stack_pointer.root || register.role === 'flags' || register.role === 'program_counter') continue;
        const candidate = candidates.get(register.id) ?? { register, uses: new Set<EntityId>() }; candidate.uses.add(node); candidates.set(register.id, candidate);
      }
    };
    for (const block of input.blocks) {
      if (!stack.snapshots.has(block.terminator.id)) continue;
      for (const node of block.instructions) {
        budget.charge();
        if (node.kind === 'assign') noteUses(expressionOperands(node.expression), node.id);
        else if (node.kind === 'load') noteUses([node.address], node.id);
        else if (node.kind === 'store') noteUses([node.address, node.value], node.id);
        else if (node.kind === 'call') {
          noteUses(node.arguments, node.id);
          if (node.target.kind === 'indirect') noteUses([node.target.value], node.id);
          const snapshot = stack.snapshots.get(node.id)!;
          const targets = [...(resolutions.get(node.id) ?? [])];
          if (node.target.kind === 'direct') targets.unshift({ call_id: node.id, target: { kind: 'address', address: node.target.address }, status: 'established', evidence_ids: node.provenance.evidence_ids });
          else {
            const target = fact(node.target.value);
            if (target.value.kind === 'address') targets.unshift({ call_id: node.id, target: { kind: 'address', address: target.value.address }, status: 'established', evidence_ids: target.evidence_ids });
          }
          const established = new Set(targets.filter(target => target.status === 'established').map(target => targetKey(target.target)));
          const matching = [...new Set(targets.flatMap(target => contracts.get(targetKey(target.target)) ?? []))];
          const trusted = matching.filter(contract => established.has(targetKey(contract.target)));
          const targetConflict = (['address', 'import'] as const).some(kind => new Set(targets.filter(target => target.status === 'established' && target.target.kind === kind).map(target => targetKey(target.target))).size > 1);
          const conflict = targetConflict || conflicting(trusted);
          const status = conflict ? 'conflicting' : trusted.length ? 'established' : matching.length || targets.length ? 'candidate' : 'unresolved';
          const noreturn = conflict ? 'conflicting' : trusted.some(contract => contract.noreturn === true) ? 'yes'
            : trusted.some(contract => contract.noreturn === false) ? 'no' : 'unknown';
          const evidence_ids = [...new Set([...node.provenance.evidence_ids, ...node.contract_evidence, ...targets.flatMap(target => target.evidence_ids), ...matching.flatMap(contract => contract.evidence_ids)])];
          if (conflict) report('Contradictory supplied call targets or contracts; no unique signature or noreturn conclusion.', evidence_ids);
          if (noreturn === 'yes' && (block.instructions.at(-1)?.id !== node.id || block.terminator.kind !== 'trap' && block.terminator.kind !== 'unknown')) report('Supplied noreturn contract conflicts with retained machine continuation; no effects or edges were removed.', evidence_ids);
          const output: StackSnapshot = { ...snapshot, registers: node.register_outputs.map(binding => ({ register: binding.register, fact: fact(binding.value) })) };
          calls.push({ node_id: node.id, targets, status, contracts: matching.map(contract => ({ ...classify(contract, snapshot, output,
            trusted.includes(contract) ? conflict ? 'conflicting' : 'established' : 'candidate', node.id), contract })),
            register_candidates: snapshot.registers.filter(binding => binding.register.root !== abi.stack_pointer.root && binding.register.role === 'general' && binding.fact.initialization === 'initialized'),
            explicit_arguments: node.arguments.map(fact), noreturn, evidence_ids });
        }
      }
      const terminator = block.terminator;
      if (terminator.kind === 'return') {
        noteUses(terminator.values, terminator.id);
        const snapshot = stack.snapshots.get(terminator.id)!;
        returns.push({ node_id: terminator.id, registers: snapshot.registers.filter(binding => binding.register.root !== abi.stack_pointer.root && binding.register.role === 'general'
          && !binding.fact.incoming_registers.some(register => register.root === binding.register.root)), explicit_values: terminator.values.map(fact) });
      } else if (terminator.kind === 'branch') noteUses([terminator.condition], terminator.id);
      else if (terminator.kind === 'switch') noteUses([terminator.value], terminator.id);
      else if (terminator.kind === 'indirect') noteUses([terminator.target], terminator.id);
    }
    const supplied = options.function_contracts ?? [];
    const functionConflict = conflicting(supplied);
    if (functionConflict) report('Contradictory supplied function contracts retained as alternatives.', supplied.flatMap(contract => contract.evidence_ids));
    // Each exit gets its own observation; do not turn one initialized exit into a
    // universal return claim. A function with no returns still exposes its inputs.
    const exits = returns.map(item => ({ id: item.node_id, snapshot: stack.snapshots.get(item.node_id)! }));
    const function_contracts = supplied.flatMap(contract => (exits.length ? exits : [{ id: null, snapshot: { ...stack.entry!, registers: [] } }])
      .map(exit => classify(contract, stack.entry!, exit.snapshot, functionConflict ? 'conflicting' : 'established', exit.id)));
    if (returns.length && supplied.some(contract => contract.noreturn === true)) report('Supplied function noreturn contract contradicts an actual return terminator.', supplied.flatMap(contract => contract.evidence_ids));
    return { state: 'complete', diagnostics, work: stack.work + budget.work, stack, calls, function_contracts,
      parameter_candidates: [...candidates.values()].map(candidate => ({ register: candidate.register, uses: [...candidate.uses] })), return_candidates: returns,
      function_contract_status: functionConflict ? 'conflicting' : supplied.length ? 'established' : 'unknown' };
  } catch (error) {
    const result = budget.result(empty, error);
    return { ...empty, state: result.state, diagnostics: result.diagnostics, work: stack.work + budget.work };
  }
}
