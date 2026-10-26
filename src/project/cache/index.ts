import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  OperationError,
  SCHEMA_VERSION,
  cacheIdentityKey,
  cacheIdentitySchema,
  contentHash,
  type CanonicalValue,
  decodeEvidence,
  decodeTypeDefinition,
  encodeArtifact,
  EMISSION_METADATA_SHED_ORDER,
  encodeEvidence,
  encodeTypeDefinition,
  entityIdSchema,
  evidenceIdSchema,
  evidenceSchema,
  fingerprint,
  functionDecompileResultSchema,
  markSchemaValidated,
  imageIdSchema,
  newIdentity,
  projectDecompilationArtifactResult,
  sliceIdSchema,
  targetSchema,
  typeDefinitionSchema,
  type Artifact,
  type CacheIdentity,
  type Evidence,
  type Job,
  type OperationContext,
  type ProjectStore,
  type ToolResult,
} from '../../core/index.js';
import {
  createTrustedSemanticCatalog,
  type AnnotationSubject,
  type TrustedSemanticCatalog,
} from '../annotations/index.js';
import { typeReferences } from '../annotations/subjects.js';
import { shedStoredMetadata } from './limits.js';
import {
  ANALYSIS_ARTIFACT_MEDIA_TYPE,
  ANALYSIS_ARTIFACT_VERSION,
  MAX_ANALYSIS_ARTIFACT_BYTES,
  type AnalysisArtifactPayload,
  type AnalysisCatalogData,
  type AnalysisComputation,
  type ReviewedSourceLookup,
  type StoredDecompilation,
} from './model.js';
import {
  analysisReadsetSchema,
  analysisReuseScope,
  validateAnalysisReadset,
  type AnalysisDependencyCollector,
} from './dependencies.js';

export * from './model.js';
export * from './dependencies.js';

const subjectSchema = z.strictObject({
  id: entityIdSchema,
  kind: z.enum([
    'function',
    'call',
    'value',
    'stack',
    'field',
    'type',
    'string',
    'reference',
    'symbol',
    'import',
    'export',
    'section',
    'mapping',
    'relocation',
  ]),
  image_id: imageIdSchema,
  slice_id: sliceIdSchema,
  abi: targetSchema.shape.abi,
});
const catalogSchema = z.strictObject({
  subjects: z.array(subjectSchema).max(100000),
  types: z
    .array(
      z.strictObject({
        id: entityIdSchema,
        definition: typeDefinitionSchema,
        source: z.enum(['analysis', 'debug', 'library', 'runtime', 'user', 'llm']),
        status: z.enum(['candidate', 'established', 'asserted', 'hypothesis', 'conflicting']),
        evidence_ids: z.array(evidenceIdSchema).max(1000),
      }),
    )
    .max(100000),
  evidence: z.array(evidenceSchema).max(100000),
});
const payloadSchema = z.strictObject({
  format_version: z.literal(ANALYSIS_ARTIFACT_VERSION),
  identity: cacheIdentitySchema,
  result: functionDecompileResultSchema,
  catalog: catalogSchema,
  dependencies: analysisReadsetSchema.optional(),
});

// Digests of immutable parts of parsed identities, results and loaded images, by object. A
// stored payload and its image are checked against each other on every hit; hash each once.
const objectFingerprints = new WeakMap<object, string>();
function objectFingerprint(value: object): string {
  let digest = objectFingerprints.get(value);
  if (digest === undefined)
    objectFingerprints.set(value, (digest = fingerprint(value as CanonicalValue)));
  return digest;
}

function fail(
  code: 'invalid_input' | 'stale_revision' | 'cancelled' | 'resource_limit',
  message: string,
): never {
  throw new OperationError({ code, severity: 'error', message, evidence_ids: [] });
}

function activeJob(
  store: ProjectStore,
  id: string,
  identity: CacheIdentity,
  context: OperationContext,
): Job {
  context.checkpoint(0);
  const revision = store.snapshot().revision;
  if (revision !== identity.annotation_revision || revision !== identity.evidence_revision)
    fail('stale_revision', 'Analysis snapshot is no longer current');
  const job = store.readJob(id);
  if (
    !job ||
    job.project_id !== store.project_id ||
    job.operation !== 'function_decompile' ||
    job.input_revision !== revision
  )
    fail('invalid_input', 'Analysis job does not match the requested snapshot');
  if (job.state === 'cancelled') fail('cancelled', 'Analysis job was cancelled');
  if (job.state !== 'running' && job.state !== 'queued')
    fail('invalid_input', 'Analysis job is already terminal');
  return job;
}

/** Validate both the durable input scope and every semantic dependency before publication/use.
 * `parsed`: the computation is the output of `payloadSchema.parse` (result, catalog and readset
 * already schema-validated; the catalog decoded once), so those parses are not repeated. */
function validateComputation(
  store: ProjectStore,
  identity: CacheIdentity,
  computation: AnalysisComputation,
  context: OperationContext,
  parsed = false,
): AnalysisComputation {
  context.checkpoint(1);
  const revision = identity.annotation_revision;
  if (identity.evidence_revision !== revision) fail('invalid_input', 'Analysis revisions disagree');
  const snapshot = store.snapshot(revision);
  const imported = snapshot.images.find(
    (image) =>
      image.sha256 === identity.image_sha256 && image.selected_slice_id === identity.slice_id,
  );
  if (!imported) fail('invalid_input', 'Analysis image does not belong to the requested snapshot');
  const image = store.readLoadedImage(imported.image_id, identity.slice_id, revision);
  if (objectFingerprint(image.target) !== objectFingerprint(identity.target))
    fail('invalid_input', 'Analysis target does not match the imported image');
  const functions = store.queryRecords({
    revision,
    image_id: image.id,
    kind: 'function',
    ids: [identity.function_id],
    limit: 1,
  });
  if (functions.items.length !== 1)
    fail('invalid_input', 'Analysis function is absent from the requested snapshot');
  const result = parsed
    ? (computation.result as StoredDecompilation)
    : functionDecompileResultSchema.parse(computation.result);
  if (
    (result.state !== 'complete' && result.state !== 'partial') ||
    result.data.delivery !== 'inline' ||
    (result.state === 'partial' &&
      ((result.reason === 'output_limit' && !result.data.emission.omitted?.length) ||
        result.continuation !== null)) ||
    result.data.cache !== 'computed' ||
    result.data.reviewed_source !== undefined ||
    result.data.function_id !== identity.function_id ||
    result.project_id !== store.project_id ||
    result.revision !== revision ||
    result.artifacts.length !== 0 ||
    objectFingerprint(result.versions) !== objectFingerprint(identity.versions) ||
    objectFingerprint(result.options) !== objectFingerprint(identity.options) ||
    objectFingerprint(result.budget) !== objectFingerprint(identity.budget)
  )
    fail('invalid_input', 'Stored analysis metadata does not match its cache identity');
  if (
    result.data.emission.language !== identity.options.emitter ||
    result.data.emission.emitter_version !== identity.versions.emitter
  ) {
    fail('invalid_input', 'Stored emission dialect/version does not match its cache identity');
  }
  let catalog: AnalysisCatalogData;
  if (parsed) catalog = computation.catalog;
  else {
    const wireCatalog = catalogSchema.parse({
      subjects: computation.catalog.subjects,
      types: computation.catalog.types.map((record) => ({
        id: record.id,
        definition: encodeTypeDefinition(record.definition),
        source: record.source,
        status: record.status,
        evidence_ids: record.evidence_ids,
      })),
      evidence: computation.catalog.evidence.map(encodeEvidence),
    });
    catalog = {
      subjects: wireCatalog.subjects,
      types: wireCatalog.types.map((record) => ({
        ...record,
        definition: decodeTypeDefinition(record.definition),
      })),
      evidence: wireCatalog.evidence.map(decodeEvidence),
    };
  }
  createTrustedSemanticCatalog(store, revision, catalog, context, {
    image_id: image.id,
    slice_id: identity.slice_id,
    abi: identity.target.abi,
    function_id: identity.function_id,
  });
  const proofs = new Map<string, Evidence>();
  for (const proof of [...catalog.evidence, ...result.evidence.map(decodeEvidence)]) {
    context.checkpoint(1);
    const prior = proofs.get(proof.id);
    // Structurally equal decoded proofs encode alike, so they need no digest; any other pair
    // is judged by the digest of its wire form exactly as before.
    if (
      prior &&
      prior !== proof &&
      !isDeepStrictEqual(prior, proof) &&
      fingerprint(encodeEvidence(prior)) !== fingerprint(encodeEvidence(proof))
    )
      fail('invalid_input', 'Analysis evidence identity is ambiguous');
    if (
      proof.revision > revision ||
      (proof.origin.kind === 'binary' && proof.origin.range.start.image_id !== image.id)
    )
      fail('invalid_input', 'Analysis evidence escapes its snapshot');
    proofs.set(proof.id, proof);
  }
  const typeIds = new Set(catalog.types.map((record) => record.id));
  const neededProofs = new Set<string>();
  const neededTypes = new Set<string>();
  for (const record of catalog.types) {
    context.checkpoint(1 + record.evidence_ids.length);
    for (const id of record.evidence_ids) neededProofs.add(id);
    for (const id of typeReferences(record.definition)) neededTypes.add(id);
  }
  if (result.data.signature) {
    if (result.data.signature.abi !== identity.target.abi)
      fail('invalid_input', 'Analysis signature ABI does not match its target');
    for (const id of [
      result.data.signature.return_type,
      ...result.data.signature.parameters.map((parameter) => parameter.type_id),
    ]) {
      neededTypes.add(id);
    }
    for (const id of result.data.signature.evidence_ids) neededProofs.add(id);
  }
  for (const id of neededTypes) {
    context.checkpoint(1);
    if (neededTypes.size > 100000)
      fail('resource_limit', 'Analysis type dependency bound exceeded');
    if (typeIds.has(id)) continue;
    const record = store.readType(id, revision);
    if (!record) fail('invalid_input', 'Analysis type dependency is unavailable');
    for (const dependency of typeReferences(record.definition)) neededTypes.add(dependency);
    for (const proof of record.evidence_ids) neededProofs.add(proof);
  }
  for (const diagnostic of result.diagnostics)
    for (const id of diagnostic.evidence_ids) neededProofs.add(id);
  for (const id of result.data.emission.evidence) neededProofs.add(id);
  for (const proof of proofs.values())
    for (const id of [...proof.derived_from, ...proof.conflicts_with]) neededProofs.add(id);
  // Walk durable proof dependencies too; an incomplete proof chain cannot authorize annotations.
  const inspected = new Set<string>();
  for (const id of neededProofs) {
    context.checkpoint(1);
    if (inspected.has(id)) continue;
    inspected.add(id);
    if (inspected.size > 100000) fail('resource_limit', 'Analysis proof dependency bound exceeded');
    const proof = proofs.get(id) ?? store.readEvidence([id], revision)[0];
    if (!proof) fail('invalid_input', 'Analysis evidence dependency is unavailable');
    for (const dependency of [...proof.derived_from, ...proof.conflicts_with])
      neededProofs.add(dependency);
  }
  // Include result proofs in the durable catalog, so their IDs resolve after reopening.
  return {
    result: result as StoredDecompilation,
    catalog: { ...catalog, evidence: [...proofs.values()] },
    ...(computation.dependencies === undefined
      ? {}
      : {
          dependencies: parsed
            ? computation.dependencies
            : analysisReadsetSchema.parse(computation.dependencies),
        }),
  };
}

interface ParsedPayload {
  readonly size: number;
  readonly wire: z.output<typeof payloadSchema>;
  readonly catalog: AnalysisCatalogData;
}
// Payloads parsed in this process by the digest of their (store-verified) bytes. Parsing is a
// pure function of the bytes; every store-dependent validation still runs on each use. Least
// recently used first, bounded by source bytes.
const parsedPayloads = new Map<string, ParsedPayload>();
let parsedPayloadBytes = 0;
const MAX_PARSED_PAYLOAD_BYTES = 16 * 1024 * 1024;

function parsePayload(sha256: string, bytes: Uint8Array): ParsedPayload {
  const known = parsedPayloads.get(sha256);
  if (known) {
    parsedPayloads.delete(sha256);
    parsedPayloads.set(sha256, known);
    return known;
  }
  const wire = payloadSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  );
  const parsed: ParsedPayload = {
    size: bytes.length,
    wire,
    catalog: {
      subjects: wire.catalog.subjects,
      types: wire.catalog.types.map((record) => ({
        ...record,
        definition: decodeTypeDefinition(record.definition),
      })),
      evidence: wire.catalog.evidence.map(decodeEvidence),
    },
  };
  if (parsed.size <= MAX_PARSED_PAYLOAD_BYTES) {
    for (const [key, old] of parsedPayloads) {
      if (parsedPayloadBytes + parsed.size <= MAX_PARSED_PAYLOAD_BYTES) break;
      parsedPayloads.delete(key);
      parsedPayloadBytes -= old.size;
    }
    parsedPayloads.set(sha256, parsed);
    parsedPayloadBytes += parsed.size;
  }
  return parsed;
}

function loadPayload(
  store: ProjectStore,
  artifact: Artifact,
  context: OperationContext,
  expected?: CacheIdentity,
  historical = false,
  /** The artifact `store.findArtifact(expected)` returned: it is the one the payload's own
   * identity indexes (their keys are checked equal below), so it is not looked up again. */
  located?: Artifact,
): AnalysisArtifactPayload {
  context.checkpoint(1);
  if (
    artifact.project_id !== store.project_id ||
    artifact.media_type !== ANALYSIS_ARTIFACT_MEDIA_TYPE ||
    artifact.size > BigInt(MAX_ANALYSIS_ARTIFACT_BYTES)
  )
    fail('invalid_input', 'Invalid analysis artifact metadata');
  const bytes = store.readArtifactBytes(artifact);
  context.checkpoint(Math.ceil(bytes.length / 1024));
  const { wire, catalog } = parsePayload(artifact.sha256, bytes);
  if (
    wire.identity.annotation_revision !== artifact.revision ||
    wire.identity.evidence_revision !== artifact.revision ||
    (expected && cacheIdentityKey(wire.identity) !== cacheIdentityKey(expected))
  )
    fail('invalid_input', 'Analysis artifact identity mismatch');
  if (located === undefined || located !== artifact || expected === undefined) {
    const indexed = historical
      ? store.findHistoricalArtifact(wire.identity)
      : store.findArtifact(wire.identity);
    if (!indexed || fingerprint(encodeArtifact(indexed)) !== fingerprint(encodeArtifact(artifact)))
      fail('invalid_input', 'Analysis payload does not match its published cache key');
  }
  const computation = validateComputation(
    store,
    wire.identity,
    {
      result: wire.result as StoredDecompilation,
      ...(wire.dependencies === undefined ? {} : { dependencies: wire.dependencies }),
      catalog,
    },
    context,
    true,
  );
  return { format_version: ANALYSIS_ARTIFACT_VERSION, identity: wire.identity, ...computation };
}

/** Exact published artifact reader shared by trusted investigation/catalog consumers. */
export function readAnalysisArtifact(
  store: ProjectStore,
  artifact: Artifact,
  context: OperationContext,
  expected?: CacheIdentity,
): AnalysisArtifactPayload {
  return loadPayload(store, artifact, context, expected);
}

function delivery(
  result: StoredDecompilation,
  artifact: Artifact,
  cache: 'hit' | 'computed',
  /** Work the request charged up to delivery; reported, never stored or part of identity. */
  work: number | undefined,
  limit: number,
  preference: 'auto' | 'artifact',
  /** `result` is a stored, schema-validated inline result: wrapping it in a handle needs no
   * second full parse. */
  validated = false,
  reviewed?: ReviewedSourceLookup,
): ToolResult<'function_decompile'> {
  const handle = encodeArtifact(artifact);
  const wrapped = {
    ...result,
    artifacts: [handle],
    ...(reviewed === undefined || reviewed.diagnostics.length === 0
      ? {}
      : { diagnostics: [...result.diagnostics, ...reviewed.diagnostics] }),
    data: {
      ...result.data,
      cache,
      ...(work === undefined ? {} : { work }),
      ...(reviewed === undefined ? {} : { reviewed_source: reviewed.reviewed_source }),
    },
  };
  const inline =
    validated && reviewed === undefined
      ? (wrapped as ToolResult<'function_decompile'>)
      : functionDecompileResultSchema.parse(wrapped);
  if (preference === 'artifact') {
    const requested = projectDecompilationArtifactResult(inline, 'requested');
    if (Buffer.byteLength(JSON.stringify(requested)) > limit)
      fail('resource_limit', 'Output budget cannot contain the requested artifact metadata');
    return requested;
  }
  if (Buffer.byteLength(JSON.stringify(inline)) <= limit) return inline;
  const bounded = projectDecompilationArtifactResult(inline);
  if (Buffer.byteLength(JSON.stringify(bounded)) > limit)
    fail('resource_limit', 'Output budget cannot contain the analysis artifact response');
  return bounded;
}

export async function runCachedDecompilation(
  input: {
    readonly store: ProjectStore;
    readonly job_id: string;
    readonly identity: CacheIdentity;
    readonly context: OperationContext;
    readonly inline_limit: number;
    readonly delivery?: 'auto' | 'artifact';
    /** Reviewed source of the function for the stored emission text: delivered beside the result,
     * never stored in it and never part of the cache identity. */
    readonly review?: (emissionText: string) => ReviewedSourceLookup;
    readonly dependencies?: AnalysisDependencyCollector;
    /** False: read and reuse no stored result and publish none (a transient artifact serves any
     * artifact delivery for this session only). */
    readonly analysis_cache?: boolean;
  },
  compute: () => AnalysisComputation | Promise<AnalysisComputation>,
): Promise<ToolResult<'function_decompile'>> {
  const { store, job_id, context } = input;
  const identity = cacheIdentitySchema.parse(input.identity);
  if (!Number.isSafeInteger(input.inline_limit) || input.inline_limit < 1)
    fail('invalid_input', 'Invalid inline output limit');
  const limit = Math.min(input.inline_limit, identity.budget.output_bytes);
  activeJob(store, job_id, identity, context);
  // Disabled: no stored result is read or reused and nothing is published; the response
  // is still delivered exactly as a computed one (inline, or by a transient artifact).
  const enabled = input.analysis_cache !== false;
  const existing = enabled ? store.findArtifact(identity) : null;
  if (existing) {
    const payload = loadPayload(store, existing, context, identity, false, existing);
    const response = delivery(
      payload.result,
      existing,
      'hit',
      (context.root ?? context).consumedWork?.(),
      limit,
      input.delivery ?? 'auto',
      true,
      input.review?.(payload.result.data.emission.text),
    );
    const job = activeJob(store, job_id, identity, context);
    store.saveJob({
      ...job,
      state: 'completed',
      progress: { phase: 'complete', completed: 1, total: 1 },
      artifacts: [existing],
      published_revision: identity.annotation_revision,
    });
    // Parsed payload, parsed handle and size already bounded: complete as it stands.
    return markSchemaValidated(response);
  }
  let reused = false;
  let candidate: AnalysisComputation | undefined;
  const dependencyStore = input.dependencies?.source ?? store;
  for (const artifact of enabled ? store.findReuseCandidates(identity, 8) : []) {
    activeJob(store, job_id, identity, context);
    const payload = loadPayload(dependencyStore, artifact, context, undefined, true);
    if (analysisReuseScope(payload.identity) !== analysisReuseScope(identity))
      fail('invalid_input', 'Analysis reuse candidate escapes its immutable scope');
    if (
      payload.dependencies === undefined ||
      !validateAnalysisReadset(
        dependencyStore,
        identity.annotation_revision,
        payload.dependencies,
        context,
      )
    )
      continue;
    context.progress('dependency-reuse', 0, 1);
    candidate = {
      result: { ...payload.result, revision: identity.annotation_revision },
      catalog: payload.catalog,
      dependencies: payload.dependencies,
    };
    reused = true;
    break;
  }
  // A reuse candidate is a stored payload `loadPayload` parsed and validated against its own
  // snapshot; only the current snapshot's checks remain. A computed result is validated once.
  let computation = candidate
    ? validateComputation(store, identity, candidate, context, true)
    : validateComputation(store, identity, await compute(), context);
  if (enabled && !reused && input.dependencies !== undefined)
    computation = { ...computation, dependencies: input.dependencies.finish() };
  if (reused) context.progress('dependency-reuse', 1, 1);
  const serialize = (value: AnalysisComputation): Buffer =>
    Buffer.from(
      JSON.stringify({
        format_version: ANALYSIS_ARTIFACT_VERSION,
        identity,
        result: value.result,
        ...(value.dependencies === undefined ? {} : { dependencies: value.dependencies }),
        catalog: {
          subjects: value.catalog.subjects,
          types: value.catalog.types.map((record) => ({
            ...record,
            definition: encodeTypeDefinition(record.definition),
          })),
          evidence: value.catalog.evidence.map(encodeEvidence),
        },
      }),
    );
  let bytes = serialize(computation);
  // `computation.result` is the output of `functionDecompileResultSchema.parse` (the hit path's
  // parsed payload for a reuse); only shedding below replaces it with an unparsed value.
  let shed = false;
  // The artifact bound never costs the pseudocode. Derived data is shed in order: the
  // incremental-reuse readset (the artifact then serves only its exact revision), then
  // whole provenance classes of the emission, each named in `emission.omitted` and in a
  // partial `provenance` coverage entry. Text, signature and the annotation catalog stay.
  if (bytes.length > MAX_ANALYSIS_ARTIFACT_BYTES && computation.dependencies !== undefined) {
    const { dependencies: _readset, ...exact } = computation;
    computation = exact;
    bytes = serialize(computation);
  }
  for (const kinds of EMISSION_METADATA_SHED_ORDER) {
    if (bytes.length <= MAX_ANALYSIS_ARTIFACT_BYTES) break;
    computation = { ...computation, result: shedStoredMetadata(computation.result, kinds) };
    shed = true;
    bytes = serialize(computation);
  }
  if (bytes.length > MAX_ANALYSIS_ARTIFACT_BYTES)
    fail(
      'resource_limit',
      `Analysis artifact exceeds 16 MiB even without provenance metadata (pseudocode ${Buffer.byteLength(computation.result.data.emission.text)} bytes)`,
    );
  context.checkpoint(1);
  // IDs and digests have fixed wire widths. Size the exact response shape before commit;
  // publication supplies only the final, equally sized opaque artifact ID.
  const provisional: Artifact = {
    id: newIdentity('artifact'),
    project_id: store.project_id,
    revision: identity.annotation_revision,
    media_type: ANALYSIS_ARTIFACT_MEDIA_TYPE,
    size: BigInt(bytes.length),
    sha256: contentHash(bytes),
    schema_version: SCHEMA_VERSION,
  };
  const response = delivery(
    computation.result,
    provisional,
    reused ? 'hit' : 'computed',
    (context.root ?? context).consumedWork?.(),
    limit,
    input.delivery ?? 'auto',
    !shed,
    input.review?.(computation.result.data.emission.text),
  );
  if (!('data' in response)) fail('invalid_input', 'Invalid prepared analysis delivery');
  activeJob(store, job_id, identity, context);
  const publication = !enabled
    ? {
        state: 'published' as const,
        artifact: store.publishTransientArtifact({
          media_type: ANALYSIS_ARTIFACT_MEDIA_TYPE,
          bytes,
        }),
      }
    : await store.publishArtifact({
        job_id,
        expected_revision: identity.annotation_revision,
        media_type: ANALYSIS_ARTIFACT_MEDIA_TYPE,
        bytes,
        cache: identity,
        ...(computation.dependencies === undefined
          ? {}
          : { reuse_scope: analysisReuseScope(identity) }),
        analysis_ids: [
          ...new Set([
            identity.function_id,
            ...computation.catalog.subjects.map((subject) => subject.id),
            ...computation.catalog.types.map((record) => record.id),
            ...computation.catalog.evidence.map((proof) => proof.id),
          ]),
        ],
      });
  if (publication.state !== 'published')
    fail(
      publication.state === 'cancelled' ? 'cancelled' : 'stale_revision',
      'Analysis publication lost its current job snapshot',
    );
  // No cancellable checkpoints or schema/size validation after durable completion.
  return {
    ...response,
    artifacts: [{ ...response.artifacts[0]!, id: publication.artifact.id }],
    data:
      response.data.delivery === 'artifact'
        ? { ...response.data, artifact_id: publication.artifact.id }
        : response.data,
  };
}

export async function readAnnotationCatalog(
  store: ProjectStore,
  revision: number,
  ids: readonly string[],
  context: OperationContext,
  isCurrent: (identity: CacheIdentity) => boolean,
): Promise<TrustedSemanticCatalog | undefined> {
  context.checkpoint(0);
  if (ids.length === 0) return undefined;
  if (ids.length > 1000) fail('resource_limit', 'Too many annotation catalog identities');
  if (store.snapshot().revision !== revision)
    fail('stale_revision', 'Annotation catalogs require the current project revision');
  const subjects: AnnotationSubject[] = [],
    types: AnalysisCatalogData['types'][number][] = [],
    evidence: Evidence[] = [];
  let cursor: string | undefined,
    retained = 0,
    count = 0;
  const proofIdentities = new Map<string, string>();
  const typeIdentities = new Set<string>();
  do {
    context.checkpoint(1 + ids.length * 17);
    const page = store.findAnalysisArtifacts({
      revision,
      ids,
      limit: 16,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const artifact of page.items) {
      if (++count > 128 || (retained += Number(artifact.size)) > 32 * 1024 * 1024)
        fail('resource_limit', 'Annotation catalog read bound exceeded');
      const payload = loadPayload(store, artifact, context);
      if (!isCurrent(payload.identity)) continue;
      for (const subject of payload.catalog.subjects) subjects.push(subject);
      for (const record of payload.catalog.types) {
        const key = fingerprint({ ...record, definition: encodeTypeDefinition(record.definition) });
        if (!typeIdentities.has(key)) {
          typeIdentities.add(key);
          types.push(record);
        }
      }
      for (const proof of payload.catalog.evidence) {
        const key = fingerprint(encodeEvidence(proof)),
          prior = proofIdentities.get(proof.id);
        if (prior !== undefined && prior !== key)
          fail('invalid_input', 'Published catalogs disagree about evidence identity');
        if (prior === undefined) {
          proofIdentities.set(proof.id, key);
          evidence.push(proof);
        }
      }
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return subjects.length === 0
    ? undefined
    : createTrustedSemanticCatalog(store, revision, { subjects, types, evidence }, context);
}
