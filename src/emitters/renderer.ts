import { OperationError, type Address, type Annotation, type CallClobbers, type Diagnostic, type Emitter, type OperationContext, type RegisterDescriptor } from '../core/index.js';
import { expressionOperands, type Effect, type Instruction, type Origin, type RegisterBinding, type Value } from '../ir/index.js';
import type { BlockRegion, Control, ControlArm, ParallelTransfer, Region } from '../presentation/index.js';
import type { CallFact, ContractObservation, LocationObservation } from '../analysis/calls/index.js';
import type { SignatureAssociation, SuppliedTypeRecord, TypeAssociation } from '../analysis/types/index.js';
import { expressionText, machineType } from './expressions.js';
import { Writer } from './writer.js';
import type { EmissionInput, EmissionResult } from './model.js';

type Options = Parameters<Emitter<EmissionInput>['emit']>[1];
/** Both dialects traverse the same verified presentation facts and effects. */
export class Renderer {
  private readonly writer: Writer;
  private readonly labels = new Map<string, BlockRegion>();
  private readonly values = new Map<string, Value>();
  private readonly effects = new Map<string, Effect>();
  private readonly origins = new Map<string, Origin>();
  private readonly names = new Map<string, string | null>();
  private readonly identifiers = new Map<string, EmissionResult['identifiers'][number]>();
  private readonly diagnostics: Diagnostic[] = [];
  private readonly associations = new Map<string, TypeAssociation[]>();
  private readonly signatures = new Map<string, SignatureAssociation[]>();
  private readonly calls = new Map<string, CallFact>();
  private readonly typeRecords = new Map<string, SuppliedTypeRecord[]>();
  private readonly notes = new Map<string, Annotation[]>();
  private readonly emittedNotes = new Set<string>();
  private readonly statementIds = new Set<string>();
  private readonly controlIds = new Set<string>();
  private readonly mappedStatements = new Set<string>();
  private readonly mappedControls = new Set<string>();
  private readonly conflictingSubjects = new Set<string>();
  private temporary = 0;

  constructor(private readonly input: EmissionInput, private readonly options: Options, private readonly context: OperationContext, private readonly language: 'c-like' | 'python-like', private readonly version: string) {
    this.writer = new Writer(context, options.indent, options.include_evidence, language);
    this.origins.set(input.function.id, input.function);
    for (const conflict of input.types?.conflicts ?? []) {
      context.checkpoint(1); this.conflictingSubjects.add(conflict.subject_id);
    }
    for (const name of input.names ?? []) {
      context.checkpoint(1);
      this.writer.metadata(Buffer.byteLength(name.entity_id) + Buffer.byteLength(name.name));
      const previous = this.names.get(name.entity_id);
      if (previous !== undefined && previous !== name.name) {
        this.names.set(name.entity_id, null);
        this.report('conflicting_evidence', 'Multiple display names remain ambiguous; a generated identifier is used.', name.entity_id);
      } else if (previous === undefined) this.names.set(name.entity_id, name.name);
    }
    for (const note of input.annotations ?? []) {
      context.checkpoint(1);
      if (note.status === 'retracted' || note.value.kind !== 'note') continue;
      const list = this.notes.get(note.entity_id) ?? [];
      list.push(note); this.notes.set(note.entity_id, list);
    }
    for (const type of input.types?.types ?? []) {
      context.checkpoint(1);
      const list = this.typeRecords.get(type.id) ?? []; list.push(type); this.typeRecords.set(type.id, list);
    }
    for (const association of input.types?.associations ?? []) {
      context.checkpoint(1);
      const list = this.associations.get(association.subject_id) ?? []; list.push(association); this.associations.set(association.subject_id, list);
    }
    for (const signature of input.types?.signatures ?? []) {
      context.checkpoint(1);
      const list = this.signatures.get(signature.subject_id) ?? []; list.push(signature); this.signatures.set(signature.subject_id, list);
    }
    for (const call of input.types?.calls?.calls ?? []) { context.checkpoint(1); this.calls.set(call.node_id, call); }
    this.collect(input.function.body, 0);
    if (!this.labels.has(input.function.entry)) this.invalid('Structured function has no entry block');
  }
  private invalid(message: string): never {
    throw new OperationError({ code: 'invalid_input', severity: 'error', message, evidence_ids: [] });
  }
  private report(code: 'conflicting_evidence' | 'unavailable_semantics', message: string, entity: string, evidence: readonly string[] = []): void {
    this.context.checkpoint(1 + evidence.length);
    if (this.diagnostics.length >= 1000 || evidence.length > 1000) this.writer.fail('Pseudocode diagnostic limit exceeded');
    this.writer.metadata(Buffer.byteLength(message) + entity.length + evidence.length * 80);
    this.diagnostics.push({ code, severity: 'warning', message, entity_id: entity, evidence_ids: this.options.include_evidence ? [...evidence] : [] });
  }
  private identifier(id: string, prefix: string): string {
    const existing = this.identifiers.get(id);
    if (existing) return existing.identifier;
    this.context.checkpoint(1);
    const original = this.names.get(id) ?? null;
    // ASCII prefixes prevent language keywords, reserved implementation names and helper
    // collisions; a monotonic suffix preserves identity even after escaping.
    let stem = '';
    if (original !== null) for (const character of original) {
      this.context.checkpoint(1);
      if (stem.length >= 40) break;
      stem += /[A-Za-z0-9_]/.test(character) ? character : '_';
    }
    const identifier = `${prefix}_${stem ? `${stem}_` : ''}${this.identifiers.size}`;
    this.writer.metadata(id.length + identifier.length + (original === null ? 0 : Buffer.byteLength(original)));
    this.identifiers.set(id, { entity_id: id, identifier, original_name: original });
    return identifier;
  }
  private value = (value: Value): string => this.identifier(value.id, 'v');
  private effect(effect: Effect): string { return this.identifier(effect.id, 'effect'); }
  private call(helper: string, explanation: string, args: readonly string[]): string {
    this.writer.helper(helper, explanation);
    return `${helper}(${this.writer.join(args)})`;
  }
  private collect(region: Region, depth: number): void {
    this.context.checkpoint(1);
    if (depth > 128) this.writer.fail('Structured input nesting exceeds 128');
    if (region.kind === 'sequence') { for (const child of region.regions) this.collect(child, depth + 1); return; }
    if (region.kind === 'loop') { this.collect(region.body, depth + 1); return; }
    if (this.labels.has(region.id)) this.invalid('Structured block is owned more than once');
    if (this.labels.size >= this.context.budget.blocks) this.writer.fail('Pseudocode block budget exceeded');
    this.labels.set(region.id, region); this.origins.set(region.id, region);
    this.effects.set(region.effect_parameter.id, region.effect_parameter);
    const recordValue = (value: Value, origin: Origin): void => {
      this.context.checkpoint(1);
      if (this.values.size >= this.context.budget.ir_nodes && !this.values.has(value.id)) this.writer.fail('Pseudocode value budget exceeded');
      this.values.set(value.id, value); this.origins.set(value.id, origin);
    };
    for (const parameter of region.parameters) recordValue(parameter, region);
    for (const node of region.statements) {
      this.context.checkpoint(1);
      if (this.statementIds.has(node.id)) this.invalid('Duplicate structured statement identity');
      if (this.statementIds.size >= this.context.budget.ir_nodes) this.writer.fail('Pseudocode statement budget exceeded');
      this.statementIds.add(node.id); this.origins.set(node.id, node);
      if ('result' in node) recordValue(node.result, node);
      if ('effect_out' in node) this.effects.set(node.effect_out.id, node.effect_out);
      if (node.kind === 'call') for (const result of node.results) recordValue(result, node);
      if (node.kind === 'call' || node.kind === 'unknown_effect') for (const binding of node.register_outputs) recordValue(binding.value, node);
    }
    if (this.controlIds.has(region.control.id)) this.invalid('Duplicate structured control identity');
    this.controlIds.add(region.control.id); this.origins.set(region.control.id, region.control);
    const c = region.control;
    if (c.kind === 'if') {
      if (c.when_true.body) this.collect(c.when_true.body, depth + 1);
      if (c.when_false.body) this.collect(c.when_false.body, depth + 1);
    } else if (c.kind === 'switch') {
      for (const item of c.cases) {
        this.context.checkpoint(1);
        if (item.arm.body) this.collect(item.arm.body, depth + 1);
      }
      if (c.otherwise.body) this.collect(c.otherwise.body, depth + 1);
    }
  }
  private dataOrigin(id: string, evidence: readonly string[] = []): Origin {
    return this.origins.get(id) ?? { id, provenance: { instruction_ids: [], ranges: [], evidence_ids: evidence, synthetic: ['Recovered presentation fact'] } };
  }
  private emitNotes(id: string, depth: number): void {
    for (const note of this.notes.get(id) ?? []) {
      this.context.checkpoint(1);
      if (this.emittedNotes.has(note.id) || note.value.kind !== 'note') continue;
      this.emittedNotes.add(note.id);
      const start = this.writer.offset;
      this.writer.comment(depth, `note ${note.status}/${note.origin} id=${this.writer.quote(note.id)} subject=${this.writer.quote(id)} author=${this.writer.quote(note.author)}: ${this.writer.quote(note.value.value)}`);
      this.writer.map(this.dataOrigin(id), start, [id], note.evidence_ids);
    }
  }
  private address(address: Address): string {
    return this.call('image_address', 'Image-qualified address-space value; no host pointer, ASLR assumption or memory read.', [this.writer.quote(address.image_id), this.writer.quote(address.space), `0x${address.value.toString(16)}`]);
  }
  private register(register: RegisterDescriptor): string {
    return this.call('register_slice', 'Arguments: identity, root, offset bits, width bits, root width bits, bank, role, write rule. This exact architectural slice is data, not a source variable or an inferred ABI argument.', [this.writer.quote(register.id), this.writer.quote(register.root), String(register.offset_bits), String(register.width_bits), String(register.root_width_bits), this.writer.quote(register.bank), this.writer.quote(register.role), this.writer.quote(register.write_rule)]);
  }
  private registers(bindings: readonly RegisterBinding[]): string {
    const parts = this.writer.list(bindings, binding => this.call('binding', 'Pair a physical register slice with its exact raw SSA value; omitted root bits are preserved, not zero-filled.', [this.register(binding.register), this.value(binding.value)]));
    return this.call('register_state', 'An explicit ordered snapshot of physical register slices. Not a source argument list; omitted registers are not invented. Every binding is read before an enclosing effect.', parts);
  }
  private clobbers(clobbers: CallClobbers): string {
    const registers = this.writer.list(clobbers.registers, register => this.register(register));
    const flags = this.writer.list(clobbers.flags, register => this.register(register));
    return this.call('clobbers', 'Arguments: memory contract, register slices, flag slices. Only specified physical slices may be overwritten; unknown_read_write is not purity, read_only still may read/fault. Unmentioned slices remain preserved.', [this.writer.quote(clobbers.memory), this.writer.sequence(registers), this.writer.sequence(flags)]);
  }
  private valueList(values: readonly Value[]): string {
    const parts = this.writer.list(values, this.value);
    return this.call('explicit_values', 'Explicit IR values only. An empty list is NOT evidence for zero source arguments or a void source return.', parts);
  }
  private instruction(node: Instruction, depth: number): void {
    this.emitNotes(node.id, depth);
    const start = this.writer.offset;
    const ids: string[] = [];
    let text: string;
    if (node.kind === 'assign') {
      for (const operand of expressionOperands(node.expression)) { this.context.checkpoint(1); ids.push(operand.id); }
      ids.push(node.result.id);
      text = `${this.value(node.result)} = ${expressionText(node.expression, node.result.type, this.writer, this.value)}`;
      if (node.expression.kind === 'indeterminate' && node.expression.state === 'unknown') this.report('unavailable_semantics', 'An unknown machine value is retained explicitly.', node.id, node.provenance.evidence_ids);
    } else {
      ids.push(node.effect_in.id, node.effect_out.id);
      const effect = this.effect(node.effect_in), output = this.effect(node.effect_out);
      switch (node.kind) {
        case 'read_register':
          ids.push(node.result.id);
          text = `(${output}, ${this.value(node.result)}) = ${this.call('read_register', 'Ordered physical register read. Return (next effect, raw slice value); a zero register yields zero. This is not a memory load.', [effect, this.register(node.register)])}`; break;
        case 'write_register':
          ids.push(node.value.id);
          text = `${output} = ${this.call('write_register', 'Ordered architectural register write; honor discard, preserve_other_bits, zero_extend_root or replace_root exactly as described by the register slice.', [effect, this.register(node.register), this.value(node.value)])}`; break;
        case 'load': case 'store': {
          ids.push(node.address.id, ...(node.kind === 'load' ? [node.result.id] : [node.value.id]));
          for (const binding of node.register_inputs) ids.push(binding.value.id);
          const args = [effect, this.value(node.address), this.writer.quote(machineType(node.kind === 'load' ? node.result.type : node.value.type))];
          if (node.kind === 'store') args.push(this.value(node.value));
          args.push(this.writer.quote(node.access.endian), String(node.access.alignment), this.language === 'c-like' ? String(node.access.volatile) : node.access.volatile ? 'True' : 'False', this.registers(node.register_inputs));
          const operation = this.call(node.kind === 'load' ? 'memory_load' : 'memory_store', 'Ordered, potentially faulting memory operation. Arguments: incoming effect, address, machine storage type, [stored value], endian, required alignment, volatile, pre-effect physical state. Access all type bits; preserve FP/vector payloads. Misalignment/unmapped memory can fault before producing the outgoing effect. No host pointer dereference or invented memory contents.', args);
          text = node.kind === 'load' ? `(${output}, ${this.value(node.result)}) = ${operation}` : `${output} = ${operation}`; break;
        }
        case 'call': case 'unknown_effect': {
          const destinations = [output], outputTypes: string[] = [], outputRegisters: string[] = [];
          if (node.kind === 'call') for (const value of node.results) { this.context.checkpoint(1); ids.push(value.id); destinations.push(this.value(value)); outputTypes.push(this.writer.quote(machineType(value.type))); }
          for (const binding of node.register_outputs) { this.context.checkpoint(1); ids.push(binding.value.id); destinations.push(this.value(binding.value)); outputRegisters.push(this.register(binding.register)); }
          for (const binding of node.register_inputs) { this.context.checkpoint(1); ids.push(binding.value.id); }
          const args = [effect];
          if (node.kind === 'call') {
            if (node.target.kind === 'indirect') ids.push(node.target.value.id);
            for (const value of node.arguments) { this.context.checkpoint(1); ids.push(value.id); }
            args.push(node.target.kind === 'direct' ? this.address(node.target.address) : this.value(node.target.value), this.valueList(node.arguments));
          } else args.push(this.writer.quote(node.reason));
          args.push(this.registers(node.register_inputs), this.clobbers(node.clobbers), this.writer.sequence(outputTypes), this.writer.sequence(outputRegisters));
          text = `(${this.writer.join(destinations)}${this.language === 'python-like' && destinations.length === 1 ? ',' : ''}) = ${this.call(node.kind === 'call' ? 'machine_call' : 'unknown_effect', 'An ordered, possibly faulting/nonreturning machine boundary, not a pure source call or a trap. Read all inputs before assigning outputs. Arguments: effect, target/reason, [explicit IR values], physical inputs, exact clobbers, explicit result types, physical output slices. Return tuple: next effect, explicit results, physical outputs in listed order. Unknown outputs are indeterminate; other slices are preserved. Empty explicit values do not establish source arity. Supplied source/ABI facts are separate labeled evidence and never override these effects.', args)}`;
          if (node.kind === 'unknown_effect') this.report('unavailable_semantics', 'Unknown instruction effects remain ordered and explicit.', node.id, node.provenance.evidence_ids);
          else {
            const fact = this.calls.get(node.id);
            if (!fact || fact.status !== 'established') this.report(fact?.status === 'conflicting' ? 'conflicting_evidence' : 'unavailable_semantics', 'Call source contract is unknown, candidate or conflicting; the physical machine call is retained.', node.id, fact?.evidence_ids ?? node.contract_evidence);
          }
          break;
        }
      }
    }
    this.writer.statement(depth, text);
    this.writer.map(node, start, ids, node.kind === 'call' ? node.contract_evidence : []);
    this.mappedStatements.add(node.id);
    if (node.kind === 'call') this.callFacts(node.id, depth);
  }
  private transfer(transfer: ParallelTransfer, origin: Origin, depth: number): void {
    const start = this.writer.offset;
    const ids = [transfer.target, transfer.effect.source.id, transfer.effect.destination.id];
    // All RHS reads, including the effect, precede EVERY destination write. This
    // remains correct for self edges, swaps and arbitrarily long phi cycles.
    const copies: { destination: string; temporary: string }[] = [];
    for (const copy of transfer.copies) {
      this.context.checkpoint(1);
      ids.push(copy.destination.id, copy.source.id);
      const temporary = `transfer_${this.temporary++}`;
      this.writer.statement(depth, this.writer.declaration(machineType(copy.destination.type), temporary, ` = ${this.value(copy.source)}`));
      copies.push({ destination: this.value(copy.destination), temporary });
    }
    const effectTemporary = `transfer_${this.temporary++}`;
    this.writer.statement(depth, this.writer.declaration('effect_t', effectTemporary, ` = ${this.effect(transfer.effect.source)}`));
    for (const copy of copies) this.writer.statement(depth, `${copy.destination} = ${copy.temporary}`);
    this.writer.statement(depth, `${this.effect(transfer.effect.destination)} = ${effectTemporary}`);
    if (!this.labels.has(transfer.target)) this.invalid('Transfer target has no structured label');
    // Explicit labeled break/continue cannot accidentally target an intervening
    // switch or the wrong nested loop. The structurer's next remains fallthrough.
    if (transfer.mode !== 'next') {
      const target = this.identifier(transfer.target, 'label'), mode = `${transfer.mode}${transfer.loop ? ` ${this.identifier(transfer.loop, 'label')}` : ''}`;
      this.writer.line(depth, this.language === 'c-like' ? `goto ${target}; /* ${mode} */` : `goto ${target}  # ${mode}; pseudocode transfer`);
    }
    this.writer.map(origin, start, ids);
  }
  private arm(arm: ControlArm, origin: Origin, depth: number): void {
    this.transfer(arm.transfer, origin, depth);
    if (arm.body) this.region(arm.body, depth);
  }
  private control(control: Control, block: BlockRegion, depth: number): void {
    this.emitNotes(control.id, depth);
    let start = this.writer.offset;
    switch (control.kind) {
      case 'jump': this.transfer(control.transfer, control, depth); break;
      case 'if':
        this.writer.line(depth, this.language === 'c-like' ? `if (${this.value(control.condition)}) {` : `if ${this.value(control.condition)}:`);
        this.writer.map(control, start, [control.condition.id, control.effect.id]);
        this.arm(control.when_true, control, depth + 1);
        this.writer.line(depth, this.language === 'c-like' ? '} else {' : 'else:');
        this.arm(control.when_false, control, depth + 1);
        if (this.language === 'c-like') this.writer.line(depth, '}'); break;
      case 'switch':
        this.writer.line(depth, this.language === 'c-like' ? `switch (${this.value(control.value)}) {` : `match ${this.value(control.value)}:`);
        this.writer.map(control, start, [control.value.id, control.effect.id]);
        for (const item of control.cases) {
          this.context.checkpoint(1);
          start = this.writer.offset;
          this.writer.line(depth + 1, this.language === 'c-like' ? `case 0x${item.bits.toString(16)}: {` : `case 0x${item.bits.toString(16)}:`);
          this.writer.map(control, start, [control.value.id]);
          this.arm(item.arm, control, depth + 2);
          if (this.language === 'c-like') { this.writer.line(depth + 2, 'break;'); this.writer.line(depth + 1, '}'); }
        }
        this.writer.line(depth + 1, this.language === 'c-like' ? 'default: {' : 'case _:');
        this.arm(control.otherwise, control, depth + 2);
        if (this.language === 'c-like') { this.writer.line(depth + 2, 'break;'); this.writer.line(depth + 1, '}'); this.writer.line(depth, '}'); } break;
      case 'return': case 'indirect': case 'trap': case 'unknown': {
        const args = [this.effect(control.effect)];
        const ids = [control.effect.id];
        if (control.kind === 'return') { args.push(this.valueList(control.values)); for (const value of control.values) ids.push(value.id); }
        else {
          if (control.kind === 'indirect') { args.push(this.value(control.target)); ids.push(control.target.id); }
          args.push(this.writer.quote(control.reason));
        }
        for (const binding of block.register_exit) { this.context.checkpoint(1); ids.push(binding.value.id); }
        args.push(this.registers(block.register_exit));
        const helper = control.kind === 'return' ? 'machine_return' : `${control.kind}_exit`;
        const description = control.kind === 'return' ? 'A machine return with final effect, explicit values and observable physical register state. Empty explicit values do NOT imply void; physical outputs remain observable.'
          : control.kind === 'trap' ? 'An established machine trap, with final effect, inert reason and physical state; unlike unknown_exit this is known to trap.'
            : control.kind === 'indirect' ? 'An unresolved indirect control transfer, with final effect, target, inert reason and physical state. Not a guessed call, return, trap or fallthrough.'
              : 'Unavailable control semantics with final effect, inert reason and physical state. Not a trap or a proven fallthrough; execution beyond this boundary is unknown.';
        this.writer.statement(depth, `return ${this.call(helper, `${description} The surrounding return exits the reconstruction model, not necessarily the native function.`, args)}`);
        this.writer.map(control, start, ids);
        if (control.kind === 'unknown' || control.kind === 'indirect') this.report('unavailable_semantics', 'A control boundary remains unresolved; no target or trap is invented.', control.id, control.provenance.evidence_ids);
        break;
      }
    }
    this.mappedControls.add(control.id);
  }
  private region(region: Region, depth: number): void {
    this.context.checkpoint(1);
    if (region.kind === 'sequence') { for (const child of region.regions) this.region(child, depth); }
    else if (region.kind === 'loop') {
      this.writer.line(depth, this.language === 'c-like' ? 'while (true) {' : 'while True:');
      this.region(region.body, depth + 1);
      if (this.language === 'c-like') this.writer.line(depth, '}');
    } else {
      this.emitNotes(region.id, depth);
      const start = this.writer.offset;
      this.writer.line(depth, this.language === 'c-like' ? `${this.identifier(region.id, 'label')}:;` : `label ${this.identifier(region.id, 'label')}:`);
      this.writer.map(region, start, region.parameters.map(value => value.id));
      for (const node of region.statements) this.instruction(node, depth);
      this.control(region.control, region, depth);
    }
  }
  private typeName(id: string): string { return this.identifier(id, 'source_type'); }
  private sourceFacts(): void {
    const w = this.writer;
    for (const [id, records] of this.typeRecords) {
      this.context.checkpoint(1);
      const name = this.typeName(id);
      for (const record of records) {
        this.context.checkpoint(1);
        const start = w.offset;
        const trusted = records.length === 1 && record.status === 'established' && !this.conflictingSubjects.has(id);
        const type = record.definition;
        w.comment(0, `source type ${w.quote(id)} ${record.status}/${record.source}; ${trusted ? 'unambiguous supplied definition' : 'evidence only, not an established declaration'}`);
        let declaration: string;
        switch (type.kind) {
          case 'void': declaration = this.language === 'c-like' ? `typedef void ${name};` : `type ${name} = void`; break;
          case 'unknown': declaration = this.language === 'c-like' ? `opaque_type ${name} /* size=${type.size === null ? 'unknown' : type.size.toString()} */;` : `type ${name} = opaque(size=${type.size === null ? 'unknown' : type.size.toString()})`; break;
          case 'integer': declaration = this.language === 'c-like' ? `typedef ${type.signed ? 'int' : 'uint'}${type.bits}_t ${name};` : `type ${name} = ${type.signed ? 'int' : 'uint'}${type.bits}_t`; break;
          case 'float': declaration = this.language === 'c-like' ? `typedef ieee${type.bits}_t ${name};` : `type ${name} = ieee${type.bits}_t`; break;
          case 'pointer': declaration = this.language === 'c-like' ? `typedef pointer64<${this.typeName(type.to)}> ${name};` : `type ${name} = pointer64[${this.typeName(type.to)}]`; break;
          case 'array': declaration = this.language === 'c-like' ? `typedef ${this.typeName(type.element)} ${name}[${type.count === null ? '?' : type.count.toString()}];` : `type ${name} = array[${this.typeName(type.element)}, ${type.count === null ? 'unknown' : type.count.toString()}]`; break;
          case 'vector': declaration = this.language === 'c-like' ? `typedef vector<${this.typeName(type.element)}, ${type.lanes}> ${name};` : `type ${name} = vector[${this.typeName(type.element)}, ${type.lanes}]`; break;
          case 'structure': {
            if (this.language === 'python-like') w.comment(0, `structure ${name}, size=${type.size === null ? 'unknown' : type.size.toString()}, alignment=${type.alignment ?? 'unknown'}; explicit byte offsets, no guessed padding`);
            else w.line(0, trusted ? `struct ${name} { /* size=${type.size === null ? 'unknown' : type.size.toString()}, alignment=${type.alignment ?? 'unknown'}; explicit byte offsets, no guessed padding */` : `/* structure evidence ${name}, size=${type.size === null ? 'unknown' : type.size.toString()}, alignment=${type.alignment ?? 'unknown'} */`);
            for (const field of type.fields) {
              this.context.checkpoint(1);
              const fieldStart = w.offset;
              const fieldName = this.identifier(field.id, 'field');
              if (this.language === 'python-like') w.comment(1, `${fieldName}: ${this.typeName(field.type_id)} @offset(${field.offset.toString()}); display name ${w.quote(field.name)}`);
              else {
                const text = `${this.typeName(field.type_id)} ${fieldName} @offset(${field.offset.toString()});`;
                w.line(1, trusted ? `${text} /* display name ${w.quote(field.name)} */` : `/* ${text} display name ${w.quote(field.name)} */`);
              }
              w.map(this.dataOrigin(field.id), fieldStart, [field.id, field.type_id], record.evidence_ids);
              this.emitNotes(field.id, 1);
            }
            if (trusted && this.language === 'c-like') w.line(0, '};');
            declaration = ''; break;
          }
        }
        if (declaration) {
          if (this.language === 'python-like') w.comment(0, declaration);
          else w.line(0, trusted ? declaration : `/* ${declaration.replaceAll('/*', '[').replaceAll('*/', ']')} */`);
        }
        w.map(this.dataOrigin(id), start, [id], record.evidence_ids);
      }
      this.emitNotes(id, 0);
    }
    for (const [subject, signatures] of this.signatures) {
      for (const association of signatures) {
        this.context.checkpoint(1);
        const start = w.offset, signature = association.signature;
        const trusted = signatures.length === 1 && association.status === 'established' && association.abi_state === 'complete' && !this.conflictingSubjects.has(subject);
        const parameters: string[] = [];
        for (const parameter of signature.parameters) {
          this.context.checkpoint(1);
          if (parameter.name !== null) w.comment(0, `parameter display name ${w.quote(parameter.id)}: ${w.quote(parameter.name)}`);
          parameters.push(w.declaration(this.typeName(parameter.type_id), this.identifier(parameter.id, 'arg')));
        }
        if (signature.variadic) parameters.push('...');
        w.comment(0, `source signature ${association.status}/${association.source}, ABI ${signature.abi}/${association.abi_state}, noreturn=${signature.noreturn}; subject=${w.quote(subject)}; separate from machine-state interface`);
        if (this.language === 'python-like') w.comment(0, `source_signature ${this.identifier(subject, subject === this.input.function.id ? 'fn' : 'call_site')}(${w.join(parameters)}) -> ${this.typeName(signature.return_type)}`);
        else {
          const declaration = `source_signature ${this.typeName(signature.return_type)} ${this.identifier(subject, subject === this.input.function.id ? 'fn' : 'call_site')}(${w.join(parameters) || 'void'});`;
          w.line(0, trusted ? declaration : `/* evidence only: ${declaration} */`);
        }
        w.map(this.dataOrigin(subject), start, [subject, signature.return_type, ...signature.parameters.map(parameter => parameter.id)], association.evidence_ids);
      }
    }
    for (const [subject, associations] of this.associations) for (const association of associations) {
      this.context.checkpoint(1);
      const start = w.offset;
      w.comment(0, `source view ${association.status}/${association.source}: subject=${w.quote(subject)}, type=${this.typeName(association.type_id)}, machine_offset_bits=${association.machine_offset_bits}, source_offset_bits=${association.value_offset_bits}, width_bits=${association.width_bits ?? 'unknown'}; no machine-type rewrite`);
      w.map(this.dataOrigin(subject), start, [subject, association.type_id], association.evidence_ids);
    }
    for (const shape of this.input.types?.shapes ?? []) {
      this.context.checkpoint(1);
      const start = w.offset;
      w.comment(0, `observed memory view ${w.quote(shape.id)} type=${this.typeName(shape.type_id)}, base=${shape.base.kind === 'stack' ? 'entry stack' : w.quote(shape.base.value_id)}, origin_offset=${shape.base_offset.toString()}, extent=${shape.observed_extent === null ? 'unknown' : `[${shape.observed_extent.start.toString()}, ${shape.observed_extent.end.toString()})`}; observed accesses are NOT object size; alias=${shape.alias}, escape=${shape.escape}, dynamic=${shape.dynamic}`);
      w.map(this.dataOrigin(shape.id), start, [shape.id, shape.type_id], shape.evidence_ids);
      for (const field of shape.fields) {
        this.context.checkpoint(1 + field.node_ids.length + field.value_ids.length);
        const fieldStart = w.offset;
        w.comment(0, `observed field ${w.quote(field.id)}, displacement=${field.offset.toString()}, width_bits=${field.width_bits}, access=${w.join(field.access)}, stride=${field.stride === null ? 'unknown' : field.stride.toString()}, count=unknown; stack_region=${field.stack_region === null ? 'unknown' : w.quote(field.stack_region)}`);
        w.map(this.dataOrigin(field.id), fieldStart, [field.id, ...field.node_ids, ...field.value_ids], field.evidence_ids);
        this.emitNotes(field.id, 0);
      }
      this.emitNotes(shape.id, 0);
    }
    for (const conflict of this.input.types?.conflicts ?? []) {
      this.context.checkpoint(1);
      const start = w.offset;
      w.comment(0, `conflicting type evidence: ${w.quote(conflict.subject_id)}, ${conflict.reason}; alternatives ${w.join(conflict.alternatives.map(id => w.quote(id)))}`);
      w.map(this.dataOrigin(conflict.subject_id), start, [conflict.subject_id], conflict.evidence_ids);
      this.report('conflicting_evidence', 'Recovered source type/signature alternatives conflict and remain labeled evidence.', conflict.subject_id, conflict.evidence_ids);
    }
    if (this.input.types?.state === 'partial') this.report('unavailable_semantics', 'Type recovery was partial; omitted source facts are unknown, not absent.', this.input.function.id);
  }
  private contractFacts(observations: readonly ContractObservation[], subject: string, depth: number): void {
    const w = this.writer;
    for (const observation of observations) {
      this.context.checkpoint(1);
      const start = w.offset, signature = observation.contract.signature, layout = observation.layout;
      w.comment(depth, `ABI contract ${w.quote(observation.contract.id)} ${observation.status}/${layout.state}; boundary=${observation.boundary_id === null ? 'not observed' : w.quote(observation.boundary_id)}; argument count=${signature.parameters === null ? 'unknown' : signature.parameters.length}, fixed=${signature.fixed_parameter_count}, variadic=${signature.variadic}, noreturn=${observation.contract.noreturn ?? 'unknown'}; stack_bytes=${layout.stack_bytes.toString()}, shadow_space=${layout.shadow_space.toString()}, stack_alignment=${layout.stack_alignment}; observations do not imply initialization`);
      const location = (role: string, item: LocationObservation): void => {
        this.context.checkpoint(1);
        const loc = item.location;
        const description = loc.kind === 'register' ? `${this.register(loc.register)} source_offset_bits=${loc.value_offset_bits} width_bits=${loc.width_bits}`
          : loc.kind === 'stack' ? `stack_offset=${loc.offset.toString()} size=${loc.size.toString()} alignment=${loc.alignment} source_offset_bits=${loc.value_offset_bits}`
            : `indirect pointer=${'stack_offset' in loc.pointer ? `stack(${loc.pointer.stack_offset.toString()})` : this.register(loc.pointer)} size=${loc.size.toString()} alignment=${loc.alignment}`;
        w.comment(depth, `${role}: ${description}; initialization=${item.fact.initialization}, pointee_initialization=${item.pointee?.initialization ?? 'not observed'}`);
      };
      for (const parameter of observation.parameters) for (const item of parameter.locations) location(`parameter ${parameter.index}`, item);
      if (observation.hidden_result) location('hidden result', observation.hidden_result);
      for (const item of observation.returns) location('return fragment', item);
      w.map(this.dataOrigin(subject), start, [subject], observation.contract.evidence_ids);
    }
  }
  private callFacts(id: string, depth: number): void {
    const fact = this.calls.get(id);
    if (!fact) return;
    const start = this.writer.offset;
    this.writer.comment(depth, `call facts: ${fact.status}, noreturn=${fact.noreturn}; machine continuation above is retained`);
    for (const target of fact.targets) {
      this.context.checkpoint(1);
      const description = target.target.kind === 'address' ? this.address(target.target.address) : `${this.writer.quote(target.target.image_id)}:${this.writer.quote(target.target.import_id)}`;
      this.writer.comment(depth, `${target.status} target: ${description}`);
    }
    this.contractFacts(fact.contracts, id, depth);
    this.writer.map(this.dataOrigin(id), start, [id], fact.evidence_ids);
  }
  render(): EmissionResult {
    const w = this.writer;
    if (this.language === 'c-like') {
      w.helper('machine_model', 'C-like pseudocode, not original or necessarily compilable C. bitsN_t are exact unsigned bit patterns (1..2048 bits); ieee/vector types retain raw bits. Comparisons and ?: propagate unknown/undefined; ?: selects only one operand. A control condition that is indeterminate leaves control unknown, never silently false. Tuple assignments read all RHS values before writes. effect_t orders memory, faults and calls; explicit snapshots expose architectural state. Source declarations are separate evidence and never change machine arithmetic. Type widths, structure offsets and unknown extents are target facts, not host C layout.');
      w.comment(0, 'C-like machine reconstruction; not original or necessarily compilable C. Source declarations below are separate evidence.');
    } else {
      w.helper('machine_model', 'Python-like machine pseudocode, NOT executable Python or recovered source. bitsN_t are exact unsigned bit patterns (1..2048 bits); ieee/vector types retain raw bits. Helpers implement finite-width machine operations, never Python unbounded integer arithmetic. Comparisons and conditional expressions propagate unknown/undefined; only the selected operand contributes. Indeterminate if/match conditions leave control unknown, never false or the default case. Tuple assignments read all RHS before writes; typed transfer temporaries preserve parallel copies including cycles. label/goto are explicit non-Python control transfers, including labeled break/continue. effect_t orders memory, faults and calls; unknown effects are not no-ops. Source type/signature facts are evidence, not executable Python annotations or host layout.');
      w.comment(0, 'Python-like machine pseudocode; NOT executable Python or recovered source. Finite-width helpers, ordered effects and label/goto use the machine_model dialect, not Python runtime semantics.');
    }
    for (const name of this.input.names ?? []) {
      this.context.checkpoint(1);
      const start = w.offset;
      w.comment(0, `display label subject=${w.quote(name.entity_id)}${this.names.get(name.entity_id) === null ? ' conflicting' : ''}: ${w.quote(name.name)}`);
      w.map(this.dataOrigin(name.entity_id), start, [name.entity_id]);
    }
    this.sourceFacts();
    if (this.input.types?.calls) this.contractFacts(this.input.types.calls.function_contracts, this.input.function.id, 0);
    this.emitNotes(this.input.function.id, 0);
    const functionName = this.identifier(this.input.function.id, 'fn');
    if (this.names.get(this.input.function.id)) w.comment(0, `function display name: ${w.quote(this.names.get(this.input.function.id)!)}`);
    const headerStart = w.offset;
    w.line(0, this.language === 'c-like' ? `machine_exit ${functionName}(machine_state incoming) {` : `def ${functionName}(incoming: machine_state) -> machine_exit:`);
    w.map(this.input.function, headerStart);
    const entry = this.labels.get(this.input.function.entry)!;
    const entryValues = new Set(entry.parameters.map(value => value.id));
    const entryBindings = new Map<string, RegisterDescriptor[]>();
    for (const binding of entry.register_entry) {
      this.context.checkpoint(1);
      const bindings = entryBindings.get(binding.value.id) ?? [];
      bindings.push(binding.register); entryBindings.set(binding.value.id, bindings);
    }
    for (const value of this.values.values()) {
      this.context.checkpoint(1);
      const start = w.offset;
      let initializer = '';
      if (entryValues.has(value.id)) {
        const physical: string[] = [];
        for (const register of entryBindings.get(value.id) ?? []) { this.context.checkpoint(1); physical.push(this.register(register)); }
        initializer = ` = ${this.call('entry_value', 'Arguments: incoming machine state, semantic value identity, machine type, physical bindings. Read the supplied entry value, not zero or an invented source parameter. No bindings means an explicit nonphysical IR entry parameter. Empty formal IR arrays do not establish source arity.', ['incoming', w.quote(value.id), w.quote(machineType(value.type)), w.sequence(physical)])}`;
      }
      w.statement(1, w.declaration(machineType(value.type), this.value(value), initializer));
      w.map(this.dataOrigin(value.id), start, [value.id]);
      this.emitNotes(value.id, 1);
    }
    for (const effect of this.effects.values()) {
      this.context.checkpoint(1);
      w.statement(1, w.declaration('effect_t', this.effect(effect), effect.id === entry.effect_parameter.id ? ` = ${this.call('entry_effect', 'The incoming ordered memory/machine effect token, not a new empty memory state.', ['incoming'])}` : ''));
    }
    w.statement(1, `goto ${this.identifier(entry.id, 'label')}`);
    this.region(this.input.function.body, 1);
    if (this.language === 'c-like') w.line(0, '}');
    // Notes on storage/field/other eligible semantic subjects remain inspectable
    // even when no executable declaration exists for that subject after DCE.
    for (const subject of this.notes.keys()) this.emitNotes(subject, 0);
    for (const item of this.input.function.coverage) {
      this.context.checkpoint(1 + item.statement_ids.length);
      if (!this.labels.has(item.block_id) || !this.mappedControls.has(item.terminator_id)) this.invalid('Structured coverage contains an unmapped block/control');
      for (const id of item.statement_ids) if (!this.mappedStatements.has(id)) this.invalid('Structured coverage contains an unmapped statement');
    }
    return {
      emission: { language: this.language, emitter_version: this.version, text: w.text(), span_unit: 'utf16', reconstruction: 'pseudocode', mappings: w.mappings, helpers: w.helpers },
      diagnostics: this.diagnostics,
      coverage: { statements: this.statementIds.size, controls: this.controlIds.size, mapped_statements: this.mappedStatements.size, mapped_controls: this.mappedControls.size },
      identifiers: [...this.identifiers.values()],
    };
  }
}
