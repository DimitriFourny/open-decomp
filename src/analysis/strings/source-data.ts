import type { Address, LoadedImage, OperationContext, SymbolRecord } from '../../core/index.js';
import type { SourceAddress } from '../../reconstruction/source-model.js';

const contains = (start: Address, size: bigint, address: Address): boolean =>
  start.image_id === address.image_id && start.space === address.space &&
  address.value >= start.value && address.value < start.value + size;

/** Recover an address's own storage identity before considering printable bytes.
 * Bounds are not extended to a neighbouring symbol, pool, mapping or section.
 * Relocation slots describe storage, not the bytes of their eventual targets.
 */
export function recoverDataAddress(
  image: LoadedImage,
  address: Address,
  context: OperationContext,
  symbols: readonly SymbolRecord[] = image.symbols,
): SourceAddress | undefined {
  context.checkpoint(1);
  if (address.image_id !== image.id) return undefined;
  const translated = image.address_map.translate(address, 'va');
  if (translated.kind !== 'mapped' && translated.kind !== 'zero_fill') return undefined;
  const va = translated.address;
  const sections = image.sections.filter((section) => {
    context.checkpoint(1);
    return section.kind === 'section' && section.permissions.includes('read') &&
      contains(section.virtual_range.start, section.virtual_range.size, va) &&
      (image.target.format === 'macho' ? (section.flags & 0x80000400n) === 0n &&
        (section.flags & 255n) !== 8n : !section.permissions.includes('execute'));
  });
  if (sections.length !== 1) return undefined;
  const section = sections[0]!;
  const mutable = section.permissions.includes('write') || image.mappings.some((mapping) =>
    mapping.permissions.includes('write') && va.value >= mapping.va && va.value < mapping.va + mapping.memory_size);
  const objects = symbols.filter((symbol) => {
    context.checkpoint(1);
    return symbol.kind === 'object' && symbol.address &&
      (symbol.size === null || symbol.size === 0n ? symbol.address.value === va.value &&
        symbol.address.image_id === va.image_id && symbol.address.space === va.space
        : contains(symbol.address, symbol.size, va));
  });
  const hints = image.hints.filter((hint) => {
    context.checkpoint(1);
    if (hint.kind !== 'data' || !contains(hint.range.start, hint.range.size, va)) return false;
    // Section ownership is a bound, not one source-level array containing every
    // unrelated string/global in the section.
    return !(hint.encoding === 'bytes' && hint.range.start.value === section.virtual_range.start.value &&
      hint.range.size === section.virtual_range.size);
  });
  const hint = hints.length === 1 && hints[0]?.kind === 'data' ? hints[0] : undefined;
  const bases = new Set(objects.map((symbol) => symbol.address!.value));
  const sizes = new Set(objects.map((symbol) => symbol.size));
  const symbol = bases.size === 1 ? objects[0] : undefined;
  const conflicting = bases.size > 1 || sizes.size > 1 || hints.length > 1 ||
    (hint !== undefined && symbol?.address !== undefined && symbol.address !== null &&
      (hint.range.start.value !== symbol.address.value ||
        (symbol.size !== null && hint.range.size !== symbol.size)));
  const base = conflicting ? va : hint?.range.start ?? symbol?.address ?? va;
  const size = conflicting ? null : hint?.range.size ?? symbol?.size ?? null;
  const names = new Set(objects.flatMap((item) => item.display_name ?? item.original_name ?? []));
  const name = !conflicting && names.size === 1 ? [...names][0] : undefined;
  const kind = conflicting ? 'unknown' : hint?.encoding ?? 'bytes';
  const object = { address: base, byte_length: size, offset: va.value - base.value, mutable,
    kind, evidence_ids: [...new Set([...section.evidence_ids,
      ...objects.flatMap((item) => item.evidence_ids), ...(hint?.evidence_ids ?? [])])] };
  const result: SourceAddress = { address, ...(name === undefined ? {} : { name }), object };
  if (mutable || translated.kind !== 'mapped' || !section.file_range ||
    conflicting || kind === 'unknown' || kind === 'jump_table' || kind === 'literal_pool') return result;
  // Never mistake UTF-16's first ASCII byte for a terminated one-byte string.
  if (/(?:ustring|utf16)/i.test(section.name)) return result;
  let end = section.virtual_range.start.value + section.virtual_range.size;
  const fileEnd = section.virtual_range.start.value + section.file_range.size;
  if (fileEnd < end) end = fileEnd;
  if (size !== null && base.value + size < end) end = base.value + size;
  // Even size-less symbols establish a boundary, never an inferred whole extent.
  for (const item of symbols) {
    context.checkpoint(1);
    if (item.address?.image_id === va.image_id && item.address.space === 'va' &&
      item.address.value > va.value && item.address.value < end) end = item.address.value;
  }
  for (const item of image.hints) {
    context.checkpoint(1);
    if (item.kind === 'data' && item.range.start.image_id === va.image_id &&
      item.range.start.space === 'va' && item.range.start.value > va.value && item.range.start.value < end)
      end = item.range.start.value;
  }
  for (const relocation of image.relocations) {
    context.checkpoint(1);
    if (relocation.address.image_id !== va.image_id || relocation.address.space !== 'va') continue;
    const finish = relocation.address.value + BigInt(Math.ceil(relocation.width_bits / 8));
    if (relocation.address.value <= va.value && finish > va.value) return result;
    if (relocation.address.value > va.value && relocation.address.value < end) end = relocation.address.value;
  }
  const remaining = end - va.value;
  if (remaining <= 0n) return result;
  const limit = remaining < 4096n ? remaining : 4096n;
  const spans = [...image.address_map.spans(va, limit)];
  const span = spans[0];
  if (!span || span.kind !== 'mapped' || span.file_offset === null) return result;
  const count = Number(span.range.size);
  const file = span.file_offset;
  const cstring = image.target.format === 'macho' && (section.flags & 255n) === 2n;
  if (!cstring)
    for (let back = 0; back <= 4; back++) {
      context.checkpoint(1);
      const start = va.value - BigInt(back);
      if (start < section.virtual_range.start.value || start % 2n !== 0n || start + 4n > end) continue;
      const before = image.address_map.translate({ ...va, value: start }, 'file');
      const after = image.address_map.translate({ ...va, value: start + 3n }, 'file');
      if (before.kind !== 'mapped' || after.kind !== 'mapped' ||
        before.address.value !== file - BigInt(back) || after.address.value !== before.address.value + 3n) continue;
      const offset = Number(before.address.value);
      if (image.bytes.at(offset) >= 0x20 && image.bytes.at(offset) <= 0x7e &&
        image.bytes.at(offset + 1) === 0 && image.bytes.at(offset + 2) >= 0x20 &&
        image.bytes.at(offset + 2) <= 0x7e && image.bytes.at(offset + 3) === 0) return result;
    }
  let length = 0;
  while (length < count && image.bytes.at(Number(file) + length) !== 0) {
    context.checkpoint(1);
    length++;
  }
  if (length === count) return result;
  // A known multi-record object remains that object, not its first convenient
  // printable prefix. Interior suffixes are valid only within the same extent.
  if (size !== null && va.value - base.value + BigInt(length + 1) !== size) return result;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(image.bytes.read(file, length));
    if (text !== '' && !/^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}\t\r\n]+$/u.test(text)) return result;
    return { ...result, string: text, string_byte_length: BigInt(length),
      string_encoding: /^[\x00-\x7f]*$/.test(text) ? 'ascii' : 'utf8' };
  } catch {
    return result;
  }
}
