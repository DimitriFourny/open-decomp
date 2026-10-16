import { entityIdentity, fingerprint, type AbiProfile, type AbiSignature, type AbiType, type CanonicalValue, type Diagnostic, type Evidence, type OperationContext, type RecoveredType, type Signature } from '../../core/index.js';
import { bitWidth, expressionOperands, successors, type DataType, type Expression, type Instruction, type RegisterBinding, type SSAForm, type Value } from '../../ir/index.js';
import { analyzeCalls, observeImplicitRegisterInputs, type CallAnalysisResult, type ContractObservation, type LocationObservation, type SuppliedCallContract, type SuppliedFunctionContract } from '../calls/index.js';
import { inspectRegister, inspectStackMemory, type StackSnapshot } from '../stack/index.js';
import { AnalysisBudget } from '../ssa/budget.js';
import { SourceLayouts, typeKey } from './layout.js';
import type { MemoryShape, ObservedField, SignatureAssociation, SuppliedSignature, SuppliedTypeRecord, TypeAssociation, TypeBinding, TypeConflict, TypeRecoveryOptions, TypeRecoveryResult, TypeSource, TypeStatus } from './model.js';
export type * from './model.js';

/** Stable annotation subject for storage relative to this function's entry SP.
 * An offset identifies storage, not a proven source local or an object boundary. */
export function stackTypeSubject(slice_id: string, function_id: string, offset: bigint): string {
  return entityIdentity(slice_id, 'type-stack-storage', [function_id, offset]);
}

interface Transfer { to: string; offset: number; width: number; node: string; conditional: boolean }
interface Affine { base: string; offset: bigint; stride: bigint | null }

/** Bounded, nonrewriting source constraints over typed SSA. Supplied inputs are
 * the entire current revision, not deltas: retraction/removal therefore cannot
 * leave stale assertions in a cache. Names/notes/casts never create declarations.
 * Source definitions, physical machine widths and observed byte extents remain
 * independent. A shape is an incomplete view, not proof of allocation size,
 * initialization, disjointness, parameter count, or source-language alias rules.
 * Physical ABI contracts use T17's pre-effect snapshots and T19's exact nominal
 * library declarations. Debug aggregates without alignment stay ABI-unknown.
 * All alternatives and their evidence survive; emitters must not silently pick
 * one conflicting association. On budget/cancellation failure no partial source
 * conclusions are published. Input SSA and metadata are never mutated.
 */
export function recoverTypes(input: SSAForm, abi: AbiProfile, context: OperationContext, options: TypeRecoveryOptions): TypeRecoveryResult {
  if (!Number.isSafeInteger(options.revision) || options.revision < 0) throw new RangeError('Invalid type recovery revision');
  const budget = new AnalysisBudget({ max_work: options.max_work ?? 1_000_000, checkpoint: work => context.checkpoint(work) });
  let calls: CallAnalysisResult | null = null;
  const empty = { subjects: [], types: [], associations: [], signatures: [], shapes: [], conflicts: [], evidence: [] };
  try {
    budget.charge(0);
    const id = (kind: string, birth: CanonicalValue): string => entityIdentity(options.slice_id, `types-${kind}`, [input.id, birth]);
    const diagnostics: Diagnostic[] = [], conflicts: TypeConflict[] = [];
    const evidence = new Map<string, Evidence>();
    const records = new Map<string, SuppliedTypeRecord[]>();
    const layouts = new SourceLayouts(records, budget, abi.layout);
    const values = new Map<string, Value>(), nodes = new Map<string, Instruction>();
    const subjects = new Set<string>([input.id]);
    const typeSubjects = new Set<string>();
    const declaredFieldTypes = new Map<string, TypeBinding[]>();
    const transfers = new Map<string, Transfer[]>();
    const compositions = new Map<string, Extract<Instruction, { kind: 'assign' }>[]>();
    const stackOffsets = new Map<string, bigint>();
    const definitions = new Map<string, Expression>();
    const blocks = new Map(input.blocks.map(block => [block.id, block]));
    const incoming = new Map<string, number>();
    for (const block of input.blocks) for (const edge of successors(block.terminator)) {
      budget.charge(); incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    }
    const remember = (value: Value): void => { budget.charge(); values.set(value.id, value); subjects.add(value.id); typeSubjects.add(value.id); };
    const transfer = (from: Value, to: Value, offset: number, node: string, conditional = false): void => {
      budget.charge();
      const edges = transfers.get(from.id) ?? [];
      edges.push({ to: to.id, offset, width: bitWidth(to.type), node, conditional }); transfers.set(from.id, edges);
    };
    for (const block of input.blocks) {
      budget.charge();
      for (const value of block.parameters) remember(value);
      for (const node of block.instructions) {
        budget.charge(); nodes.set(node.id, node); if (node.kind === 'call') subjects.add(node.id);
        if ('result' in node) remember(node.result);
        if ('register_outputs' in node) for (const binding of node.register_outputs) remember(binding.value);
        if (node.kind === 'call') for (const value of node.results) remember(value);
        if (node.kind === 'assign') {
          definitions.set(node.result.id, node.expression);
          const e = node.expression;
          if (e.kind === 'extract') transfer(e.value, node.result, e.offset, node.id);
          else if (e.kind === 'cast' && e.op === 'bitcast' && bitWidth(e.value.type) === bitWidth(node.result.type)) transfer(e.value, node.result, 0, node.id);
          else if (e.kind === 'concat') {
            for (const value of e.values) {
              budget.charge();
              const uses = compositions.get(value.id) ?? []; uses.push(node); compositions.set(value.id, uses);
            }
          }
          else if (e.kind === 'select') { transfer(e.when_true, node.result, 0, node.id, true); transfer(e.when_false, node.result, 0, node.id, true); }
          // Bit-preserving copies transport supplied constraints; a cast alone
          // never manufactures a source declaration or an object layout.
        }
      }
      for (const edge of successors(block.terminator)) {
        const target = blocks.get(edge.target);
        if (target) edge.arguments.forEach((value, index) => { const parameter = target.parameters[index]; if (parameter) transfer(value, parameter, 0, block.terminator.id, (incoming.get(target.id) ?? 0) > 1); });
      }
    }
    const reason = (rule: string, subject: string, parents: readonly string[], source?: { author: string; agent: 'user' | 'llm'; status: 'asserted' | 'hypothesis' }): string => {
      budget.charge(parents.length + 1);
      const derived_from = [...new Set(parents)].sort();
      if (derived_from.length > 1000) budget.charge(budget.limit + 1);
      const key = `evidence_${fingerprint([options.slice_id, input.id, rule, subject, derived_from, source ? [source.author, source.agent, source.status] : null])}`;
      if (!evidence.has(key)) evidence.set(key, { id: key, origin: source ? { kind: 'assertion', ...source } : { kind: 'analysis', analyzer: 'source-types', version: '2', rule }, claim: rule, derived_from, conflicts_with: [], revision: options.revision });
      return key;
    };
    const addType = (record: SuppliedTypeRecord): void => {
      budget.charge(record.definition.kind === 'structure' ? record.definition.fields.length + 1 : 1);
      if (record.evidence_ids.length > 1000 || record.definition.kind === 'structure' && record.definition.fields.length > 10000) budget.charge(budget.limit + 1);
      const existing = records.get(record.id) ?? [];
      if (existing.some(item => typeKey(item.definition) === typeKey(record.definition) && item.source === record.source && item.status === record.status && item.evidence_ids.join() === record.evidence_ids.join())) return;
      existing.push(record); records.set(record.id, existing);
      subjects.add(record.id); typeSubjects.add(record.id);
      if (record.definition.kind === 'structure') for (const field of record.definition.fields) {
        subjects.add(field.id); typeSubjects.add(field.id);
        const alternatives = declaredFieldTypes.get(field.id) ?? [];
        alternatives.push({ subject_id: field.id, type_id: field.type_id, source: record.source, status: record.status, evidence_ids: record.evidence_ids });
        declaredFieldTypes.set(field.id, alternatives);
      }
    };
    const generated = (definition: RecoveredType, proof: readonly string[]): string => {
      const type_id = id('type', typeKey(definition));
      const existing = records.get(type_id)?.[0];
      if (existing) {
        const merged = [...new Set([...existing.evidence_ids, ...proof])].sort();
        budget.charge(existing.evidence_ids.length + proof.length);
        if (merged.length > 1000) budget.charge(budget.limit + 1);
        records.set(type_id, [{ ...existing, evidence_ids: merged }]);
      } else addType({ id: type_id, definition, source: 'analysis', status: 'candidate', evidence_ids: proof });
      return type_id;
    };
    const machineType = (type: DataType, proof: readonly string[], signed = false): string => {
      budget.charge();
      if (type.kind === 'vector') return generated({ kind: 'vector', element: machineType(type.element, proof, signed), lanes: type.lanes }, proof);
      if (type.kind === 'integer' && type.bits > 512) return generated({ kind: 'unknown', size: null }, proof);
      return generated(type.kind === 'integer' ? { ...type, signed } : type, proof);
    };
    const suppliedSignatures: SuppliedSignature[] = [...(options.signatures ?? [])];
    const bindings: TypeBinding[] = [...(options.bindings ?? [])];
    for (const record of options.types ?? []) addType(record);
    for (const record of options.debug?.types ?? []) addType({ ...record, source: 'debug', status: 'established' });
    for (const record of options.library?.types ?? []) addType({ ...record, source: 'library', status: 'established' });
    for (const proof of [...(options.debug?.evidence ?? []), ...(options.library?.evidence ?? [])]) { budget.charge(); evidence.set(proof.id, proof); }
    diagnostics.push(...(options.debug?.diagnostics ?? []), ...(options.library?.diagnostics ?? []));
    if (options.entry_address?.image_id === options.image_id && options.entry_address.space === 'va') {
      for (const fn of options.debug?.functions ?? []) {
        budget.charge();
        if (fn.dwarf.address === options.entry_address.value && fn.signature) suppliedSignatures.push({ id: fn.id, subject_id: input.id, signature: fn.signature, source: 'debug', status: fn.conflicting ? 'conflicting' : 'established', evidence_ids: fn.evidence_ids });
      }
    }
    // Stack/field subjects become known after observations; defer those records.
    const deferredTypes: { record: SuppliedTypeRecord; subject_id: string }[] = [];
    for (const annotation of options.annotations ?? []) {
      budget.charge();
      if (annotation.status === 'retracted' || annotation.value.kind === 'name' || annotation.value.kind === 'note') continue;
      const proof = reason('supplied source assertion', annotation.id, annotation.evidence_ids, { author: annotation.author, agent: annotation.origin, status: annotation.status });
      if (annotation.value.kind === 'type') {
        const record: SuppliedTypeRecord = { id: annotation.value.type_id, definition: annotation.value.definition, source: annotation.origin, status: annotation.status, evidence_ids: [proof] };
        // A function anchor declares a source type in scope; it does not give the
        // function itself a scalar machine type.
        if (annotation.entity_id === input.id) { addType(record); continue; }
        if (typeSubjects.has(annotation.entity_id)) addType(record);
        else deferredTypes.push({ record, subject_id: annotation.entity_id });
        bindings.push({ subject_id: annotation.entity_id, type_id: annotation.value.type_id, source: annotation.origin, status: annotation.status, evidence_ids: [proof] });
      } else suppliedSignatures.push({ id: annotation.id, subject_id: annotation.entity_id, signature: annotation.value.value, source: annotation.origin, status: annotation.status, evidence_ids: [proof] });
    }
    const sourceAbi = (signature: Signature): AbiSignature => ({ returns: layouts.abi(signature.return_type), parameters: signature.parameters.map(parameter => layouts.abi(parameter.type_id)), variadic: signature.variadic, fixed_parameter_count: signature.parameters.length, argument_list_complete: !signature.variadic });
    const functionContracts: SuppliedFunctionContract[] = [...(options.function_contracts ?? [])];
    const callContracts: SuppliedCallContract[] = [...(options.contracts ?? [])];
    const declarationByContract = new Map<string, SuppliedSignature>();
    const callDeclarations = new Map<string, SuppliedSignature[]>();
    const consumedCallDeclarations = new Set<SuppliedSignature>();
    for (const declaration of suppliedSignatures) {
      budget.charge();
      if (declaration.signature.abi !== abi.id) { diagnostics.push({ code: 'conflicting_evidence', severity: 'warning', message: 'Source signature belongs to a different target ABI', entity_id: declaration.subject_id, evidence_ids: [...declaration.evidence_ids] }); continue; }
      if (declaration.subject_id === input.id && declaration.status !== 'hypothesis' && declaration.status !== 'candidate') {
        functionContracts.push({ id: declaration.id, signature: sourceAbi(declaration.signature), noreturn: declaration.signature.noreturn, evidence_ids: declaration.evidence_ids });
        declarationByContract.set(declaration.id, declaration);
      }
      else if (nodes.get(declaration.subject_id)?.kind === 'call' && declaration.status !== 'hypothesis' && declaration.status !== 'candidate') {
        const key = `${declaration.subject_id}:${declaration.id}`, alternatives = callDeclarations.get(key) ?? [];
        alternatives.push(declaration); callDeclarations.set(key, alternatives);
      }
    }
    for (const contract of options.library?.contracts ?? []) {
      budget.charge();
      if (contract.abi_state !== 'supported' || !contract.signature) continue;
      const declaration: SuppliedSignature = { id: contract.id, subject_id: contract.import_id, signature: contract.signature, source: 'library', status: contract.conflicts_with.length ? 'conflicting' : 'established', evidence_ids: contract.evidence_ids };
      const supplied = { id: contract.id, signature: contract.abi_signature, noreturn: contract.noreturn, evidence_ids: contract.evidence_ids };
      callContracts.push({ ...supplied, target: { kind: 'import', image_id: options.image_id, import_id: contract.import_id } });
      declarationByContract.set(contract.id, declaration);
      if (contract.callable_entry) {
        const entryId = `${contract.id}:entry`;
        callContracts.push({ ...supplied, id: entryId, target: { kind: 'address', address: contract.callable_entry } });
        declarationByContract.set(entryId, declaration);
      }
    }
    const remaining = Math.max(0, budget.limit - budget.work);
    calls = analyzeCalls(input, abi, context, { max_work: remaining, ...(options.max_stack_bytes === undefined ? {} : { max_stack_bytes: options.max_stack_bytes }), contracts: callContracts, function_contracts: functionContracts, resolutions: options.resolutions ?? [] });
    // analyzeCalls already charges the shared OperationContext.
    budget.work += calls.work;
    if (calls.state === 'partial') return { ...empty, state: 'partial', work: budget.work, diagnostics: [...diagnostics, ...calls.diagnostics], calls };
    diagnostics.push(...calls.diagnostics);
    const stack = calls.stack;
    const bySubject = new Map<string, TypeAssociation[]>();
    const associations = new Map<string, TypeAssociation>();
    const pending: TypeAssociation[] = [];
    const associate = (binding: TypeBinding, offset = 0, width: number | null = null, machineOffset = 0): void => {
      budget.charge();
      const machine = values.get(binding.subject_id)?.type ?? null;
      const physicalWidth = width ?? (machine ? bitWidth(machine) : null);
      const key = id('association', [binding.subject_id, binding.type_id, binding.source, binding.status, offset, physicalWidth, machineOffset]);
      const previous = associations.get(key);
      if (previous) {
        const proof = [...new Set([...previous.evidence_ids, ...binding.evidence_ids])].sort();
        budget.charge(previous.evidence_ids.length + binding.evidence_ids.length);
        if (proof.length > 1000) budget.charge(budget.limit + 1);
        const updated = { ...previous, evidence_ids: proof };
        associations.set(key, updated);
        const list = bySubject.get(binding.subject_id)!;
        budget.charge(list.length);
        const index = list.findIndex(item => item.id === key);
        if (index >= 0) list[index] = updated;
        return;
      }
      const association: TypeAssociation = { ...binding, id: key, machine_type: machine, value_offset_bits: offset, machine_offset_bits: machineOffset, width_bits: physicalWidth };
      associations.set(key, association); pending.push(association);
      const list = bySubject.get(binding.subject_id) ?? []; list.push(association); bySubject.set(binding.subject_id, list);
    };
    const signatures: SignatureAssociation[] = [];
    const fromAbi = (type: AbiType, proof: readonly string[], depth = 0): string => {
      budget.charge();
      if (depth >= 64) return generated({ kind: 'unknown', size: null }, proof);
      switch (type.kind) {
        case 'void': case 'integer': case 'float': case 'unknown': return generated(type, proof);
        case 'pointer': return generated({ kind: 'pointer', bits: 64, to: generated({ kind: 'unknown', size: null }, proof) }, proof);
        case 'vector': return generated({ kind: 'vector', lanes: type.lanes, element: generated(type.element === 'integer' ? { kind: 'integer', bits: type.element_bits, signed: false } : { kind: 'float', bits: type.element_bits as 16 | 32 | 64 | 128 }, proof) }, proof);
        case 'aggregate': return generated({ kind: 'structure', size: type.size, alignment: type.alignment, fields: type.fields.map((field, index) => ({ id: id('abi-field', [type.size, field.offset, index]), name: `field_${field.offset.toString(16)}`, offset: field.offset, type_id: fromAbi(field.type, proof, depth + 1) })) }, proof);
      }
    };
    const bindLocation = (location: LocationObservation, type_id: string, declaration: SuppliedSignature, subject: string, physical: readonly RegisterBinding[]): void => {
      budget.charge();
      const proof = reason('physical ABI source association', subject, [...declaration.evidence_ids, ...location.fact.evidence_ids]);
      const loc = location.location;
      const offset = loc.kind === 'indirect' ? 0 : loc.value_offset_bits;
      const width = loc.kind === 'register' ? loc.width_bits : loc.kind === 'stack' && loc.size <= 256n ? Number(loc.size * 8n) : null;
      const physicalType = loc.kind === 'indirect' ? generated({ kind: 'pointer', bits: 64, to: type_id }, [proof]) : type_id;
      const register = loc.kind === 'register' ? loc.register : loc.kind === 'indirect' && !('stack_offset' in loc.pointer) ? loc.pointer : null;
      if (register) for (const binding of physical) {
        budget.charge();
        if (binding.register.root !== register.root) continue;
        const start = Math.max(register.offset_bits, binding.register.offset_bits);
        const stop = Math.min(register.offset_bits + (width ?? register.width_bits), binding.register.offset_bits + binding.register.width_bits);
        if (start >= stop) continue;
        associate({ subject_id: binding.value.id, type_id: physicalType, source: declaration.source, status: declaration.status, evidence_ids: [proof] }, offset + start - register.offset_bits, stop - start, start - binding.register.offset_bits);
      }
      const storage = loc.kind === 'indirect' && location.fact.value.kind === 'stack' ? location.fact.value.offset : location.stack_offset;
      if (storage !== null) {
        const subject_id = stackTypeSubject(options.slice_id, input.id, storage); subjects.add(subject_id); typeSubjects.add(subject_id);
        stackOffsets.set(subject_id, storage);
        associate({ subject_id, type_id, source: declaration.source, status: declaration.status, evidence_ids: [proof] }, offset, width);
      }
    };
    const consume = (observation: ContractObservation, subject_id: string, supplied?: SuppliedSignature): void => {
      budget.charge();
      let declaration = supplied ?? declarationByContract.get(observation.contract.id);
      if (!declaration) {
        const signature = observation.contract.signature;
        // Core Signature records formal parameters, not unknown old-style
        // prototypes or the anonymous actuals of an observed variadic call.
        if (signature.parameters === null || signature.prototyped === false) return;
        const formals = signature.variadic ? signature.parameters.slice(0, signature.fixed_parameter_count) : signature.parameters;
        declaration = { id: observation.contract.id, subject_id, source: 'analysis', status: observation.status, evidence_ids: observation.contract.evidence_ids,
          signature: { abi: abi.id, return_type: fromAbi(signature.returns, observation.contract.evidence_ids), parameters: formals.map((type, index) => ({ id: id('parameter', [observation.contract.id, index]), name: null, type_id: fromAbi(type, observation.contract.evidence_ids) })), variadic: signature.variadic, noreturn: observation.contract.noreturn ?? false, evidence_ids: [...observation.contract.evidence_ids] } };
      }
      const status = observation.status === 'conflicting' || declaration.status === 'conflicting' ? 'conflicting' : observation.status === 'candidate' ? 'candidate' : declaration.status;
      const current: SuppliedSignature = { ...declaration, subject_id, status };
      signatures.push({ ...current, abi_state: observation.layout.state, implicit_register_inputs: observation.implicit_register_inputs });
      const call = nodes.get(subject_id);
      const entryBindings = input.register_states.find(row => row.block === input.entry)?.entry ?? [];
      const returnBlock = input.blocks.find(block => block.terminator.id === observation.boundary_id);
      const before = call?.kind === 'call' ? call.register_inputs : entryBindings;
      const after = call?.kind === 'call' ? call.register_outputs : input.register_states.find(row => row.block === returnBlock?.id)?.exit ?? [];
      for (const parameter of observation.parameters) {
        const formal = current.signature.parameters[parameter.index];
        const actual = observation.contract.signature.variadic && parameter.index >= observation.contract.signature.fixed_parameter_count
          ? observation.contract.signature.parameters?.[parameter.index] : undefined;
        const type_id = formal?.type_id ?? (actual ? fromAbi(actual, observation.contract.evidence_ids) : null);
        if (type_id) for (const location of parameter.locations) bindLocation(location, type_id, current, subject_id, before);
      }
      const returnType = observation.layout.hidden_result ? generated({ kind: 'pointer', bits: 64, to: current.signature.return_type }, current.evidence_ids) : current.signature.return_type;
      for (const location of observation.returns) bindLocation(location, returnType, current, subject_id, after);
      if (observation.hidden_result) bindLocation(observation.hidden_result, current.signature.return_type, current, subject_id, before);
    };
    for (const observation of calls.function_contracts) consume(observation, input.id);
    for (const call of calls.calls) for (const observation of call.contracts) {
      const declarations = callDeclarations.get(`${call.node_id}:${observation.contract.id}`);
      if (declarations) for (const declaration of declarations) {
        consume(observation, call.node_id, declaration); consumedCallDeclarations.add(declaration);
      }
      else consume(observation, call.node_id);
    }
    // Call-local annotations are intentionally not promoted into target-global
    // contracts. Classify once and inspect the exact call's physical snapshots.
    for (const declaration of suppliedSignatures) {
      budget.charge();
      if (declaration.signature.abi !== abi.id) continue;
      const node = nodes.get(declaration.subject_id);
      if (declaration.subject_id !== input.id && node?.kind !== 'call') {
        diagnostics.push({ code: 'unavailable_semantics', severity: 'warning', message: 'Signature subject is outside this function/call scope', entity_id: declaration.subject_id, evidence_ids: [...declaration.evidence_ids] }); continue;
      }
      if (declaration.subject_id === input.id && declarationByContract.has(declaration.id) || consumedCallDeclarations.has(declaration)) continue;
      const layout = abi.classifyCall(sourceAbi(declaration.signature));
      const before = node?.kind === 'call' && declaration.status !== 'hypothesis' && declaration.status !== 'candidate' ? stack.snapshots.get(node.id) : undefined;
      budget.charge(layout.implicit_register_inputs.length);
      signatures.push({ ...declaration, abi_state: layout.state, implicit_register_inputs: observeImplicitRegisterInputs(layout, before ?? null) });
      if (node?.kind !== 'call' || declaration.status === 'hypothesis' || declaration.status === 'candidate') continue;
      if (!before) continue;
      const after: StackSnapshot = { ...before, registers: node.register_outputs.flatMap(binding => { const fact = stack.values.get(binding.value.id); return fact ? [{ register: binding.register, fact }] : []; }) };
      const observe = (location: LocationObservation['location'], snapshot: StackSnapshot): LocationObservation | null => {
        budget.charge();
        if (location.kind === 'register') return { location, fact: inspectRegister(snapshot, location.register, location.width_bits), pointee: null, stack_offset: null };
        if (location.kind === 'indirect' && !('stack_offset' in location.pointer)) return { location, fact: inspectRegister(snapshot, location.pointer), pointee: null, stack_offset: null };
        const sp = snapshot.stack_pointer.value;
        const offset = location.kind === 'stack' ? location.offset : 'stack_offset' in location.pointer ? location.pointer.stack_offset : 0n;
        const size = location.kind === 'stack' ? location.size : 8n;
        if (sp.kind !== 'stack' || size > 65536n) return null;
        budget.charge(Number(size));
        return { location, fact: inspectStackMemory(snapshot, sp.offset + offset, size), pointee: null, stack_offset: sp.offset + offset };
      };
      for (const parameter of layout.parameters) for (const location of parameter.locations) {
        const observation = observe(location, before), type = declaration.signature.parameters[parameter.index];
        if (observation && type) bindLocation(observation, type.type_id, declaration, node.id, node.register_inputs);
      }
      const returnType = layout.hidden_result ? generated({ kind: 'pointer', bits: 64, to: declaration.signature.return_type }, declaration.evidence_ids) : declaration.signature.return_type;
      for (const location of layout.returns) { const observation = observe(location, after); if (observation) bindLocation(observation, returnType, declaration, node.id, node.register_outputs); }
      if (layout.hidden_result) { const observation = observe(layout.hidden_result, before); if (observation) bindLocation(observation, declaration.signature.return_type, declaration, node.id, node.register_inputs); }
    }

    const affineCache = new Map<string, Affine>();
    const affine = (value: Value, active = new Set<string>()): Affine => {
      budget.charge();
      const cached = affineCache.get(value.id); if (cached) return cached;
      const fallback: Affine = { base: value.id, offset: 0n, stride: null };
      if (active.has(value.id) || active.size >= 64 || bitWidth(value.type) !== 64) return fallback;
      active.add(value.id);
      const expression = definitions.get(value.id);
      let result = fallback;
      if (expression?.kind === 'integer' && (expression.op === 'add' || expression.op === 'sub')) {
        const left = stack.values.get(expression.left.id)?.value, right = stack.values.get(expression.right.id)?.value;
        if (right?.kind === 'constant') { const base = affine(expression.left, active); result = { ...base, offset: BigInt.asIntN(64, base.offset + (expression.op === 'add' ? 1n : -1n) * BigInt.asIntN(64, right.bits)) }; }
        else if (left?.kind === 'constant' && expression.op === 'add') { const base = affine(expression.right, active); result = { ...base, offset: BigInt.asIntN(64, base.offset + BigInt.asIntN(64, left.bits)) }; }
        else if (expression.op === 'add') {
          for (const [baseValue, indexValue] of [[expression.left, expression.right], [expression.right, expression.left]] as const) {
            const index = definitions.get(indexValue.id);
            if (index?.kind !== 'integer' || index.op !== 'mul' && index.op !== 'shl') continue;
            const scale = stack.values.get(index.right.id)?.value;
            if (scale?.kind !== 'constant') continue;
            const stride = index.op === 'mul' ? scale.bits : scale.bits < 64n ? 1n << scale.bits : 0n;
            if (stride > 0n && stride <= 65536n) { const base = affine(baseValue, active); result = { ...base, stride }; break; }
          }
        }
      } else if (expression?.kind === 'extract' && expression.offset === 0 && bitWidth(expression.value.type) === 64) result = affine(expression.value, active);
      else if (expression?.kind === 'cast' && expression.op === 'bitcast' && bitWidth(expression.value.type) === 64) result = affine(expression.value, active);
      active.delete(value.id); affineCache.set(value.id, result); return result;
    };
    const stackAccess = new Map(stack.accesses.map(access => [access.node_id, access]));
    const groups = new Map<string, { base: MemoryShape['base']; fields: Map<string, ObservedField>; dynamic: boolean }>();
    const escapes = new Set<string>();
    for (const node of nodes.values()) {
      budget.charge();
      if (node.kind === 'store') escapes.add(affine(node.value).base);
      if (node.kind === 'call') for (const binding of node.register_inputs) escapes.add(affine(binding.value).base);
      if (node.kind !== 'load' && node.kind !== 'store') continue;
      const access = stackAccess.get(node.id), address = affine(node.address);
      const isStack = access !== undefined;
      const offset = isStack ? access.offset : address.offset;
      if (offset === null) continue;
      const key = isStack ? 'stack' : address.base;
      const group = groups.get(key) ?? { base: isStack ? { kind: 'stack' as const } : { kind: 'value' as const, value_id: address.base }, fields: new Map<string, ObservedField>(), dynamic: false };
      const value = node.kind === 'load' ? node.result : node.value, width = bitWidth(value.type);
      const fieldId = id('field', [key, offset, width, address.stride]);
      const previous = group.fields.get(fieldId);
      const proof = reason('observed memory access, not complete layout', node.id, node.provenance.evidence_ids);
      group.fields.set(fieldId, { id: fieldId, offset, width_bits: width, node_ids: [...(previous?.node_ids ?? []), node.id], value_ids: [...new Set([...(previous?.value_ids ?? []), value.id])], evidence_ids: [...(previous?.evidence_ids ?? []), proof], access: [...new Set([...(previous?.access ?? []), node.kind === 'load' ? 'read' as const : 'write' as const])], stack_region: access?.region ?? null, stride: isStack ? null : address.stride });
      group.dynamic ||= address.stride !== null;
      groups.set(key, group); subjects.add(fieldId); typeSubjects.add(fieldId);
      const type_id = machineType(value.type, [proof]);
      associate({ subject_id: fieldId, type_id, source: 'analysis', status: 'candidate', evidence_ids: [proof] });
      associate({ subject_id: value.id, type_id, source: 'analysis', status: 'candidate', evidence_ids: [proof] });
      if (isStack) {
        const subject_id = stackTypeSubject(options.slice_id, input.id, offset); subjects.add(subject_id); typeSubjects.add(subject_id); stackOffsets.set(subject_id, offset);
        associate({ subject_id, type_id, source: 'analysis', status: 'candidate', evidence_ids: [proof] });
      }
    }
    for (const block of input.blocks) if (block.terminator.kind === 'return') for (const value of block.terminator.values) escapes.add(affine(value).base);
    const shapes: MemoryShape[] = [];
    for (const [key, group] of groups) {
      budget.charge(group.fields.size);
      const fields = [...group.fields.values()].sort((a, b) => a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : a.width_bits - b.width_bits || a.id.localeCompare(b.id));
      const constantFields = fields.filter(field => field.stride === null);
      const start = fields[0]!.offset, base_offset = start < 0n ? start : 0n;
      const proof: string[] = [];
      const coreFields: Extract<RecoveredType, { kind: 'structure' }>['fields'][number][] = [];
      for (const field of fields) {
        proof.push(...field.evidence_ids);
        const value = values.get(field.value_ids[0]!)!;
        let type_id = machineType(value.type, field.evidence_ids);
        if (field.width_bits % 8 === 0 && field.stride === BigInt(field.width_bits / 8)) type_id = generated({ kind: 'array', element: type_id, count: null }, field.evidence_ids);
        coreFields.push({ id: field.id, name: `field_${(field.offset - base_offset).toString(16)}`, offset: field.offset - base_offset, type_id });
      }
      const shapeId = id('shape', key);
      const type_id = id('shape-type', key);
      addType({ id: type_id, definition: { kind: 'structure', size: null, alignment: null, fields: coreFields }, source: 'analysis', status: 'candidate', evidence_ids: proof });
      shapes.push({ id: shapeId, base: group.base, type_id, base_offset,
        observed_extent: constantFields.length ? { start: constantFields[0]!.offset, end: constantFields.reduce((maximum, field) => { const stop = field.offset + BigInt(Math.ceil(field.width_bits / 8)); return stop > maximum ? stop : maximum; }, constantFields[0]!.offset) } : null,
        fields, alias: group.base.kind === 'stack' && stack.frame.aliased ? 'observed' : 'possible', escape: group.base.kind === 'stack' ? stack.frame.escaped ? 'observed' : 'unknown' : escapes.has(group.base.value_id) ? 'observed' : 'unknown', dynamic: group.dynamic || group.base.kind === 'stack' && stack.frame.dynamic, evidence_ids: proof });
      if (group.base.kind === 'value' && base_offset === 0n) associate({ subject_id: group.base.value_id, type_id: generated({ kind: 'pointer', bits: 64, to: type_id }, proof), source: 'analysis', status: 'candidate', evidence_ids: proof });
      // Overlap is evidence of a view/union/alias, not automatically a structure.
      for (let index = 0; index < fields.length; index++) for (let next = index + 1; next < fields.length && fields[next]!.offset < fields[index]!.offset + BigInt(Math.ceil(fields[index]!.width_bits / 8)); next++) {
        budget.charge();
        const a = fields[index]!, b = fields[next]!;
        conflicts.push({ subject_id: shapeId, alternatives: [a.id, b.id], evidence_ids: [...a.evidence_ids, ...b.evidence_ids], reason: 'overlapping_accesses' });
      }
    }
    // Machine signedness is an operation-use constraint, not a rewritten value.
    for (const node of nodes.values()) if (node.kind === 'assign') {
      budget.charge(); const e = node.expression;
      if (e.kind === 'float' || e.kind === 'float_unary' || e.kind === 'vector' || e.kind === 'vector_float' || e.kind === 'vector_integer') {
        const proof = reason('typed machine operation', node.id, node.provenance.evidence_ids);
        associate({ subject_id: node.result.id, type_id: machineType(node.result.type, [proof]), source: 'analysis', status: 'candidate', evidence_ids: [proof] });
      }
      if ((e.kind === 'integer' && ['sdiv', 'srem', 'ashr', 'udiv', 'urem', 'lshr'].includes(e.op)) || e.kind === 'compare' && !['eq', 'ne'].includes(e.op)) {
        const proof = reason('machine signedness use', node.id, node.provenance.evidence_ids);
        for (const operand of expressionOperands(e)) associate({ subject_id: operand.id, type_id: machineType(operand.type, [proof], e.op.startsWith('s') || e.op === 'ashr'), source: 'analysis', status: 'candidate', evidence_ids: [proof] });
      }
    }
    for (const deferred of deferredTypes) if (typeSubjects.has(deferred.subject_id)) addType(deferred.record);
    const constrainedDeclarations = new Set<string>();
    for (const binding of bindings) {
      budget.charge();
      if (!typeSubjects.has(binding.subject_id) || !records.has(binding.type_id)) { diagnostics.push({ code: 'unavailable_semantics', severity: 'warning', message: 'Type binding has an unavailable exact subject or type ID', entity_id: binding.subject_id, evidence_ids: [...binding.evidence_ids] }); continue; }
      // Retain the declared source view when a type/field itself is annotated;
      // contradictory overrides are alternatives, not silent replacements.
      if (!constrainedDeclarations.has(binding.subject_id)) {
        constrainedDeclarations.add(binding.subject_id);
        for (const declaration of records.get(binding.subject_id) ?? []) associate({ subject_id: binding.subject_id, type_id: binding.subject_id, source: declaration.source, status: declaration.status, evidence_ids: declaration.evidence_ids });
        for (const declaration of declaredFieldTypes.get(binding.subject_id) ?? []) associate(declaration);
      }
      associate(binding);
    }
    // Forward transport and exact concatenation of source-relative fragments.
    // The worklist identity bounds cycles; no type flows backward into unrelated
    // arithmetic operands merely because stack provenance mentions their IDs.
    let propagationCursor = 0;
    const propagate = (): void => {
      for (; propagationCursor < pending.length; propagationCursor++) {
        const current = associations.get(pending[propagationCursor]!.id)!;
        for (const edge of transfers.get(current.subject_id) ?? []) {
          budget.charge();
          if (edge.offset < current.machine_offset_bits || current.width_bits !== null && edge.offset + edge.width > current.machine_offset_bits + current.width_bits) continue;
          const proof = reason('SSA reaching source constraint', edge.node, current.evidence_ids);
          const status = edge.conditional && current.status !== 'hypothesis' && current.status !== 'conflicting' ? 'candidate' : current.status;
          associate({ ...current, subject_id: edge.to, status, evidence_ids: [proof] }, current.value_offset_bits + edge.offset - current.machine_offset_bits, edge.width);
        }
        for (const node of compositions.get(current.subject_id) ?? []) {
          if (node.expression.kind !== 'concat') continue;
          let offset = 0, valid = true;
          const parents: string[] = [];
          for (const value of node.expression.values) {
            const alternatives = bySubject.get(value.id) ?? [];
            budget.charge(alternatives.length + 1);
            const part = alternatives.find(item => item.type_id === current.type_id && item.source === current.source && item.status === current.status && item.machine_offset_bits === 0 && item.value_offset_bits === offset && item.width_bits === bitWidth(value.type));
            if (!part) { valid = false; break; }
            parents.push(...part.evidence_ids); offset += bitWidth(value.type);
          }
          if (valid) associate({ ...current, subject_id: node.result.id, evidence_ids: [reason('reassembled physical source fragments', node.id, parents)] }, 0, offset);
        }
      }
    };
    propagate();
    // Match declared pointer/aggregate fields against the observed exact offsets.
    // Unknown aliases never establish a full object or propagate across stores.
    const storageDeclarations: { binding: TypeAssociation; type_id: string; offset: bigint }[] = [];
    const valueDeclarations = new Map<string, { binding: TypeAssociation; type_id: string; offset: bigint }[]>();
    for (const binding of associations.values()) {
      budget.charge();
      if (binding.source === 'analysis' || binding.value_offset_bits !== 0 || binding.machine_offset_bits !== 0) continue;
      const storageOffset = stackOffsets.get(binding.subject_id);
      if (storageOffset !== undefined) storageDeclarations.push({ binding, type_id: binding.type_id, offset: storageOffset });
      const fact = stack.values.get(binding.subject_id)?.value;
      const type = layouts.definition(binding.type_id);
      if (fact?.kind === 'stack' && type?.kind === 'pointer' && binding.width_bits === 64) storageDeclarations.push({ binding, type_id: type.to, offset: fact.offset });
      const value = values.get(binding.subject_id);
      if (value && type?.kind === 'pointer' && binding.width_bits === 64) {
        const address = affine(value);
        if (address.stride === null) {
          const list = valueDeclarations.get(address.base) ?? [];
          list.push({ binding, type_id: type.to, offset: address.offset }); valueDeclarations.set(address.base, list);
        }
      }
    }
    for (const shape of shapes) {
      const declarations: { binding: TypeAssociation; type_id: string; offset: bigint }[] = [];
      if (shape.base.kind === 'stack') declarations.push(...storageDeclarations);
      else declarations.push(...(valueDeclarations.get(shape.base.value_id) ?? []));
      for (const { binding, type_id, offset } of declarations) for (const field of shape.fields) {
        budget.charge();
        const displacement = field.offset - offset;
        const objectSize = layouts.size(type_id);
        // Separate stack objects do not constrain one another's adjacent bytes.
        if (shape.base.kind === 'stack' && (displacement < 0n || objectSize !== null && displacement >= objectSize)) continue;
        const fieldTypes = layouts.fields(type_id, displacement, field.width_bits);
        const object = layouts.definition(type_id);
        const exactMember = object?.kind === 'structure' ? object.fields.find(member => member.offset === displacement) : null;
        const memberSize = exactMember ? layouts.size(exactMember.type_id) : null;
        if (objectSize !== null && displacement >= 0n && field.stride === null && displacement + BigInt(Math.ceil(field.width_bits / 8)) > objectSize || memberSize !== null && memberSize * 8n !== BigInt(field.width_bits) && fieldTypes.length === 0) {
          conflicts.push({ subject_id: field.id, alternatives: [binding.type_id], evidence_ids: [...binding.evidence_ids, ...field.evidence_ids], reason: 'layout_mismatch' });
        }
        // A dynamic index can select an array element, but cannot be assumed to
        // remain within a particular struct member merely from its displacement.
        if (field.stride !== null && (object?.kind !== 'array' || layouts.size(object.element) !== field.stride)) continue;
        for (const fieldType of fieldTypes) {
          const proof = reason('declared field matches observed displacement and width', field.id, [...binding.evidence_ids, ...field.evidence_ids]);
          associate({ ...binding, subject_id: field.id, type_id: fieldType, evidence_ids: [proof] });
          for (const value_id of field.value_ids) associate({ ...binding, subject_id: value_id, type_id: fieldType, evidence_ids: [proof] });
        }
      }
    }
    propagate();
    // Only declarations compete as source types. Signless machine views are not
    // contradictory merely because a supplied source integer is signed/pointer.
    const declared = new Map<string, TypeAssociation[]>();
    for (const association of associations.values()) if (association.source !== 'analysis' && association.status !== 'candidate') {
      const key = `${association.subject_id}:${association.value_offset_bits}:${association.width_bits}:${association.machine_offset_bits}`;
      const list = declared.get(key) ?? []; list.push(association); declared.set(key, list);
    }
    for (const list of declared.values()) {
      budget.charge(list.length);
      const keys = new Set(list.map(item => { const definition = layouts.definition(item.type_id); return definition ? typeKey(definition) : item.type_id; }));
      if (keys.size > 1) {
        conflicts.push({ subject_id: list[0]!.subject_id, alternatives: list.map(item => item.id), evidence_ids: [...new Set(list.flatMap(item => item.evidence_ids))], reason: 'incompatible_types' });
        for (const item of list) if (item.status !== 'hypothesis') associations.set(item.id, { ...item, status: 'conflicting' });
      }
    }
    const signatureGroups = new Map<string, SignatureAssociation[]>();
    for (const signature of signatures) { const list = signatureGroups.get(signature.subject_id) ?? []; if (!list.some(item => item.id === signature.id && item.status === signature.status)) list.push(signature); signatureGroups.set(signature.subject_id, list); }
    for (const list of signatureGroups.values()) {
      const keys = new Set(list.filter(item => item.status !== 'candidate').map(item => fingerprint([item.signature.abi, item.signature.return_type, item.signature.parameters.map(parameter => parameter.type_id), item.signature.variadic, item.signature.noreturn])));
      if (keys.size > 1) {
        conflicts.push({ subject_id: list[0]!.subject_id, alternatives: list.map(item => item.id), evidence_ids: [...new Set(list.flatMap(item => item.evidence_ids))], reason: 'incompatible_signatures' });
        for (let index = 0; index < list.length; index++) if (list[index]!.status !== 'hypothesis' && list[index]!.status !== 'candidate') list[index] = { ...list[index]!, status: 'conflicting' };
      }
    }
    for (const [type_id, alternatives] of records) {
      budget.charge(alternatives.length);
      if (new Set(alternatives.map(item => typeKey(item.definition))).size <= 1) continue;
      conflicts.push({ subject_id: type_id, alternatives: alternatives.map(item => typeKey(item.definition)), evidence_ids: [...new Set(alternatives.flatMap(item => item.evidence_ids))], reason: 'incompatible_types' });
      for (const association of associations.values()) {
        budget.charge();
        if (association.type_id === type_id && association.status !== 'hypothesis') associations.set(association.id, { ...association, status: 'conflicting' });
      }
    }
    for (const conflict of conflicts) {
      budget.charge(conflict.evidence_ids.length + 1);
      diagnostics.push({ code: 'conflicting_evidence', severity: 'warning', message: `Source type constraint conflict: ${conflict.reason}`, entity_id: conflict.subject_id, evidence_ids: [...conflict.evidence_ids] });
      for (const proof of conflict.evidence_ids) {
        const record = evidence.get(proof);
        if (record) evidence.set(proof, { ...record, conflicts_with: [...new Set([...record.conflicts_with, ...conflict.evidence_ids.filter(other => other !== proof)])].sort() });
      }
    }
    return { state: options.debug?.status === 'partial' || options.library?.state === 'partial' ? 'partial' : 'complete', work: budget.work,
      subjects: [...subjects].sort(),
      types: [...records.values()].flat().sort((a, b) => a.id.localeCompare(b.id) || a.source.localeCompare(b.source) || typeKey(a.definition).localeCompare(typeKey(b.definition))),
      associations: [...associations.values()].sort((a, b) => a.id.localeCompare(b.id)),
      signatures: [...signatureGroups.values()].flat().sort((a, b) => a.subject_id.localeCompare(b.subject_id) || a.id.localeCompare(b.id)),
      shapes: shapes.sort((a, b) => a.id.localeCompare(b.id)), conflicts,
      evidence: [...evidence.values()].sort((a, b) => a.id.localeCompare(b.id)), diagnostics, calls };
  } catch (error) {
    const result = budget.result(null, error);
    return { ...empty, state: 'partial', work: budget.work, diagnostics: result.diagnostics, calls };
  }
}
