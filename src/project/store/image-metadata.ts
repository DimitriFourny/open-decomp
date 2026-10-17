import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  OperationError,
  digestSchema,
  imageIdSchema,
  sliceIdSchema,
  targetSchema,
  type Diagnostic,
  type LoadedImage,
} from '../../core/index.js';
import { MAX_RECORD_BYTES, decodeStored, encodeStored } from './encoding.js';

export type ImageMetadata = Omit<LoadedImage, 'bytes' | 'address_map'>;
const COLLECTIONS = [
  'slices',
  'mappings',
  'headers',
  'sections',
  'entry_points',
  'symbols',
  'imports',
  'exports',
  'relocations',
  'hints',
  'evidence',
  'diagnostics',
  'capabilities',
] as const;
type Collection = (typeof COLLECTIONS)[number];
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_METADATA_RECORDS = 1_000_000;
const headerSchema = z.strictObject({
  id: imageIdSchema,
  sha256: digestSchema,
  selected_slice_id: sliceIdSchema,
  image_base: z.bigint().min(0n).max(0xffffffffffffffffn),
  target: targetSchema,
  collections: z.record(z.enum(COLLECTIONS), z.int().min(0).max(MAX_METADATA_RECORDS)),
});

export const IMAGE_METADATA_TABLE = `CREATE TABLE loaded_image_records(
  image_id TEXT NOT NULL, slice_id TEXT NOT NULL, revision INTEGER NOT NULL,
  collection TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0), payload BLOB NOT NULL,
  PRIMARY KEY(image_id,slice_id,revision,collection,ordinal),
  FOREIGN KEY(image_id,slice_id,revision) REFERENCES loaded_images(image_id,slice_id,revision) ON DELETE CASCADE
) STRICT;`;

function fail(code: Diagnostic['code'], message: string): never {
  throw new OperationError({ code, severity: 'error', message, evidence_ids: [] });
}

/** The caller owns the transaction; replacing a revision also replaces all its ordered facts. */
export function writeImageMetadata(
  db: DatabaseSync,
  metadata: ImageMetadata,
  revision: number,
): void {
  const collections = {} as Record<Collection, number>;
  let records = 0;
  for (const name of COLLECTIONS) {
    if (!Array.isArray(metadata[name])) fail('invalid_input', 'Invalid image metadata collection');
    collections[name] = metadata[name].length;
    records += metadata[name].length;
  }
  if (records > MAX_METADATA_RECORDS)
    fail('resource_limit', 'Image metadata exceeds aggregate record budget');
  const { id, sha256, selected_slice_id, image_base, target } = metadata;
  const header = encodeStored(
    headerSchema.parse({ id, sha256, selected_slice_id, image_base, target, collections }),
  );
  let bytes = header.length;
  db.prepare('INSERT OR REPLACE INTO loaded_images VALUES (?,?,?,?)').run(
    id,
    selected_slice_id,
    revision,
    header,
  );
  const insert = db.prepare('INSERT INTO loaded_image_records VALUES (?,?,?,?,?,?)');
  for (const name of COLLECTIONS) {
    for (let ordinal = 0; ordinal < metadata[name].length; ordinal++) {
      const payload = encodeStored(metadata[name][ordinal]);
      bytes += payload.length;
      if (bytes > MAX_METADATA_BYTES)
        fail('resource_limit', 'Image metadata exceeds aggregate byte budget');
      insert.run(id, selected_slice_id, revision, name, ordinal, payload);
    }
  }
}

export function readImageMetadata(
  db: DatabaseSync,
  payload: unknown,
  imageId: string,
  sliceId: string,
  revision: number,
): ImageMetadata {
  const { collections: counts, ...metadata } = headerSchema.parse(decodeStored(payload));
  if (metadata.id !== imageId || metadata.selected_slice_id !== sliceId)
    fail('invalid_input', 'Stored image identity mismatch');
  const records = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (records > MAX_METADATA_RECORDS)
    fail('resource_limit', 'Image metadata exceeds aggregate record budget');
  const collections = {} as Record<Collection, unknown[]>;
  for (const name of COLLECTIONS) collections[name] = [];
  // Refuse oversized SQLite blobs before transferring them into the JS heap. The extra row detects unlisted facts.
  const rows = db
    .prepare(
      `SELECT collection,ordinal,CASE WHEN length(payload)<=${MAX_RECORD_BYTES} THEN payload ELSE NULL END AS payload
    FROM loaded_image_records WHERE image_id=? AND slice_id=? AND revision=? ORDER BY collection,ordinal LIMIT ?`,
    )
    .iterate(imageId, sliceId, revision, records + 1);
  let bytes = (payload as Uint8Array).length;
  for (const row of rows) {
    if (typeof row['collection'] !== 'string' || !Object.hasOwn(collections, row['collection']))
      fail('invalid_input', 'Invalid stored image collection');
    const name = row['collection'] as Collection,
      items = collections[name];
    if (row['ordinal'] !== items.length || items.length >= counts[name])
      fail('invalid_input', 'Stored image collection order or count mismatch');
    const value = row['payload'];
    if (!(value instanceof Uint8Array))
      fail('invalid_input', 'Invalid or oversized image metadata record');
    bytes += value.length;
    if (bytes > MAX_METADATA_BYTES)
      fail('resource_limit', 'Image metadata exceeds aggregate byte budget');
    items.push(decodeStored(value));
  }
  for (const name of COLLECTIONS)
    if (collections[name].length !== counts[name])
      fail('invalid_input', 'Stored image collection is incomplete');
  // Domain records are validated together with the immutable bytes/address map by readLoadedImage.
  return { ...metadata, ...collections } as ImageMetadata;
}
