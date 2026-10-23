import { deserialize, serialize } from 'node:v8';
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

function structuralBudget(): never {
  throw new OperationError({
    code: 'resource_limit',
    severity: 'error',
    message: 'Stored record exceeds structural budget',
    evidence_ids: [],
  });
}

const STORED_CLONE_VERSION = 3;

/** Visit every container of `value` once, depth first in a fixed order (array elements, Map
 * keys then values, own enumerable properties in insertion order), numbering them as first
 * reached. Both sides of a round trip see the same graph, so they see the same numbering.
 * Only arrays, Maps and plain objects may occur (a class instance, Set, Date, typed array
 * or function would not come back as itself). */
function visitContainers(value: unknown, visit: (container: object, index: number) => void): void {
  const seen = new Set<object>();
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'function' || typeof item === 'symbol')
      throw new TypeError('Only plain domain values may be persisted');
    if (item === null || typeof item !== 'object' || seen.has(item)) continue;
    if (seen.size >= MAX_GRAPH_NODES) structuralBudget();
    seen.add(item);
    visit(item, seen.size - 1);
    // Children are pushed in reverse so they are visited in their own order.
    if (Array.isArray(item)) for (let i = item.length - 1; i >= 0; i--) pending.push(item[i]);
    else if (item instanceof Map) {
      const entries = [...item];
      for (let i = entries.length - 1; i >= 0; i--) pending.push(entries[i]![1], entries[i]![0]);
    } else if (Object.getPrototypeOf(item) === Object.prototype) {
      const values = Object.values(item);
      for (let i = values.length - 1; i >= 0; i--) pending.push(values[i]);
    } else throw new TypeError('Only plain domain values may be persisted');
  }
}

/** An exact copy of a plain data graph (prepared callee summaries: whole analysis results).
 * The V8 value serializer keeps what analysis can observe of the value itself: Maps, bigints,
 * `undefined` fields, -0 and NaN, shared substructure and cycles; this envelope adds which
 * containers were frozen (IR verification memoizes frozen register descriptors, so frozenness
 * changes charged work). Decoding is a native deserialization plus one walk, far cheaper than
 * re-deriving the value. */
export function encodeStoredClone(value: unknown): Uint8Array {
  const frozen: number[] = [];
  visitContainers(value, (container, index) => {
    if (Object.isFrozen(container)) frozen.push(index);
  });
  const bytes = serialize({ version: STORED_CLONE_VERSION, frozen, value });
  if (bytes.length > MAX_GRAPH_BYTES) structuralBudget();
  return bytes;
}

export function decodeStoredClone<T>(bytes: unknown): T {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_GRAPH_BYTES)
    throw new TypeError('Invalid stored record bytes');
  const envelope: unknown = deserialize(bytes);
  if (
    envelope === null ||
    typeof envelope !== 'object' ||
    !('version' in envelope) ||
    envelope.version !== STORED_CLONE_VERSION ||
    !('value' in envelope) ||
    !('frozen' in envelope) ||
    !Array.isArray(envelope.frozen)
  )
    throw new TypeError('Unsupported stored record encoding');
  const frozen = envelope.frozen as unknown[];
  let next = 0;
  visitContainers(envelope.value, (container, index) => {
    if (frozen[next] !== index) return;
    Object.freeze(container);
    next++;
  });
  if (next !== frozen.length) throw new TypeError('Invalid stored frozen containers');
  return envelope.value as T;
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
