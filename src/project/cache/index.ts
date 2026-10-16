import { z } from 'zod';
import {
  OperationError, SCHEMA_VERSION, cacheIdentityKey, cacheIdentitySchema, contentHash,
  decodeEvidence, decodeTypeDefinition, encodeArtifact, encodeEvidence, encodeTypeDefinition,
  entityIdSchema, evidenceIdSchema, evidenceSchema, fingerprint, functionDecompileResultSchema,
  imageIdSchema, newIdentity, projectDecompilationArtifactResult, sliceIdSchema, targetSchema, typeDefinitionSchema,
  type Artifact, type CacheIdentity, type Evidence, type Job, type OperationContext,
  type ProjectStore, type ToolResult,
} from '../../core/index.js';
import {
  createTrustedSemanticCatalog,
  type AnnotationSubject, type TrustedSemanticCatalog,
} from '../annotations/index.js';
import { typeReferences } from '../annotations/subjects.js';
import {
  ANALYSIS_ARTIFACT_MEDIA_TYPE, ANALYSIS_ARTIFACT_VERSION, MAX_ANALYSIS_ARTIFACT_BYTES,
  type AnalysisArtifactPayload, type AnalysisCatalogData, type AnalysisComputation, type StoredDecompilation,
} from './model.js';

export * from './model.js';

const subjectSchema = z.strictObject({
  id: entityIdSchema,
  kind: z.enum(['function', 'call', 'value', 'stack', 'field', 'type', 'string', 'reference', 'symbol', 'import', 'export', 'section', 'mapping', 'relocation']),
  image_id: imageIdSchema, slice_id: sliceIdSchema, abi: targetSchema.shape.abi,
});
const catalogSchema = z.strictObject({
  subjects: z.array(subjectSchema).max(100000),
  types: z.array(z.strictObject({ id: entityIdSchema, definition: typeDefinitionSchema,
    source: z.enum(['analysis', 'debug', 'library', 'user', 'llm']),
    status: z.enum(['candidate', 'established', 'asserted', 'hypothesis', 'conflicting']),
    evidence_ids: z.array(evidenceIdSchema).max(1000),
  })).max(100000),
  evidence: z.array(evidenceSchema).max(100000),
});
const payloadSchema = z.strictObject({
  format_version: z.literal(ANALYSIS_ARTIFACT_VERSION), identity: cacheIdentitySchema,
  result: functionDecompileResultSchema, catalog: catalogSchema,
});

function fail(code: 'invalid_input' | 'stale_revision' | 'cancelled' | 'resource_limit', message: string): never {
  throw new OperationError({ code, severity: 'error', message, evidence_ids: [] });
}

function activeJob(store: ProjectStore, id: string, identity: CacheIdentity, context: OperationContext): Job {
  context.checkpoint(0);
  const revision = store.snapshot().revision;
  if (revision !== identity.annotation_revision || revision !== identity.evidence_revision) fail('stale_revision', 'Analysis snapshot is no longer current');
  const job = store.readJob(id);
  if (!job || job.project_id !== store.project_id || job.operation !== 'function_decompile' || job.input_revision !== revision) fail('invalid_input', 'Analysis job does not match the requested snapshot');
  if (job.state === 'cancelled') fail('cancelled', 'Analysis job was cancelled');
  if (job.state !== 'running' && job.state !== 'queued') fail('invalid_input', 'Analysis job is already terminal');
  return job;
}

/** Validate both the durable input scope and every semantic dependency before publication/use. */
function validateComputation(store: ProjectStore, identity: CacheIdentity, computation: AnalysisComputation, context: OperationContext): AnalysisComputation {
  context.checkpoint(1);
  const revision = identity.annotation_revision;
  if (identity.evidence_revision !== revision) fail('invalid_input', 'Analysis revisions disagree');
  const snapshot = store.snapshot(revision);
  const imported = snapshot.images.find(image => image.sha256 === identity.image_sha256 && image.selected_slice_id === identity.slice_id);
  if (!imported) fail('invalid_input', 'Analysis image does not belong to the requested snapshot');
  const image = store.readLoadedImage(imported.image_id, identity.slice_id, revision);
  if (fingerprint(image.target) !== fingerprint(identity.target)) fail('invalid_input', 'Analysis target does not match the imported image');
  const functions = store.queryRecords({ revision, image_id: image.id, kind: 'function', ids: [identity.function_id], limit: 1 });
  if (functions.items.length !== 1) fail('invalid_input', 'Analysis function is absent from the requested snapshot');
  const result = functionDecompileResultSchema.parse(computation.result);
  if ((result.state !== 'complete' && result.state !== 'partial') || result.data.delivery !== 'inline' ||
      (result.state === 'partial' && (result.reason === 'output_limit' || result.continuation !== null)) ||
      result.data.cache !== 'computed' || result.data.function_id !== identity.function_id ||
      result.project_id !== store.project_id || result.revision !== revision || result.artifacts.length !== 0 ||
      fingerprint(result.versions) !== fingerprint(identity.versions) || fingerprint(result.options) !== fingerprint(identity.options) ||
      fingerprint(result.budget) !== fingerprint(identity.budget)) fail('invalid_input', 'Stored analysis metadata does not match its cache identity');
  const wireCatalog = catalogSchema.parse({ subjects: computation.catalog.subjects,
    types: computation.catalog.types.map(record => ({ id: record.id, definition: encodeTypeDefinition(record.definition),
      source: record.source, status: record.status, evidence_ids: record.evidence_ids })),
    evidence: computation.catalog.evidence.map(encodeEvidence) });
  const catalog: AnalysisCatalogData = { subjects: wireCatalog.subjects,
    types: wireCatalog.types.map(record => ({ ...record, definition: decodeTypeDefinition(record.definition) })),
    evidence: wireCatalog.evidence.map(decodeEvidence) };
  for (const subject of catalog.subjects) {
    context.checkpoint(1);
    if (subject.image_id !== image.id || subject.slice_id !== identity.slice_id || subject.abi !== identity.target.abi) fail('invalid_input', 'Analysis catalog subject escapes its image scope');
  }
  const functionSubject = catalog.subjects.find(subject => subject.id === identity.function_id);
  if (!functionSubject || functionSubject.kind !== 'function') fail('invalid_input', 'Analysis catalog lacks its function subject');
  createTrustedSemanticCatalog(store, revision, catalog, context);
  const proofs = new Map<string, Evidence>();
  for (const proof of [...catalog.evidence, ...result.evidence.map(decodeEvidence)]) {
    context.checkpoint(1);
    const prior = proofs.get(proof.id);
    if (prior && fingerprint(encodeEvidence(prior)) !== fingerprint(encodeEvidence(proof))) fail('invalid_input', 'Analysis evidence identity is ambiguous');
    if (proof.revision > revision || (proof.origin.kind === 'binary' && proof.origin.range.start.image_id !== image.id)) fail('invalid_input', 'Analysis evidence escapes its snapshot');
    proofs.set(proof.id, proof);
  }
  const typeIds = new Set(catalog.types.map(record => record.id));
  const neededProofs = new Set<string>();
  const neededTypes = new Set<string>();
  for (const record of catalog.types) {
    context.checkpoint(1 + record.evidence_ids.length);
    for (const id of record.evidence_ids) neededProofs.add(id);
    for (const id of typeReferences(record.definition)) neededTypes.add(id);
  }
  if (result.data.signature) {
    if (result.data.signature.abi !== identity.target.abi) fail('invalid_input', 'Analysis signature ABI does not match its target');
    for (const id of [result.data.signature.return_type, ...result.data.signature.parameters.map(parameter => parameter.type_id)]) {
      neededTypes.add(id);
    }
    for (const id of result.data.signature.evidence_ids) neededProofs.add(id);
  }
  for (const id of neededTypes) {
    context.checkpoint(1);
    if (neededTypes.size > 100000) fail('resource_limit', 'Analysis type dependency bound exceeded');
    if (typeIds.has(id)) continue;
    const record = store.readType(id, revision);
    if (!record) fail('invalid_input', 'Analysis type dependency is unavailable');
    for (const dependency of typeReferences(record.definition)) neededTypes.add(dependency);
    for (const proof of record.evidence_ids) neededProofs.add(proof);
  }
  for (const diagnostic of result.diagnostics) for (const id of diagnostic.evidence_ids) neededProofs.add(id);
  for (const mapping of result.data.emission.mappings) for (const id of mapping.evidence_ids) neededProofs.add(id);
  for (const proof of proofs.values()) for (const id of [...proof.derived_from, ...proof.conflicts_with]) neededProofs.add(id);
  // Walk durable proof dependencies too; an incomplete proof chain cannot authorize annotations.
  const inspected = new Set<string>();
  for (const id of neededProofs) {
    context.checkpoint(1);
    if (inspected.has(id)) continue;
    inspected.add(id);
    if (inspected.size > 100000) fail('resource_limit', 'Analysis proof dependency bound exceeded');
    const proof = proofs.get(id) ?? store.readEvidence([id], revision)[0];
    if (!proof) fail('invalid_input', 'Analysis evidence dependency is unavailable');
    for (const dependency of [...proof.derived_from, ...proof.conflicts_with]) neededProofs.add(dependency);
  }
  // Include result proofs in the durable catalog, so their IDs resolve after reopening.
  return { result: result as StoredDecompilation, catalog: { ...catalog, evidence: [...proofs.values()] } };
}

function loadPayload(store: ProjectStore, artifact: Artifact, context: OperationContext, expected?: CacheIdentity): AnalysisArtifactPayload {
  context.checkpoint(1);
  if (artifact.project_id !== store.project_id || artifact.media_type !== ANALYSIS_ARTIFACT_MEDIA_TYPE ||
      artifact.size > BigInt(MAX_ANALYSIS_ARTIFACT_BYTES)) fail('invalid_input', 'Invalid analysis artifact metadata');
  const bytes = store.readArtifactBytes(artifact);
  context.checkpoint(Math.ceil(bytes.length / 1024));
  const wire = payloadSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (wire.identity.annotation_revision !== artifact.revision || wire.identity.evidence_revision !== artifact.revision ||
      (expected && cacheIdentityKey(wire.identity) !== cacheIdentityKey(expected))) fail('invalid_input', 'Analysis artifact identity mismatch');
  const indexed = store.findArtifact(wire.identity);
  if (!indexed || fingerprint(encodeArtifact(indexed)) !== fingerprint(encodeArtifact(artifact))) fail('invalid_input', 'Analysis payload does not match its published cache key');
  const computation = validateComputation(store, wire.identity, { result: wire.result as StoredDecompilation,
    catalog: { subjects: wire.catalog.subjects, types: wire.catalog.types.map(record => ({ ...record, definition: decodeTypeDefinition(record.definition) })), evidence: wire.catalog.evidence.map(decodeEvidence) } }, context);
  return { format_version: ANALYSIS_ARTIFACT_VERSION, identity: wire.identity, ...computation };
}

function delivery(result: StoredDecompilation, artifact: Artifact, cache: 'hit' | 'computed', limit: number): ToolResult<'function_decompile'> {
  const handle = encodeArtifact(artifact);
  const inline = functionDecompileResultSchema.parse({ ...result, artifacts: [handle], data: { ...result.data, cache } });
  if (Buffer.byteLength(JSON.stringify(inline)) <= limit) return inline;
  const bounded = projectDecompilationArtifactResult(inline);
  if (Buffer.byteLength(JSON.stringify(bounded)) > limit) fail('resource_limit', 'Output budget cannot contain the analysis artifact response');
  return bounded;
}

export async function runCachedDecompilation(input: {
  readonly store: ProjectStore; readonly job_id: string; readonly identity: CacheIdentity;
  readonly context: OperationContext; readonly inline_limit: number;
}, compute: () => AnalysisComputation | Promise<AnalysisComputation>): Promise<ToolResult<'function_decompile'>> {
  const { store, job_id, context } = input;
  const identity = cacheIdentitySchema.parse(input.identity);
  if (!Number.isSafeInteger(input.inline_limit) || input.inline_limit < 1) fail('invalid_input', 'Invalid inline output limit');
  const limit = Math.min(input.inline_limit, identity.budget.output_bytes);
  activeJob(store, job_id, identity, context);
  const existing = store.findArtifact(identity);
  if (existing) {
    const payload = loadPayload(store, existing, context, identity);
    const response = delivery(payload.result, existing, 'hit', limit);
    const job = activeJob(store, job_id, identity, context);
    store.saveJob({ ...job, state: 'completed', progress: { phase: 'complete', completed: 1, total: 1 }, artifacts: [existing], published_revision: identity.annotation_revision });
    return response;
  }
  const computation = validateComputation(store, identity, await compute(), context);
  const bytes = Buffer.from(JSON.stringify({ format_version: ANALYSIS_ARTIFACT_VERSION, identity,
    result: computation.result, catalog: { subjects: computation.catalog.subjects,
      types: computation.catalog.types.map(record => ({ ...record, definition: encodeTypeDefinition(record.definition) })),
      evidence: computation.catalog.evidence.map(encodeEvidence) } }));
  if (bytes.length > MAX_ANALYSIS_ARTIFACT_BYTES) fail('resource_limit', 'Full analysis artifact exceeds 16 MiB');
  context.checkpoint(1);
  // IDs and digests have fixed wire widths. Size the exact response shape before commit;
  // publication supplies only the final, equally sized opaque artifact ID.
  const provisional: Artifact = { id: newIdentity('artifact'), project_id: store.project_id, revision: identity.annotation_revision,
    media_type: ANALYSIS_ARTIFACT_MEDIA_TYPE, size: BigInt(bytes.length), sha256: contentHash(bytes), schema_version: SCHEMA_VERSION };
  const response = delivery(computation.result, provisional, 'computed', limit);
  if (!('data' in response)) fail('invalid_input', 'Invalid prepared analysis delivery');
  activeJob(store, job_id, identity, context);
  const publication = await store.publishArtifact({ job_id, expected_revision: identity.annotation_revision, media_type: ANALYSIS_ARTIFACT_MEDIA_TYPE, bytes, cache: identity,
    analysis_ids: [...new Set([identity.function_id, ...computation.catalog.subjects.map(subject => subject.id), ...computation.catalog.types.map(record => record.id), ...computation.catalog.evidence.map(proof => proof.id)])] });
  if (publication.state !== 'published') fail(publication.state === 'cancelled' ? 'cancelled' : 'stale_revision', 'Analysis publication lost its current job snapshot');
  // No cancellable checkpoints or schema/size validation after durable completion.
  return { ...response, artifacts: [{ ...response.artifacts[0]!, id: publication.artifact.id }], data: response.data.delivery === 'artifact' ? { ...response.data, artifact_id: publication.artifact.id } : response.data };
}

export async function readAnnotationCatalog(store: ProjectStore, revision: number, ids: readonly string[], context: OperationContext, isCurrent: (identity: CacheIdentity) => boolean): Promise<TrustedSemanticCatalog | undefined> {
  context.checkpoint(0);
  if (ids.length === 0) return undefined;
  if (ids.length > 1000) fail('resource_limit', 'Too many annotation catalog identities');
  if (store.snapshot().revision !== revision) fail('stale_revision', 'Annotation catalogs require the current project revision');
  const subjects: AnnotationSubject[] = [], types: AnalysisCatalogData['types'][number][] = [], evidence: Evidence[] = [];
  let cursor: string | undefined, retained = 0, count = 0;
  const proofIdentities = new Map<string, string>();
  const typeIdentities = new Set<string>();
  do {
    context.checkpoint(1 + ids.length * 17);
    const page = store.findAnalysisArtifacts({ revision, ids, limit: 16, ...(cursor === undefined ? {} : { cursor }) });
    for (const artifact of page.items) {
      if (++count > 128 || (retained += Number(artifact.size)) > 32 * 1024 * 1024) fail('resource_limit', 'Annotation catalog read bound exceeded');
      const payload = loadPayload(store, artifact, context);
      if (!isCurrent(payload.identity)) continue;
      for (const subject of payload.catalog.subjects) subjects.push(subject);
      for (const record of payload.catalog.types) {
        const key = fingerprint({ ...record, definition: encodeTypeDefinition(record.definition) });
        if (!typeIdentities.has(key)) { typeIdentities.add(key); types.push(record); }
      }
      for (const proof of payload.catalog.evidence) {
        const key = fingerprint(encodeEvidence(proof)), prior = proofIdentities.get(proof.id);
        if (prior !== undefined && prior !== key) fail('invalid_input', 'Published catalogs disagree about evidence identity');
        if (prior === undefined) { proofIdentities.set(proof.id, key); evidence.push(proof); }
      }
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return subjects.length === 0 ? undefined : createTrustedSemanticCatalog(store, revision, { subjects, types, evidence }, context);
}
