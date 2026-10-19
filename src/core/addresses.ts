import { z } from 'zod';
import { addressSchema, rangeSchema, type WireAddress, type HexU64 } from './primitives.js';
import { addressCodec, machineAddressSchema, machineRangeSchema, rangeCodec } from './codecs.js';
import { formatHexU64, parseHexU64 } from './integers.js';

export const U64_LIMIT = 1n << 64n;
export interface Address {
  readonly image_id: string;
  readonly space: 'va' | 'rva' | 'file';
  readonly value: bigint;
}
export interface AddressRange {
  readonly start: Address;
  readonly size: bigint;
}
/** File offsets always address the immutable container, not the selected slice. */
export interface ImageMapping {
  readonly id: string;
  readonly va: bigint;
  readonly memory_size: bigint;
  readonly file_offset: bigint;
  readonly file_size: bigint;
  readonly permissions: readonly ('read' | 'write' | 'execute')[];
}
export interface MappingContext {
  readonly image_id: string;
  readonly image_base: bigint;
  readonly byte_length: bigint;
  readonly slice_offset: bigint;
  readonly slice_size: bigint;
  readonly mappings: readonly ImageMapping[];
}
export type Translation =
  | { readonly kind: 'mapped'; readonly address: Address; readonly mapping_id: string | null }
  | { readonly kind: 'zero_fill'; readonly address: Address; readonly mapping_id: string }
  | { readonly kind: 'unmapped'; readonly address: Address };
export interface TranslationSpan {
  readonly kind: 'mapped' | 'zero_fill' | 'unmapped';
  readonly range: AddressRange;
  readonly file_offset: bigint | null;
  readonly mapping_id: string | null;
}

export function decodeAddress(wire: WireAddress): Address {
  return z.decode(addressCodec, wire);
}
/** Same validation and wire value as `z.encode(addressCodec, …)`, without re-running
 * the codec's nested parses (evidence/metadata validation encodes every range). */
export function encodeAddress(address: Address): WireAddress {
  const valid = machineAddressSchema.parse(address);
  return addressSchema.parse({ ...valid, value: formatHexU64(valid.value) });
}
export function decodeRange(wire: {
  readonly start: WireAddress;
  readonly size: string;
}): AddressRange {
  return z.decode(rangeCodec, rangeSchema.parse(wire));
}
export function encodeRange(range: AddressRange): { start: WireAddress; size: HexU64 } {
  const valid = machineRangeSchema.parse(range);
  return rangeSchema.parse({
    start: { ...valid.start, value: formatHexU64(valid.start.value) },
    size: formatHexU64(valid.size),
  });
}
export function decodeSigned(wire: {
  readonly negative: boolean;
  readonly magnitude: string;
}): bigint {
  const magnitude = parseHexU64(wire.magnitude);
  if (typeof wire.negative !== 'boolean' || (wire.negative && magnitude === 0n))
    throw new TypeError('Invalid signed magnitude');
  return wire.negative ? -magnitude : magnitude;
}
export function encodeSigned(value: bigint): { negative: boolean; magnitude: string } {
  return { negative: value < 0n, magnitude: formatHexU64(value < 0n ? -value : value) };
}
export function checkedU64(value: bigint): bigint {
  if (typeof value !== 'bigint' || value < 0n || value >= U64_LIMIT)
    throw new RangeError('Unsigned 64-bit value required');
  return value;
}
export function checkedEnd(start: bigint, size: bigint): bigint {
  checkedU64(start);
  if (typeof size !== 'bigint' || size < 0n || size >= U64_LIMIT || start + size > U64_LIMIT)
    throw new RangeError('Range overflows 64-bit space');
  return start + size;
}
export function checkedIndex(value: bigint, length: number): number {
  if (
    typeof value !== 'bigint' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    value < 0n ||
    value > BigInt(length)
  )
    throw new RangeError('Index outside bounded buffer');
  return Number(value);
}

/** No buffer or mutable typed-array view escapes; copies occur only on explicit reads. */
export class ImmutableBytes {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  constructor(bytes: Uint8Array) {
    this.#bytes = new Uint8Array(bytes);
    this.#view = new DataView(this.#bytes.buffer, this.#bytes.byteOffset, this.#bytes.byteLength);
  }

  get length(): number {
    return this.#bytes.length;
  }

  at(offset: number): number {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= this.length)
      throw new RangeError('Byte offset outside image');
    return this.#bytes[offset]!;
  }

  read(offset: bigint, length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('Invalid byte count');
    const start = checkedIndex(offset, this.length);
    checkedIndex(offset + BigInt(length), this.length);
    return this.#bytes.slice(start, start + length);
  }

  u32(offset: bigint, littleEndian = true): number {
    const start = checkedIndex(offset, this.length);
    checkedIndex(offset + 4n, this.length);
    return this.#view.getUint32(start, littleEndian);
  }

  u64(offset: bigint, littleEndian = true): bigint {
    const start = checkedIndex(offset, this.length);
    checkedIndex(offset + 8n, this.length);
    return this.#view.getBigUint64(start, littleEndian);
  }
}

/** Validate once at loader construction; ambiguous aliases are never selected by array order. */
export class AddressMap {
  readonly #context: MappingContext;
  constructor(context: MappingContext) {
    checkedU64(context.image_base);
    checkedU64(context.byte_length);
    const sliceEnd = checkedEnd(context.slice_offset, context.slice_size);
    if (sliceEnd > context.byte_length) throw new RangeError('Slice exceeds container');
    const ids = new Set<string>();
    for (const mapping of context.mappings) {
      if (ids.has(mapping.id)) throw new RangeError('Duplicate mapping identity');
      ids.add(mapping.id);
      checkedEnd(mapping.va, mapping.memory_size);
      const fileEnd = checkedEnd(mapping.file_offset, mapping.file_size);
      if (
        mapping.file_size > mapping.memory_size ||
        mapping.file_offset < context.slice_offset ||
        fileEnd > sliceEnd
      )
        throw new RangeError('Invalid mapping backing range');
    }
    for (const space of ['va', 'file'] as const) {
      const ranges = context.mappings
        .map((mapping) => ({
          start: space === 'va' ? mapping.va : mapping.file_offset,
          size: space === 'va' ? mapping.memory_size : mapping.file_size,
        }))
        .filter((range) => range.size > 0n)
        .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
      for (let i = 1; i < ranges.length; i++) {
        if (ranges[i]!.start < ranges[i - 1]!.start + ranges[i - 1]!.size)
          throw new RangeError(`Overlapping ${space} mappings`);
      }
    }
    this.#context = Object.freeze({
      ...context,
      mappings: Object.freeze(
        context.mappings.map((mapping) =>
          Object.freeze({ ...mapping, permissions: Object.freeze([...mapping.permissions]) }),
        ),
      ),
    });
  }

  translate(source: Address, space: Address['space']): Translation {
    const context = this.#context;
    if (source.image_id !== context.image_id)
      throw new RangeError('Address belongs to another image');
    checkedU64(source.value);
    const address = (value: bigint): Address => ({
      image_id: source.image_id,
      space,
      value: checkedU64(value),
    });
    if (source.space === 'file') {
      if (
        source.value < context.slice_offset ||
        source.value >= context.slice_offset + context.slice_size
      )
        return { kind: 'unmapped', address: source };
      if (space === 'file')
        return { kind: 'mapped', address: address(source.value), mapping_id: null };
      const mapping = context.mappings.find(
        (item) =>
          source.value >= item.file_offset && source.value < item.file_offset + item.file_size,
      );
      if (!mapping) return { kind: 'unmapped', address: source };
      const va = mapping.va + source.value - mapping.file_offset;
      return {
        kind: 'mapped',
        address: address(space === 'va' ? va : va - context.image_base),
        mapping_id: mapping.id,
      };
    }
    const va =
      source.space === 'rva' ? checkedU64(context.image_base + source.value) : source.value;
    const mapping = context.mappings.find(
      (item) => va >= item.va && va < item.va + item.memory_size,
    );
    if (!mapping) return { kind: 'unmapped', address: source };
    const offset = va - mapping.va;
    if (offset >= mapping.file_size) {
      // A zero-filled VA has no file address; retain its memory coordinate.
      return {
        kind: 'zero_fill',
        address:
          space === 'file'
            ? { image_id: source.image_id, space: 'va', value: va }
            : address(space === 'va' ? va : va - context.image_base),
        mapping_id: mapping.id,
      };
    }
    return {
      kind: 'mapped',
      address: address(
        space === 'file'
          ? mapping.file_offset + offset
          : space === 'va'
            ? va
            : va - context.image_base,
      ),
      mapping_id: mapping.id,
    };
  }

  /** Partition a read without inventing backing bytes for holes or zero-fill. */
  spans(source: Address, size: bigint): readonly TranslationSpan[] {
    const context = this.#context;
    if (source.image_id !== context.image_id)
      throw new RangeError('Address belongs to another image');
    const end = checkedEnd(source.value, size);
    if (source.space === 'rva') checkedEnd(checkedU64(context.image_base + source.value), size);
    const result: TranslationSpan[] = [];
    let cursor = source.value;
    while (cursor < end) {
      const va = source.space === 'rva' ? context.image_base + cursor : cursor;
      let boundary = end;
      let kind: TranslationSpan['kind'] = 'unmapped';
      let fileOffset: bigint | null = null;
      let mappingId: string | null = null;
      if (source.space === 'file') {
        const sliceEnd = context.slice_offset + context.slice_size;
        if (cursor < context.slice_offset)
          boundary = context.slice_offset < end ? context.slice_offset : end;
        else if (cursor < sliceEnd) {
          boundary = sliceEnd < end ? sliceEnd : end;
          kind = 'mapped';
          fileOffset = cursor;
        }
      } else {
        for (const mapping of context.mappings) {
          if (va >= mapping.va && va < mapping.va + mapping.memory_size) {
            const offset = va - mapping.va;
            kind = offset < mapping.file_size ? 'mapped' : 'zero_fill';
            fileOffset = kind === 'mapped' ? mapping.file_offset + offset : null;
            mappingId = mapping.id;
            const remaining =
              (kind === 'mapped' ? mapping.file_size : mapping.memory_size) - offset;
            boundary = cursor + remaining < end ? cursor + remaining : end;
            break;
          }
          if (mapping.va > va && cursor + mapping.va - va < boundary)
            boundary = cursor + mapping.va - va;
        }
      }
      result.push({
        kind,
        range: { start: { ...source, value: cursor }, size: boundary - cursor },
        file_offset: fileOffset,
        mapping_id: mappingId,
      });
      cursor = boundary;
    }
    return result;
  }
}
