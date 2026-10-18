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

export type TransferAction = 'goto' | 'fallthrough' | 'break' | 'continue';
type Nest =
  | { readonly kind: 'loop'; readonly header: string; readonly follow: string | null }
  | { readonly kind: 'switch' };

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
): TransferAction {
  if (sourceView && transfer.target === destination) return 'fallthrough';
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
  ) {
    const source = program.source;
    for (const value of program.values.values()) {
      context.checkpoint(1);
      if (
        !program.live.has(value.id) ||
        program.inline.has(value.id) ||
        inlined.has(value.id) ||
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
    // Formals keep their name; otherwise choose the earliest widest declaration.
    const values = [...list].sort((a, b) => a - b).map((id) => liveness.values[id]!);
    const representative =
      values.find((value) => formals.has(value.id)) ??
      values.reduce((best, value) =>
        best.type.kind === 'integer' &&
        value.type.kind === 'integer' &&
        value.type.bits > best.type.bits
          ? value
          : best,
      );
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
        ? [...nesting, { kind: 'switch' }]
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
  /** Terminal blocks moved to their only edge, or right after the only loop
   * entering them (`at`: the edge target or the loop header). */
  readonly relocated: readonly { readonly block: string; readonly at: string }[];
  /** Tails whose every incoming edge now ends in an owned copy. */
  readonly hidden: readonly string[];
}

/** Layout-only source-view rewrites. Every change keeps the original block and
 * transfer objects; the renderer re-derives lexical actions from the result
 * and the control validators check each emitted edge independently. `silent`
 * accepts blocks printing nothing but their control; a tail is a silent block
 * ending in a plain `return`, or in a bounded-copy jump to another tail. */
export function planLayout(
  body: Region,
  program: Reconstruction,
  language: 'c-like' | 'python-like',
  silent: (block: BlockRegion) => boolean,
  /** Number of edge copies the transfer prints (after phi-copy coalescing). */
  copies: (transfer: ParallelTransfer) => number,
  context: OperationContext,
): LayoutPlan {
  const clones = new Set<BlockRegion>();
  const duplicated: { transfer: ParallelTransfer; tail: string }[] = [];
  const relocated: { block: string; at: string }[] = [];
  const blocks = program.blocks;
  const tails = new Map<string, boolean>();
  const isTail = (id: string, depth = 0): boolean => {
    const known = tails.get(id);
    if (known !== undefined) return known;
    const block = blocks.get(id);
    let result = false;
    if (block && id !== program.function.entry && depth < 4 && silent(block)) {
      const control = block.control;
      result =
        control.kind === 'return' ||
        (control.kind === 'jump' &&
          control.transfer.target !== id &&
          copies(control.transfer) <= 4 &&
          isTail(control.transfer.target, depth + 1));
    }
    tails.set(id, result);
    return result;
  };
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
      budget > 0 &&
      isTail(transfer.target) &&
      transferAction(transfer, nested, destination, language, true) === 'goto';
    if (control.kind === 'jump') {
      if (!labeled(control.transfer, follow, nesting)) return region;
      const expanded = sequence([region, clone(control.transfer.target, control.transfer)]);
      expansions.set(expanded, region);
      return expanded;
    }
    const nested: readonly Nest[] =
      control.kind === 'switch' && language === 'c-like'
        ? [...nesting, { kind: 'switch' }]
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
  return { body: presented, clones, duplicated, relocated, hidden: [...hidden] };
}

/** Facts the loop-form planner needs from the printed program. */
export interface LoopFacts {
  /** Representative variable ids written by the printed copies of a transfer. */
  readonly writes: (transfer: ParallelTransfer) => readonly string[];
  /** The block prints nothing before its control. */
  readonly silent: (block: BlockRegion) => boolean;
  /** The test is an ordinary printed condition (no requirement predicate). */
  readonly plain: (control: Control) => boolean;
  /** Representative variable ids read when printing the condition. */
  readonly reads: (control: Extract<Control, { kind: 'if' }>) => readonly string[];
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
    // The loop syntax performs exactly this edge: a copy-free lexical break.
    const exit = (arm: ControlArm): boolean =>
      !arm.body &&
      arm.transfer.target === follow &&
      facts.writes(arm.transfer).length === 0 &&
      (incoming.get(follow) ?? []).some(
        (occurrence) =>
          occurrence.transfer === arm.transfer &&
          occurrenceAction(occurrence, language) === 'break',
      );
    const regions = loop.body.kind === 'sequence' ? loop.body.regions : [loop.body];
    // Follow only the initial straight-line chain. A stage has one lexical
    // entry and copy-free break/stay edges; later definitions
    // never move ahead of the tests which guard them.
    const chain: { block: string; test: string; enter: boolean }[] = [];
    let pending: readonly Region[] = regions;
    while (pending.length) {
      context.checkpoint(1);
      const first = pending[0]!;
      if (first.kind === 'sequence') {
        pending = [...first.regions, ...pending.slice(1)];
        continue;
      }
      if (
        first.kind !== 'block' ||
        first.control.kind !== 'if' ||
        !facts.plain(first.control) ||
        !facts.silent(first) ||
        (!chain.length && first.id !== loop.header) ||
        (chain.length > 0 && (incoming.get(first.id)?.length ?? 0) !== 1)
      )
        break;
      const control = first.control;
      const enter = exit(control.when_false) ? true : exit(control.when_true) ? false : undefined;
      if (enter === undefined) break;
      const stay = enter ? control.when_true : control.when_false;
      if (facts.writes(stay.transfer).length) break;
      chain.push({ block: first.id, test: control.id, enter });
      pending = stay.body ? [stay.body, ...pending.slice(1)] : pending.slice(1);
      if (pending.length && firstBlock(pending[0]!) !== stay.transfer.target) break;
    }
    if (chain.length > 1)
      return { kind: 'while', test: chain[0]!.test, enter: chain[0]!.enter, chain };
    const head = regions[0];
    if (
      head?.kind === 'block' &&
      head.id === loop.header &&
      head.control.kind === 'if' &&
      facts.plain(head.control) &&
      facts.silent(head)
    ) {
      const control = head.control,
        stayTrue = !exit(control.when_true),
        stayFalse = !exit(control.when_false);
      if (stayTrue !== stayFalse) {
        // The body's lexical end is the only repeat edge: it becomes the step.
        const repeats = entries.filter((occurrence) => inside.has(occurrence.block));
        if (
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
    const last = regions.at(-1);
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
        !exit(leave)
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
      // Repeat copies move before the test: they must be dead on exit and the
      // test must not observe them (or be restated over their results).
      const written = facts.writes(again.transfer);
      if (facts.live(leave.transfer.target, written)) return undefined;
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
