import {
  entityIdentity,
  fingerprint,
  type Address,
  type Decoder,
  type DecodedInstruction,
  type Evidence,
  type FunctionGraph,
  type ImportRecord,
  type LoadedImage,
  type OperationContext,
  type ReferenceRecord,
  type X86Payload,
} from '../../core/index.js';

/** A function whose whole body forwards control to one loader-bound import. */
export interface ImportStub {
  readonly import: ImportRecord;
  /** Evidence of the import binding and of the established forwarding branch. */
  readonly evidence_ids: readonly string[];
}

/** Instructions a stub may contain besides its final indirect branch: they only
 * materialize the slot address and read it, or are no-ops/CET markers. */
function inertInstruction(instruction: DecodedInstruction): boolean {
  const payload = instruction.payload;
  if (!payload || instruction.validity !== 'valid') return false;
  if (payload.architecture === 'arm64')
    return /^(?:ADRP_|ADR_|NOP_|LDR_64_ldst_pos$|LDR_64_loadlit)/.test(payload.encoding);
  return payload.mnemonic === 'endbr64' || payload.mnemonic === 'nop';
}
function forwardingBranch(instruction: DecodedInstruction): boolean {
  const payload = instruction.payload;
  if (!payload || instruction.validity !== 'valid' || instruction.flow.kind !== 'indirect_branch')
    return false;
  return payload.architecture === 'arm64'
    ? payload.encoding === 'BR_64_branch_reg'
    : payload.mnemonic === 'jmp';
}

/** Recognize import stubs: Mach-O `__stubs` (adrp/ldr/br), ELF PLT entries and
 * PE import thunks (`jmp [IAT]`). The shape is checked on the decoded
 * instructions and the forwarding is proven by established target references
 * through one import slot; a stub with a loader callable entry must be that
 * exact entry. Anything with other effects, references or a weak import
 * stays an ordinary (partial) function. */
export function classifyImportStubs(
  image: LoadedImage,
  graphs: readonly FunctionGraph[],
  references: readonly ReferenceRecord[],
  context: OperationContext,
): ReadonlyMap<string, ImportStub> {
  const imports = new Map(image.imports.map((item) => [item.id, item]));
  const byFunction = new Map<string, ReferenceRecord[]>();
  for (const reference of references) {
    context.checkpoint(1);
    if (reference.from_function === null) continue;
    const list = byFunction.get(reference.from_function);
    if (list) list.push(reference);
    else byFunction.set(reference.from_function, [reference]);
  }
  const stubs = new Map<string, ImportStub>();
  for (const graph of graphs) {
    context.checkpoint(1);
    const body = graph.instructions;
    if (body.length === 0 || body.length > 4) continue;
    const ordered = [...body].sort((a, b) => (a.address.value < b.address.value ? -1 : 1));
    const last = ordered[ordered.length - 1]!;
    if (!forwardingBranch(last) || !ordered.slice(0, -1).every(inertInstruction)) continue;
    if (ordered[0]!.address.value !== graph.function.entry.value) continue;
    const own = byFunction.get(graph.function.id) ?? [];
    const branches = own.filter((item) => item.kind === 'branch');
    const entity = branches[0]?.to_entity;
    if (
      branches.length !== 1 ||
      branches[0]!.status !== 'established' ||
      branches[0]!.to !== null ||
      entity === null ||
      entity === undefined ||
      own.some(
        (item) =>
          item !== branches[0] &&
          !(
            item.kind === 'read' &&
            item.target_role === 'import_slot' &&
            item.to_entity === entity
          ),
      )
    )
      continue;
    const imported = imports.get(entity);
    if (
      !imported?.slot ||
      imported.weak ||
      imported.original_name === null ||
      (imported.callable_entry !== null &&
        imported.callable_entry.value !== graph.function.entry.value)
    )
      continue;
    stubs.set(graph.function.id, {
      import: imported,
      evidence_ids: [...new Set([...imported.evidence_ids, ...branches[0]!.evidence_ids])],
    });
  }
  return stubs;
}

/** Linker-synthesized ELF PLT sections (lazy `.plt`, IBT `.plt.sec`, `.plt.got`). */
const PLT_SECTION = /(^|[.,])(plt|plt\.sec|plt\.got)$/;
const PLT_ENTRY_RULE = 'ELF PLT entry jumps through the import slot';

/** ELF PLT callable entries, bound from the section layout and the import relocations alone,
 * whether or not any call reaches them. A linker emits each PLT section as one contiguous
 * instruction sequence, so decoding it linearly from its start yields its instructions.
 * An entry is a `jmp qword [rip+disp]` whose memory operand is exactly the slot of one
 * non-weak, named import (the GOT cell its JUMP_SLOT/GLOB_DAT relocation binds), together
 * with an `endbr64` directly before it in the same entry; it must start 8-byte aligned.
 * Executed from that address the bytes transfer, with every register and the stack
 * untouched, to whatever the slot holds, which the dynamic linker binds to the import (a
 * lazy slot first reaches the resolver, which then transfers to it the same way). Each
 * entry becomes a separate import record (`slot` null, `callable_entry` the entry), as the
 * Mach-O loader records `__stubs`. PLT0, the lazy push/jump tails, IRELATIVE and weak
 * slots bind nothing. Other formats are returned unchanged. */
export function bindPltEntries(
  image: LoadedImage,
  decoder: Decoder,
  revision: number,
  context: OperationContext,
): { readonly imports: readonly ImportRecord[]; readonly evidence: readonly Evidence[] } {
  context.checkpoint(0);
  if (image.target.format !== 'elf' || image.target.architecture !== 'x86_64')
    return { imports: image.imports, evidence: [] };
  const slots = new Map<bigint, ImportRecord[]>();
  for (const item of image.imports) {
    context.checkpoint(1);
    if (!item.slot || item.callable_entry) continue;
    const slot = image.address_map.translate(item.slot, 'va');
    if (slot.kind !== 'mapped') continue;
    const list = slots.get(slot.address.value) ?? [];
    list.push(item);
    slots.set(slot.address.value, list);
  }
  const bound: ImportRecord[] = [],
    evidence: Evidence[] = [];
  for (const section of image.sections) {
    context.checkpoint(1);
    if (
      section.kind !== 'section' ||
      !PLT_SECTION.test(section.name) ||
      !section.permissions.includes('execute') ||
      section.virtual_range.size === 0n
    )
      continue;
    // Linear decode in windows well under the operation's instruction limit (each decode is
    // bounded by it); the next window starts after the last whole instruction.
    const instructions: DecodedInstruction[] = [];
    const start = section.virtual_range.start,
      end = start.value + section.virtual_range.size;
    for (let cursor = start.value; cursor < end;) {
      const size = end - cursor < 1024n ? end - cursor : 1024n;
      const window = decoder.decode(
        {
          image,
          regions: [{ start: { ...start, value: cursor }, size }],
          mode: 'long64',
          features: image.target.features,
        },
        context,
      ).instructions;
      const last = window.at(-1);
      if (!last || last.address.value + BigInt(last.size) <= cursor) break;
      instructions.push(...window);
      cursor = last.address.value + BigInt(last.size);
    }
    let previous: DecodedInstruction | undefined;
    for (const instruction of instructions) {
      context.checkpoint(1);
      const before = previous;
      previous = instruction;
      const slot = forwardingSlot(instruction);
      if (slot === null) continue;
      const owners = slots.get(slot);
      // One named, non-weak import per slot: aliases of a cell bind nothing.
      if (owners?.length !== 1) continue;
      const imported = owners[0]!;
      if (imported.weak || imported.original_name === null) continue;
      const marker =
        before?.payload?.architecture === 'x86_64' &&
        before.validity === 'valid' &&
        before.payload.mnemonic === 'endbr64' &&
        before.address.value + BigInt(before.size) === instruction.address.value
          ? before
          : undefined;
      const entry = marker ?? instruction;
      if (entry.address.value % 8n !== 0n) continue;
      const derived_from = [...new Set([...imported.evidence_ids, ...section.evidence_ids])].sort();
      const id = `evidence_${fingerprint([image.selected_slice_id, 'plt/1', PLT_ENTRY_RULE, entry.address.value, derived_from])}`;
      evidence.push({
        id,
        origin: {
          kind: 'analysis',
          analyzer: 'open-decomp/plt',
          version: '1',
          rule: PLT_ENTRY_RULE,
        },
        claim: `${PLT_ENTRY_RULE} 0x${slot.toString(16)} at 0x${entry.address.value.toString(16)}`,
        derived_from,
        conflicts_with: [],
        revision,
      });
      bound.push({
        id: entityIdentity(image.selected_slice_id, 'import', ['plt-entry', entry.address.value]),
        original_name: imported.original_name,
        display_name: imported.display_name,
        library: imported.library,
        ordinal: null,
        slot: null,
        callable_entry: entry.address,
        delayed: false,
        weak: false,
        evidence_ids: [...imported.evidence_ids, id],
      });
    }
  }
  return { imports: [...image.imports, ...bound], evidence };
}

/** The slot of `jmp qword [rip+disp]` (optionally BND-prefixed), else null. */
function forwardingSlot(instruction: DecodedInstruction): bigint | null {
  const payload = instruction.payload;
  if (
    instruction.validity !== 'valid' ||
    instruction.flow.kind !== 'indirect_branch' ||
    instruction.flow.conditional ||
    payload?.architecture !== 'x86_64' ||
    payload.mnemonic !== 'jmp'
  )
    return null;
  return ripSlot(payload);
}

/** The slot an x86 `call qword [rip+disp]` reads its target from, else null. */
export function memorySlot(instruction: DecodedInstruction): bigint | null {
  const payload = instruction.payload;
  if (
    instruction.validity !== 'valid' ||
    instruction.flow.kind !== 'call' ||
    !instruction.flow.indirect ||
    payload?.architecture !== 'x86_64' ||
    payload.mnemonic !== 'call'
  )
    return null;
  return ripSlot(payload);
}

/** The 64-bit flat cell of a single `[rip+disp]` operand, else null. */
function ripSlot(payload: X86Payload): bigint | null {
  if (payload.operands.length !== 1) return null;
  const operand = payload.operands[0]!;
  if (operand.kind !== 'memory') return null;
  const memory = operand.memory;
  if (
    // FS/GS address thread bases; the implicit DS of a RIP-relative operand is flat.
    (memory.segment !== null && /:(fs|gs)$/i.test(memory.segment.id)) ||
    memory.index !== null ||
    memory.address_bits !== 64 ||
    memory.access_bits !== 64 ||
    !memory.rip_relative_target
  )
    return null;
  return memory.rip_relative_target.value;
}

/** The slot an x86 import thunk at `entry` jumps through: the bytes there decode to
 * `jmp qword [rip+disp]`, or `endbr64` directly followed by it. Null for anything else. */
export function thunkSlot(
  image: LoadedImage,
  decoder: Decoder,
  entry: Address,
  context: OperationContext,
): bigint | null {
  if (image.target.architecture !== 'x86_64') return null;
  const decoded = decoder.decode(
    {
      image,
      regions: [{ start: entry, size: 4n + 15n }],
      mode: 'long64',
      features: image.target.features,
    },
    context,
  );
  const at = (value: bigint): DecodedInstruction | undefined =>
    decoded.instructions.find((instruction) => instruction.address.value === value);
  let first = at(entry.value);
  if (
    first?.validity === 'valid' &&
    first.payload?.architecture === 'x86_64' &&
    first.payload.mnemonic === 'endbr64'
  )
    first = at(entry.value + BigInt(first.size));
  return first ? forwardingSlot(first) : null;
}
