import { createHash, hash, randomBytes } from 'node:crypto';
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
  let out = '';
  // One appended string instead of per-level map/join arrays; identical text.
  const write = (item: CanonicalValue): void => {
    if (item === null) {
      out += 'null';
      return;
    }
    switch (typeof item) {
      case 'bigint':
        out += `bigint:${item.toString(16)}`;
        return;
      case 'number':
        if (!Number.isSafeInteger(item))
          throw new TypeError('Identity numbers must be safe integers');
        out += `number:${item}`;
        return;
      case 'string':
        out += `string:${JSON.stringify(item)}`;
        return;
      case 'boolean':
        out += `boolean:${item}`;
        return;
    }
    if (Array.isArray(item)) {
      out += '[';
      for (let index = 0; index < item.length; index++) {
        if (index) out += ',';
        // Holes encode as empty elements, as Array#join does.
        if (index in item) write(item[index] as CanonicalValue);
      }
      out += ']';
      return;
    }
    const object = item as { readonly [key: string]: CanonicalValue };
    const keys = Object.keys(object).sort();
    out += '{';
    for (let index = 0; index < keys.length; index++) {
      if (index) out += ',';
      out += `${JSON.stringify(keys[index])}:`;
      write(object[keys[index]!]!);
    }
    out += '}';
  };
  write(value);
  return out;
}
export function fingerprint(value: CanonicalValue): string {
  return hash('sha256', canonicalIdentity(value), 'hex');
}
/** The encoding of `{version: 1, complete: true, reads}` is `LEDGER_HEAD`, the elements
 * joined by `,`, then `LEDGER_TAIL`. Both halves are cut out of the canonical encoding of an
 * empty ledger, so the layout stays whatever `canonicalIdentity` says it is. */
const EMPTY_LEDGER = canonicalIdentity({ version: 1, complete: true, reads: [] });
const LEDGER_HEAD = EMPTY_LEDGER.slice(0, EMPTY_LEDGER.indexOf('[]') + 1);
const LEDGER_TAIL = EMPTY_LEDGER.slice(LEDGER_HEAD.length);
/** Append-only hash of a complete readset ledger. `fingerprint()` equals
 * `fingerprint({version: 1, complete: true, reads})` for the elements appended so far
 * (each element in its own `canonicalIdentity`), but costs only the new elements: the
 * hash state over the canonical prefix is kept and copied to absorb the closing text. */
export class LedgerHasher {
  readonly #state = createHash('sha256').update(LEDGER_HEAD);
  #length = 0;
  /** Number of elements absorbed so far. */
  get length(): number {
    return this.#length;
  }

  append(element: CanonicalValue): void {
    this.#state.update(
      this.#length ? `,${canonicalIdentity(element)}` : canonicalIdentity(element),
    );
    this.#length++;
  }

  fingerprint(): string {
    return this.#state.copy().update(LEDGER_TAIL).digest('hex');
  }
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
/** The per-slice type library anchor: `type` annotations on it declare project-wide types. */
export function typeLibraryIdentity(sliceId: string): string {
  return entityIdentity(sliceId, 'type-library', []);
}
/** A user-declared C type of one slice's type library, keyed by its C name (or parser key). */
export function userTypeIdentity(sliceId: string, name: string): string {
  return entityIdentity(sliceId, 'user-type', [name]);
}
/** A member of a user-declared structure/union, keyed by its type and member name. */
export function userTypeFieldIdentity(sliceId: string, typeName: string, field: string): string {
  return entityIdentity(sliceId, 'user-type-field', [typeName, field]);
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
