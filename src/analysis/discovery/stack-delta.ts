import type {
  Address,
  Arm64Payload,
  DecodedInstruction,
  OperationContext,
  X86Payload,
} from '../../core/index.js';

/** Stack-pointer offset from the root's entry SP, or null when it is not one known constant. */
export type StackDelta = bigint | null;

export interface StackDeltaInput {
  readonly entry: bigint;
  readonly instruction: (address: bigint) => DecodedInstruction | undefined;
  /** Intraprocedural successors of a member; another root's entry is no successor. */
  readonly successors: (instruction: DecodedInstruction) => readonly Address[];
}

/** SP-delta must-dataflow over the decoded instructions reachable from a root entry: the offset
 * of SP from the entry SP before each member, equal on every decoded path to it, or null.
 *
 * Exact adjustments are modeled (x86 push/pop, `add`/`sub` of an immediate, `lea` from SP;
 * ARM64 `add`/`sub` of an immediate and SP-based pre/post-index writeback); any other SP write,
 * an instruction without payload, or an ARM64 instruction of unknown behavior gives null. A call
 * leaves SP as it was: the callee returns to the fallthrough with SP restored (ABI premise).
 * Each member's state only moves down the lattice (unvisited, constant, null), so the
 * worklist ends after at most two visits per member. */
export function stackDeltas(
  input: StackDeltaInput,
  context: OperationContext,
): Map<bigint, StackDelta> {
  const before = new Map<bigint, StackDelta>([[input.entry, 0n]]);
  const work = [input.entry];
  const pending = new Set(work);
  while (work.length) {
    context.checkpoint(1);
    const address = work.pop()!;
    pending.delete(address);
    const instruction = input.instruction(address);
    if (!instruction) continue;
    const delta = before.get(address)!;
    const after = delta === null ? null : transfer(instruction, delta);
    for (const successor of input.successors(instruction)) {
      const known = before.get(successor.value);
      if (known === null || known === after) continue;
      before.set(successor.value, known === undefined ? after : null);
      if (!pending.has(successor.value)) {
        pending.add(successor.value);
        work.push(successor.value);
      }
    }
  }
  return before;
}

function transfer(instruction: DecodedInstruction, delta: bigint): StackDelta {
  const payload = instruction.payload;
  if (instruction.validity !== 'valid' || !payload) return null;
  // The callee pops its own return address (x86) and preserves SP (both ABIs).
  if (instruction.flow.kind === 'call') return delta;
  return payload.architecture === 'x86_64' ? x86(payload, delta) : arm64(payload, delta);
}

function x86(payload: X86Payload, delta: bigint): StackDelta {
  const writesStack = payload.registers.some(
    (access) =>
      access.register.role === 'stack_pointer' &&
      access.access !== 'read' &&
      access.access !== 'conditional_read' &&
      access.access !== 'none',
  );
  if (!writesStack) return delta;
  const mnemonic = payload.mnemonic.toLowerCase();
  const operands = payload.operands;
  const first = operands[0];
  const explicitStack =
    first?.kind === 'register' &&
    first.register.role === 'stack_pointer' &&
    first.register.width_bits === 64;
  if (/^push(?:f|fq)?$/.test(mnemonic)) {
    const slot = payload.memory.filter(
      (memory) => memory.base?.role === 'stack_pointer' && memory.access === 'write',
    );
    return slot.length === 1 && slot[0]!.index === null ? delta + slot[0]!.displacement : null;
  }
  if (/^pop(?:f|fq)?$/.test(mnemonic)) {
    if (
      operands.some((operand) => operand.kind !== 'register' || operand.register.role !== 'general')
    )
      return null;
    const slot = payload.memory;
    return slot.length === 1 &&
      slot[0]!.base?.role === 'stack_pointer' &&
      slot[0]!.index === null &&
      slot[0]!.displacement === 0n &&
      slot[0]!.access === 'read'
      ? delta + BigInt(slot[0]!.access_bits / 8)
      : null;
  }
  const second = operands[1];
  if ((mnemonic === 'add' || mnemonic === 'sub') && explicitStack && second?.kind === 'immediate') {
    const amount = BigInt.asIntN(
      second.effective_bits,
      second.value & ((1n << BigInt(second.effective_bits)) - 1n),
    );
    return mnemonic === 'add' ? delta + amount : delta - amount;
  }
  if (
    mnemonic === 'lea' &&
    explicitStack &&
    second?.kind === 'memory' &&
    second.memory.base?.role === 'stack_pointer' &&
    second.memory.base.width_bits === 64 &&
    second.memory.index === null &&
    second.memory.segment === null &&
    second.memory.address_bits === 64
  )
    return delta + second.memory.displacement;
  return null;
}

function arm64(payload: Arm64Payload, delta: bigint): StackDelta {
  if (payload.behavior === 'nop') return delta;
  if (payload.behavior !== 'instruction') return null;
  const operands = payload.operands;
  const first = operands[0];
  const second = operands[1];
  const match = /^(ADD|SUB)_64_addsub_imm$/.exec(payload.canonical_encoding);
  if (
    match &&
    first?.kind === 'register' &&
    first.register.role === 'stack_pointer' &&
    second?.kind === 'register' &&
    second.register.role === 'stack_pointer'
  ) {
    const amount = (payload.fields.imm12 ?? 0n) << (payload.fields.sh ? 12n : 0n);
    return match[1] === 'ADD' ? delta + amount : delta - amount;
  }
  // Any other register write of SP (a destination is always the first operand).
  if (first?.kind === 'register' && first.register.role === 'stack_pointer') return null;
  let next = delta;
  for (const operand of operands) {
    if (operand.kind === 'scalable_memory' && operand.writeback !== 'none') return null;
    if (operand.kind !== 'memory' || operand.writeback === 'none') continue;
    if (operand.base.role !== 'stack_pointer') continue;
    if (operand.base.width_bits !== 64 || operand.index !== null) return null;
    next += operand.displacement;
  }
  return next;
}
