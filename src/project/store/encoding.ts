import { OperationError } from '../../core/index.js';

export const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_NODES = 1_000_000;
/** Graph records (prepared callee summaries) are whole analysis results, far larger than
 * stored domain records; they stay bounded all the same. */
export const MAX_GRAPH_BYTES = 128 * 1024 * 1024;
const MAX_GRAPH_NODES = 12_000_000;

type Atom = null | boolean | string | number;
type Encoded = Atom | ['bigint', string] | ['array', Encoded[]] | ['object', [string, Encoded][]];

/** All containers are tagged: user notes/keys can never collide with a bigint marker. */
export function encodeStored(value: unknown): Uint8Array {
  let nodes = 0;
  function encode(item: unknown, depth: number): Encoded {
    if (++nodes > MAX_RECORD_NODES || depth > 128)
      throw new OperationError({
        code: 'resource_limit',
        severity: 'error',
        message: 'Stored record exceeds structural budget',
        evidence_ids: [],
      });
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'bigint') return ['bigint', item.toString(10)];
    if (Array.isArray(item)) return ['array', item.map((element) => encode(element, depth + 1))];
    if (typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      return [
        'object',
        Object.entries(item)
          .filter(([, element]) => element !== undefined)
          .map(([key, element]) => [key, encode(element, depth + 1)]),
      ];
    }
    throw new TypeError('Only finite plain domain values may be persisted');
  }
  const buffer = Buffer.from(JSON.stringify({ version: 1, value: encode(value, 0) }), 'utf8');
  if (buffer.length > MAX_RECORD_BYTES)
    throw new OperationError({
      code: 'resource_limit',
      severity: 'error',
      message: 'Stored record exceeds byte budget',
      evidence_ids: [],
    });
  return buffer;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

export function decodeStored<T>(bytes: unknown): T {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_RECORD_BYTES)
    throw new TypeError('Invalid stored record bytes');
  const envelope: unknown = JSON.parse(utf8.decode(bytes));
  if (
    envelope === null ||
    typeof envelope !== 'object' ||
    !('version' in envelope) ||
    envelope.version !== 1 ||
    !('value' in envelope)
  )
    throw new TypeError('Unsupported stored record encoding');
  let nodes = 0;
  function decode(item: unknown, depth: number): unknown {
    if (++nodes > MAX_RECORD_NODES || depth > 128)
      throw new RangeError('Stored record exceeds structural budget');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!Array.isArray(item) || item.length !== 2) throw new TypeError('Invalid stored value');
    const [kind, value] = item;
    if (
      kind === 'bigint' &&
      typeof value === 'string' &&
      /^-?(?:0|[1-9][0-9]{0,4095})$/.test(value)
    )
      return BigInt(value);
    if (kind === 'array' && Array.isArray(value))
      return value.map((element) => decode(element, depth + 1));
    if (kind === 'object' && Array.isArray(value)) {
      const result: Record<string, unknown> = {};
      for (const entry of value) {
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== 'string' ||
          Object.hasOwn(result, entry[0])
        )
          throw new TypeError('Invalid or duplicate stored property');
        const decoded = decode(entry[1], depth + 1);
        // Plain stores keep fast object shapes; only `__proto__` needs a defined property.
        if (entry[0] === '__proto__')
          Object.defineProperty(result, entry[0], {
            value: decoded,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        else result[entry[0]] = decoded;
      }
      return result;
    }
    throw new TypeError('Invalid stored value tag');
  }
  // Schema-specific validation remains the responsibility of the domain read boundary.
  return decode(envelope.value, 0) as T;
}

type GraphAtom = null | boolean | string | number;
type GraphEncoded =
  | GraphAtom
  | ['bigint', string]
  | ['array', GraphEncoded[]]
  | ['object', [string | number, GraphEncoded][]]
  | ['map', [GraphEncoded, GraphEncoded][]]
  | ['ref', number]
  | ['s', number];

function structuralBudget(): never {
  throw new OperationError({
    code: 'resource_limit',
    severity: 'error',
    message: 'Stored record exceeds structural budget',
    evidence_ids: [],
  });
}

/** Strings written more often than this are stored once in a table. Property names are
 * interned from the third use, long string values (identifiers, digests) from the second. */
const INTERNED_KEY_USES = 3;
const INTERNED_VALUE_USES = 2;
const INTERNED_VALUE_LENGTH = 16;

/** Same tagged encoding for plain domain values, extended with `Map`, with object
 * identity and with string interning: a container reachable twice is written once and
 * referenced, so shared substructure (copy-on-write analysis state, results that alias one
 * another) stays shared and is neither duplicated nor aliased wrongly after decoding, and a
 * long identifier used many times costs its bytes once. Finite numbers, strings, booleans,
 * null, bigints, arrays, plain objects and Maps only; anything else (class instances,
 * non-finite numbers, `undefined` array elements) throws. */
export function encodeStoredGraph(value: unknown): Uint8Array {
  const visits = new Map<object, number>();
  const keyUses = new Map<string, number>(),
    valueUses = new Map<string, number>();
  const pending: unknown[] = [value];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') {
      if (item.length >= INTERNED_VALUE_LENGTH) valueUses.set(item, (valueUses.get(item) ?? 0) + 1);
      continue;
    }
    if (item === null || typeof item !== 'object') continue;
    const seen = visits.get(item);
    visits.set(item, (seen ?? 0) + 1);
    if (seen !== undefined) continue;
    if (++nodes > MAX_GRAPH_NODES) structuralBudget();
    if (Array.isArray(item)) for (const element of item) pending.push(element);
    else if (item instanceof Map) for (const [key, element] of item) pending.push(key, element);
    else
      for (const [key, element] of Object.entries(item)) {
        keyUses.set(key, (keyUses.get(key) ?? 0) + 1);
        pending.push(element);
      }
  }
  const shared: GraphEncoded[] = [];
  const ids = new Map<object, number>();
  const strings: string[] = [],
    stringIds = new Map<string, number>();
  const intern = (text: string): number => {
    let id = stringIds.get(text);
    if (id === undefined) {
      id = strings.push(text) - 1;
      stringIds.set(text, id);
    }
    return id;
  };
  nodes = 0;
  function encode(item: unknown, depth: number): GraphEncoded {
    if (++nodes > MAX_GRAPH_NODES || depth > 128) structuralBudget();
    if (typeof item === 'string')
      return (valueUses.get(item) ?? 0) >= INTERNED_VALUE_USES ? ['s', intern(item)] : item;
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) return item;
    if (typeof item === 'bigint') return ['bigint', item.toString(10)];
    if (item === null || typeof item !== 'object')
      throw new TypeError('Only finite plain domain values may be persisted');
    const id = ids.get(item);
    if (id !== undefined) return ['ref', id];
    let body: GraphEncoded;
    if (Array.isArray(item)) body = ['array', item.map((element) => encode(element, depth + 1))];
    else if (item instanceof Map)
      body = [
        'map',
        [...item].map(([key, element]): [GraphEncoded, GraphEncoded] => [
          encode(key, depth + 1),
          encode(element, depth + 1),
        ]),
      ];
    else if (Object.getPrototypeOf(item) === Object.prototype)
      body = [
        'object',
        Object.entries(item)
          .filter(([, element]) => element !== undefined)
          .map(([key, element]): [string | number, GraphEncoded] => [
            (keyUses.get(key) ?? 0) >= INTERNED_KEY_USES ? intern(key) : key,
            encode(element, depth + 1),
          ]),
      ];
    else throw new TypeError('Only finite plain domain values may be persisted');
    if ((visits.get(item) ?? 0) < 2) return body;
    ids.set(item, shared.push(body) - 1);
    return ['ref', shared.length - 1];
  }
  const root = encode(value, 0);
  const buffer = Buffer.from(JSON.stringify({ version: 2, strings, shared, value: root }), 'utf8');
  if (buffer.length > MAX_GRAPH_BYTES) structuralBudget();
  return buffer;
}

export function decodeStoredGraph<T>(bytes: unknown): T {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_GRAPH_BYTES)
    throw new TypeError('Invalid stored record bytes');
  const envelope: unknown = JSON.parse(utf8.decode(bytes));
  if (
    envelope === null ||
    typeof envelope !== 'object' ||
    !('version' in envelope) ||
    envelope.version !== 2 ||
    !('value' in envelope) ||
    !('shared' in envelope) ||
    !Array.isArray(envelope.shared) ||
    !('strings' in envelope) ||
    !Array.isArray(envelope.strings) ||
    !envelope.strings.every((text: unknown) => typeof text === 'string')
  )
    throw new TypeError('Unsupported stored record encoding');
  const strings = envelope.strings as string[];
  let nodes = 0;
  const resolved: unknown[] = [];
  function decode(item: unknown, depth: number): unknown {
    if (++nodes > MAX_GRAPH_NODES || depth > 128)
      throw new RangeError('Stored record exceeds structural budget');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!Array.isArray(item) || item.length !== 2) throw new TypeError('Invalid stored value');
    const [kind, value] = item as [unknown, unknown];
    if (
      kind === 'bigint' &&
      typeof value === 'string' &&
      /^-?(?:0|[1-9][0-9]{0,4095})$/.test(value)
    )
      return BigInt(value);
    if (kind === 's' && Number.isSafeInteger(value) && (value as number) >= 0) {
      const text = strings[value as number];
      if (text === undefined) throw new TypeError('Invalid stored string reference');
      return text;
    }
    if (kind === 'ref' && Number.isSafeInteger(value) && (value as number) >= 0) {
      if ((value as number) >= resolved.length) throw new TypeError('Invalid stored reference');
      return resolved[value as number];
    }
    if (kind === 'array' && Array.isArray(value))
      return value.map((element) => decode(element, depth + 1));
    if (kind === 'map' && Array.isArray(value)) {
      const result = new Map<unknown, unknown>();
      for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError('Invalid map entry');
        const key = decode(entry[0], depth + 1);
        if (result.has(key)) throw new TypeError('Duplicate stored map key');
        result.set(key, decode(entry[1], depth + 1));
      }
      return result;
    }
    if (kind === 'object' && Array.isArray(value)) {
      const result: Record<string, unknown> = {};
      for (const entry of value) {
        const name = Array.isArray(entry)
          ? typeof entry[0] === 'number'
            ? strings[entry[0]]
            : entry[0]
          : undefined;
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof name !== 'string' ||
          Object.hasOwn(result, name)
        )
          throw new TypeError('Invalid or duplicate stored property');
        const decoded = decode(entry[1], depth + 1);
        if (name === '__proto__')
          Object.defineProperty(result, name, {
            value: decoded,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        else result[name] = decoded;
      }
      return result;
    }
    throw new TypeError('Invalid stored value tag');
  }
  for (const item of envelope.shared as unknown[]) resolved.push(decode(item, 0));
  return decode(envelope.value, 0) as T;
}

/** Validate internal domain records with their existing wire schemas, without changing text. */
export function wireValue(value: unknown, field = ''): unknown {
  if (typeof value === 'bigint') {
    if (field === 'addend')
      return { negative: value < 0n, magnitude: `0x${(value < 0n ? -value : value).toString(16)}` };
    if (value < 0n || value > 0xffffffffffffffffn)
      throw new RangeError('Stored machine value is outside uint64');
    return `0x${value.toString(16)}`;
  }
  if (Array.isArray(value)) return value.map((item) => wireValue(item));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, wireValue(item, key)]),
    );
  return value;
}
