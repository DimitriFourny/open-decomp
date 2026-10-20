import type {
  AbiProfile,
  AbiSignature,
  Address,
  Diagnostic,
  Evidence,
  RegisterDescriptor,
} from '../core/index.js';
import type { DataType, Instruction, Value } from '../ir/index.js';
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
  /** Explicit optional-dependency limitations; never substitutes a zero interface. */
  readonly diagnostics?: readonly Diagnostic[];
  readonly evidence?: readonly Evidence[];
  /** Proven complete actual counts for contextual variadic calls (`open`
   * flags that take no mode on every possible value). */
  readonly call_argument_counts?: ReadonlyMap<string, number>;
  /** Likely mode, source view: guessed argument-list closures by call or tail id. */
  readonly likely_arity?: ReadonlyMap<string, LikelyArity>;
  /** Source-only actual types from an established variadic library rule over
   * every possible rule-argument value: immutable printf-family format
   * literals, or Darwin `open` flags that all set `O_CREAT`. */
  readonly call_argument_signatures?: ReadonlyMap<string, AbiSignature>;
  /** Bounded native parameter-associated shape constraints over original values. */
  readonly memory_transfers?: readonly MemoryShapeTransfer[];
  /** Positive caller consumption gathered from available native units. This is
   * not an exhaustive caller scan; absence is never proof of non-consumption. */
  readonly function_return_demands?: readonly RegisterDescriptor[];
  /** Actual proven written result storage, not an inferred author aggregate. */
  readonly function_returns?: {
    readonly registers: readonly RegisterDescriptor[];
    readonly types: readonly DataType[];
  };
  readonly objc?: ObjCSourceFacts;
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
 * bounds describe observed affine accesses, not a proven dynamic allocation. */
export type SourceStackStorage = {
  readonly minimum_offset: bigint;
  readonly size: bigint;
  readonly alignment: number;
} & (
  | { readonly kind: 'private' }
  | { readonly kind: 'entry'; readonly base: Value; readonly dynamic: boolean }
);
/** Complete source interpretation of an unchanged machine-width value. */
export interface SourceTypeView {
  readonly type_id: string;
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
  /** Inferred formal spellings; reloads of a typed promoted slot share its type. */
  readonly formal_types?: ReadonlyMap<string, SourceFormalType>;
  /** Inferred incoming-stack formals by the callee-entry SP offset of their ABI slot. */
  readonly formal_stack_offsets?: ReadonlyMap<string, bigint>;
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
  /** Source view only: the rule that made the interface void-like.
   * `incidental_result`: the integer result register is established on no exit
   * path and the FP carrier is unchanged or undefined on every exit;
   * `indirect_result`: the function returns through its incoming indirect
   * result location. Computed primary exit slices are then ABI scratch, kept
   * in exit metadata. */
  readonly void_like_result?: 'incidental_result' | 'indirect_result';
  readonly field_subjects?: ReadonlyMap<string, readonly string[]>;
  /** Localized preconditions and residual sites; never a blanket CFG assumption. */
  readonly requirements?: readonly Requirement[];
  readonly locals: ReadonlyMap<string, SourceLocal>;
  readonly stack: SourceStackStorage | null;
  readonly stack_addresses: ReadonlyMap<string, bigint>;
  /** Source view only: frame-private save/restore traffic of preserved registers
   * and the frame record, hidden under an `abi_conformance` requirement. */
  readonly frame_saves?: FrameSaves;
  readonly addresses: readonly SourceAddress[];
  /** Whole source-call results may be assembled from multiple SSA register cells. */
  readonly call_results?: ReadonlyMap<string, readonly Value[]>;
  /** Synthetic display values map back to catalogued, original SSA contributors. */
  readonly value_origins?: ReadonlyMap<string, readonly string[]>;
  /** Ordered pure definitions after an original node; control anchors emit before control. */
  readonly definitions?: ReadonlyMap<string, readonly Extract<Instruction, { kind: 'assign' }>[]>;
}
