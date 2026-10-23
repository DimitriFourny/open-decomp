import {
  OperationError,
  type Evidence,
  type LoadedImage,
  type OperationContext,
  type ProjectStore,
} from '../../core/index.js';
import type { SSAForm } from '../../ir/index.js';
import { instructionResults } from '../../analysis/effects/index.js';
import type { TypeRecoveryResult } from '../../analysis/types/index.js';
import type { AnalysisCatalogData } from '../../project/cache/model.js';
import type { AnnotationSubject } from '../../project/annotations/index.js';

/** Proofs one published analysis catalog closes over (`evidence` of a result). */
const CATALOG_EVIDENCE_BOUND = 10000;
/** Proofs one stored catalog type cites (`evidence_ids` of the cache catalog). */
const TYPE_EVIDENCE_BOUND = 1000;

/** A proof set past the catalog bound. A decompilation publishes its text without
 * the proof references that do not fit (`boundedEvidence`). */
class CatalogBoundError extends OperationError {
  constructor(message: string) {
    super({ code: 'resource_limit', severity: 'error', message, evidence_ids: [] });
  }
}

/** Collect references, never interpret arbitrary strings as evidence identities.
 * More than `limit` distinct references exceed the catalog bound. */
export function evidenceReferences(
  value: unknown,
  context: OperationContext,
  limit = CATALOG_EVIDENCE_BOUND,
): Set<string> {
  const ids = new Set<string>(),
    pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length) {
    const item = pending.pop();
    if (item !== null && typeof item === 'object') {
      if (visited.has(item)) {
        context.checkpoint(0);
        continue;
      }
      visited.add(item);
    }
    context.checkpoint(1);
    if (Array.isArray(item)) pending.push(...item);
    else if (item !== null && typeof item === 'object')
      for (const [key, child] of Object.entries(item)) {
        if ((key === 'evidence_ids' || key === 'contract_evidence') && Array.isArray(child)) {
          for (const id of child) if (typeof id === 'string') ids.add(id);
        } else pending.push(child);
      }
    if (ids.size > limit)
      throw new CatalogBoundError('Analysis evidence exceeds the catalog bound');
  }
  return ids;
}

/** Every emission proof citation indexes its duplicate-free `evidence` table;
 * the table is the closed set of cited proofs, not arbitrary semantic IDs. */
export function emissionEvidenceReferences(
  emission: { readonly evidence: readonly string[] },
  context: OperationContext,
  ids = new Set<string>(),
): Set<string> {
  context.checkpoint(1 + emission.evidence.length);
  for (const id of emission.evidence) ids.add(id);
  if (ids.size > CATALOG_EVIDENCE_BOUND)
    throw new CatalogBoundError('Analysis evidence exceeds the catalog bound');
  return ids;
}

function unavailableProof(id: string): never {
  throw new OperationError({
    code: 'internal_error',
    severity: 'error',
    message: `Analysis proof dependency is unavailable: ${id}`,
    evidence_ids: [],
  });
}

/** Every advertised proof has its complete dependency/conflict closure. Missing
 * analyzer provenance is an integration failure, never silently omitted evidence. */
export function closeEvidence(
  store: Pick<ProjectStore, 'readEvidence'>,
  revision: number,
  seeds: Iterable<string>,
  available: readonly Evidence[],
  context: OperationContext,
  durableRevision = revision,
): Evidence[] {
  const source = new Map(available.map((proof) => [proof.id, proof])),
    result = new Map<string, Evidence>();
  const pending = [...new Set(seeds)];
  for (let offset = 0; offset < pending.length; offset++) {
    context.checkpoint(1);
    const id = pending[offset]!;
    if (result.has(id)) continue;
    const proof = source.get(id) ?? store.readEvidence([id], durableRevision)[0];
    if (!proof || proof.revision > revision) unavailableProof(id);
    result.set(id, proof);
    context.checkpoint(proof.derived_from.length + proof.conflicts_with.length);
    for (const parent of [...proof.derived_from, ...proof.conflicts_with])
      if (!result.has(parent)) pending.push(parent);
    if (result.size > CATALOG_EVIDENCE_BOUND || pending.length > 100000)
      throw new CatalogBoundError('Analysis proof closure exceeds the catalog bound');
  }
  return [...result.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export interface BoundedEvidence {
  /** The closed proof set the result publishes. */
  readonly evidence: Evidence[];
  /** Catalog types citing only published proofs, at most `TYPE_EVIDENCE_BOUND` each. */
  readonly types: AnalysisCatalogData['types'];
  /** False: the emission's proof table did not fit, so its metadata classes are shed. */
  readonly emission: boolean;
  /** Proof references (citations) a published record no longer carries: the shed
   * emission's proof table, dropped type citations, unpublished optional proofs. */
  readonly omitted: number;
}

/** The proofs a decompilation publishes: the closure of everything it cites. When
 * that exceeds a catalog bound (more than `CATALOG_EVIDENCE_BOUND` proofs, or a type
 * citing more than `TYPE_EVIDENCE_BOUND`), the text is still published: the proofs
 * `required` cites (diagnostics, annotations, the signature) close first, then the
 * emission's proof table as a whole, then each type's citations and the `optional`
 * references in order while their closures fit. References past the bound are
 * dropped from the catalog and counted; no published record cites a missing proof.
 * Every choice is a function of the cited records, never of timing. */
export function boundedEvidence(input: {
  readonly store: Pick<ProjectStore, 'readEvidence'>;
  readonly revision: number;
  readonly available: readonly Evidence[];
  readonly context: OperationContext;
  readonly types: AnalysisCatalogData['types'];
  /** Further records whose proofs the catalog keeps resolvable when they fit. */
  readonly optional: readonly unknown[];
  /** Records the published result carries outside the emission and the types. */
  readonly required: readonly unknown[];
  readonly emission: { readonly evidence: readonly string[] };
}): BoundedEvidence {
  const { store, revision, available, context, types } = input;
  if (types.every((record) => record.evidence_ids.length <= TYPE_EVIDENCE_BOUND))
    try {
      const ids = evidenceReferences([types, ...input.optional, ...input.required], context);
      emissionEvidenceReferences(input.emission, context, ids);
      return {
        evidence: closeEvidence(store, revision, ids, available, context),
        types,
        emission: true,
        omitted: 0,
      };
    } catch (error) {
      if (!(error instanceof CatalogBoundError)) throw error;
    }
  const source = new Map(available.map((proof) => [proof.id, proof])),
    admitted = new Map<string, Evidence>();
  let full = false;
  // Closes `seeds` into the admitted proofs, all or nothing; after the first closure
  // that does not fit, nothing more is admitted.
  const admit = (seeds: Iterable<string>): boolean => {
    if (full) return false;
    const added = new Map<string, Evidence>(),
      pending = [...seeds];
    for (let offset = 0; offset < pending.length; offset++) {
      context.checkpoint(1);
      const id = pending[offset]!;
      if (admitted.has(id) || added.has(id)) continue;
      if (admitted.size + added.size >= CATALOG_EVIDENCE_BOUND || pending.length > 100000) {
        full = true;
        return false;
      }
      const proof = source.get(id) ?? store.readEvidence([id], revision)[0];
      if (!proof || proof.revision > revision) unavailableProof(id);
      added.set(id, proof);
      context.checkpoint(proof.derived_from.length + proof.conflicts_with.length);
      pending.push(...proof.derived_from, ...proof.conflicts_with);
    }
    for (const [id, proof] of added) admitted.set(id, proof);
    return true;
  };
  if (!admit(evidenceReferences(input.required, context)))
    throw new CatalogBoundError('Analysis proof closure exceeds the catalog bound');
  const emission = admit(input.emission.evidence);
  let omitted = emission ? 0 : input.emission.evidence.length;
  const bounded = types.map((record) => {
    context.checkpoint(1 + record.evidence_ids.length);
    const evidence_ids = record.evidence_ids
      .slice(0, TYPE_EVIDENCE_BOUND)
      .filter((id) => admitted.has(id) || admit([id]));
    omitted += record.evidence_ids.length - evidence_ids.length;
    return evidence_ids.length === record.evidence_ids.length
      ? record
      : { ...record, evidence_ids };
  });
  for (const id of evidenceReferences(input.optional, context, Infinity))
    if (!admitted.has(id) && !admit([id])) omitted++;
  return {
    evidence: [...admitted.values()].sort((a, b) => a.id.localeCompare(b.id)),
    types: bounded,
    emission,
    omitted,
  };
}

export function semanticCatalog(
  image: LoadedImage,
  ir: SSAForm,
  types: TypeRecoveryResult,
  context: OperationContext,
): AnalysisCatalogData {
  const kinds = new Map<string, AnnotationSubject['kind']>([[ir.id, 'function']]);
  for (const block of ir.blocks) {
    context.checkpoint(1 + block.parameters.length + block.instructions.length);
    for (const value of block.parameters) kinds.set(value.id, 'value');
    for (const node of block.instructions) {
      if (node.kind === 'call') kinds.set(node.id, 'call');
      for (const value of instructionResults(node)) kinds.set(value.id, 'value');
    }
  }
  for (const shape of types.shapes)
    for (const field of shape.fields) {
      context.checkpoint(1);
      kinds.set(field.id, 'field');
    }
  // Recovery enumerates storage identities not otherwise represented by SSA nodes.
  for (const id of types.subjects) if (!kinds.has(id)) kinds.set(id, 'stack');
  for (const type of types.types) {
    context.checkpoint(1);
    kinds.set(type.id, 'type');
    if (type.definition.kind === 'structure')
      for (const field of type.definition.fields) {
        context.checkpoint(1);
        kinds.set(field.id, 'field');
      }
  }
  return {
    subjects: [...kinds].map(([id, kind]) => ({
      id,
      kind,
      image_id: image.id,
      slice_id: image.selected_slice_id,
      abi: image.target.abi,
    })),
    types: types.types,
    evidence: types.evidence,
  };
}
