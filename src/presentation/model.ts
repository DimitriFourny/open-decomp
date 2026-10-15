import type { Diagnostic, EntityId } from '../core/index.js';
import type { DataType, Effect, Instruction, Origin, RegisterBinding, Terminator, Value } from '../ir/index.js';

/** All sources are read before any destination is written, including the effect. */
export interface ParallelTransfer {
  readonly kind: 'transfer';
  readonly target: EntityId;
  readonly mode: 'goto' | 'next' | 'break' | 'continue';
  /** The loop exited/repeated; absent for ordinary labeled transfers. */
  readonly loop?: EntityId;
  readonly copies: readonly { readonly destination: Value; readonly source: Value }[];
  readonly effect: { readonly destination: Effect; readonly source: Effect };
}
export interface ControlArm {
  readonly transfer: ParallelTransfer;
  /** Owned region entered after the simultaneous transfer; never an implicit copy. */
  readonly body?: Region;
}
export type Control =
  | (Origin & { readonly kind: 'jump'; readonly effect: Effect; readonly transfer: ParallelTransfer })
  | (Origin & { readonly kind: 'if'; readonly effect: Effect; readonly condition: Value; readonly when_true: ControlArm; readonly when_false: ControlArm })
  | (Origin & { readonly kind: 'switch'; readonly effect: Effect; readonly value: Value; readonly cases: readonly { readonly bits: bigint; readonly arm: ControlArm }[]; readonly otherwise: ControlArm })
  | Extract<Terminator, { readonly kind: 'return' | 'indirect' | 'trap' | 'unknown' }>;
export interface BlockRegion extends Origin {
  readonly kind: 'block';
  /** The stable SSA block identity is also its explicit presentation label. */
  readonly parameters: readonly Value[];
  readonly effect_parameter: Effect;
  readonly register_entry: readonly RegisterBinding[];
  readonly register_exit: readonly RegisterBinding[];
  readonly statements: readonly Instruction[];
  readonly control: Control;
}
export interface SequenceRegion {
  readonly kind: 'sequence';
  readonly regions: readonly Region[];
}
export interface LoopRegion {
  readonly kind: 'loop';
  /** Stable header identity, not an invented statement identity. */
  readonly header: EntityId;
  /** Generic single-entry loop: condition evaluation and effects stay in body. */
  readonly body: Region;
}
export type Region = BlockRegion | SequenceRegion | LoopRegion;
export interface StructuredFunction extends Origin {
  readonly kind: 'structured_function';
  readonly entry: EntityId;
  readonly returns: readonly DataType[];
  readonly body: Region;
  readonly coverage: readonly {
    readonly block_id: EntityId;
    readonly statement_ids: readonly EntityId[];
    readonly terminator_id: EntityId;
  }[];
}
export interface StructuringOptions {
  readonly max_work?: number;
  /** Maximum nesting, 1..64. Deeper shapes retain explicit labeled transfers. */
  readonly max_depth?: number;
}
export type StructuringResult = {
  readonly state: 'complete'; readonly value: StructuredFunction;
  readonly diagnostics: readonly Diagnostic[]; readonly work: number;
} | {
  readonly state: 'partial'; readonly value: null;
  readonly diagnostics: readonly Diagnostic[]; readonly work: number;
};
