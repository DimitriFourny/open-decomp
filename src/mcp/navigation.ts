/** Lossless text projection of one navigation result for text-only MCP consumers.
 *
 * structuredContent stays the validated result. The text block is the same value with two
 * reversible rewrites that remove repetition and no facts:
 *   - a string of at least MIN_REF_LENGTH characters that occurs two or more times (IDs,
 *     image IDs) is stored once in `refs` and used as {"$ref": index};
 *   - an array of two or more objects with identical keys becomes
 *     {"$table": [keys], "rows": [[values], ...]}.
 * decodeNavigationText inverts the projection exactly. Results that already contain a `$ref`
 * or `$table` key, or that do not shrink, are delivered as the plain JSON result. */
export const NAVIGATION_TEXT_FORMAT = 'open-decomp/nav-text/1';
const MIN_REF_LENGTH = 24;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function isObject(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reserved(value: Json): boolean {
  if (Array.isArray(value)) return value.some(reserved);
  if (!isObject(value)) return false;
  return Object.entries(value).some(
    ([key, item]) => key === '$ref' || key === '$table' || reserved(item),
  );
}

function countStrings(value: Json, counts: Map<string, number>): void {
  if (typeof value === 'string') {
    if (value.length >= MIN_REF_LENGTH) counts.set(value, (counts.get(value) ?? 0) + 1);
  } else if (Array.isArray(value)) for (const item of value) countStrings(item, counts);
  else if (isObject(value)) for (const item of Object.values(value)) countStrings(item, counts);
}

/** The shared key list when every element is an object with exactly the same keys in order. */
function tableOf(items: readonly Json[]): { keys: string[]; rows: JsonObject[] } | undefined {
  const rows: JsonObject[] = [];
  for (const item of items) if (isObject(item)) rows.push(item);
  const first = rows[0];
  if (rows.length !== items.length || rows.length < 2 || !first) return undefined;
  const keys = Object.keys(first);
  if (keys.length < 2) return undefined;
  for (const row of rows) {
    const own = Object.keys(row);
    if (own.length !== keys.length || own.some((key, index) => key !== keys[index]))
      return undefined;
  }
  return { keys, rows };
}

/** Returns undefined when the compact projection would not be smaller than the plain JSON. */
export function navigationText(result: unknown): string | undefined {
  const plain = JSON.stringify(result);
  const value: Json = JSON.parse(plain);
  if (reserved(value)) return undefined;
  const counts = new Map<string, number>();
  countStrings(value, counts);
  const refs: string[] = [];
  const indexes = new Map<string, number>();
  const project = (item: Json): Json => {
    if (typeof item === 'string') {
      if ((counts.get(item) ?? 0) < 2) return item;
      let index = indexes.get(item);
      if (index === undefined) {
        index = refs.length;
        indexes.set(item, index);
        refs.push(item);
      }
      return { $ref: index };
    }
    if (Array.isArray(item)) {
      const table = tableOf(item);
      if (table)
        return {
          $table: table.keys,
          rows: table.rows.map((row) => table.keys.map((key) => project(row[key] ?? null))),
        };
      return item.map(project);
    }
    if (isObject(item))
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, project(entry)]));
    return item;
  };
  const projected = project(value);
  const text = JSON.stringify({ format: NAVIGATION_TEXT_FORMAT, refs, result: projected });
  return Buffer.byteLength(text) < Buffer.byteLength(plain) ? text : undefined;
}

/** Exact inverse of navigationText; plain JSON text decodes to itself. */
export function decodeNavigationText(text: string): unknown {
  const value: Json = JSON.parse(text);
  if (!isObject(value) || value['format'] !== NAVIGATION_TEXT_FORMAT) return value;
  const refs = value['refs'];
  if (!Array.isArray(refs)) throw new TypeError('Navigation text lacks its reference table');
  const restore = (item: Json): Json => {
    if (Array.isArray(item)) return item.map(restore);
    if (!isObject(item)) return item;
    const ref = item['$ref'];
    if (typeof ref === 'number') {
      const target = refs[ref];
      if (typeof target !== 'string') throw new TypeError('Navigation text reference is invalid');
      return target;
    }
    const keys = item['$table'],
      rows = item['rows'];
    if (Array.isArray(keys) && Array.isArray(rows))
      return rows.map((row) => {
        if (!Array.isArray(row)) throw new TypeError('Navigation text row is invalid');
        return Object.fromEntries(
          keys.map((key, index) => [String(key), restore(row[index] ?? null)]),
        );
      });
    return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, restore(entry)]));
  };
  const result = value['result'];
  if (result === undefined) throw new TypeError('Navigation text lacks its result');
  return restore(result);
}
