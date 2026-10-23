import type {
  AbiProfile,
  AbiSignature,
  Address,
  Diagnostic,
  Evidence,
  OperationContext,
  RegisterDescriptor,
} from '../core/index.js';
import type { DataType, Instruction, RegisterBinding, Value } from '../ir/index.js';
import type { MemoryShapeTransfer } from '../analysis/types/memory-shapes.js';
import type { LikelyHeuristic, Requirement } from '../core/inference.js';
import type { NativeContext } from '../service/analysis/native-context.js';
import type { TypeSpec } from '../metadata/library-contracts/spec.js';

/** `likely` inference mode only: a guess that closes the open argument list of one call
 * or tail transfer after its observed prefix. Never a proven fact. */
export interface LikelyArity {
  /** Every heuristic whose conditions held at this site, sorted. */
  readonly heuristics: readonly LikelyHeuristic[];
  /** Some firing heuristic passes its precision gate: the printed list closes, marked.
   * Otherwise the list stays open and only the provenance record states the guess. */
  readonly applied: boolean;
  /** Call sites that agreed on the arity (`caller_consensus`). */
  readonly sites?: number;
}
/** `likely` inference mode only: what the callers of the selected function suggest about
 * an integer-typed formal or its result being an address (`void *`). */
export interface LikelyTypeEvidence {
  readonly heuristics: readonly LikelyHeuristic[];
  /** Caller sites that agreed. */
  readonly sites: number;
}
/** A guess that an integer-typed formal, or the function result, is an address (`void *`),
 * made where proven analysis leaves it integer. */
export interface LikelyTypeGuess {
  readonly heuristics: readonly LikelyHeuristic[];
  /** Some firing heuristic passes its precision gate: the type prints, marked. Otherwise
   * the declaration stays as proven analysis leaves it and only provenance states the guess. */
  readonly applied: boolean;
  /** Call sites that supported the guess (caller votes); absent for body-only evidence. */
  readonly sites?: number;
}
export interface LikelyTypes {
  /** Caller evidence for pointer formals by the register root the caller prepares them in. */
  readonly parameters: ReadonlyMap<string, LikelyTypeEvidence>;
  readonly result?: LikelyTypeEvidence;
  /** Type record of `void *`, supplied beside the types in likely mode. */
  readonly pointer_type_id: string;
}
/** Source view, likely mode: the guesses that fired for this body and found the type still
 * open after proven analysis, keyed by the formal value; `applied` ones changed the text. */
export interface LikelyTypePresentation {
  readonly parameters: ReadonlyMap<string, LikelyTypeGuess>;
  readonly result?: LikelyTypeGuess;
}
/** Observed native callee inputs, not a user-supplied or proven source prototype. */
export interface InferredCallee {
  readonly call_id: string;
  /** Exact native dependency identity; absent for unresolved callback targets. */
  readonly target?: Address;
  readonly target_subject_id?: string;
  readonly parameter_state?: 'observed' | 'ambiguous';
  readonly parameters: readonly RegisterDescriptor[];
  /** False records an observed prefix without closing the target's source arity. */
  readonly argument_list_complete?: boolean;
  /** Basis on which a source view may close an open (`argument_list_complete:
   * false`) observed argument list. `callee_reads`: the fully analyzed,
   * nonrecursive callee reads no register outside `parameters`, no incoming stack
   * and no escaping incoming-stack address. Caller-private writes do not reopen
   * a callee-proven register-only argument list. `library_contract` additionally
   * relies on an established imported ABI contract, directly or through native tails.
   * `objc_selector`: a statically resolved Objective-C selector fixes the keyword
   * argument count, and the caller prepares no further argument registers. */
  readonly argument_list_closure?: 'callee_reads' | 'library_contract' | 'objc_selector';
  /** Observed incoming slots in callee-entry SP coordinates, not a full arity. */
  readonly stack_parameters?: readonly {
    readonly offset: bigint;
    readonly width_bits: number;
    readonly type: DataType;
  }[];
  /** The callee lets a pointer into its incoming argument area escape (an
   * escaping `va_list`), so it may read caller-written stack bytes beyond any
   * observed stack parameter. Never a count of those bytes or arguments. */
  readonly variadic_stack?: true;
  /** The callee's `va_start` footprint (S6/S7, published by its native unit):
   * its named argument registers in position order (`named`; their counts per
   * class) and the bytes of named stack arguments before the first anonymous
   * one. Every other argument location is anonymous under the ABI's variadic
   * convention. The physical interface fields above stay as observed. */
  readonly variadic?: {
    readonly named_integer: number;
    readonly named_vector: number;
    readonly named_stack_bytes: bigint;
    readonly named: readonly RegisterDescriptor[];
  };
  readonly returns: readonly RegisterDescriptor[];
  /** An established contract or method type encoding declares a void result:
   * empty `returns` is then proven no result, not an unknown result interface. */
  readonly returns_void?: true;
  /** Lane types observed independently of architectural register capacity. */
  readonly parameter_types?: readonly DataType[];
  readonly return_types?: readonly DataType[];
  readonly context_assumptions?: NativeContext;
  /** Preconditions of these observations; absent means no inferred FP condition. */
  readonly requirements?: readonly 'fp_environment'[];
  /** The callee may return with a changed FP control state: it writes it on a
   * path to a return or tail exit (an explicit write, an opaque effect, a writer
   * import or a writer callee). Its caller keeps its environment guards. */
  readonly fp_environment_writer?: true;
  readonly evidence_ids: readonly string[];
}
export interface SourceAddress {
  readonly address: Address;
  readonly name?: string;
  /** Evidence-backed C spelling of a native symbol; asserted names stay verbatim. */
  readonly source_name?: string;
  /** Exact immutable image bytes, free of relocation slots and possible local writes. */
  readonly constant_bytes?: readonly number[];
  /** Only immutable, terminated strings with exact image/address provenance. */
  readonly string?: string;
  readonly string_byte_length?: bigint;
  readonly string_encoding?: 'ascii' | 'utf8';
  /** The string begins at a section start or right after a NUL byte: it is not
   * the interior suffix of a neighbouring terminated string. */
  readonly string_start?: true;
  /** Static Objective-C identity of this exact address: a constant NSString
   * object, or a selector/class reference slot whose 64-bit load yields that
   * selector/class. Spelling only; memory ordering and faults are unchanged. */
  readonly objc?: { readonly kind: 'string' | 'selector_ref' | 'class_ref'; readonly text: string };
  /** The address is the entry of a function of this image (a symbol or a
   * discovered function). Identity only: it names the function wherever the
   * constant is used as a value, never the bytes at the address. `self`: it
   * is the function being presented. */
  readonly function_entry?: { readonly self: boolean };
  /** Immutable bytes of the object, from `object.address`: a bounded prefix of
   * its known extent or of `object.span_bound`, with no relocation slot in it.
   * Present only for the base of an indexed read-only table. */
  readonly object_bytes?: readonly number[];
  /** Byte storage identity; an unknown extent is never inferred from a use. */
  readonly object?: {
    readonly address: Address;
    readonly byte_length: bigint | null;
    /** An immutable object's bytes end no later than this many bytes after
     * `address`: the distance to the next symbol, data record or relocation
     * slot, or the end of its section (at most 4096). A bound, not a size. */
    readonly span_bound?: bigint;
    readonly offset: bigint;
    readonly mutable: boolean;
    readonly kind: 'bytes' | 'jump_table' | 'literal_pool' | 'unknown';
    readonly evidence_ids: readonly string[];
  };
  /** The address is the loader-bound slot of an imported symbol (Mach-O bind/GOT,
   * ELF GLOB_DAT, PE IAT). The dynamic linker alone writes it: an exact
   * pointer-width read yields the imported symbol's address, so one more
   * dereference reaches the imported object. Type and extent stay unknown. */
  readonly import?: {
    readonly id: string;
    /** Native linkage name of the symbol as the loader recorded it. */
    readonly name: string;
    /** C spelling of `name`; asserted names stay verbatim. */
    readonly source_name: string;
    readonly library: string | null;
    /** Import/bind records that evidence this slot's binding. */
    readonly evidence_ids: readonly string[];
    /** The library header's declaration of the imported object (`__stderrp` is a
     * `FILE *`): a nominal fact about the named library's declaration, never a
     * size, an array extent or a layout. */
    readonly variable?: {
      readonly type: TypeSpec;
      readonly constant: boolean;
      readonly source: string;
    };
  };
}
/** Facts supplied by the native analysis pipeline; never selected by host ABI. */
export interface SourceEvidence {
  readonly abi: AbiProfile;
  readonly callees: readonly InferredCallee[];
  /** Proven-context/import-tail refinements and their propagation, source only. */
  readonly source_callees?: readonly InferredCallee[];
  readonly addresses: readonly SourceAddress[];
  /** Virtual-address ranges of the image's executable mappings. Absent: every
   * constant may be a code address. */
  readonly executable_ranges?: readonly { readonly start: bigint; readonly end: bigint }[];
  /** Explicit optional-dependency limitations; never substitutes a zero interface. */
  readonly diagnostics?: readonly Diagnostic[];
  readonly evidence?: readonly Evidence[];
  /** Proven complete actual counts for contextual variadic calls (`open`
   * flags that take no mode on every possible value). */
  readonly call_argument_counts?: ReadonlyMap<string, number>;
  /** Likely mode, source view: guessed argument-list closures by call or tail id. */
  readonly likely_arity?: ReadonlyMap<string, LikelyArity>;
  /** Likely mode, source view: guessed pointer formals and result of the selected function. */
  readonly likely_types?: LikelyTypes;
  /** Source-only actual types from an established variadic library rule over
   * every possible rule-argument value: immutable printf-family format
   * literals, or Darwin `open` flags that all set `O_CREAT`. */
  readonly call_argument_signatures?: ReadonlyMap<string, AbiSignature>;
  /** Bounded native parameter-associated shape constraints over original values. */
  readonly memory_transfers?: readonly MemoryShapeTransfer[];
  /** Positive caller consumption gathered from available native units. This is
   * not an exhaustive caller scan; absence is never proof of non-consumption. */
  readonly function_return_demands?: readonly RegisterDescriptor[];
  /** Source view: positive caller result-use evidence from a bounded scan of the
   * image's direct call sites, computed only when the planner asks (a void-like
   * `incidental_result` interface, or a tail whose callee has no result types).
   * Charged to `context`; undefined when the scan abstains or finds no caller
   * that reads a result register. Never evidence of non-consumption. */
  readonly caller_result_demands?: (context: OperationContext) => CallerResultDemand | undefined;
  /** Source view: closed-world caller consensus (premise `caller_consensus`): the
   * function is not exported, no fixup targets its entry, no instruction
   * materializes it, every direct transfer to it is enumerated, and after each one
   * the integer result register (and the FP one when `floating`) is overwritten
   * before any read, or reaches only the returns of callers with the same
   * consensus. Computed only when the planner asks; `candidate` (the planner's
   * test whether the result may be incidental on every exit path) runs after the
   * free checks (an exported entry abstains first) and before any caller is
   * swept; charged to `context`; undefined when any step abstains. */
  readonly function_result_use?: (
    context: OperationContext,
    floating: boolean,
    candidate: () => boolean,
  ) => FunctionResultUse | undefined;
  /** Actual proven written result storage, not an inferred author aggregate. */
  readonly function_returns?: {
    readonly registers: readonly RegisterDescriptor[];
    readonly types: readonly DataType[];
  };
  readonly objc?: ObjCSourceFacts;
}
/** Result registers that a caller reads after a direct call returns, before
 * writing them: positive evidence that the function has a result. */
export interface CallerResultDemand {
  readonly registers: readonly RegisterDescriptor[];
  /** The call instructions whose callers read `registers`. */
  readonly sites: readonly Address[];
}
/** Every direct transfer to the function in the closed image ignores its result. */
export interface FunctionResultUse {
  readonly consensus: 'ignored';
  /** The function's direct call and tail sites. */
  readonly sites: readonly Address[];
}
/** Objective-C message form of a call whose selector is statically resolved.
 * `send`: projected arguments are (receiver, selector, keyword arguments...);
 * `stub`: an `__objc_stubs` call, (receiver, keyword arguments...);
 * `runtime`: a libobjc entry point equivalent to a message, (receiver,
 * keyword arguments...), with `inner` naming a nested message (`objc_alloc_init`
 * is `[[cls alloc] init]`). Keyword argument count is the selector's colon
 * count; `variadic` marks a known trailing C variadic list. */
export interface ObjCMessage {
  readonly selector: string;
  readonly form: 'send' | 'stub' | 'runtime';
  readonly inner?: string;
  readonly variadic: boolean;
}
export interface ObjCSourceFacts {
  readonly messages: ReadonlyMap<string, ObjCMessage>;
  /** Method record(s) whose implementation is the selected function. */
  readonly method?: {
    readonly owner: string;
    readonly selector: string;
    readonly kind: 'instance' | 'class';
  };
}
export interface SourceLocal {
  readonly id: string;
  readonly type: DataType;
  /** Source-only stable location name; not an authored variable identity. */
  readonly stack_offset?: bigint;
}
/** An entry-backed view shares original stack bytes across every region. Its
 * bounds describe observed affine accesses, not a proven dynamic allocation.
 * Source view: `object` is this activation's frame kept as memory, printed as
 * one local object of `size` bytes ending at entry-SP offset
 * `minimum_offset + size` (the entry SP, or below it where only hidden saves
 * and independent members follow); `minimum_offset` is its entry-SP offset.
 * Its `entry` is the live entry SP when addresses at or
 * above the entry SP (incoming arguments, the return address, the caller's
 * frame) remain: those keep the `entry_sp + k` form beside the object. */
export type SourceStackStorage = {
  readonly minimum_offset: bigint;
  readonly size: bigint;
  readonly alignment: number;
} & (
  | { readonly kind: 'private' }
  | { readonly kind: 'entry'; readonly base: Value; readonly dynamic: boolean }
  | {
      readonly kind: 'object';
      readonly id: string;
      readonly members: readonly FrameMember[];
      readonly entry: Value | null;
    }
);
/** The entry-SP input a source frame prints addresses from: the base of
 * entry-backed storage, or the live entry SP beside a frame object. */
export function stackEntry(stack: SourceStackStorage | null | undefined): Value | null {
  return stack?.kind === 'entry' ? stack.base : stack?.kind === 'object' ? stack.entry : null;
}
/** Source view: the function's anonymous arguments follow its named formals
 * (`...`).
 * - `area` (Darwin arm64, Win64; S6): `area` is a source-only value holding
 *   `va_start`'s result, the address of the first anonymous argument; it
 *   prints as `va` (`va_list`, `char *` on these ABIs) after a `va_list va;
 *   va_start(va, <last named>);` prologue, and replaces the entry SP as the
 *   base of every address at or above it: entry-SP offset `k` prints as
 *   `(uintptr_t)va + (k - offset)`.
 * - `va_list` (SysV AMD64; S7): the 24-byte `va_list` the code `va_start`
 *   lowers to initializes is the frame-object member `va` at entry-SP
 *   `offset` (fields `va[0].gp_offset`, `fp_offset`, `overflow_arg_area`,
 *   `reg_save_area`); its initializing stores and the register save area
 *   stores are hidden, `va_start(frame.va, <last named>);` prints where the
 *   last of them was (`anchor`), and the `al` guard `if` around the vector
 *   register stores (`guard`) prints nothing and is no liveness root. */
export type SourceVariadic =
  | {
      readonly kind: 'area';
      readonly area: Value;
      /** Entry-SP offset of the first anonymous argument. */
      readonly offset: bigint;
    }
  | {
      readonly kind: 'va_list';
      /** Entry-SP offset of the `va_list` frame member. */
      readonly offset: bigint;
      /** The last hidden `va_start` store: `va_start` prints in its place. */
      readonly anchor: string;
      /** Control id of the dropped `al != 0` guard, or null. */
      readonly guard: string | null;
    };
/** The source-only `va` value of an `area` interface (S6), else null. */
export function variadicArea(variadic: SourceVariadic | undefined): Value | null {
  return variadic?.kind === 'area' ? variadic.area : null;
}
/** The register outputs of a call or unknown effect as the source view prints
 * them: `register_outputs` may replace the cells of a root with one whole. */
export function registerOutputs(
  source: SourcePresentation | undefined,
  node: { readonly id: string; readonly register_outputs: readonly RegisterBinding[] },
): readonly RegisterBinding[] {
  return source?.register_outputs?.get(node.id) ?? node.register_outputs;
}
/** One named member of a frame object, in entry-SP coordinates. Bytes between
 * members are padding; every byte stays ordinary, aliasable memory. */
export interface FrameMember {
  readonly offset: bigint;
  readonly size: bigint;
  /** Every access to these bytes reads or writes exactly them: a scalar member
   * (accesses wider than it, covering whole members, are casts at the member
   * holding their first byte). Otherwise (partially overlapping accesses, an
   * interior or indexed address, padding under a wider access) a byte array. */
  readonly scalar: boolean;
  /** The known-offset frame accesses inside these bytes (a scalar member lists
   * those of exactly its bytes, not the wider accesses spanning it). */
  readonly access_ids: readonly string[];
  /** SysV `va_list` (S7): the 24-byte member `va`; every access inside it is
   * exactly one of its fields. */
  readonly va?: true;
  /** Source view (A3): the member is an object of its own (entity `id`),
   * declared and addressed outside the frame object: exactly the bytes every
   * escape reaching it can designate, bounded by a proven save slot or the
   * entry SP; no access crosses its bounds and no escaped or indexed address
   * lies inside it except at its start. */
  readonly independent?: { readonly id: string };
}
/** Source view (S4): the incoming stack-argument bytes this activation keeps
 * as memory (a by-value aggregate modified in place), printed as one struct
 * formal of `size` bytes starting at entry-SP `minimum_offset` (the first
 * incoming byte). Members are in entry-SP coordinates; bytes between them are
 * padding, and every byte stays ordinary, aliasable memory. The formal's IR
 * type is a pointer-width carrier only; its spelling is the struct. */
export interface IncomingObject {
  readonly formal: Value;
  readonly id: string;
  readonly minimum_offset: bigint;
  readonly size: bigint;
  readonly members: readonly FrameMember[];
}
/** Complete source interpretation of an unchanged machine-width value. */
export interface SourceTypeView {
  readonly type_id: string;
  /** Likely mode: this view is a guess (`caller_argument_pointer`), not a proven projection. */
  readonly likely?: true;
  readonly association_ids: readonly string[];
  readonly subject_ids: readonly string[];
  readonly evidence_ids: readonly string[];
}
export interface FrameSaves {
  /** Store statements saving an entry register value into a frame-private slot. */
  readonly stores: ReadonlySet<string>;
  /** Load statements restoring that exact slot. */
  readonly reloads: ReadonlySet<string>;
  /** Saved bytes in entry-SP coordinates, excluded from possible stack arguments. */
  readonly bytes: ReadonlySet<bigint>;
}
/** Inferred source-only signature spelling, never a machine-storage mutation. */
export type SourceFormalType =
  | { readonly kind: 'integer'; readonly bits: number; readonly signed: boolean }
  | {
      readonly kind: 'pointer';
      readonly bits: number;
      /** Element kind of every observed access through the formal. */
      readonly pointee: 'integer' | 'float';
      readonly pointee_bits: number;
      readonly const: boolean;
    };

/** Syntax-neutral source storage and interface information. All original SSA
 * identities and effects remain in the analyzed graph and source mappings. */
export interface SourcePresentation {
  readonly inferred: boolean;
  readonly parameter_names: ReadonlyMap<string, string>;
  readonly return_type: DataType | null;
  /** Multiple observed result words are a typed tuple, never an invented SIMD/source struct. */
  readonly return_types?: readonly DataType[];
  /** Source pointer interpretation, separate from the machine result bit width. */
  readonly return_pointer?: 'char' | 'byte';
  readonly value_types?: ReadonlyMap<string, SourceTypeView>;
  readonly return_source_type?: string;
  /** Likely mode: guessed formal and result types (see `LikelyTypePresentation`). */
  readonly likely_types?: LikelyTypePresentation;
  /** Inferred formal spellings; reloads of a typed promoted slot share its type. */
  readonly formal_types?: ReadonlyMap<string, SourceFormalType>;
  /** Inferred incoming-stack formals by the callee-entry SP offset of their ABI slot. */
  readonly formal_stack_offsets?: ReadonlyMap<string, bigint>;
  /** Source view (S9): the formal of a declared hidden result (sret) pointer,
   * the first formal; the declaration's own parameters follow it. It points
   * to the declared result type, and the function returns that pointer where
   * its ABI does (SysV, Win64), otherwise nothing. */
  readonly hidden_result?: Value;
  /** Promoted slot (local id) spellings proven by `slot_pointer_type`. */
  readonly local_types?: ReadonlyMap<string, SourceFormalType>;
  readonly return_scalar?: { readonly bits: number; readonly signed: boolean };
  /** IEEE values and closed whole-bit carriers approved for native FP spelling. */
  readonly float_values?: ReadonlyMap<string, 32 | 64>;
  readonly return_float?: 32 | 64;
  /** Load/store node ids proven by `fp_memory_access`: the access reads or
   * writes its `float_values` member through a native float/double lvalue. */
  readonly float_accesses?: ReadonlySet<string>;
  /** Promoted slot locals (by local id) approved by `fp_slot_type`: declared
   * float/double, every stored and reloaded value a `float_values` member. */
  readonly float_locals?: ReadonlyMap<string, 32 | 64>;
  /** Source view only: the primary-result rule rejected the native written-result
   * storage, which then no longer counts as result evidence for exit overlays. */
  readonly observed_result_rejected?: true;
  /** Source view only: caller result-use demand the planner fetched
   * (`caller_result_demands`); counts like `function_return_demands`. */
  readonly caller_result_demands?: readonly RegisterDescriptor[];
  /** Source view only: the rule that made the interface void-like.
   * `incidental_result`: the integer result register is established on no exit
   * path and the FP carrier is unchanged or undefined on every exit;
   * `indirect_result`: the function returns through its incoming indirect
   * result location; `caller_consensus`: no caller in the closed image observes
   * a result register (`function_result_use`). Computed primary exit slices are
   * then ABI scratch, kept in exit metadata. */
  readonly void_like_result?: 'incidental_result' | 'indirect_result' | 'caller_consensus';
  readonly field_subjects?: ReadonlyMap<string, readonly string[]>;
  /** Localized preconditions and residual sites; never a blanket CFG assumption. */
  readonly requirements?: readonly Requirement[];
  /** Calls whose callee summary is an FP environment writer
   * (`InferredCallee.fp_environment_writer`): their caller keeps its guards. */
  readonly fp_environment_writers?: ReadonlySet<string>;
  readonly locals: ReadonlyMap<string, SourceLocal>;
  readonly stack: SourceStackStorage | null;
  /** Source view (S4): the incoming object, when its struct formal is presented. */
  readonly incoming_object?: IncomingObject | null;
  readonly stack_addresses: ReadonlyMap<string, bigint>;
  /** Source view only: frame-private save/restore traffic of preserved registers
   * and the frame record, hidden under an `abi_conformance` requirement. */
  readonly frame_saves?: FrameSaves;
  readonly addresses: readonly SourceAddress[];
  /** Whole source-call results may be assembled from multiple SSA register cells. */
  readonly call_results?: ReadonlyMap<string, readonly Value[]>;
  /** Synthetic display values map back to catalogued, original SSA contributors. */
  readonly value_origins?: ReadonlyMap<string, readonly string[]>;
  /** A stored value -> its forwarded stack reloads that read exactly its bits (an
   * O0 argument spill reloaded for a call): their type evidence is the value's. */
  readonly forwarded_reloads?: ReadonlyMap<string, readonly string[]>;
  /** Ordered pure definitions after an original node; control anchors emit before control. */
  readonly definitions?: ReadonlyMap<string, readonly Extract<Instruction, { kind: 'assign' }>[]>;
  /** Source view (E3): by call or unknown-effect id, its register outputs when
   * one whole output replaces the cells of a root it writes (each cell is then
   * a slice of that whole); other nodes keep their own `register_outputs`. */
  readonly register_outputs?: ReadonlyMap<string, readonly RegisterBinding[]>;
  /** Source view only: the callee-side variadic interface (`va_start`). */
  readonly variadic?: SourceVariadic;
}
