import type { Address, Diagnostic, PresentationView, RegisterDescriptor } from '../core/index.js';
import type { SignatureAssociation, MemoryShape, ObservedField } from '../analysis/types/model.js';
import type { DataType, Expression, Instruction, Origin, Value } from '../ir/index.js';
import type { BlockRegion, ParallelTransfer, StructuredFunction } from '../presentation/index.js';
import type { SourcePresentation } from './source-model.js';
import type { LocalValidationRecord, LocalValidationSession } from './local-validation.js';

/** A source projection exists only when every physical location is an exact,
 * compatible whole value. Physical boundaries otherwise remain explicit. */
export interface BoundaryProjection {
  readonly kind: 'source' | 'inferred' | 'physical';
  readonly signature: SignatureAssociation | null;
  readonly arguments: readonly Value[];
  /** False preserves a known prefix without claiming that trailing source arguments are absent. */
  readonly argument_list_complete?: boolean;
  readonly results: readonly Value[];
  readonly inputs: readonly { readonly register: RegisterDescriptor; readonly value: Value }[];
  readonly outputs: readonly { readonly register: RegisterDescriptor; readonly value: Value }[];
  /** Source view only: possible-return slices not established as results.
   * They are not liveness roots and are rendered out of line, but their exact
   * values and provenance remain available here and in the checked view. */
  readonly exit_scratch?: readonly ExitScratchSlice[];
}
export interface ExitScratchSlice {
  readonly register: RegisterDescriptor;
  readonly value: Value;
  /** Reaching clobbering call statements, or the exact computed value identity. */
  readonly sources: readonly string[];
  /** True when the untouched entry value may also reach this exit slice. */
  readonly entry: boolean;
  /** Locally computed value, moved under an explicit ABI/result-use assumption. */
  readonly computed?: true;
}
/** Terminal call: results belong to the callee, not invented caller SSA cells. */
export interface TailProjection {
  readonly target: Address;
  readonly boundary: BoundaryProjection;
  readonly result_types: readonly DataType[];
}
export interface MemoryView {
  readonly shape: MemoryShape;
  readonly field: ObservedField;
  /** A view of the original memory operation, never a new scalar storage cell. */
  readonly scalar: false;
}
export interface Reconstruction {
  readonly function: StructuredFunction;
  readonly view: PresentationView;
  readonly source?: SourcePresentation;
  readonly blocks: ReadonlyMap<string, BlockRegion>;
  readonly values: ReadonlyMap<string, Value>;
  /** Rewritten pure definitions. Operand identities remain original SSA IDs. */
  readonly expressions: ReadonlyMap<string, Expression>;
  /** Values whose definitions may be expanded by the renderer; bounded depth/size. */
  readonly inline: ReadonlySet<string>;
  readonly live: ReadonlySet<string>;
  /** Liveness demand count per live value: roots, live expression operands and live phi sources. */
  readonly use_counts: ReadonlyMap<string, number>;
  readonly retained: ReadonlySet<string>;
  /** Keyed by original transfer object, preserving simultaneous assignment. */
  readonly transfers: ReadonlyMap<
    ParallelTransfer,
    readonly { readonly destination: Value; readonly source: Value }[]
  >;
  /** Keyed by consuming statement/control ID; includes hidden contributors. */
  readonly origins: ReadonlyMap<string, readonly Origin[]>;
  readonly parameters: readonly Value[];
  readonly parameter_registers: ReadonlyMap<string, RegisterDescriptor>;
  readonly signature: SignatureAssociation | null;
  readonly calls: ReadonlyMap<string, BoundaryProjection>;
  readonly returns: ReadonlyMap<string, BoundaryProjection>;
  readonly tails: ReadonlyMap<string, TailProjection>;
  /** Complete physical snapshots encoded as overlays on immutable function-entry
   * state, not patches on the preceding boundary. Missing slices retain entry
   * bits, including at faults. Only proven unchanged slices are omitted. */
  readonly physical_inputs: ReadonlyMap<
    string,
    readonly { readonly register: RegisterDescriptor; readonly value: Value }[]
  >;
  readonly physical_exits: ReadonlyMap<
    string,
    readonly { readonly register: RegisterDescriptor; readonly value: Value }[]
  >;
  readonly memory: ReadonlyMap<string, MemoryView>;
  readonly local_validation?: readonly LocalValidationRecord[];
  readonly local_validation_session?: LocalValidationSession;
  readonly diagnostics: readonly Diagnostic[];
}
export type Assignment = Extract<Instruction, { readonly kind: 'assign' }>;
