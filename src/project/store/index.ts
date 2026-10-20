import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, constants as zlib } from 'node:zlib';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  AddressMap,
  ImmutableBytes,
  OperationError,
  SCHEMA_VERSION,
  addressSchema,
  annotationIdSchema,
  annotationSchema,
  artifactIdSchema,
  artifactReadArgsSchema,
  artifactReadResultSchema,
  cacheIdentityKey,
  cacheIdentitySchema,
  contentHash,
  decodeCursor,
  digestSchema,
  encodeAnnotation,
  encodeAnnotationEdit,
  encodeArtifact,
  encodeCursor,
  encodeDiagnostic,
  encodeEvidence,
  encodeJob,
  encodeTypeDefinition,
  entityIdSchema,
  evidenceIdSchema,
  exportSchema,
  fingerprint,
  functionSchema,
  headerSchema,
  imageIdSchema,
  imageIdentity,
  imageSummarySchema,
  importSchema,
  jobIdSchema,
  lineageSchema,
  mappingSchema,
  newIdentity,
  nextRevision,
  projectIdSchema,
  referenceSchema,
  relocationSchema,
  revisionSchema,
  sectionSchema,
  signatureSchema,
  sliceIdSchema,
  stringRecordSchema,
  symbolSchema,
  hintSchema,
  type NativeSummaryRow,
  type Address,
  type Annotation,
  type AnnotationBatch,
  type AnnotationQuery,
  type AnnotationHistoryQuery,
  type AnnotationHistoryEntry,
  type Artifact,
  type CacheIdentity,
  type Diagnostic,
  type Evidence,
  type Job,
  type LoadedImage,
  type MutationResult,
  type ProjectSnapshot,
  type ProjectStore,
  type RecordQuery,
  type RecoveredType,
  type Signature,
  type StoreFactory,
  type StoredRecordKinds,
  type StoreTransaction,
} from '../../core/index.js';
import {
  MAX_GRAPH_BYTES,
  MAX_RECORD_BYTES,
  decodeStored,
  decodeStoredGraph,
  encodeStored,
  encodeStoredGraph,
  wireValue,
} from './encoding.js';
import {
  IMAGE_METADATA_TABLE,
  readImageMetadata,
  writeImageMetadata,
  type ImageMetadata,
} from './image-metadata.js';

// Persistence migrations are independent of the public wire/artifact schema version.
const STORE_SCHEMA_VERSION = 6;
/** Per-project cap on persisted prepared-callee summaries (compressed payload bytes). Entries
 * of superseded revisions go first, then the oldest write; see `flushNativeSummaries`. */
export const DEFAULT_NATIVE_SUMMARY_BYTES = 64 * 1024 * 1024;
/** Queued summaries are written at the next publication; a long computation that queues more
 * than this flushes by itself. */
/** Delivery-only artifacts (analysis caching disabled) kept in memory for this connection. */
const MAX_TRANSIENT_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_SUMMARY_BYTES = 8 * 1024 * 1024;
/** One persisted summary larger than this is not stored; loading it would cost about what preparing does. */
const MAX_NATIVE_SUMMARY_ROW_BYTES = 16 * 1024 * 1024;
const NATIVE_SUMMARIES_TABLE = `CREATE TABLE native_summaries(scope TEXT NOT NULL, function_id TEXT NOT NULL, revision INTEGER NOT NULL, seq INTEGER NOT NULL, allowance INTEGER NOT NULL, work INTEGER NOT NULL, bytes INTEGER NOT NULL, digest TEXT NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(scope,function_id)) STRICT;
  CREATE INDEX native_summaries_order ON native_summaries(revision,seq,bytes);`;
const annotationActorSchema = annotationSchema.pick({ author: true, origin: true });
const MAX_IMAGE_BYTES = 512 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_LOADED_IMAGE_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_LOADED_IMAGE_CACHE_ENTRIES = 4;
const RECORD_SCHEMAS = {
  function: functionSchema,
  string: stringRecordSchema,
  reference: referenceSchema,
  symbol: symbolSchema,
  import: importSchema,
  export: exportSchema,
} as const;
type RecordKind = keyof StoredRecordKinds;
type Row = Record<string, unknown>;

function fail(code: Diagnostic['code'], message: string): never {
  throw new OperationError({
    code,
    severity: 'error',
    message: message.slice(0, 8192),
    evidence_ids: [],
  });
}
function numberField(row: Row | undefined, field: string): number {
  const value = row?.[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    fail('invalid_input', `Invalid persisted ${field}`);
  return value;
}
function stringField(row: Row | undefined, field: string): string {
  const value = row?.[field];
  if (typeof value !== 'string') fail('invalid_input', `Invalid persisted ${field}`);
  return value;
}
function directory(path: string, create: boolean): void {
  if (!existsSync(path) && create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail('permission_denied', 'Project storage directories must not be symlinks');
}
function checkedFile(path: string, maximum: number): Uint8Array {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum)
    fail('invalid_input', 'Invalid or oversized project file');
  return readFileSync(path, { flag: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) });
}
function hashImage(bytes: ImmutableBytes): string {
  const hash = createHash('sha256');
  for (let offset = 0; offset < bytes.length; offset += 1_048_576)
    hash.update(bytes.read(BigInt(offset), Math.min(1_048_576, bytes.length - offset)));
  return hash.digest('hex');
}
function writeImmutable(path: string, bytes: ImmutableBytes | Uint8Array): void {
  const temporary = `${path}.${newIdentity('artifact')}.pending`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    const length = bytes.length;
    for (let offset = 0; offset < length; offset += 1_048_576) {
      const chunk =
        bytes instanceof ImmutableBytes
          ? bytes.read(BigInt(offset), Math.min(1_048_576, length - offset))
          : bytes.subarray(offset, offset + 1_048_576);
      let written = 0;
      while (written < chunk.length)
        written += writeSync(fd, chunk, written, chunk.length - written);
    }
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temporary, path);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
}
function recordLocation(record: StoredRecordKinds[RecordKind]): Address | null {
  if ('entry' in record) return record.entry;
  if ('address' in record) return record.address;
  if ('slot' in record) return record.slot ?? record.callable_entry;
  if ('from' in record) return record.from;
  return null;
}
function validateImage(image: LoadedImage): void {
  imageSummarySchema.parse(
    wireValue({
      id: image.id,
      sha256: image.sha256,
      byte_length: BigInt(image.bytes.length),
      selected_slice_id: image.selected_slice_id,
      image_base: image.image_base,
      target: image.target,
      slices: image.slices,
      entry_points: image.entry_points,
      capabilities: image.capabilities,
    }),
  );
  for (const item of image.mappings) mappingSchema.parse(wireValue(item));
  for (const item of image.headers) headerSchema.parse(wireValue(item));
  for (const item of image.sections) sectionSchema.parse(wireValue(item));
  for (const item of image.symbols) symbolSchema.parse(wireValue(item));
  for (const item of image.imports) importSchema.parse(wireValue(item));
  for (const item of image.exports) exportSchema.parse(wireValue(item));
  for (const item of image.relocations) relocationSchema.parse(wireValue(item));
  for (const item of image.hints) hintSchema.parse(wireValue(item));
  for (const item of image.evidence) encodeEvidence(item);
  for (const item of image.diagnostics) encodeDiagnostic(item);
}

/** Only decoded metadata is frozen; bytes and address maps already expose immutable interfaces. */
function freezeMetadata(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeMetadata(child);
  Object.freeze(value);
}

interface PendingSummary {
  readonly scope: string;
  readonly function_id: string;
  readonly revision: number;
  readonly allowance: number;
  readonly work: number;
  readonly digest: string;
  readonly payload: Uint8Array;
}
/** A row is authentic only for exactly the identity it was written under. */
function summaryDigest(
  scope: string,
  functionId: string,
  revision: number,
  payload: Uint8Array,
): string {
  return createHash('sha256')
    .update(`${scope}\n${functionId}\n${revision}\n`)
    .update(payload)
    .digest('hex');
}

/** Owns one exclusive SQLite connection. OS releases the lock after a worker crash. */
export class SqliteProjectStore implements ProjectStore {
  readonly project_id: string;
  readonly #db: DatabaseSync;
  readonly #path: string;
  #closed = false;
  #transaction = false;
  // The exclusive connection owns immutable metadata revisions. Keep their validated
  // indexes, not a second cache keyed to unrelated annotation revisions.
  readonly #loadedImages = new Map<string, { image: LoadedImage; byte_length: number }>();
  #loadedImageBytes = 0;
  // Prepared statements of this connection, by SQL text. Compiling a statement costs
  // far more than most indexed reads; dynamic SQL shapes are bounded by the cap.
  readonly #statements = new Map<string, StatementSync>();
  readonly #annotatedRevisions = new Map<number, boolean>();
  readonly #summaryCap: number;
  // Summaries awaiting the next batched write, by `scope\0function`.
  readonly #pendingSummaries = new Map<string, PendingSummary>();
  #pendingSummaryBytes = 0;
  // Analysis artifacts delivered with analysis caching disabled: memory only, newest kept.
  readonly #transientArtifacts = new Map<string, { artifact: Artifact; bytes: Uint8Array }>();
  #transientBytes = 0;

  private constructor(path: string, db: DatabaseSync, summaryCap = DEFAULT_NATIVE_SUMMARY_BYTES) {
    this.#path = path;
    this.#db = db;
    if (!Number.isSafeInteger(summaryCap) || summaryCap < 0)
      fail('invalid_input', 'Invalid native summary byte cap');
    this.#summaryCap = summaryCap;
    this.project_id = projectIdSchema.parse(
      stringField(
        db.prepare('SELECT project_id FROM metadata WHERE singleton=1').get(),
        'project_id',
      ),
    );
  }

  #prepare(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      if (this.#statements.size >= 256) this.#statements.clear();
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  static open(
    path: string,
    mode: 'create' | 'resume',
    options: { readonly native_summary_bytes?: number } = {},
  ): SqliteProjectStore {
    const requested = resolve(path);
    directory(requested, mode === 'create');
    const root = realpathSync(requested);
    const databasePath = join(root, 'project.sqlite');
    if (mode === 'create') {
      if (existsSync(databasePath))
        fail('invalid_input', 'Project already exists; resume it instead');
      const fd = openSync(databasePath, 'wx', 0o600);
      closeSync(fd);
    } else {
      if (!existsSync(databasePath)) fail('not_found', 'Project database does not exist');
      const stat = lstatSync(databasePath);
      if (!stat.isFile() || stat.isSymbolicLink())
        fail('permission_denied', 'Project database must be a regular file');
      const probe = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const version = numberField(probe.prepare('PRAGMA user_version').get(), 'user_version');
        if (version < 1 || version > STORE_SCHEMA_VERSION)
          fail('unsupported_version', `Unsupported project schema ${version}`);
      } finally {
        probe.close();
      }
    }
    const db = new DatabaseSync(databasePath, { timeout: 1000 });
    try {
      db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA foreign_keys=ON; BEGIN EXCLUSIVE;');
      const version = numberField(db.prepare('PRAGMA user_version').get(), 'user_version');
      if (mode === 'resume' && (version < 1 || version > STORE_SCHEMA_VERSION)) {
        db.exec('ROLLBACK');
        fail('unsupported_version', `Unsupported project schema ${version}`);
      }
      db.exec('COMMIT; PRAGMA journal_mode=WAL;');
      if (mode === 'create') {
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1), project_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0)) STRICT;
          CREATE TABLE images(image_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE) STRICT;
          CREATE TABLE image_imports(image_id TEXT NOT NULL REFERENCES images(image_id), slice_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(image_id,slice_id)) STRICT;
          CREATE TABLE loaded_images(image_id TEXT NOT NULL, slice_id TEXT NOT NULL, revision INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(image_id,slice_id,revision)) STRICT;
          ${IMAGE_METADATA_TABLE}
          CREATE TABLE records(kind TEXT NOT NULL, id TEXT NOT NULL, image_id TEXT NOT NULL REFERENCES images(image_id), revision INTEGER NOT NULL, text_value TEXT NOT NULL, address_space TEXT, address_value TEXT, payload BLOB NOT NULL, PRIMARY KEY(kind,id,revision)) STRICT;
          CREATE INDEX records_query ON records(image_id,kind,id,revision);
          CREATE INDEX records_scope_revision ON records(image_id,kind,revision DESC);
          CREATE INDEX loaded_images_revision ON loaded_images(image_id,revision DESC);
          CREATE TABLE indexes(image_id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(image_id,kind,revision)) STRICT;
          CREATE TABLE evidence(id TEXT NOT NULL, revision INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(id,revision)) STRICT;
          CREATE TABLE types(id TEXT NOT NULL, revision INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(id,revision)) STRICT;
          CREATE TABLE signatures(id TEXT NOT NULL, revision INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(id,revision)) STRICT;
          CREATE TABLE lineage(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload BLOB NOT NULL) STRICT;
          CREATE TABLE annotations(id TEXT NOT NULL, entity_id TEXT NOT NULL, revision INTEGER NOT NULL, payload BLOB, PRIMARY KEY(id,revision)) STRICT;
          CREATE INDEX annotations_entity ON annotations(entity_id,id,revision);
          CREATE TABLE annotation_removals(id TEXT NOT NULL, revision INTEGER NOT NULL, author TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('user','llm')), PRIMARY KEY(id,revision), FOREIGN KEY(id,revision) REFERENCES annotations(id,revision)) STRICT;
          CREATE TABLE jobs(id TEXT PRIMARY KEY, payload BLOB NOT NULL) STRICT;
          CREATE TABLE artifacts(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, job_id TEXT NOT NULL, cache_key TEXT NOT NULL UNIQUE, payload BLOB NOT NULL) STRICT;
          CREATE TABLE analysis_artifacts(revision INTEGER NOT NULL, analysis_id TEXT NOT NULL, artifact_id TEXT NOT NULL REFERENCES artifacts(id), PRIMARY KEY(revision,analysis_id,artifact_id)) STRICT;
          CREATE TABLE analysis_reuse(scope TEXT NOT NULL, revision INTEGER NOT NULL, artifact_id TEXT NOT NULL REFERENCES artifacts(id), PRIMARY KEY(scope,revision DESC,artifact_id)) STRICT;
          ${NATIVE_SUMMARIES_TABLE}
          PRAGMA user_version=${STORE_SCHEMA_VERSION};`);
        db.prepare('INSERT INTO metadata VALUES (1,?,0)').run(newIdentity('project'));
        db.exec('COMMIT');
      } else if (version < STORE_SCHEMA_VERSION) {
        db.exec('BEGIN IMMEDIATE');
        try {
          if (version === 1)
            db.exec(
              "CREATE TABLE annotation_removals(id TEXT NOT NULL, revision INTEGER NOT NULL, author TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('user','llm')), PRIMARY KEY(id,revision), FOREIGN KEY(id,revision) REFERENCES annotations(id,revision)) STRICT;",
            );
          if (version < 3)
            db.exec(
              'CREATE TABLE analysis_artifacts(revision INTEGER NOT NULL, analysis_id TEXT NOT NULL, artifact_id TEXT NOT NULL REFERENCES artifacts(id), PRIMARY KEY(revision,analysis_id,artifact_id)) STRICT;',
            );
          if (version < 4) {
            db.exec(IMAGE_METADATA_TABLE);
            const imageQuery = `SELECT image_id,slice_id,revision,CASE WHEN length(payload)<=${MAX_RECORD_BYTES} THEN payload ELSE NULL END AS payload FROM loaded_images`;
            const nextImage = db.prepare(
              `${imageQuery} WHERE (image_id,slice_id,revision)>(?,?,?) ORDER BY image_id,slice_id,revision LIMIT 1`,
            );
            let row = db.prepare(`${imageQuery} ORDER BY image_id,slice_id,revision LIMIT 1`).get();
            while (row) {
              const imageId = stringField(row, 'image_id'),
                sliceId = stringField(row, 'slice_id'),
                revision = numberField(row, 'revision');
              const metadata = decodeStored<ImageMetadata>(row['payload']);
              if (metadata.id !== imageId || metadata.selected_slice_id !== sliceId)
                fail('invalid_input', 'Stored image identity mismatch');
              writeImageMetadata(db, metadata, revision);
              row = nextImage.get(imageId, sliceId, revision);
            }
          }
          if (version < 5)
            db.exec(`CREATE INDEX records_scope_revision ON records(image_id,kind,revision DESC);
              CREATE INDEX loaded_images_revision ON loaded_images(image_id,revision DESC);
              CREATE TABLE analysis_reuse(scope TEXT NOT NULL, revision INTEGER NOT NULL, artifact_id TEXT NOT NULL REFERENCES artifacts(id), PRIMARY KEY(scope,revision DESC,artifact_id)) STRICT;`);
          if (version < 6) db.exec(NATIVE_SUMMARIES_TABLE);
          db.exec(`PRAGMA user_version=${STORE_SCHEMA_VERSION}; COMMIT;`);
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }
      directory(join(root, 'images'), mode === 'create');
      directory(join(root, 'artifacts'), mode === 'create');
      return new SqliteProjectStore(root, db, options.native_summary_bytes);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  #current(): number {
    if (this.#closed) fail('invalid_input', 'Project is closed');
    return numberField(
      this.#prepare('SELECT revision FROM metadata WHERE singleton=1').get(),
      'revision',
    );
  }

  #revision(revision: number): void {
    revisionSchema.parse(revision);
    if (revision > this.#current())
      fail('stale_revision', 'Requested project revision does not exist');
  }

  #latest(
    table: 'evidence' | 'types' | 'signatures' | 'annotations',
    id: string,
    revision: number,
  ): Row | undefined {
    this.#revision(revision);
    return this.#prepare(
      `SELECT * FROM ${table} WHERE id=? AND revision<=? ORDER BY revision DESC LIMIT 1`,
    ).get(id, revision);
  }

  #storagePath(kind: 'images' | 'artifacts', filename: string): string {
    directory(join(this.#path, kind), false);
    return join(this.#path, kind, filename);
  }

  snapshot(revision = this.#current()): ProjectSnapshot {
    this.#revision(revision);
    const images = this.#prepare(
      'SELECT i.image_id,i.sha256,s.slice_id FROM images i JOIN image_imports s USING(image_id) WHERE s.revision<=? ORDER BY i.image_id,s.slice_id',
    ).all(revision);
    return {
      project_id: this.project_id,
      revision,
      schema_version: STORE_SCHEMA_VERSION,
      images: images.map((row) => ({
        image_id: imageIdSchema.parse(row['image_id']),
        sha256: digestSchema.parse(row['sha256']),
        selected_slice_id: sliceIdSchema.parse(row['slice_id']),
      })),
    };
  }

  async importImage(input: {
    bytes: ImmutableBytes;
    sha256: string;
    selected_slice_id: string;
  }): Promise<{ image_id: string; existing: boolean }> {
    const revision = this.#current();
    if (this.#transaction) fail('invalid_input', 'Image import cannot nest in a transaction');
    digestSchema.parse(input.sha256);
    sliceIdSchema.parse(input.selected_slice_id);
    if (input.bytes.length > MAX_IMAGE_BYTES)
      fail('resource_limit', 'Imported image exceeds 512 MiB limit');
    if (hashImage(input.bytes) !== input.sha256)
      fail('invalid_input', 'Image content does not match its claimed hash');
    const image_id = imageIdentity(input.sha256);
    const prior = this.#prepare(
      'SELECT revision FROM image_imports WHERE image_id=? AND slice_id=?',
    ).get(image_id, input.selected_slice_id);
    const path = this.#storagePath('images', input.sha256);
    if (existsSync(path)) {
      if (contentHash(checkedFile(path, MAX_IMAGE_BYTES)) !== input.sha256)
        fail('invalid_input', 'Stored image integrity check failed');
    } else writeImmutable(path, input.bytes);
    if (prior) return { image_id, existing: true };
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#prepare('INSERT OR IGNORE INTO images VALUES (?,?)').run(image_id, input.sha256);
      this.#prepare('INSERT INTO image_imports VALUES (?,?,?)').run(
        image_id,
        input.selected_slice_id,
        nextRevision(revision),
      );
      this.#prepare('UPDATE metadata SET revision=? WHERE singleton=1').run(nextRevision(revision));
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return { image_id, existing: false };
  }

  #readImageBytes(imageId: string): Uint8Array {
    this.#current();
    imageIdSchema.parse(imageId);
    const row = this.#prepare('SELECT sha256 FROM images WHERE image_id=?').get(imageId);
    if (!row) fail('not_found', 'Image is not part of this project');
    const sha = digestSchema.parse(row['sha256']);
    const bytes = checkedFile(this.#storagePath('images', sha), MAX_IMAGE_BYTES);
    if (contentHash(bytes) !== sha) fail('invalid_input', 'Stored image integrity check failed');
    return bytes;
  }

  readImage(imageId: string): ImmutableBytes {
    return new ImmutableBytes(this.#readImageBytes(imageId));
  }

  readLoadedImage(imageId: string, sliceId: string, revision = this.#current()): LoadedImage {
    this.#revision(revision);
    imageIdSchema.parse(imageId);
    sliceIdSchema.parse(sliceId);
    const row = this.#prepare(
      `SELECT revision,CASE WHEN length(payload)<=${MAX_RECORD_BYTES} THEN payload ELSE NULL END AS payload
          FROM loaded_images WHERE image_id=? AND slice_id=? AND revision<=? ORDER BY revision DESC LIMIT 1`,
    ).get(imageId, sliceId, revision);
    if (!row) fail('not_found', 'Image has not been loaded for this slice');
    const metadataRevision = numberField(row, 'revision');
    const key = `${imageId}:${sliceId}:${metadataRevision}`;
    const cached = this.#loadedImages.get(key);
    if (cached) {
      // Retain the original full-file integrity check even on a warm metadata hit.
      // Do not trust timestamps or a cached digest of externally replaceable files.
      this.#readImageBytes(imageId);
      this.#loadedImages.delete(key);
      this.#loadedImages.set(key, cached);
      return cached.image;
    }
    const { metadata, byte_length } = readImageMetadata(
      this.#db,
      row['payload'],
      imageId,
      sliceId,
      metadataRevision,
    );
    const bytes = this.readImage(imageId);
    const slice = metadata.slices.find((item) => item.id === sliceId);
    if (!slice) fail('invalid_input', 'Stored image has no selected slice');
    const address_map = new AddressMap({
      image_id: imageId,
      image_base: metadata.image_base,
      byte_length: BigInt(bytes.length),
      slice_offset: slice.offset,
      slice_size: slice.size,
      mappings: metadata.mappings,
    });
    const image = { ...metadata, bytes, address_map };
    validateImage(image);
    freezeMetadata(metadata);
    Object.freeze(image);
    const retainedBytes = bytes.length + byte_length;
    if (retainedBytes <= MAX_LOADED_IMAGE_CACHE_BYTES) {
      while (
        this.#loadedImages.size >= MAX_LOADED_IMAGE_CACHE_ENTRIES ||
        this.#loadedImageBytes + retainedBytes > MAX_LOADED_IMAGE_CACHE_BYTES
      ) {
        const oldest = this.#loadedImages.keys().next().value!;
        this.#loadedImageBytes -= this.#loadedImages.get(oldest)!.byte_length;
        this.#loadedImages.delete(oldest);
      }
      this.#loadedImages.set(key, { image, byte_length: retainedBytes });
      this.#loadedImageBytes += retainedBytes;
    }
    return image;
  }

  /** Indexed change tokens cover positive and negative native-record/index/image reads. */
  readRecordScopeVersion(imageId: string, kind: RecordKind, revision: number): string {
    this.#revision(revision);
    imageIdSchema.parse(imageId);
    if (!Object.hasOwn(RECORD_SCHEMAS, kind)) fail('invalid_input', 'Unknown record kind');
    const record = this.#prepare(
      'SELECT revision FROM records WHERE image_id=? AND kind=? AND revision<=? ORDER BY revision DESC LIMIT 1',
    ).get(imageId, kind, revision);
    const index = this.#prepare(
      'SELECT revision,state FROM indexes WHERE image_id=? AND kind=? AND revision<=? ORDER BY revision DESC LIMIT 1',
    ).get(imageId, kind, revision);
    const image = this.#prepare(
      'SELECT revision FROM loaded_images WHERE image_id=? AND revision<=? ORDER BY revision DESC LIMIT 1',
    ).get(imageId, revision);
    return fingerprint([
      record ? numberField(record, 'revision') : null,
      index ? [numberField(index, 'revision'), stringField(index, 'state')] : null,
      image ? numberField(image, 'revision') : null,
    ]);
  }

  queryRecords<K extends RecordKind>(
    query: RecordQuery<K>,
  ): {
    items: readonly StoredRecordKinds[K][];
    next_cursor: string | null;
    index_state: 'complete' | 'partial' | 'not_started';
  } {
    this.#revision(query.revision);
    imageIdSchema.parse(query.image_id);
    if (
      !this.#prepare('SELECT 1 FROM image_imports WHERE image_id=? AND revision<=? LIMIT 1').get(
        query.image_id,
        query.revision,
      )
    )
      fail('not_found', 'Image is absent from the requested snapshot');
    if (query.address) addressSchema.parse(wireValue(query.address));
    if (
      !Object.hasOwn(RECORD_SCHEMAS, query.kind) ||
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 1000
    )
      fail('invalid_input', 'Invalid record query');
    if (query.ids && query.ids.length > 1000)
      fail('resource_limit', 'Too many requested identities');
    for (const id of query.ids ?? []) entityIdSchema.parse(id);
    if (query.address && query.address.image_id !== query.image_id)
      fail('invalid_address', 'Query address belongs to another image');
    const queryHash = fingerprint({
      image: query.image_id,
      kind: query.kind,
      ids: query.ids === undefined ? null : [...new Set(query.ids)].sort(),
      text: query.text ?? null,
      address: query.address ? { ...query.address } : null,
      limit: query.limit,
    });
    const binding = {
      project_id: this.project_id,
      revision: query.revision,
      operation: 'records',
      query_hash: queryHash,
    };
    const cursor = query.cursor ? decodeCursor(query.cursor, binding) : null;
    if (cursor && (cursor.after.length !== 1 || !entityIdSchema.safeParse(cursor.after[0]).success))
      fail('invalid_cursor', 'Record cursor has an invalid key');
    const after = cursor?.after[0] ?? '';
    const params: SQLInputValue[] = [
      query.image_id,
      query.kind,
      query.revision,
      query.revision,
      after,
    ];
    let sql =
      'SELECT r.* FROM records r WHERE r.image_id=? AND r.kind=? AND r.revision<=? AND r.revision=(SELECT MAX(v.revision) FROM records v WHERE v.kind=r.kind AND v.id=r.id AND v.revision<=?) AND r.id>?';
    if (query.ids) {
      if (query.ids.length === 0) sql += ' AND 0';
      else {
        sql += ` AND r.id IN (${query.ids.map(() => '?').join(',')})`;
        params.push(...query.ids);
      }
    }
    if (query.text !== undefined) {
      sql += ' AND instr(r.text_value,?)>0';
      params.push(query.text.toLowerCase());
    }
    if (query.address) {
      sql += ' AND r.address_space=? AND r.address_value=?';
      params.push(query.address.space, query.address.value.toString(16).padStart(16, '0'));
    }
    sql += ' ORDER BY r.id LIMIT ?';
    params.push(query.limit + 1);
    const rows = this.#prepare(sql).all(...params);
    const more = rows.length > query.limit;
    const page = more ? rows.slice(0, query.limit) : rows;
    const items = page.map((row) => {
      const value = decodeStored<StoredRecordKinds[K]>(row['payload']);
      RECORD_SCHEMAS[query.kind].parse(wireValue(value));
      return value;
    });
    const index = this.#prepare(
      'SELECT state FROM indexes WHERE image_id=? AND kind=? AND revision<=? ORDER BY revision DESC LIMIT 1',
    ).get(query.image_id, query.kind, query.revision);
    const index_state = index
      ? z.enum(['complete', 'partial', 'not_started']).parse(index['state'])
      : items.length > 0
        ? 'partial'
        : 'not_started';
    return {
      items,
      next_cursor: more
        ? encodeCursor({ ...binding, version: 1, after: [items.at(-1)!.id] })
        : null,
      index_state,
    };
  }

  transaction(
    expectedRevision: number,
    mutate: (transaction: StoreTransaction) => void,
  ): MutationResult {
    revisionSchema.parse(expectedRevision);
    const current = this.#current();
    if (current !== expectedRevision)
      return { state: 'conflict', expected_revision: expectedRevision, current_revision: current };
    if (this.#transaction) fail('invalid_input', 'Nested transactions are forbidden');
    const revision = nextRevision(current);
    const changed: Annotation[] = [],
      removed: string[] = [];
    let active = true;
    const guard = (): void => {
      if (!active) fail('invalid_input', 'Transaction has finished');
    };
    const putVersion = (
      table: 'evidence' | 'types' | 'signatures',
      id: string,
      value: unknown,
    ): void => {
      guard();
      this.#prepare(`INSERT OR REPLACE INTO ${table}(id,revision,payload) VALUES (?,?,?)`).run(
        id,
        revision,
        encodeStored(value),
      );
    };
    const tx: StoreTransaction = {
      putImage: (image) => {
        guard();
        validateImage(image);
        const imported = this.#prepare(
          'SELECT i.sha256 FROM images i JOIN image_imports s USING(image_id) WHERE i.image_id=? AND s.slice_id=?',
        ).get(image.id, image.selected_slice_id);
        if (
          !imported ||
          imported['sha256'] !== image.sha256 ||
          hashImage(image.bytes) !== image.sha256
        )
          fail('invalid_input', 'Loaded image must match an imported immutable snapshot');
        const { bytes: _bytes, address_map: _map, ...metadata } = image;
        writeImageMetadata(this.#db, metadata, revision);
      },
      putEvidence: (evidence) => {
        encodeEvidence(evidence);
        if (evidence.revision > revision)
          fail('stale_revision', 'Evidence is from a future revision');
        putVersion('evidence', evidence.id, evidence);
      },
      putType: (id, definition, evidenceIds) => {
        entityIdSchema.parse(id);
        encodeTypeDefinition(definition);
        evidenceIds.forEach((value) => evidenceIdSchema.parse(value));
        putVersion('types', id, { definition, evidence_ids: evidenceIds });
      },
      putSignature: (functionId, signature) => {
        entityIdSchema.parse(functionId);
        signatureSchema.parse(signature);
        putVersion('signatures', functionId, signature);
      },
      putLineage: (change) => {
        guard();
        lineageSchema.parse(change);
        if (change.revision !== revision)
          fail('stale_revision', 'Lineage must use the transaction revision');
        this.#prepare('INSERT INTO lineage VALUES (?,?,?)').run(
          fingerprint({ ...change }),
          revision,
          encodeStored(change),
        );
      },
      putRecord: (imageId, kind, record) => {
        guard();
        imageIdSchema.parse(imageId);
        if (!Object.hasOwn(RECORD_SCHEMAS, kind)) fail('invalid_input', 'Unknown record kind');
        RECORD_SCHEMAS[kind].parse(wireValue(record));
        const existing = this.#prepare(
          'SELECT image_id FROM records WHERE kind=? AND id=? LIMIT 1',
        ).get(kind, record.id);
        if (existing && existing['image_id'] !== imageId)
          fail('conflicting_evidence', 'Entity identity cannot move between images');
        const location = recordLocation(record);
        if (location && location.image_id !== imageId)
          fail('invalid_address', 'Record source address belongs to another image');
        const text =
          'text' in record
            ? record.text
            : 'original_name' in record
              ? `${record.original_name ?? ''}\n${record.display_name ?? ''}`
              : '';
        this.#prepare('INSERT OR REPLACE INTO records VALUES (?,?,?,?,?,?,?,?)').run(
          kind,
          record.id,
          imageId,
          revision,
          text.toLowerCase(),
          location?.space ?? null,
          location ? location.value.toString(16).padStart(16, '0') : null,
          encodeStored(record),
        );
        this.#prepare('INSERT OR IGNORE INTO indexes VALUES (?,?,?,?)').run(
          imageId,
          kind,
          revision,
          'partial',
        );
      },
      setIndexState: (imageId, kind, state) => {
        guard();
        imageIdSchema.parse(imageId);
        if (!Object.hasOwn(RECORD_SCHEMAS, kind)) fail('invalid_input', 'Unknown index kind');
        z.enum(['complete', 'partial', 'not_started']).parse(state);
        if (!this.#prepare('SELECT 1 FROM images WHERE image_id=?').get(imageId))
          fail('not_found', 'Index image is not imported');
        this.#prepare('INSERT OR REPLACE INTO indexes VALUES (?,?,?,?)').run(
          imageId,
          kind,
          revision,
          state,
        );
      },
      setAnnotation: (annotation) => {
        guard();
        encodeAnnotation(annotation);
        if (annotation.revision !== revision)
          fail('stale_revision', 'Annotation must use the transaction revision');
        const prior = this.#latest('annotations', annotation.id, current);
        if (prior && prior['entity_id'] !== annotation.entity_id)
          fail('conflicting_evidence', 'Annotation identity cannot move to another entity');
        this.#prepare('INSERT OR REPLACE INTO annotations VALUES (?,?,?,?)').run(
          annotation.id,
          annotation.entity_id,
          revision,
          encodeStored(annotation),
        );
        changed.push(annotation);
      },
      removeAnnotation: (id, actor) => {
        guard();
        annotationIdSchema.parse(id);
        annotationActorSchema.parse(actor);
        const prior = this.#latest('annotations', id, current);
        if (!prior || prior['payload'] === null) fail('not_found', 'Annotation does not exist');
        this.#prepare('INSERT OR REPLACE INTO annotations VALUES (?,?,?,NULL)').run(
          id,
          stringField(prior, 'entity_id'),
          revision,
        );
        this.#prepare('INSERT OR REPLACE INTO annotation_removals VALUES (?,?,?,?)').run(
          id,
          revision,
          actor.author,
          actor.origin,
        );
        removed.push(id);
      },
    };
    this.#db.exec('BEGIN IMMEDIATE');
    this.#transaction = true;
    try {
      if (mutate.constructor.name === 'AsyncFunction')
        fail('invalid_input', 'Transaction callbacks must be synchronous');
      const returned: unknown = mutate(tx);
      if (returned !== null && typeof returned === 'object' && 'then' in returned)
        fail('invalid_input', 'Transaction callbacks must be synchronous');
      this.#prepare('UPDATE metadata SET revision=? WHERE singleton=1').run(revision);
      this.#db.exec('COMMIT');
      return {
        state: 'committed',
        previous_revision: current,
        revision,
        annotations: changed,
        removed,
        invalidate_before_revision: revision,
      };
    } catch (error) {
      this.#db.exec('ROLLBACK');
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
    } finally {
      active = false;
      this.#transaction = false;
    }
  }

  applyAnnotations(batch: AnnotationBatch): MutationResult {
    const seen = new Set<string>();
    if (
      batch.edits.length < 1 ||
      batch.edits.length > 1000 ||
      !batch.author ||
      batch.author.length > 1024 ||
      !['user', 'llm'].includes(batch.origin)
    )
      fail('invalid_input', 'Invalid annotation batch');
    for (const edit of batch.edits) {
      encodeAnnotationEdit(edit);
      if (seen.has(edit.id)) fail('invalid_input', 'An annotation can occur only once in a batch');
      seen.add(edit.id);
    }
    return this.transaction(batch.expected_revision, (tx) => {
      const revision = nextRevision(batch.expected_revision);
      for (const edit of batch.edits) {
        if (edit.operation === 'set')
          tx.setAnnotation({
            id: edit.id,
            entity_id: edit.entity_id,
            value: edit.value,
            status: edit.status,
            evidence_ids: edit.evidence_ids,
            author: batch.author,
            origin: batch.origin,
            revision,
          });
        else if (edit.operation === 'remove')
          tx.removeAnnotation(edit.id, { author: batch.author, origin: batch.origin });
        else {
          const row = this.#latest('annotations', edit.id, batch.expected_revision);
          if (!row || row['payload'] === null) fail('not_found', 'Annotation does not exist');
          const prior = decodeStored<Annotation>(row['payload']);
          tx.setAnnotation({
            ...prior,
            status: 'retracted',
            author: batch.author,
            origin: batch.origin,
            revision,
          });
        }
      }
    });
  }

  /** Whether any annotation row exists at or below a readable revision. Readable
   * revisions are immutable (writes always create the next revision), so the
   * answer is memoized; analysis asks per subject, usually of an unannotated image. */
  #hasAnnotations(revision: number): boolean {
    let present = this.#annotatedRevisions.get(revision);
    if (present === undefined) {
      present =
        this.#prepare('SELECT 1 FROM annotations WHERE revision<=? LIMIT 1').get(revision) !==
        undefined;
      this.#annotatedRevisions.set(revision, present);
    }
    return present;
  }

  readAnnotations(entityId: string, revision: number): readonly Annotation[] {
    this.#revision(revision);
    entityIdSchema.parse(entityId);
    if (!this.#hasAnnotations(revision)) return [];
    const rows = this.#prepare(
      'SELECT a.payload FROM annotations a WHERE a.entity_id=? AND a.revision<=? AND a.revision=(SELECT MAX(v.revision) FROM annotations v WHERE v.id=a.id AND v.revision<=?) AND a.payload IS NOT NULL ORDER BY a.id LIMIT 10001',
    ).all(entityId, revision, revision);
    if (rows.length > 10000) fail('resource_limit', 'Too many annotations for one entity');
    return rows.map((row) => {
      const value = decodeStored<Annotation>(row['payload']);
      encodeAnnotation(value);
      return value;
    });
  }

  queryAnnotations(query: AnnotationQuery): {
    items: readonly Annotation[];
    next_cursor: string | null;
  } {
    this.#revision(query.revision);
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 1000)
      fail('invalid_input', 'Invalid annotation page limit');
    if ((query.ids?.length ?? 0) > 1000 || (query.entity_ids?.length ?? 0) > 1000)
      fail('resource_limit', 'Too many annotation query identities');
    for (const id of query.ids ?? []) annotationIdSchema.parse(id);
    for (const id of query.entity_ids ?? []) entityIdSchema.parse(id);
    const ids = query.ids === undefined ? null : [...new Set(query.ids)].sort(),
      entities = query.entity_ids === undefined ? null : [...new Set(query.entity_ids)].sort();
    const binding = {
      project_id: this.project_id,
      revision: query.revision,
      operation: 'annotations',
      query_hash: fingerprint([ids, entities, query.limit]),
    };
    const cursor = query.cursor ? decodeCursor(query.cursor, binding) : null;
    if (
      cursor &&
      (cursor.after.length !== 1 || !annotationIdSchema.safeParse(cursor.after[0]).success)
    )
      fail('invalid_cursor', 'Annotation cursor has an invalid key');
    const params: SQLInputValue[] = [query.revision, query.revision, cursor?.after[0] ?? ''];
    let sql =
      'SELECT a.payload FROM annotations a WHERE a.revision<=? AND a.revision=(SELECT MAX(v.revision) FROM annotations v WHERE v.id=a.id AND v.revision<=?) AND a.id>? AND a.payload IS NOT NULL';
    for (const [column, values] of [
      ['id', ids],
      ['entity_id', entities],
    ] as const)
      if (values !== null) {
        if (values.length === 0) sql += ' AND 0';
        else {
          sql += ` AND a.${column} IN (${values.map(() => '?').join(',')})`;
          params.push(...values);
        }
      }
    sql += ' ORDER BY a.id LIMIT ?';
    params.push(query.limit + 1);
    const rows = this.#prepare(sql).all(...params),
      more = rows.length > query.limit;
    const items = (more ? rows.slice(0, query.limit) : rows).map((row) => {
      const value = decodeStored<Annotation>(row['payload']);
      encodeAnnotation(value);
      return value;
    });
    return {
      items,
      next_cursor: more
        ? encodeCursor({ ...binding, version: 1, after: [items.at(-1)!.id] })
        : null,
    };
  }

  queryAnnotationHistory(query: AnnotationHistoryQuery): {
    items: readonly AnnotationHistoryEntry[];
    next_cursor: string | null;
  } {
    this.#revision(query.revision);
    annotationIdSchema.parse(query.id);
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 1000)
      fail('invalid_input', 'Invalid annotation history page limit');
    const binding = {
      project_id: this.project_id,
      revision: query.revision,
      operation: 'annotation_history',
      query_hash: fingerprint([query.id, query.limit]),
    };
    const cursor = query.cursor ? decodeCursor(query.cursor, binding) : null;
    const after = cursor ? Number(cursor.after[0]) : 0;
    if (
      cursor &&
      (cursor.after.length !== 1 ||
        !/^(0|[1-9][0-9]*)$/.test(cursor.after[0]!) ||
        !Number.isSafeInteger(after) ||
        after > query.revision)
    )
      fail('invalid_cursor', 'Annotation history cursor has an invalid revision');
    const rows = this.#prepare(
      'SELECT a.*, r.author AS removal_author, r.origin AS removal_origin FROM annotations a LEFT JOIN annotation_removals r ON a.id=r.id AND a.revision=r.revision WHERE a.id=? AND a.revision<=? AND a.revision>? ORDER BY a.revision LIMIT ?',
    ).all(query.id, query.revision, after, query.limit + 1);
    const more = rows.length > query.limit;
    const items: AnnotationHistoryEntry[] = (more ? rows.slice(0, query.limit) : rows).map(
      (row) => {
        const id = annotationIdSchema.parse(row['id']),
          entity_id = entityIdSchema.parse(row['entity_id']),
          revision = numberField(row, 'revision');
        if (row['payload'] === null) {
          const actor =
            row['removal_author'] === null
              ? null
              : annotationActorSchema.parse({
                  author: row['removal_author'],
                  origin: row['removal_origin'],
                });
          return { id, entity_id, revision, operation: 'remove', annotation: null, actor };
        }
        const annotation = decodeStored<Annotation>(row['payload']);
        encodeAnnotation(annotation);
        if (
          annotation.id !== id ||
          annotation.entity_id !== entity_id ||
          annotation.revision !== revision
        )
          fail('invalid_input', 'Persisted annotation history identity mismatch');
        return {
          id,
          entity_id,
          revision,
          operation: annotation.status === 'retracted' ? 'retract' : 'set',
          annotation,
          actor: { author: annotation.author, origin: annotation.origin },
        };
      },
    );
    return {
      items,
      next_cursor: more
        ? encodeCursor({ ...binding, version: 1, after: [String(items.at(-1)!.revision)] })
        : null,
    };
  }

  readEvidence(ids: readonly string[], revision: number): readonly Evidence[] {
    this.#revision(revision);
    if (ids.length > 1000) fail('resource_limit', 'Too many evidence identities');
    const values: Evidence[] = [];
    for (const id of new Set(ids)) {
      evidenceIdSchema.parse(id);
      const row = this.#latest('evidence', id, revision);
      if (row) {
        const value = decodeStored<Evidence>(row['payload']);
        encodeEvidence(value);
        values.push(value);
      }
    }
    return values;
  }

  readType(
    id: string,
    revision: number,
  ): { definition: RecoveredType; evidence_ids: readonly string[] } | null {
    entityIdSchema.parse(id);
    const row = this.#latest('types', id, revision);
    if (!row) return null;
    const value = decodeStored<{ definition: RecoveredType; evidence_ids: readonly string[] }>(
      row['payload'],
    );
    encodeTypeDefinition(value.definition);
    value.evidence_ids.forEach((item) => evidenceIdSchema.parse(item));
    return value;
  }

  readSignature(functionId: string, revision: number): Signature | null {
    entityIdSchema.parse(functionId);
    const row = this.#latest('signatures', functionId, revision);
    if (!row) return null;
    return signatureSchema.parse(decodeStored<Signature>(row['payload']));
  }

  readLineage(entityId: string, revision: number): readonly z.infer<typeof lineageSchema>[] {
    this.#revision(revision);
    entityIdSchema.parse(entityId);
    const rows = this.#prepare(
      'SELECT payload FROM lineage WHERE revision<=? ORDER BY revision,id LIMIT 10001',
    ).all(revision);
    if (rows.length > 10000) fail('resource_limit', 'Lineage query exceeds budget');
    return rows
      .map((row) => lineageSchema.parse(decodeStored(row['payload'])))
      .filter((value) => value.previous.includes(entityId) || value.next.includes(entityId));
  }

  findArtifact(identity: CacheIdentity): Artifact | null {
    if (
      identity.annotation_revision !== this.#current() ||
      identity.evidence_revision !== this.#current()
    )
      return null;
    const key = cacheIdentityKey(cacheIdentitySchema.parse(identity));
    const row = this.#prepare('SELECT payload FROM artifacts WHERE cache_key=?').get(key);
    if (!row) return null;
    const artifact = decodeStored<Artifact>(row['payload']);
    encodeArtifact(artifact);
    return artifact;
  }

  findHistoricalArtifact(identity: CacheIdentity): Artifact | null {
    this.#revision(identity.annotation_revision);
    if (identity.annotation_revision !== identity.evidence_revision)
      fail('invalid_input', 'Historical analysis revisions disagree');
    const key = cacheIdentityKey(cacheIdentitySchema.parse(identity));
    const row = this.#prepare('SELECT payload FROM artifacts WHERE cache_key=?').get(key);
    if (!row) return null;
    const artifact = decodeStored<Artifact>(row['payload']);
    encodeArtifact(artifact);
    if (
      artifact.project_id !== this.project_id ||
      artifact.revision !== identity.annotation_revision
    )
      fail('invalid_input', 'Historical analysis scope mismatch');
    return artifact;
  }

  findReuseCandidates(identity: CacheIdentity, limit: number): readonly Artifact[] {
    cacheIdentitySchema.parse(identity);
    this.#revision(identity.annotation_revision);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8)
      fail('invalid_input', 'Invalid analysis reuse candidate bound');
    const scope = cacheIdentityKey({ ...identity, annotation_revision: 0, evidence_revision: 0 });
    const rows = this.#prepare(
      'SELECT a.payload FROM analysis_reuse r JOIN artifacts a ON a.id=r.artifact_id WHERE r.scope=? AND r.revision<? ORDER BY r.revision DESC,r.artifact_id LIMIT ?',
    ).all(scope, identity.annotation_revision, limit);
    return rows.map((row) => {
      const artifact = decodeStored<Artifact>(row['payload']);
      encodeArtifact(artifact);
      if (
        artifact.project_id !== this.project_id ||
        artifact.revision >= identity.annotation_revision
      )
        fail('invalid_input', 'Analysis reuse index scope mismatch');
      return artifact;
    });
  }

  findAnalysisArtifacts(query: {
    readonly revision: number;
    readonly ids: readonly string[];
    readonly limit: number;
    readonly cursor?: string;
  }): { items: readonly Artifact[]; next_cursor: string | null } {
    this.#revision(query.revision);
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 1000)
      fail('invalid_input', 'Invalid analysis artifact page limit');
    if (query.ids.length > 1000) fail('resource_limit', 'Too many analysis query identities');
    const ids = [...new Set(query.ids)].sort();
    for (const id of ids) z.union([entityIdSchema, evidenceIdSchema]).parse(id);
    const binding = {
      project_id: this.project_id,
      revision: query.revision,
      operation: 'analysis_artifacts',
      query_hash: fingerprint([ids, query.limit]),
    };
    const cursor = query.cursor ? decodeCursor(query.cursor, binding) : null;
    if (
      cursor &&
      (cursor.after.length !== 1 || !artifactIdSchema.safeParse(cursor.after[0]).success)
    )
      fail('invalid_cursor', 'Analysis artifact cursor has an invalid key');
    if (ids.length === 0) return { items: [], next_cursor: null };
    // Bound index work per requested ID, rather than sorting every historical
    // option/version variant matching a large multi-ID catalog query.
    const lookup = this.#prepare(
      'SELECT artifact_id FROM analysis_artifacts WHERE revision=? AND analysis_id=? AND artifact_id>? ORDER BY artifact_id LIMIT ?',
    );
    let candidates: string[] = [];
    for (const id of ids) {
      const matches = lookup
        .all(query.revision, id, cursor?.after[0] ?? '', query.limit + 1)
        .map((row) => stringField(row, 'artifact_id'));
      const merged: string[] = [];
      let left = 0,
        right = 0;
      while (merged.length <= query.limit && (left < candidates.length || right < matches.length)) {
        const a = candidates[left],
          b = matches[right];
        if (a !== undefined && (b === undefined || a < b)) {
          merged.push(a);
          left++;
        } else if (b !== undefined && (a === undefined || b < a)) {
          merged.push(b);
          right++;
        } else {
          merged.push(a!);
          left++;
          right++;
        }
      }
      candidates = merged;
    }
    const more = candidates.length > query.limit;
    const artifactLookup = this.#prepare('SELECT payload FROM artifacts WHERE id=?');
    const items = candidates.slice(0, query.limit).map((id) => {
      const row = artifactLookup.get(id);
      if (!row) fail('invalid_input', 'Analysis index references an unpublished artifact');
      const artifact = decodeStored<Artifact>(row['payload']);
      encodeArtifact(artifact);
      if (
        artifact.id !== id ||
        artifact.project_id !== this.project_id ||
        artifact.revision !== query.revision
      )
        fail('invalid_input', 'Analysis artifact index scope mismatch');
      return artifact;
    });
    return {
      items,
      next_cursor: more
        ? encodeCursor({ ...binding, version: 1, after: [items.at(-1)!.id] })
        : null,
    };
  }

  async publishArtifact(input: {
    job_id: string;
    expected_revision: number;
    media_type: string;
    bytes: Uint8Array;
    cache: CacheIdentity;
    analysis_ids?: readonly string[];
    reuse_scope?: string;
  }): Promise<
    | { state: 'published'; artifact: Artifact }
    | { state: 'stale' | 'cancelled'; current_revision: number }
  > {
    const current = this.#current();
    revisionSchema.parse(input.expected_revision);
    if (this.#transaction)
      fail('invalid_input', 'Artifact publication cannot nest in a transaction');
    if (current !== input.expected_revision) return { state: 'stale', current_revision: current };
    const job = this.readJob(input.job_id);
    if (!job) fail('not_found', 'Artifact job does not exist');
    if (job.state === 'cancelled') return { state: 'cancelled', current_revision: current };
    if (job.input_revision !== current || job.state === 'stale')
      return { state: 'stale', current_revision: current };
    if (job.state !== 'queued' && job.state !== 'running')
      fail('invalid_input', 'Finished jobs cannot publish artifacts');
    if (input.bytes.length > MAX_ARTIFACT_BYTES)
      fail('resource_limit', 'Artifact exceeds 64 MiB limit');
    cacheIdentitySchema.parse(input.cache);
    if (input.cache.annotation_revision !== current || input.cache.evidence_revision !== current)
      fail('stale_revision', 'Artifact cache identity is stale');
    if ((input.analysis_ids?.length ?? 0) > 100000)
      fail('resource_limit', 'Too many analysis artifact identities');
    const analysisIds = [...new Set(input.analysis_ids ?? [])];
    for (const id of analysisIds) z.union([entityIdSchema, evidenceIdSchema]).parse(id);
    if (
      input.reuse_scope !== undefined &&
      input.reuse_scope !==
        cacheIdentityKey({ ...input.cache, annotation_revision: 0, evidence_revision: 0 })
    )
      fail('invalid_input', 'Analysis reuse index does not match its immutable scope');
    const artifact: Artifact = {
      id: newIdentity('artifact'),
      project_id: this.project_id,
      revision: current,
      media_type: input.media_type,
      size: BigInt(input.bytes.length),
      sha256: contentHash(input.bytes),
      schema_version: SCHEMA_VERSION,
    };
    encodeArtifact(artifact);
    const path = this.#storagePath('artifacts', artifact.id);
    writeImmutable(path, input.bytes);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#prepare('INSERT INTO artifacts VALUES (?,?,?,?,?)').run(
        artifact.id,
        current,
        job.id,
        cacheIdentityKey(input.cache),
        encodeStored(artifact),
      );
      const index = this.#prepare('INSERT INTO analysis_artifacts VALUES (?,?,?)');
      for (const id of analysisIds) index.run(current, id, artifact.id);
      if (input.reuse_scope !== undefined)
        this.#prepare('INSERT INTO analysis_reuse VALUES (?,?,?)').run(
          input.reuse_scope,
          current,
          artifact.id,
        );
      this.saveJob({
        ...job,
        state: 'completed',
        progress: { phase: 'complete', completed: 1, total: 1 },
        artifacts: [artifact],
        published_revision: current,
      });
      this.#writeNativeSummaries();
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      unlinkSync(path);
      throw error;
    }
    return { state: 'published', artifact };
  }

  publishTransientArtifact(input: { media_type: string; bytes: Uint8Array }): Artifact {
    const current = this.#current();
    if (input.bytes.length > MAX_ARTIFACT_BYTES)
      fail('resource_limit', 'Artifact exceeds 64 MiB limit');
    const artifact: Artifact = {
      id: newIdentity('artifact'),
      project_id: this.project_id,
      revision: current,
      media_type: input.media_type,
      size: BigInt(input.bytes.length),
      sha256: contentHash(input.bytes),
      schema_version: SCHEMA_VERSION,
    };
    encodeArtifact(artifact);
    this.#transientArtifacts.set(artifact.id, { artifact, bytes: input.bytes });
    this.#transientBytes += input.bytes.length;
    // Oldest first, never the artifact just published.
    for (const [id, old] of this.#transientArtifacts) {
      if (this.#transientBytes <= MAX_TRANSIENT_ARTIFACT_BYTES || id === artifact.id) break;
      this.#transientArtifacts.delete(id);
      this.#transientBytes -= old.bytes.length;
    }
    return artifact;
  }

  readArtifactBytes(input: Artifact): Uint8Array {
    this.#revision(input.revision);
    encodeArtifact(input);
    if (input.project_id !== this.project_id)
      fail('permission_denied', 'Artifact belongs to another project');
    const transient = this.#transientArtifacts.get(input.id);
    const row = transient
      ? undefined
      : this.#prepare('SELECT payload FROM artifacts WHERE id=?').get(input.id);
    if (!transient && !row) fail('not_found', 'Artifact does not exist');
    const artifact = transient?.artifact ?? decodeStored<Artifact>(row!['payload']);
    encodeArtifact(artifact);
    if (fingerprint(encodeArtifact(input)) !== fingerprint(encodeArtifact(artifact)))
      fail('invalid_input', 'Artifact handle does not match published metadata');
    if (transient) return transient.bytes;
    const bytes = checkedFile(
      this.#storagePath('artifacts', artifactIdSchema.parse(artifact.id)),
      MAX_ARTIFACT_BYTES,
    );
    if (BigInt(bytes.length) !== artifact.size || contentHash(bytes) !== artifact.sha256)
      fail('invalid_input', 'Artifact integrity check failed');
    return bytes;
  }

  async readArtifact(
    input: z.infer<typeof artifactReadArgsSchema>,
  ): Promise<z.infer<typeof artifactReadResultSchema>> {
    const args = artifactReadArgsSchema.parse(input);
    this.#revision(args.revision);
    if (args.project_id !== this.project_id)
      fail('permission_denied', 'Artifact belongs to another project');
    const transient = this.#transientArtifacts.get(args.artifact_id);
    const row = transient
      ? undefined
      : this.#prepare('SELECT payload FROM artifacts WHERE id=?').get(args.artifact_id);
    if (!transient && !row) fail('not_found', 'Artifact does not exist');
    const artifact = transient?.artifact ?? decodeStored<Artifact>(row!['payload']);
    encodeArtifact(artifact);
    if (artifact.revision !== args.revision)
      fail('stale_revision', 'Artifact belongs to another revision');
    const bytes = this.readArtifactBytes(artifact);
    const offset = BigInt(args.offset);
    if (offset > artifact.size) fail('invalid_address', 'Artifact offset exceeds its size');
    const end = Math.min(bytes.length, Number(offset) + args.length);
    return artifactReadResultSchema.parse({
      artifact: encodeArtifact(artifact),
      offset: args.offset,
      bytes_hex: Buffer.from(bytes.subarray(Number(offset), end)).toString('hex'),
      next_offset: end < bytes.length ? `0x${end.toString(16)}` : null,
    });
  }

  /** Inside an open transaction: write every queued summary of the current revision, drop those
   * of superseded revisions (never reusable: their scope names the revision) and evict
   * deterministically past the byte cap, oldest revision then oldest write first. Failure to
   * write leaves the enclosing transaction intact. */
  #writeNativeSummaries(): void {
    if (this.#pendingSummaries.size === 0) return;
    const current = this.#current();
    const rows = [...this.#pendingSummaries.values()].filter((row) => row.revision === current);
    this.#pendingSummaries.clear();
    this.#pendingSummaryBytes = 0;
    if (rows.length === 0) return;
    this.#db.exec('SAVEPOINT native_summaries');
    try {
      this.#prepare('DELETE FROM native_summaries WHERE revision<?').run(current);
      let seq = numberField(
        this.#prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM native_summaries').get(),
        'seq',
      );
      const insert = this.#prepare(
        'INSERT OR REPLACE INTO native_summaries(scope,function_id,revision,seq,allowance,work,bytes,digest,payload) VALUES (?,?,?,?,?,?,?,?,?)',
      );
      for (const row of rows)
        insert.run(
          row.scope,
          row.function_id,
          row.revision,
          ++seq,
          row.allowance,
          row.work,
          row.payload.length,
          row.digest,
          row.payload,
        );
      let total = numberField(
        this.#prepare('SELECT COALESCE(SUM(bytes),0) AS total FROM native_summaries').get(),
        'total',
      );
      if (total > this.#summaryCap) {
        const oldest = this.#prepare(
          'SELECT scope,function_id,bytes FROM native_summaries ORDER BY revision,seq LIMIT 64',
        );
        const drop = this.#prepare('DELETE FROM native_summaries WHERE scope=? AND function_id=?');
        while (total > this.#summaryCap) {
          const victims = oldest.all();
          if (victims.length === 0) break;
          for (const victim of victims) {
            if (total <= this.#summaryCap) break;
            drop.run(stringField(victim, 'scope'), stringField(victim, 'function_id'));
            total -= numberField(victim, 'bytes');
          }
        }
      }
      this.#db.exec('RELEASE native_summaries');
    } catch {
      this.#db.exec('ROLLBACK TO native_summaries; RELEASE native_summaries');
    }
  }

  readNativeSummary(scope: string, functionId: string): NativeSummaryRow | null {
    this.#current();
    const row = this.#prepare(
      'SELECT revision,allowance,work,digest,payload FROM native_summaries WHERE scope=? AND function_id=?',
    ).get(scope, functionId);
    if (!row) return null;
    try {
      const revision = numberField(row, 'revision'),
        payload = row['payload'];
      if (
        !(payload instanceof Uint8Array) ||
        summaryDigest(scope, functionId, revision, payload) !== row['digest']
      )
        return null;
      return {
        scope,
        function_id: functionId,
        revision,
        allowance: numberField(row, 'allowance'),
        work: numberField(row, 'work'),
        value: decodeStoredGraph(
          brotliDecompressSync(payload, { maxOutputLength: MAX_GRAPH_BYTES }),
        ),
      };
    } catch {
      // Undecodable content is a miss, never a served summary; the next preparation replaces it.
      return null;
    }
  }

  queueNativeSummary(row: NativeSummaryRow): boolean {
    const current = this.#current();
    if (
      row.scope.length < 1 ||
      row.scope.length > 256 ||
      row.revision !== current ||
      !Number.isSafeInteger(row.allowance) ||
      row.allowance < 0 ||
      !Number.isSafeInteger(row.work) ||
      row.work < 0
    )
      return false;
    entityIdSchema.parse(row.function_id);
    let payload: Uint8Array;
    try {
      const encoded = encodeStoredGraph(row.value);
      payload = brotliCompressSync(encoded, {
        params: {
          [zlib.BROTLI_PARAM_QUALITY]: 4,
          [zlib.BROTLI_PARAM_SIZE_HINT]: encoded.length,
        },
      });
    } catch {
      return false;
    }
    if (payload.length > Math.min(this.#summaryCap, MAX_NATIVE_SUMMARY_ROW_BYTES)) return false;
    const key = `${row.scope}\0${row.function_id}`;
    const prior = this.#pendingSummaries.get(key);
    if (prior) this.#pendingSummaryBytes -= prior.payload.length;
    this.#pendingSummaries.set(key, {
      scope: row.scope,
      function_id: row.function_id,
      revision: row.revision,
      allowance: row.allowance,
      work: row.work,
      digest: summaryDigest(row.scope, row.function_id, row.revision, payload),
      payload,
    });
    this.#pendingSummaryBytes += payload.length;
    if (this.#pendingSummaryBytes > MAX_PENDING_SUMMARY_BYTES) this.flushNativeSummaries();
    return true;
  }

  flushNativeSummaries(): void {
    if (this.#pendingSummaries.size === 0 || this.#db.isTransaction) return;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#writeNativeSummaries();
      this.#db.exec('COMMIT');
    } catch {
      this.#db.exec('ROLLBACK');
      this.#pendingSummaries.clear();
      this.#pendingSummaryBytes = 0;
    }
  }

  saveJob(job: Job): void {
    this.#current();
    encodeJob(job);
    if (job.project_id !== this.project_id || job.input_revision > this.#current())
      fail('invalid_input', 'Job belongs to another project or future revision');
    const prior = this.readJob(job.id);
    if (prior && (prior.input_revision !== job.input_revision || prior.operation !== job.operation))
      fail('conflicting_evidence', 'Job identity cannot change its input');
    if (
      prior &&
      ['completed', 'cancelled', 'failed', 'stale'].includes(prior.state) &&
      prior.state !== job.state
    )
      fail('invalid_input', 'Terminal job cannot restart');
    if (prior?.state === 'running' && job.state === 'queued')
      fail('invalid_input', 'Running job cannot return to queue');
    for (const artifact of job.artifacts) {
      // Cache-hit jobs may reuse publication from another job in this input snapshot.
      // encodeJob enforces project/revision scope; the published metadata must match.
      const row = this.#prepare('SELECT payload FROM artifacts WHERE id=?').get(artifact.id);
      if (
        !row ||
        fingerprint(encodeArtifact(decodeStored<Artifact>(row['payload']))) !==
          fingerprint(encodeArtifact(artifact))
      )
        fail('invalid_input', 'Job artifact has not been published');
    }
    this.#prepare('INSERT OR REPLACE INTO jobs VALUES (?,?)').run(job.id, encodeStored(job));
  }

  readJob(jobId: string): Job | null {
    this.#current();
    jobIdSchema.parse(jobId);
    const row = this.#prepare('SELECT payload FROM jobs WHERE id=?').get(jobId);
    if (!row) return null;
    const job = decodeStored<Job>(row['payload']);
    encodeJob(job);
    return job;
  }

  listJobs(query: { readonly limit: number; readonly cursor?: string }): {
    items: readonly Job[];
    next_cursor: string | null;
  } {
    const revision = this.#current();
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 1000)
      fail('invalid_input', 'Invalid job page limit');
    const binding = {
      project_id: this.project_id,
      revision,
      operation: 'jobs',
      query_hash: fingerprint({ limit: query.limit }),
    };
    const cursor = query.cursor ? decodeCursor(query.cursor, binding) : null;
    if (cursor && (cursor.after.length !== 1 || !jobIdSchema.safeParse(cursor.after[0]).success))
      fail('invalid_cursor', 'Job cursor has an invalid key');
    const rows = this.#prepare('SELECT payload FROM jobs WHERE id>? ORDER BY id LIMIT ?').all(
      cursor?.after[0] ?? '',
      query.limit + 1,
    );
    const more = rows.length > query.limit;
    const items = (more ? rows.slice(0, query.limit) : rows).map((row) => {
      const job = decodeStored<Job>(row['payload']);
      encodeJob(job);
      return job;
    });
    return {
      items,
      next_cursor: more
        ? encodeCursor({ ...binding, version: 1, after: [items.at(-1)!.id] })
        : null,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#transaction) fail('invalid_input', 'Cannot close a project inside a transaction');
    this.flushNativeSummaries();
    this.#db.close();
    this.#closed = true;
    this.#loadedImages.clear();
    this.#loadedImageBytes = 0;
    this.#transientArtifacts.clear();
    this.#transientBytes = 0;
  }
}

export const sqliteStoreFactory: StoreFactory = {
  async open(path, mode) {
    return SqliteProjectStore.open(path, mode);
  },
};
