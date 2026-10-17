import type {
  AbiProfile,
  Address,
  Diagnostic,
  EntityId,
  OperationContext,
  RegisterDescriptor,
} from '../../core/index.js';
import { bitWidth, evaluateExpression, expressionOperands, successors } from '../../ir/index.js';
import type { Edge, Expression, RegisterBinding, SSAForm, Value } from '../../ir/index.js';
import { AnalysisBudget, type AnalysisOptions } from '../ssa/budget.js';

export type Initialization = 'initialized' | 'uninitialized' | 'maybe_initialized' | 'unknown';
export type StackValue =
  | { readonly kind: 'constant'; readonly bits: bigint }
  | { readonly kind: 'address'; readonly address: Address }
  | { readonly kind: 'stack'; readonly offset: bigint }
  | {
      readonly kind: 'stack_fragment';
      readonly offset: bigint;
      readonly offset_bits: number;
      readonly width_bits: number;
    }
  | { readonly kind: 'dynamic_stack' | 'unknown' | 'undefined' };
export interface StackFact {
  readonly value: StackValue;
  readonly initialization: Initialization;
  readonly value_ids: readonly EntityId[];
  readonly evidence_ids: readonly string[];
  /** Physical entry dependencies, not a source parameter declaration. */
  readonly incoming_registers: readonly RegisterDescriptor[];
}
export interface StackByte {
  readonly fact: StackFact;
  readonly value_offset_bits: number;
}
export interface StackSnapshot {
  readonly registers: readonly {
    readonly register: RegisterDescriptor;
    readonly fact: StackFact;
  }[];
  readonly memory: ReadonlyMap<bigint, StackByte>;
  readonly stack_pointer: StackFact;
  readonly escaped: boolean;
  readonly aliased: boolean;
}
export interface StackAccess {
  readonly node_id: EntityId;
  readonly kind: 'read' | 'write';
  readonly offset: bigint | null;
  readonly size: bigint;
  readonly region:
    | 'local_candidate'
    | 'incoming_candidate'
    | 'return_address'
    | 'shadow_space'
    | 'mixed'
    | 'dynamic';
  readonly before: StackFact;
  readonly value: StackFact;
  readonly evidence_ids: readonly string[];
}
export interface StackRecoveryOptions extends Pick<AnalysisOptions, 'max_work'> {
  readonly max_stack_bytes?: number;
}
export interface StackRecoveryResult {
  readonly state: 'complete' | 'partial';
  readonly diagnostics: readonly Diagnostic[];
  readonly work: number;
  readonly accesses: readonly StackAccess[];
  /** Pre-effect memory/register state keyed by instruction ID; terminators have exit state. */
  readonly snapshots: ReadonlyMap<EntityId, StackSnapshot>;
  readonly values: ReadonlyMap<EntityId, StackFact>;
  readonly entry: StackSnapshot | null;
  readonly frame: {
    readonly minimum_offset: bigint;
    readonly maximum_offset: bigint;
    readonly dynamic: boolean;
    readonly escaped: boolean;
    readonly aliased: boolean;
  };
}

/** Regions use callee-entry SP coordinates, never the current allocated frame. */
export function classifyStackRegion(
  abi: AbiProfile,
  offset: bigint | null,
  size: bigint,
): StackAccess['region'] {
  if (offset === null) return 'dynamic';
  const classify = (at: bigint): StackAccess['region'] =>
    at < 0n
      ? 'local_candidate'
      : at < abi.stack_return_address_bytes
        ? 'return_address'
        : abi.id === 'windows-x64' && at < 40n
          ? 'shadow_space'
          : 'incoming_candidate';
  return classify(offset) === classify(offset + size - 1n) ? classify(offset) : 'mixed';
}
const unknown: StackFact = Object.freeze({
  value: { kind: 'unknown' as const },
  initialization: 'unknown',
  value_ids: [],
  evidence_ids: [],
  incoming_registers: [],
});
const uninitialized: StackFact = Object.freeze({ ...unknown, initialization: 'uninitialized' });
function isStack(value: StackValue): boolean {
  return (
    value.kind === 'stack' || value.kind === 'stack_fragment' || value.kind === 'dynamic_stack'
  );
}
function sameValue(a: StackValue, b: StackValue): boolean {
  return (
    a.kind === b.kind &&
    (a.kind === 'constant'
      ? b.kind === 'constant' && a.bits === b.bits
      : a.kind === 'stack'
        ? b.kind === 'stack' && a.offset === b.offset
        : a.kind === 'stack_fragment'
          ? b.kind === 'stack_fragment' &&
            a.offset === b.offset &&
            a.offset_bits === b.offset_bits &&
            a.width_bits === b.width_bits
          : a.kind === 'address'
            ? b.kind === 'address' &&
              a.address.image_id === b.address.image_id &&
              a.address.space === b.address.space &&
              a.address.value === b.address.value
            : true)
  );
}
function union<T>(a: readonly T[], b: readonly T[]): T[] {
  return [...new Set([...a, ...b])];
}
function initialization(facts: readonly StackFact[]): Initialization {
  if (facts.length === 0) return 'unknown';
  if (facts.every((fact) => fact.initialization === 'initialized')) return 'initialized';
  if (facts.every((fact) => fact.initialization === 'uninitialized')) return 'uninitialized';
  return facts.some((fact) => fact.initialization === 'unknown') ? 'unknown' : 'maybe_initialized';
}
function combine(
  facts: readonly StackFact[],
  value: StackValue,
  init = initialization(facts),
): StackFact {
  return {
    value,
    initialization: init,
    value_ids: [...new Set(facts.flatMap((fact) => fact.value_ids))].sort(),
    evidence_ids: [...new Set(facts.flatMap((fact) => fact.evidence_ids))].sort(),
    incoming_registers: [
      ...new Map(
        facts.flatMap((fact) => fact.incoming_registers).map((register) => [register.id, register]),
      ).values(),
    ].sort((a, b) => a.id.localeCompare(b.id)),
  };
}
function join(a: StackFact, b: StackFact): StackFact {
  if (sameFact(a, b)) return a;
  return combine(
    [a, b],
    sameValue(a.value, b.value)
      ? a.value
      : isStack(a.value) || isStack(b.value)
        ? { kind: 'dynamic_stack' }
        : { kind: 'unknown' },
  );
}
function sameFact(a: StackFact, b: StackFact): boolean {
  return a === b || (
    sameValue(a.value, b.value) &&
    a.initialization === b.initialization &&
    a.value_ids.length === b.value_ids.length &&
    a.value_ids.every((id, index) => id === b.value_ids[index]) &&
    a.evidence_ids.length === b.evidence_ids.length &&
    a.evidence_ids.every((id, index) => id === b.evidence_ids[index]) &&
    a.incoming_registers.length === b.incoming_registers.length &&
    a.incoming_registers.every((register, index) => register.id === b.incoming_registers[index]?.id)
  );
}
function absent(offset: bigint, aliased: boolean): StackFact {
  return offset < 0n && !aliased ? uninitialized : unknown;
}

/** Reassemble a split architectural pointer only when every original bit survives. */
function assembleStack(facts: readonly StackFact[], widths: readonly number[]): StackValue | null {
  let cursor = 0,
    offset: bigint | null = null;
  for (let index = 0; index < facts.length; index++) {
    const value = facts[index]!.value;
    if (
      value.kind !== 'stack_fragment' ||
      value.offset_bits !== cursor ||
      value.width_bits !== widths[index] ||
      (offset !== null && value.offset !== offset)
    )
      return null;
    offset = value.offset;
    cursor += value.width_bits;
  }
  return cursor === 64 && offset !== null ? { kind: 'stack', offset } : null;
}

/** Byte-precise initialization with low-bits-first values. Missing negative bytes are
 * uninitialized only before an alias barrier; incoming bytes always remain unknown.
 * The caller must bound size (recoverStack uses max_stack_bytes and a work budget). */
export function inspectStackMemory(
  snapshot: Pick<StackSnapshot, 'memory' | 'aliased'>,
  offset: bigint,
  size: bigint,
  endian: 'little' | 'big' = 'little',
): StackFact {
  if (size < 0n || size > 65_536n)
    throw new RangeError('Stack observation must contain at most 65536 bytes');
  const bytes: StackByte[] = [];
  for (let index = 0n; index < size; index++)
    bytes.push(
      snapshot.memory.get(offset + index) ?? {
        fact: absent(offset + index, snapshot.aliased),
        value_offset_bits: 0,
      },
    );
  if (!bytes.length) return { ...unknown, initialization: 'initialized' };
  const first = bytes[0]!;
  if (bytes.some((byte) => byte.fact.value.kind === 'undefined'))
    return combine(
      bytes.map((byte) => byte.fact),
      { kind: 'undefined' },
      'uninitialized',
    );
  if (
    bytes.every(
      (byte, index) =>
        sameFact(byte.fact, first.fact) &&
        byte.value_offset_bits === (endian === 'little' ? index : bytes.length - index - 1) * 8,
    ) &&
    size === 8n &&
    (first.fact.value.kind === 'stack' || first.fact.value.kind === 'address')
  )
    return first.fact;
  let bits = 0n;
  const constant = bytes.every((byte) => byte.fact.value.kind === 'constant');
  if (constant)
    bytes.forEach((byte, index) => {
      if (byte.fact.value.kind === 'constant')
        bits |=
          ((byte.fact.value.bits >> BigInt(byte.value_offset_bits)) & 255n) <<
          BigInt((endian === 'little' ? index : bytes.length - index - 1) * 8);
    });
  return combine(
    bytes.map((byte) => byte.fact),
    constant
      ? { kind: 'constant', bits }
      : bytes.some((byte) => isStack(byte.fact.value))
        ? { kind: 'dynamic_stack' }
        : { kind: 'unknown' },
  );
}

/** Assemble canonical SSA register cells without assuming names, cell boundaries or
 * initialized high bits. ABI width_bits denotes meaningful bits, not root width. */
export function inspectRegister(
  snapshot: Pick<StackSnapshot, 'registers'>,
  register: RegisterDescriptor,
  width = register.width_bits,
): StackFact {
  const end = register.offset_bits + width;
  const parts = snapshot.registers
    .filter(
      (binding) =>
        binding.register.root === register.root &&
        binding.register.offset_bits < end &&
        binding.register.offset_bits + binding.register.width_bits > register.offset_bits,
    )
    .sort((a, b) => a.register.offset_bits - b.register.offset_bits);
  let cursor = register.offset_bits,
    bits = 0n,
    constant = true;
  const facts: StackFact[] = [];
  for (const part of parts) {
    const start = Math.max(register.offset_bits, part.register.offset_bits),
      stop = Math.min(end, part.register.offset_bits + part.register.width_bits);
    if (start !== cursor) return unknown;
    cursor = stop;
    facts.push(part.fact);
    if (part.fact.value.kind === 'constant')
      bits |=
        BigInt.asUintN(
          stop - start,
          part.fact.value.bits >> BigInt(start - part.register.offset_bits),
        ) << BigInt(start - register.offset_bits);
    else constant = false;
    if (
      start === register.offset_bits &&
      stop === end &&
      part.register.offset_bits === start &&
      width === part.register.width_bits
    )
      return part.fact;
  }
  if (cursor !== end) return unknown;
  if (facts.some((fact) => fact.value.kind === 'undefined'))
    return combine(facts, { kind: 'undefined' }, 'uninitialized');
  const assembled =
    register.offset_bits === 0 && width === 64
      ? assembleStack(
          facts,
          parts.map((part) => part.register.width_bits),
        )
      : null;
  return combine(
    facts,
    constant
      ? { kind: 'constant', bits }
      : (assembled ??
          (facts.some((f) => isStack(f.value)) ? { kind: 'dynamic_stack' } : { kind: 'unknown' })),
  );
}
interface State {
  parameters: StackFact[];
  memory: Map<bigint, StackByte>;
  memory_shared: boolean;
  escaped: boolean;
  aliased: boolean;
}

/** Bounded reverse-postorder priority scheduling; every pending block has one
 * fixed slot, including backedges and disconnected components. */
function stackWorklist(input: SSAForm, budget: AnalysisBudget) {
  const count = input.blocks.length, slots = new Map<EntityId, number>();
  const outgoing = new Array<readonly Edge[]>(count);
  for (let slot = 0; slot < count; slot++) {
    budget.charge();
    slots.set(input.blocks[slot]!.id, slot);
    outgoing[slot] = successors(input.blocks[slot]!.terminator);
  }
  const slotFor = (id: EntityId): number => {
    const slot = slots.get(id);
    if (slot === undefined) throw new TypeError('Stack worklist references a missing SSA block');
    return slot;
  };
  const marked = new Uint8Array(count), cursor = new Uint32Array(count);
  const frames = new Uint32Array(count), postorder = new Uint32Array(count);
  let ordered = 0;
  // The entry component comes first; remaining components use original order.
  for (let start = -1; start < count; start++) {
    budget.charge();
    const root = start < 0 ? slotFor(input.entry) : start;
    if (marked[root]) continue;
    let depth = 1;
    frames[0] = root;
    marked[root] = 1;
    budget.charge();
    while (depth > 0) {
      const slot = frames[depth - 1]!, edges = outgoing[slot]!;
      if (cursor[slot]! < edges.length) {
        budget.charge();
        const target = slotFor(edges[cursor[slot]!]!.target);
        cursor[slot] = cursor[slot]! + 1;
        if (marked[target]) continue;
        marked[target] = 1;
        frames[depth++] = target;
        budget.charge();
      } else {
        postorder[ordered++] = slot;
        depth--;
      }
    }
  }
  // Reuse DFS storage for ranks, the heap and membership; no enqueue allocates.
  const rank = cursor, heap = frames;
  for (let index = 0; index < ordered; index++) {
    budget.charge();
    rank[postorder[index]!] = ordered - index - 1;
  }
  budget.charge(count);
  marked.fill(0);
  let size = 0;
  return {
    add(id: EntityId): void {
      const slot = slotFor(id);
      if (marked[slot]) return;
      marked[slot] = 1;
      let child = size++;
      while (child > 0) {
        budget.charge();
        const parent = (child - 1) >>> 1, previous = heap[parent]!;
        if (rank[previous]! <= rank[slot]!) break;
        heap[child] = previous;
        child = parent;
      }
      heap[child] = slot;
    },
    take(): EntityId | undefined {
      if (size === 0) return undefined;
      const first = heap[0]!, last = heap[--size]!;
      marked[first] = 0;
      if (size > 0) {
        let parent = 0;
        while (parent * 2 + 1 < size) {
          let child = parent * 2 + 1;
          if (child + 1 < size) {
            budget.charge();
            if (rank[heap[child + 1]!]! < rank[heap[child]!]!) child++;
          }
          budget.charge();
          if (rank[last]! <= rank[heap[child]!]!) break;
          heap[parent] = heap[child]!;
          parent = child;
        }
        heap[parent] = last;
      }
      return input.blocks[first]!.id;
    },
    edges(id: EntityId): readonly Edge[] { return outgoing[slotFor(id)]!; },
  };
}

/** Shared, nonrewriting stack interpreter for validated immutable SSA. Uses affine
 * entry-SP offsets, exact byte stores, simultaneous edge transfer and a bounded
 * monotone join. Both arms of unresolved branches are retained. Changing loop
 * offsets widen to dynamic_stack; pointer taint survives casts/partial stores and
 * unknown writes. Unknown stores and read/write effects are whole-stack alias
 * barriers (deliberately conservative, not a points-to analysis). Calls capture
 * any stack-derived physical input, including nested pointers in stack storage.
 * No negative offset alone establishes a local/source type or complete frame size.
 * Windows entry +0..7 is the return address, +8..39 home space, +40 arguments;
 * SysV entry +0..7 is the return address and +8 starts incoming arguments;
 * Darwin entry +0 is incoming argument storage. Negative offsets remain local
 * candidates, never proof of ABI red-zone ownership. On exhaustion facts clear.
 * Defaults: one million charged work units and 65536 distinct tracked bytes per
 * state. Sub-byte memory operations retain uncertainty rather than padding bits.
 * Result maps are read-only views owned by this result; the input is never mutated.
 */
export function recoverStack(
  input: SSAForm,
  abi: AbiProfile,
  context: OperationContext,
  options: StackRecoveryOptions = {},
): StackRecoveryResult {
  const budget = new AnalysisBudget({ ...options, checkpoint: (work) => context.checkpoint(work) });
  const maxBytes = options.max_stack_bytes ?? 65_536;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 65_536)
    throw new RangeError('Invalid stack byte bound');
  const empty = {
    accesses: [],
    snapshots: new Map<EntityId, StackSnapshot>(),
    values: new Map<EntityId, StackFact>(),
    entry: null,
    frame: {
      minimum_offset: 0n,
      maximum_offset: 0n,
      dynamic: false,
      escaped: false,
      aliased: false,
    },
  };
  try {
    budget.charge(input.blocks.length + input.register_states.length);
    const blocks = new Map(input.blocks.map((block) => [block.id, block]));
    const rows = new Map(input.register_states.map((row) => [row.block, row]));
    const stackValues = new Set<EntityId>();
    const noteStackBindings = (bindings: readonly RegisterBinding[]): void => {
      budget.charge(bindings.length);
      for (const binding of bindings)
        if (binding.register.root === abi.stack_pointer.root) stackValues.add(binding.value.id);
    };
    for (const row of input.register_states) {
      noteStackBindings(row.entry);
      noteStackBindings(row.exit);
    }
    for (const block of input.blocks)
      for (const node of block.instructions) {
        budget.charge();
        if ('register_inputs' in node) noteStackBindings(node.register_inputs);
        if ('register_outputs' in node) noteStackBindings(node.register_outputs);
      }
    const values = new Map<EntityId, StackFact>();
    const edgeUsers = new Map<EntityId, { edge: Edge; index: number }[]>();
    const dirtyEdges = new Map<Edge, Set<number>>();
    const dirtyParameters = new Map<EntityId, Set<number>>();
    const transferred = new Set<EntityId>();
    const publish = (id: EntityId, fact: StackFact): StackFact => {
      const previous = values.get(id);
      if (previous && sameFact(previous, fact)) return previous;
      values.set(id, fact);
      for (const { edge, index } of edgeUsers.get(id) ?? []) {
        budget.charge();
        const row = dirtyEdges.get(edge) ?? new Set<number>();
        row.add(index);
        dirtyEdges.set(edge, row);
      }
      return fact;
    };
    const entryBlock = blocks.get(input.entry)!;
    const entryBindings = rows.get(input.entry)!.entry;
    budget.charge(entryBindings.length + entryBlock.parameters.length);
    const entryByValue = new Map(entryBindings.map((binding) => [binding.value.id, binding]));
    const parameters = entryBlock.parameters.map((parameter) => {
      const binding = entryByValue.get(parameter.id);
      return binding
        ? {
            ...unknown,
            value:
              binding.register.root === abi.stack_pointer.root
                ? binding.register.offset_bits === 0 && binding.register.width_bits === 64
                  ? { kind: 'stack' as const, offset: 0n }
                  : {
                      kind: 'stack_fragment' as const,
                      offset: 0n,
                      offset_bits: binding.register.offset_bits,
                      width_bits: binding.register.width_bits,
                    }
                : { kind: 'unknown' as const },
            initialization:
              binding.register.root === abi.stack_pointer.root
                ? ('initialized' as const)
                : ('unknown' as const),
            value_ids: [parameter.id],
            incoming_registers: [binding.register],
          }
        : { ...unknown, value_ids: [parameter.id] };
    });
    const initial: State = { parameters, memory: new Map(), memory_shared: false, escaped: false, aliased: false };
    const incoming = new Map<EntityId, State>([[input.entry, initial]]);
    const pendingBlocks = stackWorklist(input, budget);
    pendingBlocks.add(input.entry);
    const snapshots = new Map<EntityId, StackSnapshot>();
    const accesses: StackAccess[] = [];
    const frame = {
      minimum_offset: 0n,
      maximum_offset: 0n,
      dynamic: false,
      escaped: false,
      aliased: false,
    };
    const get = (value: Value): StackFact => {
      const fact = values.get(value.id) ?? unknown;
      if (stackValues.has(value.id) && !isStack(fact.value) && fact.value.kind !== 'undefined') {
        return publish(value.id, { ...fact, value: { kind: 'dynamic_stack' } });
      }
      return fact;
    };
    // Working states borrow predecessor/snapshot maps until their first write.
    // Every fork marks both states shared; byte/fact records are immutable.
    // A barrier's byte transform is idempotent until this exact private map is
    // written. COW preserves the invariant on unmodified predecessor snapshots.
    const barrierInvariant = new WeakSet<Map<bigint, StackByte>>();
    const mutableMemory = (state: State): Map<bigint, StackByte> => {
      if (state.memory_shared) {
        budget.charge(state.memory.size);
        state.memory = new Map(state.memory);
        state.memory_shared = false;
      }
      barrierInvariant.delete(state.memory);
      return state.memory;
    };
    const snapshot = (state: State, bindings: readonly RegisterBinding[]): StackSnapshot => {
      budget.charge(bindings.length);
      const registers = bindings.map((binding) => ({
        register: binding.register,
        fact: get(binding.value),
      }));
      state.memory_shared = true;
      return {
        registers,
        memory: state.memory,
        stack_pointer: inspectRegister({ registers }, abi.stack_pointer),
        escaped: state.escaped,
        aliased: state.aliased,
      };
    };
    const barrier = (state: State): void => {
      state.aliased = true;
      budget.charge();
      if (barrierInvariant.has(state.memory)) return;
      for (const [offset, byte] of state.memory) {
        budget.charge();
        if (byte.fact.initialization === 'unknown' &&
          (byte.fact.value.kind === 'unknown' || byte.fact.value.kind === 'dynamic_stack')) continue;
        mutableMemory(state).set(offset, {
          fact: {
            ...byte.fact,
            value: isStack(byte.fact.value) ? { kind: 'dynamic_stack' } : { kind: 'unknown' },
            initialization: 'unknown',
          },
          value_offset_bits: byte.value_offset_bits,
        });
      }
      barrierInvariant.add(state.memory);
    };
    const region = (offset: bigint | null, size: bigint): StackAccess['region'] =>
      classifyStackRegion(abi, offset, size);
    const evaluate = (expression: Expression, result: Value): StackFact => {
      const operands = expressionOperands(expression).map(get);
      let value: StackValue = { kind: 'unknown' };
      if (expression.kind === 'address') value = { kind: 'address', address: expression.address };
      else if (expression.kind === 'indeterminate')
        return {
          ...unknown,
          value: { kind: expression.state },
          initialization: expression.state === 'undefined' ? 'uninitialized' : 'unknown',
        };
      else if (expression.kind === 'select') {
        const condition = get(expression.condition).value;
        return condition.kind === 'constant'
          ? get(condition.bits === 0n ? expression.when_false : expression.when_true)
          : join(get(expression.when_true), get(expression.when_false));
      } else if (
        expression.kind === 'integer' &&
        bitWidth(result.type) === 64 &&
        (expression.op === 'add' || expression.op === 'sub')
      ) {
        const a = operands[0]!.value,
          b = operands[1]!.value;
        if (a.kind === 'stack' && b.kind === 'constant')
          value = {
            kind: 'stack',
            offset: BigInt.asIntN(
              64,
              a.offset +
                (expression.op === 'add' ? BigInt.asIntN(64, b.bits) : -BigInt.asIntN(64, b.bits)),
            ),
          };
        else if (a.kind === 'constant' && b.kind === 'stack' && expression.op === 'add')
          value = {
            kind: 'stack',
            offset: BigInt.asIntN(64, b.offset + BigInt.asIntN(64, a.bits)),
          };
      } else if (
        expression.kind === 'cast' &&
        expression.op === 'bitcast' &&
        bitWidth(expression.value.type) === bitWidth(result.type)
      )
        return get(expression.value);
      else if (
        expression.kind === 'extract' &&
        expression.offset === 0 &&
        bitWidth(expression.value.type) === bitWidth(result.type)
      )
        return get(expression.value);
      else if (expression.kind === 'extract') {
        const source = get(expression.value);
        if (source.value.kind === 'stack' || source.value.kind === 'stack_fragment')
          return {
            ...source,
            value: {
              kind: 'stack_fragment',
              offset: source.value.offset,
              offset_bits:
                (source.value.kind === 'stack_fragment' ? source.value.offset_bits : 0) +
                expression.offset,
              width_bits: bitWidth(result.type),
            },
          };
      } else if (expression.kind === 'concat') {
        const assembled = assembleStack(
          operands,
          expression.values.map((value) => bitWidth(value.type)),
        );
        if (assembled) return combine(operands, assembled);
      }
      if (value.kind === 'unknown') {
        const evaluated = evaluateExpression(result.type, expression, (operand) => {
          const fact = get(operand).value;
          return fact.kind === 'constant'
            ? { kind: 'bits', bits: fact.bits }
            : fact.kind === 'undefined'
              ? { kind: 'undefined', reason: 'Undefined stack operand' }
              : { kind: 'unknown', reason: 'Nonconstant stack operand' };
        });
        value =
          evaluated.kind === 'bits'
            ? { kind: 'constant', bits: evaluated.bits }
            : evaluated.kind === 'undefined'
              ? { kind: 'undefined' }
              : operands.some((fact) => isStack(fact.value))
                ? { kind: 'dynamic_stack' }
                : { kind: 'unknown' };
      }
      return combine(
        operands,
        value,
        value.kind === 'constant' || value.kind === 'address'
          ? 'initialized'
          : value.kind === 'undefined'
            ? 'uninitialized'
            : initialization(operands),
      );
    };
    const transfer = (id: EntityId, record: boolean): State => {
      const block = blocks.get(id)!,
        incomingState = incoming.get(id)!;
      incomingState.memory_shared = true;
      const state: State = { ...incomingState };
      if (!transferred.has(id)) {
        budget.charge(block.parameters.length);
        block.parameters.forEach((parameter, index) =>
          publish(parameter.id, incomingState.parameters[index]!));
        transferred.add(id);
      } else {
        const changed = dirtyParameters.get(id);
        dirtyParameters.delete(id);
        budget.charge(changed?.size ?? 0);
        for (const index of changed ?? [])
          publish(block.parameters[index]!.id, incomingState.parameters[index]!);
      }
      for (const node of block.instructions) {
        budget.charge();
        if (node.kind === 'assign') {
          const fact = evaluate(node.expression, node.result);
          publish(node.result.id, {
            ...fact,
            value_ids: union(fact.value_ids, [node.result.id]).sort(),
            evidence_ids: union(fact.evidence_ids, node.provenance.evidence_ids).sort(),
          });
          if (record) {
            if (fact.value.kind === 'stack') {
              frame.minimum_offset =
                fact.value.offset < frame.minimum_offset ? fact.value.offset : frame.minimum_offset;
              frame.maximum_offset =
                fact.value.offset > frame.maximum_offset ? fact.value.offset : frame.maximum_offset;
            } else if (fact.value.kind === 'dynamic_stack') frame.dynamic = true;
          }
        } else if (node.kind === 'load' || node.kind === 'store') {
          if (record) snapshots.set(node.id, snapshot(state, node.register_inputs));
          const address = get(node.address),
            width = bitWidth(node.kind === 'load' ? node.result.type : node.value.type),
            size = BigInt(Math.ceil(width / 8));
          const offset = address.value.kind === 'stack' ? address.value.offset : null;
          budget.charge(Number(size));
          const before =
            offset === null ? unknown : inspectStackMemory(state, offset, size, node.access.endian);
          const source = node.kind === 'store' ? get(node.value) : before;
          const fact = {
            ...source,
            evidence_ids: union(source.evidence_ids, node.provenance.evidence_ids).sort(),
          };
          if (record && isStack(address.value))
            accesses.push({
              node_id: node.id,
              kind: node.kind === 'load' ? 'read' : 'write',
              offset,
              size,
              region: region(offset, size),
              before,
              value: fact,
              evidence_ids: node.provenance.evidence_ids,
            });
          if (node.kind === 'load')
            publish(node.result.id, {
              ...fact,
              value_ids: union(fact.value_ids, [node.result.id]).sort(),
              evidence_ids: union(fact.evidence_ids, node.provenance.evidence_ids).sort(),
            });
          else if (offset !== null) {
            for (let index = 0n; index < size; index++) {
              budget.charge();
              const at = offset + index, previous = state.memory.get(at);
              if (!previous && state.memory.size >= maxBytes)
                budget.charge(budget.limit + 1);
              const byte: StackByte = {
                fact:
                  width % 8 === 0
                    ? fact
                    : {
                        ...fact,
                        value: isStack(fact.value)
                          ? { kind: 'dynamic_stack' }
                          : { kind: 'unknown' },
                        initialization: 'unknown',
                      },
                value_offset_bits:
                  Number(node.access.endian === 'little' ? index : size - index - 1n) * 8,
              };
              if (!previous || previous.value_offset_bits !== byte.value_offset_bits ||
                !sameFact(previous.fact, byte.fact))
                mutableMemory(state).set(at, byte);
            }
          } else {
            if (isStack(fact.value)) state.escaped = true;
            barrier(state);
          }
        } else if (node.kind === 'call' || node.kind === 'unknown_effect') {
          if (record) snapshots.set(node.id, snapshot(state, node.register_inputs));
          if (
            [
              ...(node.kind === 'call' ? node.arguments.map(get) : []),
              ...node.register_inputs
                .filter((binding) => binding.register.root !== abi.stack_pointer.root)
                .map((binding) => get(binding.value)),
            ].some((fact) => isStack(fact.value))
          )
            state.escaped = true;
          if (!state.escaped) {
            for (const byte of state.memory.values()) {
              budget.charge();
              if (isStack(byte.fact.value)) {
                state.escaped = true;
                break;
              }
            }
          }
          if (node.clobbers.memory === 'unknown_read_write') barrier(state);
          for (const binding of node.register_outputs)
            publish(binding.value.id, {
              ...unknown,
              value_ids: [binding.value.id],
              evidence_ids: node.provenance.evidence_ids,
            });
          if (node.kind === 'call')
            for (const value of node.results)
              publish(value.id, {
                ...unknown,
                value_ids: [value.id],
                evidence_ids: node.provenance.evidence_ids,
              });
        }
      }
      if (block.terminator.kind === 'return') {
        const outputs = [...block.terminator.values.map(get)];
        for (const binding of rows.get(id)!.exit) {
          budget.charge();
          const register = binding.register;
          if (
            register.root !== abi.stack_pointer.root &&
            !abi.preserved.some(
              (preserved) =>
                preserved.root === register.root &&
                preserved.offset_bits <= register.offset_bits &&
                preserved.offset_bits + preserved.width_bits >=
                  register.offset_bits + register.width_bits,
            )
          )
            outputs.push(get(binding.value));
        }
        if (outputs.some((fact) => isStack(fact.value))) state.escaped = true;
      }
      if (record) {
        const exit = snapshot(state, rows.get(id)!.exit);
        snapshots.set(block.terminator.id, exit);
        if (
          exit.registers.some((binding) => binding.register.root === abi.stack_pointer.root) &&
          exit.stack_pointer.value.kind !== 'stack'
        )
          frame.dynamic = true;
        for (const fact of [
          ...exit.registers.map((binding) => binding.fact),
          ...block.parameters.map(get),
        ]) {
          if (fact.value.kind === 'stack') {
            frame.minimum_offset =
              fact.value.offset < frame.minimum_offset ? fact.value.offset : frame.minimum_offset;
            frame.maximum_offset =
              fact.value.offset > frame.maximum_offset ? fact.value.offset : frame.maximum_offset;
          }
          if (fact.value.kind === 'dynamic_stack') frame.dynamic = true;
        }
        frame.escaped ||= state.escaped;
        frame.aliased ||= state.aliased;
      }
      return state;
    };
    const posted = new Map<Edge, Readonly<Pick<State, 'memory' | 'escaped' | 'aliased'>>>();
    for (let id = pendingBlocks.take(); id !== undefined; id = pendingBlocks.take()) {
      budget.charge();
      const state = transfer(id, false);
      for (const edge of pendingBlocks.edges(id)) {
        budget.charge();
        const last = posted.get(edge), pending = dirtyEdges.get(edge);
        const memoryChanged = !last || last.memory !== state.memory ||
          last.escaped !== state.escaped || last.aliased !== state.aliased;
        if (last && !pending?.size && !memoryChanged) continue;
        dirtyEdges.delete(edge);
        budget.charge(last ? pending?.size ?? 0 : edge.arguments.length);
        state.memory_shared = true;
        const previous = incoming.get(edge.target);
        const next: State = {
          ...state,
          parameters: previous?.parameters ?? new Array<StackFact>(edge.arguments.length),
          memory_shared: true,
        };
        let changed = !previous;
        const contribute = (index: number): void => {
          const fact = get(edge.arguments[index]!);
          if (!previous) { next.parameters[index] = fact; return; }
          const prior = previous.parameters[index]!, merged = join(prior, fact);
          if (sameFact(prior, merged)) return;
          // Entry snapshots retain the original ABI inputs even if an unusual
          // backedge targets the entry. Other parameter arrays are solver-owned.
          if (next.parameters === parameters) {
            budget.charge(parameters.length);
            next.parameters = [...parameters];
          }
          next.parameters[index] = merged;
          if (transferred.has(edge.target)) {
            const row = dirtyParameters.get(edge.target) ?? new Set<number>();
            row.add(index);
            dirtyParameters.set(edge.target, row);
          }
          changed = true;
        };
        if (!last) {
          edge.arguments.forEach((argument, index) => {
            const row = edgeUsers.get(argument.id) ?? [];
            row.push({ edge, index });
            edgeUsers.set(argument.id, row);
            contribute(index);
          });
        } else for (const index of pending ?? []) contribute(index);
        // get() can promote this edge's own SP source during the visit; its
        // returned fact has already contributed. Other edges retain their events.
        dirtyEdges.delete(edge);
        if (previous) {
          next.escaped ||= previous.escaped;
          next.aliased ||= previous.aliased;
          changed ||= next.escaped !== previous.escaped || next.aliased !== previous.aliased;
          previous.memory_shared = true;
          next.memory = previous.memory;
          if (memoryChanged && previous.memory !== state.memory)
            for (const offset of new Set([...previous.memory.keys(), ...state.memory.keys()])) {
              budget.charge();
              const a = previous.memory.get(offset), b = state.memory.get(offset);
              const merged = join(
                a?.fact ?? absent(offset, previous.aliased),
                b?.fact ?? absent(offset, state.aliased),
              );
              const sameOffset = a && b && a.value_offset_bits === b.value_offset_bits;
              const byte = {
                fact: sameOffset ? merged : {
                  ...merged,
                  value: isStack(merged.value)
                    ? { kind: 'dynamic_stack' as const } : { kind: 'unknown' as const },
                },
                value_offset_bits: sameOffset ? a.value_offset_bits : 0,
              };
              if (!a || a.value_offset_bits !== byte.value_offset_bits || !sameFact(a.fact, byte.fact)) {
                mutableMemory(next).set(offset, byte);
                changed = true;
              }
            }
          if (next.memory.size > maxBytes) budget.charge(budget.limit + 1);
        }
        posted.set(edge, { memory: state.memory, escaped: state.escaped, aliased: state.aliased });
        if (changed) {
          incoming.set(edge.target, next);
          pendingBlocks.add(edge.target);
        }
      }
    }
    for (const block of input.blocks) if (incoming.has(block.id)) transfer(block.id, true);
    const entryRegisters = entryBindings.map((binding) => ({
      register: binding.register,
      fact: parameters[
        entryBlock.parameters.findIndex((parameter) => parameter.id === binding.value.id)
      ]!,
    }));
    const entry: StackSnapshot = {
      registers: entryRegisters,
      memory: new Map(),
      stack_pointer: inspectRegister({ registers: entryRegisters }, abi.stack_pointer),
      escaped: false,
      aliased: false,
    };
    for (const access of accesses)
      if (access.offset !== null) {
        frame.minimum_offset =
          access.offset < frame.minimum_offset ? access.offset : frame.minimum_offset;
        frame.maximum_offset =
          access.offset + access.size > frame.maximum_offset
            ? access.offset + access.size
            : frame.maximum_offset;
      } else frame.dynamic = true;
    return {
      state: 'complete',
      diagnostics: [],
      work: budget.work,
      accesses,
      snapshots,
      values,
      entry,
      frame,
    };
  } catch (error) {
    const result = budget.result(empty, error);
    return { ...empty, state: result.state, diagnostics: result.diagnostics, work: result.work };
  }
}
