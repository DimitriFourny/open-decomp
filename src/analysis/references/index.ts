import {
  entityIdentity,
  fingerprint,
  type Address,
  type Diagnostic,
  type Evidence,
  type LoadedImage,
  type OperationContext,
  type ReferenceRecord,
} from '../../core/index.js';
import type { DiscoveryResult } from '../discovery/index.js';
import type { StringIndex } from '../strings/index.js';
import { recoverTargets, virtualAddress, type TargetRecoveryResult } from '../targets/index.js';
import { searchIndex, type IndexPage, type IndexSearch } from './search.js';
export type { IndexPage, IndexSearch } from './search.js';

export interface ReferenceIndex {
  readonly image_id: string;
  readonly slice_id: string;
  readonly revision: number;
  readonly identity: string;
  readonly references: readonly ReferenceRecord[];
  readonly evidence: readonly Evidence[];
  readonly state: 'complete' | 'partial';
  readonly diagnostics: readonly Diagnostic[];
  /** Same string identities/bytes, promoted only by established address/read uses. */
  readonly strings: StringIndex | null;
}
export interface ReferenceIndexInput {
  readonly image: LoadedImage;
  readonly discovery: DiscoveryResult;
  readonly revision: number;
  readonly strings?: StringIndex;
  /** Reuse the exact recovery artifact instead of repeating address analysis. */
  readonly targets?: TargetRecoveryResult;
  readonly max_references?: number;
  readonly max_instructions?: number;
  readonly max_table_entries?: number;
}

/** Navigation combines actual discovery edges, scoped operand recovery and loader
 * relocation facts. It never decodes executable bytes a second time or invents
 * functions from constants. Import callable entries and pointer storage remain
 * distinct targets. Unresolved edges are removed only when the same instruction
 * and owner has an established control target (candidates cannot discharge them).
 * Completion covers the supplied discovery, not an assertion of whole-image code
 * discovery. Cancellation/work/deadline exhaustion throws without publication;
 * explicit record/instruction/table limits return partial artifacts.
 */
export function buildReferenceIndex(
  input: ReferenceIndexInput,
  context: OperationContext,
): ReferenceIndex {
  context.checkpoint(0);
  const { image, discovery, revision } = input;
  const max = input.max_references ?? 100_000;
  if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(max) || max < 0)
    throw new RangeError('Invalid reference index bounds');
  if (
    input.strings &&
    (input.strings.image_id !== image.id ||
      input.strings.slice_id !== image.selected_slice_id ||
      input.strings.revision !== revision)
  )
    throw new RangeError('String index belongs to another snapshot');
  const targets =
    input.targets ??
    recoverTargets(
      {
        image,
        discovery,
        revision,
        ...(input.max_references !== undefined ? { max_references: max } : {}),
        ...(input.max_instructions !== undefined
          ? { max_instructions: input.max_instructions }
          : {}),
        ...(input.max_table_entries !== undefined
          ? { max_table_entries: input.max_table_entries }
          : {}),
      },
      context,
    );
  if (
    targets.image_id !== image.id ||
    targets.slice_id !== image.selected_slice_id ||
    targets.revision !== revision
  )
    throw new RangeError('Target recovery belongs to another snapshot');
  const diagnostics: Diagnostic[] = [...discovery.diagnostics, ...targets.diagnostics];
  const evidence = new Map(
    [
      ...image.evidence,
      ...discovery.evidence,
      ...targets.evidence,
      ...(input.strings?.evidence ?? []),
    ].map((item) => [item.id, item]),
  );
  const imports = new Map<bigint, LoadedImage['imports'][number]>();
  const slots = new Map<bigint, LoadedImage['imports'][number]>();
  for (const item of image.imports) {
    context.checkpoint(1);
    if (item.callable_entry) imports.set(virtualAddress(image, item.callable_entry).value, item);
    if (item.slot) slots.set(virtualAddress(image, item.slot).value, item);
  }
  const instructions = new Map(
    discovery.graphs.flatMap((graph) =>
      graph.instructions.map((instruction) => [instruction.id, instruction] as const),
    ),
  );
  const established = new Set(
    targets.references
      .filter(
        (item) =>
          item.status === 'established' &&
          (item.kind === 'call' || item.kind === 'branch' || item.kind === 'tail_call'),
      )
      .map((item) => `${item.from_function}:${item.from_instruction}`),
  );
  const records = new Map<string, ReferenceRecord>();
  let capped = false;
  const insert = (item: ReferenceRecord): void => {
    const key = fingerprint([
      item.from_function,
      item.from_instruction,
      item.from,
      item.kind,
      item.to,
      item.to_entity,
      item.status,
      item.target_role,
    ]);
    if (records.has(key)) return;
    if (records.size >= max) {
      capped = true;
      return;
    }
    records.set(key, item);
  };
  for (const item of discovery.references) {
    context.checkpoint(1);
    const instruction = item.from_instruction ? instructions.get(item.from_instruction) : undefined;
    if (
      item.status === 'unresolved' &&
      established.has(`${item.from_function}:${item.from_instruction}`)
    )
      continue;
    const control = item.kind === 'call' || item.kind === 'branch' || item.kind === 'tail_call';
    const imported = item.to && control ? imports.get(item.to.value) : undefined;
    const kind =
      item.status === 'unresolved' && instruction?.flow.kind === 'call'
        ? 'call'
        : item.status === 'unresolved' && instruction?.flow.kind === 'indirect_branch'
          ? 'branch'
          : item.kind;
    insert({
      ...item,
      kind,
      to_entity: imported?.id ?? item.to_entity,
      target_role: imported ? 'callable_stub' : control && item.to ? 'code' : item.target_role,
      evidence_ids: [...new Set([...item.evidence_ids, ...(imported?.evidence_ids ?? [])])].sort(),
    });
  }
  for (const item of targets.references) {
    context.checkpoint(1);
    insert(item);
  }
  // Explicit loader pointer relationships are data xrefs, not code reads/calls.
  for (const relocation of image.relocations) {
    context.checkpoint(1);
    const from = virtualAddress(image, relocation.address);
    const target = relocation.target ? virtualAddress(image, relocation.target) : null;
    const imported = slots.get(from.value);
    const id = entityIdentity(image.selected_slice_id, 'reference', [
      'relocation/1',
      relocation.id,
    ]);
    const ev = `evidence_${fingerprint([id, 'loader-pointer-relationship'])}`;
    evidence.set(ev, {
      id: ev,
      origin: {
        kind: 'analysis',
        analyzer: 'open-decomp/references',
        version: '1',
        rule: 'Loader-described pointer relationship; not an executed access',
      },
      claim: 'Pointer storage target',
      derived_from: relocation.evidence_ids,
      conflicts_with: [],
      revision,
    });
    insert({
      id,
      from,
      from_function: null,
      from_instruction: null,
      to: target,
      to_entity: imported?.id ?? relocation.symbol_id,
      kind: 'address',
      status: target || imported ? 'established' : 'unresolved',
      target_role: target ? 'data' : 'unknown',
      evidence_ids: [ev],
    });
  }
  let references = [...records.values()].sort((a, b) =>
    a.from.value < b.from.value ? -1 : a.from.value > b.from.value ? 1 : a.id.localeCompare(b.id),
  );
  let strings: StringIndex | null = null;
  if (input.strings) {
    const original = input.strings;
    const promoted = new Map<string, Set<string>>();
    // Sorted interval lookup supports pointers into a string, not only its start.
    const text = original.strings;
    references = references.map((reference) => {
      context.checkpoint(1);
      if (
        !reference.to ||
        reference.to_entity !== null ||
        (reference.kind !== 'read' && reference.kind !== 'address')
      )
        return reference;
      let low = 0,
        high = text.length;
      while (low < high) {
        context.checkpoint(1);
        const mid = (low + high) >>> 1;
        if (text[mid]!.address.value <= reference.to.value) low = mid + 1;
        else high = mid;
      }
      const found = text[low - 1];
      if (!found || reference.to.value >= found.address.value + found.byte_length) return reference;
      if (reference.status === 'established' && reference.from_instruction !== null) {
        const parents = promoted.get(found.id) ?? new Set<string>();
        for (const id of reference.evidence_ids) parents.add(id);
        promoted.set(found.id, parents);
      }
      return { ...reference, to_entity: found.id };
    });
    const updated = text.map((item) => {
      const parents = promoted.get(item.id);
      return parents
        ? {
            ...item,
            status: 'referenced' as const,
            evidence_ids: [...new Set([...item.evidence_ids, ...parents])].sort(),
          }
        : item;
    });
    strings = {
      ...original,
      strings: updated,
      identity: fingerprint([
        original.identity,
        updated.map((item) => [item.id, item.status, item.evidence_ids]),
      ]),
      evidence: [...evidence.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
  }
  if (capped)
    diagnostics.push({
      code: 'resource_limit',
      severity: 'warning',
      message: 'Reference index record budget exhausted',
      evidence_ids: [],
    });
  const state =
    capped || targets.state !== 'complete' || discovery.coverage.state !== 'complete'
      ? 'partial'
      : 'complete';
  return {
    image_id: image.id,
    slice_id: image.selected_slice_id,
    revision,
    identity: fingerprint([image.selected_slice_id, revision, 'references/1', references, state]),
    references,
    evidence: [...evidence.values()].sort((a, b) => a.id.localeCompare(b.id)),
    state,
    diagnostics,
    strings,
  };
}
export interface ReferenceSearch extends IndexSearch {
  readonly direction?: 'incoming' | 'outgoing';
  readonly address?: Address;
  readonly entity_id?: string;
  readonly function_id?: string;
  readonly instruction_id?: string;
  readonly kinds?: readonly ReferenceRecord['kind'][];
  readonly statuses?: readonly ReferenceRecord['status'][];
  readonly target_roles?: readonly ReferenceRecord['target_role'][];
}
/** Incoming entity queries include imports and interior string references. Outgoing
 * function queries use source ownership, including shared-tail multiple owners. */
export function searchReferences(
  index: ReferenceIndex,
  options: ReferenceSearch,
  context: OperationContext,
): IndexPage<ReferenceRecord> {
  if (
    options.address &&
    (options.address.image_id !== index.image_id || options.address.space !== 'va')
  )
    throw new RangeError('Reference search requires this image virtual address');
  const direction = options.direction ?? 'incoming';
  const query = [
    direction,
    options.address
      ? [options.address.image_id, options.address.space, options.address.value]
      : null,
    options.entity_id ?? null,
    options.function_id ?? null,
    options.instruction_id ?? null,
    options.kinds ?? null,
    options.statuses ?? null,
    options.target_roles ?? null,
  ];
  return searchIndex(
    {
      items: index.references,
      identity: index.identity,
      revision: index.revision,
      state: index.state,
      query,
      matches: (item) =>
        (options.address === undefined ||
          (direction === 'incoming' ? item.to?.value : item.from.value) ===
            options.address.value) &&
        (options.entity_id === undefined ||
          (direction === 'incoming' ? item.to_entity : item.from_function) === options.entity_id) &&
        (options.function_id === undefined || item.from_function === options.function_id) &&
        (options.instruction_id === undefined ||
          item.from_instruction === options.instruction_id) &&
        (options.kinds === undefined || options.kinds.includes(item.kind)) &&
        (options.statuses === undefined || options.statuses.includes(item.status)) &&
        (options.target_roles === undefined || options.target_roles.includes(item.target_role)),
    },
    options,
    context,
  );
}
