import type { OperationContext } from '../core/index.js';
import { expressionOperands, type Value } from '../ir/index.js';
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

export type TransferAction = 'goto' | 'fallthrough' | 'break' | 'continue' | 'loop-exit';
type Nest =
  | { readonly kind: 'loop'; readonly header: string; readonly follow: string | null }
  | { readonly kind: 'switch'; readonly id: string };

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
 * original rules, where only source programs elide a goto to the follow. */
export function transferAction(
  transfer: ParallelTransfer,
  nesting: readonly Nest[],
  destination: string | null,
  language: 'c-like' | 'python-like',
  sourceView: boolean,
  sourceProgram = sourceView,
  normalizeLoopTargets = sourceView,
): TransferAction {
  if (sourceView && transfer.target === destination) return 'fallthrough';
  if (sourceView && normalizeLoopTargets) {
    const loop = [...nesting].reverse().find((item) => item.kind === 'loop');
    if (loop?.kind === 'loop') {
      if (transfer.target === loop.header) return 'continue';
      if (
        transfer.target === loop.follow &&
        (language === 'python-like' || nesting.at(-1)?.kind === 'loop')
      )
        return 'break';
    }
  }
  if (transfer.mode === 'next') return transfer.target === destination ? 'fallthrough' : 'goto';
  if (transfer.mode === 'goto')
    return sourceProgram && transfer.target === destination ? 'fallthrough' : 'goto';
  for (let i = nesting.length - 1; i >= 0; i--) {
    const item = nesting[i]!;
    if (item.kind !== 'loop') continue;
    if (transfer.loop !== item.header) return 'goto';
    // A loop may have several exits. Only its actual lexical successor can
    // use break; other destinations must keep their explicit labeled edge.
    if (transfer.mode === 'continue') return transfer.target === item.header ? 'continue' : 'goto';
    return transfer.target === item.follow &&
      (language === 'python-like' || nesting[nesting.length - 1]?.kind === 'loop')
      ? 'break'
      : 'goto';
  }
  return 'goto';
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
  private readonly words: number;
  readonly complete: boolean;

  constructor(
    private readonly program: Reconstruction,
    private readonly context: OperationContext,
    limit = 4096,
    private readonly inlined: ReadonlyMap<string, InlineSite> = new Map(),
    private readonly alternateIndices: ReadonlyMap<string, Value> = new Map(),
    /** Values printed as an operand of their reader, never as a variable. */
    omitted: ReadonlySet<string> = new Set(),
  ) {
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
      if (this.program.source?.stack_addresses.has(current.id)) {
        if (stack?.kind === 'entry') pending.push(stack.base);
        continue;
      }
      const inlined = this.inlined.get(current.id)?.node;
      if (inlined?.kind === 'load') {
        if (!this.program.source?.locals.has(inlined.id)) pending.push(inlined.address);
        const index = this.alternateIndices.get(inlined.id);
        if (index) pending.push(index);
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
        const reads: Value[] = [];
        if (node.kind === 'assign')
          reads.push(
            ...expressionOperands(program.expressions.get(node.result.id) ?? node.expression),
          );
        else if (node.kind === 'write_register') reads.push(node.value);
        else if (node.kind === 'load' || node.kind === 'store') {
          if (!program.source?.locals.has(node.id)) reads.push(node.address);
          if (node.kind === 'store') reads.push(node.value);
          const index = this.alternateIndices.get(node.id);
          if (index) reads.push(index);
        }
        if (node.kind === 'call') {
          const projection = program.calls.get(node.id);
          reads.push(...(projection?.arguments ?? node.arguments));
          for (const binding of projection?.inputs ?? node.register_inputs)
            reads.push(binding.value);
          if (node.target.kind === 'indirect') reads.push(node.target.value);
        }
        if ('register_inputs' in node)
          for (const binding of program.physical_inputs.get(node.id) ?? node.register_inputs)
            reads.push(binding.value);
        use(reads);
        const writes: Value[] = [];
        if ('result' in node) writes.push(node.result);
        if (node.kind === 'call') writes.push(...(program.calls.get(node.id)?.results ?? []));
        if (node.kind === 'call') writes.push(...node.results);
        if ('register_outputs' in node)
          for (const binding of node.register_outputs) writes.push(binding.value);
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

  /** Bound at block entry: its parameters, plus formals at the function entry. */
  bound(block: BlockRegion): number[] {
    const ids: number[] = [];
    const add = (value: Value): void => {
      const index = this.index.get(value.id);
      if (index !== undefined) ids.push(index);
    };
    block.parameters.forEach(add);
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

/** Coalesce edge copies and value-preserving assignments using SSA live-range
 * interference. `compatible` must establish interchangeable storage, including
 * any original-width read/definition conversions supplied by the renderer.
 * Assignment pairs hold equal values at their definition and may overlap there.
 * Returns value id -> representative for accepted classes. */
export function coalescePhiCopies(
  program: Reconstruction,
  liveness: VariableLiveness,
  compatible: (a: Value, b: Value) => boolean,
  context: OperationContext,
  assignments: readonly { readonly destination: Value; readonly source: Value }[] = [],
): Map<string, Value> {
  const result = new Map<string, Value>();
  if (!liveness.complete) return result;
  const candidates = new Set<number>();
  const pairs: { destination: number; source: number }[] = [];
  for (const copies of [...program.transfers.values(), assignments])
    for (const copy of copies) {
      context.checkpoint(1);
      const destination = liveness.index.get(copy.destination.id),
        source = liveness.index.get(copy.source.id);
      if (
        destination === undefined ||
        source === undefined ||
        program.inline.has(copy.source.id) ||
        !compatible(copy.destination, copy.source)
      )
        continue;
      candidates.add(destination);
      candidates.add(source);
      pairs.push({ destination, source });
    }
  if (!pairs.length) return result;
  const interference = new Map<number, Set<number>>();
  for (const id of candidates) interference.set(id, new Set());
  const conflict = (a: number, b: number): void => {
    if (a === b || !candidates.has(a) || !candidates.has(b)) return;
    interference.get(a)!.add(b);
    interference.get(b)!.add(a);
  };
  const members = [...candidates];
  const equalDefinitions = new Map<number, number>();
  for (const copy of assignments) {
    const destination = liveness.index.get(copy.destination.id),
      source = liveness.index.get(copy.source.id);
    if (destination !== undefined && source !== undefined)
      equalDefinitions.set(destination, source);
  }
  for (const block of program.blocks.values()) {
    context.checkpoint(1);
    const live = liveness.exit(block);
    const events = liveness.events(block);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      if (!event.def) {
        for (const id of event.ids) live[id >>> 5]! |= 1 << (id & 31);
        continue;
      }
      for (const id of event.ids) live[id >>> 5]! &= ~(1 << (id & 31));
      for (const id of event.ids) {
        if (!candidates.has(id)) continue;
        for (const other of event.ids) conflict(id, other);
        for (const other of members) {
          context.checkpoint(1);
          // At this copy definition the source and destination hold the same
          // value, even when a later read still uses the narrow source.
          if (liveness.has(live, other) && equalDefinitions.get(id) !== other) conflict(id, other);
        }
      }
    }
    // Parameters (and formals) are bound simultaneously at entry, on every edge.
    const entry = liveness.live(block.id)!,
      bound = liveness.bound(block);
    for (const id of bound) {
      if (!candidates.has(id)) continue;
      for (const other of bound) conflict(id, other);
      for (const other of members) {
        context.checkpoint(1);
        if (liveness.has(entry, other)) conflict(id, other);
      }
    }
  }
  const parent = new Map<number, number>(),
    classes = new Map<number, number[]>();
  for (const id of candidates) {
    parent.set(id, id);
    classes.set(id, [id]);
  }
  const find = (id: number): number => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  for (const pair of pairs) {
    const a = find(pair.destination),
      b = find(pair.source);
    if (a === b) continue;
    const left = classes.get(a)!,
      right = classes.get(b)!;
    let free = true;
    for (const x of left) {
      for (const y of right) {
        context.checkpoint(1);
        if (interference.get(x)!.has(y) || !compatible(liveness.values[x]!, liveness.values[y]!)) {
          free = false;
          break;
        }
      }
      if (!free) break;
    }
    if (!free) continue;
    parent.set(b, a);
    left.push(...right);
    classes.delete(b);
  }
  const formals = new Set(program.parameters.map((value) => value.id));
  for (const list of classes.values()) {
    if (list.length < 2) continue;
    const values = [...list].sort((a, b) => a - b).map((id) => liveness.values[id]!);
    const representative = classRepresentative(values, formals);
    for (const value of values) result.set(value.id, representative);
  }
  return result;
}

/** Formals keep their name; otherwise the earliest widest declaration. */
function classRepresentative(values: readonly Value[], formals: ReadonlySet<string>): Value {
  return (
    values.find((value) => formals.has(value.id)) ??
    values.reduce((best, value) =>
      best.type.kind === 'integer' &&
      value.type.kind === 'integer' &&
      value.type.bits > best.type.bits
        ? value
        : best,
    )
  );
}

/** In-place update coalescing: a value defined from a printed variable that
 * dies at that very definition (`y = f(x)`, no later read of `x`) shares its
 * storage, so the statement prints as `x = f(x)`; candidates are `pairs`
 * (destination, an operand leaf of its definition). Unrelated values never
 * share. Two classes join only when no member of one is live where a member of
 * the other is defined (including simultaneous block parameters and
 * loop-carried liveness) and every member pair is `compatible`. `existing`
 * classes (phi-copy coalescing) only grow. Returns the full value id ->
 * representative map, or undefined when nothing merged or the interference
 * graph is out of bounds. */
export function coalesceValues(
  program: Reconstruction,
  liveness: VariableLiveness,
  compatible: (a: Value, b: Value) => boolean,
  context: OperationContext,
  existing: ReadonlyMap<string, Value>,
  pairs: readonly { readonly destination: Value; readonly source: Value }[],
): Map<string, Value> | undefined {
  if (!liveness.complete) return undefined;
  const count = liveness.values.length,
    words = (count + 31) >>> 5;
  // The interference matrix is optional work: never starve the rest of the run.
  const allowance = Math.floor((context.remainingWork?.() ?? 0) / 8);
  let spent = 0;
  const charge = (work: number): boolean => {
    spent += work;
    context.checkpoint(work);
    return spent <= allowance;
  };
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
      if (!charge(1 + (event.def ? event.ids.length * words : event.ids.length))) return undefined;
      if (!event.def) {
        for (const id of event.ids) live[id >>> 5]! |= 1 << (id & 31);
        continue;
      }
      for (const id of event.ids) live[id >>> 5]! &= ~(1 << (id & 31));
      for (const id of event.ids) {
        for (let w = 0; w < words; w++) rows[id * words + w]! |= live[w]!;
        for (const other of event.ids) if (other !== id) mark(id, other);
      }
    }
    // Parameters (and formals) are bound simultaneously at entry, on every edge.
    const entry = liveness.live(block.id)!,
      here = liveness.bound(block);
    if (!charge(1 + here.length * words)) return undefined;
    for (const id of here) {
      for (let w = 0; w < words; w++) rows[id * words + w]! |= entry[w]!;
      for (const other of here) if (other !== id) mark(id, other);
    }
  }
  const parent = Array.from({ length: count }, (_, index) => index),
    members = new Map<number, number[]>(),
    bits = new Map<number, Uint32Array>(),
    conflicts = new Map<number, Uint32Array>();
  for (let id = 0; id < count; id++) {
    members.set(id, [id]);
    const own = new Uint32Array(words);
    own[id >>> 5]! |= 1 << (id & 31);
    bits.set(id, own);
    conflicts.set(id, rows.slice(id * words, (id + 1) * words));
  }
  const find = (id: number): number => {
    while (parent[id] !== id) id = parent[id] = parent[parent[id]!]!;
    return id;
  };
  const join = (a: number, b: number): void => {
    parent[b] = a;
    members.get(a)!.push(...members.get(b)!);
    members.delete(b);
    const bitsA = bits.get(a)!,
      bitsB = bits.get(b)!,
      rowA = conflicts.get(a)!,
      rowB = conflicts.get(b)!;
    for (let w = 0; w < words; w++) {
      bitsA[w]! |= bitsB[w]!;
      rowA[w]! |= rowB[w]!;
    }
    bits.delete(b);
    conflicts.delete(b);
  };
  for (const [id, representative] of existing) {
    const a = liveness.index.get(id),
      b = liveness.index.get(representative.id);
    if (a === undefined || b === undefined || find(a) === find(b)) continue;
    join(find(b), find(a));
  }
  const before = members.size;
  let exhausted = false;
  /** Join two classes when they never interfere and every member pair is compatible. */
  const attempt = (a: number, b: number): boolean => {
    const bitsA = bits.get(a)!,
      bitsB = bits.get(b)!,
      rowA = conflicts.get(a)!,
      rowB = conflicts.get(b)!;
    if (!charge(words)) {
      exhausted = true;
      return false;
    }
    for (let w = 0; w < words; w++)
      if (((rowA[w]! & bitsB[w]!) | (rowB[w]! & bitsA[w]!)) !== 0) return false;
    const left = members.get(a)!,
      right = members.get(b)!;
    if (!charge(left.length * right.length)) {
      exhausted = true;
      return false;
    }
    for (const x of left)
      for (const y of right)
        if (!compatible(liveness.values[x]!, liveness.values[y]!)) return false;
    join(a, b);
    return true;
  };
  for (const pair of pairs) {
    if (exhausted) break;
    const d = liveness.index.get(pair.destination.id),
      s = liveness.index.get(pair.source.id);
    if (d === undefined || s === undefined) continue;
    const a = find(d),
      b = find(s);
    if (a !== b) attempt(a, b);
  }
  const formals = new Set(program.parameters.map((value) => value.id));
  if (members.size === before) return undefined;
  const result = new Map<string, Value>();
  for (const list of members.values()) {
    if (list.length < 2) continue;
    const values = [...list].sort((a, b) => a - b).map((id) => liveness.values[id]!);
    const representative = classRepresentative(values, formals);
    for (const value of values) result.set(value.id, representative);
  }
  return result;
}

export interface Occurrence {
  readonly transfer: ParallelTransfer;
  readonly control: Control;
  /** Block owning the control; a duplicated tail reports its home identity. */
  readonly block: string;
  /** Region reached when the transfer prints nothing; null at the function end. */
  readonly destination: Region | null;
  readonly nesting: readonly Nest[];
}

function leaf(region: Region | null): Region | null {
  while (region?.kind === 'sequence') {
    const next = region.regions.find((child) => firstBlock(child) !== null);
    if (!next) return null;
    region = next;
  }
  return region;
}

/** Visit every printed transfer occurrence with its lexical destination. */
export function visitTransfers(
  body: Region,
  language: 'c-like' | 'python-like',
  context: OperationContext,
  visit: (occurrence: Occurrence) => void,
): void {
  const walk = (region: Region, follow: Region | null, nesting: readonly Nest[]): void => {
    context.checkpoint(1);
    if (region.kind === 'sequence') {
      for (let i = 0; i < region.regions.length; i++) {
        let next = follow;
        for (let j = i + 1; j < region.regions.length; j++)
          if (firstBlock(region.regions[j]!) !== null) {
            next = region.regions[j]!;
            break;
          }
        walk(region.regions[i]!, next, nesting);
      }
      return;
    }
    if (region.kind === 'loop') {
      const after = leaf(follow);
      walk(region.body, region, [
        ...nesting,
        { kind: 'loop', header: region.header, follow: after ? firstBlock(after) : null },
      ]);
      return;
    }
    const control = region.control;
    if (control.kind === 'jump')
      visit({
        transfer: control.transfer,
        control,
        block: region.id,
        destination: leaf(follow),
        nesting,
      });
    const nested: readonly Nest[] =
      control.kind === 'switch' && language === 'c-like'
        ? [...nesting, { kind: 'switch', id: control.id }]
        : nesting;
    for (const arm of controlArms(control)) {
      visit({
        transfer: arm.transfer,
        control,
        block: region.id,
        destination: leaf(arm.body ?? follow),
        nesting: nested,
      });
      if (arm.body) walk(arm.body, follow, nested);
    }
  };
  walk(body, null, []);
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

export interface LoopExitRoute {
  readonly loop: string;
  /** Breakable scopes, innermost first, ending at the target loop. */
  readonly through: readonly string[];
}

/** A boolean is needed only when a real edge bypasses two or more breakable
 * scopes to an enclosing loop's exact continuation. No arbitrary target, loop
 * entry, or irreducible edge is rewritten. */
export function planLoopExits(
  body: Region,
  language: 'c-like' | 'python-like',
  context: OperationContext,
): ReadonlyMap<ParallelTransfer, LoopExitRoute> {
  const routes = new Map<ParallelTransfer, LoopExitRoute>();
  const unsafeEntries = new Set<string>();
  visitTransfers(body, language, context, (occurrence) => {
    if (occurrenceAction(occurrence, language) !== 'goto') return;
    const scopes = occurrence.nesting;
    if (
      !scopes.some((scope) => scope.kind === 'loop' && scope.header === occurrence.transfer.target)
    )
      unsafeEntries.add(occurrence.transfer.target);
    for (let index = scopes.length - 1; index >= 0; index--) {
      const scope = scopes[index]!;
      if (scope.kind !== 'loop' || scope.follow !== occurrence.transfer.target) continue;
      if (index < scopes.length - 1)
        routes.set(occurrence.transfer, {
          loop: scope.header,
          through: scopes
            .slice(index)
            .reverse()
            .map((item) => (item.kind === 'loop' ? item.header : item.id)),
        });
      break;
    }
  });
  for (const [transfer, route] of routes)
    if (unsafeEntries.has(route.loop)) routes.delete(transfer);
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
  /** Regions ordered by CFG dependencies or placed with all their incoming edges. */
  readonly ordered: readonly string[];
  /** Terminal blocks moved to their only edge, or right after the only loop
   * entering them (`at`: the edge target or the loop header). */
  readonly relocated: readonly { readonly block: string; readonly at: string }[];
  /** Tails whose every incoming edge now ends in an owned copy. */
  readonly hidden: readonly string[];
  /** Exit blocks moved onto their only loop edge so the loop's other exits
   * share one successor (`at`: the edge target the block was entered from). */
  readonly merged: readonly { readonly block: string; readonly at: string }[];
}

/** Layout-only source-view rewrites. Every change keeps the original block and
 * transfer objects; the renderer re-derives lexical actions from the result
 * and the control validators check each emitted edge independently. `silent`
 * accepts expression-only tails; `small` optionally accepts bounded statement
 * tails. Every copied path runs the same statements once, then returns. */
export function planLayout(
  body: Region,
  program: Reconstruction,
  language: 'c-like' | 'python-like',
  silent: (block: BlockRegion) => boolean,
  /** Number of edge copies the transfer prints (after phi-copy coalescing). */
  copies: (transfer: ParallelTransfer) => number,
  context: OperationContext,
  small: (block: BlockRegion) => boolean = silent,
): LayoutPlan {
  const clones = new Set<BlockRegion>();
  const duplicated: { transfer: ParallelTransfer; tail: string }[] = [];
  const relocated: { block: string; at: string }[] = [];
  const blocks = program.blocks;
  const ordered: string[] = [];
  const incomingEdges = new Map<string, { block: string; transfer: ParallelTransfer }[]>();
  for (const block of blocks.values())
    for (const transfer of controlTransfers(block.control)) {
      const edges = incomingEdges.get(transfer.target) ?? [];
      edges.push({ block: block.id, transfer });
      incomingEdges.set(transfer.target, edges);
    }
  // Place a shared continuation in the smallest owned region containing all
  // of its incoming edges. A loop's continuation goes after it, never inside.
  const attach = (
    region: Region,
    transfers: readonly ParallelTransfer[],
    target: Region,
    depth = 0,
  ): Region | null => {
    context.checkpoint(1);
    if (depth >= 32) return null;
    const contained = new Set<ParallelTransfer>();
    const collect = (child: Region): void => {
      context.checkpoint(1);
      if (child.kind === 'sequence') child.regions.forEach(collect);
      else if (child.kind === 'loop') collect(child.body);
      else {
        for (const edge of controlTransfers(child.control)) contained.add(edge);
        for (const arm of controlArms(child.control)) if (arm.body) collect(arm.body);
      }
    };
    collect(region);
    if (!transfers.every((transfer) => contained.has(transfer))) return null;
    if (region.kind === 'loop') return sequence([region, target]);
    if (region.kind === 'sequence') {
      for (let index = 0; index < region.regions.length; index++) {
        const changed = attach(region.regions[index]!, transfers, target, depth + 1);
        if (changed)
          return sequence(region.regions.map((child, i) => (i === index ? changed : child)));
      }
      return sequence([...region.regions, target]);
    }
    const transfer = transfers.length === 1 ? transfers[0] : undefined;
    if (region.control.kind === 'jump' && region.control.transfer === transfer)
      return sequence([region, target]);
    let found = false;
    const control = mapArms(region.control, (arm) => {
      if (arm.transfer === transfer && !arm.body) {
        found = true;
        return { ...arm, body: target };
      }
      const changed = arm.body ? attach(arm.body, transfers, target, depth + 1) : null;
      if (changed) {
        found = true;
        return { ...arm, body: changed };
      }
      return arm;
    });
    return found ? { ...region, control } : sequence([region, target]);
  };
  const shallow = (region: Region, depth = 0): boolean => {
    context.checkpoint(1);
    if (depth >= 16) return false;
    if (region.kind === 'sequence')
      return region.regions.every((child) => shallow(child, depth + 1));
    if (region.kind === 'loop') return shallow(region.body, depth + 1);
    return controlArms(region.control).every((arm) => !arm.body || shallow(arm.body, depth + 1));
  };
  // Structuring reduces successors first, which can leave shared continuations
  // before their predecessors. Order whole owned regions, never instructions.
  // Cyclic sibling dependencies are irreducible here and retain explicit edges.
  const order = (region: Region, header: string | null = null): Region => {
    context.checkpoint(1);
    if (region.kind === 'loop') return { ...region, body: order(region.body, region.header) };
    if (region.kind === 'block')
      return {
        ...region,
        control: mapArms(region.control, (arm) =>
          arm.body ? { ...arm, body: order(arm.body, header) } : arm,
        ),
      };
    const children = region.regions.map((child) => order(child, header));
    const owner = new Map<string, number>();
    const targets: Set<string>[] = children.map(() => new Set());
    const collect = (child: Region, index: number): void => {
      context.checkpoint(1);
      if (child.kind === 'sequence') child.regions.forEach((item) => collect(item, index));
      else if (child.kind === 'loop') collect(child.body, index);
      else {
        owner.set(child.id, index);
        for (const transfer of controlTransfers(child.control))
          targets[index]!.add(transfer.target);
        for (const arm of controlArms(child.control)) if (arm.body) collect(arm.body, index);
      }
    };
    children.forEach(collect);
    const outgoing = targets.map(
      (ids, index) =>
        new Set(
          [...ids].flatMap((id) => {
            // Header backedges are performed by the enclosing loop, not
            // sibling dependencies. Other cycles remain irreducible.
            const next = id === header ? undefined : owner.get(id);
            return next === undefined || next === index ? [] : [next];
          }),
        ),
    );
    const incoming = children.map(() => 0);
    for (const successors of outgoing) for (const next of successors) incoming[next]!++;
    const ready = incoming.flatMap((count, index) => (count === 0 ? [index] : [])).reverse();
    const indices: number[] = [];
    // Prefer a newly ready continuation over an unrelated pending sibling.
    // In particular, a loop's sole exit belongs immediately after that loop.
    while (ready.length) {
      const index = ready.pop()!;
      indices.push(index);
      for (const next of outgoing[index]!) {
        context.checkpoint(1);
        if (--incoming[next]! === 0) ready.push(next);
      }
    }
    if (indices.length !== children.length || indices[0] !== 0) return sequence(children);
    if (indices.some((index, position) => index !== position)) {
      for (const child of children) {
        const id = firstBlock(child);
        if (id !== null) ordered.push(id);
      }
    }
    const owned: (Region | null)[] = [...children];
    // Work backwards, then revisit joins exposed by earlier ownership moves.
    // Every successful round removes a sibling; cycles cannot be absorbed.
    const candidates = [...indices].reverse();
    let moved = true;
    while (moved) {
      moved = false;
      for (const index of candidates) {
        context.checkpoint(1);
        const target = owned[index];
        if (!target || index === 0 || !shallow(target)) continue;
        const members = new Set(
          [...owner].filter(([, value]) => value === index).map(([id]) => id),
        );
        const edges = [...members].flatMap((id) =>
          (incomingEdges.get(id) ?? []).filter((edge) => !members.has(edge.block)),
        );
        if (!edges.length || edges.some((edge) => edge.transfer.target !== firstBlock(target)))
          continue;
        const edge = edges[0]!,
          source = owner.get(edge.block);
        if (
          source === undefined ||
          source === index ||
          !owned[source] ||
          edges.some((edge) => owner.get(edge.block) !== source)
        )
          continue;
        const changed = attach(
          owned[source]!,
          edges.map((edge) => edge.transfer),
          target,
        );
        if (!changed) continue;
        owned[source] = changed;
        owned[index] = null;
        for (const id of members) owner.set(id, source);
        ordered.push(edge.transfer.target);
        moved = true;
      }
    }
    return sequence(indices.flatMap((index) => (owned[index] ? [owned[index]!] : [])));
  };
  body = order(body);
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
      if (control.kind === 'return') size = 1;
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
  const isTail = (id: string): boolean => tailSize(id) > 0;
  // Each copy prints at most four edge copies and one return per level (depth <= 4).
  let budget = 128;
  const clone = (id: string, transfer: ParallelTransfer): Region => {
    const block = blocks.get(id)!,
      copy: BlockRegion = { ...block };
    clones.add(copy);
    duplicated.push({ transfer, tail: id });
    budget--;
    const control = block.control;
    return control.kind === 'jump'
      ? sequence([copy, clone(control.transfer.target, control.transfer)])
      : copy;
  };

  // 1. A terminal block entered only from one loop is placed right after it, so
  // its edges become breaks, when every other exit of that loop is a tail.
  const predecessors = new Map<string, Set<string>>();
  for (const block of blocks.values())
    for (const transfer of controlTransfers(block.control)) {
      context.checkpoint(1);
      const list = predecessors.get(transfer.target) ?? new Set<string>();
      list.add(block.id);
      predecessors.set(transfer.target, list);
    }
  const scan = (region: Region, owned: Set<string>, targets: Set<string>): void => {
    context.checkpoint(1);
    if (region.kind === 'sequence') for (const child of region.regions) scan(child, owned, targets);
    else if (region.kind === 'loop') scan(region.body, owned, targets);
    else {
      owned.add(region.id);
      for (const transfer of controlTransfers(region.control)) targets.add(transfer.target);
      for (const arm of controlArms(region.control)) if (arm.body) scan(arm.body, owned, targets);
    }
  };
  const terminal = (id: string): boolean => {
    const kind = blocks.get(id)?.control.kind;
    return kind === 'return' || kind === 'trap' || kind === 'unknown' || kind === 'indirect';
  };
  // A terminal block whose only CFG edge is labeled moves onto that edge.
  const edges = new Map<string, number>();
  for (const block of blocks.values())
    for (const transfer of controlTransfers(block.control))
      edges.set(transfer.target, (edges.get(transfer.target) ?? 0) + 1);
  // 0. A loop's lexical successor is the exit most of its edges reach, so those
  // edges become breaks instead of tail copies. Every other exit is either a
  // tail (still copied) or a block entered by one loop edge only, which then
  // moves onto that edge and ends in a break or a tail copy.
  const merged: { block: string; at: string }[] = [];
  const successors = (region: Region, owned: ReadonlySet<string>, counts: Map<string, number>) => {
    context.checkpoint(1);
    if (region.kind === 'sequence')
      for (const child of region.regions) successors(child, owned, counts);
    else if (region.kind === 'loop') successors(region.body, owned, counts);
    else {
      for (const transfer of controlTransfers(region.control))
        if (!owned.has(transfer.target))
          counts.set(transfer.target, (counts.get(transfer.target) ?? 0) + 1);
      for (const arm of controlArms(region.control))
        if (arm.body) successors(arm.body, owned, counts);
    }
  };
  /** `home` placed where the only edge to `id` leaves the region. */
  const embed = (region: Region, id: string, home: BlockRegion): Region | null => {
    context.checkpoint(1);
    if (region.kind === 'sequence') {
      for (let index = 0; index < region.regions.length; index++) {
        const changed = embed(region.regions[index]!, id, home);
        if (changed)
          return sequence(region.regions.map((child, i) => (i === index ? changed : child)));
      }
      return null;
    }
    if (region.kind === 'loop') {
      const changed = embed(region.body, id, home);
      return changed && { ...region, body: changed };
    }
    if (region.control.kind === 'jump')
      return region.control.transfer.target === id ? sequence([region, home]) : null;
    let found = false;
    const control = mapArms(region.control, (arm) => {
      if (found) return arm;
      if (!arm.body && arm.transfer.target === id) {
        found = true;
        return { ...arm, body: home };
      }
      const changed = arm.body ? embed(arm.body, id, home) : null;
      if (changed) {
        found = true;
        return { ...arm, body: changed };
      }
      return arm;
    });
    return found ? { ...region, control } : null;
  };
  const joinExits = (children: Region[], index: number): Region[] | null => {
    const loop = children[index]!;
    if (loop.kind !== 'loop') return null;
    const owned = new Set<string>(),
      counts = new Map<string, number>();
    scan(loop.body, owned, new Set());
    successors(loop.body, owned, counts);
    let shared: string | null = null,
      top = 1,
      tie = false;
    for (const [id, count] of counts) {
      if (count > top) [shared, top, tie] = [id, count, false];
      else if (count === top && shared !== null) tie = true;
    }
    if (shared === null || tie) return null;
    const siblingBlock = (id: string): number =>
      children.findIndex((child, at) => at > index && child.kind === 'block' && child.id === id);
    const sharedIndex = siblingBlock(shared);
    if (sharedIndex < 0) return null;
    const sunk = new Map<number, BlockRegion>();
    let inside: Region = loop;
    for (const id of counts.keys()) {
      if (id === shared) continue;
      const at = siblingBlock(id),
        sibling = at < 0 ? undefined : (children[at] as BlockRegion),
        entries = incomingEdges.get(id) ?? [];
      if (
        sibling &&
        id !== program.function.entry &&
        entries.length === 1 &&
        owned.has(entries[0]!.block) &&
        (terminal(id) ||
          (sibling.control.kind === 'jump' &&
            (sibling.control.transfer.target === shared ||
              isTail(sibling.control.transfer.target))))
      ) {
        const embedded = embed(inside, id, sibling);
        if (!embedded) return null;
        inside = embedded;
        sunk.set(at, sibling);
      } else if (!isTail(id)) return null;
    }
    if (!sunk.size) return null;
    const result = children.flatMap((child, at) =>
      at === index ? [inside] : sunk.has(at) ? [] : [child],
    );
    // Only the shared exit may follow the loop, and every edge of the loop
    // (including the moved blocks') that reaches it must print as a break.
    const next = result.findIndex((child, at) => at > index && firstBlock(child) !== null);
    if (next < 0 || firstBlock(result[next]!) !== shared) return null;
    let exact = true;
    visitTransfers(sequence(result), language, context, (occurrence) => {
      if (
        occurrence.transfer.target === shared &&
        (owned.has(occurrence.block) ||
          [...sunk.values()].some((s) => s.id === occurrence.block)) &&
        occurrenceAction(occurrence, language) !== 'break'
      )
        exact = false;
    });
    if (!exact) return null;
    for (const block of sunk.values())
      merged.push({
        block: block.id,
        at: incomingEdges.get(block.id)![0]!.transfer.target,
      });
    return result;
  };
  const consolidate = (region: Region): Region => {
    context.checkpoint(1);
    if (region.kind === 'loop') {
      const inner = consolidate(region.body);
      return inner === region.body ? region : { ...region, body: inner };
    }
    if (region.kind === 'block') {
      let changed = false;
      const control = mapArms(region.control, (arm) => {
        if (!arm.body) return arm;
        const inner = consolidate(arm.body);
        if (inner === arm.body) return arm;
        changed = true;
        return { ...arm, body: inner };
      });
      return changed ? { ...region, control } : region;
    }
    const children = region.regions.map(consolidate);
    const changed = children.some((child, index) => child !== region.regions[index]);
    // A loop and the exit that follows it may sit in different nested
    // sequences; sequences carry no layout of their own, so join on the flat list.
    let flat = children.flatMap(function flatten(child): Region[] {
      return child.kind === 'sequence' ? child.regions.flatMap(flatten) : [child];
    });
    let joinedAny = false;
    for (let index = 0; index < flat.length; index++) {
      const joined = joinExits(flat, index);
      if (joined) {
        flat = joined;
        joinedAny = true;
      }
    }
    return joinedAny ? sequence(flat) : changed ? sequence(children) : region;
  };
  body = consolidate(body);
  const sinks = new Map<ParallelTransfer, string>();
  visitTransfers(body, language, context, (occurrence) => {
    const id = occurrence.transfer.target;
    if (
      edges.get(id) === 1 &&
      terminal(id) &&
      !isTail(id) &&
      id !== program.function.entry &&
      occurrenceAction(occurrence, language) === 'goto'
    )
      sinks.set(occurrence.transfer, id);
  });
  const moves = new Map<string, string>();
  const placed = new Set<string>(sinks.values());
  const findMoves = (region: Region, follow: string | null): void => {
    context.checkpoint(1);
    if (region.kind === 'sequence') {
      region.regions.forEach((child, index) =>
        findMoves(child, nextEntry(region.regions, index, follow)),
      );
      return;
    }
    if (region.kind === 'loop') {
      const owned = new Set<string>(),
        targets = new Set<string>();
      scan(region.body, owned, targets);
      const exits = [...targets].filter((id) => !owned.has(id));
      const movable = exits.filter(
        (id) =>
          id !== follow &&
          terminal(id) &&
          (!isTail(id) || (predecessors.get(id)?.size ?? 0) > 1) &&
          !placed.has(id) &&
          [...(predecessors.get(id) ?? [])].every((previous) => owned.has(previous)),
      );
      if (movable.length === 1 && exits.every((id) => id === movable[0] || isTail(id))) {
        moves.set(region.header, movable[0]!);
        placed.add(movable[0]!);
      }
      findMoves(region.body, region.header);
      return;
    }
    for (const arm of controlArms(region.control)) if (arm.body) findMoves(arm.body, follow);
  };
  findMoves(body, null);
  let presented = body;
  if (placed.size) {
    const homes = new Map<string, BlockRegion>();
    // Only sequence elements move: an owned arm body has a unique predecessor.
    const lift = (region: Region): Region => {
      context.checkpoint(1);
      if (region.kind === 'block')
        return {
          ...region,
          control: mapArms(region.control, (item) =>
            item.body ? { ...item, body: lift(item.body) } : item,
          ),
        };
      if (region.kind === 'loop') return { ...region, body: lift(region.body) };
      const children: Region[] = [];
      for (const child of region.regions)
        if (child.kind === 'block' && placed.has(child.id)) homes.set(child.id, child);
        else children.push(lift(child));
      return sequence(children);
    };
    const lifted = lift(body);
    const home = (transfer: ParallelTransfer): BlockRegion | undefined => {
      const id = sinks.get(transfer),
        region = id === undefined ? undefined : homes.get(id);
      if (region) relocated.push({ block: region.id, at: transfer.target });
      return region;
    };
    const place = (region: Region): Region => {
      context.checkpoint(1);
      if (region.kind === 'block') {
        const control = region.control;
        if (control.kind === 'jump') {
          const sunk = home(control.transfer);
          return sunk ? sequence([region, sunk]) : region;
        }
        return {
          ...region,
          control: mapArms(control, (item) => {
            if (item.body) return { ...item, body: place(item.body) };
            const sunk = home(item.transfer);
            return sunk ? { ...item, body: sunk } : item;
          }),
        };
      }
      if (region.kind === 'sequence') return sequence(region.regions.map(place));
      const loop = { ...region, body: place(region.body) },
        moved = moves.get(region.header),
        after = moved === undefined ? undefined : homes.get(moved);
      if (!after) return loop;
      relocated.push({ block: after.id, at: region.header });
      return sequence([loop, after]);
    };
    // Every lifted block must land again, or the layout is left unchanged.
    if (homes.size === placed.size) {
      presented = place(lifted);
      if (relocated.length !== placed.size) {
        presented = body;
        relocated.length = 0;
      }
    }
  }

  // 2. Each labeled edge into a tail ends in an owned copy of the tail instead.
  // A jump and the copied continuation it owns are removed together if the
  // jump's home becomes unreachable. Otherwise its orphan return would remain
  // after another terminal block, despite having no incoming edge.
  const expansions = new Map<Region, BlockRegion>();
  const duplicate = (region: Region, follow: string | null, nesting: readonly Nest[]): Region => {
    context.checkpoint(1);
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
        ? [...nesting, { kind: 'switch', id: control.id }]
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
  presented = duplicate(presented, null, []);

  // 3. A tail no longer reached lexically at home is printed only as its copies.
  const hidden = new Set<string>();
  for (let round = 0; clones.size && round <= tails.size; round++) {
    const reached = new Set<string>();
    visitTransfers(presented, language, context, (occurrence) => {
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
      context.checkpoint(1);
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
    presented = prune(presented) ?? presented;
    for (const id of drop) hidden.add(id);
  }
  return { body: presented, clones, duplicated, relocated, merged, ordered, hidden: [...hidden] };
}

/** Facts the loop-form planner needs from the printed program. */
export interface LoopFacts {
  /** Representative variable ids written by the printed copies of a transfer. */
  readonly writes: (transfer: ParallelTransfer) => readonly string[];
  /** Representative variable ids read by the printed copies of a transfer. */
  readonly copyReads: (transfer: ParallelTransfer) => readonly string[];
  /** The block prints nothing before its control. */
  readonly silent: (block: BlockRegion) => boolean;
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
   * entry by an enclosing `if` arm (`guards`, outermost first). */
  readonly induction: (loop: {
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
    const chain: { block: string; test: string; enter: boolean }[] = [];
    let pending: readonly Region[] = regions;
    while (pending.length) {
      context.checkpoint(1);
      pending = unfold(pending);
      const first = pending[0]!;
      if (first.kind !== 'block') break;
      let rest: readonly Region[] = pending.slice(1),
        tested: BlockRegion = first;
      const merge = facts.flag(first);
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
        !facts.silent(first) ||
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
    if (chain.length > 1)
      return { kind: 'while', test: chain[0]!.test, enter: chain[0]!.enter, chain };
    const head = edge('first');
    const headMerge = head?.kind === 'block' ? facts.flag(head) : undefined;
    let headTest: Extract<Control, { kind: 'if' }> | undefined;
    if (head?.kind === 'block' && head.id === loop.header && facts.silent(head)) {
      if (headMerge === undefined) headTest = head.control.kind === 'if' ? head.control : undefined;
      else {
        const next = unfold(unfold([loop.body]).slice(1))[0];
        if (
          next?.kind === 'block' &&
          next.id === headMerge &&
          next.control.kind === 'if' &&
          facts.silent(next)
        )
          headTest = next.control;
      }
    }
    if (headTest && facts.plain(headTest)) {
      const control = headTest,
        stayTrue = !exit(control.when_true, true),
        stayFalse = !exit(control.when_false, true);
      if (stayTrue !== stayFalse) {
        // The body's lexical end is the only repeat edge: it becomes the step.
        const repeats = entries.filter((occurrence) => inside.has(occurrence.block));
        if (
          headMerge === undefined &&
          language === 'c-like' &&
          init &&
          repeats.length === 1 &&
          occurrenceAction(repeats[0]!, language) === 'fallthrough' &&
          facts.induction({
            test: control,
            enter: stayTrue,
            bottom: false,
            init,
            step: repeats[0]!.transfer,
            inside,
            guards,
          })
        )
          return { kind: 'for', test: control.id, enter: stayTrue, bottom: false };
        return { kind: 'while', test: control.id, enter: stayTrue };
      }
    }
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
          test: control,
          enter: repeat,
          bottom: true,
          init,
          step: again.transfer,
          inside,
          guards,
        })
      )
        return { kind: 'for', test: control.id, enter: repeat, bottom: true };
      return { kind: 'do_while', test: control.id, repeat };
    }
    return undefined;
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
