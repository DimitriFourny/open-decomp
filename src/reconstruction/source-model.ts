import type {
  AbiProfile,
  Address,
  Diagnostic,
  Evidence,
  RegisterDescriptor,
} from '../core/index.js';
import type { DataType, Instruction, Value } from '../ir/index.js';
import type { MemoryShapeTransfer } from '../analysis/types/memory-shapes.js';
import type { Requirement } from '../core/inference.js';
import type { NativeContext } from '../service/analysis/native-context.js';

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
   * and no escaping incoming-stack address; the caller must still prove that it
   * prepares no possible stack argument. */
  readonly argument_list_closure?: 'callee_reads';
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
  /** Only immutable, terminated strings with exact image/address provenance. */
  readonly string?: string;
  readonly string_byte_length?: bigint;
  readonly string_encoding?: 'ascii' | 'utf8';
  /** The string begins at a section start or right after a NUL byte: it is not
   * the interior suffix of a neighbouring terminated string. */
  readonly string_start?: true;
  /** Byte storage identity; an unknown extent is never inferred from a use. */
  readonly object?: {
    readonly address: Address;
    readonly byte_length: bigint | null;
    readonly offset: bigint;
    readonly mutable: boolean;
    readonly kind: 'bytes' | 'jump_table' | 'literal_pool' | 'unknown';
    readonly evidence_ids: readonly string[];
  };
}
/** Facts supplied by the native analysis pipeline; never selected by host ABI. */
export interface SourceEvidence {
  readonly abi: AbiProfile;
  readonly callees: readonly InferredCallee[];
  readonly addresses: readonly SourceAddress[];
  /** Explicit optional-dependency limitations; never substitutes a zero interface. */
  readonly diagnostics?: readonly Diagnostic[];
  readonly evidence?: readonly Evidence[];
  /** Proven complete actual counts for contextual variadic calls. */
  readonly call_argument_counts?: ReadonlyMap<string, number>;
  /** Bounded native parameter-associated shape constraints over original values. */
  readonly memory_transfers?: readonly MemoryShapeTransfer[];
  /** Actual proven written result storage, not an inferred author aggregate. */
  readonly function_returns?: {
    readonly registers: readonly RegisterDescriptor[];
    readonly types: readonly DataType[];
  };
}
export interface SourceLocal {
  readonly id: string;
  readonly type: DataType;
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
