import type { AbiProfile, Address, RegisterDescriptor } from '../core/index.js';
import type { DataType, Instruction, Value } from '../ir/index.js';

/** Observed native callee inputs, not a user-supplied or proven source prototype. */
export interface InferredCallee {
  readonly call_id: string;
  readonly parameter_state?: 'observed' | 'ambiguous';
  readonly parameters: readonly RegisterDescriptor[];
  readonly returns: readonly RegisterDescriptor[];
  readonly evidence_ids: readonly string[];
}
export interface SourceAddress {
  readonly address: Address;
  readonly name?: string;
  /** Only immutable, terminated strings with exact image/address provenance. */
  readonly string?: string;
}
/** Facts supplied by the native analysis pipeline; never selected by host ABI. */
export interface SourceEvidence {
  readonly abi: AbiProfile;
  readonly callees: readonly InferredCallee[];
  readonly addresses: readonly SourceAddress[];
  /** Proven complete actual counts for contextual variadic calls. */
  readonly call_argument_counts?: ReadonlyMap<string, number>;
}
export interface SourceLocal {
  readonly id: string;
  readonly type: DataType;
}
/** Syntax-neutral source storage and interface information. All original SSA
 * identities and effects remain in the analyzed graph and source mappings. */
export interface SourcePresentation {
  readonly inferred: boolean;
  readonly parameter_names: ReadonlyMap<string, string>;
  readonly return_type: DataType | null;
  readonly locals: ReadonlyMap<string, SourceLocal>;
  readonly stack: { readonly minimum_offset: bigint; readonly size: bigint; readonly alignment: number } | null;
  readonly stack_addresses: ReadonlyMap<string, bigint>;
  readonly addresses: readonly SourceAddress[];
  /** Whole source-call results may be assembled from multiple SSA register cells. */
  readonly call_results?: ReadonlyMap<string, readonly Value[]>;
  /** Synthetic display values map back to catalogued, original SSA contributors. */
  readonly value_origins?: ReadonlyMap<string, readonly string[]>;
  /** Ordered pure definitions after an original node; control anchors emit before control. */
  readonly definitions?: ReadonlyMap<string, readonly Extract<Instruction, { kind: 'assign' }>[]>;
}
