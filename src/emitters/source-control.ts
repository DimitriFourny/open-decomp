import { fingerprint, type OperationContext } from '../core/index.js';
import { bitWidth, expressionOperands, type Instruction, type Value } from '../ir/index.js';
import type {
  BlockRegion,
  Control,
  ControlArm,
  LoopForm,
  ParallelTransfer,
  Region,
} from '../presentation/index.js';
import type { Reconstruction } from '../reconstruction/model.js';
import type { InlineSite } from './source-inlining.js';

/** `shared-arm`: a short-circuit operand edge entering its head's shared arm. */
export type TransferAction =
  'goto' | 'fallthrough' | 'break' | 'continue' | 'loop-exit' | 'shared-arm';
type Nest =
  | {
      readonly kind: 'loop';
      readonly header: string;
      readonly follow: string | null;
    }
  | { readonly kind: 'switch'; readonly id: string; readonly follow: string | null };

/** A presentation search ran out of its share of the remaining work. */
class OptionalWorkExhausted extends Error {}

/** Optional presentation searches never starve the rest of the run: they
 * charge the shared budget and stop at `1/share` of the work remaining. */
function optionalWork(context: OperationContext, share: number): OperationContext {
  const limit = Math.floor((context.remainingWork?.() ?? 0) / share);
  let used = 0;
  return {
    ...context,
    budget: { ...context.budget, work: limit },
    remainingWork: () => Math.max(0, limit - used),
    checkpoint(work) {
      context.checkpoint(work);
      used += work;
      if (used > limit) throw new OptionalWorkExhausted();
    },
  };
}

export function controlArms(control: Control): readonly ControlArm[] {
  return control.kind === 'if'
    ? [control.when_true, control.when_false]
    : control.kind === 'switch'
      ? [...control.cases.map((item) => item.arm), control.otherwise]
      : [];
}

function controlTransfers(control: Control): readonly ParallelTransfer[] {
  return control.kind === 'jump'
    ? [control.transfer]
    : controlArms(control).map((arm) => arm.transfer);
}

export function firstBlock(region: Region): string | null {
  for (;;) {
    if (region.kind === 'block') return region.id;
    if (region.kind === 'loop') return region.header;
    const first = region.regions[0];
    if (!first) return null;
    region = first;
  }
}

/** Lexical action of one transfer occurrence. `destination` is where control
 * goes when nothing is printed. In the source view any transfer that already
 * reaches its target lexically prints nothing (including a trailing continue
 * and a goto/break into an owned tail copy). The checked view keeps exactly the
 * original rules, where only source programs elide a goto to the follow.
 * `reaches(from, target)` tells whether control entering block `from` arrives
 * at `target` without printing anything (`from === target`, or `from` is a
 * block printing nothing that falls through to it); it decides every
 * comparison with a lexical follow. */
export function transferAction(
  transfer: ParallelTransfer,
  nesting: readonly Nest[],
  destination: string | null,
  language: 'c-like' | 'python-like',
  sourceView: boolean,
  sourceProgram = sourceView,
  normalizeLoopTargets = sourceView,
  reaches: (from: string | null, target: string) => boolean = exactly,
): TransferAction {
  if (sourceView && reaches(destination, transfer.target)) return 'fallthrough';
  if (sourceView && normalizeLoopTargets) {
    const loop = [...nesting].reverse().find((item) => item.kind === 'loop');
    if (loop?.kind === 'loop') {
      if (transfer.target === loop.header) return 'continue';
      if (
        reaches(loop.follow, transfer.target) &&
        (language === 'python-like' || nesting.at(-1)?.kind === 'loop')
      )
        return 'break';
    }
  }
  if (transfer.mode === 'next')
    return reaches(destination, transfer.target) ? 'fallthrough' : 'goto';
  if (transfer.mode === 'goto')
    return sourceProgram && reaches(destination, transfer.target) ? 'fallthrough' : 'goto';
  for (let i = nesting.length - 1; i >= 0; i--) {
    const item = nesting[i]!;
    if (item.kind !== 'loop') continue;
    if (transfer.loop !== item.header) return 'goto';
    // A loop may have several exits. Only its actual lexical successor can
    // use break; other destinations must keep their explicit labeled edge.
    if (transfer.mode === 'continue') return transfer.target === item.header ? 'continue' : 'goto';
    return reaches(item.follow, transfer.target) &&
      (language === 'python-like' || nesting[nesting.length - 1]?.kind === 'loop')
      ? 'break'
      : 'goto';
  }
  return 'goto';
}

function exactly(from: string | null, target: string): boolean {
  return from === target;
}

/** The arm of a loop-form test that the loop syntax itself performs. */
export function formArm(
  form: LoopForm,
  control: Control,
): { readonly arm: ControlArm; readonly action: 'break' | 'continue' }[] {
  const stage =
    form.kind === 'while' ? form.chain?.find((item) => item.test === control.id) : undefined;
  if (control.kind !== 'if' || (control.id !== form.test && !stage)) return [];
  const repeat = stage?.enter ?? (form.kind === 'do_while' ? form.repeat : form.enter);
  const again = repeat ? control.when_true : control.when_false,
    leave = repeat ? control.when_false : control.when_true;
  if (form.kind === 'while' || (form.kind === 'for' && !form.bottom))
    return [{ arm: leave, action: 'break' }];
  return [
    { arm: again, action: 'continue' },
    { arm: leave, action: 'break' },
  ];
}

/** Printed SSA variables of one reconstruction: which values are emitted as
 * named storage, where each is written and read, and block-entry liveness.
 * Reads mirror every renderer use site (see validate-uses.ts); extra reads only
 * make the derived facts more conservative. */
export class VariableLiveness {
  readonly index = new Map<string, number>();
  readonly values: Value[] = [];
  /** Live at block entry after its parameters are bound (includes used parameters). */
  private readonly entry = new Map<string, Uint32Array>();
  private readonly leafMemo = new Map<string, readonly number[]>();
  /** Rotated loop headers (rotateLoopCopies): phi id -> the pseudo value bound instead. */
  private readonly pseudo = new Map<string, Map<string, Value>>();
  private readonly words: number;
  readonly complete: boolean;

  constructor(
    private readonly program: Reconstruction,
    private readonly context: OperationContext,
    private readonly limit = 4096,
    private readonly inlined: ReadonlyMap<string, InlineSite> = new Map(),
    private readonly alternateIndices: ReadonlyMap<string, readonly Value[]> = new Map(),
    /** Values printed as an operand of their reader, never as a variable. */
    omitted: ReadonlySet<string> = new Set(),
    /** Derive the liveness of `program` = rotateLoopCopies(from's program, rotations). */
    rotation?: { readonly from: VariableLiveness; readonly rotations: readonly LoopCopyRotation[] },
  ) {
    if (rotation) {
      const { from, rotations } = rotation;
      for (const value of from.values) {
        this.index.set(value.id, this.values.length);
        this.values.push(value);
      }
      for (const { header, phi, pseudo } of rotations) {
        this.index.set(pseudo.id, this.values.length);
        this.values.push(pseudo);
        const phis = this.pseudo.get(header) ?? new Map<string, Value>();
        phis.set(phi.id, pseudo);
        this.pseudo.set(header, phis);
      }
      this.words = (this.values.length + 31) >>> 5;
      this.complete = from.complete && this.values.length <= limit;
      for (const [id, leaves] of from.leafMemo) this.leafMemo.set(id, leaves);
      // Every edge into a rotated header removes what the header binds (its
      // pseudo values instead of its phis), so only the header's own entry set
      // changes: its first definitions read each pseudo value and write its phi.
      for (const [block, live] of from.entry) {
        context.checkpoint(this.words);
        const next = new Uint32Array(this.words);
        next.set(live);
        this.entry.set(block, next);
      }
      for (const { header, phi, pseudo } of rotations) {
        const live = this.entry.get(header);
        if (!live) continue;
        const old = this.index.get(phi.id)!,
          id = this.index.get(pseudo.id)!;
        live[old >>> 5]! &= ~(1 << (old & 31));
        live[id >>> 5]! |= 1 << (id & 31);
      }
      return;
    }
    const source = program.source;
    for (const value of program.values.values()) {
      context.checkpoint(1);
      if (
        !program.live.has(value.id) ||
        program.inline.has(value.id) ||
        inlined.has(value.id) ||
        omitted.has(value.id) ||
        source?.stack_addresses.has(value.id)
      )
        continue;
      this.index.set(value.id, this.values.length);
      this.values.push(value);
    }
    for (const value of program.parameters)
      if (!this.index.has(value.id)) {
        this.index.set(value.id, this.values.length);
        this.values.push(value);
      }
    this.words = (this.values.length + 31) >>> 5;
    this.complete = this.values.length <= limit && program.blocks.size <= limit;
    if (this.complete) this.solve();
  }

  /** This liveness for `program`, the reconstruction rotateLoopCopies made
   * from this one's with `rotations`. */
  rotated(program: Reconstruction, rotations: readonly LoopCopyRotation[]): VariableLiveness {
    return new VariableLiveness(
      program,
      this.context,
      this.limit,
      this.inlined,
      this.alternateIndices,
      undefined,
      { from: this, rotations },
    );
  }

  /** Variable leaves read when printing a value (inline expressions expanded). */
  leaves(value: Value): readonly number[] {
    const memo = this.leafMemo.get(value.id);
    if (memo) return memo;
    const result = new Set<number>(),
      pending = [value],
      seen = new Set<string>();
    const stack = this.program.source?.stack;
    while (pending.length) {
      this.context.checkpoint(1);
      const current = pending.pop()!;
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      const offset = this.program.source?.stack_addresses.get(current.id);
      if (offset !== undefined) {
        if (stack?.kind === 'entry') pending.push(stack.base);
        else if (stack?.kind === 'object' && stack.entry && offset >= 0n) pending.push(stack.entry);
        continue;
      }
      const inlined = this.inlined.get(current.id)?.node;
      if (inlined?.kind === 'load') {
        if (!this.program.source?.locals.has(inlined.id)) pending.push(inlined.address);
        pending.push(...(this.alternateIndices.get(inlined.id) ?? []));
        continue;
      }
      const index = this.index.get(current.id);
      if (index !== undefined && !this.program.inline.has(current.id)) {
        result.add(index);
        continue;
      }
      const expression = this.program.expressions.get(current.id);
      if (expression) pending.push(...expressionOperands(expression));
    }
    const leaves = [...result];
    this.leafMemo.set(value.id, leaves);
    return leaves;
  }

  /** The values a printed statement reads (its inline expressions unexpanded). */
  operands(node: Instruction): Value[] {
    const program = this.program,
      reads: Value[] = [];
    if (node.kind === 'assign')
      reads.push(...expressionOperands(program.expressions.get(node.result.id) ?? node.expression));
    else if (node.kind === 'write_register') reads.push(node.value);
    else if (node.kind === 'load' || node.kind === 'store') {
      if (!program.source?.locals.has(node.id)) reads.push(node.address);
      if (node.kind === 'store') reads.push(node.value);
      reads.push(...(this.alternateIndices.get(node.id) ?? []));
    }
    if (node.kind === 'call') {
      const projection = program.calls.get(node.id);
      reads.push(...(projection?.arguments ?? node.arguments));
      for (const binding of projection?.inputs ?? node.register_inputs) reads.push(binding.value);
      if (node.target.kind === 'indirect') reads.push(node.target.value);
    }
    if ('register_inputs' in node)
      for (const binding of program.physical_inputs.get(node.id) ?? node.register_inputs)
        reads.push(binding.value);
    return reads;
  }

  /** Ordered printed definitions/reads of one block, excluding its parameters. */
  events(block: BlockRegion): { readonly def: boolean; readonly ids: readonly number[] }[] {
    const program = this.program,
      events: { def: boolean; ids: number[] }[] = [];
    const use = (values: readonly Value[]): void => {
      const ids: number[] = [];
      for (const value of values) ids.push(...this.leaves(value));
      if (ids.length) events.push({ def: false, ids });
    };
    const define = (values: readonly Value[]): void => {
      const ids: number[] = [];
      for (const value of values) {
        const index = this.index.get(value.id);
        if (index !== undefined && !program.inline.has(value.id)) ids.push(index);
      }
      if (ids.length) events.push({ def: true, ids });
    };
    const definitions = (anchor: string): void => {
      for (const definition of program.source?.definitions?.get(anchor) ?? []) {
        if (this.inlined.has(definition.result.id)) continue;
        use([...expressionOperands(definition.expression)]);
        define([definition.result]);
      }
    };
    definitions(block.id);
    for (const node of block.statements) {
      this.context.checkpoint(1);
      if (
        program.retained.has(node.id) &&
        !('result' in node && this.inlined.has(node.result.id))
      ) {
        use(this.operands(node));
        const writes: Value[] = [];
        if ('result' in node) writes.push(node.result);
        if (node.kind === 'call') writes.push(...(program.calls.get(node.id)?.results ?? []));
        if (node.kind === 'call') writes.push(...node.results);
        if ('register_outputs' in node)
          for (const binding of node.register_outputs) writes.push(binding.value);
        if (node.kind === 'call' || node.kind === 'unknown_effect')
          for (const binding of program.source?.register_outputs?.get(node.id) ?? [])
            writes.push(binding.value);
        define(writes);
      }
      definitions(node.id);
    }
    const control = block.control;
    definitions(control.id);
    const reads: Value[] = [];
    if (control.kind === 'if') reads.push(control.condition);
    else if (control.kind === 'switch') reads.push(control.value);
    else if (control.kind === 'indirect') reads.push(control.target);
    if (control.kind === 'return') {
      const projection = program.returns.get(control.id);
      reads.push(...(projection?.results ?? control.values));
      for (const binding of projection?.outputs ?? block.register_exit) reads.push(binding.value);
    }
    for (const binding of program.physical_exits.get(control.id) ?? []) reads.push(binding.value);
    if (control.kind !== 'return' && control.kind !== 'jump' && control.kind !== 'if')
      for (const binding of block.register_exit) reads.push(binding.value);
    reads.push(...(program.tails.get(control.id)?.boundary.arguments ?? []));
    for (const transfer of controlTransfers(control))
      for (const copy of program.transfers.get(transfer) ?? []) reads.push(copy.source);
    use(reads);
    return events;
  }

  /** Bound at block entry: its parameters (a rotated phi's pseudo value instead
   * of the phi), plus formals at the function entry. */
  bound(block: BlockRegion): number[] {
    const ids: number[] = [];
    const add = (value: Value): void => {
      const index = this.index.get(value.id);
      if (index !== undefined) ids.push(index);
    };
    const pseudo = this.pseudo.get(block.id);
    for (const value of block.parameters) add(pseudo?.get(value.id) ?? value);
    if (block.id === this.program.function.entry) this.program.parameters.forEach(add);
    return ids;
  }

  live(block: string): Uint32Array | undefined {
    return this.entry.get(block);
  }

  has(set: Uint32Array, index: number): boolean {
    return ((set[index >>> 5]! >>> (index & 31)) & 1) === 1;
  }

  private solve(): void {
    const blocks = [...this.program.blocks.values()];
    const summaries = new Map<
      string,
      { use: Uint32Array; def: Uint32Array; bound: number[]; successors: string[] }
    >();
    for (const block of blocks) {
      const use = new Uint32Array(this.words),
        def = new Uint32Array(this.words);
      for (const event of this.events(block))
        for (const id of event.ids) {
          const word = id >>> 5,
            bit = 1 << (id & 31);
          if (event.def) def[word]! |= bit;
          else if (!(def[word]! & bit)) use[word]! |= bit;
        }
      summaries.set(block.id, {
        use,
        def,
        bound: this.bound(block),
        successors: controlTransfers(block.control).map((transfer) => transfer.target),
      });
      this.entry.set(block.id, new Uint32Array(this.words));
    }
    const out = new Uint32Array(this.words),
      edge = new Uint32Array(this.words);
    for (let changed = true, rounds = 0; changed; rounds++) {
      changed = false;
      // Monotone over a finite lattice: each round propagates at least one block.
      if (rounds > blocks.length + 2) throw new Error('Liveness did not converge');
      for (let b = blocks.length - 1; b >= 0; b--) {
        const block = blocks[b]!,
          summary = summaries.get(block.id)!;
        this.context.checkpoint(this.words + 1);
        out.fill(0);
        for (const target of summary.successors) {
          const next = this.entry.get(target);
          if (!next) continue;
          edge.set(next);
          for (const id of summaries.get(target)!.bound) edge[id >>> 5]! &= ~(1 << (id & 31));
          for (let w = 0; w < this.words; w++) out[w]! |= edge[w]!;
        }
        const entry = this.entry.get(block.id)!;
        for (let w = 0; w < this.words; w++) {
          const next = (summary.use[w]! | (out[w]! & ~summary.def[w]!)) >>> 0;
          if (next !== entry[w]) {
            entry[w] = next;
            changed = true;
          }
        }
      }
    }
  }

  /** Values live just after the end of `block` along any successor edge. */
  exit(block: BlockRegion): Uint32Array {
    const out = new Uint32Array(this.words);
    for (const transfer of controlTransfers(block.control)) {
      const next = this.entry.get(transfer.target);
      if (!next) continue;
      const edge = next.slice();
      for (const id of this.bound(this.program.blocks.get(transfer.target)!))
        edge[id >>> 5]! &= ~(1 << (id & 31));
      for (let w = 0; w < this.words; w++) out[w]! |= edge[w]!;
    }
    return out;
  }
}

/** What the variable partition needs to know about one printed value. */
export interface VariableMember {
  /** Presented spelling of the value on its own. */
  readonly spelling: string;
  /** Storage identity (machine storage type and FP presentation): members of
   * one variable share it. */
  readonly storage: string;
  /** Its definition prints converted exactly into any scalar variable spelling
   * (an edge copy, a pure assignment, a plain load). Any other member (a
   * formal, a call result) is rigid: its spelling is the variable's. */
  readonly flexible: boolean;
  /** An integer value spelled as a pointer or an integer type of its own
   * width: same-width conversions between such spellings keep every bit. */
  readonly scalar: boolean;
  /** Plain unsigned integer spelling: a variable holding several widths holds
   * only these (each narrower member is read through one conversion). */
  readonly plain: boolean;
  /** Carries a supplied name (preferred as the representative). */
  readonly named: boolean;
  /** Reads of the value: the variable takes its members' most-read spelling. */
  readonly reads: number;
  readonly formal: boolean;
}

interface ValuePair {
  readonly destination: Value;
  readonly source: Value;
}

export interface PartitionPairs {
  /** A block parameter and the variable an incoming argument reads (directly,
   * through a same-width alias or as a zero extension into plain storage):
   * they share a variable unless they interfere (Ghidra `mergeMarker`); an
   * interfering pair keeps its explicit edge copy. */
  readonly edges: readonly ValuePair[];
  /** Statement definitions whose value equals their source at that point (a
   * same-width alias, a zero extension into plain unsigned storage): the
   * source being live there is no conflict. Merged like edges. */
  readonly equal: readonly ValuePair[];
  /** A definition and a variable its expression reads (in-place update `x = x
   * + 1`): merged only when both have the same presented spelling (Ghidra
   * `mergeAdjacent`). */
  readonly adjacent: readonly ValuePair[];
  /** Values one machine register holds, in program order: a value joins an
   * earlier one of the same presented spelling when they do not interfere
   * (register reuse; Ghidra `mergeByDatatype`). */
  readonly reuse: readonly (readonly Value[])[];
}

/** One variable partition over the printed SSA values (block parameters, edge
 * arguments, definitions), from exact SSA live-range interference: two values
 * conflict when one is live where the other is defined (simultaneous block
 * parameters and loop-carried liveness included), except a source at a
 * definition equal to it. Classes join only without a conflict between any two
 * members, with one storage identity, at most one rigid spelling, scalar
 * members whenever spellings differ and plain members whenever widths differ.
 * Since no member is ever live where another is written, sharing storage
 * changes names only. Formals stay representatives; otherwise the widest
 * member of the rigid or most-read spelling represents the class and gives the
 * variable its declared type. Returns value id -> representative for classes
 * of two or more members; empty when the interference matrix is out of bounds
 * (its work is optional, at most 1/8 of the remaining budget). */
export function partitionVariables(
  program: Reconstruction,
  liveness: VariableLiveness,
  member: (value: Value) => VariableMember,
  pairs: PartitionPairs,
  context: OperationContext,
): Map<string, Value> {
  const result = new Map<string, Value>();
  if (!liveness.complete) return result;
  const count = liveness.values.length,
    words = (count + 31) >>> 5;
  const allowance = Math.floor((context.remainingWork?.() ?? 0) / 8);
  let spent = 0;
  const charge = (work: number): boolean => {
    spent += work;
    context.checkpoint(work);
    return spent <= allowance;
  };
  const indexOf = (value: Value): number | undefined =>
    program.inline.has(value.id) ? undefined : liveness.index.get(value.id);
  const equal = new Map<number, number>();
  for (const pair of pairs.equal) {
    const destination = indexOf(pair.destination),
      source = indexOf(pair.source);
    if (destination !== undefined && source !== undefined) equal.set(destination, source);
  }
  // Row `i`: every value live where `i` is defined (or defined together with it).
  const rows = new Uint32Array(count * words);
  const mark = (a: number, b: number): void => {
    rows[a * words + (b >>> 5)]! |= 1 << (b & 31);
  };
  for (const block of program.blocks.values()) {
    const live = liveness.exit(block);
    const events = liveness.events(block);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      if (!charge(1 + (event.def ? event.ids.length * words : event.ids.length))) return result;
      if (!event.def) {
        for (const id of event.ids) live[id >>> 5]! |= 1 << (id & 31);
        continue;
      }
      for (const id of event.ids) live[id >>> 5]! &= ~(1 << (id & 31));
      for (const id of event.ids) {
        const row = id * words;
        for (let w = 0; w < words; w++) rows[row + w]! |= live[w]!;
        // At an equal definition the source holds the same value.
        const source = equal.get(id);
        if (source !== undefined) rows[row + (source >>> 5)]! &= ~(1 << (source & 31));
        for (const other of event.ids) if (other !== id) mark(id, other);
      }
    }
    // Parameters (and formals) are bound simultaneously at entry, on every edge.
    const entry = liveness.live(block.id)!,
      here = liveness.bound(block);
    if (!charge(1 + here.length * words)) return result;
    for (const id of here) {
      for (let w = 0; w < words; w++) rows[id * words + w]! |= entry[w]!;
      for (const other of here) if (other !== id) mark(id, other);
    }
  }
  interface Class {
    readonly members: number[];
    readonly bits: Uint32Array;
    readonly conflicts: Uint32Array;
    readonly storage: string;
    rigid: string | null;
    readonly spellings: Set<string>;
    readonly widths: Set<number>;
    scalar: boolean;
    plain: boolean;
  }
  const parent = new Map<number, number>(),
    classes = new Map<number, Class>(),
    facts = new Map<number, VariableMember>();
  const fact = (id: number): VariableMember => {
    let known = facts.get(id);
    if (!known) facts.set(id, (known = member(liveness.values[id]!)));
    return known;
  };
  const find = (id: number): number => {
    if (!parent.has(id)) {
      const own = fact(id),
        bits = new Uint32Array(words);
      bits[id >>> 5]! |= 1 << (id & 31);
      parent.set(id, id);
      classes.set(id, {
        members: [id],
        bits,
        conflicts: rows.slice(id * words, (id + 1) * words),
        storage: own.storage,
        rigid: own.flexible ? null : own.spelling,
        spellings: new Set([own.spelling]),
        widths: new Set([bitWidth(liveness.values[id]!.type)]),
        scalar: own.scalar,
        plain: own.plain,
      });
      return id;
    }
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let next = id; next !== root;) {
      const up = parent.get(next)!;
      parent.set(next, root);
      next = up;
    }
    return root;
  };
  let exhausted = false;
  /** Join two classes when no member of one conflicts with a member of the other
   * and the union still has one storage, one presented spelling and exact
   * conversions for every other member; true when they now share a variable. */
  const attempt = (a: number, b: number): boolean => {
    if (a === b) return true;
    const left = classes.get(a)!,
      right = classes.get(b)!;
    if (left.storage !== right.storage) return false;
    const plain = left.plain && right.plain;
    if (left.rigid !== null && right.rigid !== null && left.rigid !== right.rigid && !plain)
      return false;
    if (!plain && [...right.widths].some((width) => !left.widths.has(width))) return false;
    if (
      !plain &&
      !(left.scalar && right.scalar) &&
      [...right.spellings].some((spelling) => !left.spellings.has(spelling))
    )
      return false;
    if (!charge(words)) {
      exhausted = true;
      return false;
    }
    for (let w = 0; w < words; w++)
      if (((left.conflicts[w]! & right.bits[w]!) | (right.conflicts[w]! & left.bits[w]!)) !== 0)
        return false;
    parent.set(b, a);
    left.members.push(...right.members);
    for (let w = 0; w < words; w++) {
      left.bits[w]! |= right.bits[w]!;
      left.conflicts[w]! |= right.conflicts[w]!;
    }
    left.rigid ??= right.rigid;
    for (const spelling of right.spellings) left.spellings.add(spelling);
    for (const width of right.widths) left.widths.add(width);
    left.scalar &&= right.scalar;
    left.plain = plain;
    classes.delete(b);
    return true;
  };
  const join = (pair: ValuePair, sameSpelling: boolean): void => {
    if (exhausted) return;
    const destination = indexOf(pair.destination),
      source = indexOf(pair.source);
    if (destination === undefined || source === undefined) return;
    if (sameSpelling && fact(destination).spelling !== fact(source).spelling) return;
    context.checkpoint(1);
    attempt(find(destination), find(source));
  };
  for (const pair of pairs.edges) join(pair, false);
  for (const pair of pairs.equal) join(pair, false);
  for (const pair of pairs.adjacent) join(pair, true);
  // Register reuse (Ghidra `mergeByDatatype`, kept to one machine register):
  // each value joins the first earlier class of its register and spelling it
  // can share storage with.
  for (const group of pairs.reuse) {
    const stacks = new Map<string, number[]>();
    for (const value of group) {
      if (exhausted) break;
      const id = indexOf(value);
      if (id === undefined) continue;
      const spelling = fact(id).spelling;
      const stack = stacks.get(spelling) ?? [];
      stacks.set(spelling, stack);
      const root = find(id);
      if (!stack.some((other) => (context.checkpoint(1), attempt(find(other), find(root)))))
        stack.push(root);
    }
  }
  for (const { members } of classes.values()) {
    if (members.length < 2) continue;
    context.checkpoint(members.length);
    members.sort((a, b) => a - b);
    const representative = classRepresentative(members, liveness.values, fact);
    for (const id of members) result.set(liveness.values[id]!.id, liveness.values[representative]!);
  }
  return result;
}

/** A formal; otherwise among the widest members a rigid one, else one of the
 * most-read spelling (a named member first, then the earliest). */
function classRepresentative(
  members: readonly number[],
  values: readonly Value[],
  fact: (id: number) => VariableMember,
): number {
  const formal = members.find((id) => fact(id).formal);
  if (formal !== undefined) return formal;
  const widest = Math.max(...members.map((id) => bitWidth(values[id]!.type)));
  const candidates = members.filter((id) => bitWidth(values[id]!.type) === widest);
  const rigid = candidates.find((id) => !fact(id).flexible);
  if (rigid !== undefined) return rigid;
  const reads = new Map<string, number>();
  for (const id of members)
    reads.set(fact(id).spelling, (reads.get(fact(id).spelling) ?? 0) + fact(id).reads);
  let spelling = fact(candidates[0]!).spelling;
  for (const id of candidates)
    if (reads.get(fact(id).spelling)! > reads.get(spelling)!) spelling = fact(id).spelling;
  const chosen = candidates.filter((id) => fact(id).spelling === spelling);
  return chosen.find((id) => fact(id).named) ?? chosen[0]!;
}

/** Edge copies `copies` (one transfer's) still print under the partition
 * `variables`: a copy between members of one variable is no move, whether the
 * source is the member itself, a same-width alias of it, or the zero extension
 * of a narrower member (the variable's plain unsigned storage holds exactly
 * that extension; the parallel-copy validation states the assumption).
 * Structuring and source planning read every edge's copy count from here. */
export function edgeCopies<T extends ValuePair>(
  program: Reconstruction,
  variables: ReadonlyMap<string, Value>,
  inline: ReadonlySet<string>,
  copies: readonly T[],
): readonly T[] {
  if (!variables.size) return copies;
  const uncast = (value: Value, ops: readonly string[]): Value => {
    for (let depth = 0; depth < 16 && inline.has(value.id); depth++) {
      const expression = program.expressions.get(value.id);
      if (expression?.kind !== 'cast' || !ops.includes(expression.op)) break;
      value = expression.value;
    }
    return value;
  };
  return copies.filter((copy) => {
    const destination = variables.get(copy.destination.id);
    if (!destination) return true;
    const source = uncast(copy.source, ['bitcast']);
    const narrow = uncast(source, ['bitcast', 'zero_extend']);
    return !(
      (!inline.has(source.id) && variables.get(source.id) === destination) ||
      (!inline.has(narrow.id) &&
        variables.get(narrow.id) === destination &&
        bitWidth(narrow.type) < bitWidth(destination.type))
    );
  });
}

/** A loop-carried copy `x = y` rotated to the top of its loop (L4). The header
 * binds `pseudo` instead of the phi `x`: every incoming edge writes it (the
 * entry value, or `y` on the repeat edge), and the header's first statement is
 * `definition`, `x = pseudo`. `pseudo` and `y` do not interfere, so the
 * partition may give them one variable and the repeat edge prints no copy. */
export interface LoopCopyRotation {
  readonly header: string;
  readonly phi: Value;
  readonly source: Value;
  readonly pseudo: Value;
  readonly definition: Extract<Instruction, { kind: 'assign' }>;
}

/** Loops (C-like do-while candidates) whose lexically last block ends in a
 * test with one copy-carrying arm that is the sole edge back to the header and
 * one arm leaving the loop, where some repeat copies `x = y` are live on exit
 * or read by the exit edge's copies: the only reason a do-while cannot move
 * them before its test. Each such copy rotates when `y` is a printed value of
 * the phi's type that is not live into the header (defined in the loop) and
 * `eligible` holds. A loop rotates only when all of them do and every other
 * repeat copy is unread by the test, so no copy blocker remains, and only when
 * `topTested` is false for its header and the bottom test's exit target (a
 * header test leaving for the same continuation may already print the loop as
 * `while`, which the rotated copy would displace). */
export function loopCopyRotations(
  body: Region,
  program: Reconstruction,
  liveness: VariableLiveness,
  plain: (control: Control) => boolean,
  eligible: (phi: Value, source: Value) => boolean,
  topTested: (header: BlockRegion, follow: string) => boolean,
  context: OperationContext,
): LoopCopyRotation[] {
  const result: LoopCopyRotation[] = [];
  if (!program.source || !liveness.complete) return result;
  const blocksOf = (region: Region, into: BlockRegion[] = []): BlockRegion[] => {
    context.checkpoint(1);
    if (region.kind === 'sequence') for (const child of region.regions) blocksOf(child, into);
    else if (region.kind === 'loop') blocksOf(region.body, into);
    else {
      into.push(region);
      for (const arm of controlArms(region.control)) if (arm.body) blocksOf(arm.body, into);
    }
    return into;
  };
  const consider = (loop: Extract<Region, { kind: 'loop' }>): void => {
    let last: Region | undefined = loop.body;
    while (last?.kind === 'sequence') {
      context.checkpoint(1);
      last = last.regions.at(-1);
    }
    if (last?.kind !== 'block' || last.control.kind !== 'if' || !plain(last.control)) return;
    const control = last.control,
      header = program.blocks.get(loop.header);
    const again = [control.when_true, control.when_false].find(
      (arm) => arm.transfer.mode === 'continue' && arm.transfer.target === loop.header,
    );
    const leave = again === control.when_true ? control.when_false : control.when_true;
    const copies = again ? (program.transfers.get(again.transfer) ?? []) : [];
    if (
      !again ||
      again.body ||
      leave.body ||
      !copies.length ||
      !header ||
      topTested(header, leave.transfer.target)
    )
      return;
    const inside = blocksOf(loop.body);
    if (
      leave.transfer.target === loop.header ||
      inside.some((block) => block.id === leave.transfer.target) ||
      inside.some((block) =>
        controlTransfers(block.control).some(
          (transfer) => transfer !== again.transfer && transfer.target === loop.header,
        ),
      )
    )
      return;
    const exit = liveness.live(leave.transfer.target),
      entry = liveness.live(loop.header);
    if (!exit || !entry) return;
    const exitReads = new Set(
      (program.transfers.get(leave.transfer) ?? []).flatMap((copy) => liveness.leaves(copy.source)),
    );
    const testReads = new Set(liveness.leaves(control.condition));
    const found: LoopCopyRotation[] = [];
    for (const { destination: phi, source } of copies) {
      context.checkpoint(1);
      const index = liveness.index.get(phi.id);
      if (index === undefined || program.inline.has(phi.id)) continue;
      if (!liveness.has(exit, index) && !exitReads.has(index)) {
        if (testReads.has(index)) return;
        continue;
      }
      const carried = liveness.index.get(source.id);
      if (
        carried === undefined ||
        program.inline.has(source.id) ||
        liveness.has(entry, carried) ||
        !header.parameters.some((parameter) => parameter.id === phi.id) ||
        phi.type.kind !== source.type.kind ||
        bitWidth(phi.type) !== bitWidth(source.type) ||
        !eligible(phi, source)
      )
        return;
      const pseudo: Value = {
        id: `entity_${fingerprint(['loop-copy-rotation', phi.id])}`,
        type: phi.type,
      };
      found.push({
        header: loop.header,
        phi,
        source,
        pseudo,
        definition: {
          kind: 'assign',
          id: `entity_${fingerprint(['loop-copy-rotation-definition', phi.id])}`,
          result: phi,
          expression: { kind: 'cast', op: 'bitcast', value: pseudo },
          provenance: header.provenance,
        },
      });
    }
    result.push(...found);
  };
  const visit = (region: Region): void => {
    context.checkpoint(1);
    if (region.kind === 'sequence') region.regions.forEach(visit);
    else if (region.kind === 'loop') {
      consider(region);
      visit(region.body);
    } else for (const arm of controlArms(region.control)) if (arm.body) visit(arm.body);
  };
  visit(body);
  return result;
}

/** `program` with `rotations` applied: each edge into a rotated header writes
 * the phi's pseudo value instead of the phi, and the header's first source
 * definitions assign every rotated phi from its pseudo value. */
export function rotateLoopCopies(
  program: Reconstruction,
  rotations: readonly LoopCopyRotation[],
  context: OperationContext,
): Reconstruction {
  const source = program.source;
  if (!source || !rotations.length) return program;
  const pseudo = new Map<string, Map<string, Value>>(),
    definitions = new Map(source.definitions ?? []),
    values = new Map(program.values),
    live = new Set(program.live),
    counts = new Map(program.use_counts);
  context.checkpoint(values.size + live.size + counts.size + definitions.size);
  for (const rotation of [...rotations].reverse()) {
    const phis = pseudo.get(rotation.header) ?? new Map<string, Value>();
    phis.set(rotation.phi.id, rotation.pseudo);
    pseudo.set(rotation.header, phis);
    definitions.set(rotation.header, [
      rotation.definition,
      ...(definitions.get(rotation.header) ?? []),
    ]);
    values.set(rotation.pseudo.id, rotation.pseudo);
    live.add(rotation.pseudo.id);
    counts.set(rotation.pseudo.id, 1);
  }
  const transfers = new Map(program.transfers);
  for (const [transfer, copies] of program.transfers) {
    const phis = pseudo.get(transfer.target);
    if (!phis) continue;
    context.checkpoint(copies.length);
    transfers.set(
      transfer,
      copies.map((copy) => {
        const destination = phis.get(copy.destination.id);
        return destination ? { destination, source: copy.source } : copy;
      }),
    );
  }
  return {
    ...program,
    source: { ...source, definitions },
    values,
    live,
    use_counts: counts,
    transfers,
  };
}

export interface Occurrence {
  readonly transfer: ParallelTransfer;
  readonly control: Control;
  /** Block owning the control; a duplicated tail reports its home identity. */
  readonly block: string;
  /** The printed block region itself (a copy for a duplicated tail). */
  readonly owner: BlockRegion;
  /** Region reached when the transfer prints nothing; null at the function end. */
  readonly destination: Region | null;
  readonly nesting: readonly Nest[];
}

function firstBlockOf(region: Region | null): string | null {
  return region ? firstBlock(region) : null;
}

function leaf(region: Region | null): Region | null {
  while (region?.kind === 'sequence') {
    const next = region.regions.find((child) => firstBlock(child) !== null);
    if (!next) return null;
    region = next;
  }
  return region;
}

/** Visit every printed transfer occurrence with its lexical destination;
 * `follow` is the region the body falls into. */
export function visitTransfers(
  body: Region,
  language: 'c-like' | 'python-like',
  context: OperationContext,
  visit: (occurrence: Occurrence) => void,
  follow: Region | null = null,
): void {
  /** `shared`: the body a `joins` arm of the operand chain being walked enters. */
  const walk = (
    region: Region,
    follow: Region | null,
    nesting: readonly Nest[],
    shared: Region | null = null,
  ): void => {
    context.checkpoint(1);
    if (region.kind === 'sequence') {
      for (let i = 0; i < region.regions.length; i++) {
        let next = follow;
        for (let j = i + 1; j < region.regions.length; j++)
          if (firstBlock(region.regions[j]!) !== null) {
            next = region.regions[j]!;
            break;
          }
        walk(region.regions[i]!, next, nesting, shared);
      }
      return;
    }
    if (region.kind === 'loop') {
      const after = leaf(follow);
      walk(region.body, region, [
        ...nesting,
        {
          kind: 'loop',
          header: region.header,
          follow: firstBlockOf(after),
        },
      ]);
      return;
    }
    const control = region.control;
    if (control.kind === 'jump')
      visit({
        transfer: control.transfer,
        control,
        block: region.id,
        owner: region,
        destination: leaf(follow),
        nesting,
      });
    const nested: readonly Nest[] =
      control.kind === 'switch' && language === 'c-like'
        ? [...nesting, { kind: 'switch', id: control.id, follow: firstBlockOf(leaf(follow)) }]
        : nesting;
    const head = controlArms(control).find((arm) => arm.shared);
    for (const arm of controlArms(control)) {
      visit({
        transfer: arm.transfer,
        control,
        block: region.id,
        owner: region,
        destination: leaf(arm.joins ? shared : (arm.body ?? follow)),
        nesting: nested,
      });
      if (arm.body)
        walk(
          arm.body,
          follow,
          nested,
          head && arm !== head
            ? head.body!
            : arm.shared
              ? null
              : controlArms(control).some((item) => item.joins)
                ? shared
                : null,
        );
    }
  };
  walk(body, follow, []);
}

export function occurrenceAction(
  occurrence: Occurrence,
  language: 'c-like' | 'python-like',
): TransferAction {
  const destination = occurrence.destination;
  return transferAction(
    occurrence.transfer,
    occurrence.nesting,
    destination ? firstBlock(destination) : null,
    language,
    true,
  );
}

/** Printed goto occurrences of a layout. */
export function gotoOccurrences(
  body: Region,
  language: 'c-like' | 'python-like',
  context: OperationContext,
): Occurrence[] {
  const gotos: Occurrence[] = [];
  visitTransfers(body, language, context, (occurrence) => {
    if (occurrenceAction(occurrence, language) === 'goto') gotos.push(occurrence);
  });
  return gotos;
}

export interface LoopExitRoute {
  readonly loop: string;
  /** Breakable scopes, innermost first, ending at the target loop. */
  readonly through: readonly string[];
}

/** What the renderer prints around a loop's exit: a guard `if (flag) break;`
 * stands right after the scope it propagates out of. */
export interface LoopExitPrinting {
  /** The block prints nothing but its transfer. */
  readonly quiet: (block: BlockRegion) => boolean;
  /** Headers of loops printing exit edge copies right after the loop. */
  readonly exitCopies: ReadonlySet<string>;
}

/** A boolean is needed only when a real edge bypasses two or more breakable
 * scopes to an enclosing loop's exact continuation. No arbitrary target, loop
 * entry, or irreducible edge is rewritten: a loop entered by a goto (at its
 * header or into its body) keeps its labeled exits, since the flag, declared
 * where it starts, would not be initialized on that entry.
 *
 * The guard after a scope tells a path that left through the flag from one that
 * left normally, so an edge keeps the flag only if every guard it passes
 * decides something: (1) some printed edge reaches the guard with the flag
 * clear (a scope that cannot be left but through flagged edges never tests it
 * clear), and (2) the guard is not followed by an unconditional `break` that
 * leaves the same scope (both outcomes would go the same way). Any other edge
 * keeps its labeled goto to the loop's continuation. */
export function planLoopExits(
  body: Region,
  language: 'c-like' | 'python-like',
  context: OperationContext,
  printing: LoopExitPrinting,
): ReadonlyMap<ParallelTransfer, LoopExitRoute> {
  const routes = new Map<ParallelTransfer, LoopExitRoute>();
  const enclosing = new Map<string, readonly string[]>();
  const scan = (region: Region, loops: readonly string[]): void => {
    context.checkpoint(1);
    if (region.kind === 'sequence') for (const child of region.regions) scan(child, loops);
    else if (region.kind === 'loop') scan(region.body, [...loops, region.header]);
    else {
      enclosing.set(region.id, loops);
      for (const arm of controlArms(region.control)) if (arm.body) scan(arm.body, loops);
    }
  };
  scan(body, []);
  const unsafe = new Set<string>();
  const name = (scope: Nest): string => (scope.kind === 'loop' ? scope.header : scope.id);
  const signature = (scopes: readonly Nest[]): string =>
    scopes.map((scope) => `${scope.kind}:${name(scope)}`).join('|');
  /** Per scope: its lexical successor and the nesting around it. */
  const scopes = new Map<string, { follow: string | null; outer: string }>();
  /** Scopes some printed edge leaves to their successor without a goto. */
  const left = new Set<string>();
  /** Per block, its jump occurrences: printed action and nesting. */
  const jumps = new Map<
    string,
    { block: BlockRegion; action: TransferAction; nesting: string }[]
  >();
  visitTransfers(body, language, context, (occurrence) => {
    const action = occurrenceAction(occurrence, language);
    const nesting = occurrence.nesting;
    nesting.forEach((scope, index) => {
      if (!scopes.has(name(scope)))
        scopes.set(name(scope), {
          follow: scope.follow,
          outer: signature(nesting.slice(0, index)),
        });
      if (action !== 'goto' && scope.follow !== null && occurrence.transfer.target === scope.follow)
        left.add(name(scope));
    });
    if (occurrence.control.kind === 'jump') {
      const rows = jumps.get(occurrence.block) ?? [];
      rows.push({ block: occurrence.owner, action, nesting: signature(nesting) });
      jumps.set(occurrence.block, rows);
    }
    if (action !== 'goto') return;
    const inside = new Set(
      nesting.flatMap((scope) => (scope.kind === 'loop' ? [scope.header] : [])),
    );
    if (!inside.has(occurrence.transfer.target)) unsafe.add(occurrence.transfer.target);
    for (const loop of enclosing.get(occurrence.transfer.target) ?? [])
      if (!inside.has(loop)) unsafe.add(loop);
    for (let index = nesting.length - 1; index >= 0; index--) {
      const scope = nesting[index]!;
      if (scope.kind !== 'loop' || scope.follow !== occurrence.transfer.target) continue;
      if (index < nesting.length - 1)
        routes.set(occurrence.transfer, {
          loop: scope.header,
          through: nesting
            .slice(index)
            .reverse()
            .map((item) => (item.kind === 'loop' ? item.header : item.id)),
        });
      break;
    }
  });
  /** Edges kept as flagged exits, by the loop whose continuation they reach. */
  const reaching = new Map<string, ParallelTransfer[]>();
  for (const [transfer, route] of routes)
    reaching.set(route.loop, [...(reaching.get(route.loop) ?? []), transfer]);
  const kept = new Map<ParallelTransfer, boolean>();
  const decided = new Map<string, boolean>();
  /** Some path reaches the guard after `scope` with the guard's flags clear: a
   * printed edge to its successor, or a flagged edge to it when `scope` is a
   * loop (that edge sets its own flag, not the guarded one), and the guard is
   * not followed by the same `break`. Nested scopes only: no cycle. */
  const decides = (scope: string): boolean => {
    const known = decided.get(scope);
    if (known !== undefined) return known;
    const info = scopes.get(scope)!;
    const next = info.follow === null ? undefined : jumps.get(info.follow);
    const decision =
      (left.has(scope) || (reaching.get(scope) ?? []).some((transfer) => keep(transfer))) &&
      !(
        next?.length &&
        !printing.exitCopies.has(scope) &&
        next.every(
          (row) =>
            row.action === 'break' && row.nesting === info.outer && printing.quiet(row.block),
        )
      );
    decided.set(scope, decision);
    return decision;
  };
  const keep = (transfer: ParallelTransfer): boolean => {
    const known = kept.get(transfer);
    if (known !== undefined) return known;
    const route = routes.get(transfer)!;
    const decision =
      !unsafe.has(route.loop) && route.through.slice(0, -1).every((scope) => decides(scope));
    kept.set(transfer, decision);
    return decision;
  };
  for (const transfer of [...routes.keys()]) if (!keep(transfer)) routes.delete(transfer);
  return routes;
}

function mapArms(control: Control, arm: (item: ControlArm) => ControlArm): Control {
  if (control.kind === 'if')
    return { ...control, when_true: arm(control.when_true), when_false: arm(control.when_false) };
  if (control.kind === 'switch')
    return {
      ...control,
      cases: control.cases.map((item) => ({ ...item, arm: arm(item.arm) })),
      otherwise: arm(control.otherwise),
    };
  return control;
}

/** Rebuilt sequences keep the input nesting, so nesting bounds still apply. */
function sequence(regions: readonly Region[]): Region {
  return { kind: 'sequence', regions: [...regions] };
}

function nextEntry(
  regions: readonly Region[],
  index: number,
  follow: string | null,
): string | null {
  for (let j = index + 1; j < regions.length; j++) {
    const candidate = firstBlock(regions[j]!);
    if (candidate !== null) return candidate;
  }
  return follow;
}

export interface LayoutPlan {
  readonly body: Region;
  /** Shallow block copies owned by a duplicated tail; never labeled. */
  readonly clones: ReadonlySet<BlockRegion>;
  /** Duplicated tail occurrences: the copied block and the edge it now ends. */
  readonly duplicated: readonly { readonly transfer: ParallelTransfer; readonly tail: string }[];
  /** Tails whose every incoming edge now ends in an owned copy. */
  readonly hidden: readonly string[];
}

/** Source-view tail copies, after structuring (which already orders regions,
 * places loop exits and labels edges into small function tails first). Every
 * change keeps the original block and transfer objects; the renderer
 * re-derives lexical actions from the result and the control validators check
 * each emitted edge independently. `silent` accepts expression-only tails;
 * `small` optionally accepts bounded statement tails. Every copied path runs
 * the same statements once, then returns. */
export function planLayout(
  body: Region,
  program: Reconstruction,
  language: 'c-like' | 'python-like',
  silent: (block: BlockRegion) => boolean,
  /** Number of edge copies the transfer prints under the variable partition (`edgeCopies`). */
  copies: (transfer: ParallelTransfer) => number,
  context: OperationContext,
  small: (block: BlockRegion) => boolean = silent,
): LayoutPlan {
  let clones = new Set<BlockRegion>();
  let duplicated: { transfer: ParallelTransfer; tail: string }[] = [];
  const active = context;
  const blocks = program.blocks;
  const tails = new Map<string, number>();
  const tailSize = (id: string, path = new Set<string>()): number => {
    const known = tails.get(id);
    if (known !== undefined) return known;
    const block = blocks.get(id);
    if (!block || id === program.function.entry || path.has(id) || path.size >= 4) return 0;
    path.add(id);
    let size = 0;
    if (silent(block) || small(block)) {
      const control = block.control;
      if (control.kind === 'return' || control.kind === 'indirect' || control.kind === 'trap')
        size = 1;
      else if (control.kind === 'jump' && copies(control.transfer) <= 4) {
        const next = tailSize(control.transfer.target, path);
        if (next > 0 && next < 4) size = next + 1;
      }
    }
    path.delete(id);
    // A depth-limited search may fail only in this context. Cache successes,
    // whose exact lengths remain valid from every incoming edge.
    if (size > 0) tails.set(id, size);
    return size;
  };
  // Each copy prints at most four edge copies and one return per level (depth <= 4).
  let budget = 128;
  // A copied jump falls into the copy of its target, while the renderer keeps
  // one action per transfer: a copied transfer whose home occurrence prints
  // anything else (a loop break, a goto) refuses the labeled edge whose copy
  // holds it, and that edge keeps its goto. `roots`: copy -> that edge.
  let roots = new Map<BlockRegion, ParallelTransfer>();
  const refused = new Set<ParallelTransfer>();
  const clone = (id: string, transfer: ParallelTransfer, root = transfer): Region => {
    const block = blocks.get(id)!,
      copy: BlockRegion = { ...block };
    clones.add(copy);
    roots.set(copy, root);
    duplicated.push({ transfer, tail: id });
    budget--;
    const control = block.control;
    return control.kind === 'jump'
      ? sequence([copy, clone(control.transfer.target, control.transfer, root)])
      : copy;
  };

  // 1. Each labeled edge into a tail ends in an owned copy of the tail instead.
  // A jump and the copied continuation it owns are removed together if the
  // jump's home becomes unreachable. Otherwise its orphan return would remain
  // after another terminal block, despite having no incoming edge.
  let expansions = new Map<Region, BlockRegion>();
  const duplicate = (region: Region, follow: string | null, nesting: readonly Nest[]): Region => {
    active.checkpoint(1);
    if (region.kind === 'sequence')
      return sequence(
        region.regions.map((child, index) =>
          duplicate(child, nextEntry(region.regions, index, follow), nesting),
        ),
      );
    if (region.kind === 'loop')
      return {
        ...region,
        body: duplicate(region.body, region.header, [
          ...nesting,
          { kind: 'loop', header: region.header, follow },
        ]),
      };
    const control = region.control;
    const labeled = (
      transfer: ParallelTransfer,
      destination: string | null,
      nested: readonly Nest[],
    ): boolean =>
      !refused.has(transfer) &&
      tailSize(transfer.target) > 0 &&
      budget >= tailSize(transfer.target) &&
      transferAction(transfer, nested, destination, language, true) === 'goto';
    if (control.kind === 'jump') {
      if (!labeled(control.transfer, follow, nesting)) return region;
      const expanded = sequence([region, clone(control.transfer.target, control.transfer)]);
      expansions.set(expanded, region);
      return expanded;
    }
    const nested: readonly Nest[] =
      control.kind === 'switch' && language === 'c-like'
        ? [...nesting, { kind: 'switch', id: control.id, follow }]
        : nesting;
    return {
      ...region,
      control: mapArms(control, (item) =>
        item.body
          ? { ...item, body: duplicate(item.body, follow, nested) }
          : labeled(item.transfer, follow, nested)
            ? { ...item, body: clone(item.transfer.target, item.transfer) }
            : item,
      ),
    };
  };
  // 2. A tail no longer reached lexically at home is printed only as its copies.
  let hidden = new Set<string>();
  const expand = (base: Region): Region => {
    clones = new Set();
    roots = new Map();
    duplicated = [];
    expansions = new Map();
    hidden = new Set();
    budget = 128;
    let result = duplicate(base, null, []);
    for (let round = 0; clones.size && round <= tails.size; round++) {
      const reached = new Set<string>();
      visitTransfers(result, language, active, (occurrence) => {
        const destination = occurrence.destination;
        if (
          occurrenceAction(occurrence, language) !== 'fallthrough' ||
          destination?.kind !== 'block' ||
          !clones.has(destination)
        )
          reached.add(occurrence.transfer.target);
      });
      const drop = new Set<string>();
      for (const [id, tail] of tails) if (tail && !reached.has(id) && !hidden.has(id)) drop.add(id);
      if (!drop.size) break;
      const prune = (region: Region): Region | null => {
        active.checkpoint(1);
        const owner = expansions.get(region);
        if (owner && drop.has(owner.id)) return null;
        if (region.kind === 'block') {
          // Clones contain only jumps/returns, so have no owned arms to rebuild.
          // Keep their identity for subsequent pruning rounds and label planning.
          if (clones.has(region)) return region;
          if (drop.has(region.id)) return null;
          return {
            ...region,
            control: mapArms(region.control, (item) =>
              item.body ? { ...item, body: prune(item.body) ?? item.body } : item,
            ),
          };
        }
        if (region.kind === 'loop') return { ...region, body: prune(region.body) ?? region.body };
        const children: Region[] = [];
        for (const child of region.regions) {
          const next = prune(child);
          if (next) children.push(next);
        }
        if (!children.length) return null;
        const next = sequence(children);
        if (owner) expansions.set(next, owner);
        return next;
      };
      result = prune(result) ?? result;
      for (const id of drop) hidden.add(id);
    }
    return result;
  };
  // 3. Refuse the copies holding a transfer printed two ways; each round
  // refuses at least one more labeled edge.
  let result = expand(body);
  for (;;) {
    const actions = new Map<ParallelTransfer, TransferAction>(),
      conflicting = new Set<ParallelTransfer>();
    visitTransfers(result, language, active, (occurrence) => {
      const action = occurrenceAction(occurrence, language),
        previous = actions.get(occurrence.transfer);
      if (previous !== undefined && previous !== action) conflicting.add(occurrence.transfer);
      actions.set(occurrence.transfer, action);
    });
    const before = refused.size;
    if (conflicting.size)
      visitTransfers(result, language, active, (occurrence) => {
        const root = conflicting.has(occurrence.transfer) && roots.get(occurrence.owner);
        if (root) refused.add(root);
      });
    if (refused.size === before) break;
    result = expand(body);
  }
  return {
    body: result,
    clones,
    duplicated,
    hidden: [...hidden],
  };
}

/** Facts the loop-form planner needs from the printed program. */
export interface LoopFacts {
  /** Representative variable ids written by the printed copies of a transfer. */
  readonly writes: (transfer: ParallelTransfer) => readonly string[];
  /** Representative variable ids read by the printed copies of a transfer. */
  readonly copyReads: (transfer: ParallelTransfer) => readonly string[];
  /** The block prints nothing before its control. */
  readonly silent: (block: BlockRegion) => boolean;
  /** The block prints exactly one statement before its `if`, which that test
   * holds (the renderer's comma operand: `(x = f(), x != 0)`, `(x = f()) != 0`). */
  readonly comma: (block: BlockRegion) => boolean;
  /** The block ends in a jump and prints exactly one statement, which the test
   * of the block it alone enters holds: the id of that block. */
  readonly carrier: (block: BlockRegion) => string | undefined;
  /** The test is an ordinary printed condition (no requirement predicate). */
  readonly plain: (control: Control) => boolean;
  /** Representative variable ids read when printing the condition. */
  readonly reads: (control: Extract<Control, { kind: 'if' }>) => readonly string[];
  /** The block heads a flag-carried short-circuit test (see planFlagTests):
   * the id of its merge block, whose `if` prints the whole test. */
  readonly flag: (block: BlockRegion) => string | undefined;
  /** Any value of these variables is live entering the block. */
  readonly live: (block: string, variables: readonly string[]) => boolean;
  /** Restate a condition so it holds after the repeat copies ran; false when
   * no verified restatement exists. */
  readonly rebase: (control: Extract<Control, { kind: 'if' }>, repeat: ParallelTransfer) => boolean;
  /** Accept a `for` header: the single entry edge `init` and repeat edge `step`
   * write only induction variables (`x = x ± c`) that nothing else inside the
   * loop writes, and the test reads one. A bottom test must also be implied on
   * entry by an enclosing `if` arm (`guards`, outermost first). `header` is the
   * loop header block (a top test holds its statement when it prints one). */
  readonly induction: (loop: {
    readonly header: string;
    readonly test: Extract<Control, { kind: 'if' }>;
    readonly enter: boolean;
    readonly bottom: boolean;
    readonly init: ParallelTransfer;
    readonly step: ParallelTransfer;
    readonly inside: ReadonlySet<string>;
    readonly guards: readonly Guard[];
  }) => boolean;
}

/** An enclosing `if` arm: code inside it runs only when `condition == value`. */
export interface Guard {
  readonly control: Extract<Control, { kind: 'if' }>;
  readonly value: boolean;
}

/** Source view: the range guard of a proven jump table and its switch print as
 * one switch. A guard block ends in an `if` built from the instruction the
 * switch's `jump_table.exact_guard_instruction` names: discovery proved that
 * instruction's out-of-range edge is taken exactly when the selector exceeds
 * every case. One arm enters, copy-free, only the switch block, which prints
 * nothing and is otherwise `eligible`, and owns no `otherwise` body; the other
 * arm goes to the switch's own `otherwise` target. The switch then prints in the
 * guard's place with that other arm as its `otherwise`, so no statement, copy
 * or effect moves.
 * Returns the folded guard `if` controls by switch control id. */
export function foldSwitchGuards(
  body: Region,
  eligible: (guard: BlockRegion, target: BlockRegion) => boolean,
  copies: (transfer: ParallelTransfer) => number,
  context: OperationContext,
): { readonly body: Region; readonly guards: ReadonlyMap<string, Control> } {
  const guards = new Map<string, Control>();
  const fold = (region: Region): Region => {
    context.checkpoint(1);
    if (region.kind === 'sequence') {
      const regions = region.regions.map(fold);
      return regions.every((child, index) => child === region.regions[index])
        ? region
        : sequence(regions);
    }
    if (region.kind === 'loop') {
      const inner = fold(region.body);
      return inner === region.body ? region : { ...region, body: inner };
    }
    let changed = false;
    const control = mapArms(region.control, (arm) => {
      if (!arm.body) return arm;
      const inner = fold(arm.body);
      if (inner === arm.body) return arm;
      changed = true;
      return { ...arm, body: inner };
    });
    if (control.kind === 'if')
      for (const [inside, outside] of [
        [control.when_true, control.when_false],
        [control.when_false, control.when_true],
      ] as const) {
        const target = inside.body;
        if (target?.kind !== 'block' || target.control.kind !== 'switch') continue;
        const exact = target.control.jump_table?.exact_guard_instruction;
        if (
          exact !== undefined &&
          control.provenance.instruction_ids.includes(exact) &&
          inside.transfer.target === target.id &&
          copies(inside.transfer) === 0 &&
          !target.control.otherwise.body &&
          outside.transfer.target === target.control.otherwise.transfer.target &&
          eligible(region, target)
        ) {
          guards.set(target.control.id, region.control);
          return { ...region, control: { ...target.control, otherwise: outside } };
        }
      }
    return changed ? { ...region, control } : region;
  };
  return { body: fold(body), guards };
}

/** Choose `for (init; cond; step)`, `while (cond)` or `do { } while (cond)`
 * syntax where its side conditions hold on the final layout; other loops keep
 * `while (true)`. */
export function planLoopForms(
  body: Region,
  language: 'c-like' | 'python-like',
  facts: LoopFacts,
  context: OperationContext,
): Region {
  const incoming = new Map<string, Occurrence[]>();
  visitTransfers(body, language, context, (occurrence) => {
    const list = incoming.get(occurrence.transfer.target) ?? [];
    list.push(occurrence);
    incoming.set(occurrence.transfer.target, list);
  });
  const owned = (region: Region, into = new Set<string>()): Set<string> => {
    context.checkpoint(1);
    if (region.kind === 'sequence') for (const child of region.regions) owned(child, into);
    else if (region.kind === 'loop') owned(region.body, into);
    else {
      into.add(region.id);
      for (const arm of controlArms(region.control)) if (arm.body) owned(arm.body, into);
    }
    return into;
  };
  const choose = (
    loop: Extract<Region, { kind: 'loop' }>,
    follow: string | null,
    guards: readonly Guard[],
  ): LoopForm | undefined => {
    const entries = incoming.get(loop.header) ?? [];
    if (
      follow === null ||
      entries.some((occurrence) => occurrenceAction(occurrence, language) === 'goto')
    )
      return undefined;
    const inside = owned(loop.body);
    // A `for` header replaces exactly one entry edge falling into the loop.
    const enters = entries.filter((occurrence) => !inside.has(occurrence.block));
    const init =
      enters.length === 1 &&
      occurrenceAction(enters[0]!, language) === 'fallthrough' &&
      enters[0]!.destination?.kind === 'loop' &&
      enters[0]!.destination.header === loop.header
        ? enters[0]!.transfer
        : undefined;
    // The sole entry edge being an `if` arm, the loop is first entered only
    // when that condition took the arm's value, wherever the loop is laid out.
    const gate = init && enters[0]!.control;
    const entered: readonly Guard[] =
      gate && gate.kind === 'if'
        ? [...guards, { control: gate, value: gate.when_true.transfer === init }]
        : guards;
    // The loop syntax performs exactly this edge as its lexical break. Its
    // copies (when `copies`) print right after the loop, so no other edge from
    // inside the loop may reach the continuation.
    const exit = (arm: ControlArm, copies = false): boolean =>
      !arm.body &&
      arm.transfer.target === follow &&
      (incoming.get(follow) ?? []).some(
        (occurrence) =>
          occurrence.transfer === arm.transfer &&
          occurrenceAction(occurrence, language) === 'break',
      ) &&
      (facts.writes(arm.transfer).length === 0 ||
        (copies &&
          (incoming.get(follow) ?? []).every(
            (occurrence) => occurrence.transfer === arm.transfer || !inside.has(occurrence.block),
          )));
    const regions = loop.body.kind === 'sequence' ? loop.body.regions : [loop.body];
    // Nested sequences print as one lexical list.
    const edge = (at: 'first' | 'last'): Region | undefined => {
      let region: Region | undefined = loop.body;
      while (region?.kind === 'sequence') {
        context.checkpoint(1);
        region = at === 'first' ? region.regions[0] : region.regions.at(-1);
      }
      return region;
    };
    // The leading lexical region of a pending list.
    const unfold = (list: readonly Region[]): readonly Region[] => {
      let rest = list;
      while (rest[0]?.kind === 'sequence') {
        context.checkpoint(1);
        rest = [...rest[0].regions, ...rest.slice(1)];
      }
      return rest;
    };
    // Follow only the initial straight-line chain. A stage has one lexical
    // entry and copy-free break/stay edges; later definitions
    // never move ahead of the tests which guard them. The head of a
    // flag-carried short circuit and its merge right after it form one stage
    // that tests the merge's `if`.
    // The header alone may print one statement, which its test holds
    // (`comma`), or be a carrier jump block holding the statement of the test
    // block right after it: that statement then prints inside the loop test.
    const head = edge('first');
    const held = head?.kind === 'block' && head.id === loop.header && !facts.silent(head);
    const chain: { block: string; test: string; enter: boolean }[] = [];
    let pending: readonly Region[] = regions;
    while (pending.length) {
      context.checkpoint(1);
      pending = unfold(pending);
      const first = pending[0]!;
      if (first.kind !== 'block') break;
      const opening = held && !chain.length;
      let rest: readonly Region[] = pending.slice(1),
        tested: BlockRegion = first;
      const carried = opening ? facts.carrier(first) : undefined;
      const merge = carried ?? facts.flag(first);
      if (merge !== undefined) {
        rest = unfold(rest);
        const next = rest[0];
        if (next?.kind !== 'block' || next.id !== merge || !facts.silent(next)) break;
        tested = next;
        rest = rest.slice(1);
      }
      if (
        tested.control.kind !== 'if' ||
        !facts.plain(tested.control) ||
        !(
          facts.silent(first) ||
          (opening && (carried !== undefined || (merge === undefined && facts.comma(first))))
        ) ||
        (!chain.length && first.id !== loop.header) ||
        (chain.length > 0 && (incoming.get(first.id)?.length ?? 0) !== 1)
      )
        break;
      const control = tested.control;
      const enter = exit(control.when_false) ? true : exit(control.when_true) ? false : undefined;
      if (enter === undefined) break;
      const stay = enter ? control.when_true : control.when_false;
      if (facts.writes(stay.transfer).length) break;
      chain.push({ block: first.id, test: control.id, enter });
      pending = stay.body ? [stay.body, ...rest] : rest;
      if (pending.length && firstBlock(pending[0]!) !== stay.transfer.target) break;
    }
    const top = (): LoopForm | undefined => {
      if (chain.length > 1)
        return { kind: 'while', test: chain[0]!.test, enter: chain[0]!.enter, chain };
      const headCarrier = held && head?.kind === 'block' ? facts.carrier(head) : undefined;
      const headMerge = head?.kind === 'block' ? facts.flag(head) : undefined;
      let headTest: Extract<Control, { kind: 'if' }> | undefined;
      if (
        head?.kind === 'block' &&
        head.id === loop.header &&
        (!held || headCarrier !== undefined || (headMerge === undefined && facts.comma(head)))
      ) {
        const joined = headCarrier ?? headMerge;
        if (joined === undefined) headTest = head.control.kind === 'if' ? head.control : undefined;
        else {
          const next = unfold(unfold([loop.body]).slice(1))[0];
          if (
            next?.kind === 'block' &&
            next.id === joined &&
            next.control.kind === 'if' &&
            facts.silent(next)
          )
            headTest = next.control;
        }
      }
      if (!headTest || !facts.plain(headTest)) return undefined;
      const control = headTest,
        stayTrue = !exit(control.when_true, true),
        stayFalse = !exit(control.when_false, true);
      if (stayTrue === stayFalse) return undefined;
      // The body's lexical end is the only repeat edge: it becomes the step.
      const repeats = entries.filter((occurrence) => inside.has(occurrence.block));
      if (
        headMerge === undefined &&
        language === 'c-like' &&
        init &&
        repeats.length === 1 &&
        occurrenceAction(repeats[0]!, language) === 'fallthrough' &&
        facts.induction({
          header: loop.header,
          test: control,
          enter: stayTrue,
          bottom: false,
          init,
          step: repeats[0]!.transfer,
          inside,
          guards: entered,
        })
      )
        return { kind: 'for', test: control.id, enter: stayTrue, bottom: false };
      return { kind: 'while', test: control.id, enter: stayTrue };
    };
    const bottom = (): LoopForm | undefined => {
      const last = edge('last');
      if (
        language !== 'c-like' ||
        last?.kind !== 'block' ||
        last.control.kind !== 'if' ||
        !facts.plain(last.control)
      )
        return undefined;
      const control = last.control;
      for (const repeat of [true, false]) {
        const again = repeat ? control.when_true : control.when_false,
          leave = repeat ? control.when_false : control.when_true;
        if (
          again.body ||
          again.transfer.mode !== 'continue' ||
          again.transfer.target !== loop.header ||
          !exit(leave, true)
        )
          continue;
        // `continue` in a do-while reaches the test, so the repeat edge must be
        // the only way back to the header; outer entries only fall into it.
        if (
          entries.some(
            (occurrence) =>
              occurrence.transfer !== again.transfer &&
              (inside.has(occurrence.block) ||
                occurrenceAction(occurrence, language) !== 'fallthrough'),
          )
        )
          return undefined;
        // Repeat copies move before the test: they must be dead on exit, neither
        // the test nor the exit copies may observe them (the test may be restated
        // over their results).
        const written = facts.writes(again.transfer);
        if (facts.live(leave.transfer.target, written)) return undefined;
        const exitReads = new Set(facts.copyReads(leave.transfer));
        if (written.some((id) => exitReads.has(id))) return undefined;
        const reads = new Set(facts.reads(control));
        if (written.some((id) => reads.has(id)) && !facts.rebase(control, again.transfer))
          return undefined;
        if (
          init &&
          facts.induction({
            header: loop.header,
            test: control,
            enter: repeat,
            bottom: true,
            init,
            step: again.transfer,
            inside,
            guards: entered,
          })
        )
          return { kind: 'for', test: control.id, enter: repeat, bottom: true };
        return { kind: 'do_while', test: control.id, repeat };
      }
      return undefined;
    };
    // A header printing a statement keeps a valid bottom test: its loop already
    // reads as do-while, and its test would otherwise hold the statement.
    return held ? (bottom() ?? top()) : (top() ?? bottom());
  };
  const rebuild = (region: Region, follow: string | null, guards: readonly Guard[]): Region => {
    context.checkpoint(1);
    if (region.kind === 'sequence')
      return {
        kind: 'sequence',
        regions: region.regions.map((child, index) =>
          rebuild(child, nextEntry(region.regions, index, follow), guards),
        ),
      };
    if (region.kind === 'loop') {
      const inner = rebuild(region.body, region.header, guards);
      const form = choose(region, follow, guards);
      return form ? { ...region, body: inner, form } : { ...region, body: inner };
    }
    const control = region.control;
    // Tail-copy identity is significant to label planning; only controls with
    // owned arms require rebuilding when shaping nested loops.
    if (control.kind !== 'if' && control.kind !== 'switch') return region;
    // An owned arm body is entered only through its arm, after its test.
    return {
      ...region,
      control: mapArms(control, (item) =>
        item.body
          ? {
              ...item,
              body: rebuild(
                item.body,
                follow,
                control.kind === 'if'
                  ? [...guards, { control, value: item === control.when_true }]
                  : guards,
              ),
            }
          : item,
      ),
    };
  };
  return rebuild(body, null, []);
}

/** Source view, after loop forms: a short-circuit
 * test `if (a && b) { F } X` whose operands all leave for the next statement X,
 * X entered by those edges only, while F leaves for the statement after X,
 * prints as `if (a && b) { F } else { X }` (or `if (a || b) { X } else { F }`
 * when every operand leaves on its true arm). X becomes the `shared` body of the
 * head's leaving arm; the other operands' leaving arms `join` it. Operands are
 * copy-free tests the condition prints (`operand`, with only copy-free silent
 * jumps between them); no statement, edge copy or effect moves, and a rewrite
 * is kept only when an edge leaving F now falls through. Returns the new layout
 * and the head control ids. Optional work: exhausting its share keeps the
 * rewrites found so far. */
export function planSharedArms(
  body: Region,
  program: Reconstruction,
  language: 'c-like' | 'python-like',
  operand: (block: BlockRegion, head: boolean) => boolean,
  copies: (transfer: ParallelTransfer) => number,
  shared: OperationContext,
): { readonly body: Region; readonly heads: readonly string[] } {
  const heads: string[] = [];
  const context = optionalWork(shared, 16);
  const incoming = new Map<string, number>();
  for (const block of program.blocks.values())
    for (const transfer of controlTransfers(block.control))
      incoming.set(transfer.target, (incoming.get(transfer.target) ?? 0) + 1);
  const flatten = (region: Region): Region[] =>
    region.kind === 'sequence' ? region.regions.flatMap(flatten) : [region];
  const leaves = (arm: ControlArm, target: string): boolean =>
    !arm.body && arm.transfer.target === target && copies(arm.transfer) === 0;
  /** The operand chain from `head` whose leaving arms all reach `target`. */
  const chain = (head: BlockRegion, target: string): Map<ControlArm, BlockRegion> | null => {
    const members = new Map<ControlArm, BlockRegion>();
    let block: BlockRegion | undefined = head;
    while (block) {
      context.checkpoint(1);
      const control: Control = block.control;
      if (control.kind !== 'if' || !operand(block, block === head)) return null;
      const exit: ControlArm | undefined = leaves(control.when_true, target)
        ? control.when_true
        : leaves(control.when_false, target)
          ? control.when_false
          : undefined;
      const stay: ControlArm = exit === control.when_true ? control.when_false : control.when_true;
      if (!exit || stay.transfer.target === target) return null;
      members.set(exit, block);
      // The last operand's staying edge may carry copies and own no body.
      const parts = stay.body ? flatten(stay.body) : [],
        last = parts.at(-1);
      block =
        copies(stay.transfer) === 0 &&
        last?.kind === 'block' &&
        last.control.kind === 'if' &&
        controlArms(last.control).some((arm) => !arm.body && arm.transfer.target === target) &&
        parts
          .slice(0, -1)
          .every(
            (part, index) =>
              part.kind === 'block' &&
              part.control.kind === 'jump' &&
              part.control.transfer.target === firstBlock(parts[index + 1]!) &&
              copies(part.control.transfer) === 0 &&
              operand(part, false),
          )
          ? last
          : undefined;
    }
    return members.size >= 2 && incoming.get(target) === members.size ? members : null;
  };
  /** Mark the chain's leaving arms; the head's own owns `owned`. */
  const mark = (
    region: Region,
    members: ReadonlyMap<ControlArm, BlockRegion>,
    head: ControlArm,
    owned: Region,
    form: 'all' | 'any',
  ): Region => {
    context.checkpoint(1);
    if (region.kind === 'sequence')
      return sequence(region.regions.map((child) => mark(child, members, head, owned, form)));
    // Tail copies are recognized by identity (clones, return constants).
    if (region.kind === 'loop' || !controlArms(region.control).length) return region;
    return {
      ...region,
      control: mapArms(region.control, (arm) =>
        arm === head
          ? { ...arm, body: owned, shared: form }
          : members.has(arm)
            ? { ...arm, joins: true }
            : arm.body
              ? { ...arm, body: mark(arm.body, members, head, owned, form) }
              : arm,
      ),
    };
  };
  const gotos = (region: Region, follow: Region | null): number => {
    let count = 0;
    visitTransfers(
      region,
      language,
      context,
      (occurrence) => {
        if (occurrenceAction(occurrence, language) === 'goto') count++;
      },
      follow,
    );
    return count;
  };
  const rewrite = (region: Region, follow: Region | null): Region => {
    context.checkpoint(1);
    if (region.kind === 'loop') return { ...region, body: rewrite(region.body, region) };
    if (region.kind === 'block' && !controlArms(region.control).length) return region;
    if (region.kind === 'block')
      return {
        ...region,
        control: mapArms(region.control, (arm) =>
          arm.body ? { ...arm, body: rewrite(arm.body, follow) } : arm,
        ),
      };
    const next = (list: readonly Region[], index: number): Region | null =>
      list.slice(index + 1).find((child) => firstBlock(child) !== null) ?? follow;
    let list = region.regions.map((child, index) => rewrite(child, next(region.regions, index)));
    // Each rewrite exposes the head to the statement list again (nesting).
    for (let changed = true; changed;) {
      changed = false;
      for (let index = 0; index + 1 < list.length; index++) {
        const head = list[index]!,
          owned = list[index + 1]!,
          target = firstBlock(owned);
        if (head.kind !== 'block' || head.control.kind !== 'if' || target === null) continue;
        if (target === program.function.entry) continue;
        const members = chain(head, target);
        if (!members) continue;
        const exits = [...members.keys()];
        const own = exits.find((arm) => members.get(arm) === head)!;
        const stay =
          own === head.control.when_true ? head.control.when_false : head.control.when_true;
        // F's leaving edges then fall into the statement after X.
        const after = next(list, index + 1);
        const final = (arm: ControlArm): ControlArm => {
          if (!arm.body) return arm;
          const parts = flatten(arm.body),
            last = parts.at(-1)!;
          const inner =
            last.kind === 'block' && last.control.kind === 'if'
              ? controlArms(last.control).find((item) => members.has(item))
              : undefined;
          if (!inner || last.kind !== 'block' || last.control.kind !== 'if') return arm;
          return final(
            inner === last.control.when_true ? last.control.when_false : last.control.when_true,
          );
        };
        const branch = final(stay),
          land = leaf(after);
        if (
          branch.body
            ? gotos(branch.body, owned) <= gotos(branch.body, after)
            : !land || branch.transfer.target !== firstBlock(land)
        )
          continue;
        const form = exits.every((arm) => {
          const block = members.get(arm)!;
          return block.control.kind === 'if' && block.control.when_true === arm;
        })
          ? 'any'
          : 'all';
        list = [
          ...list.slice(0, index),
          mark(head, members, own, owned, form),
          ...list.slice(index + 2),
        ];
        heads.push(head.control.id);
        changed = true;
        break;
      }
    }
    return sequence(list);
  };
  try {
    return { body: rewrite(body, null), heads };
  } catch (error) {
    if (!(error instanceof OptionalWorkExhausted)) throw error;
    return { body, heads: [] };
  }
}
