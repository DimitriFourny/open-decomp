import type { OperationContext } from '../core/index.js';
import type { StackFact } from '../analysis/stack/index.js';
import { bitWidth, type Instruction, type Value } from '../ir/index.js';
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
