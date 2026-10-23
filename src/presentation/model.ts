import type { Diagnostic, EntityId } from '../core/index.js';
import type {
  DataType,
  Effect,
  Instruction,
  JumpTableOrigin,
  Origin,
  RegisterBinding,
  Terminator,
  SSAForm,
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
  /** Source view only: this arm of a short-circuit head owns a body that the
   * `joins` arms of the operand chain in its other arm enter as well; the
   * head prints as `if (stay && …) {…} else {body}` (`all`) or
   * `if (exit || …) {body} else {…}` (`any`). */
  readonly shared?: 'all' | 'any';
  /** Source view only: a bodiless operand edge entering the `shared` arm body
   * of the head whose operand chain holds this test. */
  readonly joins?: true;
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
      readonly jump_table?: JumpTableOrigin;
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
 * structurer). Absent means generic `while (true)` with explicit transfers.
 * A single-test form's exit edge may carry copies only when it is the sole
 * edge from inside the loop to its continuation; they print after the loop. */
export type LoopForm =
  /** Header block prints nothing but its test, or one statement that test holds
   * (printed inside it); its `if` is the loop test and the
   * exit arm is the loop's lexical break. `enter` is the arm value staying inside. */
  | {
      readonly kind: 'while';
      readonly test: EntityId;
      readonly enter: boolean;
      /** Ordered header-to-break tests sharing one continuation. */
      readonly chain?: readonly {
        readonly block: EntityId;
        readonly test: EntityId;
        readonly enter: boolean;
      }[];
    }
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
  /** Laid out without the goto search (`StructuringOptions.search` false): the
   * source view structures it again once block contents are known. */
  readonly provisional?: true;
}
export interface StructuringOptions {
  readonly max_work?: number;
  /** Maximum nesting, 1..64. Deeper shapes retain explicit labeled transfers. */
  readonly max_depth?: number;
  /** False skips the goto-selection search: when no rule applies, nodes are
   * laid out in dependency order. Loops, their follows and bodies, and block
   * ownership are unchanged (the source view structures again; see
   * StructuringConditions). */
  readonly search?: boolean;
  /** Work this structuring may have charged while the goto-selection search still
   * runs; past it, as past the selection allowance, the remaining nodes of a stuck
   * scope are laid out in dependency order. The source view's restructure passes the
   * request's remaining work less the text render's reserve. Unbounded when absent. */
  readonly search_work?: number;
  /** Block contents known after reconstruction (source view): short-circuit
   * conditions collapse first, Ghidra's `collapseConditions`. */
  readonly conditions?: StructuringConditions;
  /** The transfer object of edge (block, slot) of an earlier structuring of the
   * same graph, kept so maps keyed by transfer stay valid. Loop scopes (hence
   * break/continue modes) are the same in every structuring; `goto` and `next`
   * differ only in a checked-view label, and only the source view passes this. */
  readonly transfers?: (block: EntityId, slot: number) => ParallelTransfer | undefined;
}
/** What blocks print, from reconstruction and source planning. */
export interface StructuringConditions {
  /** The block may be a non-head short-circuit operand: a branch printing
   * nothing or exactly one statement its test can hold (`(x = f(), x != 0)`),
   * or a jump printing nothing that leads to one. */
  readonly operand: (block: EntityId) => boolean;
  /** Edge copies the edge (block, slot) prints; operand edges print none. */
  readonly copies: (block: EntityId, slot: number) => number;
  /** The edge (block, slot) prints only constants its target, a return block,
   * returns: an owned copy of that tail on the edge prints `return k` and no
   * copy, so such a branch edge into a small tail with other entries is
   * labeled before any collapse (the source view copies the tail onto it). */
  readonly returnsConstants: (block: EntityId, slot: number) => boolean;
}
/** The control-flow graph structuring reads (an SSA function, or the blocks of
 * a structured one; see structuredGraph). */
export type StructuringInput = Pick<
  SSAForm,
  'id' | 'provenance' | 'entry' | 'returns' | 'blocks' | 'register_states'
>;
export type StructuringResult =
  | {
      readonly state: 'complete';
      readonly value: StructuredFunction;
      readonly diagnostics: readonly Diagnostic[];
      readonly work: number;
      /** Head blocks of the short-circuit conditions collapsed first (see
       * StructuringConditions). */
      readonly conditions: readonly EntityId[];
      /** Branch blocks whose constant-return edges were labeled first (see
       * StructuringConditions.returnsConstants). */
      readonly tails: readonly EntityId[];
    }
  | {
      readonly state: 'partial';
      readonly value: null;
      readonly diagnostics: readonly Diagnostic[];
      readonly work: number;
    };
