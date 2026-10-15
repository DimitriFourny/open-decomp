import { OperationError, type Evidence, type LoadedImage, type OperationContext, type ProjectStore } from '../../core/index.js';
import type { SSAForm } from '../../ir/index.js';
import { instructionResults } from '../../analysis/effects/index.js';
import type { TypeRecoveryResult } from '../../analysis/types/index.js';
import type { AnalysisCatalogData } from '../../project/cache/model.js';
import type { AnnotationSubject } from '../../project/annotations/index.js';

/** Collect references, never interpret arbitrary strings as evidence identities. */
export function evidenceReferences(value: unknown, context: OperationContext): Set<string> {
  const ids = new Set<string>(), pending: unknown[] = [value];
  while (pending.length) {
    context.checkpoint(1);
    const item = pending.pop();
    if (Array.isArray(item)) pending.push(...item);
    else if (item !== null && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      if ((key === 'evidence_ids' || key === 'contract_evidence') && Array.isArray(child)) {
        for (const id of child) if (typeof id === 'string') ids.add(id);
      } else pending.push(child);
    }
    if (ids.size > 10000) throw new OperationError({ code: 'resource_limit', severity: 'error', message: 'Analysis evidence exceeds the catalog bound', evidence_ids: [] });
  }
  return ids;
}

/** Every advertised proof has its complete dependency/conflict closure. Missing
 * analyzer provenance is an integration failure, never silently omitted evidence. */
export function closeEvidence(store: ProjectStore, revision: number, seeds: Iterable<string>, available: readonly Evidence[], context: OperationContext, durableRevision = revision): Evidence[] {
  const source = new Map(available.map(proof => [proof.id, proof])), result = new Map<string, Evidence>();
  const pending = [...new Set(seeds)];
  for (let offset = 0; offset < pending.length; offset++) {
    context.checkpoint(1);
    const id = pending[offset]!;
    if (result.has(id)) continue;
    const proof = source.get(id) ?? store.readEvidence([id], durableRevision)[0];
    if (!proof || proof.revision > revision) throw new OperationError({ code: 'internal_error', severity: 'error', message: `Analysis proof dependency is unavailable: ${id}`, evidence_ids: [] });
    result.set(id, proof);
    context.checkpoint(proof.derived_from.length + proof.conflicts_with.length);
    for (const parent of [...proof.derived_from, ...proof.conflicts_with]) if (!result.has(parent)) pending.push(parent);
    if (result.size > 10000 || pending.length > 100000) throw new OperationError({ code: 'resource_limit', severity: 'error', message: 'Analysis proof closure exceeds the catalog bound', evidence_ids: [] });
  }
  return [...result.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function semanticCatalog(image: LoadedImage, ir: SSAForm, types: TypeRecoveryResult, context: OperationContext): AnalysisCatalogData {
  const kinds = new Map<string, AnnotationSubject['kind']>([[ir.id, 'function']]);
  for (const block of ir.blocks) {
    context.checkpoint(1 + block.parameters.length + block.instructions.length);
    for (const value of block.parameters) kinds.set(value.id, 'value');
    for (const node of block.instructions) {
      if (node.kind === 'call') kinds.set(node.id, 'call');
      for (const value of instructionResults(node)) kinds.set(value.id, 'value');
    }
  }
  for (const shape of types.shapes) for (const field of shape.fields) { context.checkpoint(1); kinds.set(field.id, 'field'); }
  // Recovery enumerates storage identities not otherwise represented by SSA nodes.
  for (const id of types.subjects) if (!kinds.has(id)) kinds.set(id, 'stack');
  for (const type of types.types) {
    context.checkpoint(1);
    kinds.set(type.id, 'type');
    if (type.definition.kind === 'structure') for (const field of type.definition.fields) { context.checkpoint(1); kinds.set(field.id, 'field'); }
  }
  return { subjects: [...kinds].map(([id, kind]) => ({ id, kind, image_id: image.id, slice_id: image.selected_slice_id, abi: image.target.abi })), types: types.types, evidence: types.evidence };
}
