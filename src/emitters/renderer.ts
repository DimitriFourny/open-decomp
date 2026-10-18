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
  type IntegerPredicate,
  type Origin,
  type RegisterBinding,
  type Value,
} from '../ir/index.js';
import type {
  BlockRegion,
  Control,
  ControlArm,
  LoopForm,
  ParallelTransfer,
  Region,
} from '../presentation/index.js';
import type { SuppliedTypeRecord } from '../analysis/types/index.js';
import { reconstruct } from '../reconstruction/index.js';
import type { BoundaryProjection, Reconstruction } from '../reconstruction/model.js';
import { validateReconstruction, validateRenderedTransfers } from '../reconstruction/validate.js';
import type { SourceAddress } from '../reconstruction/source-model.js';
import { sourceDataValues } from '../reconstruction/source-data.js';
import {
  sourceFpPresentation,
  SOURCE_FP_ENVIRONMENT,
  type SourceFpPresentation,
} from '../reconstruction/source-fp.js';
import { indexedDataAccesses, type IndexedDataAccess } from './source-tables.js';
import { declareCScalarSupport } from './source-c-support.js';
import { cSourceName } from '../metadata/symbols/c-names.js';
import { catalog, type CatalogEntry } from '../metadata/library-contracts/catalog.js';
import { planSourceNames, sourceIdentifierStem } from '../reconstruction/source-names.js';
import {
  abiConformanceRequirements,
  sourceRequirementPredicates,
  sourceRequirementProofs,
  type SourceRequirementPredicate,
} from '../reconstruction/source-requirements.js';
import {
  LocalValidationSession,
  rejectTranslation,
  validateBitvectorCandidate,
  validateParallelMoves,
  type PlannedMove,
} from '../reconstruction/local-validation.js';
import {
  validateEmittedControl,
  type EmittedEdge,
} from '../reconstruction/local-control-validation.js';
import {
  PRIMARY,
  SourcePrinter,
  UNARY,
  expressionText,
  machineType,
  integerStorageBits,
  usualArithmetic,
  type IntegerCType,
  type Printed,
} from './expressions.js';
import { Writer } from './writer.js';
import type { EmissionInput, EmissionResult } from './model.js';
import { collectInferences } from './inference.js';
import {
  VariableLiveness,
  coalescePhiCopies,
  controlArms,
  formArm,
  planLayout,
  planLoopForms,
  planLoopExits,
  visitTransfers,
  firstBlock,
  type LoopExitRoute,
  transferAction,
  type LoopFacts,
  type TransferAction,
} from './source-control.js';
import { planSourceInlining, type InlineSite } from './source-inlining.js';
import { SourceStructs, type ObservedMember } from './source-structs.js';

type Options = Parameters<Emitter<EmissionInput>['emit']>[1];
type Nest =
  | { readonly kind: 'loop'; readonly header: string; readonly follow: string | null }
  | { readonly kind: 'switch'; readonly id: string };
/** Exact complement of each integer predicate (no NaN case for integers). */
const NEGATED_PREDICATE: Readonly<Record<IntegerPredicate, IntegerPredicate>> = {
  eq: 'ne',
  ne: 'eq',
  ult: 'uge',
  uge: 'ult',
  ule: 'ugt',
  ugt: 'ule',
  slt: 'sge',
  sge: 'slt',
  sle: 'sgt',
  sgt: 'sle',
};

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
  private readonly inferenceSites = new Map<
    string,
    { readonly start: number; readonly end: number }
  >();
  private readonly labels = new Set<string>();
  private readonly gotos = new Set<ParallelTransfer>();
  private readonly localValidation: LocalValidationSession;
  private readonly emittedEdges = new Map<ParallelTransfer, EmittedEdge>();
  // Source-view control presentation (see source-control.ts). `body` is the
  // printed layout; the checked view prints `input.function.body` unchanged.
  private body: Region;
  private readonly sourceView: boolean;
  private readonly nativeIntegerStorage: boolean;
  private readonly actions = new Map<ParallelTransfer, TransferAction>();
  /** Loop-test arms whose action the loop syntax itself performs. */
  private readonly consumed = new Set<ParallelTransfer>();
  private readonly fallthrough = new Set<ParallelTransfer>();
  private readonly loopTests = new Map<string, LoopForm>();
  private clones: ReadonlySet<BlockRegion> = new Set();
  private loopExits: ReadonlyMap<ParallelTransfer, LoopExitRoute> = new Map();
  private normalizeLoopTargets = false;
  private readonly exitFlags = new Map<string, string>();
  private readonly exitGuards = new Map<string, Set<string>>();
  private readonly emittedExitGuards = new Map<string, Set<string>>();
  private readonly initializedExitFlags = new Set<string>();
  /** Coalesced phi copies: value id -> representative printed variable. */
  private variables: ReadonlyMap<string, Value> = new Map();
  private readonly inline: Set<string>;
  private readonly inlined = new Map<string, InlineSite>();
  private readonly inlineSites = new Map<string, InlineSite[]>();
  private liveness: VariableLiveness | null = null;
  /** Do-while tests restated over the values written by their repeat copies. */
  private readonly rebased = new Map<string, Extract<Expression, { kind: 'compare' }>>();
  private readonly synthetic = new Map<string, Expression>();
  /** Edge copies printed in a `for` header (by destination variable), not at their edge. */
  private readonly hoisted = new Map<ParallelTransfer, ReadonlySet<string>>();
  /** `for` header edges keyed by the loop test control. */
  private readonly forLoops = new Map<
    string,
    { readonly init: ParallelTransfer; readonly step: ParallelTransfer }
  >();
  private readonly typeRecords = new Map<string, SuppliedTypeRecord | null>();
  private readonly libraryDeclarations = new Map<string, CatalogEntry>();
  private readonly callParameterSpellings = new Map<string, string>();
  private readonly sourceStructs: SourceStructs;
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
  private readonly dataTables = new Map<string, IndexedDataAccess & { readonly name: string }>();
  private indexedData: ReadonlyMap<string, IndexedDataAccess> = new Map();
  private readonly sourceValueTypes = new Map<string, string>();
  private readonly sourceRoleNames: ReadonlyMap<string, string | null>;
  private readonly requirementPredicates: ReadonlyMap<string, SourceRequirementPredicate>;
  private readonly fpPresentation: SourceFpPresentation;
  private sourceTemporary = 0;
  private sourceLocal = 0;
  /** C spellings of native linkage names; null marks conflicting spellings. */
  private readonly linkageNames = new Map<string, string | null>();
  constructor(
    private readonly input: EmissionInput,
    private readonly options: Options,
    private readonly context: OperationContext,
    private readonly language: 'c-like' | 'python-like',
    private readonly version: string,
  ) {
    this.writer = new Writer(context, options.indent, options.include_evidence, language);
    this.program = reconstruct(input, context, options.view === 'checked' ? 'checked' : 'source');
    this.inline = new Set(this.program.inline);
    this.sourceView = options.view !== 'checked';
    this.body = input.function.body;
    this.requirementPredicates = sourceRequirementPredicates(this.program.source?.requirements);
    this.localValidation =
      this.program.local_validation_session ?? new LocalValidationSession(context);
    let oddWidth = false;
    for (const value of this.program.values.values()) {
      context.checkpoint(1);
      if (
        value.type.kind === 'integer' &&
        value.type.bits > 1 &&
        value.type.bits < 128 &&
        integerStorageBits(value.type.bits) !== value.type.bits
      )
        oddWidth = true;
    }
    for (const block of this.program.blocks.values()) {
      for (const node of block.statements) {
        context.checkpoint(1);
        const type =
          node.kind === 'load' ? node.result.type : node.kind === 'store' ? node.value.type : null;
        if (type?.kind === 'integer' && integerStorageBits(type.bits) !== type.bits)
          oddWidth = false;
      }
    }
    this.nativeIntegerStorage =
      this.sourceView &&
      language === 'c-like' &&
      oddWidth &&
      this.localValidation.presentation(
        'c_integer_storage',
        input.function.id,
        'nonstandard-width integer locals use the next ordinary C storage width; conversions retain exact low-bit masks and signed interpretation, with one evaluation of each operand',
      );
    this.fpPresentation = sourceFpPresentation(this.program, context);
    this.body = this.fpPresentation.body;
    this.sourceStructs = new SourceStructs(
      this.typeRecords,
      this.localValidation,
      input.function.id,
      context,
      this.sourceView ? input.types?.shapes : undefined,
    );
    this.sourceDataValue = sourceDataValues(
      this.program.expressions,
      this.program.source?.addresses ?? [],
      context,
    );
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
      if (name.source_name !== undefined) {
        const spelling = this.linkageNames.get(name.entity_id);
        if (spelling === undefined) this.linkageNames.set(name.entity_id, name.source_name);
        else if (spelling !== name.source_name) this.linkageNames.set(name.entity_id, null);
      }
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
    if (this.sourceView && language === 'c-like')
      for (const proof of input.types?.evidence ?? []) {
        context.checkpoint(1);
        if (proof.origin.kind === 'library' && Object.hasOwn(catalog, proof.origin.contract))
          this.libraryDeclarations.set(proof.id, catalog[proof.origin.contract]!);
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
    if (this.sourceView) this.stridedPointerTypes();
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
    if (this.sourceView) this.planSourceControl();
    this.findLabels(this.body, [], 0);
    validateReconstruction(this.program, context);
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
    const entryStack =
      (stack?.kind === 'entry' && stack.base.id === id) ||
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
    const representative = this.variables.get(value.id);
    if (representative && representative.id !== value.id) {
      // One printed variable for a coalesced phi class; every member keeps its row.
      const identifier = this.local(representative);
      if (!this.identifiers.has(value.id))
        this.identifiers.set(value.id, {
          entity_id: value.id,
          identifier,
          original_name: this.names.get(value.id) ?? null,
        });
      return identifier;
    }
    return this.program.source
      ? (this.identifiers.get(value.id)?.identifier ??
          this.sourceIdentifier(
            value.id,
            this.names.get(value.id) ??
              this.sourceRoleNames.get(value.id) ??
              `value${this.sourceTemporary++}`,
          ))
      : this.identifier(value.id, 'v');
  }

  private valueType(value: Value): string {
    const floating = this.sourceView && this.program.source?.float_values?.get(value.id);
    if (floating) return floating === 32 ? 'float' : 'double';
    const formal = this.sourceView && this.program.source?.formal_types?.get(value.id);
    const source =
      this.sourceValueTypes.get(value.id) ??
      this.program.source?.value_types?.get(value.id)?.type_id;
    if (formal && formal.kind === 'pointer' && source) {
      const pointer = this.typeRecords.get(source)?.definition;
      const members = pointer?.kind === 'pointer' ? this.partialLayout(pointer.to) : null;
      if (
        members?.some(
          (member) => member.bits !== formal.pointee_bits || member.count !== undefined,
        ) &&
        this.localValidation.presentation(
          'observed_struct_formal',
          value.id,
          'complete observed member widths and strides take precedence over a scalar-only formal access path',
        )
      )
        return this.sourceType(source);
    }
    if (formal)
      return formal.kind === 'integer'
        ? `${formal.signed ? 'int' : 'uint'}${formal.bits}_t`
        : this.language === 'c-like'
          ? `${formal.const ? 'const ' : ''}uint${formal.pointee_bits}_t*`
          : `pointer[uint${formal.pointee_bits}_t]`;
    if (source) return this.sourceType(source);
    return this.dataType(value.type);
  }

  private dataType(type: DataType): string {
    return this.program.source && type.kind === 'integer'
      ? type.bits === 1
        ? 'bool'
        : `uint${this.nativeIntegerStorage ? integerStorageBits(type.bits) : type.bits}_t`
      : machineType(type);
  }

  private expressionType(value: Value): DataType {
    const bits = this.sourceView && this.program.source?.float_values?.get(value.id);
    return bits ? { kind: 'float', bits } : value.type;
  }

  private floatingValue(value: Value, bits: 32 | 64): Printed {
    if (value.type.kind === 'float' || this.program.source?.float_values?.get(value.id) === bits)
      return this.printed(value);
    const expression = this.program.expressions.get(value.id);
    return this.expression(
      expression?.kind === 'constant' ? expression : { kind: 'cast', op: 'bitcast', value },
      { kind: 'float', bits },
    );
  }

  private printerCache?: SourcePrinter;
  private get printer(): SourcePrinter {
    return (this.printerCache ??= new SourcePrinter(this.writer, this.nativeIntegerStorage));
  }
  /** Exact declared spelling of each formal/local, recorded where declared. */
  private readonly declaredTypes = new Map<string, string>();
  /** Declared function result type spelling (set before the body prints). */
  private returnSpelling = '';

  /** The C/Python integer type a local is declared with, read from its actual
   * declaration; pointers and non-integer source types have none. */
  private declaredInteger(value: Value, spelling: string): IntegerCType | null {
    if (value.type.kind !== 'integer') return null;
    if (spelling === 'bool') return value.type.bits === 1 ? { bits: 1, signed: false } : null;
    const match = /^(u?)int(\d+)_t$/.exec(spelling);
    return match &&
      (Number(match[2]) === value.type.bits || this.program.source?.formal_types?.has(value.id))
      ? { bits: Number(match[2]), signed: !match[1] }
      : null;
  }

  /** Signed result context changes literal spelling, not the underlying bits. */
  private scalarReturn(value: Value, bits: number, signed: boolean, depth = 0): Printed {
    const expression = this.inline.has(value.id)
      ? this.program.expressions.get(value.id)
      : undefined;
    if (depth < 32 && expression) {
      if (expression.kind === 'constant')
        return signed
          ? {
              ...this.printer.signedLiteral(BigInt.asIntN(bits, expression.bits)),
              ctype: { bits, signed: true },
            }
          : this.printer.literal(BigInt.asUintN(bits, expression.bits), bits);
      if (
        expression.kind === 'cast' &&
        ['zero_extend', 'sign_extend', 'bitcast'].includes(expression.op) &&
        bitWidth(expression.value.type) >= bits
      )
        return this.scalarReturn(expression.value, bits, signed, depth + 1);
      if (expression.kind === 'select')
        return expressionText(
          expression,
          value.type,
          this.writer,
          (operand) =>
            operand.id === expression.condition.id
              ? this.printed(operand)
              : this.scalarReturn(operand, bits, signed, depth + 1),
          { view: 'source', source: { address: (address) => this.addressPrinted(address) } },
        );
    }
    return signed
      ? this.printer.cast(bits, true, this.printed(value))
      : this.printer.reduce(bits, this.printed(value));
  }

  private sourceInterpretation(
    value: Value,
    printed: Printed,
    id?: string,
    assigned?: Expression,
  ): Printed {
    if (!this.program.source) return printed;
    if (!this.sourceView)
      return this.printer.primary(this.checkedInterpretation(value, printed.text, id));
    if (this.program.source.float_values?.has(value.id)) return printed;
    id ??=
      this.sourceValueTypes.get(value.id) ??
      this.program.source.value_types?.get(value.id)?.type_id;
    const type = id && this.typeRecords.get(id)?.definition;
    if (
      !type ||
      (type.kind !== 'integer' && type.kind !== 'pointer') ||
      type.bits !== bitWidth(value.type) ||
      value.type.kind !== 'integer'
    )
      return printed;
    if (type.kind === 'pointer') {
      // Python-like pointers are their address bits; only reduce if unbounded.
      if (this.language === 'python-like')
        return printed.ctype && !printed.ctype.signed && printed.ctype.bits <= type.bits
          ? printed
          : this.printer.reduce(type.bits, printed);
      const step = assigned && this.pointerStep(id!, assigned, type.bits);
      if (step) return step;
      // Integer-to-pointer conversion of the exact address bits; a narrower
      // integer goes through uintptr_t (no implicit widening warning).
      const address =
        printed.ctype?.bits === type.bits && !printed.ctype.signed
          ? printed
          : {
              text: `(uintptr_t)${this.printer.group(printed, UNARY)}`,
              precedence: UNARY,
              ctype: null,
            };
      return {
        text: `(${this.sourceType(id!)})${this.printer.group(address, UNARY)}`,
        precedence: UNARY,
        ctype: null,
      };
    }
    return type.signed ? this.printer.cast(type.bits, true, printed) : printed;
  }

  private checkedInterpretation(value: Value, text: string, id?: string): string {
    id ??=
      this.sourceValueTypes.get(value.id) ??
      this.program.source?.value_types?.get(value.id)?.type_id;
    const type = id && this.typeRecords.get(id)?.definition;
    if (
      !type ||
      (type.kind !== 'integer' && type.kind !== 'pointer') ||
      type.bits !== bitWidth(value.type) ||
      value.type.kind !== 'integer'
    )
      return text;
    if (type.kind === 'pointer')
      return this.language === 'c-like'
        ? `((${this.sourceType(id!)})(uintptr_t)(${text}))`
        : this.call(
            'uint64',
            'Interpret exact target pointer bits without a host pointer or inferred object bounds.',
            [text],
          );
    if (!type.signed) return text;
    return this.language === 'c-like'
      ? `((int${type.bits}_t)(${text}))`
      : this.call(
          `int${type.bits}`,
          'Interpret the proven source signed scalar from its unchanged machine bits.',
          [text],
        );
  }

  /** Byte size of the scalar a declared source pointer type points to. */
  private scalarPointee(id: string): IntegerCType | null {
    const pointer = this.typeRecords.get(id)?.definition;
    if (pointer?.kind !== 'pointer') return null;
    const target = this.naturalScalar(pointer.to) ?? pointer.to;
    const type = this.typeRecords.get(target)?.definition;
    return type?.kind === 'integer' && type.bits % 8 === 0 && type.bits <= 64
      ? { bits: type.bits, signed: type.signed }
      : null;
  }

  /** `p = p + k` on the same declared scalar pointer type prints as C pointer
   * arithmetic `p + k/size` when the byte displacement k is a multiple of the
   * element size; C scales by exactly that size, so the address bits agree. */
  private pointerStep(id: string, expression: Expression, bits: number): Printed | null {
    const element = this.scalarPointee(id);
    if (
      expression.kind !== 'integer' ||
      (expression.op !== 'add' && expression.op !== 'sub') ||
      !element
    )
      return null;
    const candidates =
      expression.op === 'add'
        ? [
            [expression.left, expression.right],
            [expression.right, expression.left],
          ]
        : [[expression.left, expression.right]];
    for (const [base, offset] of candidates) {
      const bytes = this.constantOf(offset!);
      const baseType =
        this.sourceValueTypes.get(base!.id) ??
        this.program.source?.value_types?.get(base!.id)?.type_id;
      if (
        bytes === undefined ||
        this.inline.has(base!.id) ||
        !baseType ||
        this.sourceType(baseType) !== this.sourceType(id)
      )
        continue;
      const signed = BigInt.asIntN(bits, bytes) * (expression.op === 'sub' ? -1n : 1n);
      const size = BigInt(element.bits / 8);
      if (signed % size !== 0n) continue;
      if (
        !this.localValidation.presentation(
          'scaled_pointer_arithmetic',
          this.input.function.id,
          'typed pointer update; byte displacement is an exact multiple of the element size',
        )
      )
        return null;
      const name = this.printer.primary(this.local(base!));
      const count = signed / size;
      return count === 0n
        ? name
        : this.printer.binary(
            count < 0n ? '-' : '+',
            name,
            this.printer.literal(count < 0n ? -count : count, 64),
            null,
          );
    }
    return null;
  }

  private constantOf = (value: Value): bigint | undefined => {
    // Restated do-while test bounds (Structuring) are synthetic inline constants.
    const synthetic = this.synthetic.get(value.id);
    if (synthetic?.kind === 'constant' && value.type.kind === 'integer')
      return BigInt.asUintN(value.type.bits, synthetic.bits);
    if (!this.inline.has(value.id) || value.type.kind !== 'integer') return undefined;
    const expression = this.program.expressions.get(value.id);
    return expression?.kind === 'constant'
      ? BigInt.asUintN(value.type.bits, expression.bits)
      : undefined;
  };

  private expression(expression: Expression, type: DataType): Printed {
    if (
      this.sourceView &&
      type.kind === 'float' &&
      expression.kind === 'cast' &&
      expression.op === 'bitcast' &&
      this.program.source?.float_values?.get(expression.value.id) === type.bits
    )
      return this.printed(expression.value);
    if (
      this.sourceView &&
      this.language === 'c-like' &&
      expression.kind === 'cast' &&
      expression.op === 'bitcast' &&
      (type.kind === 'integer' || type.kind === 'float') &&
      (expression.value.type.kind === 'integer' || expression.value.type.kind === 'float') &&
      type.kind !== expression.value.type.kind &&
      (type.bits === 32 || type.bits === 64) &&
      type.bits === expression.value.type.bits &&
      this.localValidation.presentation(
        'c_bitcast',
        expression.value.id,
        'equal-width integer/IEEE storage copied with memcpy, preserving every bit without aliasing or numeric conversion',
      )
    ) {
      this.localValidation.requireAbi(
        'c_bitcast',
        [expression.value.id],
        'Native C float/double and integer storage use the target IEEE binary32/binary64 representation and matching byte order.',
      );
      const target = `${type.kind === 'float' ? 'f' : 'u'}${type.bits}`;
      const source = `${expression.value.type.kind === 'float' ? 'f' : 'u'}${type.bits}`;
      return this.printer.primary(
        this.call(
          `__od_bitcast_${target}_${source}`,
          'Copy the exact same-width IEEE/integer object representation; preserve NaN payloads and signed zero.',
          [this.value(expression.value)],
        ),
        type.kind === 'integer' ? { bits: type.bits, signed: false } : null,
      );
    }
    if (
      this.sourceView &&
      expression.kind === 'compare' &&
      (expression.op === 'eq' || expression.op === 'ne')
    ) {
      const pointer =
        this.constantOf(expression.right) === 0n
          ? expression.left
          : this.constantOf(expression.left) === 0n
            ? expression.right
            : undefined;
      if (
        pointer &&
        !this.inline.has(pointer.id) &&
        this.declaredPointer(pointer) &&
        this.localValidation.presentation(
          'pointer_null_test',
          pointer.id,
          'declared pointer compared for equality with zero target address bits',
        )
      ) {
        this.localValidation.requireAbi(
          'pointer_null_test',
          [this.input.function.id],
          'The target null pointer has zero address bits.',
        );
        return this.printer.binary(
          expression.op === 'eq' ? '==' : '!=',
          this.printer.primary(this.local(pointer)),
          this.printer.literal(0n, 64),
          { bits: 1, signed: false },
        );
      }
    }
    const operand =
      this.sourceView && type.kind === 'float' && expression.kind === 'select'
        ? (value: Value) =>
            value.id === expression.condition.id
              ? this.printed(value)
              : this.floatingValue(value, type.bits)
        : this.printed;
    return expressionText(expression, type, this.writer, operand, {
      view: this.sourceView ? 'source' : 'checked',
      ...(this.program.source
        ? {
            source: {
              address: (address: Address) => this.addressPrinted(address),
            },
          }
        : {}),
      constant: this.constantOf,
      nativeIntegerStorage: this.nativeIntegerStorage,
      nativeFp: this.fpPresentation.expressions.has(expression),
      floatLiterals: this.fpPresentation.expressions.has(expression),
    });
  }

  /** Declared spelling of the variable a value prints as (its phi class
   * representative when coalesced). */
  private declaredSpelling(value: Value): string {
    return (
      this.declaredTypes.get((this.variables.get(value.id) ?? value).id) ?? this.valueType(value)
    );
  }

  /** Actual declarations, including coalesced formals, are authoritative. */
  private declaredPointer(value: Value): { bits: number; signed: boolean } | null {
    const spelling = this.declaredSpelling(value);
    const match =
      this.language === 'c-like'
        ? /^(?:const )?(u?)int(8|16|32|64)_t\s*\*$/.exec(spelling)
        : /^pointer\[(u?)int(8|16|32|64)_t\]$/.exec(spelling);
    return match ? { bits: Number(match[2]), signed: !match[1] } : null;
  }

  /** A C context that converts to unsigned `bits` (assignment, return, store)
   * makes a final reduction or widening to exactly that type implicit. */
  private converted(value: Printed, bits: number | null): string {
    const implicit = value.unreduced ?? value.widened;
    return this.sourceView &&
      this.language === 'c-like' &&
      implicit &&
      bits !== null &&
      bits > 1 &&
      value.ctype?.bits === bits &&
      !value.ctype.signed
      ? implicit.text
      : value.text;
  }

  private assigned(destination: Value, value: Printed): string {
    const declared = this.declaredInteger(destination, this.declaredSpelling(destination));
    return this.converted(
      value,
      declared && !declared.signed && declared.bits === bitWidth(destination.type)
        ? declared.bits
        : null,
    );
  }

  /** Right-hand side of `destination = ...`, interpreted as the destination's
   * source type. */
  private assignedText(destination: Value, value: Printed, expression?: Expression): string {
    return this.assigned(
      destination,
      this.sourceInterpretation(destination, value, undefined, expression),
    );
  }

  /** `destination = source` for an SSA copy; an inline source keeps its
   * defining expression available to pointer-arithmetic presentation. */
  private copied(destination: Value, source: Value): string {
    const floating = this.sourceView && this.program.source?.float_values?.get(destination.id);
    if (floating) return this.floatingValue(source, floating).text;
    if (this.sourceView) {
      const uncast = this.uncast(source, ['bitcast']);
      // A storage copy may erase same-kind aliases, never an IEEE/integer
      // reinterpretation: C assignment would otherwise numerically convert.
      if (this.expressionType(uncast).kind === this.expressionType(source).kind) source = uncast;
    }
    if (
      this.sourceView &&
      !this.inline.has(source.id) &&
      this.declaredPointer(destination) &&
      this.declaredPointer(source) &&
      this.localValidation.presentation(
        'pointer_copy',
        destination.id,
        'whole address copied between declared scalar pointers without an integer round trip',
        [source.id],
      )
    ) {
      const target = this.declaredSpelling(destination),
        original = this.declaredSpelling(source);
      return this.language === 'python-like' ||
        target === original ||
        target === `const ${original}`
        ? this.local(source)
        : `(${target})${this.local(source)}`;
    }
    return this.assignedText(
      destination,
      this.printed(source),
      this.inline.has(source.id) ? this.program.expressions.get(source.id) : undefined,
    );
  }

  private value = (value: Value): string => this.printed(value).text;
  private printed = (value: Value): Printed => {
    this.context.checkpoint(1);
    const source = this.sourceView,
      python = this.language === 'python-like';
    const stack = this.program.source?.stack,
      offset = this.program.source?.stack_addresses.get(value.id);
    if (stack && offset !== undefined) {
      if (stack.kind === 'entry') {
        if (source) {
          const base = this.printed(stack.base);
          if (offset === 0n) return base;
          const amount = this.printer.literal(offset < 0n ? -offset : offset, 64);
          return this.printer.reduce(
            64,
            this.printer.binary(
              offset < 0n ? '-' : '+',
              base,
              amount,
              python || !base.ctype ? null : usualArithmetic(base.ctype, amount.ctype!),
            ),
          );
        }
        const base = this.value(stack.base);
        if (offset === 0n) return this.printer.primary(base);
        const address = `(${base} ${offset < 0n ? '-' : '+'} ${offset < 0n ? -offset : offset})`;
        return this.printer.primary(
          this.language === 'c-like'
            ? `((uintptr_t)${address})`
            : this.call('uint64', 'Wrap an entry-stack byte address to the target pointer width.', [
                address,
              ]),
        );
      }
      if (source)
        return python
          ? this.printer.primary(`address_of(stack_frame, ${offset - stack.minimum_offset})`, {
              bits: 64,
              signed: false,
            })
          : {
              text: `(uintptr_t)&stack_frame[${offset - stack.minimum_offset}]`,
              precedence: UNARY,
              ctype: { bits: 64, signed: false },
            };
      return this.printer.primary(
        this.language === 'c-like'
          ? `((uintptr_t)&stack_frame[${offset - stack.minimum_offset}])`
          : `address_of(stack_frame, ${offset - stack.minimum_offset})`,
      );
    }
    const load = this.inlined.get(value.id)?.node;
    if (load?.kind === 'load') {
      if (this.expanding.has(value.id)) this.invalid('Cyclic inlined load');
      if (this.expanding.size >= 128 || ++this.expansionWork > this.context.budget.ir_nodes * 64)
        this.writer.fail('Reconstructed expression expansion exceeds its budget');
      this.expanding.add(value.id);
      const storage = this.storage(load);
      const id =
        this.sourceValueTypes.get(load.address.id) ??
        this.program.source?.value_types?.get(load.address.id)?.type_id;
      const pointee = id && !this.inline.has(load.address.id) ? this.scalarPointee(id) : null;
      const type = storage.includes('->')
        ? null
        : (pointee ?? { bits: bitWidth(value.type), signed: false });
      const result = this.printer.reduce(bitWidth(value.type), {
        text: storage,
        precedence: storage.startsWith('*') ? UNARY : PRIMARY,
        ctype: type,
      });
      this.expanding.delete(value.id);
      this.writer.guard(Buffer.byteLength(result.text));
      return result;
    }
    const expression =
      this.synthetic.get(value.id) ??
      (this.inline.has(value.id) ? this.program.expressions.get(value.id) : undefined);
    if (!expression) {
      const name = this.local(value),
        id =
          this.sourceValueTypes.get(value.id) ??
          this.program.source?.value_types?.get(value.id)?.type_id;
      const type = id && this.typeRecords.get(id)?.definition;
      if (source) {
        const spelling = this.declaredSpelling(value);
        const representative = this.variables.get(value.id);
        const declared = this.declaredInteger(representative ?? value, spelling);
        if (
          declared &&
          representative &&
          value.type.kind === 'integer' &&
          representative.type.kind === 'integer' &&
          representative.type.bits > value.type.bits
        )
          return this.printer.cast(value.type.bits, false, this.printer.primary(name, declared));
        if (
          this.nativeIntegerStorage &&
          declared &&
          value.type.kind === 'integer' &&
          declared.bits !== value.type.bits
        )
          return this.printer.cast(value.type.bits, false, this.printer.primary(name, declared));
        if (declared?.signed)
          return this.printer.cast(declared.bits, false, this.printer.primary(name, declared));
        if (declared) return this.printer.primary(name, declared);
        if (
          value.type.kind === 'integer' &&
          (python ? spelling.startsWith('pointer[') : spelling.endsWith('*'))
        )
          return python
            ? this.printer.primary(name, { bits: value.type.bits, signed: false })
            : {
                text: `(uintptr_t)${name}`,
                precedence: UNARY,
                ctype: { bits: value.type.bits, signed: false },
              };
        return this.printer.primary(name);
      }
      if (this.program.source && type && type.kind === 'integer' && type.signed)
        return this.printer.primary(
          this.language === 'c-like'
            ? `((uint${type.bits}_t)(${name}))`
            : this.call(
                `uint${type.bits}`,
                'Convert a signed source result back to its exact ABI bit pattern.',
                [name],
              ),
        );
      if (this.program.source && type && type.kind === 'pointer')
        return this.printer.primary(
          this.language === 'c-like'
            ? `((uintptr_t)(${name}))`
            : this.call(
                'uint64',
                'Read a source pointer as exact target address bits before machine byte arithmetic.',
                [name],
              ),
        );
      return this.printer.primary(name);
    }
    if (this.expanding.has(value.id)) this.invalid('Cyclic reconstructed expression');
    if (this.expanding.size >= 128 || ++this.expansionWork > this.context.budget.ir_nodes * 64)
      this.writer.fail('Reconstructed expression expansion exceeds its budget');
    this.expanding.add(value.id);
    const printed = this.expression(expression, this.expressionType(value));
    this.expanding.delete(value.id);
    this.writer.guard(Buffer.byteLength(printed.text));
    return printed;
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
    // Empty spans publish nothing; never intern identities for them.
    if (start === end) return;
    const contributors = this.program.source?.value_origins;
    const references = this.writer.references();
    for (const id of [origin.id, ...ids])
      for (const subject of contributors?.get(id) ?? [id]) references.add(subject);
    if (references.ids.length === 0) references.add(origin.id);
    const subjects = references.ids;
    const dataEvidence = new Set(evidence);
    const dataSubjects = new Set([origin.id, ...ids]);
    for (const id of subjects) dataSubjects.add(id);
    for (const id of dataSubjects) {
      const type = this.program.source?.value_types?.get(id);
      if (type) {
        references.add(type.type_id);
        for (const subject of [...type.association_ids, ...type.subject_ids])
          references.add(subject);
        for (const evidenceId of type.evidence_ids) dataEvidence.add(evidenceId);
      }
      const value = this.program.values.get(id);
      if (!value) continue;
      const data = this.sourceDataValue(value);
      for (const evidenceId of data?.object?.evidence_ids ?? []) dataEvidence.add(evidenceId);
    }
    this.writer.map(
      { ...origin, id: subjects[0] ?? origin.id },
      start,
      references,
      [...dataEvidence],
      end,
    );
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
    for (const site of this.inlineSites.get(origin.id) ?? []) {
      if (site.origin) {
        this.mapped(this.dataOrigin(site.origin), start, [site.node.result.id], [], end);
        if (this.statements.has(site.origin)) this.mappedStatements.add(site.origin);
      } else {
        this.map(site.node, start, [], end);
        this.mapMemory(site.node, start, end);
      }
    }
  }

  private addressKey(address: Address): string {
    return `${address.image_id}:${address.space}:${address.value}`;
  }
  private sourceAddress = (address: Address, literal = false): string => {
    const key = this.addressKey(address),
      item = this.sourceAddresses.get(key);
    if (
      literal &&
      item?.string !== undefined &&
      (!this.sourceView || (item.string_start === true && item.object?.mutable === false))
    )
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
          object.byte_length === null
            ? this.writer.quote('unknown')
            : `0x${object.byte_length.toString(16)}`,
          this.language === 'c-like' ? String(object.mutable) : object.mutable ? 'True' : 'False',
          this.writer.quote(object.kind),
        ],
      );
    }
    if (item?.name) {
      if (
        this.sourceView &&
        this.language === 'c-like' &&
        address.space === 'va' &&
        this.localValidation.presentation(
          'symbolic_address',
          this.input.function.id,
          'an exact named image VA without an established C object/function type stays an address constant, not an invented extern declaration',
          undefined,
          `${this.addressKey(address)}: ${this.writer.quote(item.name)}`,
        )
      )
        return `((uintptr_t)0x${address.value.toString(16)}) /* ${this.writer.quote(item.name)} */`;
      const name = this.sourceNames.get(key) ?? this.sourceIdentifier(key, item.name);
      this.sourceNames.set(key, name);
      return this.language === 'c-like' ? `((uintptr_t)&${name})` : `address_of(${name})`;
    }
    if (address.space === 'va') return `0x${address.value.toString(16)}`;
    return this.address(address);
  };
  private sourceAddressValue(value: Value, literal = false): string {
    return this.sourceAddressPrinted(value, literal).text;
  }

  private sourceAddressPrinted(value: Value, literal = false): Printed {
    const address = this.sourceAddressOf(value);
    return address ? this.addressPrinted(address, literal) : this.printed(value);
  }

  /** Source address text with its C type: a bare VA is a hexadecimal constant. */
  private addressPrinted(address: Address, literal = false): Printed {
    const text = this.sourceAddress(address, literal);
    return /^0x[0-9a-f]+$/.test(text)
      ? { ...this.printer.literal(address.value, 64), text }
      : this.printer.primary(text, { bits: 64, signed: false });
  }

  private sourceAddressOf(value: Value): Address | undefined {
    const fact = this.input.types?.calls?.stack.values.get(value.id)?.value;
    if (fact?.kind === 'address') return fact.address;
    const item = this.sourceDataValue(value);
    if (item) return item.address;
    if (fact?.kind === 'constant') {
      for (const address of this.program.source?.addresses ?? []) {
        this.context.checkpoint(1);
        if (address.address.space === 'va' && address.address.value === fact.bits)
          return address.address;
      }
    }
    return undefined;
  }

  /** Display name of an entity. The source view presents a native linkage name
   * in its C spelling (cSourceName); asserted names and the checked view keep
   * the original, which identifiers[].original_name always retains. */
  private presentedName(id: string): string | undefined {
    const name = this.names.get(id) ?? undefined;
    return (name !== undefined && this.sourceView && this.linkageNames.get(id)) || name;
  }

  /** Source view: a C string literal for an exact pointer-width constant
   * argument addressing the start (not an interior suffix) of an immutable,
   * NUL-terminated string with an established encoding; otherwise undefined. */
  private sourceLiteral(value: Value): string | undefined {
    if (
      !this.sourceView ||
      value.type.kind !== 'integer' ||
      value.type.bits !== this.input.source?.abi.layout.pointer_bits
    )
      return undefined;
    const address = this.sourceAddressOf(value),
      item = address && this.sourceAddresses.get(this.addressKey(address));
    if (
      !address ||
      !item ||
      item.string === undefined ||
      item.string_encoding === undefined ||
      item.string_start !== true ||
      item.object?.mutable !== false
    )
      return undefined;
    return this.sourceAddress(address, true);
  }

  private sourceCallee(node: Extract<Instruction, { kind: 'call' }>): string {
    if (node.target.kind === 'indirect') {
      const value = node.target.value;
      // Source view: an inline same-width bitcast of a pointer local carries the
      // same target bits; the function-pointer cast then applies to the local.
      const alias = this.inline.has(value.id) ? this.program.expressions.get(value.id) : undefined;
      for (const candidate of alias?.kind === 'cast' &&
      alias.op === 'bitcast' &&
      this.sourceView &&
      bitWidth(alias.value.type) === bitWidth(value.type)
        ? [value, alias.value]
        : [value]) {
        if (!this.program.source || this.inline.has(candidate.id)) continue;
        const id =
          this.sourceValueTypes.get(candidate.id) ??
          this.program.source.value_types?.get(candidate.id)?.type_id;
        const type = id && this.typeRecords.get(id)?.definition;
        // Callable context retains the declared pointer local; value() converts
        // pointers to integer bits for machine arithmetic, not invocation.
        if (type && type.kind === 'pointer') return this.local(candidate);
      }
      return this.value(value);
    }
    const key = this.addressKey(node.target.address),
      previous = this.sourceNames.get(key);
    if (previous) return previous;
    const projection = this.program.calls.get(node.id);
    let preferred = this.presentedName(node.id) ?? `sub_${node.target.address.value.toString(16)}`;
    if (
      !this.sourceView &&
      projection?.signature?.source === 'library' &&
      this.input.source?.abi.id === 'darwin-arm64'
    )
      preferred = preferred.replace(/^_/, '');
    // A direct self-call names the function being rendered, not a second identifier.
    const own = this.identifiers.get(this.input.function.id)?.identifier;
    if (
      this.sourceView &&
      own !== undefined &&
      this.input.source?.callees.some(
        (callee) =>
          callee.call_id === node.id && callee.target_subject_id === this.input.function.id,
      )
    ) {
      this.sourceNames.set(key, own);
      return own;
    }
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

  /** Exact boundary arguments, without descriptor fields the boundary never uses. */
  private effectContract(clobbers: CallClobbers): string | null {
    const key = (register: RegisterDescriptor): string =>
      `${register.root}:${register.offset_bits}:${register.width_bits}`;
    const contract = JSON.stringify({
      memory: clobbers.memory,
      registers: this.writer.list(clobbers.registers, key),
      flags: this.writer.list(clobbers.flags, key),
    });
    // The public local-validation reason has this bound. Never truncate facts.
    return contract.length <= 8192 ? contract : null;
  }

  private values(values: readonly Value[]): string {
    return this.call(
      'explicit_values',
      'Explicit IR boundary values only; an empty list does not prove a void return or zero source arguments.',
      this.writer.list(values, this.value),
    );
  }
  private readonly sourceArrays = new Map<string, string>();
  private readonly sourceOpaqueTypes = new Map<string, string>();

  private opaqueType(id: string): string {
    let name = this.sourceOpaqueTypes.get(id);
    if (!name) {
      name = this.sourceIdentifier(id, `opaque_${this.sourceOpaqueTypes.size + 1}`);
      this.sourceOpaqueTypes.set(id, name);
    }
    return name;
  }

  private sourceType(id: string, depth = 0): string {
    this.context.checkpoint(1);
    if (depth > 32) return this.sourceView ? this.opaqueType(id) : this.identifier(id, 'type');
    const record = this.typeRecords.get(id);
    if (
      !record ||
      (record.status !== 'established' &&
        record.status !== 'asserted' &&
        !(record.source === 'analysis' && record.status === 'candidate'))
    )
      return this.sourceView ? this.opaqueType(id) : this.identifier(id, 'type');
    const type = record.definition;
    switch (type.kind) {
      case 'void':
        return 'void';
      case 'integer':
        return `${type.signed ? 'int' : 'uint'}${this.nativeIntegerStorage ? integerStorageBits(type.bits) : type.bits}_t`;
      case 'float':
        return this.sourceView && (type.bits === 32 || type.bits === 64)
          ? type.bits === 32
            ? 'float'
            : 'double'
          : `ieee${type.bits}_t`;
      case 'pointer':
        return this.language === 'c-like'
          ? `${this.sourceType(type.to, depth + 1)}*`
          : `pointer[${this.sourceType(type.to, depth + 1)}]`;
      case 'array':
        if (this.sourceView && this.language === 'c-like') {
          let name = this.sourceArrays.get(id);
          if (!name) {
            name = this.sourceIdentifier(id, `array_${this.sourceArrays.size + 1}`);
            this.sourceArrays.set(id, name);
          }
          return name;
        }
        return `array<${this.sourceType(type.element, depth + 1)}, ${type.count === null ? '?' : type.count}>`;
      case 'vector':
        return `vector<${this.sourceType(type.element, depth + 1)}, ${type.lanes}>`;
      case 'structure': {
        const scalar = this.naturalScalar(id);
        return scalar
          ? this.sourceType(scalar, depth + 1)
          : this.sourceView
            ? this.sourceStructs.name(id)
            : this.identifier(id, 'type');
      }
      case 'unknown':
        return this.sourceView ? this.opaqueType(id) : this.identifier(id, 'type');
    }
  }

  /** A whole machine address stepped by a proven record stride retains its
   * pointer view; assignment still converts the exact modular address bits. */
  private stridedPointerTypes(): void {
    for (const [id, expression] of this.program.expressions) {
      this.context.checkpoint(1);
      if (
        expression.kind !== 'integer' ||
        expression.op !== 'add' ||
        this.sourceValueTypes.has(id) ||
        this.program.source?.value_types?.has(id)
      )
        continue;
      for (const [base, step] of [
        [expression.left, expression.right],
        [expression.right, expression.left],
      ] as const) {
        const typeId =
          this.sourceValueTypes.get(base.id) ??
          this.program.source?.value_types?.get(base.id)?.type_id;
        const pointer = typeId && this.typeRecords.get(typeId)?.definition;
        if (!pointer || pointer.kind !== 'pointer' || pointer.bits !== 64) continue;
        const stride = this.sourceStructs.strides.get(pointer.to);
        if (!stride || !this.partialLayout(pointer.to)) continue;
        const scaled = this.program.expressions.get(step.id);
        if (scaled?.kind !== 'integer') continue;
        const amount = this.constantOf(scaled.right);
        if (
          amount === undefined ||
          !(
            (scaled.op === 'mul' && amount === stride) ||
            (scaled.op === 'shl' && amount < 16n && 1n << amount === stride)
          )
        )
          continue;
        if (
          this.localValidation.presentation(
            'strided_struct_pointer',
            this.input.function.id,
            'whole address plus an index scaled by the observed member period; exact target address bits retained',
            [id, base.id],
          )
        )
          this.sourceValueTypes.set(id, typeId!);
        break;
      }
    }
  }

  private naturalScalar(id: string): string | null {
    return this.sourceView ? this.sourceStructs.scalar(id) : null;
  }

  private partialLayout(id: string): readonly ObservedMember[] | null {
    return this.sourceView && this.language === 'c-like' ? this.sourceStructs.layout(id) : null;
  }

  /** `p->f_<offset>` for an access at `p + offset` through a declared pointer to
   * a declared partial structure with a member of exactly that offset and width. */
  private memberAccess(address: Value, bits: number): string | null {
    let base = address,
      offset = 0n;
    let index: Value | undefined,
      stride = 0n;
    for (let depth = 0; this.inline.has(base.id) && depth < 16; depth++) {
      const expression = this.program.expressions.get(base.id);
      if (
        (expression?.kind === 'cast' &&
          (expression.op === 'bitcast' ||
            expression.op === 'truncate' ||
            expression.op === 'zero_extend')) ||
        (expression?.kind === 'extract' && expression.offset === 0)
      ) {
        if (bitWidth(base.type) !== bitWidth(expression.value.type)) return null;
        base = expression.value;
        continue;
      }
      if (expression?.kind !== 'integer' || expression.op !== 'add') return null;
      const left = this.constantOf(expression.left),
        right = this.constantOf(expression.right);
      if (right !== undefined) {
        base = expression.left;
        offset += right;
      } else if (left !== undefined) {
        base = expression.right;
        offset += left;
      } else {
        if (index) return null;
        for (const [candidate, other] of [
          [expression.left, expression.right],
          [expression.right, expression.left],
        ] as const) {
          const scaled = this.program.expressions.get(candidate.id);
          if (!this.inline.has(candidate.id) || scaled?.kind !== 'integer') continue;
          const amount = this.constantOf(scaled.right);
          if (amount === undefined) continue;
          if (scaled.op === 'mul' && amount > 0n) stride = amount;
          else if (scaled.op === 'shl' && amount < 16n) stride = 1n << amount;
          else continue;
          index = scaled.left;
          base = other;
          break;
        }
        if (!index) return null;
      }
    }
    if (this.inline.has(base.id) || base.type.kind !== 'integer') return null;
    offset = BigInt.asIntN(base.type.bits, offset);
    const id =
      this.sourceValueTypes.get(base.id) ?? this.program.source?.value_types?.get(base.id)?.type_id;
    const pointer = id ? this.typeRecords.get(id)?.definition : undefined;
    if (pointer?.kind !== 'pointer' || this.declaredSpelling(base) !== this.sourceType(id!))
      return null;
    const members = this.partialLayout(pointer.to);
    const elementStride = this.sourceStructs.strides.get(pointer.to);
    const indexedStruct = !!index && stride === elementStride;
    const member = members?.find((item) => {
      if (item.bits !== bits || this.typeRecords.get(item.typeId)?.definition.kind !== 'integer')
        return false;
      if (item.count === undefined) return (!index || indexedStruct) && item.offset === offset;
      const displacement = offset - item.offset,
        size = BigInt(item.bits / 8);
      return (
        displacement >= 0n &&
        displacement % size === 0n &&
        (item.count === null || displacement / size < item.count) &&
        (!index || stride === size)
      );
    });
    if (
      !member ||
      !this.localValidation.presentation(
        'partial_struct_member',
        this.input.function.id,
        'declared partial structure member at the exact accessed offset and width',
      )
    )
      return null;
    let access = indexedStruct
      ? `${this.local(base)}[${this.value(index!)}].f_${member.offset.toString(16)}`
      : `${this.local(base)}->f_${member.offset.toString(16)}`;
    if (member.count !== undefined) {
      const displacement = (offset - member.offset) / BigInt(member.bits / 8);
      const subscript = index
        ? `(${this.value(index)})${displacement ? ` + ${displacement}` : ''}`
        : String(displacement);
      access += `[${subscript}]`;
    }
    return access;
  }

  /** Walk the entire used type closure, including nested pointer members. */
  private structDeclarations(typeIds: Iterable<string>): void {
    const seen = new Set<string>(),
      emitted = new Set<string>();
    const pending = [...typeIds, ...this.sourceOpaqueTypes.keys()],
      structures: string[] = [];
    for (let index = 0; index < pending.length; index++) {
      this.context.checkpoint(1);
      const id = pending[index]!;
      if (seen.has(id)) continue;
      seen.add(id);
      const record = this.typeRecords.get(id),
        type = record?.definition;
      if (
        !record ||
        type?.kind === 'unknown' ||
        (record.status !== 'established' &&
          record.status !== 'asserted' &&
          !(record.source === 'analysis' && record.status === 'candidate'))
      ) {
        this.opaqueType(id);
        continue;
      }
      if (type?.kind === 'pointer') pending.push(type.to);
      else if (type?.kind === 'array' || type?.kind === 'vector') pending.push(type.element);
      else if (type?.kind === 'structure') {
        const scalar = this.naturalScalar(id);
        if (scalar) {
          pending.push(scalar);
          continue;
        }
        const name = this.sourceStructs.name(id);
        if (emitted.has(name)) continue;
        emitted.add(name);
        structures.push(id);
        for (const field of type.fields) pending.push(field.type_id);
      }
    }
    for (const id of structures) {
      const name = this.sourceStructs.name(id);
      this.writer.line(0, `typedef struct ${name} ${name};`);
    }
    for (const name of this.sourceOpaqueTypes.values())
      this.writer.line(0, `typedef struct ${name} ${name};`);
    const declaredArrays = new Set<string>();
    const declareArray = (id: string): void => {
      if (declaredArrays.has(id)) return;
      const type = this.typeRecords.get(id)?.definition;
      if (type?.kind !== 'array') return;
      declaredArrays.add(id);
      const element = this.typeRecords.get(type.element)?.definition;
      if (
        !element ||
        element.kind === 'unknown' ||
        this.sourceOpaqueTypes.has(type.element) ||
        (element.kind === 'structure' && !this.naturalScalar(type.element))
      ) {
        const name = this.sourceType(id);
        this.writer.comment(0, 'array element size is not established; opaque view');
        this.writer.line(0, `typedef struct ${name} ${name};`);
        return;
      }
      declareArray(type.element);
      this.writer.line(
        0,
        `typedef ${this.sourceType(type.element)} ${this.sourceType(id)}[${type.count ?? ''}];`,
      );
    };
    for (const id of pending) declareArray(id);
    for (const id of structures) {
      const members = this.partialLayout(id);
      if (!members) continue;
      const name = this.sourceStructs.name(id),
        parts: string[] = [];
      let end = 0n,
        packed = false;
      for (const member of members) {
        if (member.offset > end)
          parts.push(`uint8_t gap_${end.toString(16)}[${member.offset - end}];`);
        const definition = this.typeRecords.get(member.typeId)?.definition;
        const spelling =
          definition?.kind === 'float'
            ? definition.bits === 32
              ? 'float'
              : 'double'
            : definition?.kind === 'integer' && definition.bits === 128
              ? definition.signed
                ? '__int128_t'
                : '__uint128_t'
              : this.sourceType(member.typeId);
        const array = member.count === undefined ? '' : `[${member.count ?? ''}]`;
        parts.push(`${spelling} f_${member.offset.toString(16)}${array};`);
        packed ||= member.offset % BigInt(member.bits / 8) !== 0n;
        end = member.offset + member.size;
      }
      const stride = this.sourceStructs.strides.get(id);
      if (stride) {
        if (stride > end) parts.push(`uint8_t gap_${end.toString(16)}[${stride - end}];`);
        packed ||= members.some((member) => stride % BigInt(member.bits / 8) !== 0n);
        this.writer.comment(0, `observed access stride ${stride}; not an allocation extent`);
      }
      this.writer.comment(0, 'observed members only; size unknown');
      this.writer.line(
        0,
        `struct ${name} { ${parts.join(' ')} }${packed ? ' __attribute__((packed))' : ''};`,
      );
    }
  }

  private unalignedRecorded = false;
  /** Plain scalar access spelling for an IR access that permits unaligned
   * addresses (alignment 1), recorded once per function as a target fact. */
  private permitUnaligned(node: Extract<Instruction, { kind: 'load' | 'store' }>): boolean {
    if (this.unalignedRecorded) return true;
    if (
      !this.localValidation.presentation(
        'unaligned_access_permitted',
        this.input.function.id,
        'IR alignment 1 permits unaligned scalar access; plain dereferences below carry no alignment fault',
      )
    )
      return false;
    this.localValidation.requireAbi(
      'unaligned_access_permitted',
      [node.id],
      'Plain scalar dereferences assume the target permits unaligned access for ordinary loads and stores, as the lifted IR alignment of 1 states.',
    );
    this.unalignedRecorded = true;
    return true;
  }

  /** C character identity comes from the installed contract's evidence, never
   * from a guessed callee name or an arbitrary 8-bit pointee. */
  private callParameterType(projection: BoundaryProjection, index: number): string {
    const association = projection.signature!;
    const parameter = association.signature.parameters[index]!;
    const fallback = this.sourceType(parameter.type_id);
    if (!this.sourceView || this.language !== 'c-like' || association.source !== 'library')
      return fallback;
    const cached = this.callParameterSpellings.get(parameter.id);
    if (cached !== undefined) return cached;
    this.callParameterSpellings.set(parameter.id, fallback);
    const pointer = this.typeRecords.get(parameter.type_id);
    const character =
      pointer?.definition.kind === 'pointer'
        ? this.typeRecords.get(pointer.definition.to)
        : undefined;
    if (
      pointer?.source !== 'library' ||
      character?.source !== 'library' ||
      character.definition.kind !== 'integer' ||
      character.definition.bits !== 8
    )
      return fallback;
    let spelling: string | undefined;
    for (const id of association.evidence_ids) {
      this.context.checkpoint(1);
      const declaration = this.libraryDeclarations.get(id);
      if (!declaration) continue;
      const type = declaration.parameters[index]?.[1];
      if (!type || typeof type === 'string' || type.kind !== 'pointer' || type.to !== 'char')
        return fallback;
      const accesses = declaration.memory?.filter((item) => item.argument === index) ?? [];
      const next =
        accesses.length && accesses.every((item) => item.access === 'read')
          ? 'const char*'
          : 'char*';
      if (spelling !== undefined && spelling !== next) return fallback;
      spelling = next;
    }
    if (
      !spelling ||
      !this.localValidation.presentation(
        'library_string_parameter',
        parameter.id,
        'library-contract C character pointer; const only for a declared read-only argument footprint',
        [association.id, parameter.type_id],
      )
    )
      return fallback;
    this.callParameterSpellings.set(parameter.id, spelling);
    return spelling;
  }

  /** Call-site declarations describe the recovered interface, not an authored prototype. */
  private declareSourceCallees(): void {
    if (!this.sourceView || this.language !== 'c-like') return;
    const declarations = new Map<string, { text: string; node: Instruction } | null>();
    for (const [id, projection] of this.program.calls) {
      const node = this.statements.get(id);
      if (node?.kind !== 'call' || node.target.kind !== 'direct') continue;
      const name = this.sourceCallee(node);
      if (name === this.identifiers.get(this.input.function.id)?.identifier) continue;
      const signature = projection.signature?.signature;
      if (projection.results.length > 1) continue;
      const result = signature
        ? this.sourceType(signature.return_type)
        : projection.results.length === 1
          ? this.valueType(projection.results[0]!)
          : projection.kind !== 'physical'
            ? 'void'
            : null;
      if (!result) continue;
      const parameters = signature
        ? signature.parameters.map((_, index) => this.callParameterType(projection, index))
        : projection.arguments.map((value) => this.valueType(value));
      const open = signature
        ? signature.variadic
        : projection.argument_list_complete === false || projection.kind === 'physical';
      if (signature?.variadic && parameters.length === 0) continue;
      if (open) parameters.push(parameters.length ? '...' : 'uintptr_t');
      const text = `extern ${result} ${name}(${parameters.length ? this.writer.join(parameters) : 'void'});`;
      const previous = declarations.get(name);
      declarations.set(
        name,
        previous === null || (previous && previous.text !== text) ? null : { text, node },
      );
    }
    for (const declaration of declarations.values()) {
      if (!declaration) continue;
      const { text, node } = declaration;
      const signature = this.program.calls.get(node.id)!.signature;
      if (
        !this.localValidation.presentation(
          'call_declaration',
          node.id,
          signature
            ? 'C declaration from the recovered source signature'
            : 'unknown prototype: C declaration of the observed call interface only; open arguments retain their explicit remainder marker',
        )
      )
        continue;
      if (!signature) {
        this.localValidation.requireAbi(
          'call_declaration',
          [node.id],
          'The declaration describes the observed native call interface under the target ABI, not a proven authored prototype; unresolved trailing arguments remain explicit.',
        );
        this.writer.comment(0, 'unknown prototype; observed call interface only');
      }
      const start = this.writer.offset;
      this.writer.line(0, text);
      this.mapped(node, start, [], signature?.evidence_ids ?? []);
    }
  }

  private declareDataTables(): void {
    if (!this.sourceView) return;
    const declared = new Set<string>();
    for (const [id, table] of this.indexedData) {
      const node = this.statements.get(id);
      if (node?.kind !== 'load' || !this.permitUnaligned(node)) continue;
      const object = table.data.object;
      if (
        !this.localValidation.presentation(
          'indexed_data_load',
          id,
          'exact mapped data base plus nonwrapping integer index, element-width scaling and aligned symbol displacement; native names use their C spelling; no array bound or string ownership inferred',
          [node.address.id, table.index.id],
        )
      )
        continue;
      const key = `${this.addressKey(object.address)}:u${table.bits}`;
      const stem =
        table.data.source_name ?? table.data.name ?? `data_${object.address.value.toString(16)}`;
      if (table.data.name !== undefined) this.names.set(key, table.data.name);
      const name = this.sourceIdentifier(key, stem);
      this.dataTables.set(id, { ...table, name });
      if (declared.has(key)) continue;
      declared.add(key);
      const start = this.writer.offset;
      this.writer.comment(
        0,
        `${name}: image VA 0x${object.address.value.toString(16)}; byte extent ${object.byte_length ?? 'unknown'}`,
      );
      if (this.language === 'c-like')
        this.writer.line(
          0,
          `extern ${object.mutable ? '' : 'const '}uint${table.bits}_t ${name}[];`,
        );
      else
        this.writer.line(
          0,
          `${name} = memory_view(0x${object.address.value.toString(16)}, "uint${table.bits}_t", ${object.mutable ? 'True' : 'False'})`,
        );
      this.writer.helper(
        this.language === 'c-like' ? name : 'memory_view',
        'Image-backed indexed storage view at the declared VA; no allocation or invented extent. Index units are the declared scalar width. Reads retain original byte order, aliasing and faults; no Python sequence bounds or negative-index rebasing.',
      );
      this.mapped(node, start, [node.address.id], object.evidence_ids);
    }
  }

  /** Source-view memory access: `*p` through a declared scalar pointer of the
   * accessed width, otherwise one cast dereference of the actual address. The
   * memory-view annotation stays in mappings and inferences, not in the text. */
  private sourceStorage(node: Extract<Instruction, { kind: 'load' | 'store' }>): string {
    const table = this.dataTables.get(node.id);
    if (table) {
      let index = this.printer.reduce(bitWidth(table.index.type), this.printed(table.index));
      if (table.stride !== 1n || table.offset !== 0n) index = this.printer.reduce(64, index);
      if (table.stride !== 1n)
        index = this.printer.binary('*', index, this.printer.literal(table.stride, 64), {
          bits: 64,
          signed: false,
        });
      if (table.offset !== 0n)
        index = this.printer.binary('+', this.printer.literal(table.offset, 64), index, {
          bits: 64,
          signed: false,
        });
      return `${table.name}[${index.text}]`;
    }
    const type = node.kind === 'load' ? node.result.type : node.value.type,
      access = node.access,
      plain =
        type.kind === 'integer' &&
        access.endian === 'little' &&
        !access.volatile &&
        access.alignment === 1;
    const pointerAddress = this.uncast(node.address, ['bitcast']);
    if (this.language === 'c-like' && plain && !this.inline.has(pointerAddress.id)) {
      const pointee = this.declaredPointer(pointerAddress);
      if (
        pointee?.bits === bitWidth(type) &&
        this.permitUnaligned(node) &&
        this.localValidation.presentation(
          'typed_dereference',
          this.input.function.id,
          'declared scalar pointer of exactly the accessed width at displacement 0',
        )
      )
        return `*${this.local(pointerAddress)}`;
    }
    if (this.language === 'c-like' && plain) {
      const member = this.memberAccess(node.address, bitWidth(type));
      if (member && this.permitUnaligned(node)) return member;
    }
    let address = this.sourceAddressPrinted(node.address);
    if (this.language === 'python-like') {
      const name = `${access.volatile ? 'volatile_' : ''}${access.endian === 'big' ? 'be_' : ''}${type.kind === 'integer' ? `u${type.bits}` : machineType(type)}`;
      this.writer.helper(
        `memory.${name}`,
        `Ordered ${access.endian}-endian ${bitWidth(type)}-bit memory view, alignment ${access.alignment}; aliasing and faults are preserved. It is not a scalar local.`,
      );
      return `memory.${name}[${address.text}]`;
    }
    if (access.endian === 'big')
      return this.call(
        `memory_be${bitWidth(type)}`,
        'Big-endian memory lvalue; ordered access with original aliasing and fault behavior.',
        [address.text],
      );
    // A declared pointer converts directly; a narrower integer goes through uintptr_t.
    const spelling =
      this.inline.has(node.address.id) || this.program.source?.stack_addresses.has(node.address.id)
        ? ''
        : this.declaredSpelling(node.address);
    if (spelling.endsWith('*')) address = this.printer.primary(this.local(node.address));
    else if (address.ctype?.bits !== 64 || address.ctype.signed)
      address = {
        text: `(uintptr_t)${this.printer.group(address, UNARY)}`,
        precedence: UNARY,
        ctype: { bits: 64, signed: false },
      };
    let name: string;
    if (type.kind !== 'integer') name = machineType(type);
    else if (access.alignment === 1 && this.permitUnaligned(node)) name = `uint${type.bits}_t`;
    else {
      name = `aligned${access.alignment}_uint${type.bits}_t`;
      this.writer.helper(
        name,
        `Exact ${type.bits}-bit little-endian storage view whose address must be ${access.alignment}-byte aligned (misalignment faults); no strict-aliasing or padding assumption.`,
      );
    }
    return `*(${access.volatile ? 'volatile ' : ''}${name} *)${this.printer.group(address, UNARY)}`;
  }

  private storage(node: Extract<Instruction, { kind: 'load' | 'store' }>): string {
    const local = this.program.source?.locals.get(node.id);
    if (local)
      return (
        this.identifiers.get(local.id)?.identifier ??
        this.sourceIdentifier(
          local.id,
          this.names.get(local.id) ??
            this.sourceRoleNames.get(local.id) ??
            (local.stack_offset !== undefined
              ? `local_${(-local.stack_offset).toString(16)}`
              : `local${this.sourceLocal++}`),
        )
      );
    if (this.sourceView) return this.sourceStorage(node);
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

  private sourceCall(
    node: Extract<Instruction, { kind: 'call' }>,
    depth: number,
    literalsAllowed = true,
  ): string {
    const projection = this.program.calls.get(node.id)!;
    const literals: string[] = [];
    const args = projection.arguments.map((value, index) => {
      this.context.checkpoint(1);
      const parameter = projection.signature?.signature.parameters[index];
      const parameterType = parameter && this.typeRecords.get(parameter.type_id)?.definition;
      const pointer = parameterType?.kind === 'pointer';
      const pointee = pointer ? this.typeRecords.get(parameterType.to)?.definition : undefined;
      const bytePointer =
        pointee?.kind === 'void' || (pointee?.kind === 'integer' && pointee.bits === 8);
      const literal =
        !literalsAllowed || (pointer && !bytePointer) ? undefined : this.sourceLiteral(value);
      if (literal !== undefined) literals.push(value.id);
      const text = pointer
        ? (literal ?? this.sourceAddressValue(value, !this.sourceView))
        : (literal ?? this.value(value));
      if (pointer && this.language === 'c-like') {
        const spelling = this.callParameterType(projection, index);
        if (literal !== undefined)
          return /^(?:const )?(?:char|void)\s*\*$/.test(spelling)
            ? literal
            : `(${spelling})${literal}`;
        return `((${spelling})(uintptr_t)(${text}))`;
      }
      const type = parameter && this.typeRecords.get(parameter.type_id)?.definition;
      if (type?.kind === 'integer' && type.signed && this.language === 'python-like')
        return this.call(
          `int${type.bits}`,
          'Interpret source integer argument with its established signed ABI type.',
          [text],
        );
      return text;
    });
    if (
      literals.length &&
      !this.localValidation.presentation(
        'string_literal',
        node.id,
        'pointer-width constant call arguments addressing the exact start of an immutable NUL-terminated string with established encoding, printed as that string literal',
        literals,
      )
    )
      return this.sourceCall(node, depth, false);
    if (this.sourceView) {
      const contract = this.effectContract(node.clobbers);
      if (
        contract === null ||
        !this.localValidation.presentation(
          'call_effects',
          node.id,
          'the visible call carries its own ordered memory/fault effects; its unchanged physical clobber contract is retained in this record, not a second effect statement',
          [node.effect_in.id, node.effect_out.id],
          contract,
        )
      )
        this.writer.statement(depth, this.clobbers(node.clobbers));
    }
    const open = projection.argument_list_complete === false || projection.kind === 'physical';
    if (open)
      args.push(
        this.call(
          projection.arguments.length ? 'unknown_argument_remainder' : 'unknown_arguments',
          'Unresolved remainder of a call interface; not zero arguments or a purity claim.',
          [],
        ),
      );
    let target = this.sourceCallee(node);
    this.writer.helper(
      target,
      `${projection.kind === 'source' ? 'Established' : 'Inferred or incomplete'} source call. Original target: ${node.target.kind === 'direct' ? this.writer.quote(this.addressKey(node.target.address)) : 'indirect'}. Original memory effect: ${node.clobbers.memory}. Calls remain ordered; unused machine clobbers are not source results.`,
    );
    if (
      this.sourceView &&
      node.target.kind === 'indirect' &&
      this.localValidation.presentation(
        'function_pointer_call',
        node.id,
        'indirect call target presented through a function-pointer type spelled from the projected argument and result types; an open arity keeps a trailing ellipsis and the remainder marker',
        [node.target.value.id],
      )
    )
      target = this.functionPointer(node, projection, target, open);
    const variadic = projection.variadic_stack_arguments ?? 0;
    if (variadic)
      this.writer.comment(
        depth,
        `last ${variadic} argument${variadic === 1 ? '' : 's'} observed in Darwin variadic outgoing stack slots (a lower bound; the source arity stays open)${projection.kind === 'physical' ? '; the register arguments before them are an observed, possibly incomplete prefix' : ''}`,
      );
    const operation = `${target}(${this.writer.join(args)})`;
    const results = projection.results.filter((value) => this.program.live.has(value.id));
    const result = results.length === 1 ? results[0] : undefined;
    if (
      this.nativeIntegerStorage &&
      result?.type.kind === 'integer' &&
      integerStorageBits(result.type.bits) !== result.type.bits
    )
      return `${this.local(result)} = ${this.printer.cast(result.type.bits, false, this.printer.primary(operation, { bits: integerStorageBits(result.type.bits), signed: false })).text}`;
    return results.length
      ? `${results.length === 1 ? this.local(results[0]!) : `(${this.writer.join(results.map((value) => this.local(value)))})`} = ${operation}`
      : operation;
  }

  /** C: `((R (*)(T0, T1, ...))target)`; Python-like: `function_pointer(target, "R (*)(...)")`.
   * The result type is the single projected result, void only for a projected
   * source/inferred interface without results, and unknown_result otherwise. */
  private functionPointer(
    node: Extract<Instruction, { kind: 'call' }>,
    projection: BoundaryProjection,
    target: string,
    open: boolean,
  ): string {
    const declared = projection.signature?.signature;
    const result =
      projection.results.length === 1
        ? declared
          ? this.sourceType(declared.return_type)
          : this.valueType(projection.results[0]!)
        : projection.results.length === 0 && projection.kind !== 'physical'
          ? 'void'
          : 'unknown_result';
    const parameters = declared
      ? declared.parameters.map((_, index) => this.callParameterType(projection, index))
      : projection.arguments.map((value) => {
          this.context.checkpoint(1);
          return this.valueType(value);
        });
    if (declared ? declared.variadic : open)
      parameters.push(parameters.length ? '...' : 'uintptr_t');
    const signature = `${result} (*)(${parameters.length ? this.writer.join(parameters) : 'void'})`;
    if (this.language === 'python-like')
      return this.call(
        'function_pointer',
        'Call target address bits as a function of the given C type; neither a host function nor proof that the target has that prototype.',
        [target, this.writer.quote(signature)],
      );
    // A cast binds tighter than a call only around a primary expression.
    let depth = 0,
      enclosed = target.startsWith('(');
    for (let index = 0; enclosed && index < target.length; index++) {
      if (target[index] === '(') depth++;
      else if (target[index] === ')' && --depth === 0 && index !== target.length - 1)
        enclosed = false;
    }
    return `((${signature})${enclosed || /^[A-Za-z_]\w*$/.test(target) ? target : `(${target})`})`;
  }

  /** Shared assignment spelling for retained pure definitions and source loads. */
  private assignmentText(
    node: Extract<Instruction, { kind: 'assign' | 'load' }>,
    storage?: string,
  ): string {
    if (node.kind === 'assign') {
      const expression = this.program.expressions.get(node.result.id) ?? node.expression;
      if (
        this.sourceView &&
        expression.kind === 'cast' &&
        expression.op === 'zero_extend' &&
        this.variableKey(node.result) === this.variableKey(expression.value)
      )
        return '';
      return `${this.local(node.result)} = ${this.assignedText(
        node.result,
        this.expression(expression, this.expressionType(node.result)),
        expression,
      )}`;
    }
    storage ??= this.storage(node);
    return this.program.live.has(node.result.id)
      ? `${this.local(node.result)} = ${
          this.sourceInterpretation(node.result, {
            text: storage,
            precedence: storage.startsWith('*') ? UNARY : 16,
            ctype: null,
          }).text
        }`
      : storage;
  }

  private mapMemory(node: Instruction, start: number, end = this.writer.offset): void {
    const view = this.program.memory.get(node.id);
    if (view)
      this.mapped(
        node,
        start,
        [
          view.shape.id,
          view.field.id,
          view.shape.type_id,
          ...(this.program.source?.field_subjects?.get(node.id) ?? []),
        ],
        [...view.shape.evidence_ids, ...view.field.evidence_ids],
        end,
      );
  }

  private instruction(node: Instruction, depth: number): void {
    this.emitNotes(node.id, depth);
    const start = this.writer.offset;
    let text: string;
    switch (node.kind) {
      case 'assign': {
        text = this.assignmentText(node);
        if (!text) {
          this.map(node, start);
          return;
        }
        break;
      }
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
          [
            this.writer.quote(node.scope),
            this.writer.quote(node.ordering),
            this.writer.quote(node.accesses),
          ],
        );
        break;
      case 'load':
      case 'store': {
        if (this.program.source) {
          const storage = this.storage(node);
          if (node.kind === 'store') {
            // Storing converts to the lvalue's own width (a local is declared
            // unsigned; a dereference has exactly the stored width).
            text = `${storage} = ${this.converted(this.printed(node.value), bitWidth(node.value.type))}`;
          } else text = this.assignmentText(node, storage);
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
          text = this.sourceCall(node, depth);
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
          const contract =
            this.sourceView && node.kind === 'unknown_effect'
              ? this.effectContract(node.clobbers)
              : null;
          const compact =
            contract !== null &&
            this.localValidation.presentation(
              'compact_unknown_effect',
              node.id,
              'one ordered opaque statement retains the original reason, memory contract, physical input snapshot and requested outputs; the unchanged register/flag clobber contract is retained in this record',
              [node.effect_in.id, node.effect_out.id],
              contract,
            );
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
          args.push(
            this.registers(inputs),
            compact ? this.writer.quote(node.clobbers.memory) : this.clobbers(node.clobbers),
          );
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
            compact
              ? '__unknown_effect'
              : source
                ? 'source_call'
                : node.kind === 'call'
                  ? 'physical_call'
                  : 'opaque_effect',
            compact
              ? 'Ordered opaque instruction effect, never a pure call or no-op. Arguments: original reason, physical input snapshot, memory contract, requested physical output keys. Exact register/flag clobbers are in the compact_unknown_effect presentation record for the mapped statement. Read inputs before clobbering outputs; unrequested clobbers still occur. Preserve ordering and faults relative to every load, store, call and fence.'
              : source
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
    this.mapMemory(node, start);
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
      if (region.form) {
        this.loopTests.set(region.form.test, region.form);
        if (region.form.kind === 'while')
          for (const stage of region.form.chain ?? []) this.loopTests.set(stage.test, region.form);
      }
      this.findLabels(
        region.body,
        [...nesting, { kind: 'loop', header: region.header, follow }],
        depth + 1,
        region.header,
      );
      return;
    }
    const decide = (
      item: ParallelTransfer,
      nested: readonly Nest[],
      destination: string | null,
      performed?: TransferAction,
    ): void => {
      if (!this.program.blocks.has(item.target))
        this.invalid('Transfer target has no structured block');
      const action =
        (this.loopExits.has(item) ? 'loop-exit' : performed) ??
        transferAction(
          item,
          nested,
          destination,
          this.language,
          this.sourceView,
          !!this.program.source,
          this.normalizeLoopTargets,
        );
      // A duplicated tail prints its transfers again; each copy must agree.
      const previous = this.actions.get(item);
      if (previous !== undefined && previous !== action)
        this.invalid('A duplicated transfer has inconsistent rendered actions');
      this.actions.set(item, action);
      if (performed) this.consumed.add(item);
      if (action === 'goto') {
        this.labels.add(item.target);
        this.gotos.add(item);
      } else if (action === 'fallthrough') this.fallthrough.add(item);
    };
    const control = region.control;
    const form = this.loopTests.get(control.id);
    const performed = form ? formArm(form, control) : [];
    const arm = (item: ControlArm, nested: readonly Nest[]): void => {
      decide(
        item.transfer,
        nested,
        item.body ? this.firstBlock(item.body) : follow,
        performed.find((entry) => entry.arm === item)?.action,
      );
      if (item.body) this.findLabels(item.body, nested, depth + 1, follow);
    };
    if (control.kind === 'jump') decide(control.transfer, nesting, follow);
    if (control.kind === 'if') {
      arm(control.when_true, nesting);
      arm(control.when_false, nesting);
    }
    if (control.kind === 'switch') {
      const nested: readonly Nest[] =
        this.language === 'c-like' ? [...nesting, { kind: 'switch', id: control.id }] : nesting;
      for (const item of control.cases) {
        this.context.checkpoint(1);
        arm(item.arm, nested);
      }
      arm(control.otherwise, nested);
    }
  }

  private transfer(transfer: ParallelTransfer, depth: number, origin: Control): void {
    if (!this.program.transfers.has(transfer)) this.invalid('Reconstructed transfer is missing');
    // Coalesced phi classes share storage: order moves by printed variable.
    const key = (value: Value): string => this.variableKey(value);
    // Copies hoisted into a `for` header are independent of every other copy of
    // this edge and execute right after the ones printed here.
    const hoisted = this.hoisted.get(transfer);
    const copies = this.printedCopies(transfer).filter(
      (copy) => !hoisted?.has(key(copy.destination)),
    );
    const moves: PlannedMove[] = [];
    // A write is safe only after all other RHS readers of its destination ran.
    if (copies.length === 1) {
      const copy = copies[0]!;
      moves.push({ destination: key(copy.destination), source: copy.source });
      this.writer.statement(
        depth,
        `${this.local(copy.destination)} = ${this.copied(copy.destination, copy.source)}`,
      );
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
        pending.set(key(copy.destination), { ...copy, dependencies: new Set() });
        readers.set(key(copy.destination), 0);
      }
      for (const move of pending.values()) {
        const seen = new Set<string>();
        const values = [move.source];
        while (values.length) {
          this.context.checkpoint(1);
          const value = values.pop()!;
          if (seen.has(value.id)) continue;
          seen.add(value.id);
          const expression = this.inline.has(value.id)
            ? this.program.expressions.get(value.id)
            : undefined;
          if (expression) {
            for (const operand of expressionOperands(expression)) {
              this.context.checkpoint(1);
              values.push(operand);
            }
          } else if (key(value) !== key(move.destination) && pending.has(key(value))) {
            move.dependencies.add(key(value));
            readers.set(key(value), readers.get(key(value))! + 1);
          }
        }
      }
      const ready: Move[] = [];
      for (const move of pending.values()) {
        this.context.checkpoint(1);
        if (readers.get(key(move.destination)) === 0) ready.push(move);
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
          if (moves.length <= 128)
            moves.push({ destination: candidate.temporary, source: candidate.source });
          this.writer.statement(
            depth,
            this.writer.declaration(
              this.sourceView && this.program.source?.float_values?.has(candidate.source.id)
                ? this.valueType(candidate.source)
                : this.dataType(candidate.source.type),
              candidate.temporary,
              ` = ${this.value(candidate.source)}`,
            ),
          );
          release(candidate);
        } else {
          const move = ready[next++]!;
          if (moves.length <= 128)
            moves.push({
              destination: key(move.destination),
              source: move.temporary ?? move.source,
            });
          this.writer.statement(
            depth,
            `${this.local(move.destination)} = ${
              move.temporary === undefined
                ? this.copied(move.destination, move.source)
                : this.assignedText(
                    move.destination,
                    this.printer.primary(
                      move.temporary,
                      move.source.type.kind === 'integer'
                        ? { bits: move.source.type.bits, signed: false }
                        : null,
                    ),
                  )
            }`,
          );
          pending.delete(key(move.destination));
          release(move);
        }
      }
    }
    if (hoisted)
      for (const copy of this.printedCopies(transfer))
        if (hoisted.has(key(copy.destination)) && moves.length <= 128)
          moves.push({ destination: key(copy.destination), source: copy.source });
    if (this.program.transfers.get(transfer)!.length) {
      const checked = this.localValidation.check(
        'parallel-copy',
        transfer.effect.destination.id,
        'actual phi-copy emission',
        () => {
          this.localValidation.allowance.charge();
          if (transfer.copies.length > 64)
            return {
              kind: 'parallel-copy',
              subject: transfer.effect.destination.id,
              scope: 'actual phi-copy emission',
              status: 'unverified',
              reason: 'original edge copy bound exceeded',
            };
          return validateParallelMoves(
            transfer.effect.destination.id,
            transfer.copies.flatMap((copy) => {
              this.localValidation.allowance.charge();
              return this.program.live.has(copy.destination.id) &&
                !this.inline.has(copy.destination.id)
                ? [
                    {
                      ...copy,
                      destination: this.variables.get(copy.destination.id) ?? copy.destination,
                    },
                  ]
                : [];
            }),
            moves,
            (id) => {
              // A coalesced value is read from its class's single variable.
              const representative = this.variables.get(id);
              if (representative && representative.id !== id && !this.inline.has(id))
                return { kind: 'cast', op: 'bitcast', value: representative };
              const expression = this.program.expressions.get(id);
              return this.inline.has(id) ||
                (expression?.kind === 'cast' && expression.op === 'bitcast')
                ? expression
                : undefined;
            },
            this.localValidation.allowance,
          );
        },
        [origin.id],
      );
      if (checked.status === 'rejected') rejectTranslation(checked, origin);
    }
    const action = this.actions.get(transfer);
    if (!action) this.invalid('Rendered transfer has no lexical action');
    if (action === 'loop-exit') {
      const route = this.loopExits.get(transfer)!;
      this.writer.statement(depth, `${this.exitFlags.get(route.loop)!} = 1`);
      this.writer.statement(depth, 'break');
      this.emittedEdges.set(transfer, { kind: 'loop-exit', ...route });
      return;
    }
    this.emittedEdges.set(
      transfer,
      action === 'goto' ? { kind: 'goto', target: transfer.target } : { kind: action },
    );
    if (action === 'goto')
      this.writer.statement(depth, `goto ${this.identifier(transfer.target, 'label')}`);
    else if (action !== 'fallthrough' && !this.consumed.has(transfer))
      this.writer.statement(depth, action);
  }

  /** Printed variable identity: a coalesced phi class shares its representative. */
  private variableKey(value: Value): string {
    return (this.variables.get(value.id) ?? value).id;
  }

  /** `a = x, b = y` text of the copies a `for` header prints for one edge. */
  private hoistedText(transfer: ParallelTransfer): string {
    const hoisted = this.hoisted.get(transfer);
    return this.writer.join(
      this.printedCopies(transfer)
        .filter((copy) => hoisted?.has(this.variableKey(copy.destination)))
        .map(
          (copy) =>
            `${this.local(copy.destination)} = ${this.copied(copy.destination, copy.source)}`,
        ),
    );
  }

  /** Inline casts only change width; strip them to the operand they view. */
  private uncast(value: Value, ops: readonly string[]): Value {
    for (let depth = 0; depth < 16 && this.inline.has(value.id); depth++) {
      const expression = this.program.expressions.get(value.id);
      if (expression?.kind !== 'cast' || !ops.includes(expression.op)) break;
      value = expression.value;
    }
    return value;
  }

  /** The copy source prints as `variable ± c` (c != 0), possibly through casts. */
  private inductionStep(source: Value, variable: string): boolean {
    const casts = ['bitcast', 'zero_extend', 'sign_extend', 'truncate'];
    const top = this.uncast(source, casts);
    const expression = this.inline.has(top.id) ? this.program.expressions.get(top.id) : undefined;
    if (expression?.kind !== 'integer' || (expression.op !== 'add' && expression.op !== 'sub'))
      return false;
    const right = this.constantOf(expression.right),
      left = expression.op === 'add' ? this.constantOf(expression.left) : undefined;
    const [base, step] = right !== undefined ? [expression.left, right] : [expression.right, left];
    if (step === undefined || step === 0n) return false;
    const leaf = this.uncast(base, casts);
    return !this.inline.has(leaf.id) && this.variableKey(leaf) === variable;
  }

  /** Side conditions of a `for` header (see LoopFacts.induction). Records the
   * hoisted copies when they hold. */
  private acceptFor(loop: Parameters<LoopFacts['induction']>[0]): boolean {
    const liveness = this.liveness;
    if (!liveness) return false;
    const key = (value: Value): string => this.variableKey(value);
    const steps = this.printedCopies(loop.step),
      inits = this.printedCopies(loop.init);
    // Every copy of both edges reads no other destination of its edge, so
    // printing some of them elsewhere (and in any order) is unobservable.
    const independent = (copies: typeof steps): boolean =>
      copies.every((copy) => {
        const others = new Set(
          copies.filter((other) => other !== copy).map((other) => key(other.destination)),
        );
        return liveness
          .leaves(copy.source)
          .every((index) => !others.has(key(liveness.values[index]!)));
      });
    if (!steps.length || !independent(steps) || !independent(inits)) return false;
    const induction = new Set<string>();
    for (const copy of steps) {
      const variable = key(copy.destination);
      if (!this.inductionStep(copy.source, variable)) return false;
      induction.add(variable);
    }
    const initialized = inits.filter((copy) => induction.has(key(copy.destination)));
    if (initialized.length !== induction.size) return false;
    const restated = this.rebased.get(loop.test.id);
    const reads = loop.bottom
      ? restated
        ? [key(restated.left)]
        : []
      : liveness.leaves(loop.test.condition).map((index) => key(liveness.values[index]!));
    if (!reads.some((variable) => induction.has(variable))) return false;
    // Nothing inside the loop writes an induction variable except the step.
    for (const id of loop.inside) {
      const block = this.program.blocks.get(id);
      if (!block) return false;
      for (const event of liveness.events(block))
        if (event.def && event.ids.some((index) => induction.has(key(liveness.values[index]!))))
          return false;
      for (const arm of [
        ...(block.control.kind === 'jump' ? [{ transfer: block.control.transfer }] : []),
        ...controlArms(block.control),
      ])
        if (
          arm.transfer !== loop.step &&
          this.printedCopies(arm.transfer).some((copy) => induction.has(key(copy.destination)))
        )
          return false;
    }
    if (loop.bottom && !this.entryHolds(loop, inits)) return false;
    this.hoisted.set(loop.init, new Set(initialized.map((copy) => key(copy.destination))));
    this.hoisted.set(loop.step, induction);
    this.forLoops.set(loop.test.id, { init: loop.init, step: loop.step });
    return true;
  }

  /** A bottom test also runs before the first iteration of a `for`: an
   * enclosing arm must establish exactly the restated test `v op K` over the
   * entry value of `v` (same SSA operand modulo bitcasts, constant and width). */
  private entryHolds(
    loop: Parameters<LoopFacts['induction']>[0],
    inits: readonly { readonly destination: Value; readonly source: Value }[],
  ): boolean {
    const restated = this.rebased.get(loop.test.id);
    if (!restated) return false;
    const bound = this.constantOf(restated.right),
      entry = inits.find(
        (copy) => this.variableKey(copy.destination) === this.variableKey(restated.left),
      );
    if (bound === undefined || !entry) return false;
    const op = loop.enter ? restated.op : NEGATED_PREDICATE[restated.op];
    const operand = this.uncast(entry.source, ['bitcast']);
    for (let i = loop.guards.length - 1; i >= 0; i--) {
      const guard = loop.guards[i]!;
      if (this.requirementPredicates.has(guard.control.id)) continue;
      const condition = this.uncast(guard.control.condition, ['bitcast']);
      const compare = this.program.expressions.get(condition.id);
      if (compare?.kind !== 'compare') continue;
      const constant = this.constantOf(compare.right);
      if (
        constant === bound &&
        (guard.value ? compare.op : NEGATED_PREDICATE[compare.op]) === op &&
        this.uncast(compare.left, ['bitcast']).id === operand.id &&
        bitWidth(compare.left.type) === bitWidth(restated.left.type)
      )
        return this.localValidation.presentation(
          'loop_entry_test',
          loop.test.id,
          'the first for-loop test holds on entry: an enclosing if arm establishes the same predicate over the same entry value',
          [guard.control.id, loop.test.id],
        );
    }
    return false;
  }

  /** Edge copies actually printed: a coalesced class's self-copy is no move. */
  private printedCopies(
    transfer: ParallelTransfer,
  ): readonly { readonly destination: Value; readonly source: Value }[] {
    const copies = this.program.transfers.get(transfer) ?? [];
    if (!this.variables.size) return copies;
    return copies.filter((copy) => {
      const destination = this.variables.get(copy.destination.id);
      const source = this.uncast(copy.source, ['bitcast']);
      return !(
        destination &&
        !this.inline.has(source.id) &&
        this.variables.get(source.id) === destination
      );
    });
  }

  private arm(arm: ControlArm, depth: number, origin: Control): void {
    const start = this.writer.codeLines;
    this.transfer(arm.transfer, depth, origin);
    if (arm.body) this.region(arm.body, depth);
    if (this.language === 'python-like' && this.writer.codeLines === start)
      this.writer.statement(depth, 'pass');
  }

  /** An arm that cannot reach the end of its `if` (it returns, jumps or leaves). */
  private terminates(arm: ControlArm): boolean {
    if (arm.body) return this.regionTerminates(arm.body);
    const action = this.actions.get(arm.transfer);
    return (
      action === 'goto' || action === 'break' || action === 'continue' || action === 'loop-exit'
    );
  }

  private regionTerminates(region: Region): boolean {
    this.context.checkpoint(1);
    if (region.kind === 'sequence') {
      const last = region.regions.at(-1);
      return last !== undefined && this.regionTerminates(last);
    }
    if (region.kind === 'loop') return false;
    const control = region.control;
    switch (control.kind) {
      case 'return':
      case 'trap':
      case 'unknown':
      case 'indirect':
        return true;
      case 'jump': {
        const action = this.actions.get(control.transfer);
        return (
          action === 'goto' || action === 'break' || action === 'continue' || action === 'loop-exit'
        );
      }
      case 'if':
        return (
          !this.loopTests.has(control.id) &&
          this.terminates(control.when_true) &&
          this.terminates(control.when_false)
        );
      default:
        return false;
    }
  }

  /** Source-view `if`. Loop tests print as their loop's syntax. Otherwise an
   * arm printing nothing is dropped (testing the inverse when it is the true
   * arm), and an arm that cannot fall through ends the `if` so its sibling
   * follows at the same depth (an early exit, no `else`). */
  private sourceIf(
    control: Extract<Control, { kind: 'if' }>,
    depth: number,
    condition: Printed,
    compare: Extract<Expression, { kind: 'compare' }> | undefined,
    compared: Value,
  ): void {
    const c = this.language === 'c-like';
    const negate = (printed: Printed, flip?: Extract<Expression, { kind: 'compare' }>): string =>
      flip
        ? this.expression({ ...flip, op: NEGATED_PREDICATE[flip.op] }, compared.type).text
        : c
          ? `!${this.printer.group(printed, UNARY)}`
          : `not ${this.printer.group(printed, PRIMARY)}`;
    const test = (positive: boolean): string =>
      positive ? condition.text : negate(condition, compare);
    const form = this.loopTests.get(control.id);
    if (form?.kind === 'while' && form.chain) {
      const stage = form.chain.find((item) => item.test === control.id)!;
      if (control.id === form.test) {
        const start = this.writer.offset;
        const operands = form.chain.map((item) => {
          const block = this.program.blocks.get(item.block)!;
          const test = block.control;
          if (test.kind !== 'if') this.invalid('A loop condition lost its branch');
          const predicate = this.printed(test.condition);
          const condition = item.enter
            ? predicate.text
            : c
              ? `!(${predicate.text})`
              : `not (${predicate.text})`;
          return `(${condition})`;
        });
        this.writer.line(
          depth - 1,
          c ? `while (${operands.join(' && ')}) {` : `while ${operands.join(' and ')}:`,
        );
        for (const item of form.chain) {
          const block = this.program.blocks.get(item.block)!;
          for (const node of block.statements)
            if (this.program.retained.has(node.id)) this.map(node, start);
          this.map(block.control, start, [block.control.effect.id]);
        }
      }
      const enter = stage.enter ? control.when_true : control.when_false;
      const exit = stage.enter ? control.when_false : control.when_true;
      this.transfer(exit.transfer, depth, control);
      this.arm(enter, depth, control);
      return;
    }
    if (form?.kind === 'while' || (form?.kind === 'for' && !form.bottom)) {
      const enter = form.enter ? control.when_true : control.when_false,
        exit = form.enter ? control.when_false : control.when_true,
        header = this.forLoops.get(control.id);
      this.writer.line(
        depth - 1,
        form.kind === 'for' && header
          ? `for (${this.hoistedText(header.init)}; ${test(form.enter)}; ${this.hoistedText(header.step)}) {`
          : c
            ? `while (${test(form.enter)}) {`
            : `while ${test(form.enter)}:`,
      );
      this.transfer(exit.transfer, depth, control);
      this.arm(enter, depth, control);
      return;
    }
    if (form?.kind === 'for') {
      // The header printed this test and the step; both arms are the loop's own.
      const again = form.enter ? control.when_true : control.when_false,
        leave = form.enter ? control.when_false : control.when_true;
      this.transfer(again.transfer, depth, control);
      this.transfer(leave.transfer, depth, control);
      return;
    }
    if (form?.kind === 'do_while') {
      const again = form.repeat ? control.when_true : control.when_false,
        leave = form.repeat ? control.when_false : control.when_true;
      // The repeat copies run before the test; planning proved this unobservable.
      this.transfer(again.transfer, depth, control);
      this.transfer(leave.transfer, depth, control);
      const restated = this.rebased.get(control.id);
      const text = restated
        ? form.repeat
          ? this.expression(restated, control.condition.type).text
          : negate(this.expression(restated, control.condition.type), restated)
        : test(form.repeat);
      this.writer.line(depth - 1, `} while (${text});`);
      return;
    }
    const open = (text: string): void =>
      this.writer.line(depth, c ? `if (${text}) {` : `if ${text}:`);
    const close = (): void => {
      if (c) this.writer.line(depth, '}');
    };
    const empty = (arm: ControlArm): boolean =>
      !arm.body &&
      this.actions.get(arm.transfer) === 'fallthrough' &&
      this.printedCopies(arm.transfer).length === (this.hoisted.get(arm.transfer)?.size ?? 0);
    const yes = control.when_true,
      no = control.when_false;
    const shaped =
      (empty(yes) || empty(no) || this.terminates(yes) || this.terminates(no)) &&
      this.localValidation.presentation(
        'branch_layout',
        this.input.function.id,
        'an empty arm is dropped (inverting the exact integer test) and an arm that cannot fall through ends its if; the other arm follows unchanged',
      );
    if (shaped && empty(no)) {
      open(test(true));
      this.transfer(no.transfer, depth + 1, control);
      if (empty(yes)) {
        this.transfer(yes.transfer, depth + 1, control);
        if (!c) this.writer.statement(depth + 1, 'pass');
      } else this.arm(yes, depth + 1, control);
      close();
    } else if (shaped && empty(yes)) {
      open(test(false));
      this.transfer(yes.transfer, depth + 1, control);
      this.arm(no, depth + 1, control);
      close();
    } else if (shaped) {
      const first = this.terminates(yes) ? yes : no;
      open(test(first === yes));
      this.arm(first, depth + 1, control);
      close();
      this.arm(first === yes ? no : yes, depth, control);
    } else {
      open(test(true));
      this.arm(yes, depth + 1, control);
      this.writer.line(depth, c ? '} else {' : 'else:');
      this.arm(no, depth + 1, control);
      close();
    }
  }

  /** Source view: coalesce phi copies, then lay out return tails and loop
   * syntax. Each step checks its side conditions on this reconstruction and
   * records one presentation rewrite; the checked view never calls this. */
  private planSourceControl(): void {
    const subject = this.input.function.id,
      program = this.program;
    this.indexedData = indexedDataAccesses(program, this.context);
    const indices = new Map([...this.indexedData].map(([id, table]) => [id, table.index]));
    const candidates = planSourceInlining(
      program,
      this.context,
      (value) => this.names.has(value.id),
      (node) => indices.get(node.id),
    );
    if (
      candidates.size &&
      this.localValidation.presentation(
        'single_use_inlining',
        subject,
        'single-use integer expressions expand at dominated SSA uses; nonvolatile loads expand only at unconditional same-block uses with no intervening effects except nested dependent loads; initialized private-local reads may cross unrelated effects but never a write to that local',
        [...candidates.values()].map(({ node }) => node.id),
      )
    ) {
      for (const [id, site] of candidates) {
        this.inlined.set(id, site);
        this.inline.add(id);
        const nodes = this.inlineSites.get(site.anchor) ?? [];
        nodes.push(site);
        this.inlineSites.set(site.anchor, nodes);
      }
    }
    const liveness = new VariableLiveness(program, this.context, 4096, this.inlined, indices);
    this.liveness = liveness;
    const formals = new Set(program.parameters.map((value) => value.id));
    const typeId = (value: Value): string | undefined =>
      this.sourceValueTypes.get(value.id) ?? program.source?.value_types?.get(value.id)?.type_id;
    // Widening copies may share unsigned storage. Interference is checked
    // at every other definition; narrow reads retain their original C type.
    const widening = new Map<string, Value>();
    const assignments: { destination: Value; source: Value }[] = [];
    for (const copies of program.transfers.values())
      for (const copy of copies) {
        const source = this.uncast(copy.source, ['bitcast']);
        if (source.id !== copy.source.id)
          assignments.push({ destination: copy.destination, source });
      }
    for (const block of program.blocks.values())
      for (const node of block.statements) {
        if (node.kind !== 'assign' || !program.retained.has(node.id)) continue;
        const expression = program.expressions.get(node.result.id) ?? node.expression;
        if (expression.kind !== 'cast' || expression.op !== 'zero_extend') continue;
        const source = expression.value,
          destination = node.result;
        if (
          source.type.kind !== 'integer' ||
          destination.type.kind !== 'integer' ||
          source.type.bits >= destination.type.bits ||
          formals.has(source.id) ||
          this.valueType(source) !== this.dataType(source.type) ||
          this.valueType(destination) !== this.dataType(destination.type)
        )
          continue;
        widening.set(source.id, destination);
        assignments.push({ source, destination });
      }
    const storageType = (value: Value): string =>
      machineType((widening.get(value.id) ?? value).type);
    const variables = coalescePhiCopies(
      program,
      liveness,
      (a, b) => {
        if (!program.source && (formals.has(a.id) || formals.has(b.id))) return false;
        const left = widening.get(a.id) ?? a,
          right = widening.get(b.id) ?? b;
        const pointerFormal = [left, right].find(
          (value) => program.source?.formal_types?.get(value.id)?.kind === 'pointer',
        );
        const pointerCompatible =
          pointerFormal &&
          this.valueType(left).replace(/^const /, '') ===
            this.valueType(right).replace(/^const /, '');
        return (
          storageType(a) === storageType(b) &&
          (pointerCompatible ||
            (typeId(left) === typeId(right) && this.valueType(left) === this.valueType(right))) &&
          (this.names.get(a.id) ?? null) === (this.names.get(b.id) ?? null)
        );
      },
      this.context,
      assignments,
    );
    if (
      variables.size &&
      this.localValidation.presentation(
        'phi_copy_coalescing',
        subject,
        'noninterfering edge copies (including formals after their last use) and unsigned widening assignments share storage; formals retain their declaration, otherwise a widening class uses its widest unsigned declaration and preserves original definition and read conversions',
        [...variables.keys()],
      )
    )
      this.variables = variables;
    const key = (value: Value): string => (this.variables.get(value.id) ?? value).id;
    const definitions = program.source?.definitions;
    const hasDefinitions = (anchor: string): boolean =>
      definitions?.get(anchor)?.some((definition) => !this.inlined.has(definition.result.id)) ??
      false;
    const silent = (block: BlockRegion): boolean =>
      !hasDefinitions(block.id) &&
      !hasDefinitions(block.control.id) &&
      block.statements.every(
        (node) =>
          (!program.retained.has(node.id) ||
            ('result' in node && this.inlined.has(node.result.id))) &&
          !hasDefinitions(node.id),
      );
    const layout = planLayout(
      this.body,
      program,
      this.language,
      (block) => {
        if (!silent(block)) return false;
        if (block.control.kind !== 'return') return true;
        // One return statement; a retained physical overlay is printed with it.
        const projection = program.returns.get(block.control.id);
        return !!projection && projection.outputs.length <= 8;
      },
      (transfer) => this.printedCopies(transfer).length,
      this.context,
      (block) =>
        !hasDefinitions(block.id) &&
        !hasDefinitions(block.control.id) &&
        block.statements.every((node) => !hasDefinitions(node.id)) &&
        block.statements.filter((node) => program.retained.has(node.id)).length <= 4 &&
        block.statements.every(
          (node) =>
            !program.retained.has(node.id) ||
            node.kind === 'assign' ||
            node.kind === 'load' ||
            node.kind === 'store',
        ) &&
        (block.control.kind !== 'return' ||
          (program.returns.get(block.control.id)?.outputs.length ?? 9) <= 8),
    );
    let body = this.body;
    if (
      (!layout.ordered.length ||
        this.localValidation.presentation(
          'loop_exit_layout',
          subject,
          'acyclic sibling regions follow exact CFG dependencies, excluding natural header backedges; successors whose external incoming edges all belong to one owned region move to the smallest such region, after any containing loop; fixed-point placement preserves every statement, edge copy and dynamic effect order, while cyclic dependencies retain labels',
          layout.ordered,
        )) &&
      (!layout.duplicated.length ||
        this.localValidation.presentation(
          'return_tail_duplication',
          subject,
          'a labeled edge into an acyclic return tail of at most four blocks, each with at most four assignments/loads/stores and four edge copies, ends in an owned copy; effects execute once on the same path in the same order, and copies retain original identities',
          [...new Set(layout.duplicated.map((item) => item.tail))],
        )) &&
      (!layout.relocated.length ||
        this.localValidation.presentation(
          'terminal_block_placement',
          subject,
          'a terminal block is printed at its only edge, or right after the only loop entering it when every other exit of that loop is a duplicated tail',
          layout.relocated.map((item) => item.block),
        ))
    ) {
      body = layout.body;
      this.clones = layout.clones;
    }
    const shaped = planLoopForms(
      body,
      this.language,
      {
        writes: (transfer) => this.printedCopies(transfer).map((copy) => key(copy.destination)),
        silent,
        plain: (control) => !this.requirementPredicates.has(control.id),
        reads: (control) =>
          liveness.leaves(control.condition).map((index) => key(liveness.values[index]!)),
        live: (block, variables) => {
          const entry = liveness.live(block);
          if (!entry) return true;
          const wanted = new Set(variables);
          return liveness.values.some(
            (value, index) => liveness.has(entry, index) && wanted.has(key(value)),
          );
        },
        rebase: (control, repeat) => this.restateTest(control, repeat),
        induction: (loop) => this.acceptFor(loop),
      },
      this.context,
    );
    const tests: string[] = [],
      fors: string[] = [];
    const forms = (region: Region): void => {
      if (region.kind === 'sequence') region.regions.forEach(forms);
      else if (region.kind === 'loop') {
        if (region.form)
          tests.push(
            ...(region.form.kind === 'while' && region.form.chain
              ? region.form.chain.map((stage) => stage.test)
              : [region.form.test]),
          );
        if (region.form?.kind === 'for') fors.push(region.form.test);
        forms(region.body);
      } else for (const arm of controlArms(region.control)) if (arm.body) forms(arm.body);
    };
    forms(shaped);
    this.body =
      (!tests.length ||
        this.localValidation.presentation(
          'loop_form',
          subject,
          'chained loop tests are expression-only, with single-entry stages and copy-free exits to one continuation; short-circuit evaluation preserves test/load order; bottom tests have a sole repeat edge and dead-on-exit repeat copies',
          tests,
        )) &&
      (!fors.length ||
        this.localValidation.presentation(
          'for_loop',
          subject,
          'a while/do-while prints as for (init; test; step) when its single entry and single repeat edges only initialize and step (x = x ± c) induction variables nothing else in the loop writes, and its test reads one; a bottom test must hold on entry',
          fors,
        ))
        ? shaped
        : body;
    if (this.body === body) {
      this.rebased.clear();
      this.hoisted.clear();
      this.forLoops.clear();
    }
    const normalized: string[] = [];
    visitTransfers(this.body, this.language, this.context, (occurrence) => {
      const target = occurrence.destination ? firstBlock(occurrence.destination) : null;
      if (
        transferAction(occurrence.transfer, occurrence.nesting, target, this.language, true) !==
        transferAction(
          occurrence.transfer,
          occurrence.nesting,
          target,
          this.language,
          true,
          true,
          false,
        )
      )
        normalized.push(occurrence.control.id);
    });
    this.normalizeLoopTargets =
      !normalized.length ||
      this.localValidation.presentation(
        'loop_transfer_target',
        subject,
        'break and continue select the nearest enclosing loop by exact lexical successor/header identity, not the structurer annotation; a C switch never captures a loop break',
        [...new Set(normalized)],
      );
    const routes = planLoopExits(this.body, this.language, this.context);
    if (
      routes.size &&
      this.localValidation.presentation(
        'multi_level_loop_exit',
        subject,
        'an edge to an enclosing loop continuation sets one boolean for that loop and breaks; guards immediately after each intervening loop/switch propagate the exit before any following effects; the flag is initialized before each entry to its target loop',
        [...new Set([...routes.values()].flatMap((route) => route.through))],
      )
    ) {
      this.loopExits = routes;
      for (const route of routes.values()) {
        if (!this.exitFlags.has(route.loop)) {
          let name: string;
          do {
            name = `loop_exit_${this.temporary++}`;
          } while (this.usedSourceNames.has(name));
          this.usedSourceNames.add(name);
          this.exitFlags.set(route.loop, name);
        }
        for (const scope of route.through.slice(0, -1)) {
          const targets = this.exitGuards.get(scope) ?? new Set<string>();
          targets.add(route.loop);
          this.exitGuards.set(scope, targets);
        }
      }
    }
  }

  /** Restate a do-while test over the variable its repeat copy just wrote: for
   * a copy `x <- x + c` and test `(x or zext x) ==/!= K`, test `x ==/!= K + c`.
   * Used only when the bit-vector checker proves the restated test, over the
   * copy's source value, equal to the original test. */
  private restateTest(
    control: Extract<Control, { kind: 'if' }>,
    repeat: ParallelTransfer,
  ): boolean {
    const program = this.program,
      liveness = this.liveness;
    if (!liveness) return false;
    const constant = (value: Value): bigint | undefined => {
      const expression = program.expressions.get(value.id);
      return expression?.kind === 'constant' ? expression.bits : undefined;
    };
    let tested = control.condition,
      compare = program.expressions.get(tested.id);
    for (let i = 0; i < 16 && compare?.kind === 'cast' && compare.op === 'bitcast'; i++) {
      tested = compare.value;
      compare = program.expressions.get(tested.id);
    }
    if (compare?.kind !== 'compare' || (compare.op !== 'eq' && compare.op !== 'ne')) return false;
    const right = constant(compare.right),
      bound = right ?? constant(compare.left);
    let leaf = right === undefined ? compare.right : compare.left;
    if (bound === undefined) return false;
    for (let i = 0; i < 16 && this.inline.has(leaf.id); i++) {
      const cast = program.expressions.get(leaf.id);
      if (cast?.kind !== 'cast' || (cast.op !== 'zero_extend' && cast.op !== 'bitcast'))
        return false;
      leaf = cast.value;
    }
    if (this.inline.has(leaf.id) || leaf.type.kind !== 'integer') return false;
    const width = leaf.type.bits;
    if (bound >= 1n << BigInt(width)) return false;
    const key = (value: Value): string => (this.variables.get(value.id) ?? value).id;
    const copies = this.printedCopies(repeat),
      copy = copies.find((item) => key(item.destination) === key(leaf));
    if (!copy || copy.destination.type.kind !== 'integer' || copy.destination.type.bits !== width)
      return false;
    const offset = (value: Value, depth: number): bigint | null => {
      if (value.id === leaf.id) return 0n;
      const expression = program.expressions.get(value.id);
      if (depth > 8 || !expression || value.type.kind !== 'integer' || value.type.bits < width)
        return null;
      if (
        expression.kind === 'cast' &&
        ['bitcast', 'zero_extend', 'sign_extend', 'truncate'].includes(expression.op)
      )
        return offset(expression.value, depth + 1);
      if (expression.kind === 'extract' && expression.offset === 0)
        return offset(expression.value, depth + 1);
      if (expression.kind !== 'integer' || (expression.op !== 'add' && expression.op !== 'sub'))
        return null;
      const step = constant(expression.right);
      if (step !== undefined) {
        const base = offset(expression.left, depth + 1);
        return base === null ? null : expression.op === 'add' ? base + step : base - step;
      }
      const first = constant(expression.left);
      if (first === undefined || expression.op !== 'add') return null;
      const base = offset(expression.right, depth + 1);
      return base === null ? null : base + first;
    };
    const shift = offset(copy.source, 0);
    if (shift === null) return false;
    if (this.localValidation.skipExhaustedBitvector(tested.id)) return false;
    const restated: Value = { id: `${control.id}#restated_bound`, type: copy.destination.type };
    const bits = BigInt.asUintN(width, bound + shift),
      original = compare,
      subject = tested;
    const expressions = new Map(program.expressions);
    expressions.set(restated.id, { kind: 'constant', bits });
    const record = this.localValidation.check(
      'bitvector',
      subject.id,
      'do-while test restated over its repeat copy result; not whole-function equivalence',
      () =>
        validateBitvectorCandidate(
          subject,
          original,
          { kind: 'compare', op: original.op, left: copy.source, right: restated },
          expressions,
          this.localValidation.allowance,
        ),
    );
    // The derivation above is exact modular arithmetic; the bit-vector check is an
    // independent second proof when its shared allowance remains, and may veto.
    if (
      record.status === 'rejected' ||
      !this.localValidation.presentation(
        'loop_test_restatement',
        control.id,
        `test of x ==/!= ${bound} restated after the repeat copy x <- x ${shift < 0n ? '-' : '+'} ${shift < 0n ? -shift : shift} (mod 2^${width}) as x ==/!= ${bits}`,
        [tested.id, copy.destination.id],
      )
    )
      return false;
    this.synthetic.set(restated.id, { kind: 'constant', bits });
    this.rebased.set(control.id, {
      kind: 'compare',
      op: compare.op,
      left: copy.destination,
      right: restated,
    });
    return true;
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
        const requirement = this.requirementPredicates.get(control.id);
        const originalCondition = this.value(control.condition);
        const condition = requirement
          ? this.call(
              'requirement_predicate',
              'A pure predicate at its original control site. Arguments: requirement ID, site ID, exact SSA state epoch, original predicate, supported predicate result (0 or 1). Evaluate the original pure predicate and preserve any known result, including unsupported state. Only an unknown result may be resolved by explicit matching acknowledgment to the documented supported result; this never changes surrounding values, effects, other sites or epochs, or moves or erases the guard.',
              [
                this.writer.quote(requirement.requirement.id),
                this.writer.quote(requirement.site.id),
                this.writer.quote(requirement.site.state_epoch),
                originalCondition,
                requirement.site.supported_predicate_value ? '1' : '0',
              ],
            )
          : originalCondition;
        let conditionValue = control.condition,
          expression: Expression | undefined;
        for (
          let depth = 0;
          this.program.source && depth < 128 && this.inline.has(conditionValue.id);
          depth++
        ) {
          this.context.checkpoint(1);
          expression = this.program.expressions.get(conditionValue.id);
          if (expression?.kind !== 'cast' || expression.op !== 'bitcast') break;
          conditionValue = expression.value;
        }
        if (this.sourceView) {
          this.sourceIf(
            control,
            depth,
            requirement ? this.printer.primary(condition) : this.printed(control.condition),
            requirement || expression?.kind !== 'compare' ? undefined : expression,
            conditionValue,
          );
          break;
        }
        // Checked compare text carries its own parentheses; source text does not.
        const grouped = !this.sourceView && !requirement && expression?.kind === 'compare';
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
        this.propagateLoopExit(control.id, depth);
        break;
      case 'return': {
        const projection = this.program.returns.get(control.id);
        for (const value of control.values) ids.push(value.id);
        for (const binding of block.register_exit) ids.push(binding.value.id);
        if (projection && projection.kind !== 'physical' && projection.outputs.length === 0) {
          const values = this.writer.list(projection.results, (value) => {
            const scalar = this.sourceView && this.program.source?.return_scalar;
            if (scalar) return this.scalarReturn(value, scalar.bits, scalar.signed).text;
            if (this.program.source?.return_pointer && !this.program.source.return_source_type)
              return this.sourceAddressValue(value, true);
            const returned = this.sourceInterpretation(
              value,
              this.printed(value),
              this.program.signature?.signature.return_type ??
                this.program.source?.return_source_type,
            );
            // `return` converts to the declared result type like assignment.
            const bits = bitWidth(value.type);
            return this.converted(
              returned,
              projection.results.length === 1 && this.returnSpelling === `uint${bits}_t`
                ? bits
                : null,
            );
          });
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
        const tail =
          control.kind === 'indirect' && control.tail_call
            ? this.program.tails.get(control.id)
            : undefined;
        if (tail && this.program.source && control.kind === 'indirect') {
          const key = this.addressKey(tail.target),
            known = this.sourceAddresses.get(key);
          const name =
            this.sourceNames.get(key) ??
            this.sourceIdentifier(
              control.id,
              this.presentedName(control.id) ??
                (known?.name !== undefined &&
                this.sourceView &&
                this.input.source?.abi.id === 'darwin-arm64'
                  ? // Darwin arm64 images are Mach-O: one leading linkage underscore.
                    cSourceName('macho', known.name)
                  : known?.name) ??
                `sub_${tail.target.value.toString(16)}`,
            );
          this.sourceNames.set(key, name);
          const arguments_ = tail.boundary.arguments.map((value) => {
            ids.push(value.id);
            return this.value(value);
          });
          if (tail.boundary.argument_list_complete === false)
            arguments_.push(
              this.call(
                arguments_.length ? 'unknown_argument_remainder' : 'unknown_arguments',
                'Unresolved trailing native tail-call arguments; observed prefix is retained, not a complete prototype.',
                [],
              ),
            );
          this.writer.helper(
            name,
            `Native tail transfer to ${this.writer.quote(key)} using observed ${this.input.source!.abi.id} storage. Preserve unknown target effects and forward its actual results. An absent observed result layout is unknown, not void.`,
          );
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
              this.call(
                'unknown_arguments',
                'The source argument list is unresolved, not empty. Known changed physical input bits remain in the tail-call boundary snapshot.',
                [],
              ),
              this.call(
                'unknown_calling_convention',
                'The target calling convention is not established; do not infer it from a discovered code address.',
                [],
              ),
              this.call(
                'unknown_results',
                'The target result interface is unresolved, not void. Propagate the actual tail-call result without guessing its width or type.',
                [],
              ),
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
      if (this.inlined.has(definition.result.id)) continue;
      this.context.checkpoint(1);
      const value = definition.result,
        expression = definition.expression;
      this.emitNotes(anchor, depth);
      const start = this.writer.offset;
      this.writer.statement(
        depth,
        `${this.local(value)} = ${this.assigned(value, this.expression(expression, value.type))}`,
      );
      this.mapped(this.dataOrigin(anchor), start, [value.id]);
    }
  }

  private propagateLoopExit(scope: string, depth: number): void {
    for (const loop of this.exitGuards.get(scope) ?? []) {
      const flag = this.exitFlags.get(loop)!;
      const c = this.language === 'c-like';
      this.writer.line(depth, c ? `if (${flag}) {` : `if ${flag}:`);
      this.writer.statement(depth + 1, 'break');
      if (c) this.writer.line(depth, '}');
      const emitted = this.emittedExitGuards.get(scope) ?? new Set<string>();
      emitted.add(loop);
      this.emittedExitGuards.set(scope, emitted);
    }
  }

  private region(region: Region, depth: number): void {
    this.context.checkpoint(1);
    if (region.kind === 'sequence') {
      for (const child of region.regions) this.region(child, depth);
    } else if (region.kind === 'loop') {
      const form = region.form,
        c = this.language === 'c-like';
      const flag = this.exitFlags.get(region.header);
      if (flag) {
        this.writer.statement(depth, this.writer.declaration('uint8_t', flag, ' = 0'));
        this.initializedExitFlags.add(region.header);
      }
      // A while/for test prints its own header line from inside the body (its
      // block's control); a do-while test prints the closing `} while (...)` line.
      // A bottom-tested for prints its header here; its test was proven on entry.
      if (!form) this.writer.line(depth, c ? 'while (true) {' : 'while True:');
      else if (form.kind === 'do_while') this.writer.line(depth, 'do {');
      else if (form.kind === 'for' && form.bottom) {
        const control = this.controls.get(form.test),
          restated = this.rebased.get(form.test),
          header = this.forLoops.get(form.test);
        if (control?.kind !== 'if' || !restated || !header)
          this.invalid('A bottom-tested for loop lost its proven test');
        const start = this.writer.offset,
          test = this.expression(
            form.enter ? restated : { ...restated, op: NEGATED_PREDICATE[restated.op] },
            control.condition.type,
          ).text;
        this.writer.line(
          depth,
          `for (${this.hoistedText(header.init)}; ${test}; ${this.hoistedText(header.step)}) {`,
        );
        this.mapped(control, start, [control.condition.id]);
      }
      const lines = this.writer.codeLines;
      this.region(region.body, depth + 1);
      if (
        this.sourceView &&
        !c &&
        this.writer.codeLines - lines <= (form?.kind === 'while' ? 1 : 0)
      )
        this.writer.statement(depth + 1, 'pass');
      if (c && form?.kind !== 'do_while') this.writer.line(depth, '}');
      this.propagateLoopExit(region.header, depth);
    } else {
      this.emitNotes(region.id, depth);
      const start = this.writer.offset;
      // A duplicated tail is reached only lexically; its home keeps the label.
      if (this.labels.has(region.id) && !this.clones.has(region))
        this.writer.line(
          depth,
          this.language === 'c-like'
            ? `${this.identifier(region.id, 'label')}:;`
            : `label ${this.identifier(region.id, 'label')}:`,
        );
      this.sourceDefinitions(region.id, depth);
      for (const node of region.statements) {
        this.context.checkpoint(1);
        if (
          this.program.retained.has(node.id) &&
          !('result' in node && this.inlined.has(node.result.id))
        )
          this.instruction(node, depth);
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
    if (this.sourceView) {
      const scratch = new Set<string>();
      for (const boundary of this.program.returns.values())
        for (const { register } of boundary.exit_scratch ?? [])
          scratch.add(register.root.slice(register.root.lastIndexOf(':') + 1));
      if (scratch.size)
        w.comment(
          0,
          `ABI scratch at return: ${[...scratch].join(', ')}; exact slices and values retained in exit metadata, not additional results.`,
        );
    }
    for (const requirement of this.program.source?.requirements ?? []) {
      this.context.checkpoint(1);
      if (requirement.kind === 'fp_environment') {
        const start = w.offset;
        w.comment(
          0,
          `Requirement ${requirement.id} (${requirement.status}): ${this.fpPresentation.guards.size ? SOURCE_FP_ENVIRONMENT : requirement.explanation}`,
        );
        for (const site of requirement.sites) {
          const origin = this.origins.get(site.subject_ids[0]!);
          if (origin && this.fpPresentation.guards.has(origin.id)) {
            this.map(origin, start, site.subject_ids);
            const control = this.controls.get(origin.id);
            if (control?.kind === 'if') {
              const failure = site.supported_predicate_value
                ? control.when_false
                : control.when_true;
              const block = this.program.blocks.get(failure.transfer.target)!;
              this.map(block, start);
              this.map(block.control, start);
              for (const node of block.statements) this.map(node, start);
            }
          }
        }
      }
    }
    if (this.sourceView) {
      const renamed: string[] = [];
      for (const [id, spelling] of this.linkageNames)
        if (spelling && spelling !== this.names.get(id)) renamed.push(id);
      if (
        renamed.length &&
        !this.localValidation.presentation(
          'c_source_name',
          this.input.function.id,
          'native linkage names presented in their C spelling (Mach-O drops one leading underscore) without a generated prefix; identifiers[].original_name keeps each native name',
          renamed.slice(0, 64),
        )
      )
        this.linkageNames.clear();
    }
    const displayName = this.names.get(this.input.function.id);
    const functionName = this.program.source
      ? this.sourceIdentifier(
          this.input.function.id,
          this.sourceView
            ? (this.presentedName(this.input.function.id) ?? 'fn_function')
            : `fn_${displayName ?? 'function'}`,
        )
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
              ? (this.sourceRoleNames.get(value.id) ?? `arg${i}`)
              : (this.program.source.parameter_names.get(value.id) ?? source?.name ?? `arg${i}`),
          )
        : this.identifier(value.id, source ? 'arg' : register ? 'reg' : 'arg');
      const type = source ? this.sourceType(source.type_id) : this.valueType(value);
      this.declaredTypes.set(value.id, type);
      parameters.push({ value, type, name });
    }
    let hasTailCall = false;
    for (const block of this.program.blocks.values()) {
      this.context.checkpoint(1);
      if (block.control.kind === 'indirect' && block.control.tail_call) hasTailCall = true;
    }
    let returnType = signature
      ? this.sourceType(signature.signature.return_type)
      : this.program.source
        ? this.program.source.return_source_type
          ? this.sourceType(this.program.source.return_source_type)
          : this.program.source.return_pointer
            ? this.language === 'c-like'
              ? `${this.program.source.return_pointer === 'char' ? 'char' : 'uint8_t'} *`
              : `pointer[${this.program.source.return_pointer === 'char' ? 'char' : 'uint8_t'}]`
            : this.program.source.return_types?.length
              ? this.language === 'c-like'
                ? `tuple<${w.join(this.program.source.return_types.map((type) => this.dataType(type)))}>`
                : `tuple[${w.join(this.program.source.return_types.map((type) => this.dataType(type)))}]`
              : this.program.source.return_type
                ? this.dataType(this.program.source.return_type)
                : hasTailCall
                  ? 'unknown_result'
                  : 'void'
        : 'physical_result';
    const scalar = this.sourceView && this.program.source?.return_scalar;
    if (scalar) returnType = `${scalar.signed ? 'int' : 'uint'}${scalar.bits}_t`;
    const floating = this.sourceView && this.program.source?.return_float;
    if (floating) returnType = floating === 32 ? 'float' : 'double';
    this.returnSpelling = returnType;
    if (this.sourceView && this.language === 'c-like') declareCScalarSupport(this.program, w);
    if (this.sourceView && this.language === 'c-like') {
      const typeIds: string[] = [];
      const resultType =
        signature?.signature.return_type ?? this.program.source?.return_source_type;
      if (resultType) typeIds.push(resultType);
      for (const parameter of signature?.signature.parameters ?? [])
        typeIds.push(parameter.type_id);
      for (const projection of this.program.calls.values()) {
        this.context.checkpoint(1);
        if (!projection.signature) continue;
        typeIds.push(projection.signature.signature.return_type);
        for (const parameter of projection.signature.signature.parameters)
          typeIds.push(parameter.type_id);
      }
      for (const value of this.program.values.values()) {
        this.context.checkpoint(1);
        const id =
          this.sourceValueTypes.get(value.id) ??
          this.program.source?.value_types?.get(value.id)?.type_id;
        if (id) typeIds.push(id);
      }
      this.structDeclarations(typeIds);
    }
    this.declareDataTables();
    this.declareSourceCallees();
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
      const name = this.sourceIdentifier(
          local.id,
          this.names.get(local.id) ??
            this.sourceRoleNames.get(local.id) ??
            (local.stack_offset !== undefined
              ? `local_${(-local.stack_offset).toString(16)}`
              : `local${this.sourceLocal++}`),
        ),
        start = w.offset;
      w.statement(1, w.declaration(this.dataType(local.type), name));
      this.mapped(this.dataOrigin(node), start, [node]);
    }
    for (const value of this.program.values.values()) {
      this.context.checkpoint(1);
      if (
        !this.program.live.has(value.id) ||
        this.inline.has(value.id) ||
        formals.has(value.id) ||
        this.program.source?.stack_addresses.has(value.id)
      )
        continue;
      const start = w.offset,
        spelling = this.valueType(value),
        representative = this.variables.get(value.id);
      this.declaredTypes.set(value.id, spelling);
      // A coalesced phi class is declared once, as its representative.
      if (representative && representative.id !== value.id) continue;
      w.statement(1, w.declaration(spelling, this.local(value)));
      this.mapped(this.dataOrigin(value.id), start, [value.id]);
      this.emitNotes(value.id, 1);
    }
    this.region(this.body, 1);
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
    validateRenderedTransfers(
      { ...this.input.function, body: this.body },
      this.gotos,
      this.language,
      this.context,
      this.fallthrough,
      this.emittedEdges,
      { initialized: this.initializedExitFlags, guards: this.emittedExitGuards },
    );
    validateEmittedControl(
      { ...this.input.function, body: this.body },
      this.emittedEdges,
      this.language,
      this.localValidation,
      { initialized: this.initializedExitFlags, guards: this.emittedExitGuards },
    );
    for (const record of this.localValidation.records)
      if (record.kind === 'control' && record.status === 'rejected')
        rejectTranslation(record, this.controls.get(record.subject) ?? this.input.function);
    const requirements = sourceRequirementProofs(
      this.program,
      w.mappings,
      { ids: w.ids.items, ranges: w.ranges.items },
      this.context,
      abiConformanceRequirements(
        this.input.function.id,
        this.localValidation.abiConformance,
        (id) => this.origins.get(id),
        this.context,
      ),
    ).map((record) =>
      w.requirement(
        this.fpPresentation.guards.size && record.kind === 'fp_environment'
          ? { ...record, explanation: SOURCE_FP_ENVIRONMENT }
          : record,
      ),
    );
    const inferences = collectInferences(
      this.input,
      this.program,
      this.localValidation.records,
      w,
      this.context,
      this.inferenceSites,
      this.sourceDataValue,
    );
    const declarationSpan = { start: this.headerStart, end: this.headerEnd };
    const review = {
      operation: 'function_get',
      view: 'metadata',
      function_id: this.input.function.id,
    } as const;
    w.charge({ declarationSpan, review });
    return {
      emission: {
        language: this.language,
        emitter_version: this.version,
        text: w.text(),
        span_unit: 'utf16',
        reconstruction: 'pseudocode',
        ids: w.ids.items,
        evidence: w.proofs.items,
        ranges: w.ranges.items,
        mappings: w.mappings,
        declaration_span: declarationSpan,
        helpers: w.helpers,
        local_validation: this.localValidation.records,
        inferences,
        requirements,
        review,
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
