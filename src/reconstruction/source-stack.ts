import { fingerprint, type OperationContext } from '../core/index.js';
import type { EmissionInput } from '../emitters/model.js';
import { classifyStackRegion } from '../analysis/stack/index.js';
import {
  bitWidth,
  expressionOperands,
  sameType,
  type DataType,
  type Expression,
  type Instruction,
  type Value,
} from '../ir/index.js';
import type { BlockRegion, ParallelTransfer } from '../presentation/index.js';
import type { BoundaryProjection } from './model.js';
import type { SourceLocal } from './source-model.js';

type MemoryNode = Extract<Instruction, { kind: 'load' | 'store' }>;
/** Exact private slots only. Escapes and overlapping access intervals retain one
 * shared frame; promoting a slot never changes an observable memory operation. */
export function planSourceStack(
  input: EmissionInput,
  blocks: ReadonlyMap<string, BlockRegion>,
  expressions: Map<string, Expression>,
  transfers: readonly { transfer: ParallelTransfer; block: BlockRegion }[],
  calls: ReadonlyMap<string, BoundaryProjection>,
  returns: ReadonlyMap<string, BoundaryProjection>,
  alias: (value: Value, expression: Expression) => void,
  context: OperationContext,
  incomingStack: (
    offset: bigint,
    type: DataType,
    contributors: readonly Value[],
  ) => Value | null,
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
  let escaped = false;
  const accesses: { node: MemoryNode; block: string; offset: bigint; end: bigint; key: string }[] =
    [];
  for (const block of blocks.values()) {
    for (const node of block.statements) {
      context.checkpoint(1);
      if (
        node.kind === 'call' &&
        (calls.get(node.id)!.kind === 'physical' ||
          calls.get(node.id)!.arguments.some((value) => tainted.has(value.id)))
      )
        escaped = true;
      if (node.kind === 'unknown_effect') escaped = true;
      if (node.kind !== 'load' && node.kind !== 'store') continue;
      const offset = addresses.get(node.address.id),
        width = bitWidth(node.kind === 'load' ? node.result.type : node.value.type);
      if (
        node.kind === 'store' &&
        tainted.has(node.value.id) &&
        (offset === undefined || offset >= 0n)
      )
        escaped = true;
      if (offset === undefined && tainted.has(node.address.id)) escaped = true;
      if (offset === undefined || width % 8) continue;
      const end = offset + BigInt(width / 8);
      accesses.push({ node, block: block.id, offset, end, key: `${offset}:${end}` });
    }
    if (
      block.control.kind === 'return' &&
      returns.get(block.control.id)!.results.some((value) => tainted.has(value.id))
    )
      escaped = true;
  }
  const groups = new Map<string, typeof accesses>();
  for (const access of accesses) {
    const group = groups.get(access.key) ?? [];
    group.push(access);
    groups.set(access.key, group);
  }
  const eligible = new Set<string>();
  if (!escaped)
    for (const [key, group] of groups) {
      const first = group[0]!;
      context.checkpoint(accesses.length);
      if (
        first.offset >= 0n ||
        first.end > 0n ||
        group.some((access) => access.node.access.volatile)
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
  const hidden = new Set<string>(),
    privateLoads = new Set<string>(),
    locals = new Map<string, SourceLocal>();
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
        accesses.some((access) =>
          access.key !== first.key && access.offset < first.end && access.end > first.offset,
        ) ||
        memory.some((node) => node.kind === 'store' && !addresses.has(node.address.id))
      )
        continue;
      const loads = group.map((access) => access.node as Extract<Instruction, { kind: 'load' }>);
      if (loads.some((node) =>
        !sameType(node.result.type, loads[0]!.result.type) ||
        node.access.endian !== input.source!.abi.layout.endian ||
        facts?.snapshots.get(node.id)?.aliased ||
        facts?.snapshots.get(node.id)?.escaped,
      ))
        continue;
      const value = incomingStack(first.offset, loads[0]!.result.type, loads.map((node) => node.result));
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
  const frame = (retained: ReadonlySet<string>, live: ReadonlySet<string>) => {
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
          minimum_offset: minimum,
          size: maximum - minimum,
          alignment: input.source!.abi.layout.stack_alignment,
        }
      : null;
  };
  return { hidden, privateLoads, locals, addresses, returnAddressLoads, frame };
}
