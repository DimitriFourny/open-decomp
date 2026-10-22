import type { AbiProfile, OperationContext, RegisterDescriptor } from '../core/index.js';
import type { StackByte, StackFact } from '../analysis/stack/index.js';
import { instructionOperands } from '../analysis/effects/index.js';
import {
  bitWidth,
  expressionOperands,
  sameType,
  type DataType,
  type Expression,
  type Instruction,
  type RegisterBinding,
  type Value,
} from '../ir/index.js';
import type { BlockRegion, ParallelTransfer } from '../presentation/index.js';
import type { EmissionInput } from '../emitters/model.js';
import type { BoundaryProjection } from './model.js';
import type { LocalValidationSession } from './local-validation.js';
import type { InferredCallee } from './source-model.js';
import {
  createStackArgumentJoins,
  sourceStackArgumentParts,
  type StackArgumentJoins,
} from './source-stack-arguments.js';
type Store = Extract<Instruction, { kind: 'store' }>;

/** Darwin arm64 passes every variadic argument in 8-byte outgoing stack slots
 * starting at SP+0. When the callee lets a pointer into its incoming argument
 * area escape (an escaping `va_list`), a contiguous run of such slots written
 * by this body is presented as observed anonymous trailing arguments. Each slot
 * must be written by exactly one store that reaches the call on every path,
 * or (a slot written on several branches) by one store in the predecessor of
 * each incoming edge of the call's block: the argument is then the value the
 * join already carries, or a source-only block parameter each edge assigns
 * its stored value (`variadic_stack_join`). Every such store starts at the
 * slot, is not a frame save, a private local or hidden traffic, holds no stack
 * address, and is read by no load and visible at no other call or tail call
 * that may read it (a boundary whose SP lies at or above the slot, such as a
 * tail call, cannot). The run stops at the first slot failing any condition;
 * later stores stay explicit statements and the remainder marker stays, so no
 * argument is dropped and the source arity remains open. */
export function planVariadicStackArguments(
  input: EmissionInput,
  blocks: Map<string, BlockRegion>,
  expressions: ReadonlyMap<string, Expression>,
  calls: Map<string, BoundaryProjection>,
  excluded: (store: string) => boolean,
  storage: StackJoinStorage,
  validation: LocalValidationSession,
  context: OperationContext,
): ReadonlyMap<string, string> {
  const consumed = new Map<string, string>();
  const source = input.source,
    stack = input.types?.calls?.stack;
  if (source?.abi.id !== 'darwin-arm64' || stack?.state !== 'complete') return consumed;
  // Source-view refinements (e.g. a known variadic Objective-C selector) replace
  // the observed record of the same call.
  const inferred = new Map(
    [...source.callees, ...(source.source_callees ?? [])].map(
      (callee) => [callee.call_id, callee] as const,
    ),
  );
  const callees = new Map(
    [...inferred].filter(([, callee]) => callee.variadic_stack || callee.variadic),
  );
  if (!callees.size) return consumed;
  const writes = createRegisterWrites(blocks, expressions, input.function.entry, context);
  const integerArguments = argumentRegisters(source.abi, 'integer', 8);
  // The stack analysis treats a live frame pointer at any call as an escape.
  // Under ABI conformance (recorded with each rewrite) callees use preserved
  // registers and SP only as such; any other stack address leaving this body
  // (a scratch/argument register at a boundary, or a stored value) may alias
  // the outgoing slots and disables the rewrite for the whole function.
  const stackKind = (fact: StackFact | undefined): boolean =>
    fact?.value.kind === 'stack' ||
    fact?.value.kind === 'stack_fragment' ||
    fact?.value.kind === 'dynamic_stack';
  const preserved = new Set(source.abi.preserved.map((register) => register.root));
  // A callee with a published `va_start` footprint (S8) reads, under the
  // variadic convention recorded with each rewrite, its named registers (the
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
        if (stackKind(stack.values.get(node.value.id))) return consumed;
        stores.set(node.id, node);
      } else if ((node.kind === 'call' || node.kind === 'unknown_effect') && leaks(node.id))
        return consumed;
    }
    if (block.control.kind === 'indirect' && block.control.tail_call && leaks(block.control.id))
      return consumed;
  }
  const owners = new Map<StackFact, { store: Store; offset: bigint; size: bigint }>(),
    reads: { start: bigint; end: bigint }[] = [];
  for (const access of stack.accesses) {
    context.checkpoint(1);
    if (access.kind === 'read') {
      // An unknown read offset may observe any slot.
      if (access.offset === null) return consumed;
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
  // Boundaries that may read their incoming stack (our outgoing area). A
  // consumed store must be visible at no such boundary but its own call. Only
  // an observed callee without stack inputs, or an established complete
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
  const slot = BigInt(source.abi.layout.pointer_bits / 8);
  // The store owning slot `start` in `memory` (a boundary's or an edge exit's
  // snapshot): it starts the slot, its value covers exactly its bytes, it is
  // not volatile, hidden, private, a save or already consumed, and every other
  // slot byte is absent or owned by no store.
  const ownedSlot = (
    memory: ReadonlyMap<bigint, StackByte>,
    start: bigint,
  ): { readonly store: Store; readonly fact: StackFact; readonly size: bigint } | null => {
    const cell = memory.get(start),
      owner = cell && owners.get(cell.fact);
    if (
      !cell ||
      !owner ||
      owner.offset !== start ||
      owner.size > slot ||
      cell.value_offset_bits !== 0 ||
      owner.store.access.volatile ||
      BigInt(Math.ceil(bitWidth(owner.store.value.type) / 8)) !== owner.size ||
      excluded(owner.store.id) ||
      consumed.has(owner.store.id)
    )
      return null;
    for (let byte = 0n; byte < slot; byte++) {
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
  // Under the Darwin variadic convention (recorded with each rewrite) a callee
  // reads its arguments at or above its entry SP, so a boundary whose SP is an
  // exact stack offset at or above the bytes' end (a tail call: SP is back at
  // this function's entry SP) cannot read them.
  const unobserved = (
    call: string,
    start: bigint,
    size: bigint,
    facts: ReadonlySet<StackFact>,
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
        if (other && (facts.has(other.fact) || !owners.has(other.fact))) return true;
      }
      return false;
    });
  // A slot whose bytes merge at the call block's entry (written on several
  // branches). Every incoming edge carries one eligible store of one common
  // size and type, placed in the edge's predecessor block (so its value is
  // available at the edge) and owning the slot at that block's exit; the call
  // block writes nothing before the call. The join proof of
  // `sourceStackArgumentParts` (one value dominating every edge, or one
  // existing block parameter every edge copies the stored value into) gives
  // the argument; otherwise `joinStackSlot` adds a source-only block
  // parameter assigned the stored value on each edge. Each store is consumed.
  let joins: StackArgumentJoins | undefined;
  const storeValues = new Map([...stores].map(([id, store]) => [id, store.value] as const));
  const incoming = new Map<string, { transfer: ParallelTransfer; block: BlockRegion }[]>();
  for (const edge of storage.transfers) {
    const list = incoming.get(edge.transfer.target) ?? [];
    list.push(edge);
    incoming.set(edge.transfer.target, list);
  }
  const joinedSlot = (
    call: string,
    memory: ReadonlyMap<bigint, StackByte>,
    offset: bigint,
    start: bigint,
  ): JoinedSlot | null => {
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
        owned = exit && ownedSlot(exit, start),
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
    for (let byte = 0n; byte < slot; byte++) {
      const other = memory.get(start + byte);
      if (byte < size ? !other || owners.has(other.fact) : other && owners.has(other.fact))
        return null;
    }
    if (!unobserved(call, start, size, facts)) return null;
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
    return { block: position.block.id, offset, shared, edges: taken };
  };
  for (const block of blocks.values())
    for (const node of block.statements) {
      context.checkpoint(1);
      if (node.kind !== 'call') continue;
      const callee = callees.get(node.id),
        projection = calls.get(node.id);
      // Unnamed arguments follow every fixed one. An observed prefix fixes the
      // tail's position; an ambiguous callee keeps its fully bound caller-side
      // prefix, which the rendered note marks as possibly incomplete. Fixed
      // stack parameters would precede the tail, unless a published `va_start`
      // footprint (S8) names them: the tail then starts after its named bytes.
      if (
        !callee ||
        (callee.stack_parameters?.length && !callee.variadic) ||
        !(
          (projection?.kind === 'inferred' && projection.argument_list_complete === false) ||
          (projection?.kind === 'physical' &&
            callee.parameter_state === 'ambiguous' &&
            projection.arguments.length === callee.parameters.length)
        )
      )
        continue;
      // S8: a published footprint names no register itself on Darwin; the
      // anonymous slots follow the bound prefix only when the call writes no
      // integer argument register beyond it (else a named argument the
      // callee's observed prefix misses would shift every slot).
      if (
        callee.variadic &&
        integerArguments
          .slice(callee.parameters.filter((register) => register.bank === 'integer').length)
          .some((register) => writes(node.register_inputs, register))
      )
        continue;
      const snapshot = stack.snapshots.get(node.id),
        sp = snapshot?.stack_pointer.value;
      if (!snapshot || sp?.kind !== 'stack') continue;
      const taken: {
        readonly stores: readonly Store[];
        readonly value?: Value;
        readonly join?: JoinedSlot;
      }[] = [];
      for (let index = 0n; index < 32n; index++) {
        context.checkpoint(1);
        const offset = (callee.variadic?.named_stack_bytes ?? 0n) + index * slot,
          start = sp.offset + offset,
          cell = snapshot.memory.get(start);
        if (!cell) break;
        if (!owners.has(cell.fact)) {
          const join = joinedSlot(node.id, snapshot.memory, offset, start);
          if (
            !join ||
            !validation.presentation(
              'variadic_stack_join',
              node.id,
              join.shared
                ? 'Darwin arm64 variadic outgoing stack slot written on every incoming edge of the call block by one store in the predecessor, unobserved until the call: the argument is the value the join already carries'
                : 'Darwin arm64 variadic outgoing stack slot written on every incoming edge of the call block by one store in the predecessor, unobserved until the call: the argument is a source-only block parameter each edge assigns its stored value',
              [
                ...join.edges.map(({ store }) => store.id),
                ...new Set(join.edges.map(({ exit }) => exit)),
              ],
            )
          )
            break;
          taken.push({ stores: join.edges.map(({ store }) => store), join });
          continue;
        }
        const owned = ownedSlot(snapshot.memory, start);
        if (
          !owned ||
          (owned.fact.initialization !== 'initialized' && !unbarred(owned.store.id, node.id)) ||
          !unobserved(node.id, start, owned.size, new Set([owned.fact]))
        )
          break;
        taken.push({ value: owned.store.value, stores: [owned.store] });
      }
      if (
        !taken.length ||
        !validation.presentation(
          'variadic_stack_arguments',
          node.id,
          callee.variadic
            ? `Darwin arm64 variadic outgoing stack slots presented as the trailing anonymous call arguments after ${callee.variadic.named_stack_bytes} named stack bytes; the callee's va_start footprint is published and the source arity stays open`
            : 'Darwin arm64 variadic outgoing stack slots presented as observed trailing call arguments; the callee lets an incoming-stack pointer escape and the source arity stays open',
          taken.flatMap((argument) => argument.stores.map((store) => store.id)),
        )
      )
        continue;
      validation.requireAbi(
        'darwin_variadic_stack_arguments',
        [node.id],
        `Presenting outgoing stack stores as trailing arguments assumes the Darwin arm64 variadic convention (every unnamed argument in consecutive 8-byte stack slots from SP+${callee.variadic?.named_stack_bytes ?? 0n}) holds for this call.`,
      );
      const values: Value[] = taken.map(
        ({ value, join }) => value ?? join!.shared ?? joinStackSlot(blocks, storage, node.id, join!),
      );
      for (const argument of taken)
        for (const store of argument.stores) consumed.set(store.id, node.id);
      calls.set(node.id, {
        ...projection,
        arguments: [...projection.arguments, ...values],
        argument_list_complete: false,
      });
    }
  return consumed;
}

/** Source-view reconstruction state a joined variadic slot extends: every
 * edge transfer with its predecessor block, the source copies replacing a
 * transfer's own, the phi sources by destination, and the planner's value
 * factory. */
export interface StackJoinStorage {
  readonly transfers: readonly { readonly transfer: ParallelTransfer; readonly block: BlockRegion }[];
  readonly copies: Map<ParallelTransfer, ParallelTransfer['copies']>;
  readonly incoming: Map<string, Value[]>;
  readonly make: (
    key: string,
    type: DataType,
    block: string,
    expression?: Expression,
    contributors?: readonly Value[],
  ) => Value;
}

/** A variadic slot written on every incoming edge of the call block by one
 * store in that edge's predecessor. `shared` is the value the existing join
 * already carries (`sourceStackArgumentParts`), when there is one. */
interface JoinedSlot {
  readonly block: string;
  readonly offset: bigint;
  readonly shared: Value | null;
  readonly edges: readonly {
    readonly transfer: ParallelTransfer;
    readonly exit: string;
    readonly store: Store;
  }[];
}

/** The source-only block parameter of a joined slot: each incoming edge
 * assigns it the value its store wrote (available there: the store lies in
 * the predecessor block), alongside the edge's other simultaneous copies. */
function joinStackSlot(
  blocks: Map<string, BlockRegion>,
  storage: StackJoinStorage,
  call: string,
  join: JoinedSlot,
): Value {
  const sources = join.edges.map(({ store }) => store.value);
  const parameter = storage.make(
    `variadic-join:${call}:${join.offset}`,
    sources[0]!.type,
    join.block,
    undefined,
    sources,
  );
  storage.incoming.set(parameter.id, sources);
  for (const { transfer, store } of join.edges)
    storage.copies.set(transfer, [
      ...(storage.copies.get(transfer) ?? transfer.copies),
      { destination: parameter, source: store.value },
    ]);
  const block = blocks.get(join.block)!;
  blocks.set(join.block, { ...block, parameters: [...block.parameters, parameter] });
  return parameter;
}

/** A callee-side variadic area proven from the code `va_start` lowers to. */
export interface VariadicArea {
  /** Entry-SP offset of the first anonymous argument (`va_start`'s result). */
  readonly offset: bigint;
  /** Win64: the argument register of each named position, in order. Null
   * where anonymous arguments never occupy named argument registers (Darwin
   * arm64 passes all of them on the stack). */
  readonly named: readonly RegisterDescriptor[] | null;
  /** Win64: the home-area stores of the anonymous argument registers, which
   * are `va_start`'s own effect. */
  readonly stores: readonly string[];
}

/** Source view, Darwin arm64 and Win64: the callee's `va_start` area. `floor`
 * is the lowest entry-SP offset an escaping or indexing address derived from
 * the incoming area can take (`incomingFloor`); `based` holds the floors of
 * such exposures derived from the incoming area alone (every base known and
 * at or above the entry SP). The area starts at `a = floor` when
 * - Darwin: `a` is 0 or the end of the named stack formals, which tile
 *   `[0, a)` in 8-byte slots; Win64: `a = 8 + 8n` with 1 <= n <= 4;
 * - a value derived from the incoming area alone is dereferenced at
 *   non-constant offsets or escapes, and the lowest byte it can reach is `a`
 *   (a base read only at constant offsets is no variadic area);
 * - every known-offset access below `a` is a bound named formal (`bound`);
 * - Win64 only: for each i in [n, 4) exactly one store of the entry value of
 *   the i-th integer argument register to home slot `8 + 8i`, in the entry
 *   block (which no edge reenters), with no call, unknown effect or other
 *   access to the home area `[a, 40)` (or of unknown offset) before the last
 *   of them; the entry values of the integer and FP argument registers of
 *   positions >= n have no other use, and no named position uses both.
 * Anything else: null, no rewrite. */
export function classifyVariadicArea(
  facts: {
    readonly input: EmissionInput;
    readonly blocks: ReadonlyMap<string, BlockRegion>;
    readonly expressions: ReadonlyMap<string, Expression>;
    /** Phi destination -> its incoming sources. */
    readonly incoming: ReadonlyMap<string, readonly Value[]>;
    readonly calls: ReadonlyMap<string, BoundaryProjection>;
    readonly returns: ReadonlyMap<string, BoundaryProjection>;
    readonly accesses: readonly {
      readonly node: Extract<Instruction, { kind: 'load' | 'store' }>;
      readonly block: string;
      readonly offset: bigint;
      readonly end: bigint;
    }[];
    /** Statement ids of incoming slots bound as named formals. */
    readonly bound: ReadonlySet<string>;
    readonly floor: bigint | undefined;
    readonly based: ReadonlySet<bigint>;
    /** A load or store through a frame-derived address of unknown offset. */
    readonly unknownOffset: (node: Extract<Instruction, { kind: 'load' | 'store' }>) => boolean;
    readonly reentered: boolean;
  },
  context: OperationContext,
): VariadicArea | null {
  const { input, blocks, accesses, floor: area } = facts;
  const abi = input.source!.abi;
  if (area === undefined || area < 0n || area % 8n || !facts.based.has(area)) return null;
  const windows = abi.id === 'windows-x64';
  if (!windows && abi.id !== 'darwin-arm64') return null;
  if (windows && (area < 16n || area > 40n)) return null;
  for (const access of accesses) {
    context.checkpoint(1);
    // A load of the pushed return address is the return's own read.
    if (
      access.end > 0n &&
      access.offset < area &&
      !(
        access.node.kind === 'load' &&
        access.offset === 0n &&
        access.end <= abi.stack_return_address_bytes
      ) &&
      (access.offset < 0n || access.end > area || !facts.bound.has(access.node.id))
    )
      return null;
  }
  if (!windows) {
    // Named stack formals tile the bytes below the area: an unused named slot
    // would move the first anonymous argument.
    for (let slot = 0n; slot < area; slot += 8n)
      if (
        !accesses.some(
          (access) =>
            access.offset === slot && access.end === slot + 8n && facts.bound.has(access.node.id),
        )
      )
        return null;
    return { offset: area, named: null, stores: [] };
  }
  const entry = blocks.get(input.function.entry)!;
  if (facts.reentered) return null;
  const integers = argumentRegisters(abi, 'integer', 4),
    floats = argumentRegisters(abi, 'float', 4);
  if (integers.length !== 4 || floats.length !== 4) return null;
  const named = Number((area - 8n) / 8n);
  const stores: string[] = [];
  for (let index = named; index < 4; index++) {
    const slot = 8n + 8n * BigInt(index);
    const own = accesses.filter(
      (access) =>
        access.node.kind === 'store' &&
        access.offset === slot &&
        access.end === slot + 8n &&
        entryBits(facts.expressions, entry, access.node.value, integers[index]!.root, 0, 64),
    );
    if (
      own.length !== 1 ||
      own[0]!.block !== entry.id ||
      own[0]!.node.access.volatile ||
      own[0]!.node.access.endian !== abi.layout.endian
    )
      return null;
    stores.push(own[0]!.node.id);
  }
  const homeStores = new Set(stores);
  const offsets = new Map(accesses.map((access) => [access.node.id, access]));
  let last = -1;
  entry.statements.forEach((node, index) => {
    if (homeStores.has(node.id)) last = index;
  });
  for (let index = 0; index < last; index++) {
    context.checkpoint(1);
    const node = entry.statements[index]!;
    if (homeStores.has(node.id)) continue;
    if (node.kind === 'call' || node.kind === 'unknown_effect') return null;
    if (node.kind !== 'load' && node.kind !== 'store') continue;
    const access = offsets.get(node.id);
    if (access ? access.offset < 40n && access.end > area : facts.unknownOffset(node)) return null;
  }
  // The home stores' values are va_start's.
  const { used } = entryRegisterUses(facts, entry, new Set(), homeStores, context);
  const positions: RegisterDescriptor[] = [];
  for (let index = 0; index < 4; index++) {
    const integer = used(integers[index]!),
      float = used(floats[index]!);
    if (index >= named ? integer || float : integer && float) return null;
    if (index < named) positions.push(float ? floats[index]! : integers[index]!);
  }
  return { offset: area, named: positions, stores };
}

/** The first `count` argument registers of one class (64-bit integers or
 * doubles), as the ABI assigns them to a prototyped call; fewer when the
 * class has fewer registers. */
function argumentRegisters(
  abi: AbiProfile,
  type: 'integer' | 'float',
  count: number,
): RegisterDescriptor[] {
  return abi
    .classifyCall({
      returns: { kind: 'void' },
      parameters: Array.from({ length: count }, () =>
        type === 'integer'
          ? { kind: 'integer' as const, bits: 64, signed: false }
          : { kind: 'float' as const, bits: 64 as const },
      ),
      variadic: false,
      fixed_parameter_count: count,
    })
    .parameters.flatMap((parameter) => {
      const location = parameter.locations[0];
      return location?.kind === 'register' && parameter.locations.length === 1
        ? [{ ...location.register, width_bits: location.width_bits }]
        : [];
    });
}

/** `value` is exactly the entry bits `[low, low + width)` of register `root`
 * in `entry`: one entry cell, entry cells concatenated low to high, a slice
 * of such a value, or a same-width bitcast of one. */
function entryBits(
  expressions: ReadonlyMap<string, Expression>,
  entry: BlockRegion,
  value: Value,
  root: string,
  low: number,
  width: number,
  depth = 0,
): boolean {
  if (depth > 8 || bitWidth(value.type) !== width) return false;
  const binding = entry.register_entry.find((cell) => cell.value.id === value.id);
  if (binding)
    return (
      binding.register.root === root &&
      binding.register.offset_bits === low &&
      binding.register.width_bits === width
    );
  const expression = expressions.get(value.id);
  if (expression?.kind === 'cast' && expression.op === 'bitcast')
    return entryBits(expressions, entry, expression.value, root, low, width, depth + 1);
  if (expression?.kind === 'extract')
    return (
      low >= expression.offset &&
      entryBits(
        expressions,
        entry,
        expression.value,
        root,
        low - expression.offset,
        bitWidth(expression.value.type),
        depth + 1,
      )
    );
  if (expression?.kind !== 'concat') return false;
  let offset = low;
  for (const piece of expression.values) {
    if (!entryBits(expressions, entry, piece, root, offset, bitWidth(piece.type), depth + 1))
      return false;
    offset += bitWidth(piece.type);
  }
  return offset === low + width;
}

/** Source uses of the entry register values: every value an effect, a control
 * decision, a call or tail argument, or a projected result depends on.
 * Statements and controls in `ignored` are no uses; the stored values of the
 * stores in `spilled` are not either (their addresses are). A memory access's
 * register snapshot is fault state, and a register still holding its own entry
 * bits at an exit, on any path into it, is not a use. `used` reads only the
 * argument bits of a register: a vector register's upper lanes may flow
 * through unchanged into a result's register image. */
function entryRegisterUses(
  facts: {
    readonly blocks: ReadonlyMap<string, BlockRegion>;
    readonly expressions: ReadonlyMap<string, Expression>;
    readonly incoming: ReadonlyMap<string, readonly Value[]>;
    readonly calls: ReadonlyMap<string, BoundaryProjection>;
    readonly returns: ReadonlyMap<string, BoundaryProjection>;
  },
  entry: BlockRegion,
  ignored: ReadonlySet<string>,
  spilled: ReadonlySet<string>,
  context: OperationContext,
): {
  /** Values used directly: memory addresses, stored values, arguments, tests, results. */
  readonly roots: ReadonlySet<string>;
  readonly reached: ReadonlySet<string>;
  readonly used: (
    register: Pick<RegisterDescriptor, 'root' | 'offset_bits' | 'width_bits'>,
  ) => boolean;
} {
  const reached = new Set<string>(),
    pending: Value[] = [];
  const exits = (bindings: readonly { register: RegisterDescriptor; value: Value }[]) => {
    for (const { register, value: exit } of bindings) {
      const seen = new Set<string>(),
        walk = [exit];
      while (walk.length) {
        context.checkpoint(1);
        const value = walk.pop()!;
        if (seen.has(value.id)) continue;
        seen.add(value.id);
        if (
          entry.register_entry.some(
            (cell) => cell.value.id === value.id && cell.register.root === register.root,
          ) ||
          entryBits(
            facts.expressions,
            entry,
            value,
            register.root,
            register.offset_bits,
            register.width_bits,
          )
        )
          continue;
        const sources = facts.expressions.has(value.id) ? undefined : facts.incoming.get(value.id);
        if (sources) walk.push(...sources);
        else pending.push(value);
      }
    }
  };
  for (const block of facts.blocks.values()) {
    for (const node of block.statements) {
      context.checkpoint(1);
      if (ignored.has(node.id)) continue;
      if (node.kind === 'load') pending.push(node.address);
      else if (node.kind === 'store')
        pending.push(...(spilled.has(node.id) ? [node.address] : [node.address, node.value]));
      else if (node.kind === 'call') {
        const projection = facts.calls.get(node.id);
        if (node.target.kind === 'indirect') pending.push(node.target.value);
        if (!projection || projection.kind === 'physical')
          pending.push(...node.register_inputs.map((binding) => binding.value));
        else {
          pending.push(...projection.arguments);
          for (const binding of projection.inputs) pending.push(binding.value);
        }
      } else if (node.kind !== 'assign') pending.push(...instructionOperands(node));
    }
    const control = block.control;
    if (ignored.has(control.id)) continue;
    if (control.kind === 'if') pending.push(control.condition);
    else if (control.kind === 'switch') pending.push(control.value);
    else if (control.kind === 'indirect') {
      pending.push(control.target);
      exits(block.register_exit);
    } else if (control.kind === 'return') {
      const projection = facts.returns.get(control.id);
      if (projection) {
        pending.push(...projection.results);
        exits(projection.outputs);
      } else exits(block.register_exit);
    }
  }
  const roots = new Set(pending.map((value) => value.id));
  while (pending.length) {
    context.checkpoint(1);
    const value = pending.pop()!;
    if (reached.has(value.id)) continue;
    reached.add(value.id);
    const expression = facts.expressions.get(value.id);
    if (expression) pending.push(...expressionOperands(expression));
    pending.push(...(facts.incoming.get(value.id) ?? []));
  }
  return {
    roots,
    reached,
    used: (register) =>
      entry.register_entry.some(
        (binding) =>
          binding.register.root === register.root &&
          binding.register.offset_bits < register.offset_bits + register.width_bits &&
          binding.register.offset_bits + binding.register.width_bits > register.offset_bits &&
          reached.has(binding.value.id),
      ),
  };
}

/** A SysV AMD64 callee-side `va_start` footprint (`classifySysvVaStart`). */
export interface SysvVaStart {
  /** Entry-SP offset of the 24-byte `va_list`. */
  readonly va: bigint;
  /** Entry-SP offset of the 176-byte register save area. */
  readonly save: bigint;
  /** Entry-SP offset of the first anonymous stack argument (`overflow_arg_area`). */
  readonly overflow: bigint;
  /** The named argument registers: the first `g` integer ones, then the first
   * `f` vector ones (one valid order: SysV assigns the classes independently). */
  readonly named: readonly RegisterDescriptor[];
  /** Every footprint store, in program order. */
  readonly stores: readonly string[];
  /** The last footprint store, on every path. */
  readonly anchor: string;
  /** The `al != 0` guard `if` around the vector register stores, or null. */
  readonly guard: string | null;
}

const SAVE_AREA_BYTES = 176n;

/** Source view, SysV AMD64: the exact code `va_start` lowers to. With `g`
 * named integer and `f` named vector argument registers and `s` bytes of named
 * stack arguments:
 * - register save area at entry-SP offset R (a 16-aligned address): for each
 *   i in [g, 6) one 64-bit store of the entry value of integer argument
 *   register i at R + 8i, unconditional (entry block or join); for each j in
 *   [f, 8) one 128-bit store of the entry value of vector argument register j
 *   at R + 48 + 16j, all in the one block the entry block's `al != 0` test
 *   enters (and leaves only for the join it skips to; no edge copies);
 * - `va_list` at offset v, unconditional: `gp_offset = 8g` and
 *   `fp_offset = 48 + 16f` (two 32-bit stores or one 64-bit store),
 *   `overflow_arg_area` (v + 8) = entry SP + 8 + s, `reg_save_area`
 *   (v + 16) = R; named stack formals tile [8, 8 + s);
 * - before the last footprint store (on every path) no call, unknown effect,
 *   escape of a frame address, other access to either area or access through
 *   a frame address of unknown offset;
 * - anywhere: no other access to the save area, and no use of an address in
 *   it except the footprint's; every other access to the `va_list` is exactly
 *   one of its fields, kept in memory; no indexed `va_list` address and no
 *   taken one strictly inside a field; no other known-offset access at or above
 *   the entry SP than bound named formals and return-address reads;
 * - the entry values of the saved registers and of `al` have no other use.
 * Anything else: null, no rewrite. */
export function classifySysvVaStart(
  facts: {
    readonly input: EmissionInput;
    readonly blocks: ReadonlyMap<string, BlockRegion>;
    readonly expressions: ReadonlyMap<string, Expression>;
    /** Phi destination -> its incoming sources. */
    readonly incoming: ReadonlyMap<string, readonly Value[]>;
    readonly predecessors: ReadonlyMap<string, readonly string[]>;
    readonly calls: ReadonlyMap<string, BoundaryProjection>;
    readonly returns: ReadonlyMap<string, BoundaryProjection>;
    readonly accesses: readonly {
      readonly node: Extract<Instruction, { kind: 'load' | 'store' }>;
      readonly block: string;
      readonly offset: bigint;
      readonly end: bigint;
    }[];
    /** Known entry-SP offsets of frame-derived values (the analysis map). */
    readonly addresses: ReadonlyMap<string, bigint>;
    /** The addresses printed as such (not read back from memory). */
    readonly presented: ReadonlyMap<string, bigint>;
    /** A value derived from a frame address. */
    readonly tainted: (value: Value) => boolean;
    /** A memory access the stack plan keeps as memory (not hidden or promoted). */
    readonly kept: (id: string) => boolean;
    /** Statement ids of incoming slots bound as named formals. */
    readonly bound: ReadonlySet<string>;
    /** Frame offsets dynamically indexed accesses derive from. */
    readonly indexed: ReadonlySet<bigint>;
  },
  context: OperationContext,
): SysvVaStart | null {
  const { input, blocks, expressions, accesses, addresses } = facts;
  const abi = input.source!.abi;
  if (abi.id !== 'sysv-amd64') return null;
  const entry = blocks.get(input.function.entry)!;
  if (facts.predecessors.get(entry.id)?.length) return null;
  const integers = argumentRegisters(abi, 'integer', 6),
    vectors = argumentRegisters(abi, 'float', 8);
  // `al` bounds the vector registers a variadic call uses.
  const al = abi
    .classifyCall({
      returns: { kind: 'void' },
      parameters: [],
      variadic: true,
      fixed_parameter_count: 0,
    })
    .implicit_register_inputs.find(
      (input) => input.purpose === 'vector_argument_register_upper_bound',
    )?.register;
  if (integers.length !== 6 || vectors.length !== 8 || !al) return null;
  // The entry block's `al` test: the block it enters when al != 0 (the vector
  // stores) and the join both reach.
  let guard: { control: string; stores: BlockRegion; join: BlockRegion } | null = null;
  const control = entry.control;
  if (control.kind === 'if') {
    // Exactly `al` (possibly `al & al`, `al | al` or extended).
    const alOnly = (value: Value, depth = 0): boolean => {
      if (depth > 8) return false;
      if (
        entry.register_entry.some(
          (binding) =>
            binding.value.id === value.id &&
            binding.register.root === al.root &&
            binding.register.offset_bits === al.offset_bits &&
            binding.register.width_bits === al.width_bits,
        )
      )
        return true;
      const expression = expressions.get(value.id);
      if (expression?.kind === 'cast')
        return (
          (expression.op === 'bitcast' || expression.op === 'zero_extend') &&
          alOnly(expression.value, depth + 1)
        );
      return (
        expression?.kind === 'integer' &&
        (expression.op === 'and' || expression.op === 'or') &&
        expression.left.id === expression.right.id &&
        alOnly(expression.left, depth + 1)
      );
    };
    const zero = (value: Value): boolean => {
      const expression = expressions.get(value.id);
      return (
        expression?.kind === 'constant' &&
        BigInt.asUintN(bitWidth(value.type), expression.bits) === 0n
      );
    };
    const test = expressions.get(control.condition.id);
    if (
      test?.kind !== 'compare' ||
      (test.op !== 'eq' && test.op !== 'ne') ||
      !((alOnly(test.left) && zero(test.right)) || (alOnly(test.right) && zero(test.left)))
    )
      return null;
    const nonzero = test.op === 'ne' ? control.when_true : control.when_false,
      skip = test.op === 'ne' ? control.when_false : control.when_true;
    const stores = blocks.get(nonzero.transfer.target),
      join = blocks.get(skip.transfer.target);
    if (
      !stores ||
      !join ||
      stores.id === join.id ||
      stores.control.kind !== 'jump' ||
      stores.control.transfer.target !== join.id ||
      nonzero.transfer.copies.length ||
      skip.transfer.copies.length ||
      stores.control.transfer.copies.length ||
      facts.predecessors.get(stores.id)?.length !== 1 ||
      facts.predecessors.get(join.id)?.length !== 2
    )
      return null;
    guard = { control: control.id, stores, join };
  }
  // Unconditional footprint blocks, in program order, and the guarded one.
  const plain = guard ? [entry, guard.join] : [entry];
  const plainIds = new Set(plain.map((block) => block.id));
  const byNode = new Map(accesses.map((access) => [access.node.id, access]));
  const stored = (block: (id: string) => boolean, offset: bigint, bytes: bigint) =>
    accesses.filter(
      (access) =>
        access.node.kind === 'store' &&
        block(access.block) &&
        access.offset === offset &&
        access.end === offset + bytes &&
        !access.node.access.volatile &&
        access.node.access.endian === abi.layout.endian &&
        facts.kept(access.node.id),
    ) as (Omit<(typeof accesses)[number], 'node'> & {
      readonly node: Extract<Instruction, { kind: 'store' }>;
    })[];
  const constant = (value: Value): bigint | undefined => {
    const expression = expressions.get(value.id);
    return expression?.kind === 'constant'
      ? BigInt.asUintN(bitWidth(value.type), expression.bits)
      : undefined;
  };
  const unconditional = (id: string): boolean => plainIds.has(id);
  // `overflow_arg_area`: the one unconditional frame store of an incoming address.
  const overflow = accesses.filter(
    (access) =>
      access.node.kind === 'store' &&
      unconditional(access.block) &&
      access.end - access.offset === 8n &&
      access.end <= 0n &&
      (addresses.get(access.node.value.id) ?? -1n) >= 8n,
  );
  if (overflow.length !== 1) return null;
  const va = overflow[0]!.offset - 8n,
    incoming = addresses.get(
      (overflow[0]!.node as Extract<Instruction, { kind: 'store' }>).value.id,
    )!;
  if (stored(unconditional, va + 8n, 8n).length !== 1 || incoming % 8n) return null;
  const saveStore = stored(unconditional, va + 16n, 8n);
  if (saveStore.length !== 1) return null;
  const save = addresses.get(saveStore[0]!.node.value.id);
  if (
    save === undefined ||
    (save + abi.stack_return_address_bytes) % 16n !== 0n ||
    save + SAVE_AREA_BYTES > 0n ||
    !(va + 24n <= save || save + SAVE_AREA_BYTES <= va)
  )
    return null;
  // `gp_offset` and `fp_offset`: one 64-bit store or two 32-bit stores.
  const wide = stored(unconditional, va, 8n),
    gpStores = stored(unconditional, va, 4n),
    fpStores = stored(unconditional, va + 4n, 4n);
  let offsets: bigint | undefined;
  const counters: string[] = [];
  if (wide.length === 1 && !gpStores.length && !fpStores.length) {
    offsets = constant(wide[0]!.node.value);
    counters.push(wide[0]!.node.id);
  } else if (!wide.length && gpStores.length === 1 && fpStores.length === 1) {
    const gp = constant(gpStores[0]!.node.value),
      fp = constant(fpStores[0]!.node.value);
    if (gp !== undefined && fp !== undefined) offsets = gp | (fp << 32n);
    counters.push(gpStores[0]!.node.id, fpStores[0]!.node.id);
  }
  if (offsets === undefined) return null;
  const gp = offsets & 0xffffffffn,
    fp = offsets >> 32n;
  if (gp % 8n || gp > 48n || fp < 48n || (fp - 48n) % 16n || fp > 176n) return null;
  const g = Number(gp / 8n),
    f = Number((fp - 48n) / 16n);
  // A guard needs vector stores; without one there are none.
  if ((guard !== null) !== f < 8) return null;
  const footprint = new Set<string>([overflow[0]!.node.id, saveStore[0]!.node.id, ...counters]);
  for (let index = g; index < 6; index++) {
    const own = stored(unconditional, save + 8n * BigInt(index), 8n).filter((access) =>
      entryBits(expressions, entry, access.node.value, integers[index]!.root, 0, 64),
    );
    if (own.length !== 1) return null;
    footprint.add(own[0]!.node.id);
  }
  for (let index = f; index < 8; index++) {
    const own = stored(
      (id) => id === guard!.stores.id,
      save + 48n + 16n * BigInt(index),
      16n,
    ).filter((access) =>
      entryBits(expressions, entry, access.node.value, vectors[index]!.root, 0, 128),
    );
    if (own.length !== 1) return null;
    footprint.add(own[0]!.node.id);
  }
  // The guarded block holds the vector stores and pure definitions only.
  if (guard?.stores.statements.some((node) => node.kind !== 'assign' && !footprint.has(node.id)))
    return null;
  // Named stack formals tile the bytes up to the first anonymous one.
  const stack = incoming - 8n;
  if (stack > 0n && g < 6 && f < 8) return null;
  for (let slot = 8n; slot < incoming; slot += 8n)
    if (
      !accesses.some(
        (access) =>
          access.offset === slot && access.end === slot + 8n && facts.bound.has(access.node.id),
      )
    )
      return null;
  const inSave = (offset: bigint, end: bigint): boolean =>
    offset < save + SAVE_AREA_BYTES && end > save;
  const inVa = (offset: bigint, end: bigint): boolean => offset < va + 24n && end > va;
  // Program order through the footprint; the anchor is its last store, which
  // must lie on every path.
  const order = guard ? [entry, guard.stores, guard.join] : [entry];
  const stores: Instruction[] = [],
    blockOf = new Map<string, string>();
  for (const block of order)
    for (const node of block.statements)
      if (footprint.has(node.id)) {
        stores.push(node);
        blockOf.set(node.id, block.id);
      }
  const anchor = stores.at(-1)!;
  if (stores.length !== footprint.size || !unconditional(blockOf.get(anchor.id)!)) return null;
  scan: for (const block of order)
    for (const node of block.statements) {
      context.checkpoint(1);
      if (node === anchor) break scan;
      if (footprint.has(node.id) || node.kind === 'assign') continue;
      if (node.kind !== 'load' && node.kind !== 'store') return null;
      if (node.kind === 'store' && facts.tainted(node.value)) return null;
      const access = byNode.get(node.id);
      if (
        access
          ? inSave(access.offset, access.end) || inVa(access.offset, access.end)
          : facts.tainted(node.address)
      )
        return null;
    }
  const fields = new Set([
    `${va}:${va + 4n}`,
    `${va + 4n}:${va + 8n}`,
    `${va + 8n}:${va + 16n}`,
    `${va + 16n}:${va + 24n}`,
  ]);
  for (const access of accesses) {
    context.checkpoint(1);
    if (footprint.has(access.node.id)) continue;
    const type = access.node.kind === 'load' ? access.node.result.type : access.node.value.type;
    if (inSave(access.offset, access.end)) return null;
    if (
      inVa(access.offset, access.end) &&
      (!fields.has(`${access.offset}:${access.end}`) ||
        type.kind !== 'integer' ||
        access.node.access.volatile ||
        access.node.access.endian !== 'little' ||
        !facts.kept(access.node.id))
    )
      return null;
    // A load of the pushed return address is the return's own read.
    if (
      access.end > 0n &&
      !facts.bound.has(access.node.id) &&
      !(
        access.node.kind === 'load' &&
        access.offset === 0n &&
        access.end <= abi.stack_return_address_bytes
      )
    )
      return null;
  }
  for (const offset of facts.indexed) if (inVa(offset, offset + 1n)) return null;
  for (const offset of facts.presented.values())
    if (
      offset > va &&
      offset < va + 24n &&
      offset !== va + 4n &&
      offset !== va + 8n &&
      offset !== va + 16n
    )
      return null;
  // Neither the save area's addresses, nor the saved registers, nor `al` have
  // any use but the footprint (and the dropped guard). A save-area address
  // may only be the base of another printed address (the stack pointer below
  // a red-zone frame is the base of every frame address).
  const { roots, reached, used } = entryRegisterUses(
    facts,
    entry,
    new Set([...footprint, ...(guard ? [guard.control] : [])]),
    new Set(),
    context,
  );
  const users = new Map<string, string[]>();
  const user = (operand: Value, result: string): void => {
    const row = users.get(operand.id) ?? [];
    row.push(result);
    users.set(operand.id, row);
  };
  for (const [id, expression] of expressions) {
    context.checkpoint(1);
    if (reached.has(id)) for (const operand of expressionOperands(expression)) user(operand, id);
  }
  for (const [id, sources] of facts.incoming)
    if (reached.has(id)) for (const source of sources) user(source, id);
  for (const [id, offset] of facts.presented)
    if (
      reached.has(id) &&
      inSave(offset, offset + 1n) &&
      (roots.has(id) || users.get(id)?.some((result) => !facts.presented.has(result)))
    )
      return null;
  if (used(al)) return null;
  for (let index = g; index < 6; index++) if (used(integers[index]!)) return null;
  for (let index = f; index < 8; index++)
    if (used({ root: vectors[index]!.root, offset_bits: 0, width_bits: 128 })) return null;
  return {
    va,
    save,
    overflow: incoming,
    named: [...integers.slice(0, g), ...vectors.slice(0, f)],
    stores: stores.map((node) => node.id),
    anchor: anchor.id,
    guard: guard?.control ?? null,
  };
}

/** The argument values of a call or tail to a callee with a published
 * `va_start` footprint (S8), or null when the named prefix cannot be bound. */
export interface VariadicCallArguments {
  readonly arguments: readonly Value[];
  /** How many of `arguments` are anonymous (after the named prefix). */
  readonly anonymous: number;
}

/** Source view, the caller side of a callee's `va_start` footprint (S8): the
 * named prefix binds exactly to the callee's named registers and named stack
 * slots; the remaining argument locations follow the ABI's variadic
 * convention, and only those the caller provably sets up for this transfer
 * print as anonymous arguments, in ABI order:
 * - SysV AMD64: the integer argument registers after the named ones that this
 *   body writes (a prefix: an untouched entry value or a call's clobber ends
 *   it), then the vector argument registers after the named ones up to the
 *   constant `al` (the vector-register upper bound), each as its low double;
 *   the classes are assigned independently, so this order is one valid order;
 * - Win64: the positions after the named ones whose integer register this
 *   body writes (a prefix), each as the double of its FP register when that
 *   holds the same bits (a variadic FP argument is passed in both), else the
 *   integer;
 * - Darwin arm64: none here; the outgoing stack slots from SP plus the named
 *   stack bytes are `planVariadicStackArguments`'.
 * The remaining argument list stays open: a forwarded entry value may still
 * be an anonymous argument. */
export function createVariadicCallBinder(
  abi: AbiProfile,
  blocks: ReadonlyMap<string, BlockRegion>,
  expressions: ReadonlyMap<string, Expression>,
  entry: string,
  context: OperationContext,
): (
  callee: InferredCallee,
  bindings: readonly RegisterBinding[],
  bind: (key: string, register: RegisterDescriptor, type: DataType) => Value | null,
  bindStack: (key: string, offset: bigint, type: DataType) => Value | null,
) => VariadicCallArguments | null {
  const writes = createRegisterWrites(blocks, expressions, entry, context);
  // The bits a value re-presents unchanged: its base value and bit range.
  const base = (value: Value): string => {
    const width = bitWidth(value.type);
    let offset = 0,
      current = value;
    for (let depth = 0; depth < 8; depth++) {
      const expression = expressions.get(current.id);
      if (expression?.kind === 'cast' && expression.op === 'bitcast') current = expression.value;
      else if (expression?.kind === 'extract') {
        offset += expression.offset;
        current = expression.value;
      } else if (expression?.kind === 'concat') {
        // The one part (lowest first) holding every bit of the range.
        let start = 0,
          part: Value | undefined;
        for (const piece of expression.values) {
          const end = start + bitWidth(piece.type);
          if (offset >= start && offset + width <= end) part = piece;
          if (part) break;
          start = end;
        }
        if (!part) break;
        offset -= start;
        current = part;
      } else break;
    }
    return `${current.id}:${offset}:${width}`;
  };
  const constant = (value: Value, depth = 0): bigint | undefined => {
    const expression = expressions.get(value.id),
      width = bitWidth(value.type);
    if (depth > 8 || !expression) return undefined;
    if (expression.kind === 'constant') return BigInt.asUintN(width, expression.bits);
    if (expression.kind === 'extract') {
      const inner = constant(expression.value, depth + 1);
      return inner === undefined
        ? undefined
        : BigInt.asUintN(width, inner >> BigInt(expression.offset));
    }
    if (
      expression.kind === 'cast' &&
      (expression.op === 'bitcast' ||
        expression.op === 'zero_extend' ||
        expression.op === 'truncate')
    ) {
      const inner = constant(expression.value, depth + 1);
      return inner === undefined ? undefined : BigInt.asUintN(width, inner);
    }
    return undefined;
  };
  const sysv = abi.id === 'sysv-amd64',
    windows = abi.id === 'windows-x64';
  const integers = argumentRegisters(abi, 'integer', sysv ? 6 : 4),
    vectors = argumentRegisters(abi, 'float', sysv ? 8 : 4);
  const al = abi
    .classifyCall({
      returns: { kind: 'void' },
      parameters: [],
      variadic: true,
      fixed_parameter_count: 0,
    })
    .implicit_register_inputs.find(
      (input) => input.purpose === 'vector_argument_register_upper_bound',
    )?.register;
  const word: DataType = { kind: 'integer', bits: 64 },
    double: DataType = { kind: 'float', bits: 64 };
  return (callee, bindings, bind, bindStack) => {
    const variadic = callee.variadic;
    if (!variadic) return null;
    const values: Value[] = [];
    // Darwin arm64 passes no anonymous argument in a register: the named
    // registers are the call's observed register prefix, as for any callee.
    const namedRegisters = abi.id === 'darwin-arm64' ? callee.parameters : variadic.named;
    for (const [index, named] of namedRegisters.entries()) {
      // The observed cell width and type of the named register, when read.
      const at = callee.parameters.findIndex((register) => register.root === named.root);
      const register = at >= 0 ? callee.parameters[at]! : named;
      const value = bind(
        `named:${index}`,
        register,
        callee.parameter_types?.[at] ?? { kind: 'integer', bits: register.width_bits },
      );
      if (!value) return null;
      values.push(value);
    }
    const first = abi.stack_return_address_bytes;
    for (let offset = first; offset < first + variadic.named_stack_bytes; offset += 8n) {
      const observed = callee.stack_parameters?.find((parameter) => parameter.offset === offset);
      const value = bindStack(`named-stack:${offset}`, offset, observed?.type ?? word);
      if (!value) return null;
      values.push(value);
    }
    const named = values.length;
    const set = (register: RegisterDescriptor): boolean => writes(bindings, register);
    if (sysv) {
      for (let index = variadic.named_integer; index < integers.length; index++) {
        if (!set(integers[index]!)) break;
        const value = bind(`anonymous:${index}`, integers[index]!, word);
        if (!value) break;
        values.push(value);
      }
      // `al` bounds the vector registers the call uses (named ones included).
      const bound = al && bind('vector-count', al, { kind: 'integer', bits: al.width_bits });
      const count = bound ? constant(bound) : undefined;
      if (count !== undefined)
        for (let index = variadic.named_vector; index < Math.min(Number(count), 8); index++) {
          const value =
            vectors[index] && bind(`anonymous-vector:${index}`, vectors[index]!, double);
          if (!value) break;
          values.push(value);
        }
    } else if (windows) {
      for (let index = variadic.named.length; index < integers.length; index++) {
        if (!set(integers[index]!)) break;
        const integer = bind(`anonymous:${index}`, integers[index]!, word);
        if (!integer) break;
        const fp = bind(`anonymous-fp:${index}`, vectors[index]!, double);
        values.push(fp && base(fp) === base(integer) ? fp : integer);
      }
    }
    return { arguments: values, anonymous: values.length - named };
  };
}

/** Whether this body writes every bit of an argument register at a transfer
 * (`bindings`): every cell covering it was computed, loaded or moved into it
 * on every path, and no part is the register's own entry value or a value a
 * call or unknown effect left in it. */
export function createRegisterWrites(
  blocks: ReadonlyMap<string, BlockRegion>,
  expressions: ReadonlyMap<string, Expression>,
  entry: string,
  context: OperationContext,
): (bindings: readonly RegisterBinding[], register: RegisterDescriptor) => boolean {
  // Values a register holds without this body writing it: its own entry
  // cells and the cells a call or unknown effect left in it.
  const kept = new Map<string, Set<string>>();
  const keep = (bindings: readonly RegisterBinding[]): void => {
    for (const binding of bindings) {
      const roots = kept.get(binding.value.id) ?? new Set<string>();
      roots.add(binding.register.root);
      kept.set(binding.value.id, roots);
    }
  };
  const sources = new Map<string, Value[]>();
  keep(blocks.get(entry)?.register_entry ?? []);
  for (const block of blocks.values()) {
    for (const node of block.statements) {
      context.checkpoint(1);
      if (node.kind === 'call' || node.kind === 'unknown_effect') keep(node.register_outputs);
    }
    const control = block.control;
    const transfers =
      control.kind === 'jump'
        ? [control.transfer]
        : control.kind === 'if'
          ? [control.when_true.transfer, control.when_false.transfer]
          : control.kind === 'switch'
            ? [...control.cases.map((item) => item.arm.transfer), control.otherwise.transfer]
            : [];
    for (const transfer of transfers)
      for (const copy of transfer.copies) {
        const list = sources.get(copy.destination.id) ?? [];
        list.push(copy.source);
        sources.set(copy.destination.id, list);
      }
  }
  // Every bit of `value` was computed, loaded or moved into `root` by this
  // body on every path: no part is `root`'s entry value or a clobber.
  const written = (value: Value, root: string, seen = new Set<string>()): boolean => {
    context.checkpoint(1);
    if (seen.has(value.id)) return true;
    seen.add(value.id);
    if (seen.size > 64 || kept.get(value.id)?.has(root)) return false;
    const expression = expressions.get(value.id);
    if (!expression) {
      const incoming = sources.get(value.id);
      return !incoming || incoming.every((source) => written(source, root, seen));
    }
    if (expression.kind === 'indeterminate') return false;
    if (
      (expression.kind === 'cast' && expression.op === 'bitcast') ||
      expression.kind === 'extract'
    )
      return written(expression.value, root, seen);
    if (expression.kind === 'concat')
      return expression.values.every((part) => written(part, root, seen));
    return true;
  };
  return (bindings, register) => {
    const cells = bindings.filter(
      (binding) =>
        binding.register.root === register.root &&
        binding.register.offset_bits < register.offset_bits + register.width_bits &&
        binding.register.offset_bits + binding.register.width_bits > register.offset_bits,
    );
    return cells.length > 0 && cells.every((cell) => written(cell.value, register.root));
  };
}
