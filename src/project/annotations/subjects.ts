import {
  OperationError, entityIdSchema, encodeEvidence, encodeTypeDefinition,
  type Evidence, type OperationContext, type ProjectStore, type RecoveredType, type Target,
} from '../../core/index.js';
import type { SuppliedTypeRecord } from '../../analysis/types/index.js';

export interface AnnotationSubject {
  readonly id: string;
  readonly kind: 'function' | 'call' | 'value' | 'stack' | 'field' | 'type' | 'string' | 'reference' | 'symbol' | 'import' | 'export' | 'section' | 'mapping' | 'relocation';
  readonly image_id: string;
  readonly slice_id: string;
  readonly abi: Target['abi'];
}

function missing(message: string): never {
  throw new OperationError({ code: 'invalid_input', severity: 'error', message, evidence_ids: [] });
}

/** Resolve exact durable IDs, never labels, addresses masquerading as IDs, or lineage successors. */
export function resolveDurableSubject(store: ProjectStore, id: string, revision: number, context: OperationContext): AnnotationSubject | null {
  entityIdSchema.parse(id);
  const snapshot = store.snapshot(revision);
  for (const imported of snapshot.images) {
    context.checkpoint(1);
    let image;
    try { image = store.readLoadedImage(imported.image_id, imported.selected_slice_id, revision); }
    catch (error) { if (error instanceof OperationError && error.code === 'not_found') continue; throw error; }
    const subject = (kind: AnnotationSubject['kind']): AnnotationSubject => ({ id, kind, image_id: image.id, slice_id: image.selected_slice_id, abi: image.target.abi });
    for (const kind of ['function', 'string', 'reference', 'symbol', 'import', 'export'] as const) {
      context.checkpoint(1);
      if (store.queryRecords({ kind, image_id: image.id, revision, ids: [id], limit: 1 }).items.length) return subject(kind);
    }
    for (const [kind, records] of [
      ['symbol', image.symbols], ['import', image.imports], ['export', image.exports],
      ['section', image.sections], ['mapping', image.mappings], ['relocation', image.relocations],
    ] as const) for (const record of records) {
      context.checkpoint(1);
      if (record.id === id) return subject(kind);
    }
  }
  return null;
}

/** Opaque in-process trust boundary. Only the analysis host constructs this; it is not a tool argument. */
export class TrustedSemanticCatalog {
  readonly #subjects: ReadonlyMap<string, AnnotationSubject>;
  readonly #types: ReadonlyMap<string, readonly SuppliedTypeRecord[]>;
  readonly #evidence: ReadonlyMap<string, Evidence>;
  private constructor(
    readonly project_id: string, readonly revision: number,
    subjects: ReadonlyMap<string, AnnotationSubject>, types: ReadonlyMap<string, readonly SuppliedTypeRecord[]>, evidence: ReadonlyMap<string, Evidence>,
  ) { this.#subjects = subjects; this.#types = types; this.#evidence = evidence; }

  static create(store: ProjectStore, revision: number, input: {
    readonly subjects: readonly AnnotationSubject[];
    readonly types?: readonly SuppliedTypeRecord[];
    readonly evidence?: readonly Evidence[];
  }, context: OperationContext): TrustedSemanticCatalog {
    const snapshot = store.snapshot(revision), subjects = new Map<string, AnnotationSubject>(), types = new Map<string, SuppliedTypeRecord[]>(), evidence = new Map<string, Evidence>();
    const images = new Map(snapshot.images.map(image => [`${image.image_id}:${image.selected_slice_id}`, image]));
    const abis = new Map<string, Target['abi']>();
    for (const subject of input.subjects) {
      context.checkpoint(1); entityIdSchema.parse(subject.id);
      const imageKey = `${subject.image_id}:${subject.slice_id}`;
      if (!images.has(imageKey)) missing('Semantic subject does not belong to this project snapshot');
      let abi = abis.get(imageKey);
      if (abi === undefined) {
        abi = store.readLoadedImage(subject.image_id, subject.slice_id, revision).target.abi;
        abis.set(imageKey, abi);
      }
      if (subject.abi !== abi) missing('Semantic subject ABI does not match its image');
      const prior = subjects.get(subject.id);
      if (prior && (prior.kind !== subject.kind || prior.image_id !== subject.image_id || prior.slice_id !== subject.slice_id || prior.abi !== subject.abi)) missing('Semantic subject identity is ambiguous');
      subjects.set(subject.id, Object.freeze({ ...subject }));
    }
    for (const record of input.types ?? []) {
      context.checkpoint(1 + record.evidence_ids.length + (record.definition.kind === 'structure' ? record.definition.fields.length : 0));
      entityIdSchema.parse(record.id); encodeTypeDefinition(record.definition);
      const records = types.get(record.id) ?? [];
      records.push(structuredClone(record)); types.set(record.id, records);
    }
    for (const proof of input.evidence ?? []) {
      context.checkpoint(1 + proof.derived_from.length + proof.conflicts_with.length); encodeEvidence(proof);
      if (proof.revision > revision) missing('Semantic evidence belongs to a future revision');
      evidence.set(proof.id, structuredClone(proof));
    }
    context.checkpoint(0);
    return new TrustedSemanticCatalog(snapshot.project_id, revision, subjects, types, evidence);
  }

  assertSnapshot(store: ProjectStore, revision: number): void {
    if (this.project_id !== store.project_id || this.revision !== revision) missing('Semantic catalog belongs to a different project or revision');
  }
  subject(id: string): AnnotationSubject | null { return this.#subjects.get(id) ?? null; }
  types(id: string): readonly SuppliedTypeRecord[] { return structuredClone(this.#types.get(id) ?? []); }
  evidence(id: string): Evidence | null { const value = this.#evidence.get(id); return value ? structuredClone(value) : null; }
}

/** Host-supplied semantic IDs must come from the real SSA/type recovery result, not wire data. */
export const createTrustedSemanticCatalog = TrustedSemanticCatalog.create;

export function typeReferences(definition: RecoveredType): readonly string[] {
  switch (definition.kind) {
    case 'pointer': return [definition.to];
    case 'array': case 'vector': return [definition.element];
    case 'structure': return definition.fields.map(field => field.type_id);
    default: return [];
  }
}
