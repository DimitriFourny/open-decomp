import type { VariableType } from '../metadata/library-contracts/variables.js';
import {
  fingerprint,
  MAX_RESULT_DIAGNOSTICS,
  omittedDiagnosticsSummary,
  OperationError,
  type Address,
  type Annotation,
  type CallClobbers,
  type Diagnostic,
  type Emitter,
  type EmissionOmission,
  type EmissionRequirement,
  type Inference,
  type OperationContext,
  type RegisterDescriptor,
  type Requirement,
} from '../core/index.js';
import {
  bitWidth,
  expressionOperands,
  integer,
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
import { foldSourceCondition } from '../reconstruction/source-conditions.js';
import { constantRotationOperands } from '../reconstruction/source-shifts.js';
import type {
  ObjCMessage,
  SourceAddress,
  SourceFormalType,
} from '../reconstruction/source-model.js';
import { selectorArity } from '../metadata/runtime/objc-types.js';
import { objcMessageText, objcStringLiteral } from './objc.js';
import { sourceDataValues } from '../reconstruction/source-data.js';
import {
  sourceFpPresentation,
  SOURCE_FP_ENVIRONMENT,
  type SourceFpPresentation,
} from '../reconstruction/source-fp.js';
import { indexedDataAccesses, type IndexedDataAccess } from './source-tables.js';
import {
  planGlobals,
  type GlobalAccess,
  type GlobalObject,
  type GlobalPlan,
} from './source-globals.js';
import { cScalarSupport } from './source-c-support.js';
import { UnsignedBounds } from './source-bounds.js';
import { characterEvidence } from './source-characters.js';
import { stringLiteral, STRING_LITERAL_LIMIT } from './string-literals.js';
import { cSourceName } from '../metadata/symbols/c-names.js';
import {
  findDeclarationByPath,
  type CatalogEntry,
  type TypeSpec,
} from '../metadata/library-contracts/catalog.js';
import {
  planSourceNames,
  sourceGenericStems,
  sourceIdentifierStem,
  sourceRoleStems,
} from '../reconstruction/source-names.js';
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
  finiteFloatBits,
  integerStorageBits,
  pointerAssignable,
  usualArithmetic,
  type IntegerCType,
  type Printed,
  type SimplificationRecorder,
} from './expressions.js';
import { MetadataLimitError, Writer } from './writer.js';
import type { EmissionInput, EmissionResult } from './model.js';
import { collectInferences } from './inference.js';
import {
  VariableLiveness,
  coalesceValues,
  coalescePhiCopies,
  controlArms,
  formArm,
  foldSwitchGuards,
  planLayout,
  planBreakableBlocks,
  planSharedArms,
  planLoopForms,
  planLoopExits,
  visitTransfers,
  firstBlock,
  type LoopExitRoute,
  transferAction,
  type LoopFacts,
  type TransferAction,
  type LayoutPlan,
  type Occurrence,
  occurrenceAction,
} from './source-control.js';
import {
  planSourceInlining,
  type InlineCall,
  type InlineCallSite,
  type InlineStore,
  type InlineSite,
} from './source-inlining.js';
import { memberName, paddingName, SourceStructs, type ObservedMember } from './source-structs.js';
import { planFlagTests, type FlagTest } from './source-flags.js';
import { planLocalTypes, type Fact, type PointerFact } from './source-local-types.js';

type Options = Parameters<Emitter<EmissionInput>['emit']>[1];
/** Objective-C selector syntax: `name`, or keyword parts each ending in `:`. */
const OBJC_SELECTOR = /^(?:[A-Za-z_$][\w$]*|(?:[A-Za-z_$][\w$]*)?:(?:(?:[A-Za-z_$][\w$]*)?:)*)$/;
/** Element kind of a declared scalar pointer: integer or IEEE. */
type PointeeKind = Extract<SourceFormalType, { kind: 'pointer' }>['pointee'];
type Nest =
  | {
      readonly kind: 'loop';
      readonly header: string;
      readonly follow: string | null;
      readonly once?: true;
    }
  | { readonly kind: 'switch'; readonly id: string };
/** One test of a merged `if` chain: its printed form and the value it tests. */
interface ConditionTerm {
  readonly printed: Printed;
  readonly value: Value;
  readonly positive: boolean;
  /** `value` is not the printed test (a flag-carried short circuit): never fold it. */
  readonly opaque?: true;
}
/** A table's contents print in full up to this many bytes; larger tables show
 * a prefix of TABLE_PREFIX_BYTES, and an unsized one with unbounded indices
 * its first TABLE_UNKNOWN_ELEMENTS elements. */
const TABLE_FULL_BYTES = 512n;
const TABLE_PREFIX_BYTES = 256;
const TABLE_UNKNOWN_ELEMENTS = 16;
const STRING_LITERAL_SCOPE =
  'pointer-width constants addressing an immutable NUL-terminated string with established encoding (an interior address denotes its suffix bytes), printed as that string literal where the constant is a value: argument, store, return, copy, select arm or identity comparison';

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

/** Held single-use calls (result value ids) were not printed at their reader:
 * render again with those calls printed as statements. */
export class CallInliningRetry extends Error {
  constructor(readonly results: readonly string[]) {
    super('call inlining retry');
  }
}

/** Only syntax lives here: both dialects consume the same reconstructed program. */
export class Renderer {
  private readonly writer: Writer;
  private readonly program: Reconstruction;
  private readonly names = new Map<string, string | null>();
  private readonly identifiers = new Map<string, EmissionResult['identifiers'][number]>();
  private readonly diagnostics: Diagnostic[] = [];
  /** Diagnostics and citations beyond the wire list bound, counted for the summary. */
  private readonly shedDiagnostics = new Map<Diagnostic['code'], number>();
  private shedCitations = 0;
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
  /** Source view: constants an owned copy of a return tail receives on its one
   * edge, by the block parameter they would be copied into (see planReturnConstants). */
  private readonly returnConstants = new Map<BlockRegion, Map<string, Value>>();
  /** The edge copies those constants replace, by destination value id. */
  private readonly forwardedCopies = new Map<ParallelTransfer, Set<string>>();
  /** Block parameters no printed edge writes and no printed return reads. */
  private readonly vanished = new Set<string>();
  /** Block parameters read as these constants while a return prints (see planReturnConstants). */
  private substituted: ReadonlyMap<string, Value> | null = null;
  /** Loop-test arms whose action the loop syntax itself performs. */
  private readonly consumed = new Set<ParallelTransfer>();
  private readonly fallthrough = new Set<ParallelTransfer>();
  private readonly loopTests = new Map<string, LoopForm>();
  private clones: ReadonlySet<BlockRegion> = new Set();
  private loopExits: ReadonlyMap<ParallelTransfer, LoopExitRoute> = new Map();
  private normalizeLoopTargets = false;
  private readonly exitFlags = new Map<string, string>();
  private readonly bounds: UnsignedBounds;
  private readonly exitGuards = new Map<string, Set<string>>();
  private readonly emittedExitGuards = new Map<string, Set<string>>();
  private readonly initializedExitFlags = new Set<string>();
  /** Coalesced phi copies: value id -> representative printed variable. */
  private variables: ReadonlyMap<string, Value> = new Map();
  private readonly inline: Set<string>;
  private readonly inlined = new Map<string, InlineSite>();
  private readonly inlineSites = new Map<string, InlineSite[]>();
  /** Stores to private locals printed right after their reader statement, by reader id. */
  private readonly deferred = new Map<string, InlineStore[]>();
  private readonly deferredStores = new Set<string>();
  /** Calls printed as an operand of their single reader, by result value id. */
  private readonly inlinedCalls = new Map<string, InlineCallSite>();
  /** Code lines printed when the latest inlined call was held. */
  private heldLines = 0;
  private readonly inlinedCallSites = new Map<string, InlineCallSite[]>();
  /** Printed text of an inlined call between its original position and its reader. */
  private readonly pendingCalls = new Map<string, string>();
  /** The reader printing held calls, until its first code line is checked. */
  private openReader: { readonly start: number; readonly held: InlineCallSite[] } | null = null;
  private liveness: VariableLiveness | null = null;
  /** Do-while tests restated over the values written by their repeat copies. */
  private readonly rebased = new Map<string, Extract<Expression, { kind: 'compare' }>>();
  private readonly synthetic = new Map<string, Expression>();
  /** Exit edges of loop tests whose copies print after their loop, by test id. */
  private readonly loopExitCopies = new Map<string, ParallelTransfer>();
  /** Tests of enclosing `if`s merged into the next printed `if` (nestedIf). */
  private conjunct: readonly ConditionTerm[] | undefined;
  /** Operands of a shared-arm condition printed so far (see planSharedArms). */
  private sharedPlan:
    | {
        readonly arm: ControlArm;
        readonly origin: Control;
        readonly form: 'all' | 'any';
        readonly terms: readonly ConditionTerm[];
      }
    | undefined;
  /** Flag-carried short-circuit tests by merge control id (planFlagTests). */
  private readonly flagTests = new Map<string, FlagTest>();
  /** Their stage controls (printed inside the merge test). */
  private readonly flagStages = new Set<string>();
  /** Their head blocks, by block id. */
  private readonly flagHeads = new Map<string, FlagTest>();
  /** Range-guard `if` controls printed as their proven switch, by switch control id. */
  private readonly foldedGuards = new Map<string, Control>();
  /** Flag stores and loads, printed only as the merge test. */
  private readonly flagAccesses = new Set<string>();
  /** Edge copies printed in a `for` header (by destination variable), not at their edge. */
  private readonly hoisted = new Map<ParallelTransfer, ReadonlySet<string>>();
  /** `for` header edges keyed by the loop test control. */
  private readonly forLoops = new Map<
    string,
    { readonly init: ParallelTransfer; readonly step: ParallelTransfer }
  >();
  private readonly typeRecords = new Map<string, SuppliedTypeRecord | null>();
  private readonly libraryDeclarations = new Map<string, readonly CatalogEntry[]>();
  private readonly callParameterSpellings = new Map<string, string | null>();
  /** C integer type of each printed struct-member lvalue, by its text. */
  private readonly memberTypes = new Map<string, IntegerCType>();
  /** Offsets of each structure's members this function's text accesses, by structure name. */
  private readonly usedMembers = new Map<string, Set<bigint>>();
  /** Where the structure bodies are inserted once the accessed members are known. */
  private structureSlot: { readonly at: number; readonly ids: readonly string[] } | null = null;
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
  /** Source view: values holding one character code (see source-characters.ts). */
  private characters: ReadonlySet<string> = new Set();
  private readonly sourceDataValue: (value: Value) => SourceAddress | undefined;
  private readonly dataTables = new Map<string, IndexedDataAccess & { readonly name: string }>();
  private indexedData: ReadonlyMap<string, IndexedDataAccess> = new Map();
  private readonly globals: GlobalPlan;
  private readonly usedGlobals = new Map<
    string,
    { readonly object: GlobalObject; readonly name: string }
  >();
  private readonly sourceValueTypes = new Map<string, string>();
  /** Single call results, by result value id (their library return spelling). */
  private readonly callResults = new Map<string, BoundaryProjection>();
  /** Pointer spellings chosen for locals from their definitions and uses. */
  private readonly localSpellings = new Map<string, string>();
  /** Load/store nodes accessing a declared pointer member: that pointer type. */
  private readonly memberPointers = new Map<string, string>();
  private readonly sourceRoleNames: ReadonlyMap<string, string | null>;
  /** Loop header phis: each is its own loop-carried variable (see planSourceNames). */
  private readonly sourceCarried: ReadonlySet<string>;
  /** Initial value -> the loop header phi it enters (see planSourceNames). */
  private readonly sourceInitial: ReadonlyMap<string, string>;
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
    /** Call results never printed as their reader's operand; null: no call is. */
    private readonly rejectedCalls: ReadonlySet<string> | null = new Set(),
    private readonly metadata: 'full' | 'omitted' = 'full',
  ) {
    this.writer = new Writer(context, options.indent, options.include_evidence, language, metadata);
    this.program = reconstruct(input, context, options.view === 'checked' ? 'checked' : 'source');
    this.inline = new Set(this.program.inline);
    this.bounds = new UnsignedBounds(this.program.expressions, context);
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
      new Map((input.types?.image_types ?? []).map((binding) => [binding.type_id, binding])),
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
    const plan = planSourceNames(this.program, this.names, input.types, context, this.sourceView);
    this.sourceRoleNames = plan.names;
    this.sourceCarried = plan.carried;
    this.sourceInitial = plan.initial;
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
    if (this.sourceView)
      for (const proof of input.types?.evidence ?? []) {
        context.checkpoint(1);
        if (proof.origin.kind === 'library') {
          const found = findDeclarationByPath(proof.origin.contract, proof.origin.library);
          if (found.length) this.libraryDeclarations.set(proof.id, found);
        }
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
    this.globals = planGlobals(this.program, context, {
      data: this.sourceDataValue,
      uncast: (value) => this.bitcastSource(value),
      access_type: (node) => this.accessType(node),
      pretty: this.sourceView && this.program.source !== undefined,
      pointer_bits: this.input.source?.abi.layout.pointer_bits,
      abi: this.input.source?.abi,
    });
    for (const projection of this.program.calls.values()) {
      if (!projection.signature) continue;
      const declaration = projection.signature.signature;
      if (projection.results.length === 1) {
        this.sourceValueTypes.set(projection.results[0]!.id, declaration.return_type);
        this.callResults.set(projection.results[0]!.id, projection);
      }
    }
    if (this.sourceView) {
      this.stridedPointerTypes();
      this.characters = characterEvidence(this.program, context, {
        bytePointer: (id) => this.bytePointerType(id),
      }).values;
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
    // The wire list holds one entry less than its bound: the last is the omission summary.
    if (this.diagnostics.length >= MAX_RESULT_DIAGNOSTICS - 1) {
      this.shedDiagnostics.set(
        diagnostic.code,
        (this.shedDiagnostics.get(diagnostic.code) ?? 0) + 1,
      );
      return;
    }
    if (diagnostic.evidence_ids.length > 1000) {
      this.shedCitations += diagnostic.evidence_ids.length - 1000;
      diagnostic = { ...diagnostic, evidence_ids: diagnostic.evidence_ids.slice(0, 1000) };
    }
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

  private sourceIdentifier(id: string, preferred: string, linkage = false): string {
    const previous = this.identifiers.get(id);
    if (previous) return previous.identifier;
    const stack = this.program.source?.stack;
    const entryStack =
      (stack?.kind === 'entry' && stack.base.id === id) ||
      this.program.parameter_registers.get(id)?.role === 'stack_pointer';
    const stem = entryStack ? 'entry_sp' : sourceIdentifierStem(preferred, linkage);
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

  private classRoles: {
    readonly for: ReadonlyMap<string, Value>;
    readonly names: Map<string, string | null>;
  } | null = null;

  /** Role-derived name of the printed variable `value` represents. A coalesced
   * phi class takes a role name only when exactly one role names its members and
   * every other member is that same variable: not a loop header phi (each is a
   * loop-carried variable needing its own proof), and either the initial value
   * (never a parameter's) of a header phi of the class that has the role, a merge of only class
   * members and constants, or a conversion of a member; generic if named at
   * all. A class that also holds any other value is not that role and stays
   * neutral. Without a role, every named member must agree. Undefined when no
   * member has a name. */
  private classRoleName(value: Value): string | null | undefined {
    if (!this.sourceView) return this.sourceRoleNames.get(value.id);
    if (this.classRoles?.for !== this.variables) {
      const names = new Map<string, string | null>(),
        classes = new Map<string, string[]>();
      for (const [id, representative] of this.variables) {
        const row = classes.get(representative.id) ?? [];
        row.push(id);
        classes.set(representative.id, row);
      }
      const merged = new Map<string, Value[]>();
      for (const copies of this.program.transfers.values())
        for (const copy of copies) {
          const row = merged.get(copy.destination.id) ?? [];
          row.push(copy.source);
          merged.set(copy.destination.id, row);
        }
      /** Operand of a value-preserving conversion. */
      const converted = (value: Value): Value | undefined => {
        const expression = this.program.expressions.get(value.id);
        return (expression?.kind === 'cast' &&
          ['bitcast', 'truncate', 'zero_extend', 'sign_extend'].includes(expression.op)) ||
          (expression?.kind === 'extract' && expression.offset === 0)
          ? expression.value
          : undefined;
      };
      const parameterIds = new Set(this.program.parameters.map((parameter) => parameter.id));
      /** True when `input` is a parameter or, through conversions, one's operand. */
      const fromParameter = (input: Value): boolean => {
        const seen = new Set<string>();
        for (let value: Value | undefined = input; value && !seen.has(value.id);) {
          this.context.checkpoint(1);
          seen.add(value.id);
          if (parameterIds.has(value.id)) return true;
          value = converted(value);
        }
        return false;
      };
      /** True when `input` is a constant or, through conversions, a member of the
       * class `representative` names. */
      const same = (input: Value, representative: string): boolean => {
        const seen = new Set<string>();
        for (let value: Value | undefined = input; value && !seen.has(value.id);) {
          this.context.checkpoint(1);
          seen.add(value.id);
          if (
            this.variables.get(value.id)?.id === representative ||
            this.program.expressions.get(value.id)?.kind === 'constant'
          )
            return true;
          value = converted(value);
        }
        return false;
      };
      for (const [representative, members] of classes) {
        this.context.checkpoint(members.length);
        const own = members.map((id) => this.sourceRoleNames.get(id));
        const roles = new Set(own.filter((name) => name && sourceRoleStems.has(name)));
        if (roles.size > 1 || own.includes(null)) names.set(representative, null);
        else if (roles.size === 1) {
          const role = [...roles][0]!;
          const variable = members.every((id, index) => {
            const name = own[index];
            if (name === role) return true;
            if ((name && !sourceGenericStems.has(name)) || this.sourceCarried.has(id)) return false;
            // The initial value of a loop variable shares its role, except that of
            // a parameter (or a conversion of one): what a caller passes is not
            // an index or accumulator because the body then steps or folds it.
            const head = this.sourceInitial.get(id);
            if (
              head !== undefined &&
              this.variables.get(head)?.id === representative &&
              this.sourceRoleNames.get(head) === role &&
              !fromParameter(this.program.values.get(id)!)
            )
              return true;
            const sources = merged.get(id),
              operand = converted(this.program.values.get(id)!);
            return sources
              ? sources.every((source) => same(source, representative))
              : operand !== undefined && same(operand, representative);
          });
          names.set(representative, variable ? role : null);
        } else {
          const named = new Set(own.filter((name) => name !== undefined));
          if (named.size) names.set(representative, named.size === 1 ? [...named][0]! : null);
        }
      }
      this.classRoles = { for: this.variables, names };
    }
    return this.classRoles.names.has(value.id)
      ? this.classRoles.names.get(value.id)
      : this.sourceRoleNames.get(value.id);
  }

  private local(value: Value): string {
    const pending = this.pendingCalls.get(value.id);
    if (pending !== undefined) return pending;
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
              this.classRoleName(value) ??
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
    if (formal) return this.formalSpelling(formal);
    const local = this.localSpellings.get(value.id);
    if (local !== undefined) return local;
    const call = this.callResults.get(value.id);
    if (call && source === call.signature?.signature.return_type) {
      const spelling = this.callResultSpelling(call);
      if (spelling !== undefined) return spelling;
    }
    if (source) return this.sourceType(source);
    return this.dataType(value.type);
  }

  /** Source spelling of an inferred formal or typed promoted-slot type. */
  private formalSpelling(formal: SourceFormalType): string {
    if (formal.kind === 'integer') return `${formal.signed ? 'int' : 'uint'}${formal.bits}_t`;
    const element =
      formal.pointee === 'float'
        ? formal.pointee_bits === 32
          ? 'float'
          : 'double'
        : `uint${formal.pointee_bits}_t`;
    return this.language === 'c-like'
      ? `${formal.const ? 'const ' : ''}${element}*`
      : `pointer[${element}]`;
  }

  /** Proven pointer type of the promoted slot a load/store node accesses. */
  private slotType(node: string): SourceFormalType | undefined {
    const local = this.sourceView ? this.program.source?.locals.get(node) : undefined;
    return local && this.program.source?.local_types?.get(local.id);
  }

  /** Bit width of the `fp_slot_type` float local a load/store node accesses. */
  private floatSlot(node: string): 32 | 64 | undefined {
    const local = this.sourceView ? this.program.source?.locals.get(node) : undefined;
    return local && this.program.source?.float_locals?.get(local.id);
  }

  /** Source element type of a memory access: IEEE for an `fp_memory_access`
   * (whose integer value is a `float_values` member), else the machine type. */
  private accessType(node: Extract<Instruction, { kind: 'load' | 'store' }>): DataType {
    const value = node.kind === 'load' ? node.result : node.value;
    const bits =
      this.sourceView && this.program.source?.float_accesses?.has(node.id)
        ? this.program.source.float_values?.get(value.id)
        : undefined;
    return bits ? { kind: 'float', bits } : value.type;
  }

  /** C pointer spelling of a value proven to be of a typed slot's pointer kind:
   * a declared pointer, a typed-slot reload or a whole-element constant step. */
  private pointerText(value: Value, formal: SourceFormalType, depth = 0): string | null {
    if (formal.kind !== 'pointer' || depth > 16) return null;
    value = this.uncast(value, ['bitcast']);
    const load = this.inlined.get(value.id)?.node;
    if (load?.kind === 'load' && this.slotType(load.id)) return this.storage(load);
    if (!this.inline.has(value.id))
      return this.declaredSpelling(value).replace(/^const /, '') ===
        this.formalSpelling(formal).replace(/^const /, '')
        ? this.local(value)
        : null;
    const expression = this.program.expressions.get(value.id);
    if (expression?.kind !== 'integer' || (expression.op !== 'add' && expression.op !== 'sub'))
      return null;
    const right = this.constantOf(expression.right),
      left = expression.op === 'add' ? this.constantOf(expression.left) : undefined;
    const [base, bytes] = right !== undefined ? [expression.left, right] : [expression.right, left];
    if (bytes === undefined || value.type.kind !== 'integer') return null;
    const text = this.pointerText(base, formal, depth + 1);
    const displacement =
      BigInt.asIntN(value.type.bits, bytes) * (expression.op === 'sub' ? -1n : 1n);
    const size = BigInt(formal.pointee_bits / 8);
    if (text === null || displacement % size !== 0n) return null;
    const count = displacement / size;
    return count === 0n ? text : `${text} ${count < 0n ? '-' : '+'} ${count < 0n ? -count : count}`;
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
    return (this.printerCache ??= new SourcePrinter(
      this.writer,
      this.nativeIntegerStorage,
      this.recorder,
    ));
  }
  /** Source view only: every exact printer simplification leaves a presentation
   * record; the checked view never simplifies. */
  private recorderCache?: SimplificationRecorder;
  private get recorder(): SimplificationRecorder | undefined {
    return this.sourceView
      ? (this.recorderCache ??= (rule, scope, subjects) =>
          subjects?.length
            ? this.localValidation.presentation(rule, subjects[0]!, scope, subjects)
            : this.localValidation.presentation(rule, this.input.function.id, scope))
      : undefined;
  }
  /** Exact declared spelling of each formal/local, recorded where declared. */
  private readonly declaredTypes = new Map<string, string>();
  /** Declared function result type spelling (set before the body prints). */
  private returnSpelling = '';
  /** Source view: the function's lexically last block when it is a bare `return`
   * of no value, which falling off the end of the function expresses unprinted. */
  private fallOffBlock: BlockRegion | null = null;

  /** The block whose `return` ends the printed function: the last block of the
   * top-level sequence. A void `return` there is the end of the function body. */
  private fallOffReturn(region: Region): BlockRegion | null {
    for (;;) {
      this.context.checkpoint(1);
      if (region.kind === 'loop') return null;
      if (region.kind === 'block') return region.control.kind === 'return' ? region : null;
      const last = region.regions.at(-1);
      if (!last) return null;
      region = last;
    }
  }

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
    value = this.substituted?.get(value.id) ?? value;
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
          {
            view: 'source',
            source: { address: (address) => this.addressPrinted(address) },
            ...(this.recorder ? { presentation: this.recorder } : {}),
          },
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
    const given = id;
    id ??=
      this.sourceValueTypes.get(value.id) ??
      this.program.source.value_types?.get(value.id)?.type_id;
    const type = id && this.typeRecords.get(id)?.definition;
    const spelled = given === undefined ? this.localSpellings.get(value.id) : undefined;
    if (!type && spelled !== undefined && value.type.kind === 'integer') {
      // A local that only a pointer spelling types (no type record): same
      // conversion of the exact address bits.
      if (this.language === 'python-like')
        return printed.ctype && !printed.ctype.signed && printed.ctype.bits <= value.type.bits
          ? printed
          : this.printer.reduce(value.type.bits, printed);
      const text = this.pointerValue(printed, spelled);
      return {
        text,
        precedence: text === printed.pointer?.text ? PRIMARY : UNARY,
        ctype: null,
      };
    }
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
      // Integer-to-pointer conversion of the exact address bits (a declared
      // pointer of the receiving type converts implicitly; a narrower integer goes
      // through uintptr_t, no implicit widening warning). A local with its own
      // inferred spelling (`char *`, `FILE *`) casts to that spelling.
      const declared = given === undefined ? this.declaredSpelling(value) : undefined;
      const spelling = declared?.endsWith('*') ? declared : this.sourceType(id!);
      const text = this.pointerValue(printed, spelling);
      return {
        text,
        precedence: text === printed.pointer?.text ? PRIMARY : UNARY,
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

  /** C type of the scalar a source load reads through `storage`: a struct
   * member's declared integer type, a declared scalar pointer's pointee, or the
   * unsigned integer of the access width. Unknown for another member path. */
  private loadCType(
    load: Extract<Instruction, { kind: 'load' }>,
    storage: string,
  ): IntegerCType | null {
    const member = this.memberTypes.get(storage);
    if (member) return member;
    if (storage.includes('->')) return null;
    const id =
      this.sourceValueTypes.get(load.address.id) ??
      this.program.source?.value_types?.get(load.address.id)?.type_id;
    const pointee = id && !this.inline.has(load.address.id) ? this.scalarPointee(id) : null;
    return pointee ?? { bits: bitWidth(load.result.type), signed: false };
  }

  /** Byte size of the scalar a declared source pointer type points to. */
  private scalarPointee(id: string): IntegerCType | null {
    const pointer = this.typeRecords.get(id)?.definition;
    if (pointer?.kind !== 'pointer') return null;
    if (this.byteAddress(pointer.to)) return { bits: 8, signed: false };
    const target = this.naturalScalar(pointer.to) ?? pointer.to;
    const type = this.typeRecords.get(target)?.definition;
    return type?.kind === 'integer' && type.bits % 8 === 0 && type.bits <= 64
      ? { bits: type.bits, signed: type.signed }
      : null;
  }

  /** `p = p + index * size + k` on the same declared scalar pointer type prints
   * as C pointer arithmetic `p + index + k/size` when the index is scaled by
   * exactly the element size and the byte displacement k is a multiple of it;
   * C scales by exactly that size, so the address bits agree. */
  private pointerStep(id: string, expression: Expression, bits: number): Printed | null {
    const element = this.scalarPointee(id);
    if (
      expression.kind !== 'integer' ||
      (expression.op !== 'add' && expression.op !== 'sub') ||
      !element
    )
      return null;
    const size = BigInt(element.bits / 8);
    const sum = this.addressSum(expression, bits, size, (value) => {
      const baseType =
        this.sourceValueTypes.get(value.id) ??
        this.program.source?.value_types?.get(value.id)?.type_id;
      return (
        !this.inline.has(value.id) &&
        !!baseType &&
        this.sourceType(baseType) === this.sourceType(id)
      );
    });
    if (
      !sum ||
      sum.displacement % size !== 0n ||
      (sum.index && this.declaredSpelling(sum.index).endsWith('*')) ||
      !this.localValidation.presentation(
        'scaled_pointer_arithmetic',
        this.input.function.id,
        'typed pointer update; an index is scaled by exactly the element size and the byte displacement is an exact multiple of it',
      )
    )
      return null;
    let result = this.printer.primary(this.local(sum.base));
    if (sum.index) {
      const index = this.printed(sum.index);
      result = this.printer.binary('+', result, index.widened ?? index, null);
    }
    const count = sum.displacement / size;
    return count === 0n
      ? result
      : this.printer.binary(
          count < 0n ? '-' : '+',
          result,
          this.printer.literal(count < 0n ? -count : count, 64),
          null,
        );
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
      type.kind === 'float' &&
      expression.kind === 'cast' &&
      expression.op === 'bitcast'
    ) {
      const constant = this.program.expressions.get(expression.value.id);
      if (
        constant?.kind === 'constant' &&
        this.fpPresentation.expressions.has(constant) &&
        finiteFloatBits(constant.bits, type.bits)
      )
        return this.expression(constant, type);
    }
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
      const slotLoad = pointer && this.inlined.get(pointer.id)?.node;
      const name = !pointer
        ? null
        : slotLoad?.kind === 'load' && this.slotType(slotLoad.id)
          ? this.storage(slotLoad)
          : !this.inline.has(pointer.id) && this.declaredPointer(pointer)
            ? this.local(pointer)
            : null;
      if (
        pointer &&
        name !== null &&
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
          this.printer.primary(name),
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
      ...(this.sourceView
        ? { character: (value: Value) => this.characters.has(value.id), literal: this.valueLiteral }
        : {}),
      maximum: (value: Value) => this.bounds.maximum(value),
      nativeIntegerStorage: this.nativeIntegerStorage,
      ...(this.recorder ? { presentation: this.recorder } : {}),
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

  /** C only: `value` where a pointer of C type `spelling` is wanted. A declared
   * pointer variable passes as itself when C converts it implicitly (the same
   * type, `void *`, or added `const`) and through one pointer cast otherwise; an
   * address of exactly pointer width converts directly, any other width first
   * to `uintptr_t`. */
  private pointerValue(value: Printed, spelling: string): string {
    const pointer = value.pointer;
    if (pointer)
      return pointerAssignable(pointer.type, spelling)
        ? pointer.text
        : `(${spelling})${pointer.text}`;
    const address =
      value.ctype?.bits === (this.input.source?.abi.layout.pointer_bits ?? 64)
        ? value
        : {
            text: `(uintptr_t)${this.printer.group(value, UNARY)}`,
            precedence: UNARY,
            ctype: null,
          };
    return `(${spelling})${this.printer.group(address, UNARY)}`;
  }

  /** C only: text of `value` where C converts it to the signed `bits`-bit type
   * (a prototyped argument, an assignment, a return): the signed operand of the
   * same-width unsigned reinterpretation that produced `value` is itself, and the
   * implicit conversion back to signed restores exactly its bits. */
  private signedContext(value: Printed, bits: number): string {
    const original = value.from?.operand;
    return this.sourceView &&
      !this.nativeIntegerStorage &&
      original?.ctype?.bits === bits &&
      original.ctype.signed &&
      value.from!.bits === bits &&
      value.ctype?.bits === bits &&
      !value.ctype.signed &&
      this.printer.simplify('signed_conversion_context')
      ? original.text
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
    const literal = this.sourceView
      ? this.valueLiteral(source, this.declaredSpelling(destination), false)
      : undefined;
    if (literal) return this.assignedText(destination, literal);
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
    const replacement = this.substituted?.get(value.id);
    if (replacement) value = replacement;
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
      const imported = this.globals.import_loads.get(load.id);
      if (imported) return this.importAddress(imported);
      if (this.expanding.has(value.id)) this.invalid('Cyclic inlined load');
      if (this.expanding.size >= 128 || ++this.expansionWork > this.context.budget.ir_nodes * 64)
        this.writer.fail('Reconstructed expression expansion exceeds its budget');
      this.expanding.add(value.id);
      const storage = this.storage(load);
      const member = this.memberPointers.get(load.id);
      if (
        this.language === 'c-like' &&
        (this.slotType(load.id) || member || this.typedPointerGlobal(load.id))
      ) {
        // A typed pointer slot read in integer context yields its address bits.
        this.expanding.delete(value.id);
        const slot = this.slotType(load.id),
          global = this.typedPointerGlobal(load.id);
        return {
          text: `(uintptr_t)${storage}`,
          precedence: UNARY,
          ctype: { bits: bitWidth(value.type), signed: false },
          pointer: {
            text: storage,
            type: member ? this.sourceType(member) : slot ? this.formalSpelling(slot) : global!.c,
          },
        };
      }
      if (this.sourceView && this.program.source?.float_accesses?.has(load.id)) {
        // A native float/double lvalue read is an IEEE value, not integer bits.
        this.expanding.delete(value.id);
        this.writer.guard(Buffer.byteLength(storage));
        return {
          text: storage,
          precedence: storage.startsWith('*') ? UNARY : PRIMARY,
          ctype: null,
        };
      }
      const type = this.loadCType(load, storage);
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
        ) {
          const narrow = this.printer.primary(name, declared);
          const wide = this.printer.cast(value.type.bits, false, narrow);
          // A narrower unsigned declaration zero-extends: consumers that keep
          // only its low bits may read the declared variable itself.
          return declared.bits < value.type.bits && !declared.signed
            ? { ...wide, widened: narrow }
            : wide;
        }
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
                pointer: { text: name, type: spelling },
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

  /** Whether the file prints `...` for an open argument list (see openArguments). */
  private ellipsisUsed = false;
  /** The open remainder of a call's argument list. The source view prints it as
   * `...` in both dialects (the file header states its meaning once); the checked
   * view keeps the named helper. Either way the helper stays in the metadata. */
  private openArguments(helper: string, explanation: string): string {
    if (!this.sourceView) return this.call(helper, explanation, []);
    this.writer.helper(helper, explanation);
    this.ellipsisUsed = true;
    return '...';
  }

  /** Whether a `likely`-mode guess prints a call with its argument list closed. */
  private likelyArgumentList(projection: BoundaryProjection): boolean {
    return this.sourceView && projection.likely?.applied === true;
  }
  private likelyUsed = false;
  private likelyTypeUsed = false;
  /** Whether a formal's printed type is a guess that `likely` mode applied. */
  private guessedFormal(value: Value): boolean {
    return (
      this.sourceView &&
      this.program.source?.likely_types?.parameters.get(value.id)?.applied === true &&
      this.program.source.value_types?.get(value.id)?.likely === true
    );
  }

  private guessedResult(): boolean {
    return (
      this.sourceView &&
      this.program.source?.likely_types?.result?.applied === true &&
      this.program.source.return_source_type === this.input.source?.likely_types?.pointer_type_id &&
      !this.program.signature
    );
  }

  /** Likely mode: a type that only a guess established (a formal or the result that
   * proven analysis left integer) prints inside `likely_type(...)` in both dialects, once
   * where it is declared; the file header states the meaning and the guess record in the
   * provenance names the heuristics and call sites. */
  private likelyType(text: string): string {
    this.likelyTypeUsed = true;
    return this.call(
      'likely_type',
      'Guessed, not proven: the wrapped type was chosen by an opt-in likely-mode heuristic from how the function callers use this formal or result (see the guess inference); proven analysis leaves it an integer. Values connected to it by copies inherit the type.',
      [text],
    );
  }

  /** Likely mode: a call whose open argument list was closed on a guess prints inside
   * `likely_arity(...)` in both dialects (the file header states its meaning once);
   * the guess record in the provenance names the heuristics. */
  private likelyCall(text: string): string {
    this.likelyUsed = true;
    return this.call(
      'likely_arity',
      'Guessed, not proven: the argument list of the wrapped call was closed after its observed prefix by an opt-in likely-mode heuristic (see the guess inference). More arguments may exist; the callee was not proven to read no others.',
      [text],
    );
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
    // Every contributor maps the same span. The caller's subject ids belong to
    // that span, so publish them once (with the primary origin) rather than
    // repeating them in each contributor's mapping; each contributor keeps its
    // own semantic ids and instruction/range provenance.
    let shared = ids;
    for (const contributor of [origin, ...origins]) {
      this.context.checkpoint(1);
      if (seen.has(contributor.id)) continue;
      seen.add(contributor.id);
      this.mapped(contributor, start, [...shared, ...this.semanticIds(contributor)], [], end);
      shared = [];
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
    for (const site of this.inlinedCallSites.get(origin.id) ?? []) {
      const proof = this.sourceEvidence.get(site.node.id);
      this.map(site.node, start, [], end);
      this.mapped(
        site.node,
        start,
        proof ? [...proof.ids] : [],
        [...site.node.contract_evidence, ...(proof?.evidence ?? [])],
        end,
      );
      this.mapMemory(site.node, start, end);
    }
  }

  private addressKey(address: Address): string {
    return `${address.image_id}:${address.space}:${address.value}`;
  }

  /** String literal text of an item; a string past STRING_LITERAL_LIMIT shows
   * its prefix and an explicit marker keeping the address and omitted length. */
  private stringLiteralText(item: SourceAddress): string {
    const literal = stringLiteral(item.string!, this.language);
    this.context.checkpoint(1 + literal.text.length);
    this.writer.guard(Buffer.byteLength(literal.text));
    if (literal.omitted_bytes === 0) return literal.text;
    const address = `0x${item.address.value.toString(16)}`;
    return this.language === 'c-like'
      ? `${literal.text} /* ${address}: +${literal.omitted_bytes} bytes */`
      : this.call(
          'string_prefix',
          `Pointer to the NUL-terminated string at the given address; only its first ${STRING_LITERAL_LIMIT} characters are shown. Arguments: that prefix, string address, number of further bytes not shown.`,
          [literal.text, address, String(literal.omitted_bytes)],
        );
  }
  private sourceAddress = (address: Address, literal = false): string => {
    const key = this.addressKey(address),
      item = this.sourceAddresses.get(key);
    if (this.sourceView && item?.objc?.kind === 'string')
      return this.guarded(objcStringLiteral(item.objc.text, this.language));
    if (
      literal &&
      item?.string !== undefined &&
      (!this.sourceView || this.stringLiteralEligible(item, true))
    )
      return this.stringLiteralText(item);
    if (item?.object && this.sourceView) return this.globalAddress(item);
    if (
      item?.function_entry &&
      this.sourceView &&
      address.space === 'va' &&
      this.localValidation.presentation(
        'function_address',
        this.input.function.id,
        'a constant equal to the exact entry of a function of this image prints as that function; no prototype is stated',
        undefined,
        `${this.addressKey(address)}`,
      )
    )
      return this.functionAddress(address, item);
    // Checked view: exact storage identity as an explicit helper, never a declaration.
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
  /** Functions of this image the text names as values, by entry key. */
  private readonly functionValues = new Map<string, { readonly name: string }>();

  /** The integer address of a function named by identifier: `(uintptr_t)name`
   * (C) or `function_address("name")`. The function is never called here. */
  private functionAddress(address: Address, item: SourceAddress): string {
    const key = this.addressKey(address),
      own = item.function_entry?.self
        ? this.identifiers.get(this.input.function.id)?.identifier
        : undefined;
    let name = own ?? this.sourceNames.get(key);
    if (name === undefined) {
      if (item.name !== undefined) this.names.set(key, item.name);
      name = this.sourceIdentifier(
        key,
        item.source_name ?? item.name ?? `sub_${address.value.toString(16)}`,
        item.name !== undefined,
      );
      this.sourceNames.set(key, name);
    }
    if (own === undefined) this.functionValues.set(key, { name });
    return this.language === 'c-like'
      ? `(uintptr_t)${name}`
      : this.call(
          'function_address',
          'Entry address of the named function, as an integer address; the function is not called and no prototype is implied.',
          [this.writer.quote(name)],
        );
  }

  /** Value-preserving bitcast chain of an address value. */
  private bitcastSource(value: Value): Value {
    for (let depth = 0; depth < 16; depth++) {
      const expression = this.program.expressions.get(value.id);
      if (expression?.kind !== 'cast' || expression.op !== 'bitcast') break;
      value = expression.value;
    }
    return value;
  }

  private globalName(global: GlobalObject): string {
    const used = this.usedGlobals.get(global.key);
    if (used) return used.name;
    if (global.native_name !== undefined) this.names.set(global.key, global.native_name);
    const name = this.sourceIdentifier(global.key, global.stem, global.native_name !== undefined);
    this.usedGlobals.set(global.key, { object: global, name });
    return name;
  }

  /** Integer address of an image object (or of an imported object, offset 0). */
  private globalAddress(item: SourceAddress): string {
    const global = this.globals.object(item)!;
    const name = this.globalName(global),
      offset = item.object!.offset;
    if (this.language === 'python-like') return `address_of(${name}, 0x${offset.toString(16)})`;
    const base = `(uintptr_t)${global.shape === 'scalar' ? '&' : ''}${name}`;
    return offset === 0n ? base : `(${base} + 0x${offset.toString(16)})`;
  }

  /** The imported object's address: what a read of its binding slot returns. */
  private importAddress(global: GlobalObject): Printed {
    const name = this.globalName(global);
    return this.language === 'python-like'
      ? this.printer.primary(`address_of(${name}, 0x0)`, { bits: 64, signed: false })
      : {
          text: `(uintptr_t)${global.shape === 'scalar' ? '&' : ''}${name}`,
          precedence: UNARY,
          ctype: { bits: 64, signed: false },
        };
  }

  /** Byte-addressed C pointer to a constant address inside a declared global. */
  private globalPointer(value: Value): string | undefined {
    const item = this.sourceDataValue(value);
    if (!item?.object) return undefined;
    const global = this.globals.object(item);
    if (!global) return undefined;
    const name = this.globalName(global),
      offset = item.object.offset;
    const first = global.shape === 'scalar' ? `&${name}` : name;
    if (offset === 0n) return first;
    return `(${global.shape === 'bytes' ? name : `(uint8_t *)${first}`} + 0x${offset.toString(16)})`;
  }

  /** `name` / `name[i]` for an access the plan bound to a declared global. */
  private globalStorage(
    node: Extract<Instruction, { kind: 'load' | 'store' }>,
    access: GlobalAccess,
  ): string | undefined {
    if (
      !this.permitUnaligned(node) ||
      !this.localValidation.presentation(
        'global_data_access',
        this.input.function.id,
        'scalar access to an image or import-bound global at a displacement that is a multiple of its width, every access in the function agreeing on one element type; the declaration states no array bound and the object keeps its native name or a neutral data_<VA> name',
      )
    )
      return undefined;
    const name = this.globalName(access.object);
    if (this.language === 'c-like' && access.object.shape === 'scalar') return name;
    return `${name}[${access.offset / BigInt(access.object.element.bits / 8)}]`;
  }

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
      : // A bare `(uintptr_t)object` cast binds like any unary operator.
        /^\(uintptr_t\)&?\w+$/.test(text)
        ? { text, precedence: UNARY, ctype: { bits: 64, signed: false } }
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

  /** Source view: the string literal of an exact pointer-width constant that
   * addresses an immutable, NUL-terminated string with an established encoding;
   * otherwise undefined. An interior address (a tail-merged string) denotes the
   * same bytes as its suffix. The empty string is a literal only where the
   * context already establishes a character pointer (`allowEmpty`). */
  private sourceLiteral(value: Value, allowEmpty = false): string | undefined {
    if (
      !this.sourceView ||
      value.type.kind !== 'integer' ||
      value.type.bits !== this.input.source?.abi.layout.pointer_bits
    )
      return undefined;
    const address = this.sourceAddressOf(value),
      item = address && this.sourceAddresses.get(this.addressKey(address));
    if (!address || !item || !this.stringLiteralEligible(item, allowEmpty)) return undefined;
    return this.sourceAddress(address, true);
  }

  private stringLiteralEligible(item: SourceAddress, allowEmpty: boolean): boolean {
    return (
      item.string !== undefined &&
      item.string_encoding !== undefined &&
      item.object?.mutable === false &&
      (allowEmpty || item.string !== '')
    );
  }

  /** The literal of a constant string address printed in a value position (a
   * call argument, store, return, copy, select arm or identity comparison);
   * never as an operand of arithmetic, where the constant is just an integer.
   * `spelling` is the declared type of the receiving variable, slot or result:
   * a character/void pointer takes the bare literal, another pointer a cast, and
   * an integer (or an expression operand) the address of the string, so no
   * pointer is ever silently converted to an integer. `cast` false leaves a
   * pointer conversion to the receiving assignment's own interpretation. */
  private valueLiteral = (value: Value, spelling?: string, cast = true): Printed | undefined => {
    const text = this.sourceLiteral(value);
    if (text === undefined) return this.symbolicValue(value, spelling, cast);
    if (
      !this.localValidation.presentation('string_literal', value.id, STRING_LITERAL_SCOPE, [
        value.id,
      ])
    )
      return undefined;
    const integerAddress = { bits: 64, signed: false };
    if (this.language === 'python-like') {
      if (spelling?.startsWith('pointer[')) return this.printer.primary(text);
      return this.printer.primary(
        this.call(
          'string_address',
          'Address of the static NUL-terminated string literal, as an integer address.',
          [text],
        ),
        integerAddress,
      );
    }
    if (spelling?.endsWith('*')) {
      const bare = /^(?:const )?(?:char|void)\s*\*$/.test(spelling);
      // A string literal is itself a `const char *` expression.
      if (bare)
        return {
          ...this.printer.primary(text, integerAddress),
          pointer: { text, type: 'const char*' },
        };
      return !cast
        ? this.printer.primary(text, integerAddress)
        : { text: `(${spelling})${text}`, precedence: UNARY, ctype: integerAddress };
    }
    return { text: `(uintptr_t)${text}`, precedence: UNARY, ctype: integerAddress };
  };

  /** A pointer-width constant in a value position that is the exact entry of a
   * function, or the address of a named data object: it prints as that name
   * (`(uintptr_t)name`, `(uintptr_t)&name`), so a stored or compared callback or
   * table pointer is identified instead of shown as a bare number. Strings are
   * literals (`sourceLiteral`); an unnamed data address stays a number. */
  private symbolicValue(value: Value, spelling?: string, cast = true): Printed | undefined {
    if (
      !this.sourceView ||
      value.type.kind !== 'integer' ||
      value.type.bits !== this.input.source?.abi.layout.pointer_bits
    )
      return undefined;
    const address = this.sourceAddressOf(value),
      item = address && this.sourceAddresses.get(this.addressKey(address));
    if (!address || !item || address.space !== 'va') return undefined;
    if (!item.function_entry && !(item.object && item.name !== undefined)) return undefined;
    const text = this.sourceAddress(address);
    if (/^0x[0-9a-f]+$/.test(text)) return undefined;
    const integerAddress = { bits: 64, signed: false };
    if (this.language === 'python-like') return this.printer.primary(text, integerAddress);
    if (spelling?.endsWith('*') && cast)
      return { text: `(${spelling})${text}`, precedence: UNARY, ctype: integerAddress };
    return /^\(uintptr_t\)&?\w+$/.test(text)
      ? { text, precedence: UNARY, ctype: integerAddress }
      : this.printer.primary(text, integerAddress);
  }

  /** An address that adds a variable offset to the address of an immutable
   * string literal (an inlined `strncmp(p, "create", 6)` indexing its keyword):
   * the literal is shown at its position in the sum, `(uintptr_t)"create" + i`.
   * The sum is the same modular address; this is a memory address operand, so
   * the constant is a pointer and not an arithmetic integer. */
  private stringBaseSum(value: Value): Printed | undefined {
    if (!this.sourceView || !this.inline.has(value.id)) return undefined;
    const expression = this.program.expressions.get(value.id);
    if (expression?.kind !== 'integer' || expression.op !== 'add') return undefined;
    for (const [base, other] of [
      [expression.left, expression.right],
      [expression.right, expression.left],
    ] as const) {
      if (this.constantOf(other) !== undefined) continue;
      const literal = this.valueLiteral(base);
      if (!literal) continue;
      return this.printer.binary('+', literal, this.printer.reduce(64, this.printed(other)), {
        bits: 64,
        signed: false,
      });
    }
    return undefined;
  }

  /** Library-declared character parameter of a source call. Every library
   * declaration the signature rests on must agree. */
  private characterParameter(projection: BoundaryProjection, index: number): boolean {
    let agreed = false;
    for (const id of projection.signature?.evidence_ids ?? []) {
      this.context.checkpoint(1);
      const declarations = this.libraryDeclarations.get(id);
      if (!declarations?.length) continue;
      if (!declarations.every((declaration) => declaration.character?.includes(index)))
        return false;
      agreed = true;
    }
    return agreed;
  }

  /** A pointer type whose pointee is an 8-bit integer (`char`, `uint8_t`). */
  private bytePointerType(id: string): boolean {
    const pointer = this.typeRecords.get(id)?.definition;
    if (pointer?.kind !== 'pointer') return false;
    const target = this.typeRecords.get(pointer.to)?.definition;
    return target?.kind === 'integer' && target.bits === 8;
  }

  /** Source view: `@"..."` for an exact pointer-width value addressing a
   * compiler-emitted constant NSString object. */
  private objcLiteral(value: Value): string | undefined {
    if (!this.sourceView || value.type.kind !== 'integer' || value.type.bits !== 64)
      return undefined;
    const address = this.sourceAddressOf(value),
      objc = address && this.sourceAddresses.get(this.addressKey(address))?.objc;
    return objc?.kind === 'string'
      ? this.guarded(objcStringLiteral(objc.text, this.language))
      : undefined;
  }

  private guarded(text: string): string {
    this.writer.guard(Buffer.byteLength(text));
    return text;
  }

  /** Source view: the selector/class reference slot an exact 64-bit load reads. */
  private objcReference(
    node: Extract<Instruction, { kind: 'load' | 'store' }>,
  ): SourceAddress['objc'] | undefined {
    if (!this.sourceView || node.kind !== 'load' || bitWidth(node.result.type) !== 64)
      return undefined;
    const address = this.sourceAddressOf(node.address),
      objc = address && this.sourceAddresses.get(this.addressKey(address))?.objc;
    return objc && objc.kind !== 'string' ? objc : undefined;
  }

  /** `@selector(name)` / `[Name class]` for a reference-slot load; a message
   * receiver (and Python) spells an identifier-shaped class by its name. */
  private objcReferenceText(
    reference: NonNullable<SourceAddress['objc']>,
    receiver = false,
  ): string {
    if (reference.kind === 'selector_ref')
      return this.language === 'c-like' && OBJC_SELECTOR.test(reference.text)
        ? `@selector(${reference.text})`
        : this.call('selector', 'Objective-C selector read from its __objc_selrefs slot.', [
            this.writer.quote(reference.text),
          ]);
    if (!/^[A-Za-z_$][\w$]*$/.test(reference.text))
      return this.call('objc_class', 'Objective-C class read from its class-reference slot.', [
        this.writer.quote(reference.text),
      ]);
    return receiver || this.language === 'python-like'
      ? reference.text
      : `[${reference.text} class]`;
  }

  /** Message form of a call whose projected arguments exactly match its
   * resolved selector's keyword count (a known variadic tail may follow). */
  private objcSend(
    node: Extract<Instruction, { kind: 'call' }>,
  ): { readonly message: ObjCMessage; readonly skip: number; readonly arity: number } | undefined {
    const message = this.sourceView ? this.input.source?.objc?.messages.get(node.id) : undefined,
      projection = message && this.program.calls.get(node.id);
    if (!message || !projection || projection.kind === 'physical') return undefined;
    if (!OBJC_SELECTOR.test(message.selector)) return undefined;
    const skip = message.form === 'send' ? 2 : 1,
      arity = selectorArity(message.selector),
      complete = projection.kind === 'source' || projection.argument_list_complete === true;
    if (
      projection.arguments.length < skip + arity ||
      (!message.variadic && (!complete || projection.arguments.length !== skip + arity))
    )
      return undefined;
    return { message, skip, arity };
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
    const name = this.sourceIdentifier(
      node.id,
      preferred,
      this.presentedName(node.id) !== undefined,
    );
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
  /** Forward declarations of types without a printed body: written only if the
   * finished text refers to them. */
  private readonly deferredTypedefs: string[] = [];
  /** Named pointer typedefs (`HANDLE`, `CFStringRef`) of library contracts: deferred
   * typedef name -> full declaration. */
  private readonly handleTypedefs = new Map<string, string>();

  private opaqueType(id: string): string {
    let name = this.sourceOpaqueTypes.get(id);
    if (!name) {
      const spelling = this.typeRecords.get(id)?.spelling;
      // `struct tag` spellings are complete type names and need no typedef.
      if (spelling !== undefined && /^(?:struct|union) /.test(spelling)) return spelling;
      name = this.sourceIdentifier(id, spelling ?? `opaque_${this.sourceOpaqueTypes.size + 1}`);
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
        if (this.sourceView && this.language === 'c-like' && record.spelling !== undefined)
          return record.spelling;
        if (this.byteAddress(type.to))
          return this.language === 'c-like' ? 'uint8_t*' : 'pointer[uint8_t]';
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

  /** Source view: an analysis address whose pointee type is not established
   * (`void`) is spelled byte-addressed, so `p + k` and `*(T *)(p + k)` are the
   * machine's exact byte arithmetic without integer round trips. */
  private byteAddress(pointee: string): boolean {
    const record = this.typeRecords.get(pointee);
    return (
      this.sourceView &&
      record?.source === 'analysis' &&
      record.definition.kind === 'void' &&
      this.localValidation.presentation(
        'byte_addressed_pointer',
        this.input.function.id,
        'analysis address without an established pointee type spelled as a byte pointer; arithmetic and dereferences keep the exact address bits and access widths, no pointee type is claimed',
      )
    );
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

  /** Flattens an inline `add` / constant-`sub` tree into its single base, at
   * most one index scaled by `size` (unscaled for bytes) and the wrapped signed
   * byte displacement. A second index, an unscaled addend, a variable
   * subtrahend or a mixed width refuses, keeping the explicit address. */
  private addressSum(
    root: Extract<Expression, { kind: 'integer' }>,
    bits: number,
    size: bigint,
    isBase: (value: Value) => boolean,
  ): { base: Value; index: Value | null; displacement: bigint } | null {
    let base: Value | null = null,
      index: Value | null = null,
      displacement = 0n;
    const visit = (value: Value, depth: number): boolean => {
      const constant = this.constantOf(value);
      if (constant !== undefined) {
        displacement += constant;
        return true;
      }
      const node =
        depth < 16 &&
        this.inline.has(value.id) &&
        value.type.kind === 'integer' &&
        value.type.bits === bits
          ? this.program.expressions.get(value.id)
          : undefined;
      if (node?.kind === 'integer' && (node.op === 'add' || node.op === 'sub')) {
        const saved = { base, index, displacement };
        if (descend(node, depth + 1)) return true;
        ({ base, index, displacement } = saved);
      }
      if (!base && isBase(value)) {
        base = value;
        return true;
      }
      if (!index) {
        const scaled = this.scaledIndex(value, size);
        if (scaled) {
          index = scaled;
          return true;
        }
      }
      return false;
    };
    const descend = (node: Extract<Expression, { kind: 'integer' }>, depth: number): boolean => {
      if (node.op === 'add') return visit(node.left, depth) && visit(node.right, depth);
      const amount = this.constantOf(node.right);
      if (amount === undefined) return false;
      displacement -= amount;
      return visit(node.left, depth);
    };
    if (!descend(root, 0) || !base) return null;
    return { base, index, displacement: BigInt.asIntN(bits, displacement) };
  }

  /** The index of a term scaled by exactly `size` bytes (the term itself for
   * bytes); undefined for any other term. */
  private scaledIndex(term: Value, size: bigint): Value | undefined {
    if (size === 1n) return term;
    const scaled = this.inline.has(term.id) ? this.program.expressions.get(term.id) : undefined;
    if (scaled?.kind !== 'integer') return undefined;
    const right = this.constantOf(scaled.right),
      left = this.constantOf(scaled.left);
    if (scaled.op === 'shl' && right !== undefined && right < 64n && 1n << right === size)
      return scaled.left;
    if (scaled.op === 'mul' && right === size) return scaled.left;
    if (scaled.op === 'mul' && left === size) return scaled.right;
    return undefined;
  }

  /** An address `p + index * size + k` through a declared scalar pointer `p` of
   * exactly the accessed width and kind, where the byte displacement is a
   * multiple of the element size; other shapes refuse. */
  private typedAddress(
    address: Value,
    bits: number,
    kind: PointeeKind,
  ): {
    base: Value;
    index: Value | null;
    displacement: bigint;
    count: bigint;
    size: bigint;
  } | null {
    const root = this.program.expressions.get(address.id);
    if (
      root?.kind !== 'integer' ||
      (root.op !== 'add' && root.op !== 'sub') ||
      address.type.kind !== 'integer' ||
      bits % 8 !== 0
    )
      return null;
    const size = BigInt(bits / 8);
    const sum = this.addressSum(root, address.type.bits, size, (value) => {
      const pointer = this.scalarPointer(value);
      return pointer?.bits === bits && pointer.kind === kind;
    });
    if (!sum || sum.displacement % size !== 0n) return null;
    if (sum.index && this.declaredSpelling(sum.index).endsWith('*')) return null;
    return { ...sum, count: sum.displacement / size, size };
  }

  /** C `p[i + k]` / `p[k]` for an inline address through a typed scalar
   * pointer (see typedAddress). A constant joined to an index is added in the
   * index's own 64-bit unsigned arithmetic, where the scaling wraps like the
   * address; any other index type keeps the explicit form. */
  private typedIndex(address: Value, bits: number, kind: PointeeKind): string | null {
    const typed = this.typedAddress(address, bits, kind);
    const pointer = typed && this.scalarPointerBase(typed.base, bits, kind);
    if (!typed || pointer === null) return null;
    if (!typed.index) return `${pointer}[${typed.count}]`;
    const printed = this.printed(typed.index);
    if (typed.count === 0n) return `${pointer}[${(printed.widened ?? printed).text}]`;
    if (
      address.type.kind !== 'integer' ||
      !printed.ctype ||
      printed.ctype.signed ||
      printed.ctype.bits !== address.type.bits
    )
      return null;
    const offset = this.printer.primary(String(typed.count < 0n ? -typed.count : typed.count), {
      bits: 32,
      signed: true,
    });
    return `${pointer}[${this.printer.binary(typed.count < 0n ? '-' : '+', printed, offset, printed.ctype).text}]`;
  }

  /** Python-like byte address `uint64(p + index * size + bytes)` of the same
   * typed-pointer access: one modular sum instead of nested reductions. Python
   * memory views are byte-addressed, so no element subscript is printed. */
  private typedAddressSum(address: Value, bits: number, kind: PointeeKind): Printed | null {
    const typed = this.typedAddress(address, bits, kind);
    if (!typed?.index || address.type.kind !== 'integer') return null;
    const index = this.printed(typed.index);
    let sum = this.printed(typed.base);
    sum = this.printer.binary(
      '+',
      sum,
      typed.size === 1n
        ? index
        : this.printer.binary('*', index, this.printer.literal(typed.size, 64), null),
      null,
    );
    if (typed.displacement !== 0n)
      sum = this.printer.binary(
        typed.displacement < 0n ? '-' : '+',
        sum,
        this.printer.literal(
          typed.displacement < 0n ? -typed.displacement : typed.displacement,
          64,
        ),
        null,
      );
    return this.printer.cast(address.type.bits, false, sum);
  }

  /** Element kind and width of a declared scalar pointer value: a printed
   * variable, or an inline reload of a typed promoted slot. */
  private scalarPointer(value: Value): { bits: number; kind: PointeeKind } | null {
    const load = this.inlined.get(value.id)?.node;
    if (load?.kind === 'load' && this.slotType(load.id)) {
      const slot = this.slotType(load.id)!;
      return slot.kind === 'pointer' ? { bits: slot.pointee_bits, kind: slot.pointee } : null;
    }
    if (this.inline.has(value.id)) return null;
    const spelling = this.declaredSpelling(value);
    const match =
      this.language === 'c-like'
        ? /^(?:const )?(?:u?int(8|16|32|64)_t|(float|double))\s*\*$/.exec(spelling)
        : /^pointer\[(?:u?int(8|16|32|64)_t|(float|double))\]$/.exec(spelling);
    if (!match) return null;
    return match[2]
      ? { bits: match[2] === 'float' ? 32 : 64, kind: 'float' }
      : { bits: Number(match[1]), kind: 'integer' };
  }

  /** Name of a declared scalar pointer of exactly `bits` element width and
   * `kind` (C): a printed variable, or an inline reload of a typed slot. */
  private scalarPointerBase(value: Value, bits: number, kind: PointeeKind): string | null {
    const pointer = this.scalarPointer(value);
    if (this.language !== 'c-like' || pointer?.bits !== bits || pointer.kind !== kind) return null;
    const load = this.inlined.get(value.id)?.node;
    return load?.kind === 'load' && this.slotType(load.id) ? this.storage(load) : this.local(value);
  }

  /** A stored value converted to a declared pointer member's type: the same
   * declared pointer, a null constant, or the exact address bits. */
  private memberPointerValue(value: Value, typeId: string): string {
    const spelling = this.sourceType(typeId);
    if (this.constantOf(value) === 0n) return '0';
    if (!this.inline.has(value.id) && this.declaredSpelling(value) === spelling)
      return this.local(value);
    return `(${spelling})(uintptr_t)${this.printer.group(this.printed(value), UNARY)}`;
  }

  /** Exact whole value behind same-width casts, low extracts and a
   * concatenation of consecutive extracts of one value. */
  private wholeValue(value: Value): Value {
    for (let depth = 0; depth < 8; depth++) {
      const expression = this.program.expressions.get(value.id);
      if (
        ((expression?.kind === 'cast' && expression.op === 'bitcast') ||
          (expression?.kind === 'extract' && expression.offset === 0)) &&
        bitWidth(expression.value.type) === bitWidth(value.type)
      ) {
        value = expression.value;
        continue;
      }
      if (expression?.kind !== 'concat') break;
      let whole: Value | undefined,
        offset = 0;
      for (const part of expression.values) {
        const fragment = this.program.expressions.get(part.id);
        if (
          fragment?.kind !== 'extract' ||
          fragment.offset !== offset ||
          (whole && whole.id !== fragment.value.id)
        )
          return value;
        whole = fragment.value;
        offset += bitWidth(part.type);
      }
      if (!whole || offset !== bitWidth(value.type) || bitWidth(whole.type) !== offset) break;
      value = whole;
    }
    return value;
  }

  /** `p->f_<offset>` for an access at `p + offset` through a declared pointer to
   * a declared partial structure with a member of exactly that offset and width.
   * The base may itself be an inline pointer member read (`p->f_20->f_8`), and
   * a loop counter proven by shape analysis indexes a strided element view. */
  private memberAccess(address: Value, bits: number, node?: string): string | null {
    let base = address,
      offset = 0n;
    let index: Value | undefined,
      stride = 0n;
    const view = node ? this.program.memory.get(node) : undefined;
    const counter = view?.field.indices?.find((item) => item.node_id === node)?.value_id;
    const shapeBase = view?.shape.base.kind === 'value' ? view.shape.base.value_id : undefined;
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
      if (expression?.kind === 'concat' && this.wholeValue(base) !== base) {
        base = this.wholeValue(base);
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
        if (index) continue;
        // Shape analysis proved this whole address is `shapeBase + field
        // offset + k * stride` for the loop counter `k` (a strength-reduced
        // byte offset moving in lockstep with it).
        const element = counter ? this.program.values.get(counter) : undefined;
        const whole = [expression.left, expression.right]
          .map((item) => this.wholeValue(item))
          .find((item) => item.id === shapeBase);
        if (!element || !whole || !view?.field.stride) return null;
        base = whole;
        index = element;
        stride = view.field.stride;
        offset = view.field.offset;
        break;
      }
    }
    let baseText: string, id: string | undefined;
    const load = this.inlined.get(base.id)?.node;
    if (this.inline.has(base.id)) {
      // An inline read of a declared pointer member is itself the base lvalue.
      if (load?.kind !== 'load' || base.type.kind !== 'integer' || base.type.bits !== 64)
        return null;
      baseText = this.storage(load);
      id = this.memberPointers.get(load.id);
      if (!id) return null;
    } else {
      if (base.type.kind !== 'integer') return null;
      id =
        this.sourceValueTypes.get(base.id) ??
        this.program.source?.value_types?.get(base.id)?.type_id;
      if (!id || this.declaredSpelling(base) !== this.sourceType(id)) return null;
      baseText = this.local(base);
    }
    offset = BigInt.asIntN(base.type.bits, offset);
    const pointer = this.typeRecords.get(id)?.definition;
    if (pointer?.kind !== 'pointer') return null;
    const members = this.partialLayout(pointer.to);
    const elementStride = this.sourceStructs.strides.get(pointer.to);
    const indexedStruct = !!index && stride === elementStride;
    const member = members?.find((item) => {
      const kind = this.typeRecords.get(item.typeId)?.definition.kind;
      if (
        item.bits !== bits ||
        !(kind === 'integer' || (kind === 'pointer' && item.count === undefined))
      )
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
    if (this.typeRecords.get(member.typeId)?.definition.kind === 'pointer') {
      // Declared pointer members convert explicitly at integer/pointer uses.
      if (!node) return null;
      this.memberPointers.set(node, member.typeId);
    }
    const field = member.name ?? memberName(member.offset);
    const used = this.sourceStructs.name(pointer.to);
    const offsets = this.usedMembers.get(used) ?? new Set<bigint>();
    offsets.add(member.offset);
    this.usedMembers.set(used, offsets);
    let access = indexedStruct
      ? `${baseText}[${this.value(index!)}].${field}`
      : `${baseText}->${field}`;
    if (member.count !== undefined) {
      const displacement = (offset - member.offset) / BigInt(member.bits / 8);
      const subscript = index
        ? `(${this.value(index)})${displacement ? ` + ${displacement}` : ''}`
        : String(displacement);
      access += `[${subscript}]`;
    }
    const memberType = this.typeRecords.get(member.typeId)?.definition;
    if (memberType?.kind === 'integer' && memberType.bits === bits)
      this.memberTypes.set(access, { bits, signed: memberType.signed });
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
    // Every structure name is typedef'd only where the finished text mentions it.
    for (const id of structures) this.deferredTypedefs.push(this.sourceStructs.name(id));
    this.deferredTypedefs.push(...this.sourceOpaqueTypes.values());
    for (const id of pending) {
      const record = this.typeRecords.get(id);
      if (
        this.language === 'c-like' &&
        record?.source === 'library' &&
        record.spelling !== undefined &&
        record.definition.kind === 'pointer' &&
        !this.handleTypedefs.has(record.spelling)
      ) {
        this.handleTypedefs.set(
          record.spelling,
          `typedef ${this.sourceType(record.definition.to)}* ${record.spelling};`,
        );
        this.deferredTypedefs.push(record.spelling);
      }
    }
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
    this.structureSlot = { at: this.writer.offset, ids: structures };
  }

  /** The declarations of the structures the finished text accesses: only the
   * members it prints (byte gaps keep every offset), never the image-wide layout,
   * which stays in the types view / types.h. A structure the text never indexes
   * stays an incomplete type. */
  private structureLines(): string[] {
    const lines: string[] = [];
    for (const id of this.structureSlot?.ids ?? []) {
      this.context.checkpoint(1);
      const members = this.partialLayout(id);
      if (!members) continue;
      const name = this.sourceStructs.name(id),
        used = this.usedMembers.get(name);
      if (!used) continue;
      const parts: string[] = [];
      let end = 0n,
        packed = false;
      for (const member of members) {
        if (!used.has(member.offset)) continue;
        if (member.offset > end) parts.push(`uint8_t ${paddingName(end)}[${member.offset - end}];`);
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
        parts.push(`${spelling} ${member.name ?? memberName(member.offset)}${array};`);
        packed ||= member.offset % BigInt(member.bits / 8) !== 0n;
        end = member.offset + member.size;
      }
      const stride = this.sourceStructs.strides.get(id);
      if (stride) {
        if (stride > end) parts.push(`uint8_t ${paddingName(end)}[${stride - end}];`);
        packed ||= members.some((member) => stride % BigInt(member.bits / 8) !== 0n);
        lines.push(`/* access stride ${stride}, not size */`);
      }
      const image = this.sourceStructs.image(id);
      const runtime = this.typeRecords.get(id)?.source === 'runtime';
      lines.push(
        runtime
          ? '/* ObjC ivars at static class-metadata offsets; partial */'
          : `/* partial${image && image.functions > 1 ? `; ${image.functions} fns` : ''}${
              image?.conflicts.length ? `; conflicts with ${image.conflicts.join(', ')}` : ''
            } */`,
        `struct ${name} { ${parts.join(' ')} }${packed ? ' __attribute__((packed))' : ''};`,
      );
    }
    return lines;
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

  /** C spelling of a library-declared pointer type: `char` identity, header-declared
   * `const` and named opaque pointees come from the installed contract's evidence, never
   * from a guessed callee name or an arbitrary 8-bit pointee. A read-only declared
   * argument footprint also permits `const`. */
  private libraryPointerSpelling(
    association: NonNullable<BoundaryProjection['signature']>,
    typeId: string,
    subject: string,
    declared: (entry: CatalogEntry) => { spec: TypeSpec; readOnly: boolean } | undefined,
  ): string {
    const fallback = this.sourceType(typeId);
    return this.language === 'c-like'
      ? (this.libraryCSpelling(association, typeId, subject, declared) ?? fallback)
      : fallback;
  }

  /** The library's own C spelling of a declared pointer type, in either dialect
   * (the Python-like locals map it from `char` identity): undefined when no
   * contract evidence refines the generic type spelling. */
  private libraryCSpelling(
    association: NonNullable<BoundaryProjection['signature']>,
    typeId: string,
    subject: string,
    declared: (entry: CatalogEntry) => { spec: TypeSpec; readOnly: boolean } | undefined,
  ): string | undefined {
    const fallback = this.sourceType(typeId);
    if (!this.sourceView || association.source !== 'library') return undefined;
    const cached = this.callParameterSpellings.get(subject);
    if (cached !== undefined) return cached ?? undefined;
    this.callParameterSpellings.set(subject, null);
    let depth = 0,
      base = typeId,
      record = this.typeRecords.get(base);
    while (
      record?.source === 'library' &&
      record.definition.kind === 'pointer' &&
      record.spelling === undefined
    ) {
      depth++;
      base = record.definition.to;
      record = this.typeRecords.get(base);
    }
    if (depth === 0 || record?.source !== 'library') return undefined;
    let spelling: string | undefined;
    for (const id of association.evidence_ids) {
      this.context.checkpoint(1);
      for (const entry of this.libraryDeclarations.get(id) ?? []) {
        const found = declared(entry);
        if (!found) return undefined;
        let spec = found.spec,
          levels = 0,
          constant = false;
        while (typeof spec === 'object' && spec.kind === 'pointer') {
          constant = spec.const === true;
          spec = spec.to;
          levels++;
        }
        if (
          levels !== depth ||
          (spec === 'char' &&
            !(record.definition.kind === 'integer' && record.definition.bits === 8))
        )
          return undefined;
        const next = `${constant || (levels === 1 && found.readOnly) ? 'const ' : ''}${spec === 'char' ? 'char' : this.sourceType(base)}${'*'.repeat(levels)}`;
        if (spelling !== undefined && spelling !== next) return undefined;
        spelling = next;
      }
    }
    if (
      !spelling ||
      (this.language !== 'c-like' && !/^(?:const )?char\*$/.test(spelling)) ||
      spelling === fallback ||
      !this.localValidation.presentation(
        'library_string_parameter',
        subject,
        'library-contract pointer spelling: C character identity, header-declared const (or a declared read-only argument footprint) and named opaque pointees',
        [association.id, typeId],
      )
    )
      return undefined;
    this.callParameterSpellings.set(subject, spelling);
    return spelling;
  }

  /** The dialect's spelling of a library-declared pointer: C as the library
   * spells it; Python-like `pointer[char]` for character identity, else the
   * generic type spelling. */
  private dialectPointer(spelling: string, typeId: string): string {
    return this.language === 'c-like'
      ? spelling
      : /^(?:const )?char\*$/.test(spelling)
        ? 'pointer[char]'
        : this.sourceType(typeId);
  }

  /** Declared type of call parameter `index` where it is a pointer, else a scalar. */
  private callParameterFact(
    projection: BoundaryProjection,
    index: number,
  ): PointerFact | 'scalar' | undefined {
    const association = projection.signature;
    const parameter = association?.signature.parameters[index];
    if (!association || !parameter) return undefined;
    const definition = this.typeRecords.get(parameter.type_id)?.definition;
    if (definition?.kind !== 'pointer') return 'scalar';
    const library = this.libraryCSpelling(association, parameter.type_id, parameter.id, (entry) => {
      const spec = entry.parameters[index]?.[1];
      if (spec === undefined) return undefined;
      const accesses = entry.memory?.filter((item) => item.argument === index) ?? [];
      return {
        spec,
        readOnly: accesses.length > 0 && accesses.every((item) => item.access === 'read'),
      };
    });
    return {
      type_id: parameter.type_id,
      spelling: library
        ? this.dialectPointer(library, parameter.type_id)
        : this.sourceType(parameter.type_id),
    };
  }

  /** Declared spelling of a single call result that is a pointer, else undefined. */
  private callResultSpelling(projection: BoundaryProjection): string | undefined {
    const association = projection.signature;
    if (!association) return undefined;
    const typeId = association.signature.return_type;
    if (this.typeRecords.get(typeId)?.definition.kind !== 'pointer') return undefined;
    const library = this.libraryCSpelling(
      association,
      typeId,
      `${association.id}:return`,
      (entry) => ({ spec: entry.returns, readOnly: false }),
    );
    return library ? this.dialectPointer(library, typeId) : undefined;
  }

  private callParameterType(projection: BoundaryProjection, index: number): string {
    const association = projection.signature!;
    const parameter = association.signature.parameters[index]!;
    return this.libraryPointerSpelling(association, parameter.type_id, parameter.id, (entry) => {
      const spec = entry.parameters[index]?.[1];
      if (spec === undefined) return undefined;
      const accesses = entry.memory?.filter((item) => item.argument === index) ?? [];
      return {
        spec,
        readOnly: accesses.length > 0 && accesses.every((item) => item.access === 'read'),
      };
    });
  }

  private callReturnType(projection: BoundaryProjection): string {
    const association = projection.signature!;
    return this.libraryPointerSpelling(
      association,
      association.signature.return_type,
      `${association.id}:return`,
      (entry) => ({ spec: entry.returns, readOnly: false }),
    );
  }

  /** Call-site declarations describe the recovered interface, not an authored prototype. */
  private declareSourceCallees(): void {
    if (!this.sourceView || this.language !== 'c-like') return;
    const declarations = new Map<string, { text: string; node: Instruction } | null>();
    for (const [id, projection] of this.program.calls) {
      const node = this.statements.get(id);
      if (node?.kind !== 'call' || node.target.kind !== 'direct' || this.objcSend(node)) continue;
      const name = this.sourceCallee(node);
      if (name === this.identifiers.get(this.input.function.id)?.identifier) continue;
      const signature = projection.signature?.signature;
      if (projection.results.length > 1) continue;
      const result = signature
        ? this.callReturnType(projection)
        : projection.results.length === 1
          ? this.valueType(projection.results[0]!)
          : projection.kind !== 'physical'
            ? 'void'
            : null;
      if (!result) continue;
      const parameters = signature
        ? signature.parameters.map((_, index) => this.callParameterType(projection, index))
        : projection.arguments.map((value) => this.valueType(value));
      const guessed = !signature && this.likelyArgumentList(projection);
      const open = signature
        ? signature.variadic
        : !guessed &&
          (projection.argument_list_complete === false || projection.kind === 'physical');
      if (signature?.variadic && parameters.length === 0) continue;
      if (open) parameters.push(parameters.length ? '...' : 'uintptr_t');
      const text = `extern ${signature?.noreturn ? '_Noreturn ' : ''}${result} ${name}(${parameters.length ? this.writer.join(parameters) : 'void'});`;
      const previous = declarations.get(name);
      declarations.set(
        name,
        previous === null || (previous && previous.text !== text) ? null : { text, node },
      );
    }
    for (const [name, declaration] of declarations) {
      if (!declaration) continue;
      this.declaredFunctions.add(name);
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
      if (!signature)
        this.localValidation.requireAbi(
          'call_declaration',
          [node.id],
          'The declaration describes the observed native call interface under the target ABI, not a proven authored prototype; unresolved trailing arguments remain explicit.',
        );
      const start = this.writer.offset;
      // An open argument list already prints `...`; a closed observed one is marked inferred.
      const guessedList = !signature && this.likelyArgumentList(this.program.calls.get(node.id)!);
      this.writer.line(
        0,
        signature || text.includes('...')
          ? text
          : `${text} /* ${guessedList ? 'likely' : 'inferred'} */`,
      );
      this.mapped(node, start, [], signature?.evidence_ids ?? []);
    }
  }

  /** Functions with a call-site declaration in the header. */
  private readonly declaredFunctions = new Set<string>();

  /** C: functions the finished text names only as values (callback and function
   * pointer constants) need a declaration to be valid; the prototype is unknown. */
  private declareFunctionValues(
    at: number,
    insert: (at: number, lines: readonly string[]) => number,
  ): void {
    if (this.language !== 'c-like') return;
    const lines = [...this.functionValues.values()]
      .filter(({ name }) => !this.declaredFunctions.has(name))
      .map(({ name }) => `extern void ${name}(); /* used as a value; prototype unknown */`);
    if (lines.length) insert(at, lines);
  }

  /** The opaque tags and pointer typedefs a header-declared global's C type mentions. */
  private registerTypedefs(type: VariableType): void {
    for (const name of type.opaque)
      if (!this.deferredTypedefs.includes(name)) this.deferredTypedefs.push(name);
    for (const handle of type.handles)
      if (!this.handleTypedefs.has(handle.name)) {
        this.handleTypedefs.set(handle.name, `typedef ${handle.target}* ${handle.name};`);
        this.deferredTypedefs.push(handle.name);
      }
  }

  /** C only: the header-declared pointer type of the imported object a load reads.
   * Its value is a pointer; integer context reads its address bits. */
  private typedPointerGlobal(node: string): VariableType | undefined {
    if (this.language !== 'c-like') return undefined;
    const declared = this.globals.accesses.get(node)?.object.declared?.type;
    return declared?.kind === 'pointer' ? declared : undefined;
  }

  /** Declarations of every global the finished body names, inserted before the
   * function so the text refers only to declared names. Each is mapped to its
   * first planned access with the image/import evidence of the object. */
  private declareGlobals(
    at: number,
    insert: (at: number, lines: readonly string[]) => number,
  ): void {
    if (!this.usedGlobals.size) return;
    const python = this.language === 'python-like';
    const lines: string[] = [],
      spans: { readonly object: GlobalObject; readonly start: number; readonly end: number }[] = [];
    let offset = at;
    for (const { object: global, name } of this.usedGlobals.values()) {
      this.context.checkpoint(1);
      const declared = global.declared;
      if (declared && !python) this.registerTypedefs(declared.type);
      const type = declared
          ? python
            ? declared.type.python
            : declared.type.c
          : global.element.float
            ? global.element.bits === 32
              ? 'float'
              : 'double'
            : `uint${global.element.bits}_t`,
        first = lines.length;
      // Comment text only: names stay readable, a comment terminator cannot occur.
      const plain = (text: string): string => text.replace(/\*\//g, '* /');
      // Compact for readers: the library basename, plus the native name only when it is
      // not the printed name or its Mach-O `_`-prefixed form. Slot VA, binding records
      // and the declaration's source stay in the mapped evidence. An image VA is stated only
      // where the text does not already carry it (the printed name or a python memory_view).
      const native = global.import?.name;
      const hex = global.address.value.toString(16);
      const where = global.import
        ? `import${native === name || native === `_${name}` ? '' : ` ${plain(native!)}`}${global.import.library === null ? '' : ` from ${plain(global.import.library.slice(global.import.library.lastIndexOf('/') + 1))}`}`
        : [
            ...(python || name.split('_').includes(hex) ? [] : [`VA 0x${hex}`]),
            ...(global.object.byte_length === null ? [] : [`${global.object.byte_length} bytes`]),
            ...(global.object.kind === 'bytes' ? [] : [global.object.kind.replace('_', ' ')]),
          ].join(', ');
      const comment = where === '' ? '' : python ? `  # ${where}` : ` /* ${where} */`;
      if (python) {
        lines.push(
          `${
            global.import
              ? `${name} = import_view(${JSON.stringify(global.import.library ?? '')}, ${JSON.stringify(global.import.name)}, "${type}")`
              : `${name} = memory_view(0x${hex}, "${type}", ${global.object.mutable ? 'True' : 'False'})`
          }${comment}`,
        );
        this.writer.helper(
          global.import ? 'import_view' : 'memory_view',
          global.import
            ? 'Storage view of an imported symbol: arguments are its library, native name and element type. Its address is bound by the dynamic linker, not an image VA; no allocation, extent or bound is implied, and element indices count elements.'
            : 'Image-backed storage view at the declared VA; no allocation or invented extent. Index units are the declared scalar width. Reads retain original byte order, aliasing and faults; no Python sequence bounds or negative-index rebasing.',
        );
      } else
        lines.push(
          declared
            ? `extern ${type}${declared.constant ? ' const' : ''} ${name};${comment}`
            : `extern ${global.object.mutable || global.import ? '' : 'const '}${type} ${name}${global.shape === 'scalar' ? '' : '[]'};${comment}`,
        );
      const length = lines.slice(first).reduce((sum, line) => sum + line.length + 1, 0);
      spans.push({ object: global, start: offset, end: offset + length });
      offset += length;
    }
    const delta = insert(at, lines);
    for (const span of spans) {
      const origin = this.origins.get(span.object.first ?? '') ?? this.input.function;
      this.mapped(
        origin,
        span.start,
        [],
        [
          ...new Set([
            ...span.object.object.evidence_ids,
            ...(span.object.import?.evidence_ids ?? []),
          ]),
        ],
        span.end,
      );
    }
    void delta;
  }

  /** Contents bytes a function's table declarations may print in total. */
  private tableBudget = 1536;

  /** One declaration per (object, element width) the function indexes. A
   * read-only table whose extent is established prints its contents (a bounded
   * prefix when large); otherwise it stays an extern view of unknown extent. */
  private declareDataTables(): void {
    if (!this.sourceView) return;
    interface Group {
      readonly key: string;
      readonly name: string;
      readonly first: string;
      readonly address: string;
      readonly table: IndexedDataAccess;
      reach: bigint;
    }
    const groups = new Map<string, Group>();
    for (const [id, table] of this.indexedData) {
      const node = this.statements.get(id);
      if (node?.kind !== 'load' || !this.permitUnaligned(node)) continue;
      const object = table.data.object;
      if (
        !this.localValidation.presentation(
          'indexed_data_load',
          id,
          'exact mapped data base plus nonwrapping integer index, element-width scaling and aligned symbol displacement; native names use their C spelling; no array bound or string ownership inferred',
          [node.address.id, ...table.terms.map((term) => term.index.id)],
        )
      )
        continue;
      const key = `${this.addressKey(object.address)}:u${table.bits}`;
      const stem =
        table.data.source_name ?? table.data.name ?? `data_${object.address.value.toString(16)}`;
      if (table.data.name !== undefined) this.names.set(key, table.data.name);
      const name = this.sourceIdentifier(key, stem);
      this.dataTables.set(id, { ...table, name });
      const group = groups.get(key);
      if (group) group.reach = group.reach > table.last + 1n ? group.reach : table.last + 1n;
      else
        groups.set(key, {
          key,
          name,
          first: id,
          address: node.address.id,
          table,
          reach: table.last + 1n,
        });
    }
    for (const group of groups.values()) {
      const { table } = group,
        object = table.data.object,
        node = this.statements.get(group.first)!;
      const start = this.writer.offset;
      const contents = this.tableContents(group.name, table, group.reach);
      if (contents) {
        for (const line of contents.lines) this.writer.line(0, line);
        this.writer.helper(
          this.language === 'c-like' ? group.name : 'memory_view',
          'Immutable image bytes of the table at the declared VA, read from a file-backed read-only section with no relocation slot inside. Index units are the declared scalar width; the shown extent is the one the comment names.',
        );
      } else {
        const hex = object.address.value.toString(16);
        const extent =
          object.byte_length === null ? 'extent unknown' : `${object.byte_length} bytes`;
        if (this.language === 'c-like')
          this.writer.line(
            0,
            `extern ${object.mutable ? '' : 'const '}uint${table.bits}_t ${group.name}[]; /* VA 0x${hex}, ${extent} */`,
          );
        else
          this.writer.line(
            0,
            `${group.name} = memory_view(0x${hex}, "uint${table.bits}_t", ${object.mutable ? 'True' : 'False'})  # ${extent}`,
          );
        this.writer.helper(
          this.language === 'c-like' ? group.name : 'memory_view',
          'Image-backed indexed storage view at the declared VA; no allocation or invented extent. Index units are the declared scalar width. Reads retain original byte order, aliasing and faults; no Python sequence bounds or negative-index rebasing.',
        );
      }
      this.mapped(node, start, [group.address], object.evidence_ids);
    }
  }

  /** Declaration lines of a read-only table with its contents, or undefined when
   * its bytes or extent are not established. The element count is the smaller of
   * the accessed range (`reach`: the greatest index every access can take, plus
   * one) and the object's extent (symbol size, else the distance to the next
   * symbol, data record, relocation or section end); an unbounded index over an
   * unsized object shows only the first elements, never an invented extent. */
  private tableContents(
    name: string,
    table: IndexedDataAccess,
    reach: bigint,
  ): { readonly lines: readonly string[] } | undefined {
    const object = table.data.object,
      bytes = table.data.object_bytes,
      width = table.bits / 8;
    if (
      object.mutable ||
      !bytes?.length ||
      table.data.address.value !== object.address.value + object.offset
    )
      return undefined;
    const size = BigInt(width);
    const extent = object.byte_length ?? object.span_bound;
    const bySize = extent === undefined || extent === null ? undefined : extent / size;
    const proven = bySize === undefined ? (reach <= 4096n ? reach : undefined) : undefined;
    const total = bySize !== undefined ? (reach < bySize ? reach : bySize) : proven;
    const full = total !== undefined && total * size <= TABLE_FULL_BYTES;
    let shown = full
      ? total
      : BigInt(
          Math.min(
            total === undefined ? TABLE_UNKNOWN_ELEMENTS : Number(total),
            TABLE_PREFIX_BYTES / width,
          ),
        );
    shown =
      shown! < BigInt(Math.floor(bytes.length / width))
        ? shown!
        : BigInt(Math.floor(bytes.length / width));
    if (shown <= 0n || Number(shown) * width > this.tableBudget) return undefined;
    this.tableBudget -= Number(shown) * width;
    const values: string[] = [];
    for (let index = 0; index < Number(shown); index++) {
      let value = 0n;
      for (let byte = width - 1; byte >= 0; byte--)
        value = (value << 8n) | BigInt(bytes[index * width + byte]!);
      values.push(value < 1n << 32n ? String(value) : `0x${value.toString(16)}`);
    }
    const hex = object.address.value.toString(16);
    const basis =
      object.byte_length != null && bySize !== undefined && total === bySize
        ? 'symbol size'
        : total === undefined
          ? 'extent not established'
          : bySize !== undefined && total === bySize
            ? 'next symbol bound'
            : 'accessed range';
    const rest = total === undefined ? undefined : total - shown;
    const more =
      rest === undefined ? 'further elements not shown' : rest > 0n ? `${rest} more` : undefined;
    const elements = `${total === undefined ? `first ${shown}` : `${total}`} ${this.language === 'c-like' ? '' : `uint${table.bits}_t `}elements`;
    const note = `VA 0x${hex}, read-only; ${elements} (${basis})`;
    const per = Math.max(1, Math.floor(16 / width));
    const rows: string[] = [];
    for (let at = 0; at < values.length; at += per)
      rows.push(
        `${values.slice(at, at + per).join(', ')}${at + per < values.length || more ? ',' : ''}`,
      );
    const length = total === undefined ? '' : String(total);
    if (this.language === 'c-like')
      return {
        lines: [
          `/* ${note} */`,
          `static const uint${table.bits}_t ${name}[${length}] = {`,
          ...rows.map((row) => `  ${row}`),
          ...(more ? [`  /* ... ${more} */`] : []),
          '};',
        ],
      };
    const open = `${name} = (`;
    return {
      lines: [
        `# ${note}`,
        ...(more
          ? [
              `${name} = memory_view(0x${hex}, "uint${table.bits}_t", False)`,
              `# first ${shown} elements: ${values.join(', ')}; ${more}`,
            ]
          : [open, ...rows.map((row) => `    ${row}`), ')']),
      ],
    };
  }

  /** Source-view memory access: `*p` through a declared scalar pointer of the
   * accessed width, otherwise one cast dereference of the actual address. The
   * memory-view annotation stays in mappings and inferences, not in the text. */
  private sourceStorage(node: Extract<Instruction, { kind: 'load' | 'store' }>): string {
    const table = this.dataTables.get(node.id);
    if (table) {
      const wide = table.terms.length > 1 || table.terms.some((term) => term.stride !== 1n);
      let index: Printed | undefined;
      for (const term of table.terms) {
        let part = this.printer.reduce(bitWidth(term.index.type), this.printed(term.index));
        if (wide || table.offset !== 0n) part = this.printer.reduce(64, part);
        if (term.stride !== 1n)
          part = this.printer.binary('*', part, this.printer.literal(term.stride, 64), {
            bits: 64,
            signed: false,
          });
        index = index ? this.printer.binary('+', index, part, { bits: 64, signed: false }) : part;
      }
      if (table.offset !== 0n)
        index = this.printer.binary('+', this.printer.literal(table.offset, 64), index!, {
          bits: 64,
          signed: false,
        });
      return `${table.name}[${index!.text}]`;
    }
    const type = this.accessType(node),
      access = node.access,
      scalar = access.endian === 'little' && !access.volatile && access.alignment === 1,
      plain = type.kind === 'integer' && scalar,
      kind: PointeeKind | null =
        type.kind === 'integer' ? 'integer' : type.kind === 'float' ? 'float' : null;
    const pointerAddress = this.uncast(node.address, ['bitcast']);
    if (this.language === 'c-like' && scalar && kind) {
      const pointer = this.scalarPointerBase(pointerAddress, bitWidth(type), kind);
      if (
        pointer !== null &&
        this.permitUnaligned(node) &&
        this.localValidation.presentation(
          'typed_dereference',
          this.input.function.id,
          'declared scalar pointer of exactly the accessed width and kind at displacement 0',
        )
      )
        return `*${pointer}`;
      const indexed = this.inline.has(pointerAddress.id)
        ? this.typedIndex(pointerAddress, bitWidth(type), kind)
        : null;
      if (
        indexed &&
        this.permitUnaligned(node) &&
        this.localValidation.presentation(
          'typed_index',
          this.input.function.id,
          "declared scalar pointer of exactly the accessed width and kind plus any combination of one index scaled by the element size and a constant byte displacement that is a multiple of it; C subscript scaling yields the same address bits, and a constant joined to an index is added in that index's 64-bit unsigned arithmetic",
        )
      )
        return indexed;
    }
    if (this.language === 'c-like' && plain) {
      const member = this.memberAccess(node.address, bitWidth(type), node.id);
      if (member && this.permitUnaligned(node)) return member;
    }
    let address = this.stringBaseSum(node.address) ?? this.sourceAddressPrinted(node.address);
    // A constant address inside a declared global is that object's own pointer.
    const pointer = this.language === 'c-like' ? this.globalPointer(node.address) : undefined;
    if (pointer !== undefined) address = this.printer.primary(pointer, { bits: 64, signed: false });
    if (this.language === 'python-like') {
      const sum =
        kind && this.inline.has(pointerAddress.id)
          ? this.typedAddressSum(pointerAddress, bitWidth(type), kind)
          : null;
      if (
        sum &&
        this.localValidation.presentation(
          'typed_address_sum',
          this.input.function.id,
          'declared scalar pointer of exactly the accessed width and kind plus an index scaled by the element size and a constant byte displacement that is a multiple of it; one modular sum of the same address bits, memory views stay byte-addressed',
        )
      )
        address = sum;
      const name = `${access.volatile ? 'volatile_' : ''}${access.endian === 'big' ? 'be_' : ''}${type.kind === 'integer' ? `u${type.bits}` : this.program.source?.float_accesses?.has(node.id) ? `f${bitWidth(type)}` : machineType(type)}`;
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
    else if (pointer === undefined && (address.ctype?.bits !== 64 || address.ctype.signed))
      address = {
        text: `(uintptr_t)${this.printer.group(address, UNARY)}`,
        precedence: UNARY,
        ctype: { bits: 64, signed: false },
      };
    let name: string;
    if (this.program.source?.float_accesses?.has(node.id))
      name = type.kind === 'float' && type.bits === 32 ? 'float' : 'double';
    else if (type.kind !== 'integer') name = machineType(type);
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
    const reference = this.objcReference(node);
    if (reference) return this.objcReferenceText(reference);
    const global = this.globals.accesses.get(node.id);
    if (global) {
      const text = this.globalStorage(node, global);
      if (text !== undefined) return text;
    }
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
    /** Print only the call expression, for an inlined single-use result. */
    operand = false,
  ): string {
    const projection = this.program.calls.get(node.id)!;
    const literals: string[] = [],
      objcLiterals: string[] = [];
    const objcCandidate = this.objcSend(node);
    const args = projection.arguments.map((value, index) => {
      this.context.checkpoint(1);
      const parameter = projection.signature?.signature.parameters[index];
      const parameterType = parameter && this.typeRecords.get(parameter.type_id)?.definition;
      const pointer = parameterType?.kind === 'pointer';
      const pointee = pointer ? this.typeRecords.get(parameterType.to)?.definition : undefined;
      const bytePointer =
        pointee?.kind === 'void' || (pointee?.kind === 'integer' && pointee.bits === 8);
      const code =
        !pointer && this.characterParameter(projection, index) ? this.constantOf(value) : undefined;
      const character = code === undefined ? undefined : this.printer.character(code, true);
      if (character && this.printer.simplify('character_literal', [value.id]))
        return character.text;
      const objcLiteral = literalsAllowed ? this.objcLiteral(value) : undefined;
      const literal =
        objcLiteral ??
        (!literalsAllowed || (pointer && !bytePointer)
          ? undefined
          : this.sourceLiteral(value, pointer && bytePointer));
      if (objcLiteral !== undefined) objcLiterals.push(value.id);
      else if (literal !== undefined) literals.push(value.id);
      // A declared pointer local (or held call result), possibly through inline
      // same-width bitcasts of its bits, already has the parameter's pointer
      // spelling, or is a message operand: no conversion is printed.
      let operandValue = value;
      for (let step = 0; step < 4 && this.inline.has(operandValue.id); step++) {
        if (this.pendingCalls.has(operandValue.id)) break;
        const alias = this.program.expressions.get(operandValue.id);
        if (
          alias?.kind !== 'cast' ||
          alias.op !== 'bitcast' ||
          bitWidth(alias.value.type) !== bitWidth(operandValue.type)
        )
          break;
        operandValue = alias.value;
      }
      const declared =
        this.sourceView &&
        this.language === 'c-like' &&
        literal === undefined &&
        (this.pendingCalls.has(operandValue.id) || !this.inline.has(operandValue.id))
          ? this.declaredSpelling(operandValue)
          : '';
      if (
        declared.endsWith('*') &&
        (pointer
          ? this.callParameterType(projection, index) === declared
          : objcCandidate !== undefined)
      )
        return this.local(operandValue);
      // A message operand read from a declared pointer member or typed global is
      // that lvalue itself: message syntax needs no integer conversion.
      const loaded =
        objcCandidate && literal === undefined && this.sourceView
          ? this.inlined.get(operandValue.id)?.node
          : undefined;
      if (loaded?.kind === 'load' && this.inline.has(operandValue.id)) {
        const storage = this.storage(loaded);
        if (this.memberPointers.has(loaded.id) || this.typedPointerGlobal(loaded.id))
          return storage;
      }
      const printed = pointer
        ? literal === undefined
          ? this.sourceAddressPrinted(value, !this.sourceView)
          : undefined
        : literal === undefined
          ? this.printed(value)
          : undefined;
      const text = literal ?? printed!.text;
      // A message operand needs no C parameter conversion: message syntax has none.
      if (pointer && objcCandidate && literal === undefined) return this.value(value);
      if (pointer && this.language === 'c-like') {
        const spelling = this.callParameterType(projection, index);
        if (literal !== undefined)
          return /^(?:const )?(?:char|void)\s*\*$/.test(spelling)
            ? literal
            : `(${spelling})${literal}`;
        const loaded = this.inlined.get(value.id)?.node;
        if (loaded?.kind === 'load' && this.typedPointerGlobal(loaded.id)?.c === spelling)
          return this.storage(loaded);
        return this.pointerValue(printed!, spelling);
      }
      const type = parameter && this.typeRecords.get(parameter.type_id)?.definition;
      if (type?.kind === 'integer' && type.signed && this.language === 'python-like')
        return this.call(
          `int${type.bits}`,
          'Interpret source integer argument with its established signed ABI type.',
          [text],
        );
      // A declared prototype converts an argument to its parameter type: the
      // value's own signed variable passes unchanged to a signed parameter.
      if (printed && type?.kind === 'integer' && type.signed && this.language === 'c-like')
        return this.signedContext(printed, type.bits);
      // An undeclared parameter reads the callee's observed interface: an
      // argument that is a declared pointer variable passes as that pointer.
      if (printed?.pointer && !parameter && this.language === 'c-like') return printed.pointer.text;
      return text;
    });
    if (
      (literals.length &&
        !this.localValidation.presentation(
          'string_literal',
          node.id,
          STRING_LITERAL_SCOPE,
          literals,
        )) ||
      (objcLiterals.length &&
        !this.localValidation.presentation(
          'objc_string_literal',
          node.id,
          'pointer-width constant call arguments addressing an exact __cfstring constant object (isa bound to ___CFConstantStringClassReference, explicit length), printed as that NSString literal',
          objcLiterals,
        ))
    )
      return this.sourceCall(node, depth, false, operand);
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
    const guessed = this.likelyArgumentList(projection);
    const open =
      !guessed && (projection.argument_list_complete === false || projection.kind === 'physical');
    if (open)
      args.push(
        this.openArguments(
          projection.arguments.length ? 'unknown_argument_remainder' : 'unknown_arguments',
          'Unresolved remainder of a call interface; not zero arguments or a purity claim.',
        ),
      );
    // Source view: a resolved selector prints the message instead of the dispatcher.
    const candidate = objcCandidate;
    const send =
      candidate &&
      this.localValidation.presentation(
        'objc_message',
        node.id,
        `${candidate.message.form} call presented as an Objective-C message: receiver, statically resolved selector ${this.writer.quote(candidate.message.selector)} and one keyword per selector colon${candidate.message.variadic ? ', then the variadic actuals' : ''}; the dispatcher target and selector argument stay in this record`,
        [node.id],
      )
        ? candidate
        : undefined;
    let target = send ? '' : this.sourceCallee(node);
    if (!send)
      this.writer.helper(
        target,
        `${projection.kind === 'source' ? 'Established' : 'Inferred or incomplete'} source call. Original target: ${node.target.kind === 'direct' ? this.writer.quote(this.addressKey(node.target.address)) : 'indirect'}. Original memory effect: ${node.clobbers.memory}. Calls remain ordered; unused machine clobbers are not source results.`,
      );
    if (
      !send &&
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
    let operation: string;
    if (send) {
      const { message, skip, arity } = send;
      operation = this.guarded(
        objcMessageText(
          this.language,
          message,
          this.objcReceiver(projection.arguments[0]!, args[0]!),
          args.slice(skip, skip + arity),
          args.slice(skip + arity),
        ),
      );
    } else {
      operation = `${target}(${this.writer.join(args)})`;
      if (guessed) operation = this.likelyCall(operation);
    }
    if (operand) return operation;
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

  /** A tail transfer returns its callee's result; a proven-void callee is a
   * call statement followed by a plain return. */
  private tailStatement(depth: number, call: string, empty: boolean): void {
    if (!empty) return this.writer.statement(depth, `return ${call}`);
    this.writer.statement(depth, call);
    this.writer.statement(depth, 'return');
  }

  /** Message receiver text: a class-reference load (through same-width bitcasts,
   * inline or as its SSA local) names its class; otherwise the printed operand,
   * parenthesized in Python unless it is a plain name or attribute path. */
  private objcReceiver(receiver: Value, printed: string): string {
    for (let step = 0; step < 4; step++) {
      const alias = this.program.expressions.get(receiver.id);
      if (
        alias?.kind !== 'cast' ||
        alias.op !== 'bitcast' ||
        bitWidth(alias.value.type) !== bitWidth(receiver.type)
      )
        break;
      receiver = alias.value;
    }
    const load =
      this.inlined.get(receiver.id)?.node ??
      this.statements.get(this.origins.get(receiver.id)?.id ?? '');
    const reference = load?.kind === 'load' ? this.objcReference(load) : undefined;
    const text =
      reference?.kind === 'class_ref' ? this.objcReferenceText(reference, true) : printed;
    return this.language === 'python-like' && !/^[A-Za-z_$][\w$.]*$/.test(text)
      ? `(${text})`
      : text;
  }

  /** An inlined call has no assignment to convert it: its printed result type
   * (the declared return type, or the result's own) must be its variable's. */
  private admitInlinedCall(node: InlineCall, result: Value): boolean {
    const projection = this.program.calls.get(node.id);
    const declared = projection?.signature?.signature;
    return (
      this.rejectedCalls?.has(result.id) === false &&
      projection?.results.length === 1 &&
      !(
        this.nativeIntegerStorage &&
        result.type.kind === 'integer' &&
        integerStorageBits(result.type.bits) !== result.type.bits
      ) &&
      (!declared ||
        ((projection && this.callResultSpelling(projection)) ??
          this.sourceType(declared.return_type)) === this.valueType(result))
    );
  }

  /** Print an inlined call's expression now (its notes, comments and clobber
   * statements keep the call's position) and hold it for its reader. */
  private holdCall(node: InlineCall, site: InlineCallSite, depth: number): void {
    this.settleReader();
    this.emitNotes(node.id, depth);
    const text = this.sourceCall(node, depth, true, true);
    this.settleCalls(text);
    this.pendingCalls.set(site.result.id, text);
    this.heldLines = this.writer.codeLines;
  }

  /** Every held call is printed exactly once in the text of the reader that
   * consumes it, with no other code between; anything else would drop, repeat
   * or reorder the call. The emission is then retried without call inlining. */
  private settleCalls(text: string): void {
    for (const [id, call] of this.pendingCalls) {
      if (text.split(call).length !== 2) throw new CallInliningRetry([...this.pendingCalls.keys()]);
      this.pendingCalls.delete(id);
    }
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
      const literal =
        expression.kind === 'constant' || expression.kind === 'address'
          ? this.valueLiteral(node.result, this.declaredSpelling(node.result), false)
          : undefined;
      return `${this.local(node.result)} = ${this.assignedText(
        node.result,
        literal ?? this.expression(expression, this.expressionType(node.result)),
        expression,
      )}`;
    }
    storage ??= this.storage(node);
    const member = this.memberPointers.get(node.id);
    if (member && this.program.live.has(node.result.id)) {
      const spelling = this.declaredSpelling(node.result);
      return `${this.local(node.result)} = ${
        spelling === this.sourceType(member)
          ? storage
          : spelling.endsWith('*')
            ? `(${spelling})${storage}`
            : `(uintptr_t)${storage}`
      }`;
    }
    const typed = this.language === 'c-like' ? this.slotType(node.id) : undefined;
    if (typed && this.program.live.has(node.result.id)) {
      const spelling = this.declaredSpelling(node.result);
      return `${this.local(node.result)} = ${
        spelling.replace(/^const /, '') === this.formalSpelling(typed).replace(/^const /, '')
          ? storage
          : spelling.endsWith('*')
            ? `(${spelling})${storage}`
            : `(uintptr_t)${storage}`
      }`;
    }
    const global = this.typedPointerGlobal(node.id);
    if (global && this.program.live.has(node.result.id)) {
      const spelling = this.declaredSpelling(node.result);
      return `${this.local(node.result)} = ${
        spelling === global.c
          ? storage
          : spelling.endsWith('*')
            ? `(${spelling})${storage}`
            : `(uintptr_t)${storage}`
      }`;
    }
    return this.program.live.has(node.result.id)
      ? `${this.local(node.result)} = ${
          this.sourceInterpretation(node.result, {
            text: storage,
            precedence: storage.startsWith('*') ? UNARY : 16,
            ctype: node.kind === 'load' ? this.loadCType(node, storage) : null,
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
        const imported = node.kind === 'load' ? this.globals.import_loads.get(node.id) : undefined;
        if (node.kind === 'load' && imported) {
          // The binding slot is not read: the load is the imported symbol's address.
          if (!this.program.live.has(node.result.id)) {
            this.map(node, start);
            this.mapMemory(node, start);
            return;
          }
          text = `${this.local(node.result)} = ${this.importAddress(imported).text}`;
          break;
        }
        if (this.program.source) {
          const storage = this.storage(node);
          if (node.kind === 'store') {
            // Storing converts to the lvalue's own width (a local is declared
            // unsigned; a dereference has exactly the stored width).
            const typed = this.language === 'c-like' ? this.slotType(node.id) : undefined;
            const floating = this.floatSlot(node.id);
            const pointer = typed && this.pointerText(node.value, typed);
            const member = this.memberPointers.get(node.id);
            const literal =
              !floating && !pointer && !member
                ? this.valueLiteral(node.value, typed ? this.formalSpelling(typed) : undefined)
                : undefined;
            text = `${storage} = ${
              pointer ??
              (member && this.memberPointerValue(node.value, member)) ??
              (floating
                ? this.floatingValue(node.value, floating).text
                : literal
                  ? literal.text
                  : typed
                    ? `(${this.formalSpelling(typed)})(uintptr_t)${this.printer.group(this.printed(node.value), UNARY)}`
                    : this.converted(this.printed(node.value), bitWidth(node.value.type)))
            }`;
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
          !this.fpPresentation.unobserved.has(binding.value.id) &&
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
        [
          ...nesting,
          {
            kind: 'loop',
            header: region.header,
            follow,
            ...(region.once ? { once: true as const } : {}),
          },
        ],
        depth + 1,
        region.once ? follow : region.header,
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
        item.joins ? 'shared-arm' : performed.find((entry) => entry.arm === item)?.action,
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
      const landing = (item: ControlArm): string | null =>
        item.body ? this.firstBlock(item.body) : follow;
      if (this.sourceView) {
        // Grouped and omitted case edges reach the arm printed for them.
        const plan = this.switchGroups(control);
        for (const group of plan.groups) {
          this.context.checkpoint(group.members.length + 1);
          arm(group.arm, nested);
          for (const member of group.members) decide(member.transfer, nested, landing(group.arm));
        }
        arm(control.otherwise, nested);
        for (const item of plan.omitted) decide(item.transfer, nested, landing(control.otherwise));
      } else {
        for (const item of control.cases) {
          this.context.checkpoint(1);
          arm(item.arm, nested);
        }
        arm(control.otherwise, nested);
      }
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
                !this.inline.has(copy.destination.id) &&
                !this.forwardedCopies.get(transfer)?.has(copy.destination.id)
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

  /** No member of the printed variable `value` belongs to is ever written or read. */
  private vanishedVariable(value: Value): boolean {
    if (!this.vanished.has(value.id)) return false;
    const representative = this.variables.get(value.id)?.id ?? value.id;
    for (const [id, other] of this.variables)
      if (other.id === representative && !this.vanished.has(id)) return false;
    return true;
  }

  /** Source view: a return tail printed as owned copies has no other way in
   * than the edge each copy follows. A block parameter such a tail returns,
   * written from a constant by an edge every printed occurrence of which is
   * followed by such a copy, read nowhere else and used by nothing but that
   * return, is the constant: the edge copy and the carrier are dropped and
   * each `return` prints the constant. An edge that still reaches the tail's
   * home (a goto or fallthrough) keeps its copy, and with it the carrier. A
   * parameter written this way by every edge of a fully duplicated tail is
   * never printed at all. */
  private planReturnConstants(layout: LayoutPlan): void {
    const program = this.program;
    const occurrences = new Map<ParallelTransfer, Occurrence[]>();
    visitTransfers(layout.body, this.language, this.context, (occurrence) => {
      const list = occurrences.get(occurrence.transfer) ?? [];
      list.push(occurrence);
      occurrences.set(occurrence.transfer, list);
    });
    // A tail every printed entry of which is a fallthrough into a printed copy of
    // it (never a goto, break or continue) and every copy of which (its home
    // included) is entered by exactly one printed edge is, for that edge, an
    // owned copy; a join entered by several arms is not.
    const entered = new Map<string, boolean>();
    const entries = new Map<BlockRegion, number>();
    for (const [transfer, list] of occurrences)
      for (const occurrence of list) {
        const destination = occurrence.destination;
        if (destination?.kind === 'block')
          entries.set(destination, (entries.get(destination) ?? 0) + 1);
        entered.set(
          transfer.target,
          (entered.get(transfer.target) ?? true) &&
            destination?.kind === 'block' &&
            destination.id === transfer.target &&
            occurrenceAction(occurrence, this.language) === 'fallthrough',
        );
      }
    const substituted = new Set<string>();
    for (const [transfer, list] of occurrences) {
      this.context.checkpoint(list.length);
      const tail = program.blocks.get(transfer.target),
        control = tail?.control;
      if (!tail || control?.kind !== 'return') continue;
      const projection = program.returns.get(control.id);
      if (!projection || projection.kind === 'physical' || projection.outputs.length) continue;
      const copies: BlockRegion[] = [];
      const sole = entered.get(transfer.target) === true;
      for (const occurrence of list) {
        const destination = occurrence.destination;
        if (
          destination?.kind === 'block' &&
          (layout.clones.has(destination) || (sole && entries.get(destination) === 1)) &&
          destination.id === transfer.target &&
          occurrenceAction(occurrence, this.language) === 'fallthrough'
        )
          copies.push(destination);
      }
      if (copies.length !== list.length) continue;
      for (const result of projection.results) {
        // The returned value is the carrier itself or an inline conversion of it.
        const chain: Value[] = [result];
        let carrier: Value | undefined;
        while (chain.length <= 8) {
          const value = chain[chain.length - 1]!;
          if (tail.parameters.some((parameter) => parameter.id === value.id)) {
            carrier = value;
            break;
          }
          const expression = this.inline.has(value.id)
            ? program.expressions.get(value.id)
            : undefined;
          if (
            expression?.kind !== 'cast' ||
            !['zero_extend', 'sign_extend', 'truncate', 'bitcast'].includes(expression.op)
          )
            break;
          chain.push(expression.value);
        }
        if (!carrier || chain.some((value) => program.use_counts.get(value.id) !== 1)) continue;
        const move = (program.transfers.get(transfer) ?? []).find(
            (candidate) => candidate.destination.id === carrier.id,
          ),
          constant = move && program.expressions.get(move.source.id);
        if (
          !move ||
          constant?.kind !== 'constant' ||
          !this.inline.has(move.source.id) ||
          bitWidth(move.source.type) !== bitWidth(carrier.type) ||
          move.source.type.kind !== carrier.type.kind ||
          !this.localValidation.presentation(
            'return_constant',
            control.id,
            'a block parameter written from a constant by an edge that every printed occurrence of which is followed by its own copy of the return tail, read only through the conversions that form that return\u2019s value, is that constant on every path through the copy: the edge copy and the carrier are dropped and the return states the constant',
            [carrier.id, move.source.id],
          )
        )
          continue;
        for (const copy of copies) {
          const values = this.returnConstants.get(copy) ?? new Map<string, Value>();
          values.set(carrier.id, move.source);
          this.returnConstants.set(copy, values);
        }
        const dropped = this.forwardedCopies.get(transfer) ?? new Set<string>();
        dropped.add(carrier.id);
        this.forwardedCopies.set(transfer, dropped);
        substituted.add(tail.id);
      }
    }
    const hidden = new Set([...layout.hidden, ...substituted]);
    for (const id of hidden) {
      const home = program.blocks.get(id);
      if (!home) continue;
      const edges = [...program.transfers.keys()].filter((transfer) => transfer.target === id);
      for (const parameter of home.parameters)
        if (
          edges.length &&
          edges.every((transfer) => this.forwardedCopies.get(transfer)?.has(parameter.id))
        )
          this.vanished.add(parameter.id);
    }
  }

  /** Edge copies actually printed: a coalesced class's self-copy is no move. */
  private printedCopies(
    transfer: ParallelTransfer,
  ): readonly { readonly destination: Value; readonly source: Value }[] {
    const all = this.program.transfers.get(transfer) ?? [];
    const forwarded = this.forwardedCopies.get(transfer);
    const copies = forwarded ? all.filter((copy) => !forwarded.has(copy.destination.id)) : all;
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

  /** Source view: a trap whose block ends in a call established as noreturn
   * adds nothing a reader of that call does not know. */
  private noreturnCallExit(
    control: Extract<Control, { kind: 'trap' }>,
    block: BlockRegion,
  ): boolean {
    const last = block.statements.at(-1);
    return (
      this.sourceView &&
      last?.kind === 'call' &&
      this.input.types?.calls?.calls.some(
        (call) => call.node_id === last.id && call.noreturn === 'yes',
      ) === true &&
      this.localValidation.presentation(
        'noreturn_call_exit',
        control.id,
        `trap terminator implied by the preceding call to a noreturn callee; reason ${this.writer.quote(control.reason)} and the physical exit state stay in this record`,
        [control.id, last.id],
      )
    );
  }

  /** A loop test's exit edge. Copy-free, the loop syntax performs it; its
   * copies print right after the loop instead (planLoopForms proved no other
   * edge from inside the loop reaches the continuation). */
  private loopExit(transfer: ParallelTransfer, depth: number, control: Control): void {
    if (this.printedCopies(transfer).length) this.loopExitCopies.set(control.id, transfer);
    else this.transfer(transfer, depth, control);
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
    inverted?: Value,
    /** Exact complement of `condition` (a flag-carried short circuit). */
    complement?: Printed,
  ): void {
    const c = this.language === 'c-like';
    const negate = (printed: Printed, flip?: Extract<Expression, { kind: 'compare' }>): string =>
      flip
        ? this.expression({ ...flip, op: NEGATED_PREDICATE[flip.op] }, compared.type).text
        : c
          ? `!${this.printer.group(printed, UNARY)}`
          : `not ${this.printer.group(printed, PRIMARY)}`;
    // The complement of an inline logical negation is its operand.
    const test = (positive: boolean): string =>
      positive
        ? condition.text
        : complement
          ? complement.text
          : inverted
            ? this.printed(inverted).text
            : negate(condition, compare);
    const form = this.loopTests.get(control.id);
    if (form?.kind === 'while' && form.chain) {
      const stage = form.chain.find((item) => item.test === control.id)!;
      if (control.id === form.test) {
        const start = this.writer.offset;
        const operands = form.chain.map((item) => {
          const flag = this.flagTests.get(item.test);
          if (flag) {
            const merged = this.flagCondition(flag);
            return `(${(item.enter ? merged.positive : merged.negative).text})`;
          }
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
      this.loopExit(exit.transfer, depth, control);
      this.arm(enter, depth, control);
      return;
    }
    if (form?.kind === 'for') {
      // The header printed this test and the step; both arms are the loop's own.
      const again = form.enter ? control.when_true : control.when_false,
        leave = form.enter ? control.when_false : control.when_true;
      this.transfer(again.transfer, depth, control);
      this.loopExit(leave.transfer, depth, control);
      return;
    }
    if (form?.kind === 'do_while') {
      const again = form.repeat ? control.when_true : control.when_false,
        leave = form.repeat ? control.when_false : control.when_true;
      // The repeat copies run before the test; planning proved this unobservable.
      this.transfer(again.transfer, depth, control);
      this.loopExit(leave.transfer, depth, control);
      const restated = this.rebased.get(control.id);
      const text = restated
        ? form.repeat
          ? this.expression(restated, control.condition.type).text
          : negate(this.expression(restated, control.condition.type), restated)
        : test(form.repeat);
      this.writer.line(depth - 1, `} while (${text});`);
      return;
    }
    // Conjuncts of enclosing `if`s whose only content is this `if` (see nestedIf).
    const pending = this.conjunct;
    this.conjunct = undefined;
    const term = (positive: boolean): ConditionTerm => ({
      printed: positive
        ? condition
        : (complement ??
          (inverted
            ? this.printed(inverted)
            : compare
              ? this.expression({ ...compare, op: NEGATED_PREDICATE[compare.op] }, compared.type)
              : this.printer.not(condition))),
      value: control.condition,
      positive,
      ...(complement ? { opaque: true as const } : {}),
    });
    const open = (positive: boolean): void => {
      const text = pending ? this.conjunction([...pending, term(positive)]) : test(positive);
      this.writer.line(depth, c ? `if (${text}) {` : `if ${text}:`);
    };
    const close = (): void => {
      if (c) this.writer.line(depth, '}');
    };
    const yes = control.when_true,
      no = control.when_false;
    // A short-circuit head or operand whose leaving edges share one arm body
    // (planSharedArms): the last operand prints the whole `if`/`else`.
    const own = [yes, no].find((arm) => arm.shared),
      joined = [yes, no].find((arm) => arm.joins);
    if (own || joined) {
      if (pending) this.invalid('A shared-arm test was merged into an enclosing condition');
      const plan = own
        ? { arm: own, origin: control, form: own.shared!, terms: [] as ConditionTerm[] }
        : this.sharedPlan;
      if (!plan) this.invalid('A joined condition operand has no shared arm');
      this.sharedPlan = undefined;
      const exit = (own ?? joined)!,
        stay = exit === yes ? no : yes;
      const terms = [...plan.terms, term(plan.form === 'any' ? exit === yes : stay === yes)];
      const flat = (region: Region): Region[] =>
        region.kind === 'sequence' ? region.regions.flatMap(flat) : [region];
      const last = stay.body ? flat(stay.body).at(-1) : undefined;
      if (
        last?.kind === 'block' &&
        last.control.kind === 'if' &&
        (last.control.when_true.joins || last.control.when_false.joins)
      ) {
        // The next operand continues this condition.
        this.sharedPlan = { ...plan, terms };
        if (!own) this.transfer(exit.transfer, depth, control);
        this.arm(stay, depth, control);
        if (this.sharedPlan) this.invalid('A shared-arm condition was not printed');
        return;
      }
      const text =
        plan.form === 'any'
          ? terms
              .slice(1)
              .reduce(
                (all, item) => this.printer.logical('or', all, item.printed),
                terms[0]!.printed,
              ).text
          : this.conjunction(terms);
      this.writer.line(depth, c ? `if (${text}) {` : `if ${text}:`);
      if (!own) this.transfer(exit.transfer, depth + 1, control);
      const branches: [ControlArm, Control][] = [
        [stay, control],
        [plan.arm, plan.origin],
      ];
      if (plan.form === 'any') branches.reverse();
      this.arm(branches[0]![0], depth + 1, branches[0]![1]);
      this.writer.line(depth, c ? '} else {' : 'else:');
      this.arm(branches[1]![0], depth + 1, branches[1]![1]);
      close();
      return;
    }
    const shaped =
      (this.emptyArm(yes) || this.emptyArm(no) || this.terminates(yes) || this.terminates(no)) &&
      this.localValidation.presentation(
        'branch_layout',
        this.input.function.id,
        'an empty arm is dropped (inverting the exact integer test) and an arm that cannot fall through ends its if; the other arm follows unchanged',
      );
    // `if (A) { if (B) S }` with nothing else printed in either `if` is
    // `if (A && B) S`: B still runs only when A holds, in the same order.
    if (shaped && this.emptyArm(no) !== this.emptyArm(yes)) {
      const positive = this.emptyArm(no),
        body = positive ? yes : no,
        inner = this.nestedIf(body);
      if (
        inner &&
        this.localValidation.presentation(
          'nested_condition_merge',
          control.id,
          'an if whose only printed content is another else-less if (no statements, definitions, labels, notes or edge copies between them) and whose other arm prints nothing becomes one if over the short-circuit conjunction; the inner test is still evaluated only when the outer one holds',
          [inner],
        )
      ) {
        this.conjunct = [...(pending ?? []), term(positive)];
        this.transfer((positive ? no : yes).transfer, depth, control);
        this.arm(body, depth, control);
        if (this.conjunct) this.invalid('A merged condition was not printed');
        return;
      }
    }
    if (shaped && this.emptyArm(no)) {
      open(true);
      this.transfer(no.transfer, depth + 1, control);
      if (this.emptyArm(yes)) {
        this.transfer(yes.transfer, depth + 1, control);
        if (!c) this.writer.statement(depth + 1, 'pass');
      } else this.arm(yes, depth + 1, control);
      close();
    } else if (shaped && this.emptyArm(yes)) {
      open(false);
      this.transfer(yes.transfer, depth + 1, control);
      this.arm(no, depth + 1, control);
      close();
    } else if (pending) this.invalid('A merged condition reached an if with an else');
    else if (shaped) {
      const first = this.terminates(yes) ? yes : no;
      open(first === yes);
      this.arm(first, depth + 1, control);
      close();
      this.arm(first === yes ? no : yes, depth, control);
    } else {
      open(true);
      this.arm(yes, depth + 1, control);
      this.writer.line(depth, c ? '} else {' : 'else:');
      this.arm(no, depth + 1, control);
      close();
    }
  }

  /** An inlined zero extension does not change which case matches when every
   * case value fits its operand, so that narrower operand is the selector. */
  private switchSelector(control: Extract<Control, { kind: 'switch' }>): Value {
    const expression = this.inline.has(control.value.id)
      ? this.program.expressions.get(control.value.id)
      : undefined;
    if (
      expression?.kind !== 'cast' ||
      expression.op !== 'zero_extend' ||
      expression.value.type.kind !== 'integer' ||
      !control.cases.every((item) => item.bits < 1n << BigInt(bitWidth(expression.value.type))) ||
      !this.localValidation.presentation(
        'switch_selector_extension',
        control.id,
        'a zero-extended selector whose case values all fit the unextended operand is switched on that operand; the same case matches for every value',
        [control.value.id, expression.value.id],
      )
    )
      return control.value;
    return expression.value;
  }

  /** Source-view case layout. A copy-free, bodiless case arm reaching another
   * case's target is a label of that case (one arm prints for the group);
   * one reaching a copy-free `otherwise` target is left to `default`. */
  private switchGroups(control: Extract<Control, { kind: 'switch' }>): {
    readonly groups: readonly {
      readonly labels: readonly bigint[];
      readonly arm: ControlArm;
      readonly members: readonly ControlArm[];
    }[];
    readonly omitted: readonly ControlArm[];
  } {
    const quiet = (arm: ControlArm): boolean =>
      !arm.body && this.printedCopies(arm.transfer).length === 0;
    const fallback =
      this.printedCopies(control.otherwise.transfer).length === 0
        ? control.otherwise.transfer.target
        : null;
    // Only copy-free arms share labels: a bodiless one joins the first copy-free
    // arm owning its target's body (or the first such bodiless arm).
    const owners = new Map<string, ControlArm>();
    for (const item of control.cases)
      if (
        item.arm.body &&
        this.printedCopies(item.arm.transfer).length === 0 &&
        !owners.has(item.arm.transfer.target)
      )
        owners.set(item.arm.transfer.target, item.arm);
    for (const item of control.cases)
      if (quiet(item.arm) && !owners.has(item.arm.transfer.target))
        owners.set(item.arm.transfer.target, item.arm);
    const groups = new Map<
      ControlArm,
      { labels: bigint[]; arm: ControlArm; members: ControlArm[] }
    >();
    const omitted: ControlArm[] = [];
    for (const item of control.cases) {
      this.context.checkpoint(1);
      const arm = item.arm;
      if (quiet(arm) && arm.transfer.target === fallback) {
        omitted.push(arm);
        continue;
      }
      const owner = quiet(arm) ? (owners.get(arm.transfer.target) ?? arm) : arm;
      let group = groups.get(owner);
      if (!group) {
        group = { labels: [], arm: owner, members: [] };
        groups.set(owner, group);
      }
      group.labels.push(item.bits);
      if (arm !== owner) group.members.push(arm);
    }
    return { groups: [...groups.values()], omitted };
  }

  /** Source-view switch: decimal labels, grouped as planned by switchGroups;
   * grouped and omitted case edges land where the arm printed for them does.
   * An empty `default` is dropped and an arm that cannot fall through ends
   * without `break`. */
  private sourceSwitch(control: Extract<Control, { kind: 'switch' }>, depth: number): void {
    const c = this.language === 'c-like';
    const landing = (arm: ControlArm): EmittedEdge | undefined =>
      arm.body
        ? { kind: 'goto', target: firstBlock(arm.body) ?? arm.transfer.target }
        : this.emittedEdges.get(arm.transfer);
    const plan = this.switchGroups(control);
    let printed = 0;
    for (const group of plan.groups) {
      this.context.checkpoint(group.labels.length);
      const labels = group.labels.map((bits) => bits.toString());
      const scoped = c && this.armDeclares(group.arm);
      if (c) {
        for (const label of labels.slice(0, -1)) this.writer.line(depth + 1, `case ${label}:`);
        this.writer.line(depth + 1, `case ${labels.at(-1)!}:${scoped ? ' {' : ''}`);
      } else this.writer.line(depth + 1, `case ${labels.join(' | ')}:`);
      this.arm(group.arm, depth + 2, control);
      const edge = landing(group.arm);
      if (edge) for (const member of group.members) this.emittedEdges.set(member.transfer, edge);
      if (c) {
        if (!this.terminates(group.arm)) this.writer.statement(depth + 2, 'break');
        if (scoped) this.writer.line(depth + 1, '}');
      }
      printed++;
    }
    if (this.emptyArm(control.otherwise) && (c || printed)) {
      this.transfer(control.otherwise.transfer, depth + 2, control);
    } else {
      const scoped = c && this.armDeclares(control.otherwise);
      this.writer.line(depth + 1, c ? `default:${scoped ? ' {' : ''}` : 'case _:');
      this.arm(control.otherwise, depth + 2, control);
      if (c) {
        if (!this.terminates(control.otherwise)) this.writer.statement(depth + 2, 'break');
        if (scoped) this.writer.line(depth + 1, '}');
      }
    }
    const edge = landing(control.otherwise);
    if (edge) for (const arm of plan.omitted) this.emittedEdges.set(arm.transfer, edge);
    if (c) this.writer.line(depth, '}');
  }

  /** A C declaration is not a statement: `case N:` cannot label one, and it would
   * stay in scope for the labels after it. An arm whose printing may declare
   * (parallel-copy cycle temporaries, loop exit flags; any program
   * without source reconstruction) keeps its braces. Nested arms count
   * as well: a flattened `else` prints at the arm's own level. */
  private armDeclares(arm: ControlArm): boolean {
    if (!this.program.source || this.printedCopies(arm.transfer).length > 1) return true;
    return arm.body !== undefined && this.regionDeclares(arm.body);
  }

  private regionDeclares(region: Region): boolean {
    this.context.checkpoint(1);
    if (region.kind === 'sequence') return region.regions.some((part) => this.regionDeclares(part));
    if (region.kind === 'loop') return true;
    const control = region.control;
    const arms =
      control.kind === 'if'
        ? [control.when_true, control.when_false]
        : control.kind === 'switch'
          ? [...control.cases.map((item) => item.arm), control.otherwise]
          : [];
    return (
      (control.kind === 'jump' && this.printedCopies(control.transfer).length > 1) ||
      arms.some((arm) => this.armDeclares(arm))
    );
  }

  private emptyArm(arm: ControlArm): boolean {
    return !arm.body && this.silentTransfer(arm.transfer);
  }

  /** A fallthrough edge whose printed copies all moved into a `for` header. */
  private silentTransfer(transfer: ParallelTransfer): boolean {
    return (
      this.actions.get(transfer) === 'fallthrough' &&
      this.printedCopies(transfer).length === (this.hoisted.get(transfer)?.size ?? 0)
    );
  }

  /** The `if` control an arm consists of, when nothing of the arm prints before
   * it (silent jump blocks aside) and it prints with exactly one non-empty arm
   * and no `else`. */
  private nestedIf(arm: ControlArm): string | null {
    if (!arm.body || !this.silentTransfer(arm.transfer)) return null;
    const blocks: BlockRegion[] = [];
    const flatten = (region: Region): boolean => {
      if (region.kind === 'sequence') return region.regions.every(flatten);
      if (region.kind !== 'block') return false;
      blocks.push(region);
      return true;
    };
    if (!flatten(arm.body) || !blocks.length) return null;
    const definitions = this.program.source?.definitions;
    const printed = (anchor: string): boolean =>
      definitions?.get(anchor)?.some((definition) => !this.inlined.has(definition.result.id)) ??
      false;
    for (const [index, block] of blocks.entries()) {
      const control = block.control;
      // A flag short-circuit head prints nothing; its merge test follows.
      const flag = this.flagHeads.get(block.id),
        head = flag !== undefined && flag.merge === blocks[index + 1]?.id;
      if (
        this.notes.has(block.id) ||
        this.notes.has(control.id) ||
        (this.labels.has(block.id) && !this.clones.has(block)) ||
        printed(block.id) ||
        printed(control.id) ||
        block.statements.some(
          (node) =>
            printed(node.id) ||
            (this.program.retained.has(node.id) &&
              !this.flagAccesses.has(node.id) &&
              !('result' in node && this.inlined.has(node.result.id))),
        ) ||
        (index < blocks.length - 1 &&
          !head &&
          (control.kind !== 'jump' || !this.silentTransfer(control.transfer)))
      )
        return null;
    }
    const control = blocks.at(-1)!.control;
    return control.kind === 'if' &&
      !this.loopTests.has(control.id) &&
      !this.requirementPredicates.has(control.id) &&
      this.emptyArm(control.when_true) !== this.emptyArm(control.when_false)
      ? control.id
      : null;
  }

  /** The conjunction of merged `if` tests. When every test is an inline
   * predicate over shared operands, the exact enumerated-outcome fold of the
   * conjunction (IEEE less/equal/greater/unordered; integer relations) may be
   * one simpler predicate, e.g. `!(x < 0 || x > 0) && !isunordered(x, 0)` is
   * `x == 0`. Folded operands are leaves the merged tests already read here. */
  private conjunction(terms: readonly ConditionTerm[]): string {
    let plain = terms[0]!.printed;
    for (const item of terms.slice(1)) plain = this.printer.logical('and', plain, item.printed);
    if (terms.some((item) => item.opaque)) return plain.text;
    const created = new Map<string, Expression>();
    const make = (key: string, type: DataType, expression?: Expression): Value => {
      const value = {
        id: `entity_${fingerprint(['source-merged-condition', this.input.function.id, key])}`,
        type,
      };
      if (expression) created.set(value.id, expression);
      return value;
    };
    const observe = (id: string): Expression | undefined =>
      created.get(id) ??
      this.synthetic.get(id) ??
      (this.inline.has(id) && this.inlined.get(id)?.node.kind !== 'load'
        ? this.program.expressions.get(id)
        : undefined);
    let root: Value | undefined;
    for (const item of terms) {
      const value = item.positive
        ? item.value
        : make(`not:${item.value.id}`, integer(1), {
            kind: 'integer_unary',
            op: 'not',
            value: item.value,
          });
      root = root
        ? make(`and:${root.id}:${value.id}`, integer(1), {
            kind: 'integer',
            op: 'and',
            left: root,
            right: value,
          })
        : value;
    }
    const folded = foldSourceCondition(
      root!,
      created.get(root!.id)!,
      observe,
      (value) => value,
      (key, type, _block, expression) => make(key, type, expression),
      '',
      this.context,
    );
    if (!folded) return plain.text;
    const leaves = new Set(terms.flatMap((item) => this.leafIds(item.value)));
    for (const expression of created.values())
      for (const operand of expressionOperands(expression))
        if (!created.has(operand.id) && !this.synthetic.has(operand.id) && !leaves.has(operand.id))
          return plain.text;
    for (const operand of expressionOperands(folded))
      if (!created.has(operand.id) && !leaves.has(operand.id)) return plain.text;
    for (const [id, expression] of created) this.synthetic.set(id, expression);
    const text = this.expression(folded, integer(1)).text;
    if (
      text.length >= plain.text.length ||
      !this.localValidation.presentation(
        'merged_condition_flags',
        this.input.function.id,
        'a merged conjunction of compare predicates is re-expressed as fewer native predicates, exact over every feasible equal/unsigned/signed outcome and IEEE less/equal/greater/unordered outcome of each shared operand pair',
      )
    )
      return plain.text;
    return text;
  }

  /** Values printed while printing `value` (inline expressions expanded). */
  private leafIds(value: Value): string[] {
    const ids: string[] = [],
      pending = [value],
      seen = new Set<string>();
    while (pending.length && seen.size < 1024) {
      this.context.checkpoint(1);
      const current = pending.pop()!;
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      ids.push(current.id);
      const expression =
        this.synthetic.get(current.id) ??
        (this.inline.has(current.id) && this.inlined.get(current.id)?.node.kind !== 'load'
          ? this.program.expressions.get(current.id)
          : undefined);
      if (expression) pending.push(...expressionOperands(expression));
    }
    return ids;
  }

  /** The test of a plain source `if` (`positive`) or its exact complement: a
   * negated integer predicate, the operand of an inline one-bit negation, or a
   * logical negation. */
  private testPrinted(control: Extract<Control, { kind: 'if' }>, positive: boolean): Printed {
    if (positive) return this.printed(control.condition);
    let value = control.condition,
      expression: Expression | undefined;
    for (let depth = 0; depth < 128 && this.inline.has(value.id); depth++) {
      this.context.checkpoint(1);
      expression = this.program.expressions.get(value.id);
      if (expression?.kind !== 'cast' || expression.op !== 'bitcast') break;
      value = expression.value;
    }
    if (expression?.kind === 'compare')
      return this.expression({ ...expression, op: NEGATED_PREDICATE[expression.op] }, value.type);
    if (
      expression?.kind === 'integer_unary' &&
      expression.op === 'not' &&
      bitWidth(value.type) === 1
    )
      return this.printed(expression.value);
    return this.printer.not(this.printed(control.condition));
  }

  /** A flag-carried short circuit as one condition and its complement. Stage
   * tests print in their original order, each operand of `&&`/`||` evaluated
   * only when the earlier ones continue the chain, exactly as the stages ran:
   * a stage leaving with flag 0 contributes `continue && rest`, one leaving
   * with flag 1 `leave || rest`; the last stage contributes its stored bit
   * (or the nested chain whose flag it copies). */
  private flagCondition(flag: FlagTest): {
    readonly positive: Printed;
    readonly negative: Printed;
  } {
    const tests = flag.stages.map((stage) =>
      this.testPrinted(stage.control, stage.value !== stage.enter),
    );
    const last = flag.last;
    let merged =
      'chain' in last
        ? this.flagCondition(last.chain)[last.invert ? 'negative' : 'positive']
        : this.printed(last);
    for (let index = flag.stages.length - 1; index >= 0; index--)
      merged = this.printer.logical(
        flag.stages[index]!.value ? 'or' : 'and',
        tests[index]!,
        merged,
      );
    const negated = this.printer.not(merged);
    return flag.positive
      ? { positive: merged, negative: negated }
      : { positive: negated, negative: merged };
  }

  /** The declared source type a value already has: a pointer type (record and
   * spelling), `scalar` for any other declared type, undefined when it is
   * printed with its machine width only. */
  private knownFact(value: Value): Fact | undefined {
    const source = this.program.source;
    if (source?.float_values?.has(value.id)) return 'scalar';
    const formal = source?.formal_types?.get(value.id);
    if (formal)
      return formal.kind === 'pointer' ? { spelling: this.formalSpelling(formal) } : 'scalar';
    const typeId =
      this.sourceValueTypes.get(value.id) ?? source?.value_types?.get(value.id)?.type_id;
    if (!typeId) return undefined;
    const definition = this.typeRecords.get(typeId)?.definition;
    if (definition?.kind === 'pointer') return { type_id: typeId, spelling: this.valueType(value) };
    // An unsigned integer of the machine width is the value's own storage, not a
    // declaration a pointer use could contradict.
    return definition?.kind === 'integer' &&
      !definition.signed &&
      definition.bits === bitWidth(value.type)
      ? undefined
      : 'scalar';
  }

  /** Declared pointer type a load reads: a header-declared pointer global, a
   * typed promoted slot, or a declared pointer member. */
  private typedLoadFact(id: string): PointerFact | undefined {
    const slot = this.slotType(id);
    if (slot?.kind === 'pointer') return { spelling: this.formalSpelling(slot) };
    const declared = this.globals.accesses.get(id)?.object.declared?.type;
    return declared?.kind === 'pointer'
      ? { spelling: this.language === 'c-like' ? declared.c : declared.python }
      : undefined;
  }

  /** Source view: give each set of integer locals connected by phi copies the
   * pointer type its definitions and uses establish (see planLocalTypes). */
  private chooseLocalTypes(): void {
    const program = this.program,
      source = program.source;
    if (!source) return;
    const bits = this.input.source?.abi.layout.pointer_bits ?? 64;
    const formals = new Set(program.parameters.map((value) => value.id));
    const signature = program.signature?.signature;
    const resultId = signature?.return_type ?? source.return_source_type;
    const result: Fact | undefined = resultId
      ? this.typeRecords.get(resultId)?.definition.kind === 'pointer'
        ? { type_id: resultId, spelling: this.sourceType(resultId) }
        : 'scalar'
      : source.return_pointer
        ? {
            spelling:
              source.return_pointer === 'char'
                ? this.language === 'c-like'
                  ? 'char*'
                  : 'pointer[char]'
                : this.language === 'c-like'
                  ? 'uint8_t*'
                  : 'pointer[uint8_t]',
          }
        : source.return_type || source.return_types?.length
          ? 'scalar'
          : undefined;
    const choices = planLocalTypes({
      program,
      context: this.context,
      language: this.language,
      inline: this.inline,
      inlined: this.inlined,
      inlined_calls: this.inlinedCalls,
      formals,
      constant: this.constantOf,
      known: (value) => this.knownFact(value),
      parameter: (projection, index) => this.callParameterFact(projection, index),
      load: (id) => this.typedLoadFact(id),
      literal: (value) => this.sourceLiteral(value, true) !== undefined,
      result,
      variable: (value) =>
        value.type.kind === 'integer' &&
        value.type.bits === bits &&
        program.live.has(value.id) &&
        !this.inline.has(value.id) &&
        !this.inlined.has(value.id) &&
        !this.inlinedCalls.has(value.id) &&
        !formals.has(value.id) &&
        !source.stack_addresses.has(value.id) &&
        !source.float_values?.has(value.id) &&
        !this.fpPresentation.unobserved.has(value.id),
    });
    for (const choice of choices.values()) {
      const typeId = choice.fact.type_id;
      const changed = choice.members.filter(
        (id) =>
          (typeId !== undefined &&
            (this.sourceValueTypes.get(id) ?? source.value_types?.get(id)?.type_id) !== typeId) ||
          this.valueType(program.values.get(id)!) !== choice.fact.spelling,
      );
      if (
        !changed.length ||
        !this.localValidation.presentation(
          'local_source_type',
          changed[0]!,
          'integer locals connected by phi copies take the pointer type their typed call parameters, typed global, slot and call-result definitions, identity tests and dereferences establish, when none of their uses is integer arithmetic and the conversions saved outnumber those added; every use and definition still prints its exact conversion, so values, widths and evaluation order are unchanged',
          changed.slice(0, 64),
        )
      )
        continue;
      for (const id of changed) {
        if (typeId !== undefined) this.sourceValueTypes.set(id, typeId);
        if (typeId === undefined || choice.fact.spelling !== this.sourceType(typeId))
          this.localSpellings.set(id, choice.fact.spelling);
        else this.localSpellings.delete(id);
      }
    }
  }

  /** Source view: coalesce phi copies, then lay out return tails and loop
   * syntax. Each step checks its side conditions on this reconstruction and
   * records one presentation rewrite; the checked view never calls this. */
  private planSourceControl(): void {
    const subject = this.input.function.id,
      program = this.program;
    this.indexedData = indexedDataAccesses(program, this.context);
    const indices = new Map(
      [...this.indexedData].map(([id, table]) => [id, table.terms.map((term) => term.index)]),
    );
    const typeId = (value: Value): string | undefined =>
      this.sourceValueTypes.get(value.id) ?? program.source?.value_types?.get(value.id)?.type_id;
    // A constant rotation prints its operand twice: it stays a variable.
    const rotated = constantRotationOperands(program.expressions);
    const plan = planSourceInlining(
      program,
      this.context,
      (value) => this.names.has(value.id) || rotated.has(value.id),
      (node) => indices.get(node.id),
      (destination, expression) => {
        // Same presented storage: the same IEEE width (whole value, or its low
        // slice that is the presented IEEE value), or the same plain integer type.
        const source =
          (expression.kind === 'cast' &&
            (expression.op === 'bitcast' || expression.op === 'truncate')) ||
          (expression.kind === 'extract' && expression.offset === 0)
            ? expression.value
            : undefined;
        if (!source) return undefined;
        const floating = program.source?.float_values;
        const left = floating?.get(destination.id),
          right = floating?.get(source.id);
        if (left || right)
          return left === right && bitWidth(destination.type) === left ? source : undefined;
        return expression.kind === 'cast' &&
          expression.op === 'bitcast' &&
          destination.type.kind === 'integer' &&
          source.type.kind === 'integer' &&
          destination.type.bits === source.type.bits &&
          typeId(destination) === typeId(source) &&
          !program.source?.formal_types?.has(destination.id) &&
          !program.source?.formal_types?.has(source.id)
          ? source
          : undefined;
      },
      this.fpPresentation.omitted,
      (node, result) => this.admitInlinedCall(node, result),
    );
    const candidates = plan.sites;
    let calls = plan.calls;
    const propagated = [...candidates.values()].filter((site) => site.propagated);
    if (
      propagated.length &&
      !this.localValidation.presentation(
        'copy_propagation',
        subject,
        'a plain copy of a printed variable with the same presented type is read as that variable at every use; phi coalescing and liveness treat each read as a read of the source, so its storage is never reassigned in between',
        propagated.map(({ node }) => node.id),
      )
    ) {
      calls = new Map();
      for (const site of propagated) candidates.delete(site.node.result.id);
    }
    let deferred = plan.deferred;
    const reused = [...candidates.values()].filter((site) => site.local);
    if (
      reused.length &&
      !this.localValidation.presentation(
        'local_load_reuse',
        subject,
        'a load of a private local that exactly one write to that local (a pure function of the loaded value alone) and one other same-block statement read is printed as the local itself at both readers; no other access to the local lies between the load and its last reader, the write has no register input and no effect beyond the private local, and a write that follows its other reader prints right after that reader with no variable read moved',
        reused.map(({ node }) => node.id),
      )
    ) {
      calls = new Map();
      deferred = new Map();
      for (const site of reused) candidates.delete(site.node.result.id);
    }
    const repeated = [...candidates.values()].filter((site) => site.repeated);
    if (
      repeated.length &&
      !this.localValidation.presentation(
        'repeated_operation',
        subject,
        'a cheap pure integer operation of one printed variable (an add, subtract, bitwise or shift with a constant, a negation, complement or integer conversion) read only by one statement, test or edge copy (the copy only through one consumer statement), at most four times, is printed at each occurrence in that reader instead of a temporary; liveness treats each occurrence as a read of its operand at the reader, so the operand is never reassigned in between',
        repeated.map(({ node }) => node.id),
      )
    )
      for (const site of repeated) candidates.delete(site.node.result.id);
    if (
      candidates.size &&
      this.localValidation.presentation(
        'single_use_inlining',
        subject,
        'single-use pure integer/IEEE scalar expressions expand at dominated SSA uses; FP-environment-dependent ones only when no call, unknown effect or register write lies on any path from definition to use (each FP site keeps its recorded environment requirement, which excludes contraction); reads in hidden FP-guard failure blocks are not uses; nonvolatile loads expand only at unconditional same-block uses with no intervening effects except nested dependent loads and private-local reads/writes; initialized private-local reads may cross unrelated effects but never a write to that local',
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
      for (const [anchor, stores] of deferred) {
        this.deferred.set(anchor, stores);
        for (const store of stores) this.deferredStores.add(store.id);
      }
    } else if (candidates.size) calls = new Map();
    if (
      calls.size &&
      this.localValidation.presentation(
        'single_use_call_inlining',
        subject,
        "a call with exactly one live result, read once and unconditionally by the next printed statement of its block or by its return, if or switch test, is printed exactly once in that reader's first printed line (a statement, or a test before its arms and edge copies; a do-while test printed after repeat copies keeps the call a statement) at its original position: no statement prints between them, the reader has no other memory read, call or FP-environment read operand except loads addressed through the call's own result, non-result clobbers print nothing, and the result is printed with the declared result type",
        [...calls.values()].map(({ node }) => node.id),
      )
    )
      for (const [id, site] of calls) {
        this.inlinedCalls.set(id, site);
        const nodes = this.inlinedCallSites.get(site.anchor) ?? [];
        nodes.push(site);
        this.inlinedCallSites.set(site.anchor, nodes);
      }
    this.chooseLocalTypes();
    const liveness = new VariableLiveness(
      program,
      this.context,
      4096,
      this.inlined,
      indices,
      new Set(this.inlinedCalls.keys()),
    );
    this.liveness = liveness;
    const formals = new Set(program.parameters.map((value) => value.id));
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
          this.inlinedCalls.has(source.id) ||
          this.valueType(source) !== this.dataType(source.type) ||
          this.valueType(destination) !== this.dataType(destination.type)
        )
          continue;
        widening.set(source.id, destination);
        assignments.push({ source, destination });
      }
    const storageType = (value: Value): string =>
      machineType((widening.get(value.id) ?? value).type);
    const compatible = (a: Value, b: Value): boolean => {
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
    };
    const variables = coalescePhiCopies(program, liveness, compatible, this.context, assignments);
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
    // In-place updates: a definition that is the last reader of one of its
    // operand variables shares that variable (`y = f(x)` prints `x = f(x)`).
    const chains: { destination: Value; source: Value }[] = [];
    const chain = (destination: Value, operands: readonly Value[]): void => {
      if (!liveness.index.has(destination.id)) return;
      for (const operand of operands)
        for (const leaf of liveness.leaves(operand))
          chains.push({ destination, source: liveness.values[leaf]! });
    };
    const chainDefinitions = (anchor: string): void => {
      for (const definition of program.source?.definitions?.get(anchor) ?? [])
        if (!this.inlined.has(definition.result.id))
          chain(definition.result, expressionOperands(definition.expression));
    };
    for (const block of program.blocks.values()) {
      this.context.checkpoint(1);
      chainDefinitions(block.id);
      for (const node of block.statements) {
        if (program.retained.has(node.id))
          if (node.kind === 'assign')
            chain(
              node.result,
              expressionOperands(program.expressions.get(node.result.id) ?? node.expression),
            );
          else if (node.kind === 'load' && !program.source?.locals.has(node.id))
            chain(node.result, [node.address]);
        chainDefinitions(node.id);
      }
      chainDefinitions(block.control.id);
    }
    // Plain integer temporaries print identically whatever their recovered type
    // identity; everything else needs the phi-coalescing agreement.
    const sharedStorage = (a: Value, b: Value): boolean =>
      this.sourceRoleNames.get(a.id) === this.sourceRoleNames.get(b.id) &&
      (compatible(a, b) ||
        (!!program.source &&
          a.type.kind === 'integer' &&
          b.type.kind === 'integer' &&
          !formals.has(a.id) &&
          !formals.has(b.id) &&
          !widening.has(a.id) &&
          !widening.has(b.id) &&
          this.valueType(a) === this.valueType(b) &&
          this.valueType(a) === this.dataType(a.type) &&
          storageType(a) === storageType(b) &&
          (this.names.get(a.id) ?? null) === (this.names.get(b.id) ?? null)));
    const chained = coalesceValues(
      program,
      liveness,
      sharedStorage,
      this.context,
      this.variables,
      chains,
    );
    if (
      chained &&
      this.localValidation.presentation(
        'copy_coalescing',
        subject,
        'a value defined from a printed variable that dies there (in-place update: y = f(x) with no later read of x) shares its storage with that variable when no member of either class is live where a member of the other is defined (including simultaneous block parameters and loop-carried liveness), every member has the same presented type, machine width, source name and role, and no read observes a different value; unrelated values never share storage, formals retain their declaration, and a role name survives only when every member carries it',
        [...chained.keys()].filter((id) => this.variables.get(id) !== chained.get(id)),
      )
    )
      this.variables = chained;
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
            this.flagAccesses.has(node.id) ||
            ('result' in node && this.inlined.has(node.result.id))) &&
          !hasDefinitions(node.id),
      );
    // A proven jump table's exact range guard and its switch print as one switch.
    const quietAnchor = (id: string): boolean =>
      !this.notes.has(id) && !this.deferred.get(id)?.length;
    const folded = foldSwitchGuards(
      this.body,
      (guard, target) =>
        silent(target) &&
        quietAnchor(target.id) &&
        target.statements.every((node) => quietAnchor(node.id)) &&
        quietAnchor(guard.control.id) &&
        !hasDefinitions(guard.control.id) &&
        !this.requirementPredicates.has(guard.control.id),
      (transfer) => this.printedCopies(transfer).length,
      this.context,
    );
    if (
      folded.guards.size &&
      this.localValidation.presentation(
        'switch_range_guard',
        subject,
        "a proven jump table's range guard (its out-of-range edge is taken exactly when the selector exceeds every case) and the switch it alone enters, whose block prints nothing, print as one switch whose default is the guard's out-of-range arm; no statement, edge copy or effect moves",
        [...folded.guards.keys()],
      )
    ) {
      this.body = folded.body;
      for (const [id, guard] of folded.guards) this.foldedGuards.set(id, guard);
    }
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
            node.kind === 'store' ||
            node.kind === 'call',
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
          'a labeled edge into an acyclic return, tail-call or trap tail of at most four blocks, each with at most four assignments/loads/stores/calls and four edge copies, ends in an owned copy; effects execute once on the same path in the same order, and copies retain original identities',
          [...new Set(layout.duplicated.map((item) => item.tail))],
        )) &&
      (!layout.forced.length ||
        this.localValidation.presentation(
          'goto_path_tail_duplication',
          subject,
          'a bounded tail lexically between a goto and its target is copied onto every incoming edge, fallthroughs included, so its home is no longer printed and the goto falls through; each path still runs the same effects once in the same order before the same exit',
          layout.forced,
        )) &&
      (!layout.relocated.length ||
        this.localValidation.presentation(
          'terminal_block_placement',
          subject,
          'a terminal block is printed at its only edge, or right after the only loop entering it when every other exit of that loop is a duplicated tail',
          layout.relocated.map((item) => item.block),
        )) &&
      (!layout.merged.length ||
        this.localValidation.presentation(
          'loop_exit_merge',
          subject,
          'the exit reached by most loop edges follows the loop, so those edges print as breaks; an exit entered by one loop edge only moves onto that edge and still runs the same statements once on the same path before its own jump, so no exit edge, edge copy or effect changes',
          layout.merged.map((item) => item.block),
        ))
    ) {
      body = layout.body;
      this.clones = layout.clones;
      this.planReturnConstants(layout);
    }
    // Short-circuit tests carried by a promoted flag local (typical O0 `&&`).
    const anchored = (id: string): boolean =>
      hasDefinitions(id) || this.notes.has(id) || !!this.deferred.get(id)?.length;
    const flags = planFlagTests(
      body,
      program,
      {
        prints: (node) =>
          (program.retained.has(node.id) &&
            !this.deferredStores.has(node.id) &&
            !('result' in node && this.inlined.has(node.result.id))) ||
          anchored(node.id),
        anchored,
        copies: (transfer) => this.printedCopies(transfer).length,
        expression: (id) => (this.inline.has(id) ? program.expressions.get(id) : undefined),
        readOnlyBy: (value, control) => {
          const site = this.inlined.get(value.id);
          return site?.anchor === control && !site.local && !site.propagated;
        },
        inPlace: (store) => !this.deferredStores.has(store),
        plain: (control) => !this.requirementPredicates.has(control.id),
      },
      this.context,
    );
    for (const [id, flag] of flags)
      if (
        this.localValidation.presentation(
          'short_circuit_flag',
          id,
          'a promoted private flag local whose only accesses are 0/1 stores ending each stage of a copy-free chain (later stages print nothing, each entered only from the previous one) and one load read only by the merge test, which the chain alone enters and which tests exactly that bit, prints as that test over the stages joined by && (stage leaving with 0) or || (leaving with 1) in their original order, ending with the last stored bit; each later operand is evaluated only when the earlier ones continue the chain, and the dead flag storage is not printed',
          [...flag.controls, ...flag.accesses],
        )
      ) {
        this.flagTests.set(id, flag);
        this.flagHeads.set(flag.head, flag);
        for (const control of flag.controls) this.flagStages.add(control);
        for (const access of flag.accesses) this.flagAccesses.add(access);
      }
    const shaped = planLoopForms(
      body,
      this.language,
      {
        writes: (transfer) => this.printedCopies(transfer).map((copy) => key(copy.destination)),
        copyReads: (transfer) =>
          this.printedCopies(transfer).flatMap((copy) =>
            liveness.leaves(copy.source).map((index) => key(liveness.values[index]!)),
          ),
        silent,
        plain: (control) => !this.requirementPredicates.has(control.id),
        reads: (control) => {
          const flag = this.flagTests.get(control.id);
          const operands = (test: FlagTest): Value[] => [
            ...test.stages.map((stage) => stage.control.condition),
            ...('chain' in test.last ? operands(test.last.chain) : [test.last]),
          ];
          const values = flag ? operands(flag) : [control.condition];
          return values.flatMap((value) =>
            liveness.leaves(value).map((index) => key(liveness.values[index]!)),
          );
        },
        flag: (block) => this.flagHeads.get(block.id)?.merge,
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
      fors: string[] = [],
      exits: string[] = [];
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
        const control = region.form && this.controls.get(region.form.test);
        const leave =
          region.form &&
          control &&
          formArm(region.form, control).find((item) => item.action === 'break');
        if (region.form && leave && this.printedCopies(leave.arm.transfer).length)
          exits.push(region.form.test);
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
        )) &&
      (!exits.length ||
        this.localValidation.presentation(
          'loop_exit_copies',
          subject,
          "a single-test loop's exit edge prints its copies right after the loop: it is the only edge from inside the loop to the continuation, and outer-loop exit flags are tested before them; a do-while's repeat copies (moved before its test) are not read by them",
          exits,
        ))
        ? shaped
        : body;
    if (this.body === body) {
      this.rebased.clear();
      this.hoisted.clear();
      this.forLoops.clear();
    }
    // Short-circuit tests sharing one arm print as if/else (before breakable blocks).
    const loopTests = new Set(this.body === body ? [] : tests);
    const sharedArms = planSharedArms(
      this.body,
      program,
      this.language,
      (block, head) => {
        const control = block.control;
        if (
          this.flagHeads.has(block.id) ||
          this.flagTests.has(control.id) ||
          this.flagStages.has(control.id) ||
          loopTests.has(control.id) ||
          this.requirementPredicates.has(control.id)
        )
          return false;
        return (
          head ||
          (silent(block) &&
            !this.notes.has(block.id) &&
            !anchored(control.id) &&
            block.statements.every((node) => !anchored(node.id)))
        );
      },
      (transfer) => this.printedCopies(transfer).length,
      this.context,
    );
    if (
      sharedArms.heads.length &&
      this.localValidation.presentation(
        'shared_condition_arm',
        subject,
        'a short-circuit test whose operands are copy-free tests printing nothing but their condition (with only silent copy-free jumps between them) and all leave for one statement, entered by those edges only, prints as if/else: that statement becomes the arm body every leaving operand enters (else of the && of staying tests, or then of the || of leaving tests), and the remaining branch falls into the statement after it; operands are still evaluated left to right only while the condition is undecided, and no statement, edge copy or effect moves',
        sharedArms.heads,
      )
    )
      this.body = sharedArms.body;
    const breakable = planBreakableBlocks(this.body, this.language, this.context);
    if (
      breakable.blocks.length &&
      this.localValidation.presentation(
        'breakable_block',
        subject,
        'a forward goto to a later element of an enclosing statement list becomes break out of a do { } while (0) block (Python-like: while True: ending in break) holding the elements from the goto up to its target; nothing continues the block, no edge re-enters its first block, every statement, edge copy and effect keeps its place and order, and the block is kept only when fewer gotos remain',
        breakable.blocks,
      )
    )
      this.body = breakable.body;
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
   * a copy `x <- x + c` and test `(x or zext x) ==/!= K`, test `x ==/!= K + c`;
   * for a copy `x <- x >> c` (logical or arithmetic, 0 < c < width) and an
   * unsigned range test `x < 2^c` (or `x <= 2^c - 1`, or their negations), test
   * `x ==/!= 0`. The derivation is exact over the IR; while the shared
   * allowance remains, the bit-vector checker independently re-proves the
   * restated test (over the copy's source value) and may veto it. */
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
    if (compare?.kind !== 'compare') return false;
    const right = constant(compare.right),
      bound = right ?? constant(compare.left);
    let leaf = right === undefined ? compare.right : compare.left;
    if (bound === undefined) return false;
    // The predicate with the variable on its left.
    const op =
      right !== undefined
        ? compare.op
        : compare.op === 'ult'
          ? 'ugt'
          : compare.op === 'ule'
            ? 'uge'
            : compare.op === 'ugt'
              ? 'ult'
              : compare.op === 'uge'
                ? 'ule'
                : compare.op;
    if (!['eq', 'ne', 'ult', 'ule', 'ugt', 'uge'].includes(op)) return false;
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
    let restatedOp: 'eq' | 'ne', bits: bigint, scope: string;
    if (op === 'eq' || op === 'ne') {
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
      restatedOp = op;
      bits = BigInt.asUintN(width, bound + shift);
      scope = `test of x ==/!= ${bound} restated after the repeat copy x <- x ${shift < 0n ? '-' : '+'} ${shift < 0n ? -shift : shift} (mod 2^${width}) as x ==/!= ${bits}`;
    } else {
      const uncast = (value: Value): Value => {
        for (let i = 0; i < 16; i++) {
          const cast = program.expressions.get(value.id);
          if (cast?.kind !== 'cast' || cast.op !== 'bitcast') break;
          value = cast.value;
        }
        return value;
      };
      const source = uncast(copy.source),
        shifted = program.expressions.get(source.id),
        count = shifted?.kind === 'integer' ? constant(shifted.right) : undefined;
      if (
        shifted?.kind !== 'integer' ||
        (shifted.op !== 'lshr' && shifted.op !== 'ashr') ||
        source.type.kind !== 'integer' ||
        source.type.bits !== width ||
        uncast(shifted.left).id !== leaf.id ||
        count === undefined ||
        count <= 0n ||
        count >= BigInt(width)
      )
        return false;
      // x >> c == 0 iff x <u 2^c (an arithmetic shift too: 2^c <= 2^(width-1)).
      const limit = 1n << count,
        below = op === 'ult' || op === 'ule';
      if (bound !== (op === 'ult' || op === 'uge' ? limit : limit - 1n)) return false;
      restatedOp = below ? 'eq' : 'ne';
      bits = 0n;
      scope = `unsigned test x ${below ? '<' : '>='} 2^${count} restated after the repeat copy x <- x >> ${count} (${shifted.op}, width ${width}) as x ${below ? '==' : '!='} 0`;
    }
    const restated: Value = { id: `${control.id}#restated_bound`, type: copy.destination.type };
    const original = compare,
      subject = tested;
    const expressions = new Map(program.expressions);
    expressions.set(restated.id, { kind: 'constant', bits });
    const record = this.localValidation.allowance.exhausted
      ? undefined
      : this.localValidation.check(
          'bitvector',
          subject.id,
          'do-while test restated over its repeat copy result; not whole-function equivalence',
          () =>
            validateBitvectorCandidate(
              subject,
              original,
              { kind: 'compare', op: restatedOp, left: copy.source, right: restated },
              expressions,
              this.localValidation.allowance,
            ),
        );
    if (
      record?.status === 'rejected' ||
      !this.localValidation.presentation('loop_test_restatement', control.id, scope, [
        tested.id,
        copy.destination.id,
      ])
    )
      return false;
    this.synthetic.set(restated.id, { kind: 'constant', bits });
    this.rebased.set(control.id, {
      kind: 'compare',
      op: restatedOp,
      left: copy.destination,
      right: restated,
    });
    return true;
  }

  private control(control: Control, block: BlockRegion, depth: number): void {
    // A short-circuit flag stage prints inside its merge test: only its
    // copy-free edges and the stages it guards are visited here.
    if (this.flagStages.has(control.id)) {
      const before = this.writer.offset;
      if (control.kind === 'jump') this.transfer(control.transfer, depth, control);
      else
        for (const arm of controlArms(control)) {
          this.transfer(arm.transfer, depth, control);
          if (arm.body) this.region(arm.body, depth);
        }
      if (this.writer.offset !== before) this.invalid('A short-circuit flag stage printed text');
      return;
    }
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
        const flag = this.sourceView ? this.flagTests.get(control.id) : undefined;
        if (flag) {
          const merged = this.flagCondition(flag);
          this.sourceIf(
            control,
            depth,
            merged.positive,
            undefined,
            control.condition,
            undefined,
            merged.negative,
          );
          break;
        }
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
            !requirement &&
              expression?.kind === 'integer_unary' &&
              expression.op === 'not' &&
              bitWidth(conditionValue.type) === 1
              ? expression.value
              : undefined,
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
      case 'switch': {
        ids.push(control.value.id);
        const selector = this.sourceView ? this.switchSelector(control) : control.value;
        this.writer.line(
          depth,
          this.language === 'c-like'
            ? `switch (${this.value(selector)}) {`
            : `match ${this.value(selector)}:`,
        );
        if (this.sourceView) this.sourceSwitch(control, depth);
        else {
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
        }
        this.propagateLoopExit(control.id, depth);
        break;
      }
      case 'return': {
        const projection = this.program.returns.get(control.id);
        for (const value of control.values) ids.push(value.id);
        for (const binding of block.register_exit) ids.push(binding.value.id);
        if (projection && projection.kind !== 'physical' && projection.outputs.length === 0) {
          this.substituted = this.returnConstants.get(block) ?? null;
          let values: string[];
          try {
            values = this.writer.list(projection.results, (value) => {
              const nsString = this.objcLiteral(value);
              if (
                nsString !== undefined &&
                this.localValidation.presentation(
                  'objc_string_literal',
                  control.id,
                  'pointer-width constant result addressing an exact __cfstring constant object, printed as that NSString literal',
                  [value.id],
                )
              )
                return nsString;
              const scalar = this.sourceView && this.program.source?.return_scalar;
              if (scalar) return this.scalarReturn(value, scalar.bits, scalar.signed).text;
              if (this.program.source?.return_pointer && !this.program.source.return_source_type)
                return this.sourceAddressValue(value, true);
              const literal = this.valueLiteral(value, this.returnSpelling);
              if (literal) return literal.text;
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
          } finally {
            this.substituted = null;
          }
          if (values.length || block !== this.fallOffBlock)
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
        // The preceding noreturn call already ends this path in source text; the
        // trap keeps its record and (header) mapping.
        if (control.kind === 'trap' && this.noreturnCallExit(control, block)) break;
        const tail =
          control.kind === 'indirect' && control.tail_call
            ? this.program.tails.get(control.id)
            : undefined;
        if (tail && this.program.source && control.kind === 'indirect') {
          const message = this.sourceView
            ? this.input.source?.objc?.messages.get(control.id)
            : undefined;
          const skip = message?.form === 'send' ? 2 : 1,
            arity = message ? selectorArity(message.selector) : 0;
          if (
            message &&
            !message.variadic &&
            OBJC_SELECTOR.test(message.selector) &&
            tail.boundary.kind !== 'physical' &&
            tail.boundary.argument_list_complete === true &&
            tail.boundary.arguments.length === skip + arity &&
            this.localValidation.presentation(
              'objc_message',
              control.id,
              `tail transfer presented as a returned Objective-C message: receiver, statically resolved selector ${this.writer.quote(message.selector)} and one keyword per selector colon; the dispatcher target and selector argument stay in this record`,
              [control.id],
            )
          ) {
            const printed = tail.boundary.arguments.map((value) => {
              ids.push(value.id);
              // Message syntax has no C conversion: a declared pointer local
              // (possibly through inline same-width bitcasts) prints as itself.
              let operand = value;
              for (let step = 0; step < 4 && this.inline.has(operand.id); step++) {
                const alias = this.program.expressions.get(operand.id);
                if (
                  alias?.kind !== 'cast' ||
                  alias.op !== 'bitcast' ||
                  bitWidth(alias.value.type) !== bitWidth(operand.type)
                )
                  break;
                operand = alias.value;
              }
              if (
                this.language === 'c-like' &&
                !this.inline.has(operand.id) &&
                this.declaredSpelling(operand).endsWith('*')
              )
                return this.local(operand);
              return this.objcLiteral(value) ?? this.valueLiteral(value)?.text ?? this.value(value);
            });
            ids.push(control.target.id);
            const sent = this.guarded(
              objcMessageText(
                this.language,
                message,
                this.objcReceiver(tail.boundary.arguments[0]!, printed[0]!),
                printed.slice(skip),
                [],
              ),
            );
            this.tailStatement(depth, sent, tail.result_void === true);
            break;
          }
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
            return this.valueLiteral(value)?.text ?? this.value(value);
          });
          const guessedTail = this.likelyArgumentList(tail.boundary);
          if (tail.boundary.argument_list_complete === false && !guessedTail)
            arguments_.push(
              this.openArguments(
                arguments_.length ? 'unknown_argument_remainder' : 'unknown_arguments',
                'Unresolved trailing native tail-call arguments; observed prefix is retained, not a complete prototype.',
              ),
            );
          this.writer.helper(
            name,
            `Native tail transfer to ${this.writer.quote(key)} using observed ${this.input.source!.abi.id} storage. Preserve unknown target effects and forward its actual results. An absent observed result layout is unknown, not void.`,
          );
          ids.push(control.target.id);
          const tailCall = `${name}(${this.writer.join(arguments_)})`;
          this.tailStatement(
            depth,
            guessedTail ? this.likelyCall(tailCall) : tailCall,
            tail.result_void === true,
          );
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
    // A folded range guard is printed by its switch.
    const guard = this.foldedGuards.get(control.id);
    if (guard) {
      this.inferenceSites.set(guard.id, { start, end: this.writer.offset });
      this.map(guard, start);
    }
    // Absorbed stages and flag accesses are printed by this merge test.
    const flag = this.flagTests.get(control.id);
    for (const id of flag ? [...flag.controls, ...flag.accesses] : []) {
      const origin = this.controls.get(id) ?? this.statements.get(id);
      if (!origin) this.invalid('A short-circuit flag stage lost its origin');
      this.inferenceSites.set(id, { start, end: this.writer.offset });
      this.map(origin, start);
    }
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
      // A block run once is `do { } while (0)`, or `while True:` ending in a
      // break wherever its body can fall off the end.
      if (region.once) {
        this.writer.line(depth, c ? 'do {' : 'while True:');
        this.region(region.body, depth + 1);
        if (c) this.writer.line(depth, '} while (0);');
        else if (!this.regionTerminates(region.body)) this.writer.statement(depth + 1, 'break');
        this.propagateLoopExit(region.header, depth);
        return;
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
      // Flagged exits to outer loops left above; only this loop's test reaches here.
      const exit = form && this.loopExitCopies.get(form.test);
      if (form && exit) {
        this.loopExitCopies.delete(form.test);
        this.transfer(exit, depth, this.controls.get(form.test)!);
      }
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
        const held =
          node.kind === 'call' && this.program.retained.has(node.id)
            ? this.program.calls
                .get(node.id)
                ?.results.map((value) => this.inlinedCalls.get(value.id))
                .find((site) => site)
            : undefined;
        if (held) this.holdCall(held.node, held, depth);
        else if (
          this.program.retained.has(node.id) &&
          !this.deferredStores.has(node.id) &&
          !this.flagAccesses.has(node.id) &&
          !('result' in node && this.inlined.has(node.result.id))
        )
          this.reader(() => this.instruction(node, depth));
        this.sourceDefinitions(node.id, depth);
        for (const store of this.deferred.get(node.id) ?? [])
          this.reader(() => this.instruction(store, depth));
      }
      this.sourceDefinitions(region.control.id, depth);
      // A plain jump carries a held call on to the block it enters.
      if (region.control.kind === 'jump') this.control(region.control, region, depth);
      else this.reader(() => this.control(region.control, region, depth));
      this.map(region, start, [
        region.effect_parameter.id,
        ...region.parameters.map((value) => value.id),
      ]);
    }
  }

  /** Print the statement or control that reads the held inlined calls. */
  private reader(print: () => void): void {
    // A nested reader before the open reader's first line (an `if` carrying its
    // enclosing conjuncts) prints that line itself.
    if (this.openReader && this.writer.watched === null) return print();
    this.settleReader();
    const held = [...this.pendingCalls.keys()].map((id) => this.inlinedCalls.get(id)!);
    if (!held.length) return print();
    if (this.writer.codeLines !== this.heldLines)
      throw new CallInliningRetry([...this.pendingCalls.keys()]);
    this.openReader = { start: this.writer.offset, held };
    this.writer.watched = null;
    print();
    this.settleReader();
  }

  /** The open reader's held calls are read by the first code line it printed: the
   * statement, or a control's header before its arms, edge copies or a do-while's
   * repeat copies. A later reader or held call settles them as soon as it starts. */
  private settleReader(): void {
    const open = this.openReader;
    if (!open) return;
    this.openReader = null;
    const line = this.writer.watched ?? '';
    this.writer.watched = undefined;
    this.settleCalls(line);
    for (const site of open.held)
      this.inferenceSites.set(site.node.id, { start: open.start, end: this.writer.offset });
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
        ? `${this.language === 'c-like' ? 'C-like' : 'Python-like'}${this.program.source.inferred ? '' : ', source interface'}`
        : `${this.language === 'c-like' ? 'C-like' : 'Python-like'} reconstruction; explicit widths and ordered memory, not original source.`,
    );
    // Source view: the ABI scratch note is inserted after rendering, and only
    // when a scratch register name occurs in the text (exit metadata keeps
    // every slice either way).
    const scratch = new Set<string>();
    if (this.sourceView)
      for (const boundary of this.program.returns.values())
        for (const { register } of boundary.exit_scratch ?? [])
          scratch.add(register.root.slice(register.root.lastIndexOf(':') + 1));
    const scratchAt = w.offset;
    const environment = (this.program.source?.requirements ?? []).filter(
      (requirement) => requirement.kind === 'fp_environment',
    );
    const mapSites = (requirement: Requirement, start: number, end: number): void => {
      for (const site of requirement.sites) {
        const origin = this.origins.get(site.subject_ids[0]!);
        if (origin && this.fpPresentation.guards.has(origin.id)) {
          this.map(origin, start, site.subject_ids, end);
          const control = this.controls.get(origin.id);
          if (control?.kind === 'if') {
            const failure = site.supported_predicate_value ? control.when_false : control.when_true;
            const block = this.program.blocks.get(failure.transfer.target)!;
            this.map(block, start, [], end);
            this.map(block.control, start, [], end);
            for (const node of block.statements) this.map(node, start, [], end);
          }
        }
      }
    };
    // Source view: the FP-environment assumption trails the signature, naming
    // its requirement by an unambiguous ID prefix.
    const ids = (this.program.source?.requirements ?? []).map((requirement) => requirement.id);
    const reference = (id: string): string => {
      for (let length = 'requirement_'.length + 12; length < id.length; length += 4) {
        const prefix = id.slice(0, length);
        if (ids.every((other) => other === id || !other.startsWith(prefix))) return `${prefix}…`;
      }
      return id;
    };
    const note =
      this.sourceView &&
      environment.length > 0 &&
      this.localValidation.presentation(
        'requirement_note',
        this.input.function.id,
        'the FP-environment assumption is a trailing signature comment naming each requirement by an unambiguous ID prefix; full ID, explanation and sites remain in requirements metadata',
        environment.map((requirement) => requirement.id),
      )
        ? `assumes nearest-even rounding and masked FP traps (${environment.map((requirement) => reference(requirement.id)).join(', ')})`
        : undefined;
    if (!note)
      for (const requirement of environment) {
        this.context.checkpoint(1);
        const start = w.offset;
        w.comment(
          0,
          `Requirement ${requirement.id} (${requirement.status}): ${this.sourceView ? 'assumes nearest-even rounding and masked FP traps; full text in requirements metadata.' : requirement.explanation}`,
        );
        mapSites(requirement, start, w.offset);
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
          this.sourceView && this.presentedName(this.input.function.id) !== undefined,
        )
      : this.identifier(this.input.function.id, 'fn');
    if (displayName && !this.program.source) w.comment(0, `function: ${w.quote(displayName)}`);
    this.emitNotes(this.input.function.id, 0);
    const signature = this.program.signature;
    // Source view: a method implementation is headed by its runtime method
    // identity and its first two ABI arguments are the receiver and selector.
    const method = this.sourceView ? this.input.source?.objc?.method : undefined;
    const methodName =
      method &&
      OBJC_SELECTOR.test(method.selector) &&
      /^[A-Za-z_$][\w$.]*(?:\([\w$ .]*\))?$/.test(method.owner) &&
      this.localValidation.presentation(
        'objc_method',
        this.input.function.id,
        'function headed by the Objective-C method record whose implementation is this entry; the first two integer argument registers are named for the receiver (self) and selector (_cmd)',
      )
        ? this.language === 'c-like'
          ? `${method.kind === 'class' ? '+' : '-'}[${method.owner} ${method.selector}]`
          : `${method.owner.replace(/\(.*\)$/, '')}.${method.selector.replace(/:/g, '_')}`
        : undefined;
    const implicit = methodName
      ? this.input
          .source!.abi.classifyCall({
            returns: { kind: 'void' },
            parameters: [{ kind: 'pointer' }, { kind: 'pointer' }],
            variadic: false,
            fixed_parameter_count: 2,
          })
          .parameters.map((parameter) => {
            const location = parameter.locations[0];
            return location?.kind === 'register' ? location.register.root : undefined;
          })
      : [];
    const headerName = methodName ?? functionName;
    const parameters: { value: Value; type: string; name: string }[] = [];
    for (let i = 0; i < this.program.parameters.length; i++) {
      this.context.checkpoint(1);
      const value = this.program.parameters[i]!;
      const source = signature?.signature.parameters[i];
      const register = this.program.parameter_registers.get(value.id);
      if (!this.names.has(value.id) && source?.name) this.names.set(value.id, source.name);
      if (!this.names.has(value.id) && register && !this.program.source)
        this.names.set(value.id, this.registerName(register));
      // A role-named formal that is also a coalesced class needs every member to
      // be that role (classRoleName); its supplied or recovered names stand.
      const own = this.sourceRoleNames.get(value.id);
      const proven =
        own && sourceRoleStems.has(own) && this.variables.has(value.id)
          ? this.classRoleName(value)
          : own;
      const role =
        register && register.offset_bits === 0
          ? (['self', '_cmd'] as const)[implicit.indexOf(register.root)]
          : undefined;
      const name = this.program.source
        ? this.sourceIdentifier(
            value.id,
            role ??
              (this.sourceRoleNames.has(value.id)
                ? (proven ?? `arg${i}`)
                : (this.program.source.parameter_names.get(value.id) ?? source?.name ?? `arg${i}`)),
          )
        : this.identifier(value.id, source ? 'arg' : register ? 'reg' : 'arg');
      const type = source ? this.sourceType(source.type_id) : this.valueType(value);
      this.declaredTypes.set(value.id, type);
      parameters.push({
        value,
        type: this.guessedFormal(value) ? this.likelyType(type) : type,
        name,
      });
    }
    // A tail into a proven-void callee yields no result: with no returned value
    // on any other path the function is void, not of unknown result.
    let hasTailCall = false,
      voidTail = false;
    for (const block of this.program.blocks.values()) {
      this.context.checkpoint(1);
      if (block.control.kind !== 'indirect' || !block.control.tail_call) continue;
      if (this.program.tails.get(block.control.id)?.result_void) voidTail = true;
      else hasTailCall = true;
    }
    if (voidTail)
      for (const projection of this.program.returns.values())
        if (projection.results.length || projection.kind === 'physical') hasTailCall = true;
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
    const returnShown = this.guessedResult() ? this.likelyType(returnType) : returnType;
    // The scalar-support prelude is chosen from the finished text and inserted here.
    const supportAt = this.sourceView && this.language === 'c-like' ? w.offset : undefined;
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
    const globalsAt = w.offset;
    if (methodName && method?.kind === 'class' && this.language === 'python-like')
      w.line(0, '@classmethod');
    this.headerStart = w.offset;
    let noteSpan: { start: number; end: number } | undefined;
    const closing = (text: string): void => {
      if (!note) return w.line(0, text);
      const separator = this.language === 'c-like' ? ' ' : '  ',
        comment = this.language === 'c-like' ? `/* ${note} */` : `# ${note}`,
        start = w.offset + text.length + separator.length;
      w.line(0, `${text}${separator}${comment}`);
      noteSpan = { start, end: start + comment.length };
    };
    if (this.program.source && parameters.length <= 4) {
      const declarations = parameters.map((parameter) =>
        w.declaration(parameter.type, parameter.name),
      );
      const prefix =
        this.language === 'c-like' ? `${returnShown} ${headerName}(` : `def ${headerName}(`;
      closing(
        `${prefix}${this.writer.join(declarations)}${this.language === 'c-like' ? ') {' : `) -> ${returnShown}:`}`,
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
        this.language === 'c-like' ? `${returnShown} ${headerName}(` : `def ${headerName}(`,
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
      closing(this.language === 'c-like' ? ') {' : `) -> ${returnShown}:`);
    } else
      closing(
        this.language === 'c-like'
          ? `${returnShown} ${headerName}() {`
          : `def ${headerName}() -> ${returnShown}:`,
      );
    this.headerEnd = w.offset;
    const proof = this.sourceEvidence.get(this.input.function.id);
    this.mapped(this.input.function, this.headerStart, proof ? [...proof.ids] : [], [
      ...(proof?.evidence ?? []),
    ]);
    if (noteSpan)
      for (const requirement of environment) mapSites(requirement, noteSpan.start, noteSpan.end);
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
      if (
        declaredLocals.has(local.id) ||
        !this.program.retained.has(node) ||
        this.flagAccesses.has(node)
      )
        continue;
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
      const typed = this.slotType(node),
        floating = this.floatSlot(node);
      w.statement(
        1,
        w.declaration(
          floating
            ? floating === 32
              ? 'float'
              : 'double'
            : typed
              ? this.formalSpelling(typed)
              : this.dataType(local.type),
          name,
        ),
      );
      this.mapped(this.dataOrigin(node), start, [node]);
    }
    for (const value of this.program.values.values()) {
      this.context.checkpoint(1);
      if (
        !this.program.live.has(value.id) ||
        this.fpPresentation.unobserved.has(value.id) ||
        this.inline.has(value.id) ||
        this.inlinedCalls.has(value.id) ||
        formals.has(value.id) ||
        this.program.source?.stack_addresses.has(value.id) ||
        this.vanishedVariable(value)
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
    this.fallOffBlock = this.sourceView ? this.fallOffReturn(this.body) : null;
    const bodyLines = this.writer.codeLines;
    this.region(this.body, 1);
    if (this.language === 'python-like' && this.writer.codeLines === bodyLines)
      w.statement(1, 'pass');
    if (this.pendingCalls.size) throw new CallInliningRetry([...this.pendingCalls.keys()]);
    if (this.language === 'c-like') w.line(0, '}');
    // Hidden subjects retain annotations without resurrecting dead declarations.
    for (const subject of this.notes.keys()) this.emitNotes(subject, 0);
    const insert = (at: number, lines: readonly string[]): number => {
      const delta = w.insertLines(at, lines);
      this.headerStart += delta;
      this.headerEnd += delta;
      for (const [id, site] of this.inferenceSites)
        if (site.start >= at)
          this.inferenceSites.set(id, { start: site.start + delta, end: site.end + delta });
      return delta;
    };
    this.declareGlobals(globalsAt, insert);
    this.declareFunctionValues(globalsAt, insert);
    if (this.structureSlot) insert(this.structureSlot.at, this.structureLines());
    let support = supportAt;
    if (this.likelyUsed) {
      const comment = 'likely_arity(call): argument list guessed closed, not proven';
      const delta = insert(scratchAt, [
        this.language === 'c-like' ? `/* ${comment} */` : `# ${comment}`,
      ]);
      if (support !== undefined) support += delta;
    }
    if (this.likelyTypeUsed) {
      const comment = 'likely_type(T): type guessed from caller use, not proven';
      const delta = insert(scratchAt, [
        this.language === 'c-like' ? `/* ${comment} */` : `# ${comment}`,
      ]);
      if (support !== undefined) support += delta;
    }
    if (this.ellipsisUsed) {
      const comment = '...: more args possible';
      const delta = insert(scratchAt, [
        this.language === 'c-like' ? `/* ${comment} */` : `# ${comment}`,
      ]);
      if (support !== undefined) support += delta;
    }
    if (scratch.size) {
      const text = w.text().slice(scratchAt);
      if (
        [...scratch].some((name) => new RegExp(`\\b${name}\\b`).test(text)) ||
        !this.localValidation.presentation(
          'abi_scratch_note',
          this.input.function.id,
          'no ABI scratch register name occurs in the text, so the scratch-at-return comment is omitted; exit metadata keeps every exact slice and value',
          [...this.program.returns.keys()].slice(0, 64),
        )
      ) {
        const comment = `ABI scratch at return, not results: ${[...scratch].join(', ')}`;
        const delta = insert(scratchAt, [
          this.language === 'c-like' ? `/* ${comment} */` : `# ${comment}`,
        ]);
        if (support !== undefined) support += delta;
      }
    }
    if (support !== undefined && this.deferredTypedefs.length) {
      const text = w.text().slice(support);
      const mentions = (name: string, haystack: string): boolean =>
        new RegExp(`\\b${name}\\b`).test(haystack);
      const handles = [...this.handleTypedefs].filter(([name]) => mentions(name, text));
      const scan = `${text}\n${handles.map(([, declaration]) => declaration).join('\n')}`;
      const used = this.deferredTypedefs.filter(
        (name) => !this.handleTypedefs.has(name) && mentions(name, scan),
      );
      insert(support, [
        ...used.map((name) => `typedef struct ${name} ${name};`),
        ...handles.map(([, declaration]) => declaration),
      ]);
    }
    if (support !== undefined) insert(support, cScalarSupport(w.text().slice(support)));
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
    const omitted: EmissionOmission[] = [];
    let requirements: EmissionRequirement[] = [],
      inferences: readonly Inference[] = [];
    if (w.metadataMode === 'omitted') {
      // Provenance exceeded a bound during the full render: the text is complete and
      // identical, and the shed metadata classes are named in the emission.
      omitted.push(
        { kind: 'mappings', reason: 'output_limit', omitted: w.omittedMappings },
        { kind: 'inferences', reason: 'output_limit', omitted: null },
        { kind: 'requirements', reason: 'output_limit', omitted: null },
      );
    } else {
      try {
        requirements = sourceRequirementProofs(
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
      } catch (error) {
        if (!(error instanceof MetadataLimitError)) throw error;
        requirements = [];
        omitted.push({ kind: 'requirements', reason: 'output_limit', omitted: null });
      }
      const collected = collectInferences(
        this.input,
        this.program,
        this.localValidation.records,
        w,
        this.context,
        this.inferenceSites,
        this.sourceDataValue,
      );
      inferences = collected.records;
      if (collected.omitted !== 0)
        omitted.push({ kind: 'inferences', reason: 'output_limit', omitted: collected.omitted });
    }
    const summary = omittedDiagnosticsSummary(this.shedDiagnostics, this.shedCitations);
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
        ...(omitted.length ? { omitted } : {}),
        review,
      },
      diagnostics: [...this.diagnostics, ...(summary ? [summary] : [])],
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

/** Render with single-use call inlining; a held call that does not reach its
 * reader as laid out prints as a statement in the next attempt. After four
 * failed attempts every call prints as a statement. */
export function renderSource(
  input: EmissionInput,
  options: ConstructorParameters<typeof Renderer>[1],
  context: OperationContext,
  language: 'c-like' | 'python-like',
  version: string,
): EmissionResult {
  const attempt = (metadata: 'full' | 'omitted'): EmissionResult => {
    const rejected = new Set<string>();
    // Each retry prints the failed calls as statements.
    for (let retry = 0; ; retry++) {
      try {
        return new Renderer(
          input,
          options,
          context,
          language,
          version,
          retry < 4 ? rejected : null,
          metadata,
        ).render();
      } catch (error) {
        if (!(error instanceof CallInliningRetry) || retry >= 4) throw error;
        for (const id of error.results) rejected.add(id);
      }
    }
  };
  try {
    return attempt('full');
  } catch (error) {
    // Provenance metadata is bounded separately from the text. When it cannot be
    // held, render the same text without it and say so; never fail the pseudocode.
    if (!(error instanceof MetadataLimitError)) throw error;
    return attempt('omitted');
  }
}
