import type { Diagnostic, EntityId } from '../core/index.js';
import type {
  DataType,
  Effect,
  Instruction,
  Origin,
  RegisterBinding,
  Terminator,
  Value,
} from '../ir/index.js';

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
  | (Origin & {
      readonly kind: 'jump';
      readonly effect: Effect;
      readonly transfer: ParallelTransfer;
    })
  | (Origin & {
      readonly kind: 'if';
      readonly effect: Effect;
      readonly condition: Value;
      readonly when_true: ControlArm;
      readonly when_false: ControlArm;
    })
  | (Origin & {
      readonly kind: 'switch';
      readonly effect: Effect;
      readonly value: Value;
      readonly cases: readonly { readonly bits: bigint; readonly arm: ControlArm }[];
      readonly otherwise: ControlArm;
    })
  | Extract<Terminator, { readonly kind: 'return' | 'indirect' | 'trap' | 'unknown' }>;
export interface BlockRegion extends Origin {
  readonly kind: 'block';
  /** The stable SSA block identity is also its explicit presentation label. */
  readonly parameters: readonly Value[];
  readonly effect_parameter: Effect;
  /** Immediate SSA dominator, null at roots. Values it dominates are visible here. */
  readonly dominator: EntityId | null;
  /** Cells merged/rebound at entry (every cell at roots). Others inherit the
   * dominator's exit state; see registerStateAt. */
  readonly register_entry: readonly RegisterBinding[];
  /** Every cell at function exits; elsewhere only cells rebound in this block. */
  readonly register_exit: readonly RegisterBinding[];
  readonly statements: readonly Instruction[];
  readonly control: Control;
}
export interface SequenceRegion {
  readonly kind: 'sequence';
  readonly regions: readonly Region[];
}
/** Source-view syntax of a loop, chosen after reconstruction (never by the
 * structurer). Absent means generic `while (true)` with explicit transfers. */
export type LoopForm =
  /** Header block has no printed statements; its `if` is the loop test and the
   * exit arm is the loop's lexical break. `enter` is the arm value staying inside. */
  | { readonly kind: 'while'; readonly test: EntityId; readonly enter: boolean }
  /** The lexically last block's `if` is the test; its repeat arm is the only
   * edge to the header and its copies run before the test. Only `test` may continue. */
  | {
      readonly kind: 'do_while';
      readonly test: EntityId;
      readonly repeat: boolean;
    }
  /** A `while` (`bottom: false`) or a guarded `do_while` (`bottom: true`) whose
   * single entry edge and single repeat edge only initialize and step induction
   * variables: those copies print in the `for` header. `enter` is the arm value
   * staying inside. A bottom test's first evaluation is proven true on entry. */
  | {
      readonly kind: 'for';
      readonly test: EntityId;
      readonly enter: boolean;
      readonly bottom: boolean;
    };
export interface LoopRegion {
  readonly kind: 'loop';
  /** Stable header identity, not an invented statement identity. */
  readonly header: EntityId;
  /** Generic single-entry loop: condition evaluation and effects stay in body. */
  readonly body: Region;
  readonly form?: LoopForm;
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
export type StructuringResult =
  | {
      readonly state: 'complete';
      readonly value: StructuredFunction;
      readonly diagnostics: readonly Diagnostic[];
      readonly work: number;
    }
  | {
      readonly state: 'partial';
      readonly value: null;
      readonly diagnostics: readonly Diagnostic[];
      readonly work: number;
    };
