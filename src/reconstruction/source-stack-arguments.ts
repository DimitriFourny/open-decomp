import type { OperationContext } from '../core/index.js';
import type { StackByte, StackFact, StackRecoveryResult } from '../analysis/stack/index.js';
import { bitWidth, sameType, type Instruction, type Value } from '../ir/index.js';
import type { BlockRegion, ParallelTransfer } from '../presentation/index.js';
import type { EmissionInput } from '../emitters/model.js';
import { identityOperand } from './expressions.js';
import type { LocalValidationSession } from './local-validation.js';
import type { BoundaryProjection, TailProjection } from './model.js';

type Store = Extract<Instruction, { kind: 'store' }>;

export interface StackArgumentPart {
  readonly value: Value;
  readonly value_offset_bits: number;
  readonly offset_bits: number;
  readonly width_bits: number;
}

/** Block-join facts for a boundary whose stack bytes merge several stores. */
export interface StackArgumentJoins {
  /** The boundary's block: its statements up to and including the boundary
   * (`pure` statements write no memory) and every incoming edge with the edge's
   * exit-state identity and its simultaneous parameter copies. */
  readonly block: (boundary: string) =>
    | {
        readonly statements: readonly { readonly id: string; readonly pure: boolean }[];
        readonly incoming: readonly {
          readonly exit: string;
          readonly copies: readonly { readonly destination: Value; readonly source: Value }[];
        }[];
      }
    | undefined;
  /** Low-bits-first components of a value defined by `concat`. */
  readonly concat: (value: Value) => readonly Value[] | undefined;
  /** The operand an identity assignment (a register move) copies unchanged. */
  readonly alias: (value: Value) => Value | undefined;
  /** The bits of a value defined as a constant (rematerialized constants are
   * distinct SSA values with equal bits). */
  readonly constant: (value: Value) => bigint | undefined;
}

/** The block-join facts of a source body's regions: each statement's block,
 * every block's incoming edges with their parameter copies, and the concat,
 * identity-move and constant definitions of its assignments. The entry block
 * has no join. */
export function createStackArgumentJoins(
  blocks: ReadonlyMap<string, BlockRegion>,
  entry: string,
): StackArgumentJoins {
  const statementBlocks = new Map<string, string>(),
    concats = new Map<string, readonly Value[]>(),
    aliases = new Map<string, Value>(),
    constants = new Map<string, bigint>(),
    incomingEdges = new Map<
      string,
      { exit: string; copies: readonly { destination: Value; source: Value }[] }[]
    >();
  for (const block of blocks.values()) {
    for (const node of block.statements) {
      statementBlocks.set(node.id, block.id);
      if (node.kind !== 'assign') continue;
      if (node.expression.kind === 'constant') constants.set(node.result.id, node.expression.bits);
      if (node.expression.kind === 'concat') concats.set(node.result.id, node.expression.values);
      const alias = identityOperand(node.result.type, node.expression);
      if (alias) aliases.set(node.result.id, alias);
    }
    const control = block.control;
    const outgoing =
      control.kind === 'jump'
        ? [control.transfer]
        : control.kind === 'if'
          ? [control.when_true.transfer, control.when_false.transfer]
          : control.kind === 'switch'
            ? [...control.cases.map((item) => item.arm.transfer), control.otherwise.transfer]
            : [];
    for (const transfer of outgoing) {
      const edges = incomingEdges.get(transfer.target) ?? [];
      edges.push({ exit: control.id, copies: transfer.copies });
      incomingEdges.set(transfer.target, edges);
    }
  }
  return {
    block(boundary) {
      const block = blocks.get(statementBlocks.get(boundary) ?? '');
      if (!block || block.id === entry) return undefined;
      const index = block.statements.findIndex((node) => node.id === boundary);
      return {
        statements: block.statements.slice(0, index + 1).map((node) => ({
          id: node.id,
          pure: node.kind !== 'store' && node.kind !== 'call' && node.kind !== 'unknown_effect',
        })),
        incoming: incomingEdges.get(block.id) ?? [],
      };
    },
    concat: (value) => concats.get(value.id),
    alias: (value) => aliases.get(value.id),
    constant: (value) => constants.get(value.id),
  };
}

/** Recover existing stored SSA values, never add an observable memory load or
 * choose a dependency ID merely because it appears in a fact's provenance set.
 * Byte facts retain their exact owning store across snapshot copies. A byte
 * merged at the boundary's block entry (unchanged up to the boundary) resolves
 * when, on every incoming edge, the byte's exact owning store wrote either the
 * same value (or concat component) at the same bit offset — a single SSA
 * definition reaching every predecessor dominates the join — or a value that
 * the edge copies into one shared block parameter at the same bit offset. A
 * merged, aliased or absent byte without that proof keeps the argument
 * unresolved. */
export function sourceStackArgumentParts(
  stack: StackRecoveryResult,
  stores: ReadonlyMap<string, Value>,
  boundary: string,
  offset: bigint,
  width: number,
  context: OperationContext,
  joins?: StackArgumentJoins,
): readonly StackArgumentPart[] | null {
  if (width <= 0 || width % 8 !== 0 || width > 2048) return null;
  const snapshot = stack.snapshots.get(boundary),
    sp = snapshot?.stack_pointer.value;
  if (!snapshot || sp?.kind !== 'stack') return null;
  const owners = new Map<StackFact, Value>();
  for (const access of stack.accesses) {
    context.checkpoint(1);
    if (access.kind !== 'write') continue;
    const value = stores.get(access.node_id);
    if (value) owners.set(access.value, value);
  }
  // The value an identity-move chain copies unchanged.
  const unaliased = (value: Value): Value => {
    let current = value;
    for (let depth = 0; depth < 8; depth++) {
      context.checkpoint(1);
      const alias = joins?.alias(current);
      if (!alias) break;
      current = alias;
    }
    return current;
  };
  // The component of `value` holding bit `bit`, with its bit offset, through
  // identity moves and concats.
  const component = (value: Value, bit: number): { value: Value; offset: number } => {
    let current = { value: unaliased(value), offset: bit };
    for (let depth = 0; depth < 8; depth++) {
      context.checkpoint(1);
      const parts = joins?.concat(current.value);
      if (!parts) return current;
      let base = 0;
      const next = parts.find((part) => {
        const width = bitWidth(part.type);
        if (current.offset < base + width) return true;
        base += width;
        return false;
      });
      if (!next) return current;
      current = { value: unaliased(next), offset: current.offset - base };
    }
    return current;
  };
  const merged = (address: bigint): { value: Value; value_offset_bits: number } | null => {
    const block = joins?.block(boundary);
    if (!block?.incoming.length) return null;
    // Block-entry memory: the first statement with a pre-effect snapshot, after
    // only pure statements, whose byte fact reaches the boundary unchanged.
    let first: string | undefined;
    for (const statement of block.statements) {
      if (stack.snapshots.has(statement.id)) {
        first = statement.id;
        break;
      }
      if (!statement.pure) return null;
    }
    const entry = first === undefined ? undefined : stack.snapshots.get(first)?.memory.get(address);
    if (!entry || entry.fact !== snapshot.memory.get(address)?.fact) return null;
    let destination: Value | undefined,
      bit: number | undefined,
      shared: { value: Value; offset: number } | null | undefined,
      carried = true;
    for (const edge of block.incoming) {
      context.checkpoint(1);
      const cell = stack.snapshots.get(edge.exit)?.memory.get(address);
      const stored = cell && owners.get(cell.fact);
      if (!cell || !stored || cell.fact.initialization === 'uninitialized') return null;
      const source = component(stored, cell.value_offset_bits);
      shared =
        shared === undefined ||
        (shared && shared.value.id === source.value.id && shared.offset === source.offset)
          ? source
          : null;
      // A carrier copies the stored value itself or an equal rematerialized
      // constant of the same width (only `shared` needs one dominating value).
      const bits = joins?.constant(source.value);
      const copies = edge.copies.filter((copy) => {
        const carried = unaliased(copy.source);
        return (
          (carried.id === source.value.id ||
            (bits !== undefined &&
              joins?.constant(carried) === bits &&
              bitWidth(carried.type) === bitWidth(source.value.type))) &&
          (destination === undefined || copy.destination.id === destination.id)
        );
      });
      if (copies.length !== 1 || (bit !== undefined && bit !== source.offset)) carried = false;
      else {
        destination = copies[0]!.destination;
        bit = source.offset;
      }
      if (!shared && !carried) return null;
    }
    if (shared) return { value: shared.value, value_offset_bits: shared.offset };
    return carried && destination && bit !== undefined
      ? { value: destination, value_offset_bits: bit }
      : null;
  };
  const parts: StackArgumentPart[] = [];
  for (let byte = 0; byte < width / 8; byte++) {
    context.checkpoint(1);
    const address = sp.offset + offset + BigInt(byte);
    const cell = snapshot.memory.get(address);
    if (!cell) return null;
    const owner = owners.get(cell.fact);
    const resolved =
      owner && cell.fact.initialization !== 'uninitialized'
        ? { value: owner, value_offset_bits: cell.value_offset_bits }
        : merged(address);
    if (!resolved) return null;
    const { value } = resolved;
    const previous = parts.at(-1);
    if (
      previous &&
      previous.value.id === value.id &&
      previous.value_offset_bits + previous.width_bits === resolved.value_offset_bits
    ) {
      parts[parts.length - 1] = { ...previous, width_bits: previous.width_bits + 8 };
    } else
      parts.push({
        value,
        value_offset_bits: resolved.value_offset_bits,
        offset_bits: byte * 8,
        width_bits: 8,
      });
  }
  return parts;
}

/** A stack location a projection bound through `bindStack`: `width_bits` at
 * `offset` bytes above the boundary's SP, presented as the argument `value`. */
export interface StackArgumentBinding {
  readonly offset: bigint;
  readonly width_bits: number;
  readonly value: Value;
}

/** An outgoing slot written on every incoming edge of the call block by one
 * store in that edge's predecessor. `shared` is the value the existing join
 * already carries (`sourceStackArgumentParts`), when there is one. */
export interface JoinedSlot {
  readonly block: string;
  readonly offset: bigint;
  readonly shared: Value | null;
  readonly edges: readonly {
    readonly transfer: ParallelTransfer;
    readonly exit: string;
    readonly store: Store;
  }[];
}

/** The stores of one outgoing slot that only its call observes: one store
 * (`value` is its stored value) or one per incoming edge (`join`). `size` is
 * the bytes each store writes from the slot's start. */
export interface OutgoingSlot {
  readonly stores: readonly Store[];
  readonly size: bigint;
  readonly value?: Value;
  readonly join?: JoinedSlot;
  /** A boundary sees the stores only after the call (`calleeOwned`). */
  readonly afterCall: boolean;
}

/** Outgoing stack slots whose stores a call's argument presents (store id ->
 * call or tail id in `consumed`, shared by every such rewrite so no store is
 * taken twice). */
export interface OutgoingStackSlots {
  readonly consumed: Map<string, string>;
  /** The stores of the `extent` bytes at `offset` above `call`'s SP, when they
   * are its only observer; null when any condition fails. */
  readonly slot: (
    call: string,
    offset: bigint,
    extent: bigint,
    calleeOwned?: boolean,
  ) => OutgoingSlot | null;
}

/** Source view: the slot-eligibility facts of outgoing stack stores. A store
 * owns its slot when it starts the slot, its value covers exactly its bytes,
 * it is not volatile, hidden, private, a save (`excluded`) or already
 * consumed, and no other store owns the slot's remaining bytes. The store
 * reaches the call on every path (fact identity, with no barrier in between
 * when the stored value's initialization is unknown), or a slot written on
 * several branches is written on every incoming edge of the call block by
 * one such store in the edge's predecessor (`JoinedSlot`). Its bytes are read
 * by no load and visible at no other boundary that may read its incoming
 * stack: a boundary whose SP is an exact stack offset at or above the bytes'
 * end (a tail call) cannot, since a callee reads its arguments at or above
 * its entry SP. Under ABI conformance callees use preserved registers and SP
 * only as such; any other stack address leaving this body (a scratch or
 * argument register at a boundary, or a stored value) may alias the outgoing
 * slots, and an unknown read offset may read any: then no slot is eligible
 * (null). */
export function createOutgoingStackSlots(
  input: EmissionInput,
  blocks: ReadonlyMap<string, BlockRegion>,
  calls: ReadonlyMap<string, BoundaryProjection>,
  excluded: (store: string) => boolean,
  transfers: readonly { readonly transfer: ParallelTransfer; readonly block: BlockRegion }[],
  context: OperationContext,
): OutgoingStackSlots | null {
  const source = input.source,
    stack = input.types?.calls?.stack;
  if (!source || stack?.state !== 'complete') return null;
  const consumed = new Map<string, string>();
  // Source-view refinements (e.g. a known variadic Objective-C selector) replace
  // the observed record of the same call.
  const inferred = new Map(
    [...source.callees, ...(source.source_callees ?? [])].map(
      (callee) => [callee.call_id, callee] as const,
    ),
  );
  // The stack analysis treats a live frame pointer at any call as an escape.
  const stackKind = (fact: StackFact | undefined): boolean =>
    fact?.value.kind === 'stack' ||
    fact?.value.kind === 'stack_fragment' ||
    fact?.value.kind === 'dynamic_stack';
  const preserved = new Set(source.abi.preserved.map((register) => register.root));
  // A callee with a published `va_start` footprint (S8) reads, under the
  // variadic convention recorded with its call, its named registers (the
  // observed prefix) and its anonymous stack slots only: a stack address in
  // another register at its call reaches nothing.
  const leaks = (id: string): boolean => {
    const callee = inferred.get(id),
      named = callee?.variadic && callee.parameters;
    return (
      stack.snapshots
        .get(id)
        ?.registers.some(
          (row) =>
            row.register.root !== source.abi.stack_pointer.root &&
            !preserved.has(row.register.root) &&
            (!named || named.some((register) => register.root === row.register.root)) &&
            stackKind(row.fact),
        ) ?? true
    );
  };
  const stores = new Map<string, Store>();
  for (const block of blocks.values()) {
    for (const node of block.statements) {
      context.checkpoint(1);
      if (node.kind === 'store') {
        if (stackKind(stack.values.get(node.value.id))) return null;
        stores.set(node.id, node);
      } else if ((node.kind === 'call' || node.kind === 'unknown_effect') && leaks(node.id))
        return null;
    }
    if (block.control.kind === 'indirect' && block.control.tail_call && leaks(block.control.id))
      return null;
  }
  const owners = new Map<StackFact, { store: Store; offset: bigint; size: bigint }>(),
    reads: { start: bigint; end: bigint }[] = [];
  for (const access of stack.accesses) {
    context.checkpoint(1);
    if (access.kind === 'read') {
      // An unknown read offset may observe any slot.
      if (access.offset === null) return null;
      reads.push({ start: access.offset, end: access.offset + access.size });
      continue;
    }
    const store = stores.get(access.node_id);
    if (store && access.offset !== null)
      owners.set(access.value, { store, offset: access.offset, size: access.size });
  }
  // The stack analysis keeps the fact of a byte whose stored value is itself of
  // unknown initialization across a clobbering barrier, so fact identity proves
  // such a byte's store only when no barrier (a call, an unknown effect or a
  // store at an unknown offset) lies between that store and the call: in one
  // block, or (a joined slot) from the store to its block's exit and from the
  // call block's entry to the call.
  const exact = new Set(
    stack.accesses
      .filter((access) => access.kind === 'write' && access.offset !== null)
      .map((access) => access.node_id),
  );
  const positions = new Map<string, { readonly block: BlockRegion; readonly index: number }>();
  for (const block of blocks.values())
    block.statements.forEach((node, index) => positions.set(node.id, { block, index }));
  // No barrier among `block`'s statements in [from, to).
  const barrierFree = (block: BlockRegion, from: number, to: number): boolean => {
    for (let index = from; index < to; index++) {
      context.checkpoint(1);
      const node = block.statements[index]!;
      if (
        node.kind === 'call' ||
        node.kind === 'unknown_effect' ||
        (node.kind === 'store' && !exact.has(node.id))
      )
        return false;
    }
    return true;
  };
  const unbarred = (store: string, call: string): boolean => {
    const from = positions.get(store),
      to = positions.get(call);
    if (!from || !to || from.block !== to.block || from.index > to.index) return false;
    return barrierFree(from.block, from.index + 1, to.index);
  };
  // Boundaries that may read their incoming stack (our outgoing area). Only an
  // observed callee without stack inputs, or an established complete
  // non-variadic register-only contract, is known not to read those bytes.
  const stackContracts = new Set(
    (input.types?.calls?.calls ?? []).flatMap((call) =>
      call.contracts.some(
        (contract) =>
          contract.status !== 'established' ||
          contract.parameters.some((parameter) =>
            parameter.locations.some((location) => location.location.kind === 'stack'),
          ),
      )
        ? [call.node_id]
        : [],
    ),
  );
  const stackBlind = (id: string): boolean => {
    const callee = inferred.get(id),
      projection = calls.get(id);
    if (callee)
      return (
        callee.parameter_state === 'observed' &&
        !callee.variadic_stack &&
        !callee.variadic &&
        !callee.stack_parameters?.length
      );
    return (
      projection?.kind === 'source' &&
      projection.argument_list_complete !== false &&
      projection.signature?.signature.variadic === false &&
      !stackContracts.has(id)
    );
  };
  const boundaries: string[] = [];
  for (const block of blocks.values()) {
    for (const node of block.statements)
      if (node.kind === 'call' && !stackBlind(node.id)) boundaries.push(node.id);
    if (block.control.kind === 'indirect' && block.control.tail_call)
      boundaries.push(block.control.id);
  }
  // The store owning slot `start` (`extent` bytes) in `memory` (a boundary's
  // or an edge exit's snapshot).
  const ownedSlot = (
    memory: ReadonlyMap<bigint, StackByte>,
    start: bigint,
    extent: bigint,
  ): { readonly store: Store; readonly fact: StackFact; readonly size: bigint } | null => {
    const cell = memory.get(start),
      owner = cell && owners.get(cell.fact);
    if (
      !cell ||
      !owner ||
      owner.offset !== start ||
      owner.size > extent ||
      cell.value_offset_bits !== 0 ||
      owner.store.access.volatile ||
      BigInt(Math.ceil(bitWidth(owner.store.value.type) / 8)) !== owner.size ||
      excluded(owner.store.id) ||
      consumed.has(owner.store.id)
    )
      return null;
    for (let byte = 0n; byte < extent; byte++) {
      context.checkpoint(1);
      const other = memory.get(start + byte);
      if (
        !(byte < owner.size
          ? other?.fact === cell.fact && other.value_offset_bits === Number(byte) * 8
          : other === undefined || owners.get(other.fact) === undefined)
      )
        return null;
    }
    return { store: owner.store, fact: cell.fact, size: owner.size };
  };
  // Bytes [start, start + size) holding one of `facts` (the slot's stores)
  // are read by no load and visible at no stack-reading boundary but `call`,
  // unless a known different store owns them there (a barrier's unknown copy
  // may still hold a stored value; an absent byte was never written there).
  const unobserved = (
    call: string,
    start: bigint,
    size: bigint,
    facts: ReadonlySet<StackFact>,
    after?: (boundary: string) => boolean,
  ): boolean =>
    !reads.some((read) => read.start < start + size && read.end > start) &&
    !boundaries.some((id) => {
      if (id === call) return false;
      const snapshot = stack.snapshots.get(id);
      if (!snapshot) return true;
      const sp = snapshot.stack_pointer.value;
      if (sp.kind === 'stack' && sp.offset >= start + size) return false;
      for (let byte = 0n; byte < size; byte++) {
        const other = snapshot.memory.get(start + byte);
        if (other && (facts.has(other.fact) || !owners.has(other.fact))) return !after?.(id);
      }
      return false;
    });
  // Calls own their incoming stack arguments and may overwrite them
  // (`open_call_argument_area`), so a boundary that every path from each of
  // `stores` reaches only through `call` never sees their pre-call contents.
  let successors: Map<string, readonly string[]> | undefined;
  let controls: Map<string, BlockRegion> | undefined;
  const after =
    (stores: readonly Store[], call: string) =>
    (boundary: string): boolean => {
      const to = positions.get(call);
      controls ??= new Map([...blocks.values()].map((block) => [block.control.id, block] as const));
      const target = positions.get(boundary) ?? {
        block: controls.get(boundary),
        index: controls.get(boundary)?.statements.length ?? 0,
      };
      if (!to || !target.block) return false;
      if (!successors) {
        successors = new Map();
        for (const block of blocks.values()) {
          const control = block.control;
          successors.set(
            block.id,
            (control.kind === 'jump'
              ? [control.transfer]
              : control.kind === 'if'
                ? [control.when_true.transfer, control.when_false.transfer]
                : control.kind === 'switch'
                  ? [...control.cases.map((item) => item.arm.transfer), control.otherwise.transfer]
                  : []
            ).map((transfer) => transfer.target),
          );
        }
      }
      return stores.every((store) => {
        const from = positions.get(store.id);
        if (!from) return false;
        // Statements [index, end) of `block` up to the call reach the boundary
        // without the call; a block entered from its top is visited once.
        const entered = new Set<string>(),
          work: { block: BlockRegion; index: number }[] = [
            { block: from.block, index: from.index + 1 },
          ];
        while (work.length) {
          context.checkpoint(1);
          const { block, index } = work.pop()!;
          const stop = block === to.block && to.index >= index ? to.index : undefined;
          if (
            block === target.block &&
            target.index >= index &&
            (stop === undefined || target.index < stop)
          )
            return false;
          if (stop !== undefined) continue;
          for (const next of successors!.get(block.id) ?? []) {
            if (entered.has(next)) continue;
            entered.add(next);
            const region = blocks.get(next);
            if (region) work.push({ block: region, index: 0 });
          }
        }
        return true;
      });
    };
  // A slot whose bytes merge at the call block's entry (written on several
  // branches). Every incoming edge carries one eligible store of one common
  // size and type, placed in the edge's predecessor block (so its value is
  // available at the edge) and owning the slot at that block's exit; the call
  // block writes nothing before the call. The join proof of
  // `sourceStackArgumentParts` (one value dominating every edge, or one
  // existing block parameter every edge copies the stored value into) gives
  // `shared`.
  let joins: StackArgumentJoins | undefined;
  const storeValues = new Map([...stores].map(([id, store]) => [id, store.value] as const));
  const incoming = new Map<string, { transfer: ParallelTransfer; block: BlockRegion }[]>();
  for (const edge of transfers) {
    const list = incoming.get(edge.transfer.target) ?? [];
    list.push(edge);
    incoming.set(edge.transfer.target, list);
  }
  const joinedSlot = (
    call: string,
    memory: ReadonlyMap<bigint, StackByte>,
    offset: bigint,
    start: bigint,
    extent: bigint,
    through: ((stores: readonly Store[]) => (boundary: string) => boolean) | undefined,
  ): { readonly join: JoinedSlot; readonly size: bigint } | null => {
    const position = positions.get(call),
      edges = position && incoming.get(position.block.id);
    if (
      !position ||
      !edges?.length ||
      position.block.id === input.function.entry ||
      !barrierFree(position.block, 0, position.index)
    )
      return null;
    let size: bigint | undefined;
    const taken: JoinedSlot['edges'][number][] = [],
      facts = new Set<StackFact>();
    for (const { transfer, block } of edges) {
      context.checkpoint(1);
      const exit = stack.snapshots.get(block.control.id)?.memory,
        owned = exit && ownedSlot(exit, start, extent),
        from = owned && positions.get(owned.store.id);
      if (
        !owned ||
        from?.block.id !== block.id ||
        (size !== undefined && owned.size !== size) ||
        !sameType(owned.store.value.type, taken[0]?.store.value.type ?? owned.store.value.type) ||
        (owned.fact.initialization !== 'initialized' &&
          !barrierFree(block, from.index + 1, block.statements.length))
      )
        return null;
      size = owned.size;
      taken.push({ transfer, exit: block.control.id, store: owned.store });
      facts.add(owned.fact);
    }
    if (size === undefined) return null;
    // The call sees merged bytes only, and no store owns the slot's rest.
    for (let byte = 0n; byte < extent; byte++) {
      const other = memory.get(start + byte);
      if (byte < size ? !other || owners.has(other.fact) : other && owners.has(other.fact))
        return null;
    }
    if (!unobserved(call, start, size, facts, through?.(taken.map(({ store }) => store))))
      return null;
    joins ??= createStackArgumentJoins(blocks, input.function.entry);
    const width = Number(size) * 8,
      part = sourceStackArgumentParts(stack, storeValues, call, offset, width, context, joins);
    const shared =
      part?.length === 1 &&
      part[0]!.value_offset_bits === 0 &&
      part[0]!.width_bits === width &&
      bitWidth(part[0]!.value.type) === width
        ? part[0]!.value
        : null;
    return { join: { block: position.block.id, offset, shared, edges: taken }, size };
  };
  return {
    consumed,
    slot(call, offset, extent, calleeOwned = false) {
      let skipped = false;
      const through =
        (stores: readonly Store[]) =>
        (boundary: string): boolean =>
          after(stores, call)(boundary) && (skipped = true);
      const snapshot = stack.snapshots.get(call),
        sp = snapshot?.stack_pointer.value;
      if (!snapshot || sp?.kind !== 'stack') return null;
      const start = sp.offset + offset,
        cell = snapshot.memory.get(start);
      if (!cell) return null;
      if (!owners.has(cell.fact)) {
        const joined = joinedSlot(
          call,
          snapshot.memory,
          offset,
          start,
          extent,
          calleeOwned ? through : undefined,
        );
        return (
          joined && {
            stores: joined.join.edges.map(({ store }) => store),
            ...joined,
            afterCall: skipped,
          }
        );
      }
      const owned = ownedSlot(snapshot.memory, start, extent);
      if (
        !owned ||
        (owned.fact.initialization !== 'initialized' && !unbarred(owned.store.id, call)) ||
        !unobserved(
          call,
          start,
          owned.size,
          new Set([owned.fact]),
          calleeOwned ? through([owned.store]) : undefined,
        )
      )
        return null;
      return {
        stores: [owned.store],
        size: owned.size,
        value: owned.store.value,
        afterCall: skipped,
      };
    },
  };
}

/** Source view: a store whose bytes a call's projection bound through
 * `bindStack` (a format-rule closure, a callee's observed stack parameters or
 * a published `va_start` footprint) prints only as that argument. Each bound
 * location must be one eligible slot (`OutgoingStackSlots`) whose store, or
 * one store per incoming edge whose join value is the bound value, writes
 * exactly the bound bytes. A complete source projection binds every argument
 * at its ABI location, so the callee reads no other byte: its single store may
 * also cover padding up to the next bound location within the pointer-sized
 * slot (an `int` stored as a 64-bit word). The callee owns its stack
 * arguments and may overwrite them (`open_call_argument_area`, recorded on
 * the stores that rely on it), so a boundary the stores reach only through
 * the call does not observe them; any boundary that can see them before the
 * call still blocks. Records `stack_argument_store` per call and marks the
 * stores consumed by it. */
export function planStackArgumentStores(
  bindings: ReadonlyMap<string, readonly StackArgumentBinding[]>,
  calls: ReadonlyMap<string, BoundaryProjection>,
  tails: ReadonlyMap<string, TailProjection>,
  pointerBytes: bigint,
  slots: () => OutgoingStackSlots | null,
  validation: LocalValidationSession,
  context: OperationContext,
): void {
  for (const [boundary, bound] of bindings) {
    context.checkpoint(1);
    const projection = calls.get(boundary) ?? tails.get(boundary)?.boundary,
      shown = new Set(projection?.arguments.map((value) => value.id)),
      complete = projection?.kind === 'source' && projection.argument_list_complete !== false;
    const taken: Store[] = [],
      after: Store[] = [];
    for (const binding of bound) {
      context.checkpoint(1);
      if (!shown.has(binding.value.id) || binding.width_bits % 8 !== 0) continue;
      const extent = BigInt(binding.width_bits / 8),
        end = binding.offset + extent,
        next = bound.reduce(
          (limit, other) => (other.offset >= end && other.offset < limit ? other.offset : limit),
          complete ? end + ((pointerBytes - (end % pointerBytes)) % pointerBytes) : end,
        ),
        slot = slots()?.slot(boundary, binding.offset, next - binding.offset, true);
      if (
        !slot ||
        slot.size < extent ||
        (slot.join && (slot.size !== extent || slot.join.shared?.id !== binding.value.id)) ||
        slot.stores.some((store) => taken.includes(store))
      )
        continue;
      taken.push(...slot.stores);
      if (slot.afterCall) after.push(...slot.stores);
    }
    if (
      !taken.length ||
      !validation.presentation(
        'stack_argument_store',
        boundary,
        'outgoing stack store whose bytes the call binds as an argument at its ABI location (one nonvolatile store starting the slot, covering at most ABI padding no other argument occupies under a complete projection, or one store per incoming edge whose join value is the argument); not hidden, private or a frame save, read by no load and visible at no other boundary that may read its incoming stack before the call: it prints only as that argument',
        taken.map((store) => store.id),
      )
    )
      continue;
    if (after.length)
      validation.requireAbi(
        'open_call_argument_area',
        [boundary, ...after.map((store) => store.id)],
        'A call’s stack arguments form a callee-owned area starting at its callee-entry SP, which the callee may overwrite, so a caller never reads back after the call the pre-call contents of those bytes: a later boundary that sees an argument store only through the call does not observe it.',
      );
    const consumed = slots()!.consumed;
    for (const store of taken) consumed.set(store.id, boundary);
  }
}
