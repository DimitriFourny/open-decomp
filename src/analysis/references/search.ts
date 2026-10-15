import { OperationError, fingerprint, type CanonicalValue, type OperationContext } from '../../core/index.js';

/** Snapshot identity includes policy/content, not merely the project revision.
 * Cursors bind revision, index and filter; a continuation may follow a zero-match
 * bounded search. Page output is also capped by the operation byte budget; one
 * oversized record raises resource_limit rather than truncating its contents. */
export interface IndexPage<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
  readonly index_state: 'complete' | 'partial';
  readonly search_state: 'complete' | 'partial';
}
export interface IndexSearch {
  readonly limit?: number;
  readonly cursor?: string;
  /** Maximum examined records per request, including nonmatches. */
  readonly max_examined?: number;
}
export function searchIndex<T>(input: {
  readonly items: readonly T[]; readonly identity: string; readonly revision: number;
  readonly state: 'complete' | 'partial'; readonly query: CanonicalValue;
  readonly matches: (item: T) => boolean;
}, options: IndexSearch, context: OperationContext): IndexPage<T> {
  context.checkpoint(0);
  const limit = options.limit ?? 100;
  const max = options.max_examined ?? 100_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(max) || max < 1 || max > 1_000_000) throw new RangeError('Invalid index search bounds');
  const query = fingerprint(input.query);
  let offset = 0;
  if (options.cursor !== undefined) {
    try {
      if (options.cursor.length > 4096) throw new Error();
      const value: unknown = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
      if (!value || typeof value !== 'object' || !('revision' in value) || !('index' in value) || !('query' in value) || !('offset' in value)) throw new Error();
      if (value.revision !== input.revision) throw new OperationError({ code: 'stale_cursor', severity: 'error', message: 'Navigation cursor belongs to another revision', evidence_ids: [] });
      if (value.index !== input.identity || value.query !== query || typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > input.items.length) throw new Error();
      offset = value.offset;
    } catch (error) {
      if (error instanceof OperationError) throw error;
      throw new OperationError({ code: 'invalid_cursor', severity: 'error', message: 'Invalid navigation cursor or query mismatch', evidence_ids: [] });
    }
  }
  const items: T[] = [];
  let examined = 0;
  let outputBytes = 512; // bounded cursor/envelope reserve
  let outputLimited = false;
  while (offset < input.items.length && items.length < limit && examined < max) {
    context.checkpoint(1);
    const item = input.items[offset++]!;
    examined++;
    if (input.matches(item)) {
      const bytes = Buffer.byteLength(JSON.stringify(item, (_key, value: unknown) => typeof value === 'bigint' ? `0x${value.toString(16)}` : value));
      if (outputBytes + bytes > context.budget.output_bytes) {
        if (!items.length) throw new OperationError({ code: 'resource_limit', severity: 'error', message: 'One navigation record exceeds the output byte budget', evidence_ids: [] });
        offset--; outputLimited = true; break;
      }
      items.push(item);
      outputBytes += bytes;
    }
  }
  const remaining = offset < input.items.length;
  return { items, next_cursor: remaining ? Buffer.from(JSON.stringify({ revision: input.revision, index: input.identity, query, offset })).toString('base64url') : null,
    index_state: input.state, search_state: remaining && (examined >= max || outputLimited) ? 'partial' : 'complete' };
}
