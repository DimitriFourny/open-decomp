import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  digestSchema,
  projectIdSchema,
  revisionSchema,
  imageIdSchema,
  sliceIdSchema,
  entityIdSchema,
} from './primitives.js';
import { formatHexU64 } from './integers.js';

export type CanonicalValue =
  | null
  | boolean
  | string
  | number
  | bigint
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };
/** Deterministic, type-tagged encoding: bigint 1 must not collide with the text "0x1". */
export function canonicalIdentity(value: CanonicalValue): string {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return `bigint:${value.toString(16)}`;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('Identity numbers must be safe integers');
    return `number:${value}`;
  }
  if (typeof value === 'string' || typeof value === 'boolean')
    return `${typeof value}:${JSON.stringify(value)}`;
  if (Array.isArray(value))
    return `[${value.map((item: CanonicalValue) => canonicalIdentity(item)).join(',')}]`;
  const object = value as { readonly [key: string]: CanonicalValue };
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalIdentity(object[key]!)}`)
    .join(',')}}`;
}
export function fingerprint(value: CanonicalValue): string {
  return createHash('sha256').update(canonicalIdentity(value)).digest('hex');
}
export function contentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function imageIdentity(sha256: string): string {
  return imageIdSchema.parse(`image_${digestSchema.parse(sha256)}`);
}
export function sliceIdentity(
  imageId: string,
  offset: bigint,
  size: bigint,
  architecture: string,
): string {
  imageIdSchema.parse(imageId);
  return sliceIdSchema.parse(
    `slice_${fingerprint([imageId, formatHexU64(offset), formatHexU64(size), architecture])}`,
  );
}
/** Birth discriminator is immutable. Splits/merges mint IDs and record lineage, never rename IDs. */
export function entityIdentity(sliceId: string, kind: string, birth: CanonicalValue): string {
  sliceIdSchema.parse(sliceId);
  return entityIdSchema.parse(`entity_${fingerprint([sliceId, kind, birth])}`);
}
export function newIdentity(
  kind: 'project' | 'job' | 'annotation' | 'evidence' | 'artifact',
): string {
  return `${kind}_${randomBytes(32).toString('hex')}`;
}

export const cursorSchema = z.strictObject({
  version: z.literal(1),
  project_id: projectIdSchema,
  revision: revisionSchema,
  operation: z.string().min(1).max(128),
  query_hash: digestSchema,
  // Deterministic composite sort key; every query must end with a unique stable ID.
  after: z.array(z.string().max(4096)).min(1).max(16),
});
export type Cursor = z.infer<typeof cursorSchema>;
export type CursorBinding = Pick<Cursor, 'project_id' | 'revision' | 'operation' | 'query_hash'>;
export class CursorError extends Error {
  readonly code: 'invalid_cursor' | 'stale_cursor';
  constructor(code: CursorError['code'], message: string) {
    super(message);
    this.name = 'CursorError';
    this.code = code;
  }
}
export function encodeCursor(cursor: Cursor): string {
  const token = Buffer.from(JSON.stringify(cursorSchema.parse(cursor)), 'utf8').toString(
    'base64url',
  );
  if (token.length > 16_384) throw new CursorError('invalid_cursor', 'Cursor exceeds limit');
  return token;
}
/** Cursors are query state, never authorization credentials; callers still authorize project access. */
export function decodeCursor(token: string, binding: CursorBinding): Cursor {
  let cursor: Cursor;
  try {
    if (token.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(token))
      throw new Error('Invalid encoding');
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.toString('base64url') !== token) throw new Error('Noncanonical encoding');
    cursor = cursorSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
  } catch {
    throw new CursorError('invalid_cursor', 'Malformed continuation cursor');
  }
  if (
    cursor.project_id !== binding.project_id ||
    cursor.revision !== binding.revision ||
    cursor.operation !== binding.operation ||
    cursor.query_hash !== binding.query_hash
  ) {
    throw new CursorError(
      'stale_cursor',
      'Cursor is bound to a different project, revision, operation, or query',
    );
  }
  return cursor;
}
