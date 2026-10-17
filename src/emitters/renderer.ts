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
import { expressionText, machineType } from './expressions.js';
import { Writer } from './writer.js';
import type { EmissionInput, EmissionResult } from './model.js';

type Options = Parameters<Emitter<EmissionInput>['emit']>[1];
type Nest = { readonly kind: 'loop'; readonly header: string } | { readonly kind: 'switch' };

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
  private readonly labels = new Set<string>();
  private readonly gotos = new Set<ParallelTransfer>();
  private readonly typeRecords = new Map<string, SuppliedTypeRecord | null>();
  private readonly sourceEvidence = new Map<string, { ids: Set<string>; evidence: Set<string> }>();
  private readonly expanding = new Set<string>();
  private temporary = 0;
  private expansionWork = 0;
  private headerStart = 0;
  private headerEnd = 0;

  private readonly sourceNames = new Map<string, string>();
  private readonly usedSourceNames = new Set<string>();
  private readonly sourceAddresses = new Map<
    string,
    { readonly name?: string; readonly string?: string } | null
  >();
  private readonly sourceAddressesByValue = new Map<bigint, Address | null>();
  private readonly sourceValueTypes = new Map<string, string>();
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
      if (item.address.space === 'va') {
        const address = this.sourceAddressesByValue.get(item.address.value);
        this.sourceAddressesByValue.set(
          item.address.value,
          address === undefined || (address && this.addressKey(address) === key)
            ? item.address
            : null,
        );
      }
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
    let stem = preferred.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64);
    if (!/^[A-Za-z_]/.test(stem)) stem = `value_${stem}`;
    if (
      /^(?:auto|break|case|char|const|continue|def|default|do|double|else|enum|extern|False|float|for|goto|if|int|lambda|long|match|None|pass|register|return|short|signed|sizeof|static|struct|switch|True|typedef|union|unsigned|void|volatile|while|bool|uint\d+_t|int\d+_t)$/.test(
        stem,
      )
    )
      stem = `value_${stem}`;
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
            this.names.get(value.id) ?? `value${this.sourceTemporary++}`,
          ))
      : this.identifier(value.id, 'v');
  }

  private valueType(value: Value): string {
    const source = this.sourceValueTypes.get(value.id);
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
    if (stack && offset !== undefined)
      return this.language === 'c-like'
        ? `((uintptr_t)&stack_frame[${offset - stack.minimum_offset}])`
        : `address_of(stack_frame, ${offset - stack.minimum_offset})`;
    const expression = this.program.inline.has(value.id)
      ? this.program.expressions.get(value.id)
      : undefined;
    if (!expression) {
      const name = this.local(value),
        id = this.sourceValueTypes.get(value.id);
      const type = id && this.typeRecords.get(id)?.definition;
      if (this.program.source && type && type.kind === 'integer' && type.signed)
        return this.language === 'c-like'
          ? `((uint${type.bits}_t)(${name}))`
          : this.call(
              `uint${type.bits}`,
              'Convert a signed source result back to its exact ABI bit pattern.',
              [name],
            );
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
    this.writer.map({ ...origin, id: subjects[0] ?? origin.id }, start, subjects, evidence, end);
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
  private sourceAddress = (address: Address): string => {
    const key = this.addressKey(address),
      item = this.sourceAddresses.get(key);
    if (item?.string !== undefined)
      return this.writer
        .quote(item.string)
        .replace(/\\u000a/g, '\\n')
        .replace(/\\u000d/g, '\\r')
        .replace(/\\u0009/g, '\\t')
        .replace(/\\u0000/g, '\\0');
    if (item?.name) {
      const name = this.sourceNames.get(key) ?? this.sourceIdentifier(key, item.name);
      this.sourceNames.set(key, name);
      return this.language === 'c-like' ? `((uintptr_t)&${name})` : `address_of(${name})`;
    }
    if (address.space === 'va') return `0x${address.value.toString(16)}`;
    return this.address(address);
  };
  private sourceAddressValue(value: Value): string {
    const expression = this.program.expressions.get(value.id);
    const fact = this.input.types?.calls?.stack.values.get(value.id)?.value;
    if (fact?.kind === 'address') return this.sourceAddress(fact.address);
    const bits =
      expression?.kind === 'constant'
        ? expression.bits
        : fact?.kind === 'constant'
          ? fact.bits
          : null;
    const address = bits === null ? undefined : this.sourceAddressesByValue.get(bits);
    return address ? this.sourceAddress(address) : this.value(value);
  }

  private sourceCallee(node: Extract<Instruction, { kind: 'call' }>): string {
    if (node.target.kind === 'indirect') return this.value(node.target.value);
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
        this.sourceIdentifier(local.id, `local${this.sourceLocal++}`)
      );
    const address = this.sourceAddressValue(node.address),
      type = node.kind === 'load' ? node.result.type : node.value.type;
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
      const text = pointer ? this.sourceAddressValue(value) : this.value(value);
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
    if (projection.kind === 'physical')
      args.push(
        this.call(
          'unknown_arguments',
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
        text = `${this.local(node.result)} = ${this.expression(this.program.expressions.get(node.result.id) ?? node.expression, node.result.type)}`;
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
      case 'load':
      case 'store': {
        if (this.program.source) {
          const storage = this.storage(node);
          text =
            node.kind === 'store'
              ? `${storage} = ${this.value(node.value)}`
              : this.program.live.has(node.result.id)
                ? `${this.local(node.result)} = ${storage}`
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
        [view.shape.id, view.field.id, view.shape.type_id],
        [...view.shape.evidence_ids, ...view.field.evidence_ids],
      );
  }

  private ordinaryTransfer(transfer: ParallelTransfer, nesting: readonly Nest[]): boolean {
    if (transfer.mode === 'next') return true;
    for (let i = nesting.length - 1; i >= 0; i--) {
      const item = nesting[i]!;
      if (item.kind !== 'loop') continue;
      if (transfer.loop !== item.header) return false;
      return (
        transfer.mode === 'continue' ||
        (transfer.mode === 'break' &&
          (this.language === 'python-like' || nesting[nesting.length - 1]?.kind === 'loop'))
      );
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
        [...nesting, { kind: 'loop', header: region.header }],
        depth + 1,
        region.header,
      );
      return;
    }
    const transfer = (item: ParallelTransfer): void => {
      if (!this.program.blocks.has(item.target))
        this.invalid('Transfer target has no structured block');
      if (
        !this.ordinaryTransfer(item, nesting) &&
        (!this.program.source || item.target !== follow)
      ) {
        this.labels.add(item.target);
        this.gotos.add(item);
      }
    };
    const arm = (item: ControlArm, nested: readonly Nest[]): void => {
      const destination = item.body ? this.firstBlock(item.body) : follow;
      if (
        !this.ordinaryTransfer(item.transfer, nested) &&
        (!this.program.source || item.transfer.target !== destination)
      ) {
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

  private transfer(transfer: ParallelTransfer, depth: number): void {
    const copies = this.program.transfers.get(transfer);
    if (!copies) this.invalid('Reconstructed transfer is missing');
    // A write is safe only after all other RHS readers of its destination ran.
    if (copies.length === 1) {
      const copy = copies[0]!;
      this.writer.statement(depth, `${this.local(copy.destination)} = ${this.value(copy.source)}`);
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
          this.writer.statement(
            depth,
            this.writer.declaration(
              this.valueType(candidate.destination),
              candidate.temporary,
              ` = ${this.value(candidate.source)}`,
            ),
          );
          release(candidate);
        } else {
          const move = ready[next++]!;
          this.writer.statement(
            depth,
            `${this.local(move.destination)} = ${move.temporary ?? this.value(move.source)}`,
          );
          pending.delete(move.destination.id);
          release(move);
        }
      }
    }
    if (this.gotos.has(transfer))
      this.writer.statement(depth, `goto ${this.identifier(transfer.target, 'label')}`);
    else if (transfer.mode === 'break' || transfer.mode === 'continue')
      this.writer.statement(depth, transfer.mode);
  }

  private arm(arm: ControlArm, depth: number): void {
    const start = this.writer.codeLines;
    this.transfer(arm.transfer, depth);
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
        this.transfer(control.transfer, depth);
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
        this.arm(control.when_true, depth + 1);
        this.writer.line(depth, this.language === 'c-like' ? '} else {' : 'else:');
        this.arm(control.when_false, depth + 1);
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
          this.arm(item.arm, depth + 2);
          if (this.language === 'c-like') {
            this.writer.statement(depth + 2, 'break');
            this.writer.line(depth + 1, '}');
          }
        }
        this.writer.line(depth + 1, this.language === 'c-like' ? 'default: {' : 'case _:');
        this.arm(control.otherwise, depth + 2);
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
          const values = this.writer.list(projection.results, this.value);
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
        const args: string[] = [];
        if (control.kind === 'indirect') {
          args.push(this.value(control.target));
          ids.push(control.target.id);
        }
        args.push(
          this.writer.quote(control.reason),
          this.registers(this.program.physical_exits.get(control.id) ?? block.register_exit),
        );
        for (const binding of block.register_exit) ids.push(binding.value.id);
        this.writer.statement(
          depth,
          `return ${this.call(`${control.kind}_exit`, control.kind === 'trap' ? 'Established machine trap; reason and physical state are explicit. The surrounding return exits the pseudocode model.' : 'Unresolved control boundary, not a guessed trap or fallthrough. Target (indirect only), reason and physical state remain explicit. The surrounding return exits the pseudocode model.', args)}`,
        );
        break;
      }
    }
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
            this.program.source.parameter_names.get(value.id) ?? source?.name ?? `arg${i}`,
          )
        : this.identifier(value.id, source ? 'arg' : register ? 'reg' : 'arg');
      parameters.push({
        value,
        type: source ? this.sourceType(source.type_id) : this.dataType(value.type),
        name,
      });
    }
    const returnType = signature
      ? this.sourceType(signature.signature.return_type)
      : this.program.source
        ? this.program.source.return_type
          ? this.dataType(this.program.source.return_type)
          : 'void'
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
    if (stack) {
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
      const name = this.sourceIdentifier(local.id, `local${this.sourceLocal++}`),
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
    return {
      emission: {
        language: this.language,
        emitter_version: this.version,
        text: w.text(),
        span_unit: 'utf16',
        reconstruction: 'pseudocode',
        mappings: w.mappings,
        helpers: w.helpers,
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
