import { fingerprint, type OperationContext, type PresentationView } from '../core/index.js';
import type { EmissionInput } from '../emitters/model.js';
import { classifyStackRegion } from '../analysis/stack/index.js';
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
import type { BoundaryProjection } from './model.js';
import type { FrameSaves, SourceLocal, SourceStackStorage } from './source-model.js';
import { LocalValidationSession } from './local-validation.js';
import { validateStackPromotion } from './local-storage-validation.js';

type MemoryNode = Extract<Instruction, { kind: 'load' | 'store' }>;
/** Exact private slots only. Escapes and overlapping access intervals retain one
 * shared frame; promoting a slot never changes an observable memory operation. */
export function planSourceStack(
  input: EmissionInput,
  blocks: ReadonlyMap<string, BlockRegion>,
  expressions: Map<string, Expression>,
  transfers: readonly { transfer: ParallelTransfer; block: BlockRegion }[],
  calls: Map<string, BoundaryProjection>,
  returns: ReadonlyMap<string, BoundaryProjection>,
  alias: (value: Value, expression: Expression) => void,
  context: OperationContext,
  incomingStack: (offset: bigint, type: DataType, contributors: readonly Value[]) => Value | null,
  entryStack: () => Value,
  validation = new LocalValidationSession(context),
  view: PresentationView = 'checked',
) {
  const addresses = new Map<string, bigint>(),
    facts = input.types?.calls?.stack;
  if (facts?.state === 'complete')
    for (const [id, fact] of facts.values)
      if (fact.value.kind === 'stack') addresses.set(id, fact.value.offset);
  const entry = blocks.get(input.function.entry)!;
  for (const binding of entry.register_entry)
    if (
      binding.register.root === input.source!.abi.stack_pointer.root &&
      binding.register.width_bits === input.source!.abi.stack_pointer.width_bits
    )
      addresses.set(binding.value.id, 0n);
  // A bounded monotone affine pass also supports synthetic source callers that
  // do not carry the native stack analysis. Conflicting phis never get an offset.
  const incoming = new Map<string, Value[]>();
  for (const { transfer } of transfers)
    for (const copy of transfer.copies) {
      const row = incoming.get(copy.destination.id) ?? [];
      row.push(copy.source);
      incoming.set(copy.destination.id, row);
    }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, expression] of expressions) {
      context.checkpoint(1);
      if (addresses.has(id)) continue;
      let offset: bigint | undefined;
      if (expression.kind === 'cast' && expression.op === 'bitcast')
        offset = addresses.get(expression.value.id);
      else if (
        expression.kind === 'integer' &&
        (expression.op === 'add' || expression.op === 'sub')
      ) {
        const base = addresses.get(expression.left.id),
          constant = expressions.get(expression.right.id);
        if (base !== undefined && constant?.kind === 'constant')
          offset =
            base +
            (expression.op === 'add' ? 1n : -1n) *
              BigInt.asIntN(bitWidth(expression.right.type), constant.bits);
      }
      if (offset !== undefined) {
        addresses.set(id, offset);
        changed = true;
      }
    }
    for (const [id, sources] of incoming) {
      context.checkpoint(1);
      if (addresses.has(id) || !sources.length) continue;
      const offset = addresses.get(sources[0]!.id);
      if (offset !== undefined && sources.every((value) => addresses.get(value.id) === offset)) {
        addresses.set(id, offset);
        changed = true;
      }
    }
  }
  const tainted = new Set(addresses.keys());
  const memory = [...blocks.values()].flatMap((block) =>
    block.statements.filter(
      (node): node is MemoryNode => node.kind === 'load' || node.kind === 'store',
    ),
  );
  const memoryDependencies = new Map<string, Value[]>();
  for (const load of memory)
    if (load.kind === 'load') {
      const offset = addresses.get(load.address.id);
      if (offset === undefined) continue;
      const end = offset + BigInt(Math.ceil(bitWidth(load.result.type) / 8)),
        sources: Value[] = [];
      for (const store of memory) {
        context.checkpoint(1);
        if (store.kind !== 'store') continue;
        const start = addresses.get(store.address.id);
        if (
          start !== undefined &&
          start < end &&
          start + BigInt(Math.ceil(bitWidth(store.value.type) / 8)) > offset
        )
          sources.push(store.value);
      }
      memoryDependencies.set(load.result.id, sources);
    }
  changed = true;
  while (changed) {
    changed = false;
    for (const [id, expression] of expressions) {
      context.checkpoint(1);
      if (
        !tainted.has(id) &&
        expressionOperands(expression).some((value) => tainted.has(value.id))
      ) {
        tainted.add(id);
        changed = true;
      }
    }
    for (const [id, sources] of incoming)
      if (!tainted.has(id) && sources.some((value) => tainted.has(value.id))) {
        tainted.add(id);
        changed = true;
      }
    for (const [id, sources] of memoryDependencies)
      if (!tainted.has(id) && sources.some((value) => tainted.has(value.id))) {
        context.checkpoint(1);
        tainted.add(id);
        changed = true;
      }
  }
  let escaped = false,
    unknownCallStorage = false,
    // Frame saves rest on ABI conformance: an unresolved callee reads only
    // argument registers/stack and never writes its caller's frame. Only an
    // actual stack address in possible argument/result storage escapes them.
    saveEscaped = view !== 'source';
  const abi = input.source!.abi;
  const preservedRoot = (root: string): boolean =>
    abi.preserved.some((register) => register.root === root);
  const argumentTainted = (bindings: readonly RegisterBinding[]): boolean =>
    bindings.some(
      (binding) =>
        binding.register.root !== abi.stack_pointer.root &&
        !preservedRoot(binding.register.root) &&
        tainted.has(binding.value.id),
    );
  const callNodes: Extract<Instruction, { kind: 'call' }>[] = [];
  const accesses: { node: MemoryNode; block: string; offset: bigint; end: bigint; key: string }[] =
    [];
  for (const block of blocks.values()) {
    for (const node of block.statements) {
      context.checkpoint(1);
      if (node.kind === 'call') {
        callNodes.push(node);
        const projection = calls.get(node.id)!;
        if (
          projection.arguments.some((value) => tainted.has(value.id)) ||
          (projection.kind !== 'source' && argumentTainted(node.register_inputs))
        )
          saveEscaped = true;
      }
      if (node.kind === 'call' && calls.get(node.id)!.kind !== 'source') unknownCallStorage = true;
      if (
        node.kind === 'call' &&
        (calls.get(node.id)!.kind === 'physical' ||
          calls.get(node.id)!.arguments.some((value) => tainted.has(value.id)))
      )
        escaped = true;
      if (node.kind === 'unknown_effect') escaped = saveEscaped = true;
      if (node.kind !== 'load' && node.kind !== 'store') continue;
      const offset = addresses.get(node.address.id),
        width = bitWidth(node.kind === 'load' ? node.result.type : node.value.type);
      if (
        node.kind === 'store' &&
        tainted.has(node.value.id) &&
        (offset === undefined || offset >= 0n)
      )
        escaped = saveEscaped = true;
      if (offset === undefined && tainted.has(node.address.id)) escaped = saveEscaped = true;
      if (offset === undefined || width % 8) continue;
      const end = offset + BigInt(width / 8);
      accesses.push({ node, block: block.id, offset, end, key: `${offset}:${end}` });
    }
    if (
      block.control.kind === 'return' &&
      returns.get(block.control.id)!.results.some((value) => tainted.has(value.id))
    )
      escaped = saveEscaped = true;
    // Like private promotion, unmodeled exits do not observe frame-private
    // bytes; an indirect target may still receive a stack address as argument.
    if (block.control.kind === 'indirect' && argumentTainted(block.register_exit))
      saveEscaped = true;
  }
  // Established ABI stack locations are outgoing argument storage at a call,
  // even when their entry-SP offsets are negative. They are not private spills.
  const outgoingRanges = (input.types?.calls?.calls ?? []).flatMap((call) =>
    call.contracts
      .filter((contract) => contract.status === 'established')
      .flatMap((contract) =>
        contract.parameters.flatMap((parameter) =>
          parameter.locations.flatMap((observation) =>
            observation.location.kind === 'stack' && observation.stack_offset !== null
              ? [
                  {
                    start: observation.stack_offset,
                    end: observation.stack_offset + observation.location.size,
                  },
                ]
              : [],
          ),
        ),
      ),
  );
  const groups = new Map<string, typeof accesses>();
  for (const access of accesses) {
    const group = groups.get(access.key) ?? [];
    group.push(access);
    groups.set(access.key, group);
  }
  const aliased =
    facts?.frame.aliased === true ||
    memory.some((node) => node.kind === 'store' && !addresses.has(node.address.id));
  const eligible = new Set<string>();
  if (!escaped && !unknownCallStorage && !aliased)
    for (const [key, group] of groups) {
      const first = group[0]!;
      context.checkpoint(accesses.length);
      if (
        first.offset >= 0n ||
        first.end > 0n ||
        group.some((access) => access.node.access.volatile) ||
        outgoingRanges.some((range) => range.start < first.end && range.end > first.offset)
      )
        continue;
      if (
        accesses.some(
          (access) => access.key !== key && access.offset < first.end && access.end > first.offset,
        )
      )
        continue;
      if (
        group.some(
          (access) =>
            access.node.access.endian !== first.node.access.endian ||
            !sameType(
              access.node.kind === 'load' ? access.node.result.type : access.node.value.type,
              first.node.kind === 'load' ? first.node.result.type : first.node.value.type,
            ),
        )
      )
        continue;
      eligible.add(key);
    }
  // Source view: frame-private save/restore of an entry register. A slot is a
  // save when (i) its only store writes the entry value of a preserved register
  // or the link register, (ii) every return/tail exit restores that register
  // from a dominated load of exactly this slot and no other access overlaps it,
  // (iii) no stack address escapes and (iv) it is not established outgoing
  // argument storage. Under ABI conformance callees never write it, so each
  // reload equals the saved value and neither access is source-observable.
  const saveStores = new Set<string>(),
    saveReloads = new Set<string>(),
    saveBytes = new Set<bigint>();
  const exits = [...blocks.values()].filter(
    (block) =>
      block.control.kind === 'return' ||
      (block.control.kind === 'indirect' && block.control.tail_call === true),
  );
  const position = (block: string, node: MemoryNode): number =>
    blocks.get(block)!.statements.indexOf(node);
  const dominates = (
    first: (typeof accesses)[number],
    second: (typeof accesses)[number],
  ): boolean => {
    if (first.block === second.block)
      return position(first.block, first.node) < position(second.block, second.node);
    for (
      let id = blocks.get(second.block)!.dominator;
      id !== null;
      id = blocks.get(id)?.dominator ?? null
    ) {
      context.checkpoint(1);
      if (id === first.block) return true;
    }
    return false;
  };
  if (!saveEscaped && exits.length) {
    const entryCells = new Map(
      entry.register_entry.map((binding) => [binding.value.id, binding.register]),
    );
    const loadsByResult = new Map<string, string>();
    for (const access of accesses)
      if (access.node.kind === 'load') loadsByResult.set(access.node.result.id, access.node.id);
    type Bits = { readonly root: string; readonly low: number; readonly width: number };
    // Exact entry bits through bitcasts, extracts and ordered concatenation only.
    const entryBits = (value: Value, depth = 0): Bits | null => {
      context.checkpoint(1);
      const cell = entryCells.get(value.id);
      if (cell) return { root: cell.root, low: cell.offset_bits, width: cell.width_bits };
      const expression = depth < 16 ? expressions.get(value.id) : undefined;
      const width = bitWidth(value.type);
      if (expression?.kind === 'cast' && expression.op === 'bitcast')
        return bitWidth(expression.value.type) === width
          ? entryBits(expression.value, depth + 1)
          : null;
      if (expression?.kind === 'extract') {
        const inner = entryBits(expression.value, depth + 1);
        return inner && expression.offset + width <= inner.width
          ? { root: inner.root, low: inner.low + expression.offset, width }
          : null;
      }
      if (expression?.kind === 'concat') {
        let result: Bits | null = null;
        for (const part of expression.values) {
          const bits = entryBits(part, depth + 1);
          if (!bits) return null;
          if (!result) result = bits;
          else if (bits.root === result.root && bits.low === result.low + result.width)
            result = { root: result.root, low: result.low, width: result.width + bits.width };
          else return null;
        }
        return result;
      }
      return null;
    };
    // Bit offset within a reload of `members` on every incoming path, or null.
    const reloadBits = (
      value: Value,
      members: ReadonlySet<string>,
      active: Set<string>,
      depth = 0,
    ): number | null => {
      context.checkpoint(1);
      const load = loadsByResult.get(value.id);
      if (load !== undefined) return members.has(load) ? 0 : null;
      if (depth >= 32 || active.has(value.id)) return null;
      const expression = expressions.get(value.id);
      if (expression?.kind === 'cast' && expression.op === 'bitcast')
        return bitWidth(expression.value.type) === bitWidth(value.type)
          ? reloadBits(expression.value, members, active, depth + 1)
          : null;
      if (expression?.kind === 'extract') {
        const inner = reloadBits(expression.value, members, active, depth + 1);
        return inner === null ? null : inner + expression.offset;
      }
      const sources = expression ? undefined : incoming.get(value.id);
      if (!sources?.length) return null;
      active.add(value.id);
      let result: number | null | undefined;
      for (const source of sources) {
        const bits = reloadBits(source, members, active, depth + 1);
        if (bits === null || (result !== undefined && result !== bits)) {
          result = null;
          break;
        }
        result = bits;
      }
      active.delete(value.id);
      return result ?? null;
    };
    for (const [key, group] of groups) {
      context.checkpoint(group.length);
      if (eligible.has(key)) continue;
      const first = group[0]!;
      const stores = group.filter((access) => access.node.kind === 'store'),
        loads = group.filter((access) => access.node.kind === 'load');
      const save = stores[0],
        saved = save?.node.kind === 'store' ? save.node : null;
      if (
        !save ||
        !saved ||
        stores.length !== 1 ||
        !loads.length ||
        first.offset >= 0n ||
        first.end > 0n ||
        group.some(
          (access) =>
            access.node.access.volatile ||
            access.node.access.endian !== saved.access.endian ||
            (access.node.kind === 'load' && !sameType(access.node.result.type, saved.value.type)),
        ) ||
        accesses.some(
          (access) => access.key !== key && access.offset < first.end && access.end > first.offset,
        ) ||
        outgoingRanges.some((range) => range.start < first.end && range.end > first.offset)
      )
        continue;
      const bits = entryBits(saved.value);
      if (
        !bits ||
        bits.width !== bitWidth(saved.value.type) ||
        !(
          abi.link_register?.root === bits.root ||
          abi.preserved.some(
            (register) =>
              register.root === bits.root &&
              register.offset_bits <= bits.low &&
              register.offset_bits + register.width_bits >= bits.low + bits.width,
          )
        ) ||
        loads.some((load) => !dominates(save, load))
      )
        continue;
      const members = new Set(loads.map((load) => load.node.id));
      const restored = exits.every((exit) => {
        let covered = 0;
        for (const binding of exit.register_exit) {
          const register = binding.register;
          if (
            register.root !== bits.root ||
            register.offset_bits + register.width_bits <= bits.low ||
            register.offset_bits >= bits.low + bits.width
          )
            continue;
          if (
            register.offset_bits < bits.low ||
            register.offset_bits + register.width_bits > bits.low + bits.width ||
            reloadBits(binding.value, members, new Set()) !== register.offset_bits - bits.low
          )
            return false;
          covered += register.width_bits;
        }
        return covered === bits.width;
      });
      if (
        !restored ||
        !validation.presentation(
          'frame_save',
          `stack:${key}`,
          `frame-private save of ${bits.root}[${bits.low}:${bits.width}] at entry SP ${first.offset}; restored from this exact slot on every return/tail exit; nonescaping, nonoverlapping, not established outgoing argument storage`,
          [save.node.id, ...members].slice(0, 64),
        )
      )
        continue;
      saveStores.add(save.node.id);
      for (let byte = first.offset; byte < first.end; byte++) saveBytes.add(byte);
      for (const load of loads) {
        saveReloads.add(load.node.id);
        if (load.node.kind === 'load')
          alias(load.node.result, { kind: 'cast', op: 'bitcast', value: saved.value });
      }
    }
    if (saveStores.size)
      validation.requireAbi(
        'frame_save',
        [exits[0]!.control.id, ...saveStores],
        'Frame save/restore elision assumes ABI conformance: callees preserve callee-saved registers and never write their caller’s frame outside outgoing argument storage, and the saved slots are not stack arguments. Each hidden store and reload remains in the checked view and the original mappings.',
      );
  }
  // Source view: a non-volatile frame load dominated by a store covering its
  // bytes cannot fault. If its result is dead, reconstruct() may drop it.
  const deadReloadCandidates = new Set<string>();
  if (view === 'source')
    for (const load of accesses) {
      if (load.node.kind !== 'load' || load.node.access.volatile || saveReloads.has(load.node.id))
        continue;
      context.checkpoint(accesses.length);
      if (
        accesses.some(
          (store) =>
            store.node.kind === 'store' &&
            store.offset <= load.offset &&
            store.end >= load.end &&
            dominates(store, load),
        )
      )
        deadReloadCandidates.add(load.node.id);
    }
  // Register observations establish a prefix, not the absence of further
  // stack arguments. Written bytes may also be saves or locals: retain the
  // uncertainty instead of inventing an argument count from their extent.
  // Proven frame saves are not possible stack arguments.
  for (const node of callNodes) {
    context.checkpoint(1);
    const projection = calls.get(node.id)!;
    if (projection.kind !== 'inferred') continue;
    const snapshot = facts?.snapshots.get(node.id);
    let writtenStack = false;
    if (snapshot)
      for (const offset of snapshot.memory.keys()) {
        context.checkpoint(1);
        if (!saveBytes.has(offset)) {
          writtenStack = true;
          break;
        }
      }
    else
      writtenStack = memory.some(
        (access) =>
          access.kind === 'store' && addresses.has(access.address.id) && !saveStores.has(access.id),
      );
    // A source-view closure by complete callee reads (planner) also needs this
    // caller to write no possible stack argument; it is recorded or withdrawn.
    if (
      writtenStack ||
      (projection.argument_list_complete === true &&
        !validation.presentation(
          'arity_closure',
          node.id,
          'complete argument list: the fully analyzed nonrecursive callee reads no register beyond the observed prefix, no incoming stack and no escaping incoming-stack address; the caller writes no possible stack argument outside proven frame saves',
          [node.id],
        ))
    )
      calls.set(node.id, { ...projection, argument_list_complete: false });
  }
  const byNode = new Map(accesses.map((access) => [access.node.id, access]));
  const predecessors = new Map<string, string[]>();
  for (const { transfer, block } of transfers) {
    const row = predecessors.get(transfer.target) ?? [];
    row.push(block.id);
    predecessors.set(transfer.target, row);
  }
  // State is exact reaching value / definitely initialized but differing values /
  // uninitialized. Unvisited predecessors are ignored until reached, then joins
  // can only lose precision, so backedges converge without inventing assignment.
  type Cell = Value | null | undefined;
  const outgoing = new Map<string, Map<string, Cell>>(),
    before = new Map<string, Cell>();
  changed = true;
  const indegree = new Map([...blocks.keys()].map((id) => [id, 0])),
    successors = new Map<string, string[]>();
  for (const { transfer, block } of transfers) {
    indegree.set(transfer.target, (indegree.get(transfer.target) ?? 0) + 1);
    const row = successors.get(block.id) ?? [];
    row.push(transfer.target);
    successors.set(block.id, row);
  }
  const acyclicQueue = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
  for (let cursor = 0; cursor < acyclicQueue.length; cursor++)
    for (const target of successors.get(acyclicQueue[cursor]!) ?? []) {
      context.checkpoint(1);
      const count = indegree.get(target)! - 1;
      indegree.set(target, count);
      if (count === 0) acyclicQueue.push(target);
    }
  const acyclic = acyclicQueue.length === blocks.size;
  while (changed) {
    changed = false;
    for (const block of blocks.values()) {
      context.checkpoint(1);
      const parents = (predecessors.get(block.id) ?? [])
        .map((id) => outgoing.get(id))
        .filter((state): state is Map<string, Cell> => state !== undefined);
      if (block.id !== input.function.entry && !parents.length) continue;
      const state = new Map<string, Cell>();
      for (const key of eligible) {
        let cell: Cell = block.id === input.function.entry ? undefined : parents[0]?.get(key);
        for (const parent of parents) {
          const other = parent.get(key);
          cell =
            cell === undefined || other === undefined
              ? undefined
              : cell === null || other === null || cell.id !== other.id
                ? null
                : cell;
        }
        state.set(key, cell);
      }
      for (const node of block.statements) {
        context.checkpoint(1);
        const access = byNode.get(node.id);
        if (!access || !eligible.has(access.key)) continue;
        if (access.node.kind === 'load') before.set(node.id, state.get(access.key));
        else state.set(access.key, access.node.value);
      }
      const old = outgoing.get(block.id);
      if (
        !old ||
        [...state].some(
          ([key, value]) =>
            old.get(key)?.id !== value?.id || (old.get(key) === null) !== (value === null),
        )
      ) {
        outgoing.set(block.id, state);
        changed = true;
      }
    }
  }
  const hidden = new Set<string>([...saveStores, ...saveReloads]),
    privateLoads = new Set<string>(),
    locals = new Map<string, SourceLocal>();
  const saves: FrameSaves = { stores: saveStores, reloads: saveReloads, bytes: saveBytes };
  // An unchanged incoming slot is entry storage supplied by the caller, not a
  // byte array allocated by this function. Bind only exact, nonescaping accesses
  // to proven ABI scalar slots; partial/overlapping or modified storage retains
  // its ordered memory representation until a richer storage model is available.
  if (!escaped && facts?.state === 'complete')
    for (const group of groups.values()) {
      const first = group[0]!;
      if (
        classifyStackRegion(input.source!.abi, first.offset, first.end - first.offset) !==
          'incoming_candidate' ||
        group.some((access) => access.node.kind !== 'load' || access.node.access.volatile) ||
        accesses.some(
          (access) =>
            access.key !== first.key && access.offset < first.end && access.end > first.offset,
        ) ||
        memory.some((node) => node.kind === 'store' && !addresses.has(node.address.id))
      )
        continue;
      const loads = group.map((access) => access.node as Extract<Instruction, { kind: 'load' }>);
      if (
        loads.some(
          (node) =>
            !sameType(node.result.type, loads[0]!.result.type) ||
            node.access.endian !== input.source!.abi.layout.endian ||
            facts?.snapshots.get(node.id)?.aliased ||
            facts?.snapshots.get(node.id)?.escaped,
        )
      )
        continue;
      const value = incomingStack(
        first.offset,
        loads[0]!.result.type,
        loads.map((node) => node.result),
      );
      if (!value) continue;
      for (const node of loads) {
        hidden.add(node.id);
        alias(node.result, { kind: 'cast', op: 'bitcast', value });
      }
    }
  for (const key of eligible) {
    const group = groups.get(key)!,
      loads = group.filter((access) => access.node.kind === 'load');
    if (loads.some((access) => before.get(access.node.id) === undefined)) continue;
    const forwarded =
      loads.every((access) => before.get(access.node.id) !== null) &&
      (acyclic || group.every((access) => access.block === group[0]!.block));
    const subjects = [group[0]!.node.id];
    const checked = validation.check(
      'stack-promotion',
      `stack:${key}`,
      'private stack promotion',
      () => {
        const members = new Set<string>(),
          proposed = new Map<string, Value>();
        for (const access of group) {
          validation.allowance.charge();
          members.add(access.node.id);
          if (subjects.length < 64 && access.node.id !== subjects[0]) subjects.push(access.node.id);
          if (forwarded && access.node.kind === 'load')
            proposed.set(access.node.id, before.get(access.node.id)!);
        }
        return validateStackPromotion(
          `stack:${key}`,
          input.function.entry,
          blocks,
          transfers,
          addresses,
          members,
          forwarded ? proposed : null,
          expressions,
          validation.allowance,
        );
      },
      subjects,
    );
    if (checked.status === 'rejected') continue;
    if (forwarded) {
      for (const access of group) {
        hidden.add(access.node.id);
        if (access.node.kind === 'load')
          alias(access.node.result, {
            kind: 'cast',
            op: 'bitcast',
            value: before.get(access.node.id)!,
          });
      }
    } else {
      const first = group[0]!.node;
      const local: SourceLocal = {
        id: `entity_${fingerprint(['source-local', input.function.id, key])}`,
        type: first.kind === 'load' ? first.result.type : first.value.type,
      };
      for (const access of group) {
        locals.set(access.node.id, local);
        if (access.node.kind === 'load') privateLoads.add(access.node.id);
      }
    }
  }
  const dynamicStorage = memory.some(
    (node) => tainted.has(node.address.id) && !addresses.has(node.address.id),
  );
  const sharedEntry = escaped || aliased || dynamicStorage;
  const entryAddresses = new Set(
    accesses
      .filter(
        (access) =>
          !hidden.has(access.node.id) &&
          classifyStackRegion(input.source!.abi, access.offset, access.end - access.offset) !==
            'local_candidate',
      )
      .map((access) => access.node.address.id),
  );
  const entryStorage = sharedEntry || entryAddresses.size ? entryStack() : null;
  const requiresEntry = (id: string): boolean => sharedEntry || entryAddresses.has(id);
  if (entryStorage)
    for (const binding of entry.register_entry)
      if (
        binding.register.root === input.source!.abi.stack_pointer.root &&
        sameType(binding.value.type, entryStorage.type)
      )
        alias(binding.value, { kind: 'cast', op: 'bitcast', value: entryStorage });
  const returnAddressLoads = new Map<
    string,
    { node: Extract<Instruction, { kind: 'load' }>; block: string }
  >();
  for (const access of accesses)
    if (
      access.node.kind === 'load' &&
      !access.node.access.volatile &&
      access.offset === 0n &&
      access.end <= input.source!.abi.stack_return_address_bytes
    )
      returnAddressLoads.set(access.node.result.id, { node: access.node, block: access.block });
  const frame = (
    retained: ReadonlySet<string>,
    live: ReadonlySet<string>,
  ): SourceStackStorage | null => {
    const remaining = accesses.filter(
      (access) =>
        retained.has(access.node.id) && !hidden.has(access.node.id) && !locals.has(access.node.id),
    );
    let minimum = 0n,
      maximum = 0n;
    for (const access of remaining) {
      if (access.offset < minimum) minimum = access.offset;
      if (access.end > maximum) maximum = access.end;
    }
    // A pointer remains representable even after its private memory traffic dies.
    let addressLive = false;
    for (const [id, offset] of addresses)
      if (live.has(id)) {
        addressLive = true;
        if (offset < minimum) minimum = offset;
        if (offset >= maximum) maximum = offset + 1n;
      }
    return remaining.length || addressLive
      ? {
          ...(entryStorage && live.has(entryStorage.id)
            ? { kind: 'entry' as const, base: entryStorage, dynamic: dynamicStorage }
            : { kind: 'private' as const }),
          minimum_offset: minimum,
          size: maximum - minimum,
          alignment: input.source!.abi.layout.stack_alignment,
        }
      : null;
  };
  return {
    hidden,
    privateLoads,
    locals,
    addresses,
    returnAddressLoads,
    frame,
    entryStorage,
    requiresEntry,
    saves,
    deadReloadCandidates,
  };
}
