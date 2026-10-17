import {
  OperationError,
  type Address,
  type Annotation,
  type CallClobbers,
  type Diagnostic,
  type Emitter,
  type OperationContext,
  type RegisterDescriptor,
} from '../core/index.js';
import {
  bitWidth,
  expressionOperands,
  type DataType,
  type Expression,
  type Instruction,
  type Origin,
  type RegisterBinding,
  type Value,
} from '../ir/index.js';
import type {
  BlockRegion,
  Control,
  ControlArm,
  ParallelTransfer,
  Region,
} from '../presentation/index.js';
import type { SuppliedTypeRecord } from '../analysis/types/index.js';
import { reconstruct } from '../reconstruction/index.js';
import type { Reconstruction } from '../reconstruction/model.js';
import { validateReconstruction, validateRenderedTransfers } from '../reconstruction/validate.js';
import type { SourceAddress } from '../reconstruction/source-model.js';
import { sourceDataValues } from '../reconstruction/source-data.js';
import { LocalValidationSession, rejectTranslation, validateParallelMoves, type PlannedMove } from '../reconstruction/local-validation.js';
import { validateEmittedControl, type EmittedEdge } from '../reconstruction/local-control-validation.js';
import { planSourceNames, sourceIdentifierStem } from '../reconstruction/source-names.js';
import { expressionText, machineType } from './expressions.js';
import { Writer } from './writer.js';
import type { EmissionInput, EmissionResult } from './model.js';
import { collectInferences } from './inference.js';

type Options = Parameters<Emitter<EmissionInput>['emit']>[1];
type Nest =
  | { readonly kind: 'loop'; readonly header: string; readonly follow: string | null }
  | { readonly kind: 'switch' };

/** Only syntax lives here: both dialects consume the same reconstructed program. */
export class Renderer {
  private readonly writer: Writer;
  private readonly program: Reconstruction;
  private readonly names = new Map<string, string | null>();
  private readonly identifiers = new Map<string, EmissionResult['identifiers'][number]>();
  private readonly diagnostics: Diagnostic[] = [];
  private readonly origins = new Map<string, Origin>();
  private readonly statements = new Map<string, Instruction>();
  private readonly controls = new Map<string, Control>();
  private readonly notes = new Map<string, Annotation[]>();
  private readonly emittedNotes = new Set<string>();
  private readonly mappedStatements = new Set<string>();
  private readonly mappedControls = new Set<string>();
  private readonly inferenceSites = new Map<string, { readonly start: number; readonly end: number }>();
  private readonly labels = new Set<string>();
  private readonly gotos = new Set<ParallelTransfer>();
  private readonly localValidation: LocalValidationSession;
  private readonly emittedEdges = new Map<ParallelTransfer, EmittedEdge>();
  private readonly typeRecords = new Map<string, SuppliedTypeRecord | null>();
  private readonly sourceEvidence = new Map<string, { ids: Set<string>; evidence: Set<string> }>();
  private readonly expanding = new Set<string>();
  private temporary = 0;
  private expansionWork = 0;
  private headerStart = 0;
  private headerEnd = 0;

  private readonly sourceNames = new Map<string, string>();
  private readonly usedSourceNames = new Set<string>();
  private readonly sourceAddresses = new Map<string, SourceAddress | null>();
  private readonly sourceDataValue: (value: Value) => SourceAddress | undefined;
  private readonly sourceValueTypes = new Map<string, string>();
  private readonly sourceRoleNames: ReadonlyMap<string, string | null>;
  private sourceTemporary = 0;
  private sourceLocal = 0;
  constructor(
    private readonly input: EmissionInput,
    private readonly options: Options,
    private readonly context: OperationContext,
    private readonly language: 'c-like' | 'python-like',
    private readonly version: string,
  ) {
    this.writer = new Writer(context, options.indent, options.include_evidence, language);
    this.program = reconstruct(input, context);
    this.localValidation = this.program.local_validation_session ?? new LocalValidationSession(context);
    this.sourceDataValue = sourceDataValues(
      this.program.expressions, this.program.source?.addresses ?? [], context);
    this.origins.set(input.function.id, input.function);
    for (const diagnostic of this.program.diagnostics) {
      context.checkpoint(1);
      this.report(diagnostic);
    }
    for (const name of input.names ?? []) {
      context.checkpoint(1);
      this.writer.metadata(Buffer.byteLength(name.entity_id) + Buffer.byteLength(name.name));
      const previous = this.names.get(name.entity_id);
      if (previous !== undefined && previous !== name.name) {
        this.names.set(name.entity_id, null);
        this.report({
          code: 'conflicting_evidence',
          severity: 'warning',
          message: 'Multiple display names remain ambiguous; a generated identifier is used.',
          entity_id: name.entity_id,
          evidence_ids: [],
        });
      } else if (previous === undefined) this.names.set(name.entity_id, name.name);
    }
    this.sourceRoleNames = planSourceNames(this.program, this.names, input.types, context);
    for (const note of input.annotations ?? []) {
      context.checkpoint(1);
      if (note.status === 'retracted' || note.value.kind !== 'note') continue;
      const list = this.notes.get(note.entity_id) ?? [];
      list.push(note);
      this.notes.set(note.entity_id, list);
    }
    for (const record of input.types?.types ?? []) {
      context.checkpoint(1);
      this.typeRecords.set(record.id, this.typeRecords.has(record.id) ? null : record);
    }
    for (const signature of input.types?.signatures ?? []) {
      context.checkpoint(1 + signature.signature.parameters.length + signature.evidence_ids.length);
      const row = this.sourceEvidence.get(signature.subject_id) ?? {
        ids: new Set<string>(),
        evidence: new Set<string>(),
      };
      row.ids.add(signature.signature.return_type);
      for (const parameter of signature.signature.parameters) {
        row.ids.add(parameter.id);
        row.ids.add(parameter.type_id);
      }
      for (const id of signature.evidence_ids) row.evidence.add(id);
      for (const requirement of signature.implicit_register_inputs) {
        context.checkpoint(1 + requirement.fact.evidence_ids.length);
        for (const id of requirement.fact.evidence_ids) row.evidence.add(id);
      }
      this.sourceEvidence.set(signature.subject_id, row);
    }
    for (const item of this.program.source?.addresses ?? []) {
      context.checkpoint(1);
      const key = this.addressKey(item.address),
        previous = this.sourceAddresses.get(key);
      if (previous === undefined) this.sourceAddresses.set(key, item);
      else if (previous && (previous.name !== item.name || previous.string !== item.string))
        this.sourceAddresses.set(key, null);
    }
    for (const projection of this.program.calls.values()) {
      if (!projection.signature) continue;
      const declaration = projection.signature.signature;
      if (projection.results.length === 1)
        this.sourceValueTypes.set(projection.results[0]!.id, declaration.return_type);
    }
    for (const block of this.program.blocks.values()) {
      context.checkpoint(1);
      this.origins.set(block.id, block);
      for (const value of block.parameters) this.origins.set(value.id, { ...block, id: value.id });
      for (const node of block.statements) {
        context.checkpoint(1);
        if (this.statements.has(node.id)) this.invalid('Duplicate structured statement identity');
        this.statements.set(node.id, node);
        this.origins.set(node.id, node);
        if ('result' in node) this.origins.set(node.result.id, node);
        if (node.kind === 'call')
          for (const value of node.results) this.origins.set(value.id, node);
        if (node.kind === 'call' || node.kind === 'unknown_effect')
          for (const binding of node.register_outputs) this.origins.set(binding.value.id, node);
      }
      if (this.controls.has(block.control.id))
        this.invalid('Duplicate structured control identity');
      this.controls.set(block.control.id, block.control);
      this.origins.set(block.control.id, block.control);
    }
    if (!this.program.blocks.has(input.function.entry))
      this.invalid('Structured function has no entry block');
    this.findLabels(input.function.body, [], 0);
    validateReconstruction(this.program, context);
    validateRenderedTransfers(input.function, this.gotos, language, context);
  }

  private invalid(message: string): never {
    throw new OperationError({
      code: 'invalid_input',
      severity: 'error',
      message,
      evidence_ids: [],
    });
  }

  private report(diagnostic: Diagnostic): void {
    this.context.checkpoint(1 + diagnostic.evidence_ids.length);
    if (this.diagnostics.length >= 1000 || diagnostic.evidence_ids.length > 1000)
      this.writer.fail('Pseudocode diagnostic limit exceeded');
    this.writer.metadata(
      Buffer.byteLength(diagnostic.message) +
        (diagnostic.entity_id?.length ?? 0) +
        diagnostic.evidence_ids.length * 80,
    );
    this.diagnostics.push({
      ...diagnostic,
      evidence_ids: this.options.include_evidence ? diagnostic.evidence_ids : [],
    });
  }

  private identifier(id: string, prefix: string): string {
    const existing = this.identifiers.get(id);
    if (existing) return existing.identifier;
    this.context.checkpoint(1);
    const original = this.names.get(id) ?? null;
    let stem = '';
    if (original !== null)
      for (const character of original) {
        this.context.checkpoint(1);
        if (stem.length >= 40) break;
        stem += /[A-Za-z0-9_]/.test(character) ? character : '_';
      }
    const identifier = `${prefix}_${stem ? `${stem}_` : ''}${this.identifiers.size}`;
    this.writer.metadata(
      id.length + identifier.length + (original === null ? 0 : Buffer.byteLength(original)),
    );
    this.identifiers.set(id, { entity_id: id, identifier, original_name: original });
    return identifier;
  }

  private sourceIdentifier(id: string, preferred: string): string {
    const previous = this.identifiers.get(id);
    if (previous) return previous.identifier;
    const stack = this.program.source?.stack;
    const entryStack = (stack?.kind === 'entry' && stack.base.id === id) ||
      this.program.parameter_registers.get(id)?.role === 'stack_pointer';
    const stem = entryStack ? 'entry_sp' : sourceIdentifierStem(preferred);
    let name = stem,
      suffix = 1;
    while (this.usedSourceNames.has(name)) {
      this.context.checkpoint(1);
      name = `${stem}_${suffix++}`;
    }
    this.usedSourceNames.add(name);
    this.writer.metadata(id.length + name.length + Buffer.byteLength(preferred));
    this.identifiers.set(id, {
      entity_id: id,
      identifier: name,
      original_name: this.names.get(id) ?? null,
    });
    return name;
  }

  private local(value: Value): string {
    return this.program.source
      ? (this.identifiers.get(value.id)?.identifier ??
          this.sourceIdentifier(
            value.id,
            this.names.get(value.id) ?? this.sourceRoleNames.get(value.id) ?? `value${this.sourceTemporary++}`,
          ))
      : this.identifier(value.id, 'v');
  }

  private valueType(value: Value): string {
    const source = this.sourceValueTypes.get(value.id) ??
      this.program.source?.value_types?.get(value.id)?.type_id;
    if (source) return this.sourceType(source);
    return this.dataType(value.type);
  }

  private dataType(type: DataType): string {
    return this.program.source && type.kind === 'integer'
      ? type.bits === 1
        ? 'bool'
        : `uint${type.bits}_t`
      : machineType(type);
  }

  private sourceInterpretation(value: Value, text: string, id?: string): string {
    if (!this.program.source) return text;
    id ??= this.sourceValueTypes.get(value.id) ?? this.program.source.value_types?.get(value.id)?.type_id;
    const type = id && this.typeRecords.get(id)?.definition;
    if (!type || (type.kind !== 'integer' && type.kind !== 'pointer') ||
      type.bits !== bitWidth(value.type) || value.type.kind !== 'integer') return text;
    if (type.kind === 'pointer')
      return this.language === 'c-like'
        ? `((${this.sourceType(id!)})(uintptr_t)(${text}))`
        : this.call('uint64', 'Interpret exact target pointer bits without a host pointer or inferred object bounds.', [text]);
    if (!type.signed) return text;
    return this.language === 'c-like' ? `((int${type.bits}_t)(${text}))`
      : this.call(`int${type.bits}`, 'Interpret the proven source signed scalar from its unchanged machine bits.', [text]);
  }

  private expression(expression: Expression, type: DataType): string {
    return expressionText(
      expression,
      type,
      this.writer,
      this.value,
      this.program.source ? { address: this.sourceAddress } : undefined,
    );
  }
  private value = (value: Value): string => {
    this.context.checkpoint(1);
    const stack = this.program.source?.stack,
      offset = this.program.source?.stack_addresses.get(value.id);
    if (stack && offset !== undefined) {
      if (stack.kind === 'entry') {
        const base = this.value(stack.base);
        if (offset === 0n) return base;
        const address = `(${base} ${offset < 0n ? '-' : '+'} ${offset < 0n ? -offset : offset})`;
        return this.language === 'c-like'
          ? `((uintptr_t)${address})`
          : this.call('uint64', 'Wrap an entry-stack byte address to the target pointer width.', [address]);
      }
      return this.language === 'c-like'
        ? `((uintptr_t)&stack_frame[${offset - stack.minimum_offset}])`
        : `address_of(stack_frame, ${offset - stack.minimum_offset})`;
    }
    const expression = this.program.inline.has(value.id)
      ? this.program.expressions.get(value.id)
      : undefined;
    if (!expression) {
      const name = this.local(value),
        id = this.sourceValueTypes.get(value.id) ??
          this.program.source?.value_types?.get(value.id)?.type_id;
      const type = id && this.typeRecords.get(id)?.definition;
      if (this.program.source && type && type.kind === 'integer' && type.signed)
        return this.language === 'c-like'
          ? `((uint${type.bits}_t)(${name}))`
          : this.call(
              `uint${type.bits}`,
              'Convert a signed source result back to its exact ABI bit pattern.',
              [name],
            );
      if (this.program.source && type && type.kind === 'pointer')
        return this.language === 'c-like' ? `((uintptr_t)(${name}))`
          : this.call('uint64', 'Read a source pointer as exact target address bits before machine byte arithmetic.', [name]);
      return name;
    }
    if (this.expanding.has(value.id)) this.invalid('Cyclic reconstructed expression');
    if (this.expanding.size >= 128 || ++this.expansionWork > this.context.budget.ir_nodes * 64)
      this.writer.fail('Reconstructed expression expansion exceeds its budget');
    this.expanding.add(value.id);
    const text = this.expression(expression, value.type);
    this.expanding.delete(value.id);
    this.writer.guard(Buffer.byteLength(text));
    return text;
  };
  private call(helper: string, explanation: string, args: readonly string[]): string {
    this.writer.helper(helper, explanation);
    return `${helper}(${this.writer.join(args)})`;
  }

  private dataOrigin(id: string): Origin {
    return (
      this.origins.get(id) ?? {
        id,
        provenance: {
          instruction_ids: [],
          ranges: [],
          evidence_ids: [],
          synthetic: ['Reconstructed presentation subject'],
        },
      }
    );
  }

  private emitNotes(id: string, depth: number): void {
    for (const note of this.notes.get(id) ?? []) {
      this.context.checkpoint(1);
      if (this.emittedNotes.has(note.id) || note.value.kind !== 'note') continue;
      this.emittedNotes.add(note.id);
      const start = this.writer.offset;
      this.writer.comment(
        depth,
        `note ${note.status}/${note.origin} id=${this.writer.quote(note.id)} subject=${this.writer.quote(id)} author=${this.writer.quote(note.author)}: ${this.writer.quote(note.value.value)}`,
      );
      this.inferenceSites.set(id, { start, end: this.writer.offset });
      this.mapped(this.dataOrigin(id), start, [id], note.evidence_ids);
    }
  }

  private semanticIds(origin: Origin): string[] {
    const node = this.statements.get(origin.id);
    if (!node) return [];
    const ids: string[] = [];
    if ('result' in node) ids.push(node.result.id);
    if ('effect_in' in node) ids.push(node.effect_in.id, node.effect_out.id);
    if (node.kind === 'assign')
      for (const value of expressionOperands(node.expression)) ids.push(value.id);
    if (node.kind === 'load' || node.kind === 'store') ids.push(node.address.id);
    if (node.kind === 'store' || node.kind === 'write_register') ids.push(node.value.id);
    if ('register_inputs' in node)
      for (const binding of node.register_inputs) ids.push(binding.value.id);
    if ('register_outputs' in node)
      for (const binding of node.register_outputs) ids.push(binding.value.id);
    if (node.kind === 'call') {
      for (const value of node.arguments) ids.push(value.id);
      for (const value of node.results) ids.push(value.id);
      if (node.target.kind === 'indirect') ids.push(node.target.value.id);
    }
    this.context.checkpoint(ids.length);
    return ids;
  }

  private mapped(
    origin: Origin,
    start: number,
    ids: readonly string[] = [],
    evidence: readonly string[] = [],
    end = this.writer.offset,
  ): void {
    const contributors = this.program.source?.value_origins;
    const resolve = (id: string): readonly string[] => contributors?.get(id) ?? [id];
    const subjects = [...resolve(origin.id), ...ids.flatMap(resolve)];
    this.context.checkpoint(subjects.length);
    const dataEvidence = new Set(evidence), semanticSubjects = new Set(subjects);
    for (const id of [origin.id, ...ids, ...subjects]) {
      const type = this.program.source?.value_types?.get(id);
      if (type) {
        semanticSubjects.add(type.type_id);
        for (const subject of [...type.association_ids, ...type.subject_ids]) semanticSubjects.add(subject);
        for (const evidenceId of type.evidence_ids) dataEvidence.add(evidenceId);
      }
      const value = this.program.values.get(id);
      if (!value) continue;
      const data = this.sourceDataValue(value);
      for (const evidenceId of data?.object?.evidence_ids ?? []) dataEvidence.add(evidenceId);
    }
    this.writer.map({ ...origin, id: subjects[0] ?? origin.id }, start, [...semanticSubjects], [...dataEvidence], end);
  }

  private map(
    origin: Origin,
    start: number,
    ids: readonly string[] = [],
    end = this.writer.offset,
  ): void {
    if (start === end) {
      start = this.headerStart;
      end = this.headerEnd;
    }
    const origins = this.program.origins.get(origin.id) ?? [];
    const seen = new Set<string>();
    for (const contributor of [origin, ...origins]) {
      this.context.checkpoint(1);
      if (seen.has(contributor.id)) continue;
      seen.add(contributor.id);
      this.mapped(contributor, start, [...ids, ...this.semanticIds(contributor)], [], end);
      if (this.statements.has(contributor.id)) this.mappedStatements.add(contributor.id);
      if (this.controls.has(contributor.id)) this.mappedControls.add(contributor.id);
    }
  }

  private addressKey(address: Address): string {
    return `${address.image_id}:${address.space}:${address.value}`;
  }
  private sourceAddress = (address: Address, literal = false): string => {
    const key = this.addressKey(address),
      item = this.sourceAddresses.get(key);
    if (literal && item?.string !== undefined)
      return this.writer
        .quote(item.string)
        .replace(/\\u000a/g, '\\n')
        .replace(/\\u000d/g, '\\r')
        .replace(/\\u0009/g, '\\t')
        .replace(/\\u0000/g, '\\0');
    if (item?.object) {
      const object = item.object;
      return this.call(
        'data_address',
        'Exact image-backed byte storage address: identity, original VA base, byte offset, known extent (or unknown), mutability and data kind. Returns base + offset without reading, folding, allocating or rebasing storage. Not indexing into a neighbouring literal; original memory ordering and faults remain explicit.',
        [
          this.writer.quote(item.name ?? `data_${object.address.value.toString(16)}`),
          `0x${object.address.value.toString(16)}`,
          `0x${object.offset.toString(16)}`,
          object.byte_length === null ? this.writer.quote('unknown') : `0x${object.byte_length.toString(16)}`,
          this.language === 'c-like' ? String(object.mutable) : object.mutable ? 'True' : 'False',
          this.writer.quote(object.kind),
        ],
      );
    }
    if (item?.name) {
      const name = this.sourceNames.get(key) ?? this.sourceIdentifier(key, item.name);
      this.sourceNames.set(key, name);
      return this.language === 'c-like' ? `((uintptr_t)&${name})` : `address_of(${name})`;
    }
    if (address.space === 'va') return `0x${address.value.toString(16)}`;
    return this.address(address);
  };
  private sourceAddressValue(value: Value, literal = false): string {
    const fact = this.input.types?.calls?.stack.values.get(value.id)?.value;
    if (fact?.kind === 'address') return this.sourceAddress(fact.address, literal);
    const item = this.sourceDataValue(value);
    if (item) return this.sourceAddress(item.address, literal);
    if (fact?.kind === 'constant') {
      for (const address of this.program.source?.addresses ?? []) {
        this.context.checkpoint(1);
        if (address.address.space === 'va' && address.address.value === fact.bits)
          return this.sourceAddress(address.address, literal);
      }
    }
    return this.value(value);
  }

  private sourceCallee(node: Extract<Instruction, { kind: 'call' }>): string {
    if (node.target.kind === 'indirect') {
      const value = node.target.value;
      if (this.program.source && !this.program.inline.has(value.id)) {
        const id = this.sourceValueTypes.get(value.id) ??
          this.program.source.value_types?.get(value.id)?.type_id;
        const type = id && this.typeRecords.get(id)?.definition;
        // Callable context retains the declared pointer local; value() converts
        // pointers to integer bits for machine arithmetic, not invocation.
        if (type && type.kind === 'pointer') return this.local(value);
      }
      return this.value(value);
    }
    const key = this.addressKey(node.target.address),
      previous = this.sourceNames.get(key);
    if (previous) return previous;
    const projection = this.program.calls.get(node.id);
    let preferred = this.names.get(node.id) ?? `sub_${node.target.address.value.toString(16)}`;
    if (projection?.signature?.source === 'library' && this.input.source?.abi.id === 'darwin-arm64')
      preferred = preferred.replace(/^_/, '');
    const name = this.sourceIdentifier(node.id, preferred);
    this.sourceNames.set(key, name);
    return name;
  }

  private address(address: Address): string {
    return this.call(
      'image_address',
      'Image-qualified address-space value; no host pointer or assumed memory contents.',
      [
        this.writer.quote(address.image_id),
        this.writer.quote(address.space),
        `0x${address.value.toString(16)}`,
      ],
    );
  }

  private registerName(register: RegisterDescriptor): string {
    const root = register.root.slice(register.root.lastIndexOf(':') + 1);
    if (register.offset_bits === 0)
      return register.width_bits === register.root_width_bits
        ? root
        : `${root}_low${register.width_bits}`;
    if (register.offset_bits + register.width_bits === register.root_width_bits)
      return `${root}_high${register.width_bits}`;
    return `${root}_bits${register.offset_bits}_${register.offset_bits + register.width_bits - 1}`;
  }

  private registerKey(register: RegisterDescriptor): string {
    return this.writer.quote(`${register.root}:${register.offset_bits}:${register.width_bits}`);
  }

  private registers(bindings: readonly RegisterBinding[]): string {
    const parts: string[] = [];
    for (const binding of bindings) {
      this.context.checkpoint(1);
      parts.push(this.registerKey(binding.register), this.value(binding.value));
    }
    return this.call(
      'physical_inputs',
      'Alternating physical register-slice keys (root:offset:width, in bits) and values. A complete snapshot formed by overlaying these slices on the immutable entry physical environment captured by this function, never on the previous boundary. Omitted entry slices retain their incoming values. Not inferred source arguments; read all values before the boundary.',
      parts,
    );
  }

  private clobbers(clobbers: CallClobbers): string {
    return this.call(
      'boundary',
      'Memory contract, clobbered physical register slices, clobbered flag slices. Only specified slices may change; unknown_read_write is not purity, and reads may fault.',
      [
        this.writer.quote(clobbers.memory),
        this.writer.sequence(
          this.writer.list(clobbers.registers, (register) => this.registerKey(register)),
        ),
        this.writer.sequence(
          this.writer.list(clobbers.flags, (register) => this.registerKey(register)),
        ),
      ],
    );
  }

  private values(values: readonly Value[]): string {
    return this.call(
      'explicit_values',
      'Explicit IR boundary values only; an empty list does not prove a void return or zero source arguments.',
      this.writer.list(values, this.value),
    );
  }

  private sourceType(id: string, depth = 0): string {
    this.context.checkpoint(1);
    if (depth > 32) return this.identifier(id, 'type');
    const record = this.typeRecords.get(id);
    if (
      !record ||
      (record.status !== 'established' &&
        record.status !== 'asserted' &&
        !(record.source === 'analysis' && record.status === 'candidate'))
    )
      return this.identifier(id, 'type');
    const type = record.definition;
    switch (type.kind) {
      case 'void':
        return 'void';
      case 'integer':
        return `${type.signed ? 'int' : 'uint'}${type.bits}_t`;
      case 'float':
        return `ieee${type.bits}_t`;
      case 'pointer':
        return this.language === 'c-like'
          ? `${this.sourceType(type.to, depth + 1)}*`
          : `pointer[${this.sourceType(type.to, depth + 1)}]`;
      case 'array':
        return `array<${this.sourceType(type.element, depth + 1)}, ${type.count === null ? '?' : type.count}>`;
      case 'vector':
        return `vector<${this.sourceType(type.element, depth + 1)}, ${type.lanes}>`;
      case 'structure':
      case 'unknown':
        return this.identifier(id, 'type');
    }
  }

  private storage(node: Extract<Instruction, { kind: 'load' | 'store' }>): string {
    const local = this.program.source?.locals.get(node.id);
    if (local)
      return (
        this.identifiers.get(local.id)?.identifier ??
        this.sourceIdentifier(local.id,
          this.names.get(local.id) ?? this.sourceRoleNames.get(local.id) ?? `local${this.sourceLocal++}`)
      );
    let address = this.sourceAddressValue(node.address);
    const type = node.kind === 'load' ? node.result.type : node.value.type,
      view = this.program.memory.get(node.id);
    if (view)
      address = this.call(
        view.shape.base.kind === 'stack' ? 'stack_slot' : 'field_view',
        'An exact observed memory view, not a scalar local or proof of object extent. Arguments: actual address, signed byte displacement from recovered base, access width in bits. Return the unchanged address; aliasing, faults and ordering remain those of memory. A scaled actual address retains its original index and stride without asserting an array bound.',
        [address, String(view.field.offset), String(view.field.width_bits)],
      );
    if (this.language === 'python-like') {
      const name = `${node.access.volatile ? 'volatile_' : ''}${node.access.endian === 'big' ? 'be_' : ''}${type.kind === 'integer' ? `u${type.bits}` : machineType(type)}`;
      this.writer.helper(
        `memory.${name}`,
        `Ordered ${node.access.endian}-endian ${bitWidth(type)}-bit memory view, alignment ${node.access.alignment}; aliasing and faults are preserved. It is not a scalar local.`,
      );
      return `memory.${name}[${address}]`;
    }
    const name =
      type.kind === 'integer'
        ? `${node.access.alignment * 8 < type.bits ? 'unaligned_' : ''}uint${type.bits}_t`
        : machineType(type);
    if (node.access.endian === 'big')
      return this.call(
        `memory_be${bitWidth(type)}`,
        'Big-endian memory lvalue; ordered access with original aliasing and fault behavior.',
        [address],
      );
    this.writer.helper(
      name,
      `Exact ${bitWidth(type)}-bit little-endian storage view with ${node.access.alignment}-byte required alignment; no strict-aliasing or padding assumption.`,
    );
    return `(*(${node.access.volatile ? 'volatile ' : ''}${name} *)(uintptr_t)(${address}))`;
  }

  private sourceCall(node: Extract<Instruction, { kind: 'call' }>): string {
    const projection = this.program.calls.get(node.id)!;
    const args = projection.arguments.map((value, index) => {
      this.context.checkpoint(1);
      const parameter = projection.signature?.signature.parameters[index];
      const pointer =
        parameter && this.typeRecords.get(parameter.type_id)?.definition.kind === 'pointer';
      const text = pointer ? this.sourceAddressValue(value, true) : this.value(value);
      if (pointer && this.language === 'c-like')
        return `((${this.sourceType(parameter.type_id)})(uintptr_t)(${text}))`;
      const type = parameter && this.typeRecords.get(parameter.type_id)?.definition;
      if (type?.kind === 'integer' && type.signed && this.language === 'python-like')
        return this.call(
          `int${type.bits}`,
          'Interpret source integer argument with its established signed ABI type.',
          [text],
        );
      return text;
    });
    if (projection.argument_list_complete === false || projection.kind === 'physical')
      args.push(
        this.call(
          projection.arguments.length ? 'unknown_argument_remainder' : 'unknown_arguments',
          'Unresolved remainder of a call interface; not zero arguments or a purity claim.',
          [],
        ),
      );
    const target = this.sourceCallee(node);
    this.writer.helper(
      target,
      `${projection.kind === 'source' ? 'Established' : 'Inferred or incomplete'} source call. Original target: ${node.target.kind === 'direct' ? this.writer.quote(this.addressKey(node.target.address)) : 'indirect'}. Original memory effect: ${node.clobbers.memory}. Calls remain ordered; unused machine clobbers are not source results.`,
    );
    const operation = `${target}(${this.writer.join(args)})`;
    const results = projection.results.filter((value) => this.program.live.has(value.id));
    return results.length
      ? `${results.length === 1 ? this.local(results[0]!) : `(${this.writer.join(results.map((value) => this.local(value)))})`} = ${operation}`
      : operation;
  }

  private instruction(node: Instruction, depth: number): void {
    this.emitNotes(node.id, depth);
    const start = this.writer.offset;
    let text: string;
    switch (node.kind) {
      case 'assign':
        text = `${this.local(node.result)} = ${this.sourceInterpretation(node.result,
          this.expression(this.program.expressions.get(node.result.id) ?? node.expression, node.result.type))}`;
        break;
      case 'read_register': {
        const operation = this.call(
          'read_register',
          'Ordered physical slice read; statement order carries effects.',
          [this.registerKey(node.register)],
        );
        text = this.program.live.has(node.result.id)
          ? `${this.local(node.result)} = ${operation}`
          : operation;
        break;
      }
      case 'write_register':
        text = this.call(
          'write_register',
          'Ordered architectural write; arguments: slice, value, write rule, root width. Honor discard/preserve/zero-extend/replace exactly.',
          [
            this.registerKey(node.register),
            this.value(node.value),
            this.writer.quote(node.register.write_rule),
            String(node.register.root_width_bits),
          ],
        );
        break;
      case 'memory_fence':
        text = this.call(
          'memory_fence',
          'DMB ISH ordering event: all explicit memory reads/writes before this statement are ordered before subsequent reads/writes within the inner-shareable domain. No memory bytes or registers are modified. acquire_release does not claim sequentially-consistent total order or DSB completion; never elide, duplicate, or move memory accesses across this event.',
          [this.writer.quote(node.scope), this.writer.quote(node.ordering), this.writer.quote(node.accesses)],
        );
        break;
      case 'load':
      case 'store': {
        if (this.program.source) {
          const storage = this.storage(node);
          text =
            node.kind === 'store'
              ? `${storage} = ${this.value(node.value)}`
              : this.program.live.has(node.result.id)
                ? `${this.local(node.result)} = ${this.sourceInterpretation(node.result, storage)}`
                : storage;
          break;
        }
        let address = this.value(node.address);
        const view = this.program.memory.get(node.id);
        if (view) {
          address = this.call(
            view.shape.base.kind === 'stack' ? 'stack_slot' : 'field_view',
            'An exact observed memory view, not a scalar local or proof of object extent. Arguments: actual address, signed byte displacement from recovered base, access width in bits. Return the unchanged address; aliasing, faults and ordering remain those of memory.',
            [address, String(view.field.offset), String(view.field.width_bits)],
          );
        }
        const args = [address];
        if (node.kind === 'store') args.push(this.value(node.value));
        args.push(
          this.writer.quote(machineType(node.kind === 'load' ? node.result.type : node.value.type)),
          this.writer.quote(node.access.endian),
          String(node.access.alignment),
          this.language === 'c-like'
            ? String(node.access.volatile)
            : node.access.volatile
              ? 'True'
              : 'False',
          this.registers(this.program.physical_inputs.get(node.id) ?? node.register_inputs),
        );
        const operation = this.call(
          node.kind === 'load' ? 'read_memory' : 'write_memory',
          'Ordered, potentially faulting memory access. Arguments: address, [stored value], machine type, endian, required alignment, volatile, physical boundary inputs. Access all storage bits, preserve float/vector payloads. No host pointer dereference; dead-result loads still execute.',
          args,
        );
        text =
          node.kind === 'load' && this.program.live.has(node.result.id)
            ? `${this.local(node.result)} = ${operation}`
            : operation;
        break;
      }
      case 'call':
      case 'unknown_effect': {
        if (this.program.source && node.kind === 'call') {
          text = this.sourceCall(node);
          break;
        }
        const projection = this.program.calls.get(node.id);
        const results = node.kind === 'call' ? (projection?.results ?? node.results) : [];
        const resultIds = new Set(results.map((value) => value.id));
        const outputs = (projection?.outputs ?? node.register_outputs).filter(
          (binding) => this.program.live.has(binding.value.id) && !resultIds.has(binding.value.id),
        );
        const inputs =
          projection?.inputs ?? this.program.physical_inputs.get(node.id) ?? node.register_inputs;
        const destinations: string[] = [];
        for (const result of results) {
          this.context.checkpoint(1);
          const name = this.program.live.has(result.id)
            ? this.local(result)
            : this.identifier(result.id, 'unused');
          if (!this.program.live.has(result.id))
            this.writer.statement(depth, this.writer.declaration(machineType(result.type), name));
          destinations.push(name);
        }
        for (const binding of outputs) destinations.push(this.local(binding.value));
        let operation: string;
        const source = node.kind === 'call' && projection?.kind === 'source';
        const ordinary =
          source &&
          node.kind === 'call' &&
          node.target.kind === 'direct' &&
          outputs.length === 0 &&
          inputs.length === 0;
        if (ordinary && node.kind === 'call' && node.target.kind === 'direct') {
          const target = this.identifier(node.id, 'fn');
          operation = `${target}(${this.writer.join(this.writer.list(projection.arguments, this.value))})`;
          this.writer.helper(
            target,
            `Proven source call to ${this.address(node.target.address)} using ${this.writer.quote(projection.signature!.signature.abi)} ABI with ${this.clobbers(node.clobbers)}. Statement order preserves memory/fault effects. Arguments and results retain the exact storage bits of their source types.`,
          );
        } else {
          const args: string[] = [];
          if (node.kind === 'call') {
            let target =
              node.target.kind === 'direct'
                ? this.address(node.target.address)
                : this.value(node.target.value);
            if (source)
              target = this.call(
                'source_target',
                'Inert display name and actual target address for a proven source call. Return the unchanged target; the name does not resolve or invent an address.',
                [this.writer.quote(this.identifier(node.id, 'fn')), target],
              );
            args.push(target, this.values(projection?.arguments ?? node.arguments));
          } else args.push(this.writer.quote(node.reason));
          args.push(this.registers(inputs), this.clobbers(node.clobbers));
          if (node.kind === 'call')
            args.push(
              this.writer.sequence(
                this.writer.list(results, (value) => this.writer.quote(machineType(value.type))),
              ),
            );
          args.push(
            this.writer.sequence(
              this.writer.list(outputs, (binding) => this.registerKey(binding.register)),
            ),
          );
          operation = this.call(
            source ? 'source_call' : node.kind === 'call' ? 'physical_call' : 'opaque_effect',
            source
              ? 'Proven source call with explicit implicit-ABI inputs and/or additional observable clobbers. Arguments: source target, source arguments, implicit physical inputs, boundary contract, source result storage types, additional physical output keys. Apply the established compatible ABI; return source results then requested physical outputs. Statement order preserves effects.'
              : 'Ordered unresolved machine boundary; not a pure call, trap, or no-op. Read inputs before writing outputs. Return tuple: explicit results (calls only), then requested physical output slices. Missing outputs remain unknown; unmentioned clobbers still occur. Statement order carries memory/fault effects; no effect-token variables are needed. Empty explicit arguments do not imply source arity.',
            args,
          );
        }
        const destination =
          ordinary && destinations.length === 1
            ? destinations[0]
            : `(${this.writer.join(destinations)}${this.language === 'python-like' && destinations.length === 1 ? ',' : ''})`;
        text = destinations.length ? `${destination} = ${operation}` : operation;
        break;
      }
    }
    this.writer.statement(depth, text);
    this.inferenceSites.set(node.id, { start, end: this.writer.offset });
    if (this.program.source && node.kind === 'call') {
      const projection = this.program.calls.get(node.id)!;
      const returned = new Set(projection.results.map((value) => value.id));
      for (const binding of projection.outputs)
        if (
          this.program.live.has(binding.value.id) &&
          !returned.has(binding.value.id) &&
          !this.program.expressions.has(binding.value.id)
        ) {
          const unknown = this.call(
            'unknown_value',
            'Live non-result call clobber; no source value or constant is invented.',
            [
              this.writer.quote(this.dataType(binding.value.type)),
              this.writer.quote(`call clobbers ${this.registerName(binding.register)}`),
            ],
          );
          this.writer.statement(depth, `${this.local(binding.value)} = ${unknown}`);
        }
    }
    this.map(node, start);
    if (node.kind === 'call') {
      const proof = this.sourceEvidence.get(node.id);
      this.mapped(node, start, proof ? [...proof.ids] : [], [
        ...node.contract_evidence,
        ...(proof?.evidence ?? []),
      ]);
    }
    const view = this.program.memory.get(node.id);
    if (view)
      this.mapped(
        node,
        start,
        [view.shape.id, view.field.id, view.shape.type_id,
          ...(this.program.source?.field_subjects?.get(node.id) ?? [])],
        [...view.shape.evidence_ids, ...view.field.evidence_ids],
      );
  }

  private ordinaryTransfer(
    transfer: ParallelTransfer,
    nesting: readonly Nest[],
    destination: string | null,
  ): boolean {
    if (transfer.mode === 'next') return transfer.target === destination;
    if (transfer.mode === 'goto')
      return !!this.program.source && transfer.target === destination;
    for (let i = nesting.length - 1; i >= 0; i--) {
      const item = nesting[i]!;
      if (item.kind !== 'loop') continue;
      if (transfer.loop !== item.header) return false;
      // A loop may have several exits. Only its actual lexical successor can
      // use break; other destinations must keep their explicit labeled edge.
      return transfer.mode === 'continue'
        ? transfer.target === item.header
        : transfer.target === item.follow &&
            (this.language === 'python-like' || nesting[nesting.length - 1]?.kind === 'loop');
    }
    return false;
  }

  private firstBlock(region: Region): string | null {
    this.context.checkpoint(1);
    if (region.kind === 'block') return region.id;
    if (region.kind === 'loop') return region.header;
    for (const child of region.regions) {
      const first = this.firstBlock(child);
      if (first) return first;
    }
    return null;
  }

  private findLabels(
    region: Region,
    nesting: readonly Nest[],
    depth: number,
    follow: string | null = null,
  ): void {
    this.context.checkpoint(1);
    if (depth > 128) this.writer.fail('Structured input nesting exceeds 128');
    if (region.kind === 'sequence') {
      let next = follow;
      for (let index = region.regions.length - 1; index >= 0; index--) {
        const child = region.regions[index]!;
        this.findLabels(child, nesting, depth + 1, next);
        next = this.firstBlock(child) ?? next;
      }
      return;
    }
    if (region.kind === 'loop') {
      this.findLabels(
        region.body,
        [...nesting, { kind: 'loop', header: region.header, follow }],
        depth + 1,
        region.header,
      );
      return;
    }
    const transfer = (item: ParallelTransfer): void => {
      if (!this.program.blocks.has(item.target))
        this.invalid('Transfer target has no structured block');
      if (!this.ordinaryTransfer(item, nesting, follow)) {
        this.labels.add(item.target);
        this.gotos.add(item);
      }
    };
    const arm = (item: ControlArm, nested: readonly Nest[]): void => {
      const destination = item.body ? this.firstBlock(item.body) : follow;
      if (!this.ordinaryTransfer(item.transfer, nested, destination)) {
        this.labels.add(item.transfer.target);
        this.gotos.add(item.transfer);
      }
      if (!this.program.blocks.has(item.transfer.target))
        this.invalid('Transfer target has no structured block');
      if (item.body) this.findLabels(item.body, nested, depth + 1, follow);
    };
    const control = region.control;
    if (control.kind === 'jump') transfer(control.transfer);
    if (control.kind === 'if') {
      arm(control.when_true, nesting);
      arm(control.when_false, nesting);
    }
    if (control.kind === 'switch') {
      const nested: readonly Nest[] = [...nesting, { kind: 'switch' }];
      for (const item of control.cases) {
        this.context.checkpoint(1);
        arm(item.arm, nested);
      }
      arm(control.otherwise, nested);
    }
  }

  private transfer(transfer: ParallelTransfer, depth: number, origin: Control): void {
    const copies = this.program.transfers.get(transfer);
    if (!copies) this.invalid('Reconstructed transfer is missing');
    const moves: PlannedMove[] = [];
    // A write is safe only after all other RHS readers of its destination ran.
    if (copies.length === 1) {
      const copy = copies[0]!;
      moves.push({ destination: copy.destination.id, source: copy.source });
      this.writer.statement(depth, `${this.local(copy.destination)} = ${
        this.sourceInterpretation(copy.destination, this.value(copy.source))}`);
    } else {
      type Move = {
        destination: Value;
        source: Value;
        dependencies: Set<string>;
        temporary?: string;
      };
      const pending = new Map<string, Move>();
      const readers = new Map<string, number>();
      for (const copy of copies) {
        this.context.checkpoint(1);
        pending.set(copy.destination.id, { ...copy, dependencies: new Set() });
        readers.set(copy.destination.id, 0);
      }
      for (const move of pending.values()) {
        const seen = new Set<string>();
        const values = [move.source];
        while (values.length) {
          this.context.checkpoint(1);
          const value = values.pop()!;
          if (seen.has(value.id)) continue;
          seen.add(value.id);
          const expression = this.program.inline.has(value.id)
            ? this.program.expressions.get(value.id)
            : undefined;
          if (expression) {
            for (const operand of expressionOperands(expression)) {
              this.context.checkpoint(1);
              values.push(operand);
            }
          } else if (value.id !== move.destination.id && pending.has(value.id)) {
            move.dependencies.add(value.id);
            readers.set(value.id, readers.get(value.id)! + 1);
          }
        }
      }
      const ready: Move[] = [];
      for (const move of pending.values()) {
        this.context.checkpoint(1);
        if (readers.get(move.destination.id) === 0) ready.push(move);
      }
      const release = (move: Move): void => {
        for (const dependency of move.dependencies) {
          this.context.checkpoint(1);
          const count = readers.get(dependency)! - 1;
          readers.set(dependency, count);
          if (count === 0) ready.push(pending.get(dependency)!);
        }
        move.dependencies.clear();
      };
      const candidates = pending.values();
      let next = 0;
      while (pending.size) {
        this.context.checkpoint(1);
        if (next === ready.length) {
          // A cycle remains. Capture one RHS, releasing its original SSA reads.
          // Inline expression leaves, not rendered text, determine those reads.
          let candidate = candidates.next().value;
          while (candidate && candidate.dependencies.size === 0) {
            this.context.checkpoint(1);
            candidate = candidates.next().value;
          }
          if (!candidate) this.invalid('Parallel transfer dependency cycle cannot be resolved');
          candidate.temporary = `transfer_${this.temporary++}`;
          if (moves.length <= 128) moves.push({ destination: candidate.temporary, source: candidate.source });
          this.writer.statement(
            depth,
            this.writer.declaration(
              this.dataType(candidate.source.type),
              candidate.temporary,
              ` = ${this.value(candidate.source)}`,
            ),
          );
          release(candidate);
        } else {
          const move = ready[next++]!;
          if (moves.length <= 128) moves.push({ destination: move.destination.id, source: move.temporary ?? move.source });
          this.writer.statement(
            depth,
            `${this.local(move.destination)} = ${
              this.sourceInterpretation(move.destination, move.temporary ?? this.value(move.source))}`,
          );
          pending.delete(move.destination.id);
          release(move);
        }
      }
    }
    if (copies.length) {
      const checked = this.localValidation.check('parallel-copy', transfer.effect.destination.id,
        'actual phi-copy emission', () => {
          this.localValidation.allowance.charge();
          if (transfer.copies.length > 64) return { kind: 'parallel-copy', subject: transfer.effect.destination.id,
            scope: 'actual phi-copy emission', status: 'unverified', reason: 'original edge copy bound exceeded' };
          return validateParallelMoves(transfer.effect.destination.id,
            transfer.copies.filter((copy) => {
              this.localValidation.allowance.charge();
              return this.program.live.has(copy.destination.id) && !this.program.inline.has(copy.destination.id);
            }), moves, (id) => {
              const expression = this.program.expressions.get(id);
              return this.program.inline.has(id) || (expression?.kind === 'cast' && expression.op === 'bitcast')
                ? expression : undefined;
            }, this.localValidation.allowance);
        }, [origin.id]);
      if (checked.status === 'rejected')
        rejectTranslation(checked, origin);
    }
    this.emittedEdges.set(transfer, this.gotos.has(transfer)
      ? { kind: 'goto', target: transfer.target }
      : { kind: transfer.mode === 'break' || transfer.mode === 'continue' ? transfer.mode : 'fallthrough' });
    if (this.gotos.has(transfer))
      this.writer.statement(depth, `goto ${this.identifier(transfer.target, 'label')}`);
    else if (transfer.mode === 'break' || transfer.mode === 'continue')
      this.writer.statement(depth, transfer.mode);
  }

  private arm(arm: ControlArm, depth: number, origin: Control): void {
    const start = this.writer.codeLines;
    this.transfer(arm.transfer, depth, origin);
    if (arm.body) this.region(arm.body, depth);
    if (this.language === 'python-like' && this.writer.codeLines === start)
      this.writer.statement(depth, 'pass');
  }

  private control(control: Control, block: BlockRegion, depth: number): void {
    this.emitNotes(control.id, depth);
    const start = this.writer.offset;
    const ids = [control.effect.id];
    switch (control.kind) {
      case 'jump':
        this.transfer(control.transfer, depth, control);
        ids.push(control.transfer.target, control.transfer.effect.destination.id);
        for (const copy of control.transfer.copies) ids.push(copy.source.id, copy.destination.id);
        break;
      case 'if': {
        ids.push(control.condition.id);
        const condition = this.value(control.condition);
        let conditionValue = control.condition,
          expression: Expression | undefined;
        for (
          let depth = 0;
          this.program.source && depth < 128 && this.program.inline.has(conditionValue.id);
          depth++
        ) {
          this.context.checkpoint(1);
          expression = this.program.expressions.get(conditionValue.id);
          if (expression?.kind !== 'cast' || expression.op !== 'bitcast') break;
          conditionValue = expression.value;
        }
        const grouped = expression?.kind === 'compare';
        this.writer.line(
          depth,
          this.language === 'c-like'
            ? `if ${grouped ? condition : `(${condition})`} {`
            : `if ${condition}:`,
        );
        this.arm(control.when_true, depth + 1, control);
        this.writer.line(depth, this.language === 'c-like' ? '} else {' : 'else:');
        this.arm(control.when_false, depth + 1, control);
        if (this.language === 'c-like') this.writer.line(depth, '}');
        break;
      }
      case 'switch':
        ids.push(control.value.id);
        this.writer.line(
          depth,
          this.language === 'c-like'
            ? `switch (${this.value(control.value)}) {`
            : `match ${this.value(control.value)}:`,
        );
        for (const item of control.cases) {
          this.context.checkpoint(1);
          this.writer.line(
            depth + 1,
            this.language === 'c-like'
              ? `case 0x${item.bits.toString(16)}: {`
              : `case 0x${item.bits.toString(16)}:`,
          );
          this.arm(item.arm, depth + 2, control);
          if (this.language === 'c-like') {
            this.writer.statement(depth + 2, 'break');
            this.writer.line(depth + 1, '}');
          }
        }
        this.writer.line(depth + 1, this.language === 'c-like' ? 'default: {' : 'case _:');
        this.arm(control.otherwise, depth + 2, control);
        if (this.language === 'c-like') {
          this.writer.statement(depth + 2, 'break');
          this.writer.line(depth + 1, '}');
          this.writer.line(depth, '}');
        }
        break;
      case 'return': {
        const projection = this.program.returns.get(control.id);
        for (const value of control.values) ids.push(value.id);
        for (const binding of block.register_exit) ids.push(binding.value.id);
        if (projection && projection.kind !== 'physical' && projection.outputs.length === 0) {
          const values = this.writer.list(projection.results, (value) =>
            this.program.source?.return_pointer && !this.program.source.return_source_type
              ? this.sourceAddressValue(value, true)
              : this.sourceInterpretation(value, this.value(value),
                this.program.signature?.signature.return_type ?? this.program.source?.return_source_type));
          this.writer.statement(
            depth,
            values.length
              ? `return ${values.length === 1 ? values[0] : `(${this.writer.join(values)})`}`
              : 'return',
          );
        } else {
          this.writer.statement(
            depth,
            `return ${this.call(
              projection?.kind === 'source' ? 'source_return' : 'physical_return',
              projection?.kind === 'source'
                ? 'Return proven source results while preserving changed observable physical slices. Apply the physical snapshot as an immutable-entry overlay; source result bits retain their established ABI interpretation.'
                : 'Return explicit IR values and changed observable physical slices. Unlisted unchanged entry slices retain their incoming values. This uncertain interface is not a guessed source return type or void signature.',
              [
                this.values(projection?.results ?? control.values),
                this.registers(
                  projection?.outputs ??
                    this.program.physical_exits.get(control.id) ??
                    block.register_exit,
                ),
              ],
            )}`,
          );
        }
        break;
      }
      case 'indirect':
      case 'trap':
      case 'unknown': {
        const tail = control.kind === 'indirect' && control.tail_call ? this.program.tails.get(control.id) : undefined;
        if (tail && this.program.source && control.kind === 'indirect') {
          const key = this.addressKey(tail.target), known = this.sourceAddresses.get(key);
          const name = this.sourceNames.get(key) ?? this.sourceIdentifier(control.id,
            this.names.get(control.id) ?? known?.name ?? `sub_${tail.target.value.toString(16)}`);
          this.sourceNames.set(key, name);
          const arguments_ = tail.boundary.arguments.map((value) => {
            ids.push(value.id);
            return this.value(value);
          });
          if (tail.boundary.argument_list_complete === false)
            arguments_.push(this.call(arguments_.length ? 'unknown_argument_remainder' : 'unknown_arguments',
              'Unresolved trailing native tail-call arguments; observed prefix is retained, not a complete prototype.', []));
          this.writer.helper(name,
            `Native tail transfer to ${this.writer.quote(key)} using observed ${this.input.source!.abi.id} storage. Preserve unknown target effects and forward its actual results. An absent observed result layout is unknown, not void.`);
          ids.push(control.target.id);
          this.writer.statement(depth, `return ${name}(${this.writer.join(arguments_)})`);
          break;
        }
        const args: string[] = [];
        if (control.kind === 'indirect') {
          args.push(this.value(control.target));
          ids.push(control.target.id);
          if (control.tail_call) {
            args.push(
              this.call('unknown_arguments', 'The source argument list is unresolved, not empty. Known changed physical input bits remain in the tail-call boundary snapshot.', []),
              this.call('unknown_calling_convention', 'The target calling convention is not established; do not infer it from a discovered code address.', []),
              this.call('unknown_results', 'The target result interface is unresolved, not void. Propagate the actual tail-call result without guessing its width or type.', []),
            );
          }
        }
        args.push(
          this.writer.quote(control.reason),
          this.registers(this.program.physical_exits.get(control.id) ?? block.register_exit),
        );
        for (const binding of block.register_exit) ids.push(binding.value.id);
        this.writer.statement(
          depth,
          `return ${this.call(control.kind === 'indirect' && control.tail_call ? 'tail_call' : `${control.kind}_exit`, control.kind === 'indirect' && control.tail_call ? 'Discovery-established tail-call transfer. Arguments: actual target, unresolved source arguments, unresolved calling convention, unresolved results, reason, changed physical input snapshot as an immutable-entry overlay. Preserve all target effects and forward its actual results; do not invent a prototype or interpret unknown arity as zero.' : control.kind === 'trap' ? 'Established machine trap; reason and physical state are explicit. The surrounding return exits the pseudocode model.' : 'Unresolved control boundary, not a guessed trap or fallthrough. Target (indirect only), reason and physical state remain explicit. The surrounding return exits the pseudocode model.', args)}`,
        );
        break;
      }
    }
    this.inferenceSites.set(control.id, { start, end: this.writer.offset });
    this.map(control, start, ids);
  }

  private sourceDefinitions(anchor: string, depth: number): void {
    for (const definition of this.program.source?.definitions?.get(anchor) ?? []) {
      this.context.checkpoint(1);
      const value = definition.result,
        expression = definition.expression;
      this.emitNotes(anchor, depth);
      const start = this.writer.offset;
      this.writer.statement(
        depth,
        `${this.local(value)} = ${this.expression(expression, value.type)}`,
      );
      this.mapped(this.dataOrigin(anchor), start, [value.id]);
    }
  }

  private region(region: Region, depth: number): void {
    this.context.checkpoint(1);
    if (region.kind === 'sequence') {
      for (const child of region.regions) this.region(child, depth);
    } else if (region.kind === 'loop') {
      this.writer.line(depth, this.language === 'c-like' ? 'while (true) {' : 'while True:');
      this.region(region.body, depth + 1);
      if (this.language === 'c-like') this.writer.line(depth, '}');
    } else {
      this.emitNotes(region.id, depth);
      const start = this.writer.offset;
      if (this.labels.has(region.id))
        this.writer.line(
          depth,
          this.language === 'c-like'
            ? `${this.identifier(region.id, 'label')}:;`
            : `label ${this.identifier(region.id, 'label')}:`,
        );
      this.sourceDefinitions(region.id, depth);
      for (const node of region.statements) {
        this.context.checkpoint(1);
        if (this.program.retained.has(node.id)) this.instruction(node, depth);
        this.sourceDefinitions(node.id, depth);
      }
      this.sourceDefinitions(region.control.id, depth);
      this.control(region.control, region, depth);
      this.map(region, start, [
        region.effect_parameter.id,
        ...region.parameters.map((value) => value.id),
      ]);
    }
  }

  render(): EmissionResult {
    const w = this.writer;
    w.helper(
      'reconstruction_model',
      'Pseudocode, not original source. Source reconstruction observes ABI arguments, results and ordered memory/call effects, not private frame traffic or caller-saved scratch state at return. Inferred interfaces are not established prototypes. Unsigned casts reduce modulo their width; signed casts interpret two-complement bits. Unknown/undefined values propagate. Float/vector helpers preserve payloads. Scalar locals require private nonoverlapping storage; shared storage retains memory views. Parallel transfers preserve simultaneous RHS values. label/goto are pseudocode only.',
    );
    w.comment(
      0,
      this.program.source
        ? `${this.language === 'c-like' ? 'C-like' : 'Python-like'} pseudocode; ${this.program.source.inferred ? 'inferred ABI interface' : 'recovered source interface'}.`
        : `${this.language === 'c-like' ? 'C-like' : 'Python-like'} reconstruction; explicit widths and ordered memory, not original source.`,
    );
    for (const assumption of this.program.source?.assumptions ?? []) {
      this.context.checkpoint(1);
      w.comment(0, `Requirement: ${assumption}`);
    }
    const displayName = this.names.get(this.input.function.id);
    const functionName = this.program.source
      ? this.sourceIdentifier(this.input.function.id, `fn_${displayName ?? 'function'}`)
      : this.identifier(this.input.function.id, 'fn');
    if (displayName && !this.program.source) w.comment(0, `function: ${w.quote(displayName)}`);
    this.emitNotes(this.input.function.id, 0);
    const signature = this.program.signature;
    const parameters: { value: Value; type: string; name: string }[] = [];
    for (let i = 0; i < this.program.parameters.length; i++) {
      this.context.checkpoint(1);
      const value = this.program.parameters[i]!;
      const source = signature?.signature.parameters[i];
      const register = this.program.parameter_registers.get(value.id);
      if (!this.names.has(value.id) && source?.name) this.names.set(value.id, source.name);
      if (!this.names.has(value.id) && register && !this.program.source)
        this.names.set(value.id, this.registerName(register));
      const name = this.program.source
        ? this.sourceIdentifier(
            value.id,
            this.sourceRoleNames.has(value.id)
              ? this.sourceRoleNames.get(value.id) ?? `arg${i}`
              : this.program.source.parameter_names.get(value.id) ?? source?.name ?? `arg${i}`,
          )
        : this.identifier(value.id, source ? 'arg' : register ? 'reg' : 'arg');
      parameters.push({
        value,
        type: source ? this.sourceType(source.type_id) : this.valueType(value),
        name,
      });
    }
    let hasTailCall = false;
    for (const block of this.program.blocks.values()) {
      this.context.checkpoint(1);
      if (block.control.kind === 'indirect' && block.control.tail_call) hasTailCall = true;
    }
    const returnType = signature
      ? this.sourceType(signature.signature.return_type)
      : this.program.source
        ? this.program.source.return_source_type
          ? this.sourceType(this.program.source.return_source_type)
          : this.program.source.return_pointer
          ? this.language === 'c-like'
            ? `${this.program.source.return_pointer === 'char' ? 'char' : 'uint8_t'} *`
            : `pointer[${this.program.source.return_pointer === 'char' ? 'char' : 'uint8_t'}]`
          : this.program.source.return_type
            ? this.dataType(this.program.source.return_type)
            : hasTailCall ? 'unknown_result' : 'void'
        : 'physical_result';
    this.headerStart = w.offset;
    if (this.program.source && parameters.length <= 4) {
      const declarations = parameters.map((parameter) =>
        w.declaration(parameter.type, parameter.name),
      );
      const prefix =
        this.language === 'c-like' ? `${returnType} ${functionName}(` : `def ${functionName}(`;
      w.line(
        0,
        `${prefix}${this.writer.join(declarations)}${this.language === 'c-like' ? ') {' : `) -> ${returnType}:`}`,
      );
      let offset = this.headerStart + prefix.length;
      for (let index = 0; index < parameters.length; index++) {
        const parameter = parameters[index]!,
          length = declarations[index]!.length;
        this.mapped(
          { ...this.dataOrigin(parameter.value.id), id: parameter.value.id },
          offset,
          [parameter.value.id],
          signature?.evidence_ids ?? [],
          offset + length,
        );
        this.inferenceSites.set(parameter.value.id, { start: offset, end: offset + length });
        offset += length + 2;
      }
    } else if (parameters.length) {
      w.line(
        0,
        this.language === 'c-like' ? `${returnType} ${functionName}(` : `def ${functionName}(`,
      );
      for (let i = 0; i < parameters.length; i++) {
        const parameter = parameters[i]!;
        const start = w.offset;
        w.line(
          1,
          `${w.declaration(parameter.type, parameter.name)}${i + 1 < parameters.length ? ',' : ''}`,
        );
        const source = signature?.signature.parameters[i];
        this.mapped(
          { ...this.dataOrigin(parameter.value.id), id: parameter.value.id },
          start,
          source ? [parameter.value.id, source.id, source.type_id] : [parameter.value.id],
          signature?.evidence_ids ?? [],
        );
        this.inferenceSites.set(parameter.value.id, { start, end: w.offset });
      }
      w.line(0, this.language === 'c-like' ? ') {' : `) -> ${returnType}:`);
    } else
      w.line(
        0,
        this.language === 'c-like'
          ? `${returnType} ${functionName}() {`
          : `def ${functionName}() -> ${returnType}:`,
      );
    this.headerEnd = w.offset;
    const proof = this.sourceEvidence.get(this.input.function.id);
    this.mapped(this.input.function, this.headerStart, proof ? [...proof.ids] : [], [
      ...(proof?.evidence ?? []),
    ]);
    const formals = new Set(parameters.map((parameter) => parameter.value.id));
    const stack = this.program.source?.stack;
    if (stack?.kind === 'private') {
      w.statement(
        1,
        this.language === 'c-like'
          ? `_Alignas(${stack.alignment}) uint8_t stack_frame[${stack.size}]`
          : `stack_frame = ${this.call('stack_storage', 'Private byte-addressable stack storage with original initialization unknown; overlapping accesses share bytes.', [String(stack.size), String(stack.alignment)])}`,
      );
    }
    const declaredLocals = new Set<string>();
    for (const [node, local] of this.program.source?.locals ?? []) {
      this.context.checkpoint(1);
      if (declaredLocals.has(local.id) || !this.program.retained.has(node)) continue;
      declaredLocals.add(local.id);
      const name = this.sourceIdentifier(local.id,
        this.names.get(local.id) ?? this.sourceRoleNames.get(local.id) ?? `local${this.sourceLocal++}`),
        start = w.offset;
      w.statement(1, w.declaration(this.dataType(local.type), name));
      this.mapped(this.dataOrigin(node), start, [node]);
    }
    for (const value of this.program.values.values()) {
      this.context.checkpoint(1);
      if (
        !this.program.live.has(value.id) ||
        this.program.inline.has(value.id) ||
        formals.has(value.id) ||
        this.program.source?.stack_addresses.has(value.id)
      )
        continue;
      const start = w.offset;
      w.statement(1, w.declaration(this.valueType(value), this.local(value)));
      this.mapped(this.dataOrigin(value.id), start, [value.id]);
      this.emitNotes(value.id, 1);
    }
    this.region(this.program.function.body, 1);
    if (this.language === 'c-like') w.line(0, '}');
    // Hidden subjects retain annotations without resurrecting dead declarations.
    for (const subject of this.notes.keys()) this.emitNotes(subject, 0);
    for (const item of this.input.function.coverage) {
      this.context.checkpoint(1 + item.statement_ids.length);
      if (!this.program.blocks.has(item.block_id) || !this.mappedControls.has(item.terminator_id))
        this.invalid('Structured coverage contains an unmapped block/control');
      for (const id of item.statement_ids)
        if (!this.mappedStatements.has(id))
          this.invalid('Reconstructed coverage contains an unmapped statement');
    }
    validateEmittedControl(this.input.function, this.emittedEdges, this.language, this.localValidation);
    for (const record of this.localValidation.records)
      if (record.kind === 'control' && record.status === 'rejected')
        rejectTranslation(record, this.controls.get(record.subject) ?? this.input.function);
    const inferences = collectInferences(
      this.input, this.program, w.mappings, this.localValidation.records, w, this.context,
      this.inferenceSites, this.sourceDataValue,
    );
    return {
      emission: {
        language: this.language,
        emitter_version: this.version,
        text: w.text(),
        span_unit: 'utf16',
        reconstruction: 'pseudocode',
        mappings: w.mappings,
        helpers: w.helpers,
        local_validation: this.localValidation.records,
        inferences,
      },
      diagnostics: this.diagnostics,
      coverage: {
        statements: this.statements.size,
        controls: this.controls.size,
        mapped_statements: this.mappedStatements.size,
        mapped_controls: this.mappedControls.size,
      },
      identifiers: [...this.identifiers.values()],
    };
  }
}
