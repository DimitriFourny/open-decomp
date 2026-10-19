import { OperationError } from '../../core/index.js';

export const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_NODES = 1_000_000;

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
