import {
  OperationError,
  SCHEMA_VERSION,
  contentHash,
  encodeArtifact,
  newIdentity,
  type Artifact,
  type CacheIdentity,
  type Diagnostic,
  type Job,
  type ProjectStore,
} from '../core/index.js';
import type { SqliteProjectStore } from '../project/store/index.js';

function fail(code: Diagnostic['code'], message: string): never {
  throw new OperationError({ code, severity: 'error', message, evidence_ids: [] });
}

/** A publication a request made, for the owner to repeat in the project (docs/internals/
 * project-cache.md §4b). `artifact` is exactly what the owner's publication must produce. */
export type RequestPublication =
  | {
      readonly kind: 'artifact';
      readonly artifact: Artifact;
      readonly media_type: string;
      readonly bytes: Uint8Array;
      readonly cache: CacheIdentity;
      readonly analysis_ids?: readonly string[];
      readonly reuse_scope?: string;
    }
  | {
      readonly kind: 'transient';
      readonly artifact: Artifact;
      readonly media_type: string;
      readonly bytes: Uint8Array;
    };

/** The store one request sees in a request worker: every read comes from the shared project
 * snapshot (`SqliteProjectStore.openSnapshot`), summaries go to the worker's outbox, and the
 * request's own job and publications are held here until the owner, the project's single
 * writer, repeats them. A publication passes the checks the owner's will (revision, job
 * state), so a request that publishes here publishes there unless the project changed or the
 * job was cancelled meanwhile, which the owner reports exactly as it would have. */
export class RequestStore implements ProjectStore {
  readonly project_id: string;
  readonly #base: SqliteProjectStore;
  #job: Job;
  readonly publications: RequestPublication[] = [];
  constructor(base: SqliteProjectStore, job: Job) {
    if (job.project_id !== base.project_id) fail('invalid_input', 'Job belongs to another project');
    this.#base = base;
    this.project_id = base.project_id;
    this.#job = job;
  }

  /** The request's job as the request last saved it. */
  get job(): Job {
    return this.#job;
  }

  snapshot: ProjectStore['snapshot'] = (revision) => this.#base.snapshot(revision);
  importImage: ProjectStore['importImage'] = () =>
    fail('invalid_input', 'A request worker cannot import images');
  readImage: ProjectStore['readImage'] = (imageId) => this.#base.readImage(imageId);
  readLoadedImage: ProjectStore['readLoadedImage'] = (imageId, sliceId, revision) =>
    this.#base.readLoadedImage(imageId, sliceId, revision);
  readRecordScopeVersion: ProjectStore['readRecordScopeVersion'] = (imageId, kind, revision) =>
    this.#base.readRecordScopeVersion(imageId, kind, revision);
  queryRecords: ProjectStore['queryRecords'] = (query) => this.#base.queryRecords(query);
  readDiscoveryFrontier: ProjectStore['readDiscoveryFrontier'] = (imageId, revision) =>
    this.#base.readDiscoveryFrontier(imageId, revision);
  transaction: ProjectStore['transaction'] = () =>
    fail('invalid_input', 'A request worker cannot mutate the project');
  applyAnnotations: ProjectStore['applyAnnotations'] = () =>
    fail('invalid_input', 'A request worker cannot mutate the project');
  readAnnotations: ProjectStore['readAnnotations'] = (entityId, revision) =>
    this.#base.readAnnotations(entityId, revision);
  readDataEntity: ProjectStore['readDataEntity'] = (id, revision) =>
    this.#base.readDataEntity(id, revision);
  readDataEntities: ProjectStore['readDataEntities'] = (query) =>
    this.#base.readDataEntities(query);
  queryAnnotations: ProjectStore['queryAnnotations'] = (query) =>
    this.#base.queryAnnotations(query);
  queryAnnotationHistory: ProjectStore['queryAnnotationHistory'] = (query) =>
    this.#base.queryAnnotationHistory(query);
  readEvidence: ProjectStore['readEvidence'] = (ids, revision) =>
    this.#base.readEvidence(ids, revision);
  readType: ProjectStore['readType'] = (id, revision) => this.#base.readType(id, revision);
  readSignature: ProjectStore['readSignature'] = (functionId, revision) =>
    this.#base.readSignature(functionId, revision);
  readLineage: ProjectStore['readLineage'] = (entityId, revision) =>
    this.#base.readLineage(entityId, revision);
  findArtifact: ProjectStore['findArtifact'] = (identity) => this.#base.findArtifact(identity);
  findHistoricalArtifact: ProjectStore['findHistoricalArtifact'] = (identity) =>
    this.#base.findHistoricalArtifact(identity);
  findReuseCandidates: ProjectStore['findReuseCandidates'] = (identity, limit) =>
    this.#base.findReuseCandidates(identity, limit);
  findAnalysisArtifacts: ProjectStore['findAnalysisArtifacts'] = (query) =>
    this.#base.findAnalysisArtifacts(query);
  readArtifact: ProjectStore['readArtifact'] = (input) => this.#base.readArtifact(input);
  readArtifactBytes: ProjectStore['readArtifactBytes'] = (artifact) =>
    this.#base.readArtifactBytes(artifact);
  readNativeSummary: ProjectStore['readNativeSummary'] = (scope, functionId) =>
    this.#base.readNativeSummary(scope, functionId);
  queueNativeSummary: ProjectStore['queueNativeSummary'] = (row) =>
    this.#base.queueNativeSummary(row);
  releaseNativeSummaries: ProjectStore['releaseNativeSummaries'] = () =>
    this.#base.releaseNativeSummaries();
  flushNativeSummaries: ProjectStore['flushNativeSummaries'] = (maxRows) =>
    this.#base.flushNativeSummaries(maxRows);
  listJobs: ProjectStore['listJobs'] = (query) => this.#base.listJobs(query);

  #artifact(media_type: string, bytes: Uint8Array): Artifact {
    const artifact: Artifact = {
      id: newIdentity('artifact'),
      project_id: this.project_id,
      revision: this.#base.snapshot().revision,
      media_type,
      size: BigInt(bytes.length),
      sha256: contentHash(bytes),
      schema_version: SCHEMA_VERSION,
    };
    encodeArtifact(artifact);
    return artifact;
  }

  publishArtifact: ProjectStore['publishArtifact'] = async (input) => {
    const current = this.#base.snapshot().revision;
    if (input.artifact_id !== undefined)
      fail('invalid_input', 'A request worker chooses its own artifact identities');
    if (current !== input.expected_revision) return { state: 'stale', current_revision: current };
    const job = this.readJob(input.job_id);
    if (!job) fail('not_found', 'Artifact job does not exist');
    if (job.state === 'cancelled') return { state: 'cancelled', current_revision: current };
    if (job.input_revision !== current || job.state === 'stale')
      return { state: 'stale', current_revision: current };
    if (job.state !== 'queued' && job.state !== 'running')
      fail('invalid_input', 'Finished jobs cannot publish artifacts');
    const artifact = this.#artifact(input.media_type, input.bytes);
    this.publications.push({
      kind: 'artifact',
      artifact,
      media_type: input.media_type,
      bytes: input.bytes,
      cache: input.cache,
      ...(input.analysis_ids === undefined ? {} : { analysis_ids: input.analysis_ids }),
      ...(input.reuse_scope === undefined ? {} : { reuse_scope: input.reuse_scope }),
    });
    this.#job = {
      ...job,
      state: 'completed',
      progress: { phase: 'complete', completed: 1, total: 1 },
      artifacts: [artifact],
      published_revision: current,
    };
    this.#base.releaseNativeSummaries();
    return { state: 'published', artifact };
  };

  publishTransientArtifact: ProjectStore['publishTransientArtifact'] = (input) => {
    if (input.artifact_id !== undefined)
      fail('invalid_input', 'A request worker chooses its own artifact identities');
    const artifact = this.#artifact(input.media_type, input.bytes);
    this.publications.push({
      kind: 'transient',
      artifact,
      media_type: input.media_type,
      bytes: input.bytes,
    });
    return artifact;
  };

  saveJob: ProjectStore['saveJob'] = (job) => {
    if (job.id !== this.#job.id || job.project_id !== this.project_id)
      fail('invalid_input', 'A request saves only its own job');
    if (job.input_revision !== this.#job.input_revision || job.operation !== this.#job.operation)
      fail('conflicting_evidence', 'Job identity cannot change its input');
    this.#job = job;
  };

  readJob: ProjectStore['readJob'] = (jobId) =>
    jobId === this.#job.id ? this.#job : this.#base.readJob(jobId);

  /** The snapshot outlives the request; closing the request closes nothing. */
  close: ProjectStore['close'] = async () => {};
}
