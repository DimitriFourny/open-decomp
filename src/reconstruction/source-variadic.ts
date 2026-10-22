import type { OperationContext, RegisterDescriptor } from '../core/index.js';
import type { StackFact } from '../analysis/stack/index.js';
import { instructionOperands } from '../analysis/effects/index.js';
import {
  bitWidth,
  expressionOperands,
  type Expression,
  type Instruction,
  type Value,
} from '../ir/index.js';
import type { BlockRegion } from '../presentation/index.js';
import type { EmissionInput } from '../emitters/model.js';
import type { BoundaryProjection } from './model.js';
import type { LocalValidationSession } from './local-validation.js';
type Store = Extract<Instruction, { kind: 'store' }>;

/** Darwin arm64 passes every variadic argument in 8-byte outgoing stack slots
 * starting at SP+0. When the callee lets a pointer into its incoming argument
 * area escape (an escaping `va_list`), a contiguous run of such slots written
 * by this body is presented as observed anonymous trailing arguments. Each slot
 * must be written by exactly one store that reaches the call on every path,
 * starts at the slot, is not a frame save, a private local or hidden traffic,
 * holds no stack address, and is read by no load and visible at no other call
 * or tail call. The run stops at the first slot failing any condition; later
 * stores stay explicit statements and the remainder marker stays, so no
 * argument is dropped and the source arity remains open. */
export function planVariadicStackArguments(
  input: EmissionInput,
  blocks: ReadonlyMap<string, BlockRegion>,
  calls: Map<string, BoundaryProjection>,
  excluded: (store: string) => boolean,
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
  const callees = new Map([...inferred].filter(([, callee]) => callee.variadic_stack));
  if (!callees.size) return consumed;
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
  const leaks = (id: string): boolean =>
    stack.snapshots
      .get(id)
      ?.registers.some(
        (row) =>
          row.register.root !== source.abi.stack_pointer.root &&
          !preserved.has(row.register.root) &&
          stackKind(row.fact),
      ) ?? true;
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
  for (const block of blocks.values())
    for (const node of block.statements) {
      context.checkpoint(1);
      if (node.kind !== 'call') continue;
      const callee = callees.get(node.id),
        projection = calls.get(node.id);
      // Unnamed arguments follow every fixed one. An observed prefix fixes the
      // tail's position; an ambiguous callee keeps its fully bound caller-side
      // prefix, which the rendered note marks as possibly incomplete. Fixed
      // stack parameters would precede the tail.
      if (
        !callee ||
        callee.stack_parameters?.length ||
        !(
          (projection?.kind === 'inferred' && projection.argument_list_complete === false) ||
          (projection?.kind === 'physical' &&
            callee.parameter_state === 'ambiguous' &&
            projection.arguments.length === callee.parameters.length)
        )
      )
        continue;
      const snapshot = stack.snapshots.get(node.id),
        sp = snapshot?.stack_pointer.value;
      if (!snapshot || sp?.kind !== 'stack') continue;
      const taken: Store[] = [];
      for (let index = 0n; index < 32n; index++) {
        context.checkpoint(1);
        const start = sp.offset + index * slot,
          cell = snapshot.memory.get(start),
          owner = cell && owners.get(cell.fact);
        if (
          !cell ||
          !owner ||
          owner.offset !== start ||
          owner.size > slot ||
          cell.value_offset_bits !== 0 ||
          cell.fact.initialization !== 'initialized' ||
          owner.store.access.volatile ||
          BigInt(Math.ceil(bitWidth(owner.store.value.type) / 8)) !== owner.size ||
          excluded(owner.store.id) ||
          consumed.has(owner.store.id)
        )
          break;
        let exact = true;
        for (let byte = 0n; byte < slot && exact; byte++) {
          context.checkpoint(1);
          const other = snapshot.memory.get(start + byte);
          exact =
            byte < owner.size
              ? other?.fact === cell.fact && other.value_offset_bits === Number(byte) * 8
              : other === undefined || owners.get(other.fact) === undefined;
        }
        if (
          !exact ||
          reads.some((read) => read.start < start + owner.size && read.end > start) ||
          // Another stack-reading boundary may see these bytes unless a known
          // different store owns them there (a barrier's unknown copy may
          // still hold this value; an absent byte was never written there).
          boundaries.some((id) => {
            if (id === node.id) return false;
            const memory = stack.snapshots.get(id)?.memory;
            if (!memory) return true;
            for (let byte = 0n; byte < owner.size; byte++) {
              const other = memory.get(start + byte);
              if (other && (other.fact === cell.fact || !owners.has(other.fact))) return true;
            }
            return false;
          })
        )
          break;
        taken.push(owner.store);
      }
      if (
        !taken.length ||
        !validation.presentation(
          'variadic_stack_arguments',
          node.id,
          'Darwin arm64 variadic outgoing stack slots presented as observed trailing call arguments; the callee lets an incoming-stack pointer escape and the source arity stays open',
          taken.map((store) => store.id),
        )
      )
        continue;
      validation.requireAbi(
        'darwin_variadic_stack_arguments',
        [node.id],
        'Presenting outgoing stack stores as trailing arguments assumes the Darwin arm64 variadic convention (every unnamed argument in consecutive 8-byte stack slots from SP+0) holds for this call.',
      );
      const values: Value[] = taken.map((store) => store.value);
      for (const store of taken) consumed.set(store.id, node.id);
      calls.set(node.id, {
        ...projection,
        arguments: [...projection.arguments, ...values],
        argument_list_complete: false,
      });
    }
  return consumed;
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
  const registers = (type: 'integer' | 'float'): RegisterDescriptor[] =>
    abi
      .classifyCall({
        returns: { kind: 'void' },
        parameters: Array.from({ length: 4 }, () =>
          type === 'integer'
            ? { kind: 'integer' as const, bits: 64, signed: false }
            : { kind: 'float' as const, bits: 64 as const },
        ),
        variadic: false,
        fixed_parameter_count: 4,
      })
      .parameters.flatMap((parameter) => {
        const location = parameter.locations[0];
        return location?.kind === 'register' && parameter.locations.length === 1
          ? [{ ...location.register, width_bits: location.width_bits }]
          : [];
      });
  const integers = registers('integer'),
    floats = registers('float');
  if (integers.length !== 4 || floats.length !== 4) return null;
  const named = Number((area - 8n) / 8n);
  // The whole 64-bit entry value of `root`: its one full cell or its cells
  // concatenated low to high, possibly through same-width bitcasts.
  const entryValue = (start: Value, root: string): boolean => {
    let value = start;
    for (let depth = 0; depth < 8 && bitWidth(value.type) === 64; depth++) {
      const expression = facts.expressions.get(value.id);
      let low = 0;
      for (const piece of expression?.kind === 'concat' ? expression.values : [value]) {
        const binding = entry.register_entry.find(
          (candidate) => candidate.value.id === piece.id && candidate.register.root === root,
        );
        if (
          binding?.register.offset_bits !== low ||
          bitWidth(piece.type) !== binding.register.width_bits
        ) {
          low = -1;
          break;
        }
        low += binding.register.width_bits;
      }
      if (low === 64) return true;
      if (expression?.kind !== 'cast' || expression.op !== 'bitcast') return false;
      value = expression.value;
    }
    return false;
  };
  const stores: string[] = [];
  for (let index = named; index < 4; index++) {
    const slot = 8n + 8n * BigInt(index);
    const own = accesses.filter(
      (access) =>
        access.node.kind === 'store' &&
        access.offset === slot &&
        access.end === slot + 8n &&
        entryValue(access.node.value, integers[index]!.root),
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
  // Uses: every value an effect, a control decision, a call or tail argument,
  // or a projected result depends on. The home stores' values are va_start's.
  // A memory access's register snapshot is fault state, not a source use.
  const reached = new Set<string>(),
    pending: Value[] = [];
  // A register still holding its own entry value at an exit is not a use.
  const exits = (bindings: readonly { register: RegisterDescriptor; value: Value }[]) => {
    for (const binding of bindings)
      if (
        !entry.register_entry.some(
          (cell) =>
            cell.value.id === binding.value.id && cell.register.root === binding.register.root,
        )
      )
        pending.push(binding.value);
  };
  for (const block of blocks.values()) {
    for (const node of block.statements) {
      context.checkpoint(1);
      if (node.kind === 'load') pending.push(node.address);
      else if (node.kind === 'store')
        pending.push(...(homeStores.has(node.id) ? [node.address] : [node.address, node.value]));
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
  while (pending.length) {
    context.checkpoint(1);
    const value = pending.pop()!;
    if (reached.has(value.id)) continue;
    reached.add(value.id);
    const expression = facts.expressions.get(value.id);
    if (expression) pending.push(...expressionOperands(expression));
    pending.push(...(facts.incoming.get(value.id) ?? []));
  }
  // Only the argument bits count: a vector register's upper lanes may flow
  // through unchanged into a result's register image.
  const used = (register: RegisterDescriptor): boolean =>
    entry.register_entry.some(
      (binding) =>
        binding.register.root === register.root &&
        binding.register.offset_bits < register.offset_bits + register.width_bits &&
        binding.register.offset_bits + binding.register.width_bits > register.offset_bits &&
        reached.has(binding.value.id),
    );
  const positions: RegisterDescriptor[] = [];
  for (let index = 0; index < 4; index++) {
    const integer = used(integers[index]!),
      float = used(floats[index]!);
    if (index >= named ? integer || float : integer && float) return null;
    if (index < named) positions.push(float ? floats[index]! : integers[index]!);
  }
  return { offset: area, named: positions, stores };
}
