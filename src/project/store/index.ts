import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  AddressMap, ImmutableBytes, OperationError, SCHEMA_VERSION, addressSchema, annotationIdSchema, artifactIdSchema,
  artifactReadArgsSchema, artifactReadResultSchema, cacheIdentityKey, cacheIdentitySchema,
  contentHash, decodeCursor, digestSchema, encodeAnnotation, encodeAnnotationEdit, encodeArtifact,
  encodeCursor, encodeDiagnostic, encodeEvidence, encodeJob, encodeTypeDefinition, entityIdSchema,
  evidenceIdSchema, exportSchema, fingerprint, functionSchema, headerSchema, imageIdSchema,
  imageIdentity, imageSummarySchema, importSchema, lineageSchema, mappingSchema, newIdentity,
  nextRevision, projectIdSchema, referenceSchema, relocationSchema, revisionSchema, sectionSchema,
  signatureSchema, sliceIdSchema, stringRecordSchema, symbolSchema, hintSchema,
  type Address, type Annotation, type AnnotationBatch, type Artifact, type CacheIdentity,
  type Diagnostic, type Evidence, type Job, type LoadedImage, type MutationResult, type ProjectSnapshot,
  type ProjectStore, type RecordQuery, type RecoveredType, type Signature, type StoreFactory,
  type StoredRecordKinds, type StoreTransaction,
} from '../../core/index.js';
import { decodeStored, encodeStored, wireValue } from './encoding.js';

const MAX_IMAGE_BYTES = 512 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const RECORD_SCHEMAS = { function: functionSchema, string: stringRecordSchema, reference: referenceSchema, symbol: symbolSchema, import: importSchema, export: exportSchema } as const;
type RecordKind = keyof StoredRecordKinds;
type ImageMetadata = Omit<LoadedImage, 'bytes' | 'address_map'>;
type Row = Record<string, unknown>;

function fail(code: Diagnostic['code'], message: string): never {
  throw new OperationError({ code, severity: 'error', message: message.slice(0, 8192), evidence_ids: [] });
}
function numberField(row: Row | undefined, field: string): number {
  const value = row?.[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('invalid_input', `Invalid persisted ${field}`);
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
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('permission_denied', 'Project storage directories must not be symlinks');
}
function checkedFile(path: string, maximum: number): Uint8Array {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) fail('invalid_input', 'Invalid or oversized project file');
  return readFileSync(path, { flag: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) });
}
function hashImage(bytes: ImmutableBytes): string {
  const hash = createHash('sha256');
  for (let offset = 0; offset < bytes.length; offset += 1_048_576) hash.update(bytes.read(BigInt(offset), Math.min(1_048_576, bytes.length - offset)));
  return hash.digest('hex');
}
function writeImmutable(path: string, bytes: ImmutableBytes | Uint8Array): void {
  const temporary = `${path}.${newIdentity('artifact')}.pending`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    const length = bytes.length;
    for (let offset = 0; offset < length; offset += 1_048_576) {
      const chunk = bytes instanceof ImmutableBytes ? bytes.read(BigInt(offset), Math.min(1_048_576, length - offset)) : bytes.subarray(offset, offset + 1_048_576);
      let written = 0;
      while (written < chunk.length) written += writeSync(fd, chunk, written, chunk.length - written);
    }
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(fd);
  try { renameSync(temporary, path); } catch (error) { unlinkSync(temporary); throw error; }
}
function recordLocation(record: StoredRecordKinds[RecordKind]): Address | null {
  if ('entry' in record) return record.entry;
  if ('address' in record) return record.address;
  if ('slot' in record) return record.slot ?? record.callable_entry;
  if ('from' in record) return record.from;
  return null;
}
function validateImage(image: LoadedImage): void {
  imageSummarySchema.parse(wireValue({ id: image.id, sha256: image.sha256, byte_length: BigInt(image.bytes.length), selected_slice_id: image.selected_slice_id, image_base: image.image_base, target: image.target, slices: image.slices, entry_points: image.entry_points, capabilities: image.capabilities }));
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

/** Owns one exclusive SQLite connection. OS releases the lock after a worker crash. */
export class SqliteProjectStore implements ProjectStore {
  readonly project_id: string;
  readonly #db: DatabaseSync;
  readonly #path: string;
  #closed = false;
  #transaction = false;

  private constructor(path: string, db: DatabaseSync) {
    this.#path = path;
    this.#db = db;
    this.project_id = projectIdSchema.parse(stringField(db.prepare('SELECT project_id FROM metadata WHERE singleton=1').get(), 'project_id'));
  }

  static open(path: string, mode: 'create' | 'resume'): SqliteProjectStore {
    const requested = resolve(path);
    directory(requested, mode === 'create');
    const root = realpathSync(requested);
    const databasePath = join(root, 'project.sqlite');
    if (mode === 'create') {
      if (existsSync(databasePath)) fail('invalid_input', 'Project already exists; resume it instead');
      const fd = openSync(databasePath, 'wx', 0o600);
      closeSync(fd);
    } else {
      if (!existsSync(databasePath)) fail('not_found', 'Project database does not exist');
      const stat = lstatSync(databasePath);
      if (!stat.isFile() || stat.isSymbolicLink()) fail('permission_denied', 'Project database must be a regular file');
      const probe = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const version = numberField(probe.prepare('PRAGMA user_version').get(), 'user_version');
        if (version !== SCHEMA_VERSION) fail('unsupported_version', `Unsupported project schema ${version}`);
      } finally { probe.close(); }
    }
    const db = new DatabaseSync(databasePath, { timeout: 1000 });
    try {
      db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; BEGIN EXCLUSIVE; COMMIT;');
      if (mode === 'create') {
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1), project_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0)) STRICT;
          CREATE TABLE images(image_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE) STRICT;
          CREATE TABLE image_imports(image_id TEXT NOT NULL REFERENCES images(image_id), slice_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(image_id,slice_id)) STRICT;
          CREATE TABLE loaded_images(image_id TEXT NOT NULL, slice_id TEXT NOT NULL, revision INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(image_id,slice_id,revision)) STRICT;
          CREATE TABLE records(kind TEXT NOT NULL, id TEXT NOT NULL, image_id TEXT NOT NULL REFERENCES images(image_id), revision INTEGER NOT NULL, text_value TEXT NOT NULL, address_space TEXT, address_value TEXT, payload BLOB NOT NULL, PRIMARY KEY(kind,id,revision)) STRICT;
          CREATE INDEX records_query ON records(image_id,kind,id,revision);
          CREATE TABLE indexes(image_id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(image_id,kind,revision)) STRICT;
          CREATE TABLE evidence(id TEXT NOT NULL, revision INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(id,revision)) STRICT;
          CREATE TABLE types(id TEXT NOT NULL, revision INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(id,revision)) STRICT;
          CREATE TABLE signatures(id TEXT NOT NULL, revision INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(id,revision)) STRICT;
          CREATE TABLE lineage(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload BLOB NOT NULL) STRICT;
          CREATE TABLE annotations(id TEXT NOT NULL, entity_id TEXT NOT NULL, revision INTEGER NOT NULL, payload BLOB, PRIMARY KEY(id,revision)) STRICT;
          CREATE INDEX annotations_entity ON annotations(entity_id,id,revision);
          CREATE TABLE jobs(id TEXT PRIMARY KEY, payload BLOB NOT NULL) STRICT;
          CREATE TABLE artifacts(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, job_id TEXT NOT NULL, cache_key TEXT NOT NULL UNIQUE, payload BLOB NOT NULL) STRICT;
          PRAGMA user_version=1;`);
        db.prepare('INSERT INTO metadata VALUES (1,?,0)').run(newIdentity('project'));
        db.exec('COMMIT');
      }
      directory(join(root, 'images'), mode === 'create');
      directory(join(root, 'artifacts'), mode === 'create');
      return new SqliteProjectStore(root, db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  #current(): number {
    if (this.#closed) fail('invalid_input', 'Project is closed');
    return numberField(this.#db.prepare('SELECT revision FROM metadata WHERE singleton=1').get(), 'revision');
  }
  #revision(revision: number): void {
    revisionSchema.parse(revision);
    if (revision > this.#current()) fail('stale_revision', 'Requested project revision does not exist');
  }
  #latest(table: 'evidence' | 'types' | 'signatures' | 'annotations', id: string, revision: number): Row | undefined {
    this.#revision(revision);
    return this.#db.prepare(`SELECT * FROM ${table} WHERE id=? AND revision<=? ORDER BY revision DESC LIMIT 1`).get(id, revision);
  }
  #storagePath(kind: 'images' | 'artifacts', filename: string): string {
    directory(join(this.#path, kind), false);
    return join(this.#path, kind, filename);
  }

  snapshot(revision = this.#current()): ProjectSnapshot {
    this.#revision(revision);
    const images = this.#db.prepare('SELECT i.image_id,i.sha256,s.slice_id FROM images i JOIN image_imports s USING(image_id) WHERE s.revision<=? ORDER BY i.image_id,s.slice_id').all(revision);
    return { project_id: this.project_id, revision, schema_version: SCHEMA_VERSION, images: images.map(row => ({ image_id: imageIdSchema.parse(row['image_id']), sha256: digestSchema.parse(row['sha256']), selected_slice_id: sliceIdSchema.parse(row['slice_id']) })) };
  }

  async importImage(input: { bytes: ImmutableBytes; sha256: string; selected_slice_id: string }): Promise<{ image_id: string; existing: boolean }> {
    const revision = this.#current();
    if (this.#transaction) fail('invalid_input', 'Image import cannot nest in a transaction');
    digestSchema.parse(input.sha256);
    sliceIdSchema.parse(input.selected_slice_id);
    if (input.bytes.length > MAX_IMAGE_BYTES) fail('resource_limit', 'Imported image exceeds 512 MiB limit');
    if (hashImage(input.bytes) !== input.sha256) fail('invalid_input', 'Image content does not match its claimed hash');
    const image_id = imageIdentity(input.sha256);
    const prior = this.#db.prepare('SELECT revision FROM image_imports WHERE image_id=? AND slice_id=?').get(image_id, input.selected_slice_id);
    const path = this.#storagePath('images', input.sha256);
    if (existsSync(path)) {
      if (contentHash(checkedFile(path, MAX_IMAGE_BYTES)) !== input.sha256) fail('invalid_input', 'Stored image integrity check failed');
    } else writeImmutable(path, input.bytes);
    if (prior) return { image_id, existing: true };
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('INSERT OR IGNORE INTO images VALUES (?,?)').run(image_id, input.sha256);
      this.#db.prepare('INSERT INTO image_imports VALUES (?,?,?)').run(image_id, input.selected_slice_id, nextRevision(revision));
      this.#db.prepare('UPDATE metadata SET revision=? WHERE singleton=1').run(nextRevision(revision));
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    return { image_id, existing: false };
  }

  readImage(imageId: string): ImmutableBytes {
    this.#current(); imageIdSchema.parse(imageId);
    const row = this.#db.prepare('SELECT sha256 FROM images WHERE image_id=?').get(imageId);
    if (!row) fail('not_found', 'Image is not part of this project');
    const sha = digestSchema.parse(row['sha256']);
    const bytes = checkedFile(this.#storagePath('images', sha), MAX_IMAGE_BYTES);
    if (contentHash(bytes) !== sha) fail('invalid_input', 'Stored image integrity check failed');
    return new ImmutableBytes(bytes);
  }

  readLoadedImage(imageId: string, sliceId: string): LoadedImage {
    this.#current(); imageIdSchema.parse(imageId); sliceIdSchema.parse(sliceId);
    const row = this.#db.prepare('SELECT payload FROM loaded_images WHERE image_id=? AND slice_id=? ORDER BY revision DESC LIMIT 1').get(imageId, sliceId);
    if (!row) fail('not_found', 'Image has not been loaded for this slice');
    const metadata = decodeStored<ImageMetadata>(row['payload']);
    if (metadata.id !== imageId || metadata.selected_slice_id !== sliceId) fail('invalid_input', 'Stored image identity mismatch');
    const bytes = this.readImage(imageId);
    const slice = metadata.slices.find(item => item.id === sliceId);
    if (!slice) fail('invalid_input', 'Stored image has no selected slice');
    const address_map = new AddressMap({ image_id: imageId, image_base: metadata.image_base, byte_length: BigInt(bytes.length), slice_offset: slice.offset, slice_size: slice.size, mappings: metadata.mappings });
    const image = { ...metadata, bytes, address_map };
    validateImage(image);
    return image;
  }

  queryRecords<K extends RecordKind>(query: RecordQuery<K>): { items: readonly StoredRecordKinds[K][]; next_cursor: string | null; index_state: 'complete' | 'partial' | 'not_started' } {
    this.#revision(query.revision); imageIdSchema.parse(query.image_id);
    if (!this.#db.prepare('SELECT 1 FROM image_imports WHERE image_id=? AND revision<=? LIMIT 1').get(query.image_id, query.revision)) fail('not_found', 'Image is absent from the requested snapshot');
    if (query.address) addressSchema.parse(wireValue(query.address));
    if (!Object.hasOwn(RECORD_SCHEMAS, query.kind) || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 1000) fail('invalid_input', 'Invalid record query');
    if (query.ids && query.ids.length > 1000) fail('resource_limit', 'Too many requested identities');
    for (const id of query.ids ?? []) entityIdSchema.parse(id);
    if (query.address && query.address.image_id !== query.image_id) fail('invalid_address', 'Query address belongs to another image');
    const queryHash = fingerprint({ image: query.image_id, kind: query.kind, ids: [...(query.ids ?? [])].sort(), text: query.text ?? null, address: query.address ? { ...query.address } : null, limit: query.limit });
    const binding = { project_id: this.project_id, revision: query.revision, operation: 'records', query_hash: queryHash };
    const cursor = query.cursor ? decodeCursor(query.cursor, binding) : null;
    if (cursor && (cursor.after.length !== 1 || !entityIdSchema.safeParse(cursor.after[0]).success)) fail('invalid_cursor', 'Record cursor has an invalid key');
    const after = cursor?.after[0] ?? '';
    const params: SQLInputValue[] = [query.image_id, query.kind, query.revision, query.revision, after];
    let sql = 'SELECT r.* FROM records r WHERE r.image_id=? AND r.kind=? AND r.revision<=? AND r.revision=(SELECT MAX(v.revision) FROM records v WHERE v.kind=r.kind AND v.id=r.id AND v.revision<=?) AND r.id>?';
    if (query.ids) {
      if (query.ids.length === 0) sql += ' AND 0';
      else { sql += ` AND r.id IN (${query.ids.map(() => '?').join(',')})`; params.push(...query.ids); }
    }
    if (query.text !== undefined) { sql += ' AND instr(r.text_value,?)>0'; params.push(query.text.toLowerCase()); }
    if (query.address) { sql += ' AND r.address_space=? AND r.address_value=?'; params.push(query.address.space, query.address.value.toString(16).padStart(16, '0')); }
    sql += ' ORDER BY r.id LIMIT ?'; params.push(query.limit + 1);
    const rows = this.#db.prepare(sql).all(...params);
    const more = rows.length > query.limit;
    const page = more ? rows.slice(0, query.limit) : rows;
    const items = page.map(row => {
      const value = decodeStored<StoredRecordKinds[K]>(row['payload']);
      RECORD_SCHEMAS[query.kind].parse(wireValue(value));
      return value;
    });
    const index = this.#db.prepare('SELECT state FROM indexes WHERE image_id=? AND kind=? AND revision<=? ORDER BY revision DESC LIMIT 1').get(query.image_id, query.kind, query.revision);
    const index_state = index ? z.enum(['complete', 'partial', 'not_started']).parse(index['state']) : items.length > 0 ? 'partial' : 'not_started';
    return { items, next_cursor: more ? encodeCursor({ ...binding, version: 1, after: [items.at(-1)!.id] }) : null, index_state };
  }

  transaction(expectedRevision: number, mutate: (transaction: StoreTransaction) => void): MutationResult {
    revisionSchema.parse(expectedRevision);
    const current = this.#current();
    if (current !== expectedRevision) return { state: 'conflict', expected_revision: expectedRevision, current_revision: current };
    if (this.#transaction) fail('invalid_input', 'Nested transactions are forbidden');
    const revision = nextRevision(current);
    const changed: Annotation[] = [], removed: string[] = [];
    let active = true;
    const guard = (): void => { if (!active) fail('invalid_input', 'Transaction has finished'); };
    const putVersion = (table: 'evidence' | 'types' | 'signatures', id: string, value: unknown): void => {
      guard(); this.#db.prepare(`INSERT OR REPLACE INTO ${table}(id,revision,payload) VALUES (?,?,?)`).run(id, revision, encodeStored(value));
    };
    const tx: StoreTransaction = {
      putImage: image => {
        guard(); validateImage(image);
        const imported = this.#db.prepare('SELECT i.sha256 FROM images i JOIN image_imports s USING(image_id) WHERE i.image_id=? AND s.slice_id=?').get(image.id, image.selected_slice_id);
        if (!imported || imported['sha256'] !== image.sha256 || hashImage(image.bytes) !== image.sha256) fail('invalid_input', 'Loaded image must match an imported immutable snapshot');
        const { bytes: _bytes, address_map: _map, ...metadata } = image;
        this.#db.prepare('INSERT OR REPLACE INTO loaded_images VALUES (?,?,?,?)').run(image.id, image.selected_slice_id, revision, encodeStored(metadata));
      },
      putEvidence: evidence => { encodeEvidence(evidence); if (evidence.revision > revision) fail('stale_revision', 'Evidence is from a future revision'); putVersion('evidence', evidence.id, evidence); },
      putType: (id, definition, evidenceIds) => { entityIdSchema.parse(id); encodeTypeDefinition(definition); evidenceIds.forEach(value => evidenceIdSchema.parse(value)); putVersion('types', id, { definition, evidence_ids: evidenceIds }); },
      putSignature: (functionId, signature) => { entityIdSchema.parse(functionId); signatureSchema.parse(signature); putVersion('signatures', functionId, signature); },
      putLineage: change => { guard(); lineageSchema.parse(change); if (change.revision !== revision) fail('stale_revision', 'Lineage must use the transaction revision'); this.#db.prepare('INSERT INTO lineage VALUES (?,?,?)').run(fingerprint({ ...change }), revision, encodeStored(change)); },
      putRecord: (imageId, kind, record) => {
        guard(); imageIdSchema.parse(imageId);
        if (!Object.hasOwn(RECORD_SCHEMAS, kind)) fail('invalid_input', 'Unknown record kind');
        RECORD_SCHEMAS[kind].parse(wireValue(record));
        const existing = this.#db.prepare('SELECT image_id FROM records WHERE kind=? AND id=? LIMIT 1').get(kind, record.id);
        if (existing && existing['image_id'] !== imageId) fail('conflicting_evidence', 'Entity identity cannot move between images');
        const location = recordLocation(record);
        if (location && location.image_id !== imageId) fail('invalid_address', 'Record source address belongs to another image');
        const text = 'text' in record ? record.text : 'original_name' in record ? `${record.original_name ?? ''}\n${record.display_name ?? ''}` : '';
        this.#db.prepare('INSERT OR REPLACE INTO records VALUES (?,?,?,?,?,?,?,?)').run(kind, record.id, imageId, revision, text.toLowerCase(), location?.space ?? null, location ? location.value.toString(16).padStart(16, '0') : null, encodeStored(record));
        this.#db.prepare('INSERT OR IGNORE INTO indexes VALUES (?,?,?,?)').run(imageId, kind, revision, 'partial');
      },
      setIndexState: (imageId, kind, state) => {
        guard(); imageIdSchema.parse(imageId); if (!Object.hasOwn(RECORD_SCHEMAS, kind)) fail('invalid_input', 'Unknown index kind'); z.enum(['complete', 'partial', 'not_started']).parse(state);
        if (!this.#db.prepare('SELECT 1 FROM images WHERE image_id=?').get(imageId)) fail('not_found', 'Index image is not imported');
        this.#db.prepare('INSERT OR REPLACE INTO indexes VALUES (?,?,?,?)').run(imageId, kind, revision, state);
      },
      setAnnotation: annotation => {
        guard(); encodeAnnotation(annotation);
        if (annotation.revision !== revision) fail('stale_revision', 'Annotation must use the transaction revision');
        const prior = this.#latest('annotations', annotation.id, current);
        if (prior && prior['entity_id'] !== annotation.entity_id) fail('conflicting_evidence', 'Annotation identity cannot move to another entity');
        this.#db.prepare('INSERT OR REPLACE INTO annotations VALUES (?,?,?,?)').run(annotation.id, annotation.entity_id, revision, encodeStored(annotation));
        changed.push(annotation);
      },
      removeAnnotation: id => {
        guard(); annotationIdSchema.parse(id);
        const prior = this.#latest('annotations', id, current);
        if (!prior || prior['payload'] === null) fail('not_found', 'Annotation does not exist');
        this.#db.prepare('INSERT OR REPLACE INTO annotations VALUES (?,?,?,NULL)').run(id, stringField(prior, 'entity_id'), revision);
        removed.push(id);
      },
    };
    this.#db.exec('BEGIN IMMEDIATE');
    this.#transaction = true;
    try {
      if (mutate.constructor.name === 'AsyncFunction') fail('invalid_input', 'Transaction callbacks must be synchronous');
      const returned: unknown = mutate(tx);
      if (returned !== null && typeof returned === 'object' && 'then' in returned) fail('invalid_input', 'Transaction callbacks must be synchronous');
      this.#db.prepare('UPDATE metadata SET revision=? WHERE singleton=1').run(revision);
      this.#db.exec('COMMIT');
      return { state: 'committed', previous_revision: current, revision, annotations: changed, removed, invalidate_before_revision: revision };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      return { state: 'rejected', diagnostics: [error instanceof OperationError ? error.diagnostic : { code: 'invalid_input', severity: 'error', message: (error instanceof Error ? error.message : String(error)).slice(0, 8192), evidence_ids: [] }] };
    } finally { active = false; this.#transaction = false; }
  }

  applyAnnotations(batch: AnnotationBatch): MutationResult {
    const seen = new Set<string>();
    if (batch.edits.length < 1 || batch.edits.length > 1000 || !batch.author || batch.author.length > 1024 || !['user', 'llm'].includes(batch.origin)) fail('invalid_input', 'Invalid annotation batch');
    for (const edit of batch.edits) { encodeAnnotationEdit(edit); if (seen.has(edit.id)) fail('invalid_input', 'An annotation can occur only once in a batch'); seen.add(edit.id); }
    return this.transaction(batch.expected_revision, tx => {
      const revision = nextRevision(batch.expected_revision);
      for (const edit of batch.edits) {
        if (edit.operation === 'set') tx.setAnnotation({ id: edit.id, entity_id: edit.entity_id, value: edit.value, status: edit.status, evidence_ids: edit.evidence_ids, author: batch.author, origin: batch.origin, revision });
        else if (edit.operation === 'remove') tx.removeAnnotation(edit.id);
        else {
          const row = this.#latest('annotations', edit.id, batch.expected_revision);
          if (!row || row['payload'] === null) fail('not_found', 'Annotation does not exist');
          const prior = decodeStored<Annotation>(row['payload']);
          tx.setAnnotation({ ...prior, status: 'retracted', author: batch.author, origin: batch.origin, revision });
        }
      }
    });
  }

  readAnnotations(entityId: string, revision: number): readonly Annotation[] {
    this.#revision(revision); entityIdSchema.parse(entityId);
    const rows = this.#db.prepare('SELECT a.payload FROM annotations a WHERE a.entity_id=? AND a.revision<=? AND a.revision=(SELECT MAX(v.revision) FROM annotations v WHERE v.id=a.id AND v.revision<=?) AND a.payload IS NOT NULL ORDER BY a.id LIMIT 10001').all(entityId, revision, revision);
    if (rows.length > 10000) fail('resource_limit', 'Too many annotations for one entity');
    return rows.map(row => { const value = decodeStored<Annotation>(row['payload']); encodeAnnotation(value); return value; });
  }
  readEvidence(ids: readonly string[], revision: number): readonly Evidence[] {
    this.#revision(revision);
    if (ids.length > 1000) fail('resource_limit', 'Too many evidence identities');
    const values: Evidence[] = [];
    for (const id of new Set(ids)) {
      evidenceIdSchema.parse(id); const row = this.#latest('evidence', id, revision);
      if (row) { const value = decodeStored<Evidence>(row['payload']); encodeEvidence(value); values.push(value); }
    }
    return values;
  }
  readType(id: string, revision: number): { definition: RecoveredType; evidence_ids: readonly string[] } | null {
    entityIdSchema.parse(id); const row = this.#latest('types', id, revision);
    if (!row) return null;
    const value = decodeStored<{ definition: RecoveredType; evidence_ids: readonly string[] }>(row['payload']);
    encodeTypeDefinition(value.definition); value.evidence_ids.forEach(item => evidenceIdSchema.parse(item));
    return value;
  }
  readSignature(functionId: string, revision: number): Signature | null {
    entityIdSchema.parse(functionId); const row = this.#latest('signatures', functionId, revision);
    if (!row) return null;
    return signatureSchema.parse(decodeStored<Signature>(row['payload']));
  }
  readLineage(entityId: string, revision: number): readonly z.infer<typeof lineageSchema>[] {
    this.#revision(revision); entityIdSchema.parse(entityId);
    const rows = this.#db.prepare('SELECT payload FROM lineage WHERE revision<=? ORDER BY revision,id LIMIT 10001').all(revision);
    if (rows.length > 10000) fail('resource_limit', 'Lineage query exceeds budget');
    return rows.map(row => lineageSchema.parse(decodeStored(row['payload']))).filter(value => value.previous.includes(entityId) || value.next.includes(entityId));
  }

  findArtifact(identity: CacheIdentity): Artifact | null {
    if (identity.annotation_revision !== this.#current() || identity.evidence_revision !== this.#current()) return null;
    const key = cacheIdentityKey(cacheIdentitySchema.parse(identity));
    const row = this.#db.prepare('SELECT payload FROM artifacts WHERE cache_key=?').get(key);
    if (!row) return null;
    const artifact = decodeStored<Artifact>(row['payload']); encodeArtifact(artifact);
    return artifact;
  }

  async publishArtifact(input: { job_id: string; expected_revision: number; media_type: string; bytes: Uint8Array; cache: CacheIdentity }): Promise<{ state: 'published'; artifact: Artifact } | { state: 'stale' | 'cancelled'; current_revision: number }> {
    const current = this.#current(); revisionSchema.parse(input.expected_revision);
    if (this.#transaction) fail('invalid_input', 'Artifact publication cannot nest in a transaction');
    if (current !== input.expected_revision) return { state: 'stale', current_revision: current };
    const job = this.readJob(input.job_id);
    if (!job) fail('not_found', 'Artifact job does not exist');
    if (job.state === 'cancelled') return { state: 'cancelled', current_revision: current };
    if (job.input_revision !== current || job.state === 'stale') return { state: 'stale', current_revision: current };
    if (job.state !== 'queued' && job.state !== 'running') fail('invalid_input', 'Finished jobs cannot publish artifacts');
    if (input.bytes.length > MAX_ARTIFACT_BYTES) fail('resource_limit', 'Artifact exceeds 64 MiB limit');
    cacheIdentitySchema.parse(input.cache);
    if (input.cache.annotation_revision !== current || input.cache.evidence_revision !== current) fail('stale_revision', 'Artifact cache identity is stale');
    const artifact: Artifact = { id: newIdentity('artifact'), project_id: this.project_id, revision: current, media_type: input.media_type, size: BigInt(input.bytes.length), sha256: contentHash(input.bytes), schema_version: SCHEMA_VERSION };
    encodeArtifact(artifact);
    const path = this.#storagePath('artifacts', artifact.id);
    writeImmutable(path, input.bytes);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?)').run(artifact.id, current, job.id, cacheIdentityKey(input.cache), encodeStored(artifact));
      this.saveJob({ ...job, state: 'completed', artifacts: [artifact], published_revision: current });
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); unlinkSync(path); throw error; }
    return { state: 'published', artifact };
  }

  async readArtifact(input: z.infer<typeof artifactReadArgsSchema>): Promise<z.infer<typeof artifactReadResultSchema>> {
    const args = artifactReadArgsSchema.parse(input); this.#revision(args.revision);
    if (args.project_id !== this.project_id) fail('permission_denied', 'Artifact belongs to another project');
    const row = this.#db.prepare('SELECT payload FROM artifacts WHERE id=?').get(args.artifact_id);
    if (!row) fail('not_found', 'Artifact does not exist');
    const artifact = decodeStored<Artifact>(row['payload']); encodeArtifact(artifact);
    if (artifact.revision !== args.revision) fail('stale_revision', 'Artifact belongs to another revision');
    const bytes = checkedFile(this.#storagePath('artifacts', artifactIdSchema.parse(artifact.id)), MAX_ARTIFACT_BYTES);
    if (BigInt(bytes.length) !== artifact.size || contentHash(bytes) !== artifact.sha256) fail('invalid_input', 'Artifact integrity check failed');
    const offset = BigInt(args.offset);
    if (offset > artifact.size) fail('invalid_address', 'Artifact offset exceeds its size');
    const end = Math.min(bytes.length, Number(offset) + args.length);
    return artifactReadResultSchema.parse({ artifact: encodeArtifact(artifact), offset: args.offset, bytes_hex: Buffer.from(bytes.subarray(Number(offset), end)).toString('hex'), next_offset: end < bytes.length ? `0x${end.toString(16)}` : null });
  }

  saveJob(job: Job): void {
    this.#current(); encodeJob(job);
    if (job.project_id !== this.project_id || job.input_revision > this.#current()) fail('invalid_input', 'Job belongs to another project or future revision');
    const prior = this.readJob(job.id);
    if (prior && (prior.input_revision !== job.input_revision || prior.operation !== job.operation)) fail('conflicting_evidence', 'Job identity cannot change its input');
    if (prior && ['completed', 'cancelled', 'failed', 'stale'].includes(prior.state) && prior.state !== job.state) fail('invalid_input', 'Terminal job cannot restart');
    if (prior?.state === 'running' && job.state === 'queued') fail('invalid_input', 'Running job cannot return to queue');
    for (const artifact of job.artifacts) {
      const row = this.#db.prepare('SELECT payload FROM artifacts WHERE id=? AND job_id=?').get(artifact.id, job.id);
      if (!row || fingerprint(encodeArtifact(decodeStored<Artifact>(row['payload']))) !== fingerprint(encodeArtifact(artifact))) fail('invalid_input', 'Job artifact has not been published');
    }
    this.#db.prepare('INSERT OR REPLACE INTO jobs VALUES (?,?)').run(job.id, encodeStored(job));
  }
  readJob(jobId: string): Job | null {
    this.#current();
    const row = this.#db.prepare('SELECT payload FROM jobs WHERE id=?').get(jobId);
    if (!row) return null;
    const job = decodeStored<Job>(row['payload']); encodeJob(job);
    return job;
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#transaction) fail('invalid_input', 'Cannot close a project inside a transaction');
    this.#db.close(); this.#closed = true;
  }
}

export const sqliteStoreFactory: StoreFactory = {
  async open(path, mode) { return SqliteProjectStore.open(path, mode); },
};
