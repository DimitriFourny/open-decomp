import type {
  Address,
  Annotation,
  Diagnostic,
  Evidence,
  RecoveredType,
  Signature,
} from '../../core/index.js';
import type { DataType } from '../../ir/index.js';
import type { DebugRecovery } from '../../metadata/debug/index.js';
import type { LibraryContracts } from '../../metadata/library-contracts/index.js';
import type {
  CallAnalysisOptions,
  CallAnalysisResult,
  ContractObservation,
} from '../calls/index.js';

export type TypeSource = 'analysis' | 'debug' | 'library' | 'user' | 'llm';
export type TypeStatus = 'candidate' | 'established' | 'asserted' | 'hypothesis' | 'conflicting';
export interface SuppliedTypeRecord {
  readonly id: string;
  readonly definition: RecoveredType;
  readonly source: TypeSource;
  readonly status: TypeStatus;
  readonly evidence_ids: readonly string[];
}
/** Exact semantic IDs only. Names, register spellings and demangled text are not keys. */
export interface TypeBinding {
  readonly subject_id: string;
  readonly type_id: string;
  readonly source: TypeSource;
  readonly status: TypeStatus;
  readonly evidence_ids: readonly string[];
}
export interface SuppliedSignature {
  readonly id: string;
  /** Function SSA ID or exact call node ID. */
  readonly subject_id: string;
  readonly signature: Signature;
  readonly source: TypeSource;
  readonly status: TypeStatus;
  readonly evidence_ids: readonly string[];
}
export interface TypeAssociation extends TypeBinding {
  readonly id: string;
  /** Null for storage, fields and declarations; never rewrites an IR value type. */
  readonly machine_type: DataType | null;
  /** A physical ABI/register fragment is not the entire declared source object. */
  readonly value_offset_bits: number;
  /** Start of the known fragment within machine_type; independent of source offset. */
  readonly machine_offset_bits: number;
  readonly width_bits: number | null;
}
export interface SignatureAssociation extends SuppliedSignature {
  readonly abi_state: 'complete' | 'partial' | 'unsupported';
  /** Machine requirements also survive declarations scoped to one call node. */
  readonly implicit_register_inputs: ContractObservation['implicit_register_inputs'];
}
export interface ObservedField {
  readonly id: string;
  /** Signed displacement from the original base, not a guessed object start. */
  readonly offset: bigint;
  readonly width_bits: number;
  readonly node_ids: readonly string[];
  /** Stable original field identities contributing to this caller-relative view. */
  readonly origin_ids?: readonly string[];
  readonly value_ids: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly access: readonly ('read' | 'write')[];
  readonly stack_region: string | null;
  /** Non-null only for a syntactically established scaled index. Count is unknown. */
  readonly stride: bigint | null;
  /** Dynamic index evidence without a single representable stride. In this
   * case a null stride does not establish a constant-displacement access. */
  readonly dynamic?: boolean;
  /** Exact calls whose indirect target was read from this field. No prototype
   * or complete argument count is implied by observing a callable address. */
  readonly call_target_ids?: readonly string[];
  /** Accesses whose address is exactly `base + offset + k * stride` for one
   * same-loop counter value `k`; the element count remains unknown. */
  readonly indices?: readonly { readonly node_id: string; readonly value_id: string }[];
}
export interface MemoryShape {
  readonly id: string;
  readonly base: { readonly kind: 'value'; readonly value_id: string } | { readonly kind: 'stack' };
  readonly type_id: string;
  /** Relative origin of the incomplete structure view; not a complete object boundary. */
  readonly base_offset: bigint;
  /** Constant-displacement accesses only; dynamic indices establish no extent. */
  readonly observed_extent: { readonly start: bigint; readonly end: bigint } | null;
  readonly fields: readonly ObservedField[];
  readonly alias: 'possible' | 'observed';
  readonly escape: 'unknown' | 'observed';
  readonly dynamic: boolean;
  readonly evidence_ids: readonly string[];
}
export interface TypeConflict {
  readonly subject_id: string;
  readonly alternatives: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly reason:
    'incompatible_types' | 'incompatible_signatures' | 'overlapping_accesses' | 'layout_mismatch';
}
export interface TypeRecoveryOptions extends CallAnalysisOptions {
  readonly slice_id: string;
  readonly image_id: string;
  readonly revision: number;
  /** Debug matching is exact and requires a VA in this image. */
  readonly entry_address?: Address;
  readonly debug?: DebugRecovery;
  readonly library?: LibraryContracts;
  readonly annotations?: readonly Annotation[];
  readonly types?: readonly SuppliedTypeRecord[];
  readonly bindings?: readonly TypeBinding[];
  readonly signatures?: readonly SuppliedSignature[];
}
export interface TypeRecoveryResult {
  readonly state: 'complete' | 'partial';
  readonly work: number;
  /** Exact eligible annotation subjects, including currently untyped SSA values. */
  readonly subjects: readonly string[];
  readonly types: readonly SuppliedTypeRecord[];
  readonly associations: readonly TypeAssociation[];
  readonly signatures: readonly SignatureAssociation[];
  readonly shapes: readonly MemoryShape[];
  readonly conflicts: readonly TypeConflict[];
  readonly evidence: readonly Evidence[];
  readonly diagnostics: readonly Diagnostic[];
  /** Null if preparation exhausted its budget before physical ABI analysis. */
  readonly calls: CallAnalysisResult | null;
}
