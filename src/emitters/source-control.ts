import type { OperationContext } from '../core/index.js';
import { expressionOperands, type Expression, type Value } from '../ir/index.js';
import type {
  BlockRegion,
  Control,
  ControlArm,
  LoopForm,
  ParallelTransfer,
  Region,
} from '../presentation/index.js';
import type { Reconstruction } from '../reconstruction/model.js';

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
  if (control.kind !== 'if' || control.id !== form.test) return [];
  if (form.kind !== 'do_while')
    return [{ arm: form.enter ? control.when_false : control.when_true, action: 'break' }];
  return [
    { arm: form.repeat ? control.when_true : control.when_false, action: 'continue' },
    { arm: form.repeat ? control.when_false : control.when_true, action: 'break' },
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
  ) {
    const source = program.source;
    for (const value of program.values.values()) {
      context.checkpoint(1);
      if (
        !program.live.has(value.id) ||
        program.inline.has(value.id) ||
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
        use([...expressionOperands(definition.expression)]);
        define([definition.result]);
      }
    };
    definitions(block.id);
    for (const node of block.statements) {
      this.context.checkpoint(1);
      if (program.retained.has(node.id)) {
        const reads: Value[] = [];
        if (node.kind === 'assign')
          reads.push(
            ...expressionOperands(program.expressions.get(node.result.id) ?? node.expression),
          );
        else if (node.kind === 'write_register') reads.push(node.value);
        else if (node.kind === 'load' || node.kind === 'store') {
          if (!program.source?.locals.has(node.id)) reads.push(node.address);
          if (node.kind === 'store') reads.push(node.value);
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

/** Boissinot-style phi-copy coalescing: an edge copy's destination and its
 * variable source share one printed variable when no value of either class is
 * live where a value of the other is written (SSA live-range interference).
 * `compatible` must accept only values whose printed declarations and reads
 * are identical. Returns value id -> representative for coalesced classes. */
export function coalescePhiCopies(
  program: Reconstruction,
  liveness: VariableLiveness,
  compatible: (a: Value, b: Value) => boolean,
  context: OperationContext,
): Map<string, Value> {
  const result = new Map<string, Value>();
  if (!liveness.complete) return result;
  const candidates = new Set<number>();
  const pairs: { destination: number; source: number }[] = [];
  for (const copies of program.transfers.values())
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
          if (liveness.has(live, other)) conflict(id, other);
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
  for (const [root, list] of classes) {
    if (list.length < 2) continue;
    // Formals keep their declared name; otherwise the earliest declared value names the class.
    const values = list.map((id) => liveness.values[id]!);
    const representative =
      values.find((value) => formals.has(value.id)) ??
      liveness.values[Math.min(...list)] ??
      liveness.values[root]!;
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
          !isTail(id) &&
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
    if (control.kind === 'jump')
      return labeled(control.transfer, follow, nesting)
        ? sequence([region, clone(control.transfer.target, control.transfer)])
        : region;
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
      if (region.kind === 'block') {
        if (drop.has(region.id) && !clones.has(region)) return null;
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
      return children.length ? sequence(children) : null;
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
}

/** Choose `while (cond)` / `do { } while (cond)` syntax where its side
 * conditions hold on the final layout; other loops keep `while (true)`. */
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
  ): LoopForm | undefined => {
    const entries = incoming.get(loop.header) ?? [];
    if (
      follow === null ||
      entries.some((occurrence) => occurrenceAction(occurrence, language) === 'goto')
    )
      return undefined;
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
      if (stayTrue !== stayFalse) return { kind: 'while', test: control.id, enter: stayTrue };
    }
    const last = regions.at(-1);
    if (
      language !== 'c-like' ||
      last?.kind !== 'block' ||
      last.control.kind !== 'if' ||
      !facts.plain(last.control)
    )
      return undefined;
    const control = last.control,
      inside = owned(loop.body);
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
      return { kind: 'do_while', test: control.id, repeat };
    }
    return undefined;
  };
  const rebuild = (region: Region, follow: string | null): Region => {
    context.checkpoint(1);
    if (region.kind === 'sequence')
      return {
        kind: 'sequence',
        regions: region.regions.map((child, index) =>
          rebuild(child, nextEntry(region.regions, index, follow)),
        ),
      };
    if (region.kind === 'loop') {
      const inner = rebuild(region.body, region.header);
      const form = choose(region, follow);
      return form ? { ...region, body: inner, form } : { ...region, body: inner };
    }
    return {
      ...region,
      control: mapArms(region.control, (item) =>
        item.body ? { ...item, body: rebuild(item.body, follow) } : item,
      ),
    };
  };
  return rebuild(body, null);
}
