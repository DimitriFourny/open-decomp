import type {
  DecodedInstruction,
  FunctionGraph,
  ImportRecord,
  LoadedImage,
  OperationContext,
  ReferenceRecord,
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
