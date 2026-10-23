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
  sameType,
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
  StructuredFunction,
  StructuringConditions,
  StructuringResult,
} from '../presentation/index.js';
import { structureControlFlow, structuredGraph } from '../presentation/index.js';
import type { SuppliedTypeRecord } from '../analysis/types/index.js';
import { reconstruct } from '../reconstruction/index.js';
import type { BoundaryProjection, Reconstruction } from '../reconstruction/model.js';
import { validateReconstruction, validateRenderedTransfers } from '../reconstruction/validate.js';
import { foldSourceCondition } from '../reconstruction/source-conditions.js';
import { constantRotationOperands } from '../reconstruction/source-shifts.js';
import {
  registerOutputs,
  stackEntry,
  variadicArea,
  type SourceVariadic,
  type FrameMember,
  type IncomingObject,
  type ObjCMessage,
  type SourceAddress,
  type SourceFormalType,
  type SourceLocal,
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
  type SourceNamePlan,
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
  castExplanation,
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
import { MetadataLimitError, Writer, type EvidenceSource } from './writer.js';
import type { EmissionInput, EmissionResult } from './model.js';
import { collectInferences } from './inference.js';
import {
  VariableLiveness,
  edgeCopies,
  partitionVariables,
  loopCopyRotations,
  rotateLoopCopies,
  type LoopCopyRotation,
  type VariableMember,
  controlArms,
  formArm,
  foldSwitchGuards,
  planLayout,
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
import {
  paddingName,
  SourceStructs,
  structMemberName,
  usedMemberKey,
  type ObservedMember,
} from './source-structs.js';
import { planFlagTests, type FlagTest } from './source-flags.js';
import {
  planIntegerSpellings,
  planLocalTypes,
  type Fact,
  type PointerFact,
} from './source-local-types.js';

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
    }
  | { readonly kind: 'switch'; readonly id: string; readonly follow: string | null };
/** A statement a `for` header prints as its init or step. */
type HeaderStatement = Extract<Instruction, { kind: 'assign' | 'load' | 'store' }>;
/** Source view: one stack object kept as memory (the frame object, or the
 * incoming object of S4) in entry-SP coordinates, with its member naming. */
interface StackObjectView {
  /** The object's identifier (named on first use: a frame whose every member
   * is independent, A3, declares no object). */
  readonly name: () => string;
  readonly minimum_offset: bigint;
  readonly members: readonly FrameMember[];
  /** Spelling of a member: `frame.local_38`, `stack_args.arg_8`, or an
   * independent local's own name (A3). */
  readonly member: (member: FrameMember) => string;
}
/** SysV AMD64 `va_list` (`__va_list_tag[1]`) fields by byte offset (S7). */
const VA_LIST_FIELDS: ReadonlyMap<
  bigint,
  { readonly name: string; readonly bytes: bigint; readonly pointer: boolean }
> = new Map([
  [0n, { name: 'gp_offset', bytes: 4n, pointer: false }],
  [4n, { name: 'fp_offset', bytes: 4n, pointer: false }],
  [8n, { name: 'overflow_arg_area', bytes: 8n, pointer: true }],
  [16n, { name: 'reg_save_area', bytes: 8n, pointer: true }],
]);
/** One test of a merged `if` chain: its printed form and the value it tests. */
interface ConditionTerm {
  readonly printed: Printed;
  readonly value: Value;
  readonly positive: boolean;
  /** `value` is not the printed test (a flag-carried short circuit): never fold it. */
  readonly opaque?: true;
}
/** `base ± k1 ± k2 …`: an address printed through inline constant
 * displacements (`terms` of them) of one base, with their modular total. */
interface Displacement {
  readonly base: Value;
  readonly offset: bigint;
  readonly terms: number;
}
/** A table's contents print in full up to this many bytes; larger tables, and
 * those of unestablished extent, show one row of TABLE_PREFIX_BYTES. */
const TABLE_FULL_BYTES = 64n;
const TABLE_PREFIX_BYTES = 16;
/** One structure declaration of the finished text: its lines, and the byte gaps a
 * compact (inline) body omits (external text prints them as pad members). */
interface StructureBody {
  readonly name: string;
  readonly lines: string[];
  readonly gaps: { readonly offset: bigint; readonly length: bigint }[];
}
const COMPACT_STRUCT_MEMBERS_SCOPE =
  'inline structure bodies print only the members the text accesses; byte gaps before a member whose name states its offset (field_0xN) and after the last member up to an access stride are not printed, so every printed member stays at its named offset (external declarations keep the gaps as pad members)';
const STRING_LITERAL_SCOPE =
  'pointer-width constants addressing an immutable NUL-terminated string with established encoding (an interior address denotes its suffix bytes), printed as that string literal where the constant is a value: argument, store, return, copy, select arm or identity comparison';
const CALL_EFFECTS_SCOPE =
  'the visible call carries its own ordered memory/fault effects; its unchanged physical clobber contract is retained in this record, not a second effect statement';

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

/** One structuring condition (see StructuringConditions) asked and its answer. */
type StructuringQuery =
  | { readonly kind: 'operand'; readonly block: string; readonly answer: boolean }
  | {
      readonly kind: 'copies';
      readonly block: string;
      readonly slot: number;
      readonly answer: number;
    }
  | {
      readonly kind: 'returnsConstants';
      readonly block: string;
      readonly slot: number;
      readonly answer: boolean;
    };

/** Plans of one reconstruction shared by its attempts. No attempt's state
 * (rejected calls, metadata mode, validation session) changes the names,
 * characters or indexed data: the first attempt computes them and every retry
 * reuses them. A restructuring is reused only under the same conditions. */
interface AttemptPlans {
  names?: SourceNamePlan;
  characters?: ReadonlySet<string>;
  indexedData?: ReadonlyMap<string, IndexedDataAccess>;
  /** Source-view restructurings (see Renderer.restructure): the structured
   * graph, the conditions asked in order with their answers, and the layout. */
  structures?: {
    readonly graph: StructuredFunction;
    readonly queries: readonly StructuringQuery[];
    readonly result: StructuringResult;
  }[];
}

/** Only syntax lives here: both dialects consume the same reconstructed program. */
export class Renderer {
  private readonly writer: Writer;
  /** Source view: replaced once structuring ran again with block contents. */
  private program: Reconstruction;
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
  /** Source view: the one statement a while/for head test holds (LoopFacts.comma
   * and carrier), by test control id; it prints inside the loop test. */
  private readonly loopCommaTests = new Map<string, Instruction>();
  private clones: ReadonlySet<BlockRegion> = new Set();
  private cloneIds: ReadonlySet<string> = new Set();
  /** Source view: a block that prints nothing but its jump (see planSourceControl). */
  private quietJump: (block: BlockRegion) => boolean = () => false;
  /** Blocks printing nothing whose jump prints nothing either, by the block it
   * falls to: an edge reaching one of them arrives where it falls. Filled by
   * findLabels, later blocks first. */
  private readonly silentNext = new Map<string, string>();
  private readonly loopHeaders = new Set<string>();
  /** The silent blocks each fallthrough or break edge crosses before its target. */
  private readonly crossed = new Map<ParallelTransfer, readonly string[]>();
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
  /** Rotated loop headers (loop_copy_rotation): phi id -> the pseudo value every
   * edge into the header writes instead of the phi. */
  private readonly rotatedPhis = new Map<string, Map<string, Value>>();
  /** Do-while tests restated over the values written by their repeat copies. */
  private readonly rebased = new Map<string, Extract<Expression, { kind: 'compare' }>>();
  private readonly synthetic = new Map<string, Expression>();
  /** Exit edges of loop tests whose copies print after their loop, by test id. */
  private readonly loopExitCopies = new Map<string, ParallelTransfer>();
  /** Tests of enclosing `if`s merged into the next printed `if` (nestedIf). */
  private conjunct: readonly ConditionTerm[] | undefined;
  /** The next printed source-view `if` head continues an `else` (see elseArm). */
  private elseIf = false;
  /** Operands of a shared-arm condition printed so far (see planSharedArms). */
  private sharedPlan:
    | {
        readonly arm: ControlArm;
        readonly origin: Control;
        readonly form: 'all' | 'any';
        readonly terms: readonly ConditionTerm[];
      }
    | undefined;
  /** Source view: blocks a short-circuit condition may hold as a later operand
   * (see commaOperand): the one statement their test holds, null when they
   * print nothing before it. */
  private readonly commaOperands = new Map<string, Instruction | null>();
  /** The statement of the operand whose test prints next, as an expression:
   * `direct`, it replaces the test's one read of `value` (`(x = f()) != 0`,
   * `(x := f()) != 0`); else the C comma operator precedes the test. */
  private comma:
    | {
        readonly control: string;
        readonly node: Instruction;
        readonly value: Value;
        readonly text: string;
        readonly direct: boolean;
      }
    | undefined;
  /** Jump blocks holding the statement of the operand test they enter, by block id. */
  private readonly commaCarriers = new Map<string, string>();
  /** The statement of the operand block being printed, until its test takes it. */
  private commaHeld: { readonly control: string; readonly node: Instruction } | undefined;
  /** Statements and operand controls printed inside the next `if` head line. */
  private readonly headed: Origin[] = [];
  /** Exits of a joined-exit test after its first: their jump statement is the
   * first exit's (see joinedOperand); `transfer` records them without printing. */
  private readonly joinedExits = new Set<ParallelTransfer>();
  /** A test leaving by one jump statement whose later operands print next (see
   * joinedOperand): the `||` terms so far and the arms they leave by. */
  private joinedPlan:
    | {
        readonly target: string;
        readonly action: TransferAction;
        readonly terms: readonly ConditionTerm[];
        readonly exits: readonly (readonly [ControlArm, Control])[];
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
  /** `for` headers whose step (and init) are statements (Ghidra's
   * BlockWhileDo::finalTransform), by loop test control; the init may instead
   * be the entry edge's hoisted copy. Those statements are not printed in their blocks. */
  private readonly forStatements = new Map<
    string,
    {
      readonly init?: HeaderStatement;
      readonly copies?: ParallelTransfer;
      readonly step: HeaderStatement;
    }
  >();
  private readonly headerStatements = new Set<string>();
  private readonly typeRecords = new Map<string, SuppliedTypeRecord | null>();
  private readonly libraryDeclarations = new Map<string, readonly CatalogEntry[]>();
  private readonly callParameterSpellings = new Map<string, string | null>();
  /** C integer type of each printed struct-member lvalue, by its text. */
  private readonly memberTypes = new Map<string, IntegerCType>();
  /** Offsets of each structure's members this function's text accesses, by structure name. */
  private readonly usedMembers = new Map<string, Set<string>>();
  /** One IR access node per structure name that printed a member: the subject of
   * the structure's presentation records (a function-wide subject would cite every
   * instruction of the function). */
  private readonly structAccess = new Map<string, string>();
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
  /** First source address of each `va` value, in source order. */
  private readonly vaAddresses = new Map<bigint, Address>();
  /** Source view: values holding one character code (see source-characters.ts). */
  private characters: ReadonlySet<string> = new Set();
  private readonly sourceDataValue: (value: Value) => SourceAddress | undefined;
  private readonly dataTables = new Map<string, IndexedDataAccess & { readonly name: string }>();
  private indexedData: ReadonlyMap<string, IndexedDataAccess> = new Map();
  private readonly globals: GlobalPlan;
  private readonly usedGlobals = new Map<
    string,
    {
      readonly object: GlobalObject;
      readonly name: string;
      /** `symbol+0x<offset>` when the name is relative to a preceding symbol. */
      readonly relative?: string;
    }
  >();
  private readonly sourceValueTypes = new Map<string, string>();
  /** Single call results, by result value id (their library return spelling). */
  private readonly callResults = new Map<string, BoundaryProjection>();
  /** Pointer spellings chosen for locals from their definitions and uses. */
  private readonly localSpellings = new Map<string, string>();
  /** C integer types chosen for locals by conversion cost (see
   * planIntegerSpellings): signed, or narrower than the value's machine width. */
  private readonly localIntegers = new Map<string, IntegerCType>();
  /** Each such local's set (its first member): a variable holds one set only. */
  private readonly localIntegerSets = new Map<string, string>();
  /** Load/store nodes accessing a declared pointer member: that pointer type. */
  private readonly memberPointers = new Map<string, string>();
  /** Source view: the last named formal before `...` (`va_start`'s second argument). */
  private namedLast: string | undefined;
  /** C stores into a `void *` field of the SysV `va_list` (see `frameStorage`). */
  private readonly vaPointerStores = new Set<string>();
  /** Source view: the SysV `va_list` interface (S7), when the function has one. */
  private get vaList(): Extract<SourceVariadic, { kind: 'va_list' }> | undefined {
    const variadic = this.program.source?.variadic;
    return this.sourceView && variadic?.kind === 'va_list' ? variadic : undefined;
  }
  private sourceRoleNames: ReadonlyMap<string, string | null>;
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
    /** The function's reconstruction, shared by every attempt; it is never mutated. */
    reconstruction: Reconstruction,
    /** False when an earlier attempt already validated `reconstruction`. */
    validate: boolean,
    /** Call results never printed as their reader's operand; null: no call is. */
    private readonly rejectedCalls: ReadonlySet<string> | null = new Set(),
    private readonly metadata: 'full' | 'omitted' = 'full',
    plans: AttemptPlans = {},
  ) {
    this.writer = new Writer(context, options.indent, options.include_evidence, language, metadata);
    // Rendering records presentation rewrites in the validation session; each
    // attempt continues its own copy of the state reconstruction left.
    const session = reconstruction.local_validation_session?.fork();
    this.program = session
      ? { ...reconstruction, local_validation: session.records, local_validation_session: session }
      : reconstruction;
    this.inline = new Set(this.program.inline);
    this.bounds = new UnsignedBounds(this.program.expressions, context);
    this.sourceView = options.view !== 'checked';
    this.body = input.function.body;
    this.requirementPredicates = sourceRequirementPredicates(this.program.source?.requirements);
    this.localValidation = session ?? new LocalValidationSession(context);
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
    const plan = (plans.names ??= planSourceNames(
      this.program,
      this.names,
      input.types,
      context,
      this.sourceView,
    ));
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
      if (item.address.space === 'va' && !this.vaAddresses.has(item.address.value))
        this.vaAddresses.set(item.address.value, item.address);
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
        const result = projection.results[0]!;
        // A declared `void *` result (malloc) is refined by the object pointer
        // projection proved from its uses; C converts it implicitly.
        const declared = this.typeRecords.get(declaration.return_type)?.definition;
        const projected = this.program.source?.value_types?.get(result.id)?.type_id;
        const refined =
          declared?.kind === 'pointer' &&
          this.typeRecords.get(declared.to)?.definition.kind === 'void' &&
          projected !== undefined &&
          this.typeRecords.get(projected)?.definition.kind === 'pointer';
        if (!refined) this.sourceValueTypes.set(result.id, declaration.return_type);
        this.callResults.set(result.id, projection);
      }
    }
    if (this.sourceView) {
      this.stridedPointerTypes();
      this.characters = plans.characters ??= characterEvidence(this.program, context, {
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
          for (const binding of [
            ...node.register_outputs,
            ...registerOutputs(this.program.source, node),
          ])
            this.origins.set(binding.value.id, node);
      }
      if (this.controls.has(block.control.id))
        this.invalid('Duplicate structured control identity');
      this.controls.set(block.control.id, block.control);
      this.origins.set(block.control.id, block.control);
    }
    if (!this.program.blocks.has(input.function.entry))
      this.invalid('Structured function has no entry block');
    if (this.sourceView) this.planSourceControl(plans);
    this.cloneIds = new Set([...this.clones].map((block) => block.id));
    this.findLabels(this.body, [], 0);
    const crossed = new Set([...this.crossed.values()].flat());
    if (
      crossed.size &&
      !this.localValidation.presentation(
        'silent_block_crossing',
        this.input.function.id,
        'an edge whose lexical destination is a chain of blocks printing nothing (no statement, definition, note or edge copy; each jumps silently to the next, none heads a loop or is repeated by a tail copy) reaches the block after the chain: a goto to it prints nothing, and a goto from a loop to it, which is the loop continuation but for that chain, is a break; labels stay where they were and the blocks crossed are listed',
        [...crossed],
      )
    ) {
      // Keep the exact lexical rules.
      this.labels.clear();
      this.gotos.clear();
      this.actions.clear();
      this.consumed.clear();
      this.fallthrough.clear();
      this.loopTests.clear();
      this.silentNext.clear();
      this.crossed.clear();
      this.quietJump = () => false;
      this.findLabels(this.body, [], 0);
    }
    if (validate) validateReconstruction(this.program, context);
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
    const entryStack =
      stackEntry(this.program.source?.stack)?.id === id ||
      this.program.parameter_registers.get(id)?.role === 'stack_pointer';
    const stem =
      variadicArea(this.program.source?.variadic)?.id === id
        ? 'va'
        : entryStack
          ? 'entry_sp'
          : sourceIdentifierStem(preferred, linkage);
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
            if (this.sourceCarried.has(id)) return false;
            // The initial value of a loop variable shares its role, whatever its
            // own name, except that of a parameter (or a conversion of one): what
            // a caller passes is not an index or accumulator because the body then
            // steps or folds it.
            const head = this.sourceInitial.get(id);
            if (
              head !== undefined &&
              this.variables.get(head)?.id === representative &&
              this.sourceRoleNames.get(head) === role &&
              !fromParameter(this.program.values.get(id)!)
            )
              return true;
            if (name && !sourceGenericStems.has(name)) return false;
            const sources = merged.get(id),
              value = this.program.values.get(id)!,
              operand = converted(value);
            if (sources) return sources.every((source) => same(source, representative));
            if (operand !== undefined) return same(operand, representative);
            // An in-place update of the variable (it reads a member) is that variable.
            const expression = this.program.expressions.get(id);
            return (
              expression !== undefined &&
              expressionOperands(expression).some(
                (input) => this.variables.get(input.id)?.id === representative,
              )
            );
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
    if (this.comma?.direct && this.comma.value.id === value.id) return `(${this.comma.text})`;
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
      (Number(match[2]) === value.type.bits ||
        this.program.source?.formal_types?.has(value.id) ||
        this.localIntegers.has(value.id))
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
    const holder = given === undefined ? this.variables.get(value.id) : undefined;
    if (
      holder &&
      holder.id !== value.id &&
      value.type.kind === 'integer' &&
      bitWidth(holder.type) === value.type.bits
    ) {
      // A partition member presented differently from its variable defines it
      // through one exact conversion to the variable's declared type (the same
      // integer or address bits).
      const declared = this.declaredSpelling(value);
      if (declared !== this.valueType(value)) {
        if (this.language === 'python-like' && declared.startsWith('pointer['))
          return printed.ctype && !printed.ctype.signed && printed.ctype.bits <= value.type.bits
            ? printed
            : this.printer.reduce(value.type.bits, printed);
        if (this.language === 'c-like' && declared.endsWith('*')) {
          const step =
            assigned &&
            this.pointerStep(declared, this.declaredPointer(value), assigned, value.type.bits);
          if (step) return step;
          const sum = this.bytePointerAssignment(declared, assigned, value.type.bits);
          if (sum) return sum;
          const text = this.pointerValue(printed, declared);
          return {
            text,
            precedence: text === printed.pointer?.text ? PRIMARY : UNARY,
            ctype: null,
          };
        }
        const integer = this.declaredInteger(holder, declared);
        return integer?.signed ? this.printer.cast(integer.bits, true, printed) : printed;
      }
    }
    id ??=
      this.sourceValueTypes.get(value.id) ??
      this.program.source.value_types?.get(value.id)?.type_id;
    const type = id && this.typeRecords.get(id)?.definition;
    const spelled = given === undefined ? this.localSpellings.get(value.id) : undefined;
    if (
      !type &&
      spelled !== undefined &&
      value.type.kind === 'integer' &&
      !this.localIntegers.has(value.id)
    ) {
      // A local that only a pointer spelling types (no type record): same
      // conversion of the exact address bits.
      if (this.language === 'python-like')
        return printed.ctype && !printed.ctype.signed && printed.ctype.bits <= value.type.bits
          ? printed
          : this.printer.reduce(value.type.bits, printed);
      const sum = this.bytePointerAssignment(spelled, assigned, value.type.bits);
      if (sum) return sum;
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
      const step =
        assigned &&
        this.pointerStep(this.sourceType(id!), this.scalarPointee(id!), assigned, type.bits);
      if (step) return step;
      // Integer-to-pointer conversion of the exact address bits (a declared
      // pointer of the receiving type converts implicitly; a narrower integer goes
      // through uintptr_t, no implicit widening warning). A local with its own
      // inferred spelling (`char *`, `FILE *`) casts to that spelling.
      const declared = given === undefined ? this.declaredSpelling(value) : undefined;
      const spelling = declared?.endsWith('*') ? declared : this.sourceType(id!);
      const sum = this.bytePointerAssignment(spelling, assigned, type.bits);
      if (sum) return sum;
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
    const id = this.variableTypeId(load.address);
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

  /** `p = p + index * size + k` on variables declared with the same scalar
   * pointer `spelling` (element `element`) prints as C pointer arithmetic `p +
   * index + k/size` when the index is scaled by exactly the element size and
   * the byte displacement k is a multiple of it; C scales by exactly that size,
   * so the address bits agree. */
  private pointerStep(
    spelling: string,
    element: IntegerCType | null,
    expression: Expression,
    bits: number,
  ): Printed | null {
    if (
      expression.kind !== 'integer' ||
      (expression.op !== 'add' && expression.op !== 'sub') ||
      !element
    )
      return null;
    const size = BigInt(element.bits / 8);
    const sum = this.addressSum(
      expression,
      bits,
      size,
      (value) => !this.inline.has(value.id) && this.declaredSpelling(value) === spelling,
    );
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
      type.bits === expression.value.type.bits
    ) {
      const reinterpreted = this.reinterpret(
        this.value(expression.value),
        expression.value.type,
        type,
        expression.value.id,
      );
      if (reinterpreted) return reinterpreted;
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
      ...(this.sourceView ? { definition: this.definition } : {}),
    });
  }

  /** The pure IR definition of the value `printed` prints for `value`. */
  private definition = (value: Value): Expression | undefined => {
    value = this.substituted?.get(value.id) ?? value;
    return this.synthetic.get(value.id) ?? this.program.expressions.get(value.id);
  };

  /** Declared spelling of the variable a value prints as (its partition
   * representative's). */
  private declaredSpelling(value: Value): string {
    const holder = this.variables.get(value.id) ?? value;
    return this.declaredTypes.get(holder.id) ?? this.valueType(holder);
  }

  /** Whether the variable a value prints as (its partition representative)
   * was declared, as a formal or by the declaration pass. Only such a name is
   * an assignment target; any other live result prints through its value. */
  private declaredVariable(value: Value): boolean {
    return this.declaredTypes.has((this.variables.get(value.id) ?? value).id);
  }

  /** Type record id of the variable a value prints as (its partition
   * representative's): reads through the variable see that type. */
  private variableTypeId(value: Value): string | undefined {
    const holder = this.variables.get(value.id) ?? value;
    return (
      this.sourceValueTypes.get(holder.id) ??
      this.program.source?.value_types?.get(holder.id)?.type_id
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
  /** Source view: `text` (a value of type `from`) as type `to` by exact bit
   * reinterpretation. C prints a validated equal-width integer/IEEE memcpy
   * helper; otherwise (Python-like, other types, refused record) the explicit
   * `cast_bitcast` helper. Null in C when no validated helper applies. */
  private reinterpret(
    text: string,
    from: DataType,
    to: DataType,
    subject: string,
    fallback = false,
  ): Printed | null {
    if (
      this.language === 'c-like' &&
      (to.kind === 'integer' || to.kind === 'float') &&
      (from.kind === 'integer' || from.kind === 'float') &&
      to.kind !== from.kind &&
      (to.bits === 32 || to.bits === 64) &&
      to.bits === from.bits &&
      this.localValidation.presentation(
        'c_bitcast',
        subject,
        'equal-width integer/IEEE storage copied with memcpy, preserving every bit without aliasing or numeric conversion',
      )
    ) {
      this.localValidation.requireAbi(
        'c_bitcast',
        [subject],
        'Native C float/double and integer storage use the target IEEE binary32/binary64 representation and matching byte order.',
      );
      const target = `${to.kind === 'float' ? 'f' : 'u'}${to.bits}`;
      const source = `${from.kind === 'float' ? 'f' : 'u'}${to.bits}`;
      return this.printer.primary(
        this.call(
          `__od_bitcast_${target}_${source}`,
          'Copy the exact same-width IEEE/integer object representation; preserve NaN payloads and signed zero.',
          [text],
        ),
        to.kind === 'integer' ? { bits: to.bits, signed: false } : null,
      );
    }
    if (this.language === 'c-like' && !fallback) return null;
    return this.printer.primary(
      this.call('cast_bitcast', castExplanation('bitcast'), [
        this.writer.quote(machineType(to)),
        this.writer.quote(machineType(from)),
        text,
      ]),
      to.kind === 'integer' ? { bits: to.bits, signed: false } : null,
    );
  }

  /** Source view: the promoted local a load/store accesses when the access's
   * type differs from the local's declared type (a punned slot). */
  private punnedLocal(
    node: Extract<Instruction, { kind: 'load' | 'store' }>,
  ): SourceLocal | undefined {
    const local = this.sourceView ? this.program.source?.locals.get(node.id) : undefined;
    return local && !sameType(local.type, node.kind === 'load' ? node.result.type : node.value.type)
      ? local
      : undefined;
  }

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
    const chosen = this.localIntegers.has((this.variables.get(destination.id) ?? destination).id);
    // A local signed by conversion cost: C assignment converts to it, so the
    // signed variable a same-width reinterpretation re-read passes unchanged.
    if (chosen && declared?.signed) return this.signedContext(value, declared.bits);
    // A narrow local keeps the low bits of any assigned value: the operand of
    // its final reduction or zero extension has the same low bits.
    if (chosen && declared && declared.bits < bitWidth(destination.type))
      return (value.unreduced ?? value.widened ?? value).text;
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
    const variadic = this.program.source?.variadic,
      area = variadic?.kind === 'area' ? variadic : undefined;
    // `va_list` is `char *` on Darwin arm64 and Win64: its address bits.
    if (area?.area.id === value.id) {
      const name = this.local(value);
      return python
        ? this.printer.primary(name, { bits: 64, signed: false })
        : { text: `(uintptr_t)${name}`, precedence: UNARY, ctype: { bits: 64, signed: false } };
    }
    const stack = this.program.source?.stack;
    let offset = this.program.source?.stack_addresses.get(value.id);
    // The incoming object, and beside a live entry SP the frame object below it.
    const object = offset === undefined ? undefined : this.stackObject(offset);
    if (object) return this.frameAddress(object, offset!);
    if (stack && offset !== undefined) {
      const entry = stackEntry(stack);
      if (entry) {
        if (source) {
          // The variadic area is entry-SP offset `variadic.offset`.
          if (area?.area.id === entry.id) offset -= area.offset;
          const base = this.printed(entry);
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
        const base = this.value(entry);
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
      const punned = this.punnedLocal(load);
      if (punned) {
        this.expanding.delete(value.id);
        return this.reinterpret(storage, punned.type, load.result.type, load.id, true)!;
      }
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

  /** Whether the file prints an inline `...` for an open argument list (see inlineEllipsis). */
  private ellipsisUsed = false;
  /** Direct callees (printed names) whose call sites print only the proven arguments:
   * the one `open arity` comment states that each may take more. */
  private readonly openCallees = new Set<string>();
  /** Address keys of callees with a call that is not an open list (a closed or guessed
   * list, or an established prototype): one comment cannot tell their sites apart, so
   * their open sites keep the inline marker. Computed once per rendering. */
  private closedCallees: ReadonlySet<string> | undefined;

  /** An open argument list: a call interface that proves only a prefix of its arguments. */
  private openList(projection: BoundaryProjection): boolean {
    return (
      !this.likelyArgumentList(projection) &&
      (projection.argument_list_complete === false || projection.kind === 'physical')
    );
  }

  private closedCalleeKeys(): ReadonlySet<string> {
    if (this.closedCallees) return this.closedCallees;
    const closed = new Set<string>();
    for (const [id, projection] of this.program.calls) {
      const node = this.statements.get(id);
      if (node?.kind !== 'call' || node.target.kind !== 'direct') continue;
      if (projection.signature || !this.openList(projection))
        closed.add(this.addressKey(node.target.address));
    }
    for (const tail of this.program.tails.values())
      if (
        tail.target !== null &&
        (tail.boundary.signature ||
          tail.boundary.argument_list_complete !== false ||
          this.likelyArgumentList(tail.boundary))
      )
        closed.add(this.addressKey(tail.target));
    this.closedCallees = closed;
    return closed;
  }

  /** An open indirect call prints only its proven arguments in a function-pointer cast of
   * exactly those positions: the one `open arity` comment states that it may take more. */
  private openIndirectCall(origin: Origin): void {
    // The instruction's virtual address; provenance ranges are file offsets, which
    // print as such only where no address mapping is supplied.
    const address = this.input.instruction_address?.(origin.provenance.instruction_ids[0] ?? '');
    const start = origin.provenance.ranges[0]?.start;
    const where =
      address?.space === 'va'
        ? ` at 0x${address.value.toString(16)}`
        : start
          ? ` at ${start.space === 'va' ? '' : start.space === 'file' ? 'file offset ' : `${start.space} `}0x${start.value.toString(16)}`
          : '';
    this.openCallees.add(`indirect call${where}`);
  }

  /** Source view: whether a direct call to `key` prints only its proven arguments, the
   * callee's open arity being stated once in the `open arity` comment. An interface that
   * proves no argument keeps the marker (an empty list would read as zero arguments), as
   * does any callee with an established prototype (its `...` means variadic, not open). */
  private statesOpenArity(projection: BoundaryProjection, key: string | undefined): boolean {
    return (
      this.sourceView &&
      key !== undefined &&
      !projection.signature &&
      projection.arguments.length > 0 &&
      !this.closedCalleeKeys().has(key)
    );
  }

  /** The open remainder of a call's argument list in the checked view: the named helper.
   * The source view registers the helper in the metadata and prints `...` only where no
   * declaration states the open arity (see inlineEllipsis). */
  private openRemainder(helper: string, explanation: string): string | undefined {
    if (!this.sourceView) return this.call(helper, explanation, []);
    this.writer.helper(helper, explanation);
    return undefined;
  }

  /** The inline marker of an open list that no declaration states; the file header
   * states its meaning once. */
  private inlineEllipsis(): string {
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
      this.mapped(this.dataOrigin(id), start, [id], [note.evidence_ids]);
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

  /** Mappings of this attempt, published in order once its body can no longer be
   * retried: a retried attempt's text and metadata are discarded, so it interns and
   * unions nothing. Null once published; later mappings publish immediately. */
  private pendingMappings: (() => void)[] | null = [];

  /** Map `[start, end)` to `origin`; `ids` may be computed when the mapping is published. */
  private mapped(
    origin: Origin,
    start: number,
    ids: readonly string[] | (() => readonly string[]) = [],
    evidence: readonly EvidenceSource[] = [],
    end = this.writer.offset,
  ): void {
    // Empty spans publish nothing; never intern identities for them.
    if (start === end) return;
    const publish = (): void =>
      this.publishMapping(origin, start, typeof ids === 'function' ? ids() : ids, evidence, end);
    if (!this.pendingMappings) return publish();
    this.context.checkpoint(1);
    this.pendingMappings.push(publish);
  }

  private publishMappings(): void {
    const pending = this.pendingMappings ?? [];
    this.pendingMappings = null;
    for (const publish of pending) publish();
  }

  private publishMapping(
    origin: Origin,
    start: number,
    ids: readonly string[],
    evidence: readonly EvidenceSource[],
    end: number,
  ): void {
    const contributors = this.program.source?.value_origins;
    const references = this.writer.references();
    for (const id of [origin.id, ...ids])
      for (const subject of contributors?.get(id) ?? [id]) references.add(subject);
    if (references.ids.length === 0) references.add(origin.id);
    const subjects = references.ids;
    // Evidence lists are passed by identity: the writer unions each distinct
    // sequence once (duplicates across lists are removed there, in order).
    const dataEvidence: EvidenceSource[] = [...evidence];
    const dataSubjects = new Set([origin.id, ...ids]);
    for (const id of subjects) dataSubjects.add(id);
    for (const id of dataSubjects) {
      const type = this.program.source?.value_types?.get(id);
      if (type) {
        references.add(type.type_id);
        for (const subject of [...type.association_ids, ...type.subject_ids])
          references.add(subject);
        dataEvidence.push(type.evidence_ids);
      }
      const value = this.program.values.get(id);
      if (!value) continue;
      const data = this.sourceDataValue(value);
      if (data?.object) dataEvidence.push(data.object.evidence_ids);
    }
    this.writer.map(
      { ...origin, id: subjects[0] ?? origin.id },
      start,
      references,
      dataEvidence,
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
      const prefix = shared;
      this.mapped(contributor, start, () => [...prefix, ...this.semanticIds(contributor)], [], end);
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
        proof ? [site.node.contract_evidence, proof.evidence] : [site.node.contract_evidence],
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
          this.writer.quote(
            item.name ??
              (item.symbol_relative && object.offset === 0n
                ? `${item.symbol_relative.name}+0x${item.symbol_relative.offset.toString(16)}`
                : `data_${object.address.value.toString(16)}`),
          ),
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
    const relative = global.relative && this.relativeName(global.relative);
    const name = this.sourceIdentifier(
      global.key,
      relative?.stem ?? global.stem,
      global.native_name !== undefined,
    );
    this.usedGlobals.set(global.key, {
      object: global,
      name,
      ...(relative ? { relative: relative.text } : {}),
    });
    return name;
  }

  /** `symbol_0x<offset>` for storage no symbol covers, named after the preceding
   * object symbol of its section (`symbol+0x<offset>` for comments), when the
   * `symbol_relative_name` record is admitted. One record per function states the
   * rule; the declaration's mapping carries each symbol's evidence. */
  private relativeName(relative: {
    readonly symbol: string;
    readonly offset: bigint;
  }): { readonly stem: string; readonly text: string } | undefined {
    const offset = `0x${relative.offset.toString(16)}`;
    return this.localValidation.presentation(
      'symbol_relative_name',
      this.input.function.id,
      'image storage that no symbol or data record covers is named after the nearest preceding object symbol of its section plus the exact byte offset, when no other symbol or data record starts in between; naming only, the extent stays unknown',
    )
      ? {
          stem: `${relative.symbol}_${offset}`,
          // Comment text: an asserted name cannot close the comment.
          text: `${relative.symbol.replace(/\*\//g, '* /')}+${offset}`,
        }
      : undefined;
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
      this.context.checkpoint(1);
      return this.vaAddresses.get(fact.bits);
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

  /** A runtime call target in callable context: a declared pointer local
   * prints as itself, any other value as its integer bits. */
  private indirectCallee(value: Value): string {
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
      const id = this.variableTypeId(candidate);
      const type = id && this.typeRecords.get(id)?.definition;
      // Callable context retains the declared pointer local; value() converts
      // pointers to integer bits for machine arithmetic, not invocation.
      if (type && type.kind === 'pointer') return this.local(candidate);
    }
    return this.value(value);
  }

  private sourceCallee(node: Extract<Instruction, { kind: 'call' }>): string {
    if (node.target.kind === 'indirect') return this.indirectCallee(node.target.value);
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

  /** Source view: whether the call's clobber contract is retained in its
   * `call_effects` record instead of printing as a boundary statement before
   * the call. Planning (commaValue) and printing ask with the same scope and
   * contract, so an answer given at planning time holds when the call prints. */
  private callEffectsAdmitted(node: Extract<Instruction, { kind: 'call' }>): boolean {
    const contract = this.effectContract(node.clobbers);
    return (
      contract !== null &&
      this.localValidation.presentation(
        'call_effects',
        node.id,
        CALL_EFFECTS_SCOPE,
        [node.effect_in.id, node.effect_out.id],
        contract,
      )
    );
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
    const member = this.language === 'c-like' ? this.scalarPointerMember(value, bits, kind) : null;
    if (member !== null) return member;
    const pointer = this.scalarPointer(value);
    if (this.language !== 'c-like' || pointer?.bits !== bits || pointer.kind !== kind) return null;
    const load = this.inlined.get(value.id)?.node;
    return load?.kind === 'load' && this.slotType(load.id) ? this.storage(load) : this.local(value);
  }

  /** The lvalue `p->field` of an inline read of a declared pointer member
   * whose pointee is an unsigned integer (or float) of exactly `bits`/`kind`:
   * `*p->field` dereferences it without an integer round trip. */
  private scalarPointerMember(value: Value, bits: number, kind: PointeeKind): string | null {
    if (!this.inline.has(value.id) || value.type.kind !== 'integer' || value.type.bits !== 64)
      return null;
    const load = this.inlined.get(value.id)?.node;
    if (load?.kind !== 'load' || this.slotType(load.id) || this.punnedLocal(load)) return null;
    const text = this.storage(load),
      id = this.memberPointers.get(load.id),
      pointer = id ? this.typeRecords.get(id)?.definition : undefined;
    if (pointer?.kind !== 'pointer') return null;
    const pointee = this.typeRecords.get(this.naturalScalar(pointer.to) ?? pointer.to)?.definition;
    const matches =
      kind === 'integer'
        ? pointee?.kind === 'integer' && !pointee.signed && pointee.bits === bits
        : pointee?.kind === 'float' && pointee.bits === bits;
    if (!matches) return null;
    // The dereference reads the pointee's own unsigned integer type.
    if (kind === 'integer') this.memberTypes.set(`*${text}`, { bits, signed: false });
    return text;
  }

  /** A stored value converted to a declared pointer member's type: the same
   * declared pointer, a null constant, or the exact address bits. */
  private memberPointerValue(value: Value, typeId: string): string {
    const spelling = this.sourceType(typeId);
    if (this.constantOf(value) === 0n) return '0';
    if (!this.inline.has(value.id) && this.declaredSpelling(value) === spelling)
      return this.local(value);
    return this.pointerValue(this.printed(value), spelling);
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
  private memberAccess(address: Value, bits: number, node?: string, float = false): string | null {
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
      id = this.variableTypeId(base);
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
        !(float
          ? kind === 'float'
          : kind === 'integer' || (kind === 'pointer' && item.count === undefined))
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
    const field = structMemberName(member);
    const used = this.sourceStructs.name(pointer.to);
    const offsets = this.usedMembers.get(used) ?? new Set<string>();
    offsets.add(usedMemberKey(member));
    this.usedMembers.set(used, offsets);
    if (node && !this.structAccess.has(used)) this.structAccess.set(used, node);
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

  /** The declarations of the structures the finished text accesses, one entry per
   * structure: only the members it prints, never the image-wide layout, which stays
   * in the types view / types.h. A structure the text never indexes stays an
   * incomplete type. External text (`compact` false) keeps every offset as byte
   * gaps (`uint8_t pad_0xN[K];`); compact (inline) text omits the gaps before members
   * whose name states their offset (`field_0x14`), returning them in `gaps`: only a
   * declared member name (an Objective-C ivar) keeps its pad, as the name does not
   * carry the offset. The access stride comment states what a trailing pad would. */
  private structureBodies(compact: boolean): StructureBody[] {
    const bodies: StructureBody[] = [];
    for (const id of this.structureSlot?.ids ?? []) {
      this.context.checkpoint(1);
      const members = this.partialLayout(id);
      if (!members) continue;
      const name = this.sourceStructs.name(id),
        used = this.usedMembers.get(name);
      if (!used) continue;
      const parts: string[] = [],
        lines: string[] = [],
        gaps: StructureBody['gaps'][number][] = [];
      let end = 0n,
        packed = false;
      const declare = (member: ObservedMember): string => {
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
        return `${spelling} ${structMemberName(member)}${array};`;
      };
      for (let index = 0; index < members.length; index++) {
        const member = members[index]!;
        // The integer member of an overlay is followed by its floating partner;
        // both print as one anonymous union only when the text uses both.
        const partner = member.overlaid && !member.float ? members[index + 1] : undefined;
        if (partner) index++;
        const printed = [member, ...(partner ? [partner] : [])].filter((item) =>
          used.has(usedMemberKey(item)),
        );
        if (!printed.length) continue;
        // A member named by its offset states where it is: compact text omits the gap.
        if (member.offset > end) {
          if (compact && member.name === undefined)
            gaps.push({ offset: end, length: member.offset - end });
          else parts.push(`uint8_t ${paddingName(end)}[${member.offset - end}];`);
        }
        parts.push(
          printed.length === 2
            ? `union { ${printed.map(declare).join(' ')} };`
            : declare(printed[0]!),
        );
        packed ||= member.offset % BigInt(member.bits / 8) !== 0n;
        end = member.offset + member.size;
      }
      const stride = this.sourceStructs.strides.get(id);
      if (stride) {
        if (stride > end) {
          if (compact) gaps.push({ offset: end, length: stride - end });
          else parts.push(`uint8_t ${paddingName(end)}[${stride - end}];`);
        }
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
      bodies.push({ name, lines, gaps });
    }
    return bodies;
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

  /** Declarations of the callees with an established prototype (library, debug or
   * recovered source signature). A call interface observed only at its call sites is
   * not declared: the call already shows it, and an open one is stated by the
   * `open arity` comment. */
  private declareSourceCallees(): void {
    if (!this.sourceView || this.language !== 'c-like') return;
    const declarations = new Map<string, { text: string; node: Instruction } | null>();
    for (const [id, projection] of this.program.calls) {
      const node = this.statements.get(id);
      if (node?.kind !== 'call' || node.target.kind !== 'direct' || this.objcSend(node)) continue;
      const name = this.sourceCallee(node);
      if (name === this.identifiers.get(this.input.function.id)?.identifier) continue;
      const signature = projection.signature?.signature;
      if (!signature || projection.results.length > 1) continue;
      const parameters = signature.parameters.map((_, index) =>
        this.callParameterType(projection, index),
      );
      if (signature.variadic && parameters.length === 0) continue;
      if (signature.variadic) parameters.push('...');
      const text = `extern ${signature.noreturn ? '_Noreturn ' : ''}${this.callReturnType(projection)} ${name}(${parameters.length ? this.writer.join(parameters) : 'void'});`;
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
      const signature = this.program.calls.get(node.id)!.signature!;
      if (
        !this.localValidation.presentation(
          'call_declaration',
          node.id,
          'C declaration from the recovered source signature',
        )
      )
        continue;
      const start = this.writer.offset;
      this.writer.line(0, text);
      this.mapped(node, start, [], [signature.evidence_ids]);
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
      spans: {
        readonly object: GlobalObject;
        readonly start: number;
        readonly end: number;
        readonly relative: boolean;
      }[] = [];
    let offset = at;
    for (const { object: global, name, relative } of this.usedGlobals.values()) {
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
            ...(relative === undefined ? [] : [plain(relative)]),
            ...(global.object.byte_length === null ? [] : [`${global.object.byte_length} bytes`]),
            ...(global.object.kind === 'bytes' ? [] : [global.object.kind.replace('_', ' ')]),
            ...(global.initial_import === undefined
              ? []
              : [`initially ${plain(global.initial_import)}`]),
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
      spans.push({
        object: global,
        start: offset,
        end: offset + length,
        relative: relative !== undefined,
      });
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
          span.object.object.evidence_ids,
          ...(span.object.import ? [span.object.import.evidence_ids] : []),
          ...(span.relative && span.object.relative ? [span.object.relative.evidence_ids] : []),
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
      readonly relative: string | undefined;
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
      const symbolRelative = table.data.symbol_relative;
      const relative =
        symbolRelative?.source_name !== undefined &&
        table.data.source_name === undefined &&
        table.data.name === undefined &&
        object.offset === 0n
          ? this.relativeName({
              symbol: symbolRelative.source_name,
              offset: symbolRelative.offset,
            })
          : undefined;
      const stem =
        table.data.source_name ??
        table.data.name ??
        relative?.stem ??
        `data_${object.address.value.toString(16)}`;
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
          relative: relative?.text,
          reach: table.last + 1n,
        });
    }
    for (const group of groups.values()) {
      const { table } = group,
        object = table.data.object,
        node = this.statements.get(group.first)!;
      const start = this.writer.offset;
      const contents = this.tableContents(group.name, table, group.reach, group.first, [
        group.address,
      ]);
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
            `extern ${object.mutable ? '' : 'const '}uint${table.bits}_t ${group.name}[]; /* VA 0x${hex}, ${group.relative === undefined ? '' : `${group.relative}, `}${extent} */`,
          );
        else
          this.writer.line(
            0,
            `${group.name} = memory_view(0x${hex}, "uint${table.bits}_t", ${object.mutable ? 'True' : 'False'})  # ${group.relative === undefined ? '' : `${group.relative}, `}${extent}`,
          );
        this.writer.helper(
          this.language === 'c-like' ? group.name : 'memory_view',
          'Image-backed indexed storage view at the declared VA; no allocation or invented extent. Index units are the declared scalar width. Reads retain original byte order, aliasing and faults; no Python sequence bounds or negative-index rebasing.',
        );
      }
      this.mapped(
        node,
        start,
        [group.address],
        [
          object.evidence_ids,
          ...(group.relative !== undefined && table.data.symbol_relative
            ? [table.data.symbol_relative.evidence_ids]
            : []),
        ],
      );
    }
  }

  /** Declaration lines of a read-only table with its contents, or undefined when
   * its bytes are not established. The element count is an established extent
   * only when it comes from a symbol size (capped by the accessed range,
   * `reach`: the greatest index every access can take, plus one) or from the
   * accessed range itself, which must lie within the distance to the next
   * symbol, data record, relocation or section end (`span_bound`, a bound and
   * never a size). Otherwise the declaration is `name[]` with the first row. */
  private tableContents(
    name: string,
    table: IndexedDataAccess,
    reach: bigint,
    subject: string,
    subjectIds: readonly string[],
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
    const { byte_length: symbolSize, span_bound: spanBound } = object;
    const total =
      symbolSize != null
        ? reach < symbolSize / size
          ? reach
          : symbolSize / size
        : spanBound != null
          ? reach <= spanBound / size
            ? reach
            : undefined
          : reach <= 4096n
            ? reach
            : undefined;
    const full = total !== undefined && total * size <= TABLE_FULL_BYTES;
    let shown = full ? total : BigInt(TABLE_PREFIX_BYTES / width);
    if (total !== undefined && total < shown!) shown = total;
    shown =
      shown! < BigInt(Math.floor(bytes.length / width))
        ? shown!
        : BigInt(Math.floor(bytes.length / width));
    if (shown <= 0n || Number(shown) * width > this.tableBudget) return undefined;
    if (
      total !== undefined &&
      !this.localValidation.presentation(
        'table_extent',
        subject,
        'the declared element count is a symbol size or an accessed range inside the next-symbol bound; a neighbour distance is never an extent',
        subjectIds,
      )
    )
      return undefined;
    this.tableBudget -= Number(shown) * width;
    const values: string[] = [];
    for (let index = 0; index < Number(shown); index++) {
      let value = 0n;
      for (let byte = width - 1; byte >= 0; byte--)
        value = (value << 8n) | BigInt(bytes[index * width + byte]!);
      values.push(value < 1n << 32n ? String(value) : `0x${value.toString(16)}`);
    }
    const hex = object.address.value.toString(16);
    const rest = total === undefined ? undefined : total - shown;
    const more =
      rest === undefined ? 'further elements not shown' : rest > 0n ? `${rest} more` : undefined;
    const elements = `${total === undefined ? `first ${shown}` : `${total}`} ${this.language === 'c-like' ? '' : `uint${table.bits}_t `}elements`;
    const note = `VA 0x${hex}, read-only; ${elements}`;
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

  /** Element spelling of a plain (little-endian, nonvolatile, alignment 1)
   * memory access, shared by cast dereferences and frame members. */
  private plainAccessSpelling(node: Extract<Instruction, { kind: 'load' | 'store' }>): string {
    const type = this.accessType(node);
    if (this.program.source?.float_accesses?.has(node.id))
      return type.kind === 'float' && type.bits === 32 ? 'float' : 'double';
    return type.kind === 'integer' ? `uint${type.bits}_t` : machineType(type);
  }

  /** Source view: the stack object that prints entry-SP `offset`. The incoming
   * object (S4) holds offsets from its start up; the frame object holds
   * offsets below the entry SP, and every offset when no entry SP is live
   * beside it. Members are named by entry-SP offset; an independent member
   * (A3) is a local of its own. */
  private stackObject(offset: bigint): StackObjectView | undefined {
    const incoming = this.program.source?.incoming_object,
      stack = this.program.source?.stack;
    if (incoming && offset >= incoming.minimum_offset) {
      const name = () => this.sourceIdentifier(incoming.formal.id, 'stack_args');
      return {
        name,
        minimum_offset: incoming.minimum_offset,
        members: incoming.members,
        member: (member) => `${name()}.arg_${member.offset.toString(16)}`,
      };
    }
    if (stack?.kind === 'object' && (offset < 0n || !stack.entry)) {
      const name = () => {
        if (stack.members.every((member) => member.independent))
          this.invalid('A frame address lies outside every independent frame local');
        return this.sourceIdentifier(stack.id, 'frame');
      };
      return {
        name,
        minimum_offset: stack.minimum_offset,
        members: stack.members,
        member: (member) =>
          member.independent
            ? this.frameLocal(member, member.independent)
            : `${name()}.local_${(-member.offset).toString(16)}`,
      };
    }
    return undefined;
  }

  /** Source view (A3): the name of an independent frame local. */
  private frameLocal(member: FrameMember, local: { readonly id: string }): string {
    return this.sourceIdentifier(local.id, `local_${(-member.offset).toString(16)}`);
  }

  /** The member of a stack object holding entry-SP byte `offset` and the offset within it. */
  private frameMemberAt(
    object: { readonly members: readonly FrameMember[] },
    offset: bigint,
  ): { member: FrameMember; delta: bigint } | undefined {
    const members = object.members;
    // One charge per lookup: the binary search takes at most log2(members) steps.
    this.context.checkpoint(1);
    for (let low = 0, high = members.length - 1; low <= high;) {
      const middle = (low + high) >> 1,
        member = members[middle]!;
      if (offset < member.offset) high = middle - 1;
      else if (offset >= member.offset + member.size) low = middle + 1;
      else return { member, delta: offset - member.offset };
    }
    return undefined;
  }

  private readonly frameTypes = new Map<FrameMember, string>();
  /** Declared type of a stack-object member: a byte array, or the one spelling
   * every plain access of a scalar member uses (else the unsigned integer of its width). */
  private frameMemberType(member: FrameMember): string {
    if (!member.scalar) return 'uint8_t';
    let type = this.frameTypes.get(member);
    if (type !== undefined) return type;
    let common: string | null | undefined;
    for (const id of member.access_ids) {
      this.context.checkpoint(1);
      const node = this.statements.get(id);
      if (
        (node?.kind !== 'load' && node?.kind !== 'store') ||
        node.access.endian !== 'little' ||
        node.access.volatile ||
        node.access.alignment !== 1
      )
        continue;
      const spelled = this.plainAccessSpelling(node);
      common = common === undefined || common === spelled ? spelled : null;
    }
    type = common ?? `uint${member.size * 8n}_t`;
    this.frameTypes.set(member, type);
    return type;
  }

  /** Address of entry-SP `offset` in a stack object: `&frame.local_38`,
   * `&stack_args.arg_8`, an element of a byte-array member, else a byte offset
   * from the object. */
  private frameAddress(object: StackObjectView, offset: bigint): Printed {
    const found = this.frameMemberAt(object, offset),
      address = { bits: 64, signed: false } as const;
    // SysV `va_list` (S7): `frame.va`, or one of its fields.
    if (found?.member.va) {
      const va = `${object.name()}.va`,
        field = VA_LIST_FIELDS.get(found.delta);
      if (this.language === 'python-like') {
        const base = this.printer.primary(
          `address_of(${field && found.delta ? `${va}[0].${field.name}` : va})`,
          address,
        );
        return field
          ? base
          : this.printer.binary('+', base, this.printer.literal(found.delta, 64), address);
      }
      if (field && found.delta) {
        const pointer = {
          text: `&${va}[0].${field.name}`,
          type: field.pointer ? 'void**' : 'uint32_t*',
        };
        return { text: `(uintptr_t)${pointer.text}`, precedence: UNARY, ctype: address, pointer };
      }
      const base: Printed = { text: `(uintptr_t)${va}`, precedence: UNARY, ctype: address };
      return found.delta
        ? this.printer.binary('+', base, this.printer.literal(found.delta, 64), address)
        : base;
    }
    const member =
      found && (found.delta === 0n || !found.member.scalar)
        ? object.member(found.member)
        : undefined;
    if (!member && found?.member.independent)
      this.invalid('An address lies inside an independent scalar frame local');
    const name = member ? '' : object.name();
    if (this.language === 'python-like') {
      const base = this.printer.primary(`address_of(${member ?? name})`, address),
        delta = member ? found!.delta : offset - object.minimum_offset;
      return delta === 0n
        ? base
        : this.printer.binary('+', base, this.printer.literal(delta, 64), address);
    }
    if (member) {
      const pointer =
        found!.delta === 0n
          ? { text: `&${member}`, type: `${this.frameMemberType(found!.member)}*` }
          : {
              text: `&${member}[${this.printer.literal(found!.delta, 64).text}]`,
              type: 'uint8_t*',
            };
      return { text: `(uintptr_t)${pointer.text}`, precedence: UNARY, ctype: address, pointer };
    }
    const base: Printed = { text: `(uintptr_t)&${name}`, precedence: UNARY, ctype: address };
    const delta = offset - object.minimum_offset;
    return delta === 0n
      ? base
      : this.printer.binary('+', base, this.printer.literal(delta, 64), address);
  }

  /** A plain access at a known stack-object offset: the member itself when it
   * is exactly that member with its declared type, otherwise one cast
   * dereference of the member or object bytes. Undefined keeps the general
   * memory spelling (volatile, big-endian, aligned or non-byte accesses, and
   * bytes at or above the entry SP beside the frame object). */
  private frameStorage(node: Extract<Instruction, { kind: 'load' | 'store' }>): string | undefined {
    const offset = this.program.source?.stack_addresses.get(node.address.id),
      bits = BigInt(bitWidth(this.accessType(node)));
    const object = offset === undefined ? undefined : this.stackObject(offset);
    if (
      !object ||
      offset === undefined ||
      bits % 8n ||
      node.access.endian !== 'little' ||
      node.access.volatile ||
      node.access.alignment !== 1
    )
      return undefined;
    const found = this.frameMemberAt(object, offset),
      spelled = this.plainAccessSpelling(node);
    const member = found && object.member(found.member);
    if (found?.member.scalar && found.delta !== 0n && found.member.independent)
      this.invalid('An access lies inside an independent scalar frame local');
    if (found?.member.va) {
      // SysV `va_list` (S7): exactly one field; its pointers read as address
      // bits and are written from `void *` (`vaPointerStores`).
      const field = VA_LIST_FIELDS.get(found.delta);
      if (field?.bytes !== bits / 8n || !this.permitUnaligned(node)) return undefined;
      const text = `${object.name()}.va[0].${field.name}`;
      if (!field.pointer || this.language !== 'c-like') return text;
      if (node.kind === 'load') return `(uintptr_t)${text}`;
      this.vaPointerStores.add(node.id);
      return text;
    }
    let text: string | undefined;
    if (
      found?.member.scalar &&
      found.delta === 0n &&
      found.member.size * 8n === bits &&
      this.frameMemberType(found.member) === spelled
    )
      text = member;
    else if (this.language === 'python-like') return undefined;
    else if (found?.member.scalar && found.delta === 0n) text = `*(${spelled} *)&${member}`;
    else if (found && !found.member.scalar)
      text =
        found.delta === 0n
          ? `*(${spelled} *)${member}`
          : `*(${spelled} *)&${member}[${this.printer.literal(found.delta, 64).text}]`;
    else {
      const delta = offset - object.minimum_offset,
        name = object.name();
      text =
        delta === 0n
          ? `*(${spelled} *)&${name}`
          : `*(${spelled} *)((uint8_t *)&${name} + ${this.printer.literal(delta, 64).text})`;
    }
    return this.permitUnaligned(node) ? text : undefined;
  }

  /** SysV `va_list` (S7): `va_start(frame.va, <last named>);` in place of the
   * last hidden store of its lowering (`anchor`), which it maps to. */
  private vaStart(anchor: Instruction, depth: number): void {
    const stack = this.program.source?.stack;
    if (stack?.kind !== 'object' || !stack.members.some((member) => member.va))
      this.invalid('A SysV va_start has no va_list frame member');
    const start = this.writer.offset,
      last = this.namedLast;
    this.writer.statement(
      depth,
      `va_start(${this.sourceIdentifier(stack.id, 'frame')}.va${last ? `, ${last}` : ''})`,
    );
    this.map(anchor, start);
  }

  /** Source view (S4): the struct tag of the incoming object and its member
   * declarations from its start in entry-SP order, padding between (C
   * `T arg_8`, Python-like `arg_8: T`); packed when a scalar member is not at
   * its natural alignment. */
  private incomingStruct(incoming: IncomingObject): {
    tag: string;
    members: string[];
    packed: boolean;
  } {
    const c = this.language === 'c-like',
      members: string[] = [];
    const declare = (field: string, type: string): string =>
      c ? `${type} ${field}` : `${field}: ${type}`;
    let end = incoming.minimum_offset,
      packed = false;
    for (const member of incoming.members) {
      this.context.checkpoint(1);
      if (member.offset > end) {
        const gap = `pad_${end.toString(16)}`;
        members.push(
          c
            ? `uint8_t ${gap}[${member.offset - end}]`
            : declare(gap, `array<uint8_t, ${member.offset - end}>`),
        );
      }
      const field = `arg_${member.offset.toString(16)}`;
      members.push(
        member.scalar
          ? declare(field, this.frameMemberType(member))
          : c
            ? `uint8_t ${field}[${member.size}]`
            : declare(field, `array<uint8_t, ${member.size}>`),
      );
      packed ||= member.scalar && (member.offset - incoming.minimum_offset) % member.size !== 0n;
      end = member.offset + member.size;
    }
    return {
      tag: this.sourceIdentifier(incoming.id, `stack_args_${incoming.id.slice(7, 11)}`),
      members,
      packed,
    };
  }

  /** The expression `printed` expands for `value`, if any (not for a stack
   * address or an inlined load, which print their own way). */
  private printedExpression(value: Value): Expression | undefined {
    value = this.substituted?.get(value.id) ?? value;
    if (
      this.program.source?.stack_addresses.has(value.id) ||
      this.inlined.get(value.id)?.node.kind === 'load'
    )
      return undefined;
    return (
      this.synthetic.get(value.id) ??
      (this.inline.has(value.id) ? this.program.expressions.get(value.id) : undefined)
    );
  }

  /** `expression` as printed through inline constant displacements: its base
   * and their total modulo 2^bits; null unless it displaces by a constant. */
  private displacement(expression: Expression | undefined, bits: number): Displacement | null {
    let base: Value | undefined,
      offset = 0n,
      terms = 0;
    for (; terms < 16 && expression?.kind === 'integer'; terms++) {
      const left = this.constantOf(expression.left),
        right = this.constantOf(expression.right);
      if (expression.op === 'add' && (left === undefined) !== (right === undefined)) {
        base = left === undefined ? expression.left : expression.right;
        offset += left ?? right!;
      } else if (expression.op === 'sub' && left === undefined && right !== undefined) {
        base = expression.left;
        offset -= right;
      } else break;
      base = this.substituted?.get(base.id) ?? base;
      expression = this.printedExpression(base);
    }
    return base ? { base, offset: BigInt.asUintN(bits, offset), terms } : null;
  }

  /** Source view: an address through two or more inline constant displacements
   * of one base, `(b + k1) + k2`, prints as one sum `b + k` of the same modular
   * address bits. */
  private reassociated(value: Value, displaced: Displacement | null): Printed | undefined {
    if (
      !displaced ||
      displaced.terms < 2 ||
      !this.localValidation.presentation(
        'displacement_reassociation',
        this.input.function.id,
        'an address through several constant displacements of one base is printed as that base plus their total modulo the address width: the same modular address bits',
      )
    )
      return undefined;
    if (displaced.offset === 0n) return this.printed(displaced.base);
    const total: Value = { id: `${value.id}#displacement`, type: value.type };
    this.synthetic.set(total.id, { kind: 'constant', bits: displaced.offset });
    return this.expression(
      { kind: 'integer', op: 'add', left: displaced.base, right: total },
      value.type,
    );
  }

  /** C source view: a declared byte-pointer variable displaced by a constant is
   * C byte pointer arithmetic `p + k` (`p - k`) of the same address bits, with
   * no integer round trip. */
  private bytePointerSum(
    displaced: Displacement | null,
  ): { readonly printed: Printed; readonly spelling: string } | null {
    if (!displaced || !this.sourceView || this.language !== 'c-like') return null;
    const { base, offset } = displaced;
    if (
      base.type.kind !== 'integer' ||
      this.inline.has(base.id) ||
      this.program.source?.stack_addresses.has(base.id)
    )
      return null;
    const spelling = this.declaredSpelling(base);
    if (
      !/^(?:const )?(?:u?int8_t|char)\s*\*$/.test(spelling) ||
      !this.localValidation.presentation(
        'byte_pointer_sum',
        this.input.function.id,
        'a declared byte-pointer variable displaced by a constant is printed as C byte pointer arithmetic: one-byte elements scale by one, so the sum has the same modular address bits (the premise typed_index subscripts rest on)',
      )
    )
      return null;
    const width = 1n << BigInt(base.type.bits);
    const negative = offset > width >> 1n;
    let printed = this.printer.primary(this.local(base));
    if (offset !== 0n)
      printed = this.printer.binary(
        negative ? '-' : '+',
        printed,
        this.printer.literal(negative ? width - offset : offset, base.type.bits),
        null,
      );
    return { printed, spelling };
  }

  /** C source view: `q = p + k` for a declared byte pointer `p`, through one
   * pointer conversion when `q`'s spelling does not accept `p`'s. */
  private bytePointerAssignment(
    spelling: string,
    assigned: Expression | undefined,
    bits: number,
  ): Printed | null {
    const sum = this.bytePointerSum(this.displacement(assigned, bits));
    if (!sum) return null;
    return pointerAssignable(sum.spelling, spelling)
      ? sum.printed
      : {
          text: `(${spelling})${this.printer.group(sum.printed, UNARY)}`,
          precedence: UNARY,
          ctype: null,
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
    const frame = this.frameStorage(node);
    if (frame !== undefined) return frame;
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
    if (this.language === 'c-like' && (plain || (type.kind === 'float' && scalar))) {
      const member = this.memberAccess(
        node.address,
        bitWidth(type),
        node.id,
        type.kind === 'float',
      );
      if (member && this.permitUnaligned(node)) return member;
    }
    const displaced = this.displacement(
      this.printedExpression(node.address),
      bitWidth(node.address.type),
    );
    let address =
      this.stringBaseSum(node.address) ??
      this.reassociated(node.address, displaced) ??
      this.sourceAddressPrinted(node.address);
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
    const sum = pointer === undefined ? this.bytePointerSum(displaced) : null;
    if (sum) address = sum.printed;
    else if (spelling.endsWith('*')) address = this.printer.primary(this.local(node.address));
    else if (pointer === undefined && (address.ctype?.bits !== 64 || address.ctype.signed))
      address = {
        text: `(uintptr_t)${this.printer.group(address, UNARY)}`,
        precedence: UNARY,
        ctype: { bits: 64, signed: false },
      };
    let name = this.plainAccessSpelling(node);
    if (
      type.kind === 'integer' &&
      !this.program.source?.float_accesses?.has(node.id) &&
      !(access.alignment === 1 && this.permitUnaligned(node))
    ) {
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
    const objcCandidate = this.objcSend(node);
    const args = this.callArguments(
      projection,
      node.id,
      objcCandidate !== undefined,
      literalsAllowed,
    );
    if (!args) return this.sourceCall(node, depth, false, operand);
    if (this.sourceView && !this.callEffectsAdmitted(node))
      this.writer.statement(depth, this.clobbers(node.clobbers));
    const guessed = this.likelyArgumentList(projection);
    const open = this.openList(projection);
    // Source view: the marker is printed after the callee's declaration is known.
    const remainder = open
      ? this.openRemainder(
          projection.arguments.length ? 'unknown_argument_remainder' : 'unknown_arguments',
          'Unresolved remainder of a call interface; not zero arguments or a purity claim.',
        )
      : undefined;
    if (remainder !== undefined) args.push(remainder);
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
    // A function-pointer cast names exactly the printed argument positions; its open arity is
    // stated in the header note, as for a direct call.
    const pointerCast =
      !send &&
      this.sourceView &&
      node.target.kind === 'indirect' &&
      this.localValidation.presentation(
        'function_pointer_call',
        node.id,
        'indirect call target presented through a function-pointer type spelled from the projected argument and result types; the cast names exactly the printed argument positions and keeps a trailing ellipsis only for a declared variadic prototype; an open arity is stated in the file header note',
        [node.target.value.id],
      );
    if (pointerCast) target = this.functionPointer(projection, target, open);
    if (open && this.sourceView) {
      const stated = pointerCast
        ? !projection.signature && projection.arguments.length > 0
        : !send &&
          node.target.kind === 'direct' &&
          this.statesOpenArity(projection, this.addressKey(node.target.address));
      if (!stated) args.push(this.inlineEllipsis());
      else if (pointerCast) this.openIndirectCall(node);
      else this.openCallees.add(target);
    }
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

  /** The printed arguments of a source call or tail transfer, one routine for both:
   * string and Objective-C literals, character constants, declared pointer locals,
   * signed parameter contexts and pointer conversions follow the callee's parameter.
   * `objc` marks a call printed as a message (no C conversions). Undefined when a literal
   * record is refused (the caller retries without literals). */
  private callArguments(
    projection: BoundaryProjection,
    subject: string,
    objcCandidate: boolean,
    literalsAllowed: boolean,
  ): string[] | undefined {
    const literals: string[] = [],
      objcLiterals: string[] = [];
    const args = projection.arguments.map((value, index) =>
      this.callArgument(
        projection,
        objcCandidate,
        index,
        value,
        literalsAllowed,
        literals,
        objcLiterals,
      ),
    );
    if (
      (literals.length &&
        !this.localValidation.presentation(
          'string_literal',
          subject,
          STRING_LITERAL_SCOPE,
          literals,
        )) ||
      (objcLiterals.length &&
        !this.localValidation.presentation(
          'objc_string_literal',
          subject,
          'pointer-width constant call arguments addressing an exact __cfstring constant object (isa bound to ___CFConstantStringClassReference, explicit length), printed as that NSString literal',
          objcLiterals,
        ))
    )
      return undefined;
    return args;
  }

  private callArgument(
    projection: BoundaryProjection,
    objcCandidate: boolean,
    index: number,
    value: Value,
    literalsAllowed: boolean,
    literals: string[],
    objcLiterals: string[],
  ): string {
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
    if (character && this.printer.simplify('character_literal', [value.id])) return character.text;
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
      (pointer ? this.callParameterType(projection, index) === declared : objcCandidate)
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
      if (this.memberPointers.has(loaded.id) || this.typedPointerGlobal(loaded.id)) return storage;
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
  }

  /** The printed arguments of a tail transfer: the routine of an ordinary call. */
  private tailArguments(subject: string, boundary: BoundaryProjection, ids: string[]): string[] {
    for (const value of boundary.arguments) ids.push(value.id);
    return (
      this.callArguments(boundary, subject, false, true) ??
      this.callArguments(boundary, subject, false, false)!
    );
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

  /** C: `((R (*)(T0, T1))target)` (`...` ends the list only for a declared variadic
   * signature); Python-like: `function_pointer(target, "R (*)(...)")`.
   * The result type is `result` when given, else the single projected result,
   * void only for a projected source/inferred interface without results, and
   * unknown_result otherwise. */
  private functionPointer(
    projection: BoundaryProjection,
    target: string,
    open: boolean,
    result: string = projection.results.length === 1
      ? projection.signature
        ? this.sourceType(projection.signature.signature.return_type)
        : this.valueType(projection.results[0]!)
      : projection.results.length === 0 && projection.kind !== 'physical'
        ? 'void'
        : 'unknown_result',
  ): string {
    const declared = projection.signature?.signature;
    const parameters = declared
      ? declared.parameters.map((_, index) => this.callParameterType(projection, index))
      : projection.arguments.map((value) => {
          this.context.checkpoint(1);
          return this.valueType(value);
        });
    // `...` declares a variadic prototype: only a declared variadic signature has one. An open
    // interface names its proven positions; with none, a lone `uintptr_t` stands for them.
    if (declared ? declared.variadic : open && !parameters.length)
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

  /** Source view: `storage = value` for a store (promoted local, frame member
   * or dereference), converting to the lvalue's own type. */
  private storeText(node: Extract<Instruction, { kind: 'store' }>, storage: string): string {
    const punned = this.punnedLocal(node);
    if (punned)
      return `${storage} = ${this.reinterpret(this.value(node.value), node.value.type, punned.type, node.id, true)!.text}`;
    if (this.vaPointerStores.has(node.id))
      return `${storage} = ${this.pointerValue(this.printed(node.value), 'void *')}`;
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
    return `${storage} = ${
      pointer ??
      (member && this.memberPointerValue(node.value, member)) ??
      (floating
        ? this.floatingValue(node.value, floating).text
        : literal
          ? literal.text
          : typed
            ? this.pointerValue(this.printed(node.value), this.formalSpelling(typed))
            : this.converted(this.printed(node.value), bitWidth(node.value.type)))
    }`;
  }

  /** Shared assignment spelling for retained pure definitions and source loads.
   * Source view: the target is always a declared variable; a pure definition
   * of any other value prints nothing, and a load of one prints as a bare
   * read. The checked view keeps its own spelling. */
  private assignmentText(
    node: Extract<Instruction, { kind: 'assign' | 'load' }>,
    storage?: string,
  ): string {
    const assigned = this.sourceView
      ? this.declaredVariable(node.result)
      : node.kind === 'assign' || this.program.live.has(node.result.id);
    if (node.kind === 'assign') {
      const expression = this.program.expressions.get(node.result.id) ?? node.expression;
      if (this.noMove(node) || !assigned) return '';
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
    const punned = this.punnedLocal(node);
    if (punned)
      return assigned
        ? `${this.local(node.result)} = ${this.reinterpret(storage, punned.type, node.result.type, node.id, true)!.text}`
        : storage;
    const member = this.memberPointers.get(node.id);
    if (member && assigned) {
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
    if (typed && assigned) {
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
    if (global && assigned) {
      const spelling = this.declaredSpelling(node.result);
      return `${this.local(node.result)} = ${
        spelling === global.c
          ? storage
          : spelling.endsWith('*')
            ? `(${spelling})${storage}`
            : `(uintptr_t)${storage}`
      }`;
    }
    return assigned
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
        [view.shape.evidence_ids, view.field.evidence_ids],
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
          text =
            node.kind === 'store'
              ? this.storeText(node, storage)
              : this.assignmentText(node, storage);
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
        const outputs = (projection?.outputs ?? registerOutputs(this.program.source, node)).filter(
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
      this.mapped(
        node,
        start,
        proof ? [...proof.ids] : [],
        proof ? [node.contract_evidence, proof.evidence] : [node.contract_evidence],
      );
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

  /** The silent blocks control crosses entering `from` before reaching `target`
   * (none when `from` is the target), or null when it arrives elsewhere. */
  private crossing(from: string | null, target: string): readonly string[] | null {
    const through: string[] = [];
    for (let at = from; at !== null;) {
      if (at === target) return through;
      const next = this.silentNext.get(at);
      if (next === undefined || through.length >= this.silentNext.size) return null;
      through.push(at);
      at = next;
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
      this.loopHeaders.add(region.header);
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
          (from, target) => this.crossing(from, target) !== null,
        );
      if (
        !performed &&
        !this.loopExits.has(item) &&
        (action === 'fallthrough' || action === 'break')
      ) {
        const through = this.crossing(
          action === 'break' ? (nested.at(-1)?.follow ?? null) : destination,
          item.target,
        );
        if (through?.length) this.crossed.set(item, through);
      }
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
    if (control.kind === 'jump') {
      decide(control.transfer, nesting, follow);
      if (
        this.actions.get(control.transfer) === 'fallthrough' &&
        !this.consumed.has(control.transfer) &&
        !this.loopHeaders.has(region.id) &&
        !this.cloneIds.has(region.id) &&
        this.quietJump(region)
      )
        this.silentNext.set(region.id, control.transfer.target);
    }
    if (control.kind === 'if') {
      arm(control.when_true, nesting);
      arm(control.when_false, nesting);
    }
    if (control.kind === 'switch') {
      const nested: readonly Nest[] =
        this.language === 'c-like'
          ? [...nesting, { kind: 'switch', id: control.id, follow }]
          : nesting;
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
      // A dropped zero-extension self-copy reads the live narrow member `u` of a
      // widened class: its storage holds exactly zero_extend(u), written by u's own
      // definition with no other member defined while u is live (interference).
      const widened = new Map<string, Value>();
      for (const copy of this.program.transfers.get(transfer)!) {
        const representative = this.variables.get(copy.destination.id);
        const narrow = this.uncast(copy.source, ['bitcast', 'zero_extend']);
        if (
          representative &&
          narrow.id !== copy.source.id &&
          !this.inline.has(narrow.id) &&
          this.variables.get(narrow.id) === representative &&
          bitWidth(narrow.type) < bitWidth(representative.type)
        )
          widened.set(representative.id, narrow);
      }
      const assumed = new Set([...widened.values()].map((value) => value.id));
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
          // An edge into a rotated header writes the phi's pseudo value; the
          // header's first statement copies it into the phi (loop_copy_rotation).
          const rotated = this.rotatedPhis.get(transfer.target);
          return validateParallelMoves(
            transfer.effect.destination.id,
            transfer.copies.flatMap((copy) => {
              this.localValidation.allowance.charge();
              const destination = rotated?.get(copy.destination.id) ?? copy.destination;
              return this.program.live.has(copy.destination.id) &&
                !this.inline.has(copy.destination.id) &&
                !this.forwardedCopies.get(transfer)?.has(copy.destination.id)
                ? [{ ...copy, destination: this.variables.get(destination.id) ?? destination }]
                : [];
            }),
            moves,
            (id) => {
              const narrow = widened.get(id);
              if (narrow) return { kind: 'cast', op: 'zero_extend', value: narrow };
              if (assumed.has(id)) return undefined;
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
    const through = this.crossed.get(transfer);
    this.emittedEdges.set(
      transfer,
      action === 'goto'
        ? { kind: 'goto', target: transfer.target }
        : through && (action === 'fallthrough' || action === 'break')
          ? { kind: action, through }
          : { kind: action },
    );
    // A joined exit leaves by the jump statement its merged test printed.
    if (this.joinedExits.delete(transfer)) return;
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
   * hoisted copies when they hold. `held`: the one statement a top test holds
   * (it prints inside the test, so its operands count as test reads). */
  private acceptFor(loop: Parameters<LoopFacts['induction']>[0], held?: Instruction): boolean {
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
    if (!steps.length) return this.acceptStatementFor(loop, held);
    if (!independent(steps) || !independent(inits)) return false;
    const induction = new Set<string>();
    for (const copy of steps) {
      const variable = key(copy.destination);
      if (!this.inductionStep(copy.source, variable)) return false;
      induction.add(variable);
    }
    const initialized = inits.filter((copy) => induction.has(key(copy.destination)));
    // An induction variable the entry edge writes without a printed copy (its
    // entry value already shares the variable) needs no init clause.
    const entering = new Set(
      (this.program.transfers.get(loop.init) ?? []).map((copy) => key(copy.destination)),
    );
    if ([...induction].some((variable) => !entering.has(variable))) return false;
    const restated = this.rebased.get(loop.test.id);
    const reads = loop.bottom
      ? restated
        ? [key(restated.left)]
        : []
      : this.testLeaves(loop.test, held).map((index) => key(liveness.values[index]!));
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
    if (loop.bottom && !this.entryHolds(loop, this.program.transfers.get(loop.init) ?? []))
      return false;
    this.hoisted.set(loop.init, new Set(initialized.map((copy) => key(copy.destination))));
    this.hoisted.set(loop.step, induction);
    this.forLoops.set(loop.test.id, { init: loop.init, step: loop.step });
    return true;
  }

  /** Variable leaves a loop's top test reads: its condition and, when it holds
   * one (see loopCommaTests), the operands of the statement printed inside it. */
  private testLeaves(test: Extract<Control, { kind: 'if' }>, held?: Instruction): number[] {
    const liveness = this.liveness!;
    const leaves = [...liveness.leaves(test.condition)];
    if (held) for (const value of liveness.operands(held)) leaves.push(...liveness.leaves(value));
    return leaves;
  }

  /** A top-tested `for` whose step is the loop body's last statement and assigns
   * a variable the test reads; its init, when the loop's entry block ends with
   * one, is the statement assigning that variable just before the loop. The
   * step still runs last in every iteration: the sole repeat edge prints
   * nothing and follows it, and nothing else in the loop writes the variable. */
  private acceptStatementFor(
    loop: Parameters<LoopFacts['induction']>[0],
    held?: Instruction,
  ): boolean {
    const liveness = this.liveness;
    if (!liveness || loop.bottom) return false;
    const step = this.trailingStatement(loop.step);
    if (!step) return false;
    if (step.kind === 'store') return this.acceptSlotFor(loop, step, held);
    const variable = this.variableKey(step.result);
    const writes = (ids: readonly number[]): boolean =>
      ids.some((index) => this.variableKey(liveness.values[index]!) === variable);
    if (!writes(this.testLeaves(loop.test, held))) return false;
    let definitions = 0;
    for (const id of loop.inside) {
      const block = this.program.blocks.get(id);
      if (!block) return false;
      for (const event of liveness.events(block)) if (event.def && writes(event.ids)) definitions++;
      for (const arm of [
        ...(block.control.kind === 'jump' ? [{ transfer: block.control.transfer }] : []),
        ...controlArms(block.control),
      ])
        if (
          this.printedCopies(arm.transfer).some(
            (copy) => this.variableKey(copy.destination) === variable,
          )
        )
          return false;
    }
    if (definitions !== 1) return false;
    const entry = this.trailingStatement(loop.init);
    const init =
      entry && entry.kind !== 'store' && this.variableKey(entry.result) === variable
        ? entry
        : undefined;
    // Otherwise the entry edge's copy into the variable, when it reads no other
    // destination of that edge (it then runs after them, in the header).
    const copies = this.printedCopies(loop.init);
    const initial = copies.filter((copy) => this.variableKey(copy.destination) === variable);
    const others = new Set(
      copies
        .filter((copy) => !initial.includes(copy))
        .map((copy) => this.variableKey(copy.destination)),
    );
    const hoist =
      !init &&
      initial.length === 1 &&
      liveness
        .leaves(initial[0]!.source)
        .every((index) => !others.has(this.variableKey(liveness.values[index]!)));
    if (hoist) this.hoisted.set(loop.init, new Set([variable]));
    this.forStatements.set(loop.test.id, {
      ...(init ? { init } : hoist ? { copies: loop.init } : {}),
      step,
    });
    this.headerStatements.add(step.id);
    if (init) this.headerStatements.add(init.id);
    return true;
  }

  /** `acceptStatementFor` for a store step into a promoted private stack slot
   * (an `-O0` induction variable kept in memory): the slot is the variable. It
   * qualifies when the test reads it, no other store to it exists in the loop
   * (private slots are written only by their own stores: no frame address
   * reaches them), and the entry block's last statement is its init store. */
  private acceptSlotFor(
    loop: Parameters<LoopFacts['induction']>[0],
    step: Extract<HeaderStatement, { kind: 'store' }>,
    held?: Instruction,
  ): boolean {
    const locals = this.program.source?.locals,
      local = locals?.get(step.id);
    if (!locals || !local) return false;
    // The test reads the slot through a load printed inside it, or through the
    // load its header holds.
    const reads = [loop.test.condition, ...(held ? this.liveness!.operands(held) : [])];
    const heldLoad = held?.kind === 'load' ? locals.get(held.id) : undefined;
    if (heldLoad?.id !== local.id && !this.slotReads(reads).has(local.id)) return false;
    for (const id of loop.inside) {
      const block = this.program.blocks.get(id);
      if (!block) return false;
      for (const node of block.statements)
        if (node !== step && node.kind === 'store' && locals.get(node.id)?.id === local.id)
          return false;
    }
    const init = this.trailingStatement(loop.init);
    if (init?.kind !== 'store' || locals.get(init.id)?.id !== local.id) return false;
    this.forStatements.set(loop.test.id, { init, step });
    this.headerStatements.add(step.id);
    this.headerStatements.add(init.id);
    return true;
  }

  /** The promoted slots (by local id) whose inlined loads printing `values`
   * reads (the leaves walk of VariableLiveness, which stops at variables). */
  private slotReads(values: readonly Value[]): Set<string> {
    const locals = this.program.source!.locals,
      liveness = this.liveness!,
      found = new Set<string>(),
      seen = new Set<string>(),
      pending = [...values];
    while (pending.length) {
      const current = pending.pop()!;
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      const load = this.inlined.get(current.id)?.node;
      if (load?.kind === 'load') {
        const local = locals.get(load.id);
        if (local) found.add(local.id);
        continue;
      }
      if (liveness.index.has(current.id) && !this.program.inline.has(current.id)) continue;
      const expression = this.program.expressions.get(current.id);
      if (expression) pending.push(...expressionOperands(expression));
    }
    return found;
  }

  /** The last statement of the block that ends by taking `transfer`, when that
   * edge prints nothing and the statement prints exactly one plain assignment. */
  private trailingStatement(transfer: ParallelTransfer): HeaderStatement | undefined {
    if (this.printedCopies(transfer).length) return undefined;
    for (const block of this.program.blocks.values()) {
      if (block.control.kind !== 'jump' || block.control.transfer !== transfer) continue;
      const node = block.statements.at(-1);
      if (
        !node ||
        (node.kind !== 'assign' && node.kind !== 'load' && node.kind !== 'store') ||
        !this.program.retained.has(node.id) ||
        (node.kind !== 'store' &&
          (!this.program.live.has(node.result.id) || this.inlined.has(node.result.id))) ||
        this.deferredStores.has(node.id) ||
        this.flagAccesses.has(node.id) ||
        this.deferred.get(node.id)?.length ||
        this.notes.get(node.id)?.length ||
        // A store qualifies only into a promoted private slot printed as its
        // own local; the other loads and stores keep their own statements.
        (node.kind === 'store' &&
          (!this.sourceView ||
            !this.program.source?.locals.has(node.id) ||
            this.punnedLocal(node) ||
            this.vaPointerStores.has(node.id))) ||
        (node.kind === 'load' &&
          (!this.program.source ||
            this.globals.import_loads.has(node.id) ||
            this.punnedLocal(node))) ||
        (node.kind === 'assign'
          ? expressionOperands(node.expression)
          : node.kind === 'store'
            ? [node.value]
            : [node.address]
        ).some((value) => this.inlinedCalls.has(value.id)) ||
        [node.id, block.control.id].some((anchor) =>
          (this.program.source?.definitions?.get(anchor) ?? []).some(
            (definition) => !this.inlined.has(definition.result.id),
          ),
        )
      )
        return undefined;
      return node;
    }
    return undefined;
  }

  /** A header statement's text and mappings at `start` (the header line). */
  private headerStatement(node: HeaderStatement): string {
    return node.kind === 'assign'
      ? this.assignmentText(node)
      : node.kind === 'store'
        ? this.storeText(node, this.storage(node))
        : this.assignmentText(node, this.storage(node));
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
        const carrier = this.returnedCarrier(tail, result),
          move = carrier && this.constantMove(transfer, carrier);
        if (
          !carrier ||
          !move ||
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

  /** The parameter of return tail `tail` that `result` returns: the carrier
   * itself or an inline conversion of it, each value in the chain read once. */
  private returnedCarrier(tail: BlockRegion, result: Value): Value | undefined {
    const chain: Value[] = [result];
    while (chain.length <= 8) {
      const value = chain[chain.length - 1]!;
      if (tail.parameters.some((parameter) => parameter.id === value.id))
        return chain.every((item) => this.program.use_counts.get(item.id) === 1)
          ? value
          : undefined;
      const expression = this.inline.has(value.id)
        ? this.program.expressions.get(value.id)
        : undefined;
      if (
        expression?.kind !== 'cast' ||
        !['zero_extend', 'sign_extend', 'truncate', 'bitcast'].includes(expression.op)
      )
        return undefined;
      chain.push(expression.value);
    }
    return undefined;
  }

  /** The copy of `transfer` writing an inline constant of the carrier's width
   * and kind into `carrier`. */
  private constantMove(
    transfer: ParallelTransfer,
    carrier: Value,
  ): { readonly destination: Value; readonly source: Value } | undefined {
    const move = (this.program.transfers.get(transfer) ?? []).find(
      (candidate) => candidate.destination.id === carrier.id,
    );
    return move &&
      this.program.expressions.get(move.source.id)?.kind === 'constant' &&
      this.inline.has(move.source.id) &&
      bitWidth(move.source.type) === bitWidth(carrier.type) &&
      move.source.type.kind === carrier.type.kind
      ? move
      : undefined;
  }

  /** Every copy `transfer` prints writes a constant its target, a return
   * tail, returns (see planReturnConstants): an owned copy of the tail on
   * this edge prints no copy, only `return k`. */
  private returnsConstants(transfer: ParallelTransfer): boolean {
    const tail = this.program.blocks.get(transfer.target),
      control = tail?.control;
    if (!tail || control?.kind !== 'return') return false;
    const projection = this.program.returns.get(control.id);
    if (!projection || projection.kind === 'physical' || projection.outputs.length) return false;
    const printed = this.printedCopies(transfer);
    if (!printed.length) return false;
    const carriers = new Set<string>();
    for (const result of projection.results) {
      const carrier = this.returnedCarrier(tail, result);
      if (carrier && this.constantMove(transfer, carrier)) carriers.add(carrier.id);
    }
    return printed.every((copy) => carriers.has(copy.destination.id));
  }

  /** Edge copies actually printed: the variable partition's `edgeCopies`, less
   * copies forwarded into returned constants and copies into FP-environment
   * epochs that only omitted guards read (`fp_unobserved_epoch`). */
  private printedCopies(
    transfer: ParallelTransfer,
  ): readonly { readonly destination: Value; readonly source: Value }[] {
    const forwarded = this.forwardedCopies.get(transfer),
      unobserved = this.fpPresentation.unobserved;
    return edgeCopies(
      this.program,
      this.variables,
      this.inline,
      (this.program.transfers.get(transfer) ?? []).filter(
        (copy) => !forwarded?.has(copy.destination.id) && !unobserved.has(copy.destination.id),
      ),
    );
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
        // The header's one statement prints inside the first test (operandTerm).
        const held = this.loopCommaTests.get(form.test);
        const operands = form.chain.map((item) => {
          const flag = this.flagTests.get(item.test);
          if (flag) {
            const merged = this.flagCondition(flag);
            return `(${(item.enter ? merged.positive : merged.negative).text})`;
          }
          const test = this.controls.get(item.test);
          if (test?.kind !== 'if') this.invalid('A loop condition lost its branch');
          if (held && item.test === form.test)
            return this.printer.group(this.operandTerm(test, item.enter, held).printed, PRIMARY);
          return `(${this.testPrinted(test, item.enter).text})`;
        });
        this.writer.line(
          depth - 1,
          c ? `while (${operands.join(' && ')}) {` : `while ${operands.join(' and ')}:`,
        );
        this.mapHeaded(start);
        for (const item of form.chain) {
          const block = this.program.blocks.get(item.block)!;
          for (const node of block.statements)
            if (this.program.retained.has(node.id) && node !== held) this.map(node, start);
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
        header = this.forLoops.get(control.id),
        statements = form.kind === 'for' ? this.forStatements.get(control.id) : undefined;
      // The header's one statement prints inside the test (see operandTerm).
      const held = this.loopCommaTests.get(control.id);
      const head = (): string =>
        held ? this.operandTerm(control, form.enter, held).printed.text : test(form.enter);
      const start = this.writer.offset;
      this.writer.line(
        depth - 1,
        statements
          ? `for (${statements.init ? this.headerStatement(statements.init) : statements.copies ? this.hoistedText(statements.copies) : ''}; ${head()}; ${this.headerStatement(statements.step)}) {`
          : form.kind === 'for' && header
            ? `for (${this.hoistedText(header.init)}; ${head()}; ${this.hoistedText(header.step)}) {`
            : c
              ? `while (${head()}) {`
              : `while ${head()}:`,
      );
      this.mapHeaded(start);
      for (const node of statements ? [statements.init, statements.step] : [])
        if (node) {
          this.map(node, start);
          this.mapMemory(node, start);
        }
      this.loopExit(exit.transfer, depth, control);
      // The loop prints `pass` itself when its whole body prints nothing.
      this.transfer(enter.transfer, depth, control);
      if (enter.body) this.region(enter.body, depth);
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
    // A later operand's statement prints inside its test (see operandTerm).
    const held = this.commaHeld?.control === control.id ? this.commaHeld.node : undefined;
    this.commaHeld = undefined;
    const comma = new Map<boolean, ConditionTerm>();
    const term = (positive: boolean): ConditionTerm => {
      if (!held) return plainTerm(positive);
      if (!comma.has(positive)) comma.set(positive, this.operandTerm(control, positive, held));
      return comma.get(positive)!;
    };
    const plainTerm = (positive: boolean): ConditionTerm => ({
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
      this.ifHead(depth, pending ? this.conjunction([...pending, term(positive)]) : test(positive));
    };
    const close = (): void => {
      if (c) this.writer.line(depth, '}');
    };
    const yes = control.when_true,
      no = control.when_false;
    // `if (a) jump; if (b) jump;` leaving by one jump statement for one target
    // (no edge copies; each later operand prints nothing but its test and at
    // most the one statement the test holds) is one test: `if (a || b) jump;`.
    const joining = this.joinedPlan;
    this.joinedPlan = undefined;
    if (joining) {
      const exit = [yes, no].find((arm) => this.joinedExit(arm, joining.target, joining.action));
      if (!exit || pending) this.invalid('A joined-exit operand lost its exit');
      const stay = exit === yes ? no : yes,
        terms = [...joining.terms, term(exit === yes)],
        exits = [...joining.exits, [exit, control] as const];
      if (this.joinedOperand(stay, joining.target, joining.action)) {
        this.joinedPlan = { ...joining, terms, exits };
        this.silentArm(stay, depth, control);
        if (this.joinedPlan) this.invalid('A joined-exit condition was not printed');
        return;
      }
      this.ifHead(
        depth,
        terms
          .slice(1)
          .reduce((all, item) => this.printer.logical('or', all, item.printed), terms[0]!.printed)
          .text,
      );
      exits.forEach(([arm, origin], index) => {
        if (index) this.joinedExits.add(arm.transfer);
        this.transfer(arm.transfer, depth + 1, origin);
      });
      close();
      this.silentArm(stay, depth, control);
      return;
    }
    if (
      !pending &&
      !held &&
      !complement &&
      !yes.shared &&
      !no.shared &&
      !yes.joins &&
      !no.joins &&
      !this.requirementPredicates.has(control.id)
    )
      for (const exit of [yes, no]) {
        if (!this.joinedExit(exit)) continue;
        const target = exit.transfer.target,
          action = this.actions.get(exit.transfer)!,
          operands: string[] = [];
        for (
          let next = this.joinedOperand(exit === yes ? no : yes, target, action);
          next;
          next = this.joinedOperand(next.stay, target, action)
        )
          operands.push(next.block.control.id);
        if (!operands.length) continue;
        if (
          !this.localValidation.presentation(
            'joined_exit_condition',
            control.id,
            "a test leaving by a goto, break or continue with no edge copy, whose other arm starts with later tests (no label, note, definition or statement before them but the one statement each test holds, printed inside it as a comma condition) leaving the same way for the same target with no edge copy, prints as one if over the || of those exits' tests followed by that one jump statement; each test still runs only when the earlier ones stay, in the same order, and the code after the last one follows unchanged",
            operands,
          )
        )
          break;
        this.joinedPlan = { target, action, terms: [term(exit === yes)], exits: [[exit, control]] };
        this.silentArm(exit === yes ? no : yes, depth, control);
        if (this.joinedPlan) this.invalid('A joined-exit condition was not printed');
        return;
      }
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
      const branches: [ControlArm, Control][] = [
        [stay, control],
        [plan.arm, plan.origin],
      ];
      if (plan.form === 'any') branches.reverse();
      // An empty first branch: the complement opens the if, the other branch
      // is its only arm, and the empty one falls through after it.
      const empty = this.emptyArm(branches[0]![0]) && !this.emptyArm(branches[1]![0]);
      this.ifHead(depth, empty ? (c ? `!(${text})` : `not (${text})`) : text);
      if (!own) this.transfer(exit.transfer, depth + 1, control);
      if (empty) {
        this.arm(branches[1]![0], depth + 1, branches[1]![1]);
        close();
        this.silentArm(branches[0]![0], depth, branches[0]![1]);
        return;
      }
      this.arm(branches[0]![0], depth + 1, branches[0]![1]);
      this.elseArm(branches[1]![0], depth, branches[1]![1]);
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
        this.silentArm(positive ? no : yes, depth, control);
        this.arm(body, depth, control);
        if (this.conjunct) this.invalid('A merged condition was not printed');
        return;
      }
    }
    if (shaped && this.emptyArm(no)) {
      open(true);
      this.silentArm(no, depth + 1, control);
      if (this.emptyArm(yes)) {
        this.silentArm(yes, depth + 1, control);
        if (!c) this.writer.statement(depth + 1, 'pass');
      } else this.arm(yes, depth + 1, control);
      close();
    } else if (shaped && this.emptyArm(yes)) {
      open(false);
      this.silentArm(yes, depth + 1, control);
      this.arm(no, depth + 1, control);
      close();
    } else if (pending) this.invalid('A merged condition reached an if with an else');
    else {
      // The arm a goto leaves prints before the arm holding its label.
      const lead = this.leadingArm(yes, no),
        first = this.terminates(yes) ? yes : no;
      if (shaped && (lead === null || lead === first)) {
        open(first === yes);
        this.arm(first, depth + 1, control);
        close();
        this.arm(first === yes ? no : yes, depth, control);
      } else {
        const head =
          lead === no &&
          this.localValidation.presentation(
            'branch_order',
            this.input.function.id,
            'an if whose false arm holds the label of a goto leaving its true arm prints the false arm first under the complemented exact test; both arms keep their code, edges and copies',
          )
            ? no
            : yes;
        open(head === yes);
        this.arm(head, depth + 1, control);
        this.elseArm(head === yes ? no : yes, depth, control);
      }
    }
  }

  /** The arm of an `if` that prints first because a goto leaves it for a
   * label in the other arm (the structurer lays labels out after their
   * gotos); null when neither or both arms jump into the other. */
  private leadingArm(yes: ControlArm, no: ControlArm): ControlArm | null {
    if (!this.labels.size) return null;
    const intoNo = this.jumpsInto(yes, no),
      intoYes = this.jumpsInto(no, yes);
    return intoNo === intoYes ? null : intoNo ? yes : no;
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
      this.silentArm(control.otherwise, depth + 2, control);
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

  /** An arm that prints nothing: a silent edge, through blocks that print nothing
   * and fall through silently (e.g. a branch whose only copy coalesced away). */
  private emptyArm(arm: ControlArm): boolean {
    if (!this.silentTransfer(arm.transfer)) return false;
    if (!arm.body) return true;
    const blocks: BlockRegion[] = [];
    const flatten = (region: Region): boolean => {
      if (region.kind === 'sequence') return region.regions.every(flatten);
      if (region.kind !== 'block') return false;
      blocks.push(region);
      return true;
    };
    return (
      flatten(arm.body) &&
      blocks.every(
        (block) =>
          this.quietBlock(block) &&
          block.control.kind === 'jump' &&
          this.silentTransfer(block.control.transfer),
      )
    );
  }

  /** A goto inside `from`'s body lands in `into`'s body: the structurer laid
   * that label out after `from`, so `into` must print after it. */
  private jumpsInto(from: ControlArm, into: ControlArm): boolean {
    if (!from.body || !into.body) return false;
    const targets = new Set<string>();
    const collect = (region: Region): void => {
      this.context.checkpoint(1);
      if (region.kind === 'sequence') region.regions.forEach(collect);
      else if (region.kind === 'loop') collect(region.body);
      else {
        targets.add(region.id);
        for (const arm of controlArms(region.control)) if (arm.body) collect(arm.body);
      }
    };
    collect(into.body);
    const jumps = (region: Region): boolean => {
      this.context.checkpoint(1);
      if (region.kind === 'sequence') return region.regions.some(jumps);
      if (region.kind === 'loop') return jumps(region.body);
      const control = region.control;
      const arms: { transfer: ParallelTransfer; body?: Region | null }[] =
        control.kind === 'jump' ? [{ transfer: control.transfer }] : [...controlArms(control)];
      return arms.some(
        (arm) =>
          (this.actions.get(arm.transfer) === 'goto' && targets.has(arm.transfer.target)) ||
          (!!arm.body && jumps(arm.body)),
      );
    };
    return jumps(from.body);
  }

  /** Print an empty arm: its edge and silent blocks record their mappings and edges. */
  private silentArm(arm: ControlArm, depth: number, origin: Control): void {
    this.transfer(arm.transfer, depth, origin);
    if (arm.body) this.region(arm.body, depth);
  }

  /** A block printing nothing before its control: no label, note, definition or
   * printed statement. */
  private quietBlock(block: BlockRegion): boolean {
    const definitions = this.program.source?.definitions;
    const printed = (anchor: string): boolean =>
      definitions?.get(anchor)?.some((definition) => !this.inlined.has(definition.result.id)) ??
      false;
    return !(
      this.notes.has(block.id) ||
      this.notes.has(block.control.id) ||
      (this.labels.has(block.id) && !this.clones.has(block)) ||
      printed(block.id) ||
      printed(block.control.id) ||
      block.statements.some(
        (node) =>
          printed(node.id) ||
          node.id === this.vaList?.anchor ||
          (this.program.retained.has(node.id) &&
            !this.flagAccesses.has(node.id) &&
            !('result' in node && this.inlined.has(node.result.id)) &&
            !this.noMove(node)),
      )
    );
  }

  /** Source view: whether a later short-circuit operand prints its test alone
   * (null) or one statement its test holds: the block's only printed
   * statement, an assignment, load or single-result call that prints nothing
   * else, defining a value the test reads. The C comma operator is a
   * sequence point, so `(x = f(), x != 0)` runs the statement exactly when and
   * before the test, as the block did. Python-like has no comma operator: its
   * test must read the value once, unconditionally and before any other
   * memory read or call, so `(x := f()) != 0` keeps the order. Undefined:
   * anything else prints (a label is checked where the test prints). */
  private commaOperand(block: BlockRegion, carrier?: BlockRegion): Instruction | null | undefined {
    const control = block.control;
    if (control.kind !== 'if' || this.requirementPredicates.has(control.id)) return undefined;
    const own = this.printedStatement(block);
    if (own === undefined || (carrier && own)) return undefined;
    const found = carrier ? this.printedStatement(carrier) : own;
    if (found === undefined || (carrier && !found)) return undefined;
    if (!found) return null;
    const value = this.commaValue(found);
    if (!value) return undefined;
    const reads = this.commaReads(control.condition, value);
    return reads.count > 0 && (this.language === 'c-like' || reads.direct) ? found : undefined;
  }

  /** The one statement a block prints before its control, null for none;
   * undefined when it prints more (a note, definition, deferred store or a
   * second statement). */
  private printedStatement(block: BlockRegion): Instruction | null | undefined {
    const definitions = this.program.source?.definitions;
    const anchored = (anchor: string): boolean =>
      this.notes.has(anchor) ||
      !!this.deferred.get(anchor)?.length ||
      (definitions?.get(anchor)?.some((definition) => !this.inlined.has(definition.result.id)) ??
        false);
    if (anchored(block.id) || anchored(block.control.id)) return undefined;
    let found: Instruction | null = null;
    for (const node of block.statements) {
      this.context.checkpoint(1);
      if (anchored(node.id)) return undefined;
      if (
        !this.program.retained.has(node.id) ||
        this.flagAccesses.has(node.id) ||
        ('result' in node && this.inlined.has(node.result.id)) ||
        this.noMove(node)
      )
        continue;
      if (found) return undefined;
      found = node;
    }
    return found;
  }

  /** The value a comma statement defines, when it prints `name = expression`. */
  private commaValue(node: Instruction): Value | undefined {
    if (node.kind === 'assign' || node.kind === 'load')
      return this.program.live.has(node.result.id) &&
        !(node.kind === 'load' && this.globals.import_loads.has(node.id))
        ? node.result
        : undefined;
    if (node.kind !== 'call') return undefined;
    const projection = this.program.calls.get(node.id);
    const results = projection?.results.filter((value) => this.program.live.has(value.id)) ?? [];
    if (results.length !== 1 || this.inlinedCalls.has(results[0]!.id)) return undefined;
    const returned = new Set(projection!.results.map((value) => value.id));
    // Live non-result clobbers print their own statements after the call.
    if (
      projection!.outputs.some(
        (binding) =>
          this.program.live.has(binding.value.id) &&
          !this.fpPresentation.unobserved.has(binding.value.id) &&
          !returned.has(binding.value.id) &&
          !this.program.expressions.has(binding.value.id),
      )
    )
      return undefined;
    // A refused call_effects prints a boundary statement before the call: it is
    // admitted here, at planning time, exactly as sourceCall asks for it later.
    return this.callEffectsAdmitted(node) ? results[0] : undefined;
  }

  /** How often the printed test reads `value`, and whether it reads it exactly
   * once, never under a conditional operator, with no other memory read or
   * call in the test (`direct`: the read may be the assignment itself). */
  private commaReads(
    condition: Value,
    value: Value,
  ): { readonly count: number; readonly direct: boolean } {
    let count = 0,
      plain = true;
    const pending: { value: Value; conditional: boolean }[] = [
      { value: condition, conditional: false },
    ];
    for (let steps = 0; pending.length; steps++) {
      this.context.checkpoint(1);
      const { value: current, conditional } = pending.pop()!;
      if (current.id === value.id) {
        count++;
        if (conditional) plain = false;
        continue;
      }
      if (steps > 256) return { count, direct: false };
      const expression =
        this.synthetic.get(current.id) ??
        (this.inline.has(current.id) && this.inlined.get(current.id)?.node.kind !== 'load'
          ? this.program.expressions.get(current.id)
          : undefined);
      if (!expression) {
        // An inline load or call reads memory in the test.
        if (this.inline.has(current.id) || this.inlinedCalls.has(current.id)) plain = false;
        continue;
      }
      const branching =
        expression.kind === 'select' ||
        (expression.kind === 'integer' &&
          (expression.op === 'and' || expression.op === 'or') &&
          bitWidth(current.type) === 1);
      for (const operand of expressionOperands(expression))
        pending.push({ value: operand, conditional: conditional || branching });
    }
    return { count, direct: plain && count === 1 };
  }

  /** The test of a later short-circuit operand leaving (`positive`: on its
   * true arm) with the statement it holds (see commaOperand), printed where
   * the merged `if` prints; the statement maps to that line. */
  private operandTerm(
    control: Extract<Control, { kind: 'if' }>,
    positive: boolean,
    node: Instruction | null,
  ): ConditionTerm {
    if (!node)
      return { printed: this.testPrinted(control, positive), value: control.condition, positive };
    const value = this.commaValue(node)!,
      lines = this.writer.codeLines;
    const text =
      node.kind === 'call'
        ? this.sourceCall(node, 0)
        : this.assignmentText(node as Extract<Instruction, { kind: 'assign' | 'load' }>);
    if (this.writer.codeLines !== lines) this.invalid('A comma statement printed a line');
    const target = `${this.local(value)} = `;
    if (!text.startsWith(target)) this.invalid('A comma statement lost its assignment');
    const c = this.language === 'c-like',
      direct = this.commaReads(control.condition, value).direct;
    const expression = c ? text : `${this.local(value)} := ${text.slice(target.length)}`;
    this.comma = { control: control.id, node, value, text: expression, direct };
    const test = this.testPrinted(control, positive);
    this.comma = undefined;
    if (direct && test.text.split(`(${expression})`).length !== 2)
      this.invalid('A comma operand test lost its single read');
    if (!direct && !c) this.invalid('A Python-like operand statement has no single read');
    this.headed.push(node);
    return {
      printed: direct
        ? test
        : { text: `(${expression}, ${test.text})`, precedence: PRIMARY, ctype: test.ctype },
      value: control.condition,
      positive,
      opaque: true,
    };
  }

  /** Source view: a retained zero extension or same-width alias of a member of
   * its own variable is no move and prints nothing. */
  private noMove(node: Instruction): boolean {
    if (!this.sourceView || node.kind !== 'assign') return false;
    const expression = this.program.expressions.get(node.result.id) ?? node.expression;
    return (
      expression.kind === 'cast' &&
      (expression.op === 'zero_extend' || expression.op === 'bitcast') &&
      this.variableKey(node.result) === this.variableKey(expression.value)
    );
  }

  /** A fallthrough edge whose printed copies all moved into a `for` header. */
  private silentTransfer(transfer: ParallelTransfer): boolean {
    return (
      this.actions.get(transfer) === 'fallthrough' &&
      this.printedCopies(transfer).length === (this.hoisted.get(transfer)?.size ?? 0)
    );
  }

  /** An arm leaving by a jump statement alone: no body, no edge copy, a goto,
   * break or continue (for `target` by `action`, when given). */
  private joinedExit(arm: ControlArm, target?: string, action?: TransferAction): boolean {
    const kind = this.actions.get(arm.transfer);
    return (
      !arm.body &&
      (kind === 'goto' || kind === 'break' || kind === 'continue') &&
      !this.consumed.has(arm.transfer) &&
      this.printedCopies(arm.transfer).length === 0 &&
      (target === undefined || (arm.transfer.target === target && kind === action))
    );
  }

  /** The later operand an arm starts with when a joined-exit test continues
   * into it (see sourceIf): the arm enters it silently, and it is an unlabeled
   * block printing nothing but its test and at most the one statement the test
   * holds (commaOperands; that statement may end the unlabeled jump block the
   * arm starts with, its carrier), whose plain test has an arm leaving for
   * `target` by `action` (see joinedExit); `stay` is its other arm. */
  private joinedOperand(
    arm: ControlArm,
    target: string,
    action: TransferAction,
  ): { readonly block: BlockRegion; readonly stay: ControlArm } | undefined {
    if (!arm.body || !this.silentTransfer(arm.transfer)) return undefined;
    // The first two blocks of the arm.
    const leading: Region[] = [],
      pending: Region[] = [arm.body];
    while (pending.length && leading.length < 2) {
      const region = pending.pop()!;
      if (region.kind === 'sequence') pending.push(...[...region.regions].reverse());
      else leading.push(region);
    }
    const unlabeled = (region: Region | undefined): region is BlockRegion =>
      region?.kind === 'block' && !(this.labels.has(region.id) && !this.clones.has(region));
    let first = leading[0];
    if (!unlabeled(first)) return undefined;
    if (first.control.kind === 'jump') {
      const next = leading[1];
      if (
        !unlabeled(next) ||
        this.commaCarriers.get(first.id) !== next.id ||
        !this.silentTransfer(first.control.transfer)
      )
        return undefined;
      first = next;
    }
    if (!this.commaOperands.has(first.id) || this.flagHeads.has(first.id)) return undefined;
    const control = first.control;
    if (
      control.kind !== 'if' ||
      this.loopTests.has(control.id) ||
      this.requirementPredicates.has(control.id) ||
      this.flagTests.has(control.id) ||
      this.flagStages.has(control.id) ||
      controlArms(control).some((item) => item.shared || item.joins)
    )
      return undefined;
    const yes = control.when_true,
      no = control.when_false;
    if (this.joinedExit(yes, target, action)) return { block: first, stay: no };
    if (this.joinedExit(no, target, action)) return { block: first, stay: yes };
    return undefined;
  }

  /** The control an arm consists of when nothing of the arm prints before it
   * (silent jump blocks and a flag short-circuit's silent heads aside);
   * `comma`: the control's block may print the one statement its test holds
   * (see commaOperand), which then prints inside the merged test. */
  private soleControl(arm: ControlArm, comma = false): Control | null {
    if (!arm.body || !this.silentTransfer(arm.transfer)) return null;
    const blocks: BlockRegion[] = [];
    const flatten = (region: Region): boolean => {
      if (region.kind === 'sequence') return region.regions.every(flatten);
      if (region.kind !== 'block') return false;
      blocks.push(region);
      return true;
    };
    if (!flatten(arm.body) || !blocks.length) return null;
    for (const [index, block] of blocks.entries()) {
      const control = block.control;
      // A flag short-circuit head prints nothing; its merge test follows.
      const flag = this.flagHeads.get(block.id),
        head = flag !== undefined && flag.merge === blocks[index + 1]?.id;
      const last = index === blocks.length - 1;
      if (
        (!this.quietBlock(block) &&
          !(
            comma &&
            !(this.labels.has(block.id) && !this.clones.has(block)) &&
            ((last && this.commaOperands.get(block.id)) ||
              (index === blocks.length - 2 &&
                this.commaCarriers.get(block.id) === blocks.at(-1)!.id &&
                !this.labels.has(blocks.at(-1)!.id)))
          )) ||
        (index < blocks.length - 1 &&
          !head &&
          (control.kind !== 'jump' || !this.silentTransfer(control.transfer)))
      )
        return null;
    }
    return blocks.at(-1)!.control;
  }

  /** The `if` control an arm consists of, when nothing of the arm prints before
   * it (silent jump blocks aside) and it prints with exactly one non-empty arm
   * and no `else`. */
  private nestedIf(arm: ControlArm): string | null {
    const control = this.soleControl(arm, true);
    return control?.kind === 'if' &&
      !this.loopTests.has(control.id) &&
      !this.requirementPredicates.has(control.id) &&
      this.emptyArm(control.when_true) !== this.emptyArm(control.when_false)
      ? control.id
      : null;
  }

  /** Whether `sourceIf` prints this control as exactly one `if` statement: one
   * `if` head, its arms and its own `else` chain, with nothing before or after
   * it at the statement level. Mirrors the layout decisions of `sourceIf`; a
   * layout that prints anything else (shared-arm conditions, an early-exit arm
   * followed by its sibling, loop tests) answers false. */
  private printsOneIf(control: Control): control is Extract<Control, { kind: 'if' }> {
    if (
      control.kind !== 'if' ||
      this.loopTests.has(control.id) ||
      this.flagStages.has(control.id) ||
      [control.when_true, control.when_false].some((arm) => arm.shared || arm.joins)
    )
      return false;
    const yes = control.when_true,
      no = control.when_false;
    const shaped =
      (this.emptyArm(yes) || this.emptyArm(no) || this.terminates(yes) || this.terminates(no)) &&
      this.localValidation.presentation(
        'branch_layout',
        this.input.function.id,
        'an empty arm is dropped (inverting the exact integer test) and an arm that cannot fall through ends its if; the other arm follows unchanged',
      );
    if (!shaped) return true;
    if (this.emptyArm(no) !== this.emptyArm(yes)) {
      // `sourceIf` merges a nested else-less if into this one's conjunction.
      const inner = this.nestedIf(this.emptyArm(no) ? yes : no);
      if (
        inner &&
        this.localValidation.presentation(
          'nested_condition_merge',
          control.id,
          'an if whose only printed content is another else-less if (no statements, definitions, labels, notes or edge copies between them) and whose other arm prints nothing becomes one if over the short-circuit conjunction; the inner test is still evaluated only when the outer one holds',
          [inner],
        )
      )
        return this.printsOneIf(this.controls.get(inner)!);
    }
    if (this.emptyArm(no) || this.emptyArm(yes)) return true;
    const lead = this.leadingArm(yes, no);
    return lead !== null && lead !== (this.terminates(yes) ? yes : no);
  }

  /** Print the `else` arm of an if whose first arm is printed, then close the
   * if. An arm that prints exactly one `if` statement continues the chain as
   * `else if` (`elif`) at the same depth instead of nesting in an `else` block. */
  private elseArm(arm: ControlArm, depth: number, origin: Control): void {
    const c = this.language === 'c-like',
      inner = this.soleControl(arm);
    // An arm printing nothing prints no `else`.
    if (
      this.emptyArm(arm) &&
      this.localValidation.presentation(
        'branch_layout',
        this.input.function.id,
        'an empty arm is dropped (inverting the exact integer test) and an arm that cannot fall through ends its if; the other arm follows unchanged',
      )
    ) {
      if (c) this.writer.line(depth, '}');
      this.silentArm(arm, depth, origin);
      return;
    }
    if (
      inner &&
      this.printsOneIf(inner) &&
      this.localValidation.presentation(
        'else_if',
        origin.id,
        'an else arm that prints exactly one if statement (no statement, definition, label, note or edge copy before or after it) prints as else if; the same test is evaluated under the same condition',
        [inner.id],
      )
    ) {
      this.elseIf = true;
      this.arm(arm, depth, origin);
      if (this.elseIf) this.invalid('An else-if head was not printed');
      return;
    }
    this.writer.line(depth, c ? '} else {' : 'else:');
    this.arm(arm, depth + 1, origin);
    if (c) this.writer.line(depth, '}');
  }

  /** The head line of a source-view `if`; the first one after `elseArm` chose
   * `else if` continues the chain it closes. */
  private ifHead(depth: number, text: string): void {
    const chained = this.elseIf;
    this.elseIf = false;
    const start = this.writer.offset;
    this.writer.line(
      depth,
      this.language === 'c-like'
        ? `${chained ? '} else ' : ''}if (${text}) {`
        : `${chained ? 'el' : ''}if ${text}:`,
    );
    this.mapHeaded(start);
  }

  /** Operand statements printed inside the head line starting at `start` (an
   * `if` or loop test) map to that line. */
  private mapHeaded(start: number): void {
    for (const origin of this.headed.splice(0)) {
      const node = this.statements.get(origin.id);
      this.inferenceSites.set(origin.id, { start, end: this.writer.offset });
      this.map(origin, start);
      if (node?.kind === 'call') {
        const proof = this.sourceEvidence.get(node.id);
        this.mapped(
          node,
          start,
          proof ? [...proof.ids] : [],
          proof ? [node.contract_evidence, proof.evidence] : [node.contract_evidence],
        );
      }
      if (node) this.mapMemory(node, start);
    }
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
    // A declared hidden result (S9) returns its pointer, not the declared type.
    const resultId = source.hidden_result
      ? undefined
      : (signature?.return_type ?? source.return_source_type);
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
      respell_formal: (id) =>
        !source.formal_types?.has(id) &&
        (this.sourceValueTypes.get(id) ?? source.value_types?.get(id)?.type_id) !== undefined,
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
    this.chooseLocalIntegers(formals);
  }

  /** The value has no source type, or the unsigned integer type of its width. */
  private plainIntegerType(value: Value): boolean {
    const id =
      this.sourceValueTypes.get(value.id) ??
      this.program.source?.value_types?.get(value.id)?.type_id;
    const type = id === undefined ? undefined : this.typeRecords.get(id)?.definition;
    return (
      id === undefined ||
      (type?.kind === 'integer' && !type.signed && type.bits === bitWidth(value.type))
    );
  }

  /** C source view: give each set of integer locals connected by copies the
   * signed or narrow C type that prints strictly fewer conversions (see
   * planIntegerSpellings). Python-like values are unbounded integers: a signed
   * or narrow declaration there needs a reduction at every definition and keeps
   * `int32(uint32(x))` at signed reads, so it never saves one. */
  private chooseLocalIntegers(formals: ReadonlySet<string>): void {
    const program = this.program,
      source = program.source;
    if (!source || !this.sourceView || this.language !== 'c-like' || this.nativeIntegerStorage)
      return;
    const choices = planIntegerSpellings({
      program,
      context: this.context,
      inline: this.inline,
      constant: this.constantOf,
      variable: (value) =>
        value.type.kind === 'integer' &&
        [8, 16, 32, 64].includes(value.type.bits) &&
        program.live.has(value.id) &&
        !this.inline.has(value.id) &&
        !this.inlined.has(value.id) &&
        !this.inlinedCalls.has(value.id) &&
        !formals.has(value.id) &&
        !source.stack_addresses.has(value.id) &&
        !source.float_values?.has(value.id) &&
        !this.fpPresentation.unobserved.has(value.id) &&
        !this.localSpellings.has(value.id) &&
        this.valueType(value) === this.dataType(value.type) &&
        this.plainIntegerType(value),
    });
    for (const choice of choices.values()) {
      const spelling = `${choice.signed ? 'int' : 'uint'}${choice.bits}_t`;
      if (
        !this.localValidation.presentation(
          'local_integer_spelling',
          choice.members[0]!,
          `integer locals connected by copies are declared ${spelling}${choice.narrow ? ': every read, through same-width reinterpretations, reads only that low slice (a truncation or an extract inside it)' : ''}, because their reads print ${choice.after} conversions that way against ${choice.before} with the machine spelling (signed comparisons, sign extensions, arithmetic shifts and signed constant divisions read a signed local unconverted; every other read converts it to its unsigned type, so arithmetic stays unsigned and free of signed overflow); C assignment converts each definition to the declared type exactly as the explicit conversion at the read did, so values, widths and evaluation order are unchanged`,
          choice.members.slice(0, 64),
        )
      )
        continue;
      for (const id of choice.members) {
        this.localSpellings.set(id, spelling);
        this.localIntegers.set(id, { bits: choice.bits, signed: choice.signed });
        this.localIntegerSets.set(id, choice.members[0]!);
      }
    }
  }

  /** Source view: structure the reconstruction's CFG again now that block
   * contents are known (Ghidra structures again after its merges): blocks that
   * print their test alone or one statement it can hold (`commaOperands`) and
   * copy-free edges let short-circuit conditions collapse first. Transfer
   * objects are kept, so every map keyed by them stays valid; loops and block
   * ownership are those of the first structuring. The facts never depend on
   * the first layout (reconstruction reads only its blocks, transfers and loop
   * membership, see docs/internals/structuring-emission.md). */
  private restructure(silent: (block: BlockRegion) => boolean, plans: AttemptPlans): void {
    const program = this.program,
      edges = new Map<string, ParallelTransfer>();
    const slots = (control: Control): [number, ParallelTransfer][] =>
      control.kind === 'jump'
        ? [[-1, control.transfer]]
        : control.kind === 'if'
          ? [
              [0, control.when_true.transfer],
              [1, control.when_false.transfer],
            ]
          : control.kind === 'switch'
            ? [
                ...control.cases.map((item, index): [number, ParallelTransfer] => [
                  index,
                  item.arm.transfer,
                ]),
                [control.cases.length, control.otherwise.transfer],
              ]
            : [];
    for (const block of program.blocks.values())
      for (const [slot, transfer] of slots(block.control)) {
        this.context.checkpoint(1);
        edges.set(`${block.id}:${slot}`, transfer);
      }
    const conditions: StructuringConditions = {
      operand: (id) => {
        const block = program.blocks.get(id)!;
        return block.control.kind === 'jump'
          ? (silent(block) && !this.notes.has(block.id) && !this.notes.has(block.control.id)) ||
              this.commaCarriers.has(id)
          : this.commaOperands.has(id);
      },
      copies: (block, slot) => this.printedCopies(edges.get(`${block}:${slot}`)!).length,
      returnsConstants: (block, slot) => this.returnsConstants(edges.get(`${block}:${slot}`)!),
    };
    // An earlier attempt's structuring is reused when every condition it
    // evaluated, asked again in the same order, answers the same: structuring
    // is deterministic in its graph (the shared reconstruction's) and these
    // answers, so it would ask the same questions and lay out the same body.
    const structure = (facts: StructuringConditions): StructuringResult => {
      const asked = (query: StructuringQuery): boolean | number =>
        query.kind === 'operand'
          ? facts.operand(query.block)
          : facts[query.kind](query.block, query.slot);
      for (const memo of (plans.structures ??= []))
        if (
          memo.graph === program.function &&
          memo.queries.every((query) => asked(query) === query.answer)
        )
          return memo.result;
      const queries: StructuringQuery[] = [];
      const result = structureControlFlow(
        structuredGraph(program.function, program.blocks, (work) => this.context.checkpoint(work)),
        this.context,
        {
          max_work: this.context.budget.work,
          // The goto search runs from a sub-allowance that leaves the text
          // render's reserve (`TEXT_RENDER_WORK`); past it stuck scopes keep
          // dependency order, as past the search's own selection allowance.
          search_work: Math.max(
            0,
            (this.context.remainingWork?.() ?? Infinity) -
              TEXT_RENDER_WORK * renderUnits(this.input.function),
          ),
          transfers: (block, slot) => edges.get(`${block}:${slot}`),
          conditions: {
            operand: (block) => {
              const answer = facts.operand(block);
              queries.push({ kind: 'operand', block, answer });
              return answer;
            },
            copies: (block, slot) => {
              const answer = facts.copies(block, slot);
              queries.push({ kind: 'copies', block, slot, answer });
              return answer;
            },
            returnsConstants: (block, slot) => {
              const answer = facts.returnsConstants(block, slot);
              queries.push({ kind: 'returnsConstants', block, slot, answer });
              return answer;
            },
          },
        },
      );
      // A partial result (exhausted work) is not a layout: it is never reused.
      if (result.value) plans.structures.push({ graph: program.function, queries, result });
      return result;
    };
    let result = structure(conditions);
    if (
      result.value &&
      result.conditions.length &&
      !this.localValidation.presentation(
        'short_circuit_structure',
        this.input.function.id,
        "structured again after reconstruction (the blocks, edges and loops of the first structuring): a branch entered only from one condition, printing its test alone or one statement the test reads, whose exits include that condition's other successor, joins it as a short-circuit operand before any other collapse (Ghidra collapseConditions); the operand's entry edge and the condition's exits to that successor print no copies, and the successor may become the head's arm, entered by every such exit",
        result.conditions,
      )
    )
      result = structure({ ...conditions, operand: () => false });
    // Nothing collapsed or labeled first: the searched layout is the given one,
    // kept (a provisional layout skipped the search and is replaced).
    if (
      !result.value ||
      (!result.conditions.length && !result.tails.length && !program.function.provisional)
    )
      return;
    const blocks = new Map<string, BlockRegion>(),
      pending: Region[] = [result.value.body];
    while (pending.length) {
      this.context.checkpoint(1);
      const region = pending.pop()!;
      if (region.kind === 'sequence') pending.push(...region.regions);
      else if (region.kind === 'loop') pending.push(region.body);
      else {
        blocks.set(region.id, region);
        this.controls.set(region.control.id, region.control);
        for (const arm of controlArms(region.control)) if (arm.body) pending.push(arm.body);
      }
    }
    this.program = { ...program, function: result.value, blocks };
    this.body = this.fpPresentation.rewrite(result.value.body);
  }

  /** Source view, C-like (L4): rotate the loop-carried copies that alone keep a
   * bottom test from printing as do-while (loopCopyRotations): `this.program`
   * becomes rotateLoopCopies' rewrite, each pseudo value takes its phi's
   * spelling, and the rotations are returned for the partition. Optional work,
   * at most 1/8 of the remaining budget like the partition's; the checked view
   * and Python-like (no do-while) never rotate. */
  private loopCopyRotations(liveness: VariableLiveness): readonly LoopCopyRotation[] {
    if (this.language !== 'c-like' || !liveness.complete) return [];
    const program = this.program,
      floating = program.source?.float_values;
    const rotations = loopCopyRotations(
      this.body,
      program,
      liveness,
      (control) => !this.requirementPredicates.has(control.id),
      (phi, source) =>
        !floating?.has(phi.id) &&
        !floating?.has(source.id) &&
        !this.fpPresentation.unobserved.has(phi.id) &&
        !this.fpPresentation.unobserved.has(source.id),
      this.context,
    );
    // The rotated liveness copies every block's entry set once.
    const work =
      program.blocks.size * ((liveness.values.length + rotations.length + 31) >>> 5) +
      program.values.size;
    if (
      !rotations.length ||
      work > Math.floor((this.context.remainingWork?.() ?? 0) / 8) ||
      !this.localValidation.presentation(
        'loop_copy_rotation',
        this.input.function.id,
        "a loop whose lexically last test is its sole repeat edge, where repeat copies x = y of a value y defined in the loop (not live into the header) are live on exit or read by the exit copies, binds a fresh variable p at its header instead of each such phi x: every incoming edge writes p (the entry value, or y on the repeat edge) and the header's first statement is x = p. Every iteration therefore starts with x holding exactly the phi's value; p is dead after that statement and y is defined later, so they do not interfere and may share one variable, leaving the repeat edge copy-free for the do-while. Only copy placement changes; no value, effect or test moves",
        rotations.map(({ definition }) => definition.id),
      )
    )
      return [];
    // Each pseudo value is presented like the repeat source it is meant to
    // share a variable with (spelling, storage and role), so the header-start
    // copy prints exactly as the repeat edge copy it replaces.
    const roles = new Map(this.sourceRoleNames);
    this.context.checkpoint(roles.size);
    for (const { header, phi, source, pseudo } of rotations) {
      const phis = this.rotatedPhis.get(header) ?? new Map<string, Value>();
      phis.set(phi.id, pseudo);
      this.rotatedPhis.set(header, phis);
      const type =
        this.sourceValueTypes.get(source.id) ??
        program.source?.value_types?.get(source.id)?.type_id;
      if (type !== undefined) this.sourceValueTypes.set(pseudo.id, type);
      const spelling = this.localSpellings.get(source.id);
      if (spelling !== undefined) this.localSpellings.set(pseudo.id, spelling);
      const integer = this.localIntegers.get(source.id);
      if (integer !== undefined) this.localIntegers.set(pseudo.id, integer);
      const set = this.localIntegerSets.get(source.id);
      if (set !== undefined) this.localIntegerSets.set(pseudo.id, set);
      const role = roles.get(source.id);
      if (role !== undefined) roles.set(pseudo.id, role);
    }
    this.sourceRoleNames = roles;
    this.program = rotateLoopCopies(program, rotations, this.context);
    return rotations;
  }

  /** Source view: coalesce phi copies, then lay out return tails and loop
   * syntax. Each step checks its side conditions on this reconstruction and
   * records one presentation rewrite; the checked view never calls this. */
  private planSourceControl(plans: AttemptPlans): void {
    const subject = this.input.function.id;
    let program = this.program;
    this.indexedData = plans.indexedData ??= indexedDataAccesses(program, this.context);
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
    const rematerialized = [...candidates.values()].filter((site) => site.rematerialized);
    if (
      rematerialized.length &&
      !this.localValidation.presentation(
        'address_rematerialization',
        subject,
        'a pointer-width sum of one printed variable (or another such sum) and a constant, read at most eight times and only as load/store addresses (directly, through inline constant displacements, or through other such sums), is printed at each of those addresses instead of a temporary; it is modular arithmetic on immutable values, and liveness treats each occurrence as a read of the variable at its reader, so the variable is never reassigned in between',
        rematerialized.map(({ node }) => node.id),
      )
    )
      for (const site of rematerialized) candidates.delete(site.node.result.id);
    const reloads = [...candidates.values()].filter((site) => site.nonfaulting);
    if (
      reloads.length &&
      !this.localValidation.presentation(
        'nonfaulting_load_order',
        subject,
        'a nonvolatile load of an address range that a printed nonvolatile access of the same structural address and at least its width reached (through its block and single-predecessor blocks, with only assignments, register reads and nonvolatile loads/stores in between) expands at its unconditional same-block single use across independent nonvolatile loads, never across a store, call, unknown effect, fence or volatile access; it cannot fault, so the faults of the loads it crosses keep their order, and loads change no memory',
        reloads.map(({ node }) => node.id),
      )
    ) {
      calls = new Map();
      for (const site of reloads) candidates.delete(site.node.result.id);
    }
    if (
      candidates.size &&
      this.localValidation.presentation(
        'single_use_inlining',
        subject,
        'single-use pure integer/IEEE scalar expressions expand at dominated SSA uses; FP-environment-dependent ones only when no call, unknown effect or register write lies on any path from definition to use (each FP site keeps its recorded environment requirement, which excludes contraction); reads in hidden FP-guard failure blocks are not uses; nonvolatile loads expand only at unconditional same-block uses with no intervening effects except nested dependent loads and private-local reads/writes; initialized private-local reads may cross unrelated effects but never a write to that local',
        [...candidates.values()].map(({ node }) => node.id),
      )
    ) {
      if (reloads.some((site) => candidates.has(site.node.result.id)))
        this.localValidation.requireAbi(
          'nonfaulting_reload',
          [...new Set(reloads.map(({ anchor }) => anchor))].slice(0, 64),
          'A successful access to [a, a+w) implies that a later read of it does not fault, absent an intervening call, unknown effect or volatile access: no other agent unmaps, protects or remaps those bytes in between. Each moved reload keeps its address, width and value; the checked view keeps every load at its original position.',
        );
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
    const unrotated = new VariableLiveness(
      program,
      this.context,
      4096,
      this.inlined,
      indices,
      new Set(this.inlinedCalls.keys()),
    );
    const rotations = this.loopCopyRotations(unrotated);
    const liveness = rotations.length ? unrotated.rotated(this.program, rotations) : unrotated;
    program = this.program;
    this.liveness = liveness;
    const formals = new Set(program.parameters.map((value) => value.id));
    // Widening copies may share unsigned storage. Interference is checked
    // at every other definition; narrow reads retain their original C type.
    const widening = new Map<string, Value>();
    const assignments: { destination: Value; source: Value }[] = [];
    /** `destination = zero_extend(source)` of a plain unsigned variable: one
     * widest-declared storage holds both (a source widened to two different
     * storage types keeps its own). */
    const widen = (source: Value, destination: Value): void => {
      const previous = widening.get(source.id);
      if (
        source.type.kind !== 'integer' ||
        destination.type.kind !== 'integer' ||
        source.type.bits >= destination.type.bits ||
        formals.has(source.id) ||
        this.inlinedCalls.has(source.id) ||
        this.valueType(source) !== this.dataType(source.type) ||
        this.valueType(destination) !== this.dataType(destination.type) ||
        (previous && machineType(previous.type) !== machineType(destination.type))
      )
        return;
      widening.set(source.id, destination);
      assignments.push({ source, destination });
    };
    // Narrow variables zero-extended by edge copies, with each extension's copy count.
    const extended = new Map<string, { narrow: Value; copies: Map<string, Value[]> }>();
    for (const copies of program.transfers.values())
      for (const copy of copies) {
        const source = this.uncast(copy.source, ['bitcast']);
        if (source.id !== copy.source.id)
          assignments.push({ destination: copy.destination, source });
        const expression = this.inline.has(copy.source.id)
          ? program.expressions.get(copy.source.id)
          : undefined;
        if (
          expression?.kind !== 'cast' ||
          expression.op !== 'zero_extend' ||
          this.inline.has(expression.value.id)
        )
          continue;
        const row = extended.get(expression.value.id) ?? {
          narrow: expression.value,
          copies: new Map<string, Value[]>(),
        };
        row.copies.set(copy.source.id, [
          ...(row.copies.get(copy.source.id) ?? []),
          copy.destination,
        ]);
        extended.set(expression.value.id, row);
      }
    // A narrow variable joins the wide phi storage only when those edge copies
    // are its only reads, so the merge adds no conversion at any read; when its
    // value is at least `int` wide, since a narrower unsigned value (a narrow type
    // or the zero extension of one) promotes to signed `int` and its definition
    // into wider storage would need a conversion; and when it carries no role name
    // the phi lacks (the merged variable keeps it).
    const promoted = (value: Value): boolean => {
      const expression = program.expressions.get(value.id);
      return (
        bitWidth(value.type) < 32 ||
        (expression?.kind === 'cast' &&
          expression.op === 'zero_extend' &&
          bitWidth(expression.value.type) < 32)
      );
    };
    for (const { narrow, copies } of extended.values()) {
      const role = this.sourceRoleNames.get(narrow.id);
      if (
        promoted(narrow) ||
        program.use_counts.get(narrow.id) !== copies.size ||
        [...copies].some(
          ([id, destinations]) =>
            program.use_counts.get(id) !== destinations.length ||
            destinations.some(
              (destination) => !!role && this.sourceRoleNames.get(destination.id) !== role,
            ),
        )
      )
        continue;
      for (const destinations of copies.values())
        for (const destination of destinations) widen(narrow, destination);
    }
    // A retained same-width alias `d = (T)s` holds exactly `s`.
    const aliases: { destination: Value; source: Value }[] = [];
    // Definitions printed through an exact conversion into the variable's type:
    // edge copies (block parameters), pure assignments and plain source loads.
    const flexible = new Set<string>(rotations.map(({ pseudo }) => pseudo.id));
    for (const block of program.blocks.values()) {
      this.context.checkpoint(1);
      for (const parameter of block.parameters) flexible.add(parameter.id);
      for (const node of block.statements) {
        if (!program.retained.has(node.id)) continue;
        if (
          node.kind === 'load' &&
          program.source &&
          !this.globals.import_loads.has(node.id) &&
          !this.punnedLocal(node)
        )
          flexible.add(node.result.id);
        if (node.kind !== 'assign') continue;
        flexible.add(node.result.id);
        const expression = program.expressions.get(node.result.id) ?? node.expression;
        if (expression.kind === 'cast' && expression.op === 'zero_extend')
          widen(expression.value, node.result);
        else if (expression.kind === 'cast' && expression.op === 'bitcast')
          aliases.push({ destination: node.result, source: expression.value });
      }
    }
    const storageType = (value: Value): string =>
      machineType((widening.get(value.id) ?? value).type);
    const pointerSpelling = (spelling: string): boolean =>
      this.language === 'c-like' ? spelling.endsWith('*') : spelling.startsWith('pointer[');
    const member = (value: Value): VariableMember => {
      const spelling = this.valueType(value),
        formal = formals.has(value.id),
        floating = program.source?.float_values?.get(value.id);
      const integer = /^(?:const )?u?int(\d+)_t$/.exec(spelling);
      const scalar =
        value.type.kind === 'integer' &&
        floating === undefined &&
        (pointerSpelling(spelling) ||
          Number(integer?.[1]) === value.type.bits ||
          (spelling === 'bool' && value.type.bits === 1));
      return {
        spelling,
        // Without source evidence a formal keeps its own storage.
        storage:
          formal && !program.source
            ? `formal ${value.id}`
            : `${storageType(value)} ${floating ?? ''}${this.localIntegerSets.get(value.id) ?? ''}`,
        flexible: flexible.has(value.id) && !formal,
        scalar,
        plain:
          value.type.kind === 'integer' &&
          !formal &&
          floating === undefined &&
          spelling === this.dataType(value.type),
        named: this.names.has(value.id),
        reads: program.use_counts.get(value.id) ?? 0,
        formal,
      };
    };
    // In-place updates: a definition and each variable its expression reads
    // (`y = f(x)` prints `x = f(x)` when `x` dies there).
    const adjacent: { destination: Value; source: Value }[] = [];
    const chain = (destination: Value, operands: readonly Value[]): void => {
      if (!liveness.index.has(destination.id)) return;
      for (const operand of operands)
        for (const leaf of liveness.leaves(operand))
          adjacent.push({ destination, source: liveness.values[leaf]! });
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
    // A rotated phi's pseudo value joins its repeat source first: they never
    // interfere, and an earlier entry-value merge must not keep them apart.
    const edges: { destination: Value; source: Value }[] = [
      ...rotations.map(({ pseudo, source }) => ({ destination: pseudo, source })),
      ...assignments,
    ];
    for (const copies of program.transfers.values()) edges.push(...copies);
    // Values each machine register holds at a block boundary, in value order.
    const registers = new Map<string, Set<Value>>();
    for (const block of program.blocks.values())
      for (const binding of [...block.register_entry, ...block.register_exit]) {
        this.context.checkpoint(1);
        if (!liveness.index.has(binding.value.id)) continue;
        const held = registers.get(binding.register.id) ?? new Set<Value>();
        held.add(binding.value);
        registers.set(binding.register.id, held);
      }
    const reuse = [...registers.values()].map((held) =>
      [...held].sort((a, b) => liveness.index.get(a.id)! - liveness.index.get(b.id)!),
    );
    const variables = partitionVariables(
      program,
      liveness,
      member,
      { edges, equal: [...assignments, ...aliases], adjacent, reuse },
      this.context,
    );
    if (
      variables.size &&
      this.localValidation.presentation(
        'variable_partition',
        subject,
        'printed SSA values share one variable exactly when no member is live where another is defined (SSA liveness including simultaneous block parameters and loop-carried values; a source at a definition equal to it does not conflict): each block parameter with the variables its incoming edge arguments read, then each same-width alias or plain unsigned zero extension with its source, then each definition with an operand variable of the same presented type (in-place update); an edge copy within one variable prints nothing, an interfering pair keeps its copy. Members share one machine storage type and FP presentation; a formal or other rigid definition fixes the declared type, otherwise the widest member of the most-read type declares it; a member presented differently is converted exactly at its definition (same-width integer or pointer bits) and at each read; members of several widths are plain unsigned, narrower ones defined by zero extension and read through truncation. Names are chosen per variable',
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
            this.flagAccesses.has(node.id) ||
            ('result' in node && this.inlined.has(node.result.id)) ||
            this.noMove(node)) &&
          !hasDefinitions(node.id),
      );
    // Block contents are known now: structure again with them (Ghidra's
    // post-merge pass), so short-circuit conditions collapse first.
    const entries = new Map<string, number>();
    for (const block of program.blocks.values()) {
      const node = this.commaOperand(block);
      if (node !== undefined) this.commaOperands.set(block.id, node);
      const control = block.control;
      for (const transfer of control.kind === 'jump'
        ? [control.transfer]
        : controlArms(control).map((arm) => arm.transfer))
        entries.set(transfer.target, (entries.get(transfer.target) ?? 0) + 1);
    }
    // A block ending in a jump (often a call's block) may hold the statement
    // of the test it alone enters.
    for (const block of program.blocks.values()) {
      const control = block.control;
      if (control.kind !== 'jump' || this.printedCopies(control.transfer).length) continue;
      const next = program.blocks.get(control.transfer.target)!;
      if (entries.get(next.id) !== 1 || this.commaOperands.get(next.id) !== null) continue;
      const node = this.commaOperand(next, block);
      if (!node) continue;
      this.commaOperands.set(next.id, node);
      this.commaCarriers.set(block.id, next.id);
    }
    const held = [...this.commaOperands].filter(
      (entry): entry is [string, Instruction] => !!entry[1],
    );
    if (
      held.length &&
      !this.localValidation.presentation(
        'comma_condition',
        subject,
        'a later short-circuit operand whose block prints exactly one statement before its test (an assignment, load or single-result call defining a value the test reads; a jump block alone entering the test may hold it) prints that statement inside the test: C `(x = f(), test)`, or `test` with its one direct read of x replaced by `(x = f())` when it reads x once, unconditionally, with no other memory read or call; Python-like only the direct `(x := f())`. The comma operator is a sequence point, so the statement runs exactly when the test runs and before it, as in the block; nothing is hoisted',
        held.map(([, node]) => node.id),
      )
    ) {
      for (const [id] of held) this.commaOperands.delete(id);
      this.commaCarriers.clear();
    }
    this.restructure(silent, plans);
    program = this.program;
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
      !layout.duplicated.length ||
      this.localValidation.presentation(
        'return_tail_duplication',
        subject,
        'a labeled edge into an acyclic return, tail-call or trap tail of at most four blocks, each with at most four assignments/loads/stores/calls and four edge copies, ends in an owned copy; effects execute once on the same path in the same order, and copies retain original identities',
        [...new Set(layout.duplicated.map((item) => item.tail))],
      )
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
            !('result' in node && this.inlined.has(node.result.id)) &&
            !this.noMove(node)) ||
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
    // The one statement a non-silent loop header prints, when its test (or the
    // test of the block its carrier jump enters) holds it (commaOperands).
    const headStatement = (header: string): Instruction | undefined => {
      const block = program.blocks.get(header);
      if (!block || silent(block)) return undefined;
      return this.commaOperands.get(this.commaCarriers.get(header) ?? header) ?? undefined;
    };
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
        comma: (block) => {
          const node = this.commaOperands.get(block.id);
          return !!node && block.statements.includes(node);
        },
        carrier: (block) => this.commaCarriers.get(block.id),
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
        induction: (loop) =>
          this.acceptFor(loop, loop.bottom ? undefined : headStatement(loop.header)),
      },
      this.context,
    );
    const tests: string[] = [],
      fors: string[] = [],
      exits: string[] = [],
      exitCopyLoops = new Set<string>(),
      commas = new Map<string, Instruction>();
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
        // A top test of a header printing one statement holds it.
        const held =
          region.form &&
          (region.form.kind === 'while' || (region.form.kind === 'for' && !region.form.bottom))
            ? headStatement(region.header)
            : undefined;
        if (region.form && held) commas.set(region.form.test, held);
        const control = region.form && this.controls.get(region.form.test);
        const leave =
          region.form &&
          control &&
          formArm(region.form, control).find((item) => item.action === 'break');
        if (region.form && leave && this.printedCopies(leave.arm.transfer).length) {
          exits.push(region.form.test);
          exitCopyLoops.add(region.header);
        }
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
          'a while/do-while prints as for (init; test; step) when its single entry and single repeat edges only initialize and step (x = x ± c) induction variables nothing else in the loop writes, and its test reads one; a bottom test must hold on entry; a while whose sole repeat edge prints nothing may take as step the body’s last statement assigning a variable its test reads and nothing else in the loop writes, and as init the statement assigning it that ends the entry block; the same holds for a store into a promoted private stack slot (no frame address reaches it) that the test reads through a load, when no other store to the slot exists in the loop and its init store ends the entry block',
          fors,
        )) &&
      (!exits.length ||
        this.localValidation.presentation(
          'loop_exit_copies',
          subject,
          "a single-test loop's exit edge prints its copies right after the loop: it is the only edge from inside the loop to the continuation, and outer-loop exit flags are tested before them; a do-while's repeat copies (moved before its test) are not read by them",
          exits,
        )) &&
      (!commas.size ||
        this.localValidation.presentation(
          'loop_comma_condition',
          subject,
          'a while or for loop whose header prints exactly one statement before its first test (an assignment, load or single-result call defining a value that test reads; a jump block alone entering the test may hold it) prints that statement inside the test: C `(x = f(), test)`, or `test` with its one direct read of x replaced by `(x = f())`; Python-like only the direct `(x := f())`. The comma operator is a sequence point, so the statement runs once per header entry, immediately before the test, as in the header block; a header that also has a valid bottom test stays do-while',
          [...commas.values()].map((node) => node.id),
        ))
        ? shaped
        : body;
    if (this.body === body) {
      this.rebased.clear();
      this.hoisted.clear();
      this.forLoops.clear();
      this.forStatements.clear();
      this.headerStatements.clear();
    } else for (const [test, node] of commas) this.loopCommaTests.set(test, node);
    // Short-circuit tests sharing one arm print as if/else.
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
          // A later operand may print one statement its test holds.
          !!this.commaOperands.get(block.id) ||
          this.commaCarriers.has(block.id) ||
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
        'a short-circuit test whose operands are copy-free tests printing nothing but their condition, or later operands printing one statement their test holds inside it, as (x = f(), test) or (x = f()) op k (with only silent copy-free jumps between them) and all leave for one statement, entered by those edges only, prints as if/else: that statement becomes the arm body every leaving operand enters (else of the && of staying tests, or then of the || of leaving tests), and the remaining branch falls into the statement after it; operands, with their statement, are still evaluated left to right only while the condition is undecided, and no other statement, edge copy or effect moves',
        sharedArms.heads,
      )
    )
      this.body = sharedArms.body;
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
    this.quietJump = (block) =>
      block.control.kind === 'jump' &&
      silent(block) &&
      !this.notes.has(block.id) &&
      !anchored(block.control.id) &&
      block.statements.every((node) => !anchored(node.id)) &&
      !this.printedCopies(block.control.transfer).length;
    const routes = planLoopExits(this.body, this.language, this.context, {
      quiet: this.quietJump,
      exitCopies: exitCopyLoops,
    });
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

  /** Restate a do-while test over the variable its repeat copy just wrote, so
   * the copy prints before the test:
   * - for a copy `x <- x + c` and an equality `L ==/!= B` whose `L` is `x` (or
   *   `x mod 2^w`) plus a constant k through casts and constant steps, test
   *   `x (mod 2^w) ==/!= B + c - k` (mod 2^w). `B` is a constant (a zero
   *   extended `L` against a constant in its range tests the narrower value),
   *   or an expression over variables the repeat copies do not write, without
   *   inline loads or calls; `B + d` folds into `B = y ± m`. A test on the
   *   copy's source value is the case k = c: the same predicate over `x`.
   * - for a copy `x <- x >> c` (logical or arithmetic, 0 < c < width) and an
   *   unsigned range test `x < 2^c` (or `x <= 2^c - 1`, or their negations),
   *   test `x ==/!= 0`. Other ordered compares are not restated.
   * The derivation is exact over the IR; while the shared allowance remains,
   * the bit-vector checker independently re-proves the restated test (over the
   * copy's source value) and may veto it. */
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
    const original = compare;
    const key = (value: Value): string => (this.variables.get(value.id) ?? value).id;
    const copies = this.printedCopies(repeat);
    // `value - leaf` when `value` is `leaf` plus a constant modulo 2^|leaf|,
    // through casts and constant steps no narrower than `leaf`.
    const offset = (value: Value, leaf: Value, depth = 0): bigint | null => {
      if (value.id === leaf.id) return 0n;
      const expression = program.expressions.get(value.id);
      if (
        depth > 8 ||
        !expression ||
        value.type.kind !== 'integer' ||
        leaf.type.kind !== 'integer' ||
        value.type.bits < leaf.type.bits
      )
        return null;
      if (
        expression.kind === 'cast' &&
        ['bitcast', 'zero_extend', 'sign_extend', 'truncate'].includes(expression.op)
      )
        return offset(expression.value, leaf, depth + 1);
      if (expression.kind === 'extract' && expression.offset === 0)
        return offset(expression.value, leaf, depth + 1);
      if (expression.kind !== 'integer' || (expression.op !== 'add' && expression.op !== 'sub'))
        return null;
      const step = constant(expression.right);
      if (step !== undefined) {
        const base = offset(expression.left, leaf, depth + 1);
        return base === null ? null : expression.op === 'add' ? base + step : base - step;
      }
      const first = constant(expression.left);
      if (first === undefined || expression.op !== 'add') return null;
      const base = offset(expression.right, leaf, depth + 1);
      return base === null ? null : base + first;
    };
    const synthetic = new Map<string, Expression>();
    const make = (suffix: string, type: DataType, expression: Expression): Value => {
      const value = { id: `${control.id}#${suffix}`, type };
      synthetic.set(value.id, expression);
      return value;
    };
    type Restated = {
      readonly copy: { readonly destination: Value; readonly source: Value };
      readonly op: 'eq' | 'ne';
      /** The restated left operand over the copy's destination, and the same over its source. */
      readonly subject: Value;
      readonly source: Value;
      readonly bound: Value;
      readonly scope: string;
    };
    const equality = (side: Value, other: Value, op: 'eq' | 'ne'): Restated | undefined => {
      synthetic.clear();
      const fixed = constant(other);
      let operand = side;
      // `zext v ==/!= K` with K < 2^|v| is `v ==/!= K`.
      for (let i = 0; i < 16 && fixed !== undefined && this.inline.has(operand.id); i++) {
        const cast = program.expressions.get(operand.id);
        if (
          cast?.kind !== 'cast' ||
          (cast.op !== 'bitcast' && cast.op !== 'zero_extend') ||
          cast.value.type.kind !== 'integer' ||
          fixed >= 1n << BigInt(cast.value.type.bits)
        )
          break;
        operand = cast.value;
      }
      if (operand.type.kind !== 'integer') return undefined;
      const width = operand.type.bits,
        type = integer(width);
      // operand = (leaf mod 2^width) + step, through inline casts and constant steps.
      let leaf = operand,
        step = 0n;
      for (let i = 0; i < 16 && this.inline.has(leaf.id); i++) {
        const expression = program.expressions.get(leaf.id);
        let next: Value | undefined;
        if (
          expression?.kind === 'cast' &&
          ['bitcast', 'zero_extend', 'sign_extend', 'truncate'].includes(expression.op)
        )
          next = expression.value;
        else if (expression?.kind === 'extract' && expression.offset === 0) next = expression.value;
        else if (
          expression?.kind === 'integer' &&
          (expression.op === 'add' || expression.op === 'sub')
        ) {
          const right = constant(expression.right),
            left = expression.op === 'add' ? constant(expression.left) : undefined;
          if (right !== undefined) {
            step += expression.op === 'add' ? right : -right;
            next = expression.left;
          } else if (left !== undefined) {
            step += left;
            next = expression.right;
          }
        }
        if (!next || next.type.kind !== 'integer' || next.type.bits < width) return undefined;
        leaf = next;
      }
      if (this.inline.has(leaf.id) || leaf.type.kind !== 'integer') return undefined;
      const full = leaf.type.bits,
        copy = copies.find((item) => key(item.destination) === key(leaf));
      if (!copy || copy.destination.type.kind !== 'integer' || copy.destination.type.bits !== full)
        return undefined;
      const shift = offset(copy.source, leaf);
      if (shift === null) return undefined;
      const delta = BigInt.asUintN(width, shift - step),
        x = width === full ? 'x' : `(x mod 2^${width})`,
        tested = `${x}${step === 0n ? '' : ` + ${BigInt.asUintN(width, step)}`}`,
        copied = `x <- x ${shift < 0n ? '-' : '+'} ${shift < 0n ? -shift : shift} (mod 2^${full})`;
      let bound: Value, scope: string;
      if (fixed !== undefined) {
        const bits = BigInt.asUintN(width, fixed + delta);
        bound = make('restated_bound', type, { kind: 'constant', bits });
        scope = `test of ${tested} ==/!= ${fixed} restated after the repeat copy ${copied} as ${x} ==/!= ${bits}`;
      } else {
        // B prints the same after the repeat copies: they write none of its variables.
        const written = new Set(copies.map((item) => key(item.destination)));
        if (
          other.type.kind !== 'integer' ||
          other.type.bits !== width ||
          this.leafIds(other).some(
            (id) => this.inlined.get(id)?.node.kind === 'load' || this.inlinedCalls.has(id),
          ) ||
          liveness.leaves(other).some((index) => written.has(key(liveness.values[index]!)))
        )
          return undefined;
        let base = other,
          total = delta;
        const folded = this.inline.has(other.id) ? program.expressions.get(other.id) : undefined;
        if (folded?.kind === 'integer' && (folded.op === 'add' || folded.op === 'sub')) {
          const right = constant(folded.right),
            left = folded.op === 'add' ? constant(folded.left) : undefined;
          if (right !== undefined) {
            base = folded.left;
            total += folded.op === 'add' ? right : -right;
          } else if (left !== undefined) {
            base = folded.right;
            total += left;
          }
        }
        total = BigInt.asUintN(width, total);
        const negative = total >= 1n << BigInt(width - 1),
          magnitude = negative ? (1n << BigInt(width)) - total : total;
        bound =
          total === 0n
            ? base
            : make('restated_bound', type, {
                kind: 'integer',
                op: negative ? 'sub' : 'add',
                left: base,
                right: make('restated_step', type, { kind: 'constant', bits: magnitude }),
              });
        scope = `test of ${tested} ==/!= B, an expression without inline loads or calls over variables the repeat copies do not write, restated after the repeat copy ${copied} as ${x} ==/!= B + ${delta} (mod 2^${width})${base === other ? '' : ', folded into B = y ± m'}`;
      }
      const narrow = (value: Value, suffix: string): Value =>
        width === full ? value : make(suffix, type, { kind: 'cast', op: 'truncate', value });
      return {
        copy,
        op,
        subject: narrow(copy.destination, 'restated_subject'),
        source: narrow(copy.source, 'restated_source'),
        bound,
        scope,
      };
    };
    const range = (): Restated | undefined => {
      const right = constant(original.right),
        fixed = right ?? constant(original.left);
      if (fixed === undefined) return undefined;
      // The predicate with the variable on its left.
      const op =
        right !== undefined
          ? original.op
          : original.op === 'ult'
            ? 'ugt'
            : original.op === 'ule'
              ? 'uge'
              : original.op === 'ugt'
                ? 'ult'
                : original.op === 'uge'
                  ? 'ule'
                  : original.op;
      if (op !== 'ult' && op !== 'ule' && op !== 'ugt' && op !== 'uge') return undefined;
      let leaf = right === undefined ? original.right : original.left;
      for (let i = 0; i < 16 && this.inline.has(leaf.id); i++) {
        const cast = program.expressions.get(leaf.id);
        if (cast?.kind !== 'cast' || (cast.op !== 'zero_extend' && cast.op !== 'bitcast'))
          return undefined;
        leaf = cast.value;
      }
      if (this.inline.has(leaf.id) || leaf.type.kind !== 'integer') return undefined;
      const width = leaf.type.bits;
      if (fixed >= 1n << BigInt(width)) return undefined;
      const copy = copies.find((item) => key(item.destination) === key(leaf));
      if (!copy || copy.destination.type.kind !== 'integer' || copy.destination.type.bits !== width)
        return undefined;
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
        return undefined;
      // x >> c == 0 iff x <u 2^c (an arithmetic shift too: 2^c <= 2^(width-1)).
      const limit = 1n << count,
        below = op === 'ult' || op === 'ule';
      if (fixed !== (op === 'ult' || op === 'uge' ? limit : limit - 1n)) return undefined;
      synthetic.clear();
      return {
        copy,
        op: below ? 'eq' : 'ne',
        subject: copy.destination,
        source: copy.source,
        bound: make('restated_bound', copy.destination.type, { kind: 'constant', bits: 0n }),
        scope: `unsigned test x ${below ? '<' : '>='} 2^${count} restated after the repeat copy x <- x >> ${count} (${shifted.op}, width ${width}) as x ${below ? '==' : '!='} 0`,
      };
    };
    const op = original.op;
    const restated =
      op === 'eq' || op === 'ne'
        ? (equality(original.left, original.right, op) ??
          equality(original.right, original.left, op))
        : range();
    if (!restated) return false;
    const expressions = new Map(program.expressions);
    for (const [id, expression] of synthetic) expressions.set(id, expression);
    const record = this.localValidation.allowance.exhausted
      ? undefined
      : this.localValidation.check(
          'bitvector',
          tested.id,
          'do-while test restated over its repeat copy result; not whole-function equivalence',
          () =>
            validateBitvectorCandidate(
              tested,
              original,
              { kind: 'compare', op: restated.op, left: restated.source, right: restated.bound },
              expressions,
              this.localValidation.allowance,
            ),
        );
    if (
      record?.status === 'rejected' ||
      !this.localValidation.presentation('loop_test_restatement', control.id, restated.scope, [
        tested.id,
        restated.copy.destination.id,
      ])
    )
      return false;
    for (const [id, expression] of synthetic) this.synthetic.set(id, expression);
    this.rebased.set(control.id, {
      kind: 'compare',
      op: restated.op,
      left: restated.subject,
      right: restated.bound,
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
        // Source view (S7): the dropped `al` guard of a SysV va_start. Its arms
        // print nothing (the vector stores are va_start's), nor does its pure test.
        if (control.id === this.vaList?.guard) {
          if (!this.emptyArm(control.when_true) || !this.emptyArm(control.when_false))
            this.invalid('The dropped va_start guard has a printed arm');
          this.silentArm(control.when_true, depth, control);
          this.silentArm(control.when_false, depth, control);
          break;
        }
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
                this.program.source?.hidden_result
                  ? undefined
                  : (this.program.signature?.signature.return_type ??
                      this.program.source?.return_source_type),
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
        const tail = control.kind === 'indirect' ? this.program.tails.get(control.id) : undefined;
        // Source view: an indirect exit proven to be a tail call of its runtime
        // target prints as a function-pointer call that this function returns,
        // or as a call and a plain return when the function returns nothing.
        if (
          tail?.target === null &&
          control.kind === 'indirect' &&
          this.sourceView &&
          this.localValidation.presentation(
            'function_pointer_call',
            control.id,
            "indirect tail-call target presented through a function-pointer type spelled from the observed argument types and this function's own result type (void when it returns nothing); the cast names exactly the printed argument positions and an open arity is stated in the file header note",
            [control.target.id],
          )
        ) {
          const voidResult = this.returnSpelling === 'void';
          const arguments_ = this.tailArguments(control.id, tail.boundary, ids);
          const open = this.openList(tail.boundary);
          if (open) {
            this.openRemainder(
              arguments_.length ? 'unknown_argument_remainder' : 'unknown_arguments',
              'Unresolved remainder of a call interface; not zero arguments or a purity claim.',
            );
            if (!arguments_.length) arguments_.push(this.inlineEllipsis());
            else if (!tail.boundary.signature) this.openIndirectCall(control);
          }
          ids.push(control.target.id);
          const target = this.functionPointer(
            tail.boundary,
            this.indirectCallee(control.target),
            open,
            voidResult ? 'void' : this.returnSpelling,
          );
          this.tailStatement(depth, `${target}(${this.writer.join(arguments_)})`, voidResult);
          break;
        }
        if (tail && tail.target !== null && this.program.source && control.kind === 'indirect') {
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
          const arguments_ = this.tailArguments(control.id, tail.boundary, ids);
          const guessedTail = this.likelyArgumentList(tail.boundary);
          if (tail.boundary.argument_list_complete === false && !guessedTail) {
            const remainder = this.openRemainder(
              arguments_.length ? 'unknown_argument_remainder' : 'unknown_arguments',
              'Unresolved trailing native tail-call arguments; observed prefix is retained, not a complete prototype.',
            );
            if (remainder !== undefined) arguments_.push(remainder);
            else if (this.statesOpenArity(tail.boundary, key)) this.openCallees.add(name);
            else arguments_.push(this.inlineEllipsis());
          }
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
      // A rotated phi's header-start copy prints like the edge copy it replaces.
      const pseudo = this.rotatedPhis.get(anchor)?.get(value.id);
      if (pseudo && process.env.L4DBG)
        console.error('L4DBG', {
          x: value.id,
          holder: this.variables.get(value.id)?.id,
          declared: this.declaredSpelling(value),
          own: this.valueType(value),
          type: this.sourceValueTypes.get(value.id) ?? this.program.source?.value_types?.get(value.id)?.type_id,
          spelled: this.localSpellings.get(value.id),
          pholder: this.variables.get(pseudo.id)?.id,
        });
      this.writer.statement(
        depth,
        `${this.local(value)} = ${
          pseudo
            ? this.copied(value, pseudo)
            : this.assigned(value, this.expression(expression, value.type))
        }`,
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
      // A later short-circuit operand printed inside a merged test: its one
      // statement prints in that test (see operandTerm), not here.
      // A carrier jump block holds the statement of the test it enters.
      const carried = this.sourceView ? this.commaCarriers.get(region.id) : undefined;
      const test = carried ? this.program.blocks.get(carried)!.control : region.control;
      const comma = this.sourceView ? this.commaOperands.get(carried ?? region.id) : undefined;
      // A loop header's one statement prints inside its while/for test.
      const looped = this.loopCommaTests.get(test.id);
      const merged =
        comma &&
        !looped &&
        (this.joinedPlan !== undefined ||
          this.conjunct !== undefined ||
          (this.sharedPlan !== undefined && controlArms(test).some((arm) => arm.joins)))
          ? comma
          : undefined;
      if (merged) this.commaHeld = { control: test.id, node: merged };
      for (const node of region.statements) {
        if (node === merged || node === looped) continue;
        this.context.checkpoint(1);
        if (this.headerStatements.has(node.id)) {
          this.sourceDefinitions(node.id, depth);
          continue;
        }
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
        if (node.id === this.vaList?.anchor) this.vaStart(node, depth);
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
    // Source view: the FP-environment assumption is a language premise (C11
    // 7.6.1p2: code compiled with FENV_ACCESS off, the default, runs under the
    // default modes), recorded instead of printed. The checked view prints it.
    const environmentOmitted =
      this.sourceView &&
      environment.length > 0 &&
      this.localValidation.presentation(
        'requirement_note',
        this.input.function.id,
        'the FP-environment assumption prints no comment: emitted source without #pragma STDC FENV_ACCESS ON presumes nearest-even rounding and masked FP traps (C11 7.6.1p2), recorded as the fp_default_environment ABI requirement; full ID, explanation and sites remain in requirements metadata',
        environment.map((requirement) => requirement.id),
      );
    // The premise is function-wide; its provenance is the FP-environment site
    // the fp_environment requirement already lists whose origin cites the
    // fewest instructions (the first on ties). The function origin would
    // repeat every instruction of the function, and a larger site every
    // instruction it covers.
    let premiseSite: Requirement['sites'][number] | undefined;
    if (environmentOmitted) {
      let fewest = Infinity;
      for (const requirement of environment)
        for (const site of requirement.sites) {
          this.context.checkpoint(1);
          const origin = this.origins.get(site.subject_ids[0]!);
          if (origin && origin.provenance.instruction_ids.length < fewest) {
            fewest = origin.provenance.instruction_ids.length;
            premiseSite = site;
          }
        }
    }
    if (!environmentOmitted)
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
    // Source view (S4): the incoming object's by-value struct formal.
    const incomingObject = this.sourceView ? this.program.source?.incoming_object : undefined;
    const incomingStruct = incomingObject ? this.incomingStruct(incomingObject) : undefined;
    // Source view (S9): a declared hidden result is a pointer formal to the
    // declared result type, ahead of the declaration's own parameters.
    const hiddenResult = this.sourceView ? this.program.source?.hidden_result : undefined;
    const resultPointer =
      hiddenResult && signature
        ? this.language === 'c-like'
          ? `${this.sourceType(signature.signature.return_type)}*`
          : `pointer[${this.sourceType(signature.signature.return_type)}]`
        : undefined;
    for (let i = 0; i < this.program.parameters.length; i++) {
      this.context.checkpoint(1);
      const value = this.program.parameters[i]!;
      const source =
        value.id === hiddenResult?.id
          ? undefined
          : signature?.signature.parameters[hiddenResult ? i - 1 : i];
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
      const incomingFormal = incomingObject?.formal.id === value.id;
      const name = incomingFormal
        ? this.sourceIdentifier(
            value.id,
            this.program.source?.parameter_names.get(value.id) ?? 'stack_args',
          )
        : this.program.source
          ? this.sourceIdentifier(
              value.id,
              role ??
                (this.sourceRoleNames.has(value.id)
                  ? (proven ?? `arg${i}`)
                  : (this.program.source.parameter_names.get(value.id) ??
                    source?.name ??
                    `arg${i}`)),
            )
          : this.identifier(value.id, source ? 'arg' : register ? 'reg' : 'arg');
      const type =
        incomingFormal && incomingStruct
          ? this.language === 'c-like'
            ? `struct ${incomingStruct.tag}`
            : `struct{${incomingStruct.members.join(', ')}}`
          : value.id === hiddenResult?.id && resultPointer
            ? resultPointer
            : source
              ? this.sourceType(source.type_id)
              : this.valueType(value);
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
      ? resultPointer
        ? [...this.program.returns.values()].some((projection) => projection.results.length)
          ? resultPointer
          : 'void'
        : this.sourceType(signature.signature.return_type)
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
      // The incoming object's members sit at their entry-SP offsets from its start.
      if (incomingStruct)
        w.line(
          0,
          `struct ${incomingStruct.tag} { ${incomingStruct.members.map((member) => `${member};`).join(' ')} }${incomingStruct.packed ? ' __attribute__((packed))' : ''};`,
        );
    }
    this.declareDataTables();
    this.declareSourceCallees();
    const globalsAt = w.offset;
    if (methodName && method?.kind === 'class' && this.language === 'python-like')
      w.line(0, '@classmethod');
    this.headerStart = w.offset;
    // Source view: a callee-side variadic interface ends its formals with `...`.
    const ellipsis = this.sourceView && this.program.source?.variadic !== undefined;
    if (this.program.source && parameters.length <= 4) {
      const declarations = parameters.map((parameter) =>
        w.declaration(parameter.type, parameter.name),
      );
      const prefix =
        this.language === 'c-like' ? `${returnShown} ${headerName}(` : `def ${headerName}(`;
      w.line(
        0,
        `${prefix}${this.writer.join(ellipsis ? [...declarations, '...'] : declarations)}${this.language === 'c-like' ? ') {' : `) -> ${returnShown}:`}`,
      );
      let offset = this.headerStart + prefix.length;
      for (let index = 0; index < parameters.length; index++) {
        const parameter = parameters[index]!,
          length = declarations[index]!.length;
        this.mapped(
          { ...this.dataOrigin(parameter.value.id), id: parameter.value.id },
          offset,
          [parameter.value.id],
          signature ? [signature.evidence_ids] : [],
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
          `${w.declaration(parameter.type, parameter.name)}${i + 1 < parameters.length || ellipsis ? ',' : ''}`,
        );
        const source =
          parameter.value.id === this.program.source?.hidden_result?.id
            ? undefined
            : signature?.signature.parameters[this.program.source?.hidden_result ? i - 1 : i];
        this.mapped(
          { ...this.dataOrigin(parameter.value.id), id: parameter.value.id },
          start,
          source ? [parameter.value.id, source.id, source.type_id] : [parameter.value.id],
          signature ? [signature.evidence_ids] : [],
        );
        this.inferenceSites.set(parameter.value.id, { start, end: w.offset });
      }
      if (ellipsis) w.line(1, '...');
      w.line(0, this.language === 'c-like' ? ') {' : `) -> ${returnShown}:`);
    } else
      w.line(
        0,
        this.language === 'c-like'
          ? `${returnShown} ${headerName}() {`
          : `def ${headerName}() -> ${returnShown}:`,
      );
    this.headerEnd = w.offset;
    const proof = this.sourceEvidence.get(this.input.function.id);
    this.mapped(
      this.input.function,
      this.headerStart,
      proof ? [...proof.ids] : [],
      proof ? [proof.evidence] : [],
    );
    if (environmentOmitted)
      for (const requirement of environment)
        mapSites(requirement, this.headerStart, this.headerEnd);
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
    if (stack?.kind === 'object') {
      // Independent members (A3) are locals of their own; the struct holds the
      // others and is omitted when none is left. Its end is the entry SP or
      // (A3) the hidden save area below it.
      const kept = stack.members.filter((member) => !member.independent),
        top = stack.minimum_offset + stack.size;
      if (kept.length && this.language === 'c-like') {
        const name = this.sourceIdentifier(stack.id, 'frame');
        // Members sit at their packed frame offsets; padding fills the gaps.
        let end = stack.minimum_offset,
          packed = false;
        w.line(1, `_Alignas(${stack.alignment}) struct {`);
        for (const member of kept) {
          this.context.checkpoint(1);
          const field = `local_${(-member.offset).toString(16)}`;
          if (member.offset > end)
            w.statement(2, `uint8_t pad_${(-end).toString(16)}[${member.offset - end}]`);
          w.statement(
            2,
            member.va
              ? 'va_list va'
              : member.scalar
                ? `${this.frameMemberType(member)} ${field}`
                : `uint8_t ${field}[${member.size}]`,
          );
          packed ||= member.scalar && (member.offset - stack.minimum_offset) % member.size !== 0n;
          end = member.offset + member.size;
        }
        if (end < top) w.statement(2, `uint8_t pad_${(-end).toString(16)}[${top - end}]`);
        w.statement(1, `}${packed ? ' __attribute__((packed))' : ''} ${name}`);
      } else if (kept.length) {
        const name = this.sourceIdentifier(stack.id, 'frame');
        w.statement(
          1,
          `${name} = ${this.call('stack_frame', "This activation's stack frame kept as memory: SIZE bytes ending at the entry stack pointer (or, given END, at entry-SP offset END: the bytes from there to the entry SP are hidden register saves, locals of their own or untouched), starting at an ALIGNMENT-aligned address, original contents unknown. Each annotated member local_N names the bytes at entry-SP offset -N with its type; members and all other frame bytes are ordinary aliasable memory.", [String(stack.size), String(stack.alignment), ...(top < 0n ? [`-0x${(-top).toString(16)}`] : [])])}`,
        );
        for (const member of kept) {
          this.context.checkpoint(1);
          // The SysV `va_list` (S7) states its offset beside its name.
          w.statement(
            1,
            member.va
              ? `${name}.va: va_list  # at entry-SP offset -0x${(-member.offset).toString(16)}`
              : `${name}.local_${(-member.offset).toString(16)}: ${member.scalar ? this.frameMemberType(member) : `array<uint8_t, ${member.size}>`}`,
          );
        }
      }
      for (const member of stack.members) {
        if (!member.independent) continue;
        this.context.checkpoint(1);
        const name = this.frameLocal(member, member.independent);
        w.statement(
          1,
          member.scalar
            ? w.declaration(this.frameMemberType(member), name)
            : this.language === 'c-like'
              ? `uint8_t ${name}[${member.size}]`
              : `${name}: array<uint8_t, ${member.size}>`,
        );
      }
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
    // An unobserved FP-environment value is not declared, unless it represents
    // a coalesced class that also holds an observed member.
    const observedClasses = new Set<string>();
    if (this.fpPresentation.unobserved.size)
      for (const [id, representative] of this.variables) {
        this.context.checkpoint(1);
        if (!this.fpPresentation.unobserved.has(id)) observedClasses.add(representative.id);
      }
    for (const value of this.program.values.values()) {
      this.context.checkpoint(1);
      if (
        !this.program.live.has(value.id) ||
        (this.fpPresentation.unobserved.has(value.id) && !observedClasses.has(value.id)) ||
        this.inline.has(value.id) ||
        this.inlinedCalls.has(value.id) ||
        formals.has(value.id) ||
        this.program.source?.stack_addresses.has(value.id) ||
        variadicArea(this.program.source?.variadic)?.id === value.id ||
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
    // A SysV `va_list` (S7) prints `va_start` where its lowering ended.
    this.namedLast = ellipsis ? parameters.at(-1)?.name : undefined;
    const variadic = ellipsis ? variadicArea(this.program.source!.variadic) : null;
    if (variadic) {
      // `va_start` names the last named formal; with none (C23) only `va`.
      const name = this.local(variadic),
        last = parameters.at(-1)?.name,
        start = w.offset;
      if (this.language === 'c-like') {
        w.statement(1, `va_list ${name}`);
        w.statement(1, `va_start(${name}${last ? `, ${last}` : ''})`);
      } else w.statement(1, `${name} = va_start(${last ?? ''})`);
      this.mapped(this.dataOrigin(variadic.id), start, [variadic.id]);
    }
    this.fallOffBlock = this.sourceView ? this.fallOffReturn(this.body) : null;
    const bodyLines = this.writer.codeLines;
    this.region(this.body, 1);
    if (this.language === 'python-like' && this.writer.codeLines === bodyLines)
      w.statement(1, 'pass');
    if (this.pendingCalls.size) throw new CallInliningRetry([...this.pendingCalls.keys()]);
    this.publishMappings();
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
    const external = supportAt !== undefined && this.options.structures === 'external';
    let bodies = this.structureSlot ? this.structureBodies(!external) : [];
    const compacted = bodies.filter((body) => body.gaps.length);
    if (compacted.length) {
      const nodes = [
        ...new Set(compacted.flatMap((body) => this.structAccess.get(body.name) ?? [])),
      ];
      const gaps = `omitted gaps (offset+length): ${compacted
        .map(
          (body) =>
            `${body.name} ${body.gaps
              .map((gap) => `0x${gap.offset.toString(16)}+${gap.length}`)
              .join(' ')}`,
        )
        .join('; ')}`;
      // Without the record the rewrite may not apply: keep every gap as a pad member.
      if (
        !this.localValidation.presentation(
          'compact_struct_members',
          nodes[0] ?? this.input.function.id,
          COMPACT_STRUCT_MEMBERS_SCOPE,
          nodes,
          gaps,
        )
      )
        bodies = this.structureBodies(false);
    }
    if (this.structureSlot && !external)
      insert(
        this.structureSlot.at,
        bodies.flatMap((body) => body.lines),
      );
    const externalStructures: { name: string; declaration: string }[] = [];
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
    if (this.openCallees.size) {
      const comment = `open arity (calls show proven args only): ${[...this.openCallees].join(', ')}`;
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
      // External structure bodies are not in the text, but their members mention names.
      const scan = `${text}\n${external ? bodies.flatMap((body) => body.lines).join('\n') : ''}\n${handles.map(([, declaration]) => declaration).join('\n')}`;
      const used = this.deferredTypedefs.filter(
        (name) => !this.handleTypedefs.has(name) && mentions(name, scan),
      );
      const structureNames = new Set(
        (this.structureSlot?.ids ?? []).map((id) => this.sourceStructs.name(id)),
      );
      const moved = external ? used.filter((name) => structureNames.has(name)) : [];
      for (const name of new Set(moved))
        externalStructures.push({ name, declaration: `typedef struct ${name} ${name};` });
      insert(support, [
        ...used
          .filter((name) => !moved.includes(name))
          .map((name) => `typedef struct ${name} ${name};`),
        ...handles.map(([, declaration]) => declaration),
      ]);
    }
    if (external) {
      for (const body of bodies)
        externalStructures.push({ name: body.name, declaration: body.lines.join('\n') });
      if (externalStructures.length && support !== undefined)
        insert(support, ['/* struct declarations: types.h */']);
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
        const publish = (): readonly Requirement[] =>
          sourceRequirementProofs(
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
          );
        const premise = (record: Requirement): boolean =>
          record.kind === 'abi_conformance' &&
          record.sites.some((site) => site.state_epoch === 'fp_default_environment');
        const explanation =
          'Floating-point operations assume the default environment, nearest-even rounding with FP traps masked, as C11 7.6.1p2 presumes for code compiled with FENV_ACCESS off.';
        if (environmentOmitted)
          this.localValidation.requireAbi(
            'fp_default_environment',
            [premiseSite?.subject_ids[0] ?? this.input.function.id],
            explanation,
          );
        let proofs = publish();
        // A premise site that prints nowhere publishes nothing: anchor the
        // premise at the function, which the signature always maps.
        if (
          environmentOmitted &&
          proofs.some((record) => record.kind === 'fp_environment') &&
          !proofs.some(premise)
        ) {
          this.localValidation.requireAbi(
            'fp_default_environment',
            [this.input.function.id],
            explanation,
          );
          proofs = publish();
        }
        requirements = proofs.map((record) =>
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
        ...(externalStructures.length ? { structures: externalStructures } : {}),
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

/** Render units of a structured body: three per block plus its statements (about
 * 0.7 of the selected body's IR nodes), the measure the render's work grows with. */
function renderUnits(fn: StructuredFunction): number {
  return fn.coverage.reduce((count, block) => count + 3 + block.statement_ids.length, 0);
}

/** Work per render unit (`renderUnits`) the text-only (`omitted` metadata) render
 * needs after the goto search: the rest of the attempt, the render, its validation
 * and the publication that follows (74–75 per unit measured on
 * `sqlite3WhereCodeOneLoopStart` and `sqlite3_str_vappendf`, with margin). The
 * source view's goto search never reaches into it. */
const TEXT_RENDER_WORK = 120;
/** Work per render unit of a full-metadata attempt beyond the text reserve: a full
 * attempt from reconstruction to publication measured 395–407 per unit (`isDate`,
 * `sqlite3Fts3Incrmerge`); the largest bodies reach the metadata bound later still. */
const FULL_RENDER_WORK = 330;

/** Render with single-use call inlining; a held call that does not reach its
 * reader as laid out prints as a statement in the next attempt. After four
 * failed attempts every call prints as a statement. When the request's remaining
 * work cannot pay a full render plus the text-only render that replaces a failed
 * one, the text renders first, without provenance metadata (omitted with reason
 * `budget`): the text is the one the full render prints. */
export function renderSource(
  input: EmissionInput,
  options: ConstructorParameters<typeof Renderer>[1],
  context: OperationContext,
  language: 'c-like' | 'python-like',
  version: string,
): EmissionResult {
  // Reconstruction does not depend on the attempt (rejected calls, metadata).
  const program = reconstruct(input, context, options.view === 'checked' ? 'checked' : 'source');
  const plans: AttemptPlans = {};
  let validated = false;
  const attempt = (metadata: 'full' | 'omitted'): EmissionResult => {
    const rejected = new Set<string>();
    // Each retry prints the failed calls as statements.
    for (let retry = 0; ; retry++) {
      try {
        const renderer = new Renderer(
          input,
          options,
          context,
          language,
          version,
          program,
          !validated,
          retry < 4 ? rejected : null,
          metadata,
          plans,
        );
        validated = true;
        return renderer.render();
      } catch (error) {
        if (!(error instanceof CallInliningRetry) || retry >= 4) throw error;
        for (const id of error.results) rejected.add(id);
      }
    }
  };
  // A function of the request's own counters: deterministic under every budget.
  const remaining = context.remainingWork?.();
  if (
    remaining !== undefined &&
    remaining < (FULL_RENDER_WORK + TEXT_RENDER_WORK) * renderUnits(input.function)
  ) {
    const result = attempt('omitted');
    const omitted = result.emission.omitted?.map((item) => ({
      ...item,
      reason: 'budget' as const,
    }));
    return { ...result, emission: { ...result.emission, ...(omitted ? { omitted } : {}) } };
  }
  try {
    return attempt('full');
  } catch (error) {
    // Provenance metadata is bounded separately from the text. When it cannot be
    // held, render the same text without it and say so; never fail the pseudocode.
    if (!(error instanceof MetadataLimitError)) throw error;
    return attempt('omitted');
  }
}
