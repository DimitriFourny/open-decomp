import {
  OperationError,
  annotationSchema,
  decodeAnnotationEdit,
  encodeAnnotation,
  encodeAnnotationEdit,
  encodeTypeDefinition,
  entityIdSchema,
  fingerprint,
  nextRevision,
  revisionSchema,
  type Annotation,
  type AnnotationBatch,
  type AnnotationEdit,
  type Diagnostic,
  type Evidence,
  type MutationResult,
  type OperationContext,
  type ProjectStore,
  type RecoveredType,
  type StoreTransaction,
} from '../../core/index.js';
import type { SuppliedTypeRecord } from '../../analysis/types/index.js';
import {
  TrustedSemanticCatalog,
  resolveDurableSubject,
  typeReferences,
  type AnnotationSubject,
} from './subjects.js';
export {
  TrustedSemanticCatalog,
  createTrustedSemanticCatalog,
  resolveDurableSubject,
  type AnnotationSubject,
} from './subjects.js';

export interface ActiveAnnotationView {
  readonly project_id: string;
  readonly revision: number;
  /** Only live assertions/hypotheses; historical/retracted versions remain in the store history APIs. */
  readonly annotations: readonly Annotation[];
  /** Selected declarations and reachable type dependencies; alternatives in that scope remain separate. */
  readonly types: readonly SuppliedTypeRecord[];
}

/** Trusted synchronous composition hook; throwing rolls back annotations, evidence and the caller's durable job save. */
export type AnnotationCommitHook = (
  transaction: StoreTransaction,
  result: Extract<MutationResult, { state: 'committed' }>,
  evidence: readonly Evidence[],
) => void;

function reject(code: Diagnostic['code'], message: string): never {
  throw new OperationError({ code, severity: 'error', message, evidence_ids: [] });
}

function liveAnnotations(
  store: ProjectStore,
  revision: number,
  context: OperationContext,
): Annotation[] {
  const result: Annotation[] = [];
  let cursor: string | undefined;
  do {
    context.checkpoint(1);
    const page = store.queryAnnotations({
      revision,
      limit: 1000,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const annotation of page.items) {
      context.checkpoint(1);
      if (annotation.status !== 'retracted') result.push(annotation);
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return result;
}

/** Transactional domain operations over one owning store. No asserted type/signature is promoted to a fact table. */
export class AnnotationService {
  constructor(readonly store: ProjectStore) {}

  apply(
    batch: AnnotationBatch,
    context: OperationContext,
    catalog?: TrustedSemanticCatalog,
    onCommit?: AnnotationCommitHook,
  ): MutationResult {
    try {
      context.checkpoint(1);
      revisionSchema.parse(batch.expected_revision);
      const current = this.store.snapshot().revision;
      if (current !== batch.expected_revision)
        return {
          state: 'conflict',
          expected_revision: batch.expected_revision,
          current_revision: current,
        };
      catalog?.assertSnapshot(this.store, current);
      annotationSchema
        .pick({ author: true, origin: true })
        .parse({ author: batch.author, origin: batch.origin });
      if (batch.edits.length < 1 || batch.edits.length > 1000)
        reject('invalid_input', 'Annotation batches require between 1 and 1000 edits');
      const ids = new Set<string>(),
        edits: AnnotationEdit[] = [];
      let outputBytes = 0;
      for (const edit of batch.edits) {
        context.checkpoint(1);
        if (edit.operation === 'set') {
          context.checkpoint(
            edit.evidence_ids.length +
              (edit.value.kind === 'signature'
                ? edit.value.value.parameters.length + edit.value.value.evidence_ids.length
                : edit.value.kind === 'type' && edit.value.definition.kind === 'structure'
                  ? edit.value.definition.fields.length
                  : 0),
          );
        }
        const wire = encodeAnnotationEdit(edit);
        outputBytes += Buffer.byteLength(JSON.stringify(wire));
        if (outputBytes > context.budget.output_bytes)
          reject('resource_limit', 'Prepared annotation batch exceeds output byte budget');
        if (ids.has(edit.id))
          reject('invalid_input', 'An annotation identity may occur only once in a batch');
        ids.add(edit.id);
        edits.push(decodeAnnotationEdit(wire));
      }
      const revision = nextRevision(current),
        active = liveAnnotations(this.store, current, context);
      const previous = new Map(active.map((annotation) => [annotation.id, annotation]));
      // Retractions remain addressable, but removed assertions cannot be retracted or removed twice.
      const existing = this.store.queryAnnotations({
        revision: current,
        ids: [...ids],
        limit: 1000,
      }).items;
      for (const annotation of existing) previous.set(annotation.id, annotation);
      const prospective = new Map(active.map((annotation) => [annotation.id, annotation]));
      const prepared: Annotation[] = [],
        removed: string[] = [],
        evidence: Evidence[] = [];
      for (const edit of edits) {
        context.checkpoint(1);
        if (edit.operation !== 'set') {
          const prior = previous.get(edit.id);
          if (!prior) reject('not_found', 'Cannot retract or remove an absent annotation');
          prospective.delete(edit.id);
          if (edit.operation === 'remove') removed.push(edit.id);
          else
            prepared.push({
              ...prior,
              status: 'retracted',
              author: batch.author,
              origin: batch.origin,
              revision,
            });
          continue;
        }
        const history = this.store.queryAnnotationHistory({
          id: edit.id,
          revision: current,
          limit: 1,
        }).items[0];
        if (history && history.entity_id !== edit.entity_id)
          reject(
            'conflicting_evidence',
            'Annotation identity cannot move to another subject, including after removal or lineage changes',
          );
        let evidenceIds = edit.evidence_ids;
        if (evidenceIds.length === 0) {
          const proof: Evidence = {
            id: `evidence_${fingerprint([this.store.project_id, revision, edit.id, batch.author, batch.origin, edit.status])}`,
            origin: {
              kind: 'assertion',
              author: batch.author,
              agent: batch.origin,
              status: edit.status,
            },
            claim: `Annotation ${edit.id} on ${edit.entity_id}`,
            derived_from:
              edit.value.kind === 'signature' ? [...new Set(edit.value.value.evidence_ids)] : [],
            conflicts_with: [],
            revision,
          };
          evidence.push(proof);
          evidenceIds = [proof.id];
        }
        const annotation: Annotation = {
          id: edit.id,
          entity_id: edit.entity_id,
          value: edit.value,
          status: edit.status,
          evidence_ids: evidenceIds,
          author: batch.author,
          origin: batch.origin,
          revision,
        };
        prepared.push(annotation);
        prospective.set(edit.id, annotation);
      }
      const declarations = new Map<string, RecoveredType[]>();
      for (const annotation of prospective.values())
        if (annotation.value.kind === 'type') {
          context.checkpoint(1);
          const definitions = declarations.get(annotation.value.type_id) ?? [];
          definitions.push(annotation.value.definition);
          declarations.set(annotation.value.type_id, definitions);
        }
      const generated = new Set(evidence.map((proof) => proof.id));
      const checkedEvidence = new Set<string>(),
        checkedTypes = new Set<string>(),
        subjectCache = new Map<string, AnnotationSubject | null>();
      const validateEvidence = (references: readonly string[]): void => {
        const pending = [...references];
        while (pending.length) {
          context.checkpoint(1);
          const id = pending.pop()!;
          if (checkedEvidence.has(id) || generated.has(id)) continue;
          checkedEvidence.add(id);
          const durable = this.store.readEvidence([id], current)[0];
          const proof = durable ?? catalog?.evidence(id);
          if (!proof || proof.revision > current)
            reject(
              'not_found',
              'Evidence reference does not exist in the requested project snapshot',
            );
          if (!durable) evidence.push(proof);
          if (proof.origin.kind === 'binary') {
            // Image ownership is checked explicitly; evidence IDs alone never prove it.
            const imageId = proof.origin.range.start.image_id;
            if (!this.store.snapshot(current).images.some((image) => image.image_id === imageId))
              reject('invalid_input', 'Evidence range belongs to another project image');
          }
          context.checkpoint(proof.derived_from.length + proof.conflicts_with.length);
          pending.push(...proof.derived_from, ...proof.conflicts_with);
        }
      };
      const validateTypes = (references: readonly string[]): void => {
        const pending = [...references];
        while (pending.length) {
          context.checkpoint(1);
          const id = pending.pop()!;
          if (checkedTypes.has(id)) continue;
          checkedTypes.add(id);
          const definitions = declarations.get(id);
          const fact = this.store.readType(id, current),
            semantic = catalog?.types(id) ?? [];
          if (!definitions?.length && !fact && semantic.length === 0)
            reject(
              'not_found',
              'Source type reference is not a declaration in the requested project snapshot',
            );
          if (fact) {
            validateEvidence(fact.evidence_ids);
            pending.push(...typeReferences(fact.definition));
          }
          for (const record of semantic) {
            validateEvidence(record.evidence_ids);
            pending.push(...typeReferences(record.definition));
          }
          for (const definition of definitions ?? []) {
            context.checkpoint(definition.kind === 'structure' ? definition.fields.length : 1);
            if (
              definition.kind === 'structure' &&
              new Set(definition.fields.map((field) => field.id)).size !== definition.fields.length
            )
              reject('invalid_input', 'Structure field identities must be unique');
            pending.push(...typeReferences(definition));
          }
          // Visited IDs permit pointer recursion; this does not establish finite by-value layout.
        }
      };
      for (const annotation of prepared) {
        context.checkpoint(1);
        if (annotation.status === 'retracted') continue;
        let subject = subjectCache.get(annotation.entity_id);
        if (subject === undefined) {
          subject =
            catalog?.subject(annotation.entity_id) ??
            resolveDurableSubject(this.store, annotation.entity_id, current, context);
          subjectCache.set(annotation.entity_id, subject);
        }
        if (!subject)
          reject(
            'not_found',
            'Annotation subject is absent from durable facts and the trusted semantic catalog',
          );
        validateEvidence(annotation.evidence_ids);
        if (annotation.value.kind === 'type') validateTypes([annotation.value.type_id]);
        if (annotation.value.kind === 'signature') {
          if (!['function', 'call', 'import', 'export'].includes(subject.kind))
            reject('invalid_input', 'Signatures require an exact callable subject');
          const signature = annotation.value.value;
          if (signature.abi !== subject.abi)
            reject('invalid_input', 'Signature ABI does not match its subject image');
          validateEvidence(signature.evidence_ids);
          validateTypes([
            signature.return_type,
            ...signature.parameters.map((parameter) => parameter.type_id),
          ]);
          if (
            new Set(signature.parameters.map((parameter) => parameter.id)).size !==
            signature.parameters.length
          )
            reject('invalid_input', 'Signature parameter identities must be unique');
        }
      }
      context.checkpoint(0);
      // Every write and final checkpoint is inside the synchronous rollback boundary.
      return this.store.transaction(current, (tx) => {
        context.checkpoint(0);
        for (const proof of evidence) {
          context.checkpoint(1);
          tx.putEvidence(proof);
        }
        for (const annotation of prepared) {
          context.checkpoint(1);
          tx.setAnnotation(annotation);
        }
        for (const id of removed) {
          context.checkpoint(1);
          tx.removeAnnotation(id, { author: batch.author, origin: batch.origin });
        }
        if (onCommit) {
          if (onCommit.constructor.name === 'AsyncFunction')
            reject('invalid_input', 'Annotation commit hooks must be synchronous');
          const returned: unknown = onCommit(
            tx,
            {
              state: 'committed',
              previous_revision: current,
              revision,
              annotations: prepared,
              removed,
              invalidate_before_revision: revision,
            },
            evidence,
          );
          if (returned !== null && typeof returned === 'object' && 'then' in returned)
            reject('invalid_input', 'Annotation commit hooks must be synchronous');
        }
        context.checkpoint(0);
      });
    } catch (error) {
      return {
        state: 'rejected',
        diagnostics: [
          error instanceof OperationError
            ? error.diagnostic
            : {
                code: 'invalid_input',
                severity: 'error',
                message: (error instanceof Error ? error.message : String(error)).slice(0, 8192),
                evidence_ids: [],
              },
        ],
      };
    }
  }

  /** Recompute at the requested revision. Pass annotations/types together to recoverTypes; names/notes never become types. */
  active(
    revision: number,
    context: OperationContext,
    options: {
      readonly catalog?: TrustedSemanticCatalog;
      readonly entity_ids?: readonly string[];
      /** Reports effective query keys, including empty subjects and absent shared declarations. */
      readonly on_dependencies?: (subjects: readonly string[] | null, type_ids: readonly string[]) => void;
    } = {},
  ): ActiveAnnotationView {
    const snapshot = this.store.snapshot(revision);
    options.catalog?.assertSnapshot(this.store, revision);
    const selected = options.entity_ids === undefined ? null : new Set(options.entity_ids);
    for (const id of selected ?? []) entityIdSchema.parse(id);
    const live = liveAnnotations(this.store, revision, context),
      annotations: Annotation[] = [],
      types: SuppliedTypeRecord[] = [],
      pending: string[] = [];
    const declarations = new Map<
      string,
      { readonly subject: string; readonly record: SuppliedTypeRecord }[]
    >();
    let bytes = 0;
    const bound = (value: unknown): void => {
      bytes += Buffer.byteLength(JSON.stringify(value));
      if (bytes > context.budget.output_bytes)
        reject('resource_limit', 'Active annotation view exceeds output byte budget');
    };
    for (const annotation of live) {
      context.checkpoint(1);
      const included = selected === null || selected.has(annotation.entity_id);
      if (included) {
        bound(encodeAnnotation(annotation));
        annotations.push(annotation);
      }
      if (annotation.value.kind === 'type') {
        const record: SuppliedTypeRecord = {
          id: annotation.value.type_id,
          definition: annotation.value.definition,
          source: annotation.origin,
          status: annotation.status === 'asserted' ? 'asserted' : 'hypothesis',
          evidence_ids: annotation.evidence_ids,
        };
        const group = declarations.get(record.id) ?? [];
        group.push({ subject: annotation.entity_id, record });
        declarations.set(record.id, group);
        if (included) pending.push(record.id);
      } else if (annotation.value.kind === 'signature' && included) {
        pending.push(
          annotation.value.value.return_type,
          ...annotation.value.value.parameters.map((parameter) => parameter.type_id),
        );
      }
    }
    const seen = new Set<string>();
    while (pending.length) {
      context.checkpoint(1);
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const fact = this.store.readType(id, revision),
        semantic = options.catalog?.types(id) ?? [];
      const declared = declarations.get(id) ?? [];
      const local =
        selected === null ? declared : declared.filter((item) => selected.has(item.subject));
      // Explicit references may use a shared declaration when no local/native
      // definition exists. Unrelated assertions cannot poison an existing type.
      const applicable = local.length || fact || semantic.length ? local : declared;
      const records: readonly SuppliedTypeRecord[] = [
        ...applicable.map((item) => item.record),
        ...(fact
          ? [
              {
                id,
                definition: fact.definition,
                source: 'analysis' as const,
                status: 'established' as const,
                evidence_ids: fact.evidence_ids,
              },
            ]
          : []),
        ...semantic,
      ];
      for (const record of records) {
        context.checkpoint(
          1 + (record.definition.kind === 'structure' ? record.definition.fields.length : 0),
        );
        bound({ ...record, definition: encodeTypeDefinition(record.definition) });
        types.push(record);
        pending.push(...typeReferences(record.definition));
      }
    }
    options.on_dependencies?.(selected === null ? null : [...selected], [...seen]);
    context.checkpoint(0);
    return { project_id: snapshot.project_id, revision, annotations, types };
  }
}
