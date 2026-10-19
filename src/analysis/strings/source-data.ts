import type { Address, LoadedImage, OperationContext, SymbolRecord } from '../../core/index.js';
import { cSourceName } from '../../metadata/symbols/c-names.js';
import type { SourceAddress } from '../../reconstruction/source-model.js';

const contains = (start: Address, size: bigint, address: Address): boolean =>
  start.image_id === address.image_id &&
  start.space === address.space &&
  address.value >= start.value &&
  address.value < start.value + size;
const compare = (left: bigint, right: bigint): number => (left < right ? -1 : left > right ? 1 : 0);
const coordinate = (address: Address): string => `${address.image_id}\0${address.space}`;
/** Only this many bytes after an address are ever examined as string bytes, so
 * a boundary farther away cannot change the recovered result. */
const STRING_WINDOW = 4096n;
const pageKey = (address: Address, page = address.value / STRING_WINDOW): string =>
  `${coordinate(address)}\0${page}`;

interface Interval<T> {
  readonly start: bigint;
  readonly end: bigint;
  readonly order: number;
  readonly item: T;
}
/** Centered interval tree over half-open ranges: point queries visit O(log n)
 * nodes plus the ranges they return, never every image-wide record. */
interface IntervalNode<T> {
  readonly center: bigint;
  readonly by_start: readonly Interval<T>[];
  readonly by_end: readonly Interval<T>[];
  readonly left: IntervalNode<T> | undefined;
  readonly right: IntervalNode<T> | undefined;
}
function intervalNode<T>(
  sorted: readonly Interval<T>[],
  context: OperationContext,
): IntervalNode<T> | undefined {
  if (!sorted.length) return undefined;
  context.checkpoint(sorted.length);
  // The median start is inside its own non-empty range, so both sides shrink;
  // partitioning preserves start order.
  const center = sorted[sorted.length >> 1]!.start;
  const here: Interval<T>[] = [],
    left: Interval<T>[] = [],
    right: Interval<T>[] = [];
  for (const item of sorted)
    (item.end <= center ? left : item.start > center ? right : here).push(item);
  return {
    center,
    by_start: here,
    by_end: [...here].sort((first, second) => {
      context.checkpoint(1);
      return compare(second.end, first.end);
    }),
    left: intervalNode(left, context),
    right: intervalNode(right, context),
  };
}
function intervalTree<T>(
  items: readonly Interval<T>[],
  context: OperationContext,
): IntervalNode<T> | undefined {
  return intervalNode(
    [...items].sort((left, right) => {
      context.checkpoint(1);
      return compare(left.start, right.start) || left.order - right.order;
    }),
    context,
  );
}
function stab<T>(root: IntervalNode<T> | undefined, point: bigint, context: OperationContext): T[] {
  const found: Interval<T>[] = [];
  for (let node = root; node;) {
    context.checkpoint(1);
    if (point === node.center) {
      context.checkpoint(node.by_start.length);
      found.push(...node.by_start);
      break;
    }
    if (point < node.center) {
      for (const item of node.by_start) {
        context.checkpoint(1);
        if (item.start > point) break;
        found.push(item);
      }
      node = node.left;
    } else {
      for (const item of node.by_end) {
        context.checkpoint(1);
        if (item.end <= point) break;
        found.push(item);
      }
      node = node.right;
    }
  }
  return found.sort((left, right) => left.order - right.order).map((item) => item.item);
}
function grouped<T>(
  items: Iterable<T>,
  key: (item: T) => string | undefined,
  context: OperationContext,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    context.checkpoint(1);
    const name = key(item);
    if (name === undefined) continue;
    const group = groups.get(name);
    if (group) group.push(item);
    else groups.set(name, [item]);
  }
  return groups;
}
const treesByCoordinate = <T>(
  groups: ReadonlyMap<string, readonly Interval<T>[]>,
  context: OperationContext,
) => new Map([...groups].map(([key, items]) => [key, intervalTree(items, context)]));
type Pages<T extends { readonly start: bigint } = { readonly start: bigint }> = ReadonlyMap<
  string,
  readonly T[]
>;
/** Lower `end` to the first start in (va, end). Callers keep `end` within one
 * string window of `va`, so at most two window-sized pages are visited. */
function nearestStart(pages: Pages, va: Address, end: bigint, context: OperationContext): bigint {
  if (end <= va.value) return end;
  const last = (end - 1n) / STRING_WINDOW;
  for (let page = va.value / STRING_WINDOW; page <= last; page++)
    for (const { start } of pages.get(pageKey(va, page)) ?? []) {
      context.checkpoint(1);
      if (start > va.value && start < end) end = start;
    }
  return end;
}

interface SymbolIndex {
  readonly objects: ReadonlyMap<string, IntervalNode<SymbolRecord> | undefined>;
  readonly pages: Pages;
}
type DataHint = Extract<LoadedImage['hints'][number], { readonly kind: 'data' }>;
interface ImageDataIndex {
  readonly hints: ReadonlyMap<string, IntervalNode<DataHint> | undefined>;
  readonly hint_pages: Pages;
  /** Relocation slots bucketed by start page, with the widest slot's bytes. */
  readonly relocations: Pages<{ readonly start: bigint; readonly end: bigint }>;
  readonly relocation_bytes: bigint;
}
// Symbol snapshots and loaded images are immutable; one index serves every
// address recovered from the same snapshot instead of rescanning it per address.
const symbolIndexes = new WeakMap<readonly SymbolRecord[], SymbolIndex>();
const imageIndexes = new WeakMap<LoadedImage, ImageDataIndex>();
function symbolIndex(symbols: readonly SymbolRecord[], context: OperationContext): SymbolIndex {
  const cached = symbolIndexes.get(symbols);
  if (cached) return cached;
  const objects = new Map<string, Interval<SymbolRecord>[]>(),
    pages = new Map<string, { start: bigint }[]>();
  symbols.forEach((symbol, order) => {
    context.checkpoint(1);
    if (!symbol.address) return;
    const page = pageKey(symbol.address),
      starts = pages.get(page);
    if (starts) starts.push({ start: symbol.address.value });
    else pages.set(page, [{ start: symbol.address.value }]);
    if (symbol.kind !== 'object') return;
    // Size-less objects identify exactly their own address: the unit range [a, a+1).
    const item: Interval<SymbolRecord> = {
      start: symbol.address.value,
      order,
      item: symbol,
      end: symbol.address.value + (symbol.size === null || symbol.size === 0n ? 1n : symbol.size),
    };
    const key = coordinate(symbol.address),
      group = objects.get(key);
    if (group) group.push(item);
    else objects.set(key, [item]);
  });
  const indexed: SymbolIndex = { objects: treesByCoordinate(objects, context), pages };
  symbolIndexes.set(symbols, indexed);
  return indexed;
}
function imageDataIndex(image: LoadedImage, context: OperationContext): ImageDataIndex {
  const cached = imageIndexes.get(image);
  if (cached) return cached;
  const data = image.hints.filter((hint): hint is DataHint => {
    context.checkpoint(1);
    return hint.kind === 'data';
  });
  const hints = grouped(
    data
      .map((hint, order): Interval<DataHint> => ({
        start: hint.range.start.value,
        end: hint.range.start.value + hint.range.size,
        order,
        item: hint,
      }))
      .filter((item) => item.end > item.start),
    (item) => coordinate(item.item.range.start),
    context,
  );
  const hintPages = grouped(data, (hint) => pageKey(hint.range.start), context);
  let relocationBytes = 0n;
  const relocations = grouped(
    image.relocations,
    (relocation) => pageKey(relocation.address),
    context,
  );
  const indexed: ImageDataIndex = {
    hints: treesByCoordinate(hints, context),
    hint_pages: new Map(
      [...hintPages].map(([key, items]) => [
        key,
        items.map((hint) => ({ start: hint.range.start.value })),
      ]),
    ),
    relocations: new Map(
      [...relocations].map(([key, items]) => [
        key,
        items.map((relocation) => {
          const bytes = BigInt(Math.ceil(relocation.width_bits / 8));
          if (bytes > relocationBytes) relocationBytes = bytes;
          return { start: relocation.address.value, end: relocation.address.value + bytes };
        }),
      ]),
    ),
    relocation_bytes: relocationBytes,
  };
  imageIndexes.set(image, indexed);
  return indexed;
}

/** Exact scalar bytes from one immutable, file-backed section. Unlike string
 * recovery this permits literal pools and does not interpret their contents. */
export function recoverDataBytes(
  image: LoadedImage,
  address: Address,
  byteLength: number,
  context: OperationContext,
): readonly number[] | undefined {
  context.checkpoint(1);
  if (address.image_id !== image.id || !Number.isSafeInteger(byteLength) || byteLength <= 0)
    return undefined;
  const translated = image.address_map.translate(address, 'va');
  if (translated.kind !== 'mapped') return undefined;
  const va = translated.address,
    end = va.value + BigInt(byteLength);
  const sections = image.sections.filter(
    (section) =>
      section.kind === 'section' &&
      section.virtual_range.start.image_id === va.image_id &&
      section.virtual_range.start.space === va.space &&
      section.virtual_range.start.value < end &&
      section.virtual_range.start.value + section.virtual_range.size > va.value,
  );
  if (sections.length !== 1) return undefined;
  const section = sections[0]!;
  if (
    !section.permissions.includes('read') ||
    section.permissions.includes('write') ||
    !section.file_range ||
    section.virtual_range.start.value > va.value ||
    end > section.virtual_range.start.value + section.virtual_range.size ||
    end > section.virtual_range.start.value + section.file_range.size ||
    image.mappings.some(
      (mapping) =>
        (!mapping.permissions.includes('read') || mapping.permissions.includes('write')) &&
        mapping.va < end &&
        mapping.va + mapping.memory_size > va.value,
    )
  )
    return undefined;
  const indexed = imageDataIndex(image, context);
  const reach =
    va.value + 1n > indexed.relocation_bytes ? va.value + 1n - indexed.relocation_bytes : 0n;
  for (let page = reach / STRING_WINDOW; page <= (end - 1n) / STRING_WINDOW; page++)
    for (const relocation of indexed.relocations.get(pageKey(va, page)) ?? []) {
      context.checkpoint(1);
      if (relocation.start < end && relocation.end > va.value) return undefined;
    }
  const spans = [...image.address_map.spans(va, BigInt(byteLength))];
  const span = spans[0];
  if (
    spans.length !== 1 ||
    !span ||
    span.kind !== 'mapped' ||
    span.file_offset === null ||
    span.range.size !== BigInt(byteLength)
  )
    return undefined;
  context.checkpoint(byteLength);
  return [...image.bytes.read(span.file_offset, byteLength)];
}

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
    return (
      section.kind === 'section' &&
      section.permissions.includes('read') &&
      contains(section.virtual_range.start, section.virtual_range.size, va) &&
      (image.target.format === 'macho'
        ? (section.flags & 0x80000400n) === 0n && (section.flags & 255n) !== 8n
        : !section.permissions.includes('execute'))
    );
  });
  if (sections.length !== 1) return undefined;
  const section = sections[0]!;
  const mutable =
    section.permissions.includes('write') ||
    image.mappings.some(
      (mapping) =>
        mapping.permissions.includes('write') &&
        va.value >= mapping.va &&
        va.value < mapping.va + mapping.memory_size,
    );
  const owned = symbolIndex(symbols, context),
    indexed = imageDataIndex(image, context);
  const objects = stab(owned.objects.get(coordinate(va)), va.value, context);
  // Section ownership is a bound, not one source-level array containing every
  // unrelated string/global in the section.
  const hints = stab(indexed.hints.get(coordinate(va)), va.value, context).filter(
    (hint) =>
      !(
        hint.encoding === 'bytes' &&
        hint.range.start.value === section.virtual_range.start.value &&
        hint.range.size === section.virtual_range.size
      ),
  );
  const hint = hints.length === 1 && hints[0]?.kind === 'data' ? hints[0] : undefined;
  const bases = new Set(objects.map((symbol) => symbol.address!.value));
  const sizes = new Set(objects.map((symbol) => symbol.size));
  const symbol = bases.size === 1 ? objects[0] : undefined;
  const conflicting =
    bases.size > 1 ||
    sizes.size > 1 ||
    hints.length > 1 ||
    (hint !== undefined &&
      symbol?.address !== undefined &&
      symbol.address !== null &&
      (hint.range.start.value !== symbol.address.value ||
        (symbol.size !== null && hint.range.size !== symbol.size)));
  const base = conflicting ? va : (hint?.range.start ?? symbol?.address ?? va);
  const size = conflicting ? null : (hint?.range.size ?? symbol?.size ?? null);
  const names = new Set(objects.flatMap((item) => item.display_name ?? item.original_name ?? []));
  const name = !conflicting && names.size === 1 ? [...names][0] : undefined;
  const kind = conflicting ? 'unknown' : (hint?.encoding ?? 'bytes');
  const object = {
    address: base,
    byte_length: size,
    offset: va.value - base.value,
    mutable,
    kind,
    evidence_ids: [
      ...new Set([
        ...section.evidence_ids,
        ...objects.flatMap((item) => item.evidence_ids),
        ...(hint?.evidence_ids ?? []),
      ]),
    ],
  };
  const result: SourceAddress = { address, ...(name === undefined ? {} : { name }), object };
  if (
    mutable ||
    translated.kind !== 'mapped' ||
    !section.file_range ||
    conflicting ||
    kind === 'unknown' ||
    kind === 'jump_table' ||
    kind === 'literal_pool'
  )
    return result;
  // Never mistake UTF-16's first ASCII byte for a terminated one-byte string.
  if (/(?:ustring|utf16)/i.test(section.name)) return result;
  let end = section.virtual_range.start.value + section.virtual_range.size;
  const fileEnd = section.virtual_range.start.value + section.file_range.size;
  if (fileEnd < end) end = fileEnd;
  if (size !== null && base.value + size < end) end = base.value + size;
  if (end > va.value + STRING_WINDOW) end = va.value + STRING_WINDOW;
  // Even size-less symbols establish a boundary, never an inferred whole extent.
  const at: Address = { ...va, space: 'va' };
  end = nearestStart(owned.pages, at, end, context);
  end = nearestStart(indexed.hint_pages, at, end, context);
  // Relocation slots are storage: an address inside one is never string bytes.
  const reach =
    va.value + 1n > indexed.relocation_bytes ? va.value + 1n - indexed.relocation_bytes : 0n;
  for (let page = reach / STRING_WINDOW; page <= va.value / STRING_WINDOW; page++)
    for (const relocation of indexed.relocations.get(pageKey(at, page)) ?? []) {
      context.checkpoint(1);
      if (relocation.start <= va.value && relocation.end > va.value) return result;
    }
  end = nearestStart(indexed.relocations, at, end, context);
  const remaining = end - va.value;
  if (remaining <= 0n) return result;
  const spans = [...image.address_map.spans(va, remaining)];
  const span = spans[0];
  if (!span || span.kind !== 'mapped' || span.file_offset === null) return result;
  const count = Number(span.range.size);
  const file = span.file_offset;
  const cstring = image.target.format === 'macho' && (section.flags & 255n) === 2n;
  if (!cstring)
    for (let back = 0; back <= 4; back++) {
      context.checkpoint(1);
      const start = va.value - BigInt(back);
      if (start < section.virtual_range.start.value || start % 2n !== 0n || start + 4n > end)
        continue;
      const before = image.address_map.translate({ ...va, value: start }, 'file');
      const after = image.address_map.translate({ ...va, value: start + 3n }, 'file');
      if (
        before.kind !== 'mapped' ||
        after.kind !== 'mapped' ||
        before.address.value !== file - BigInt(back) ||
        after.address.value !== before.address.value + 3n
      )
        continue;
      const offset = Number(before.address.value);
      if (
        image.bytes.at(offset) >= 0x20 &&
        image.bytes.at(offset) <= 0x7e &&
        image.bytes.at(offset + 1) === 0 &&
        image.bytes.at(offset + 2) >= 0x20 &&
        image.bytes.at(offset + 2) <= 0x7e &&
        image.bytes.at(offset + 3) === 0
      )
        return result;
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
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      image.bytes.read(file, length),
    );
    if (text !== '' && !/^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}\t\r\n]+$/u.test(text)) return result;
    // A suffix of a neighbouring terminated string is a valid address but not
    // that string's own literal: only a section start or a preceding NUL begins one.
    const previous =
      va.value === section.virtual_range.start.value
        ? undefined
        : image.address_map.translate({ ...va, space: 'va', value: va.value - 1n }, 'file');
    const start =
      previous === undefined ||
      (previous.kind === 'mapped' &&
        previous.address.value === file - 1n &&
        image.bytes.at(Number(previous.address.value)) === 0);
    return {
      ...result,
      string: text,
      string_byte_length: BigInt(length),
      string_encoding: /^[\x00-\x7f]*$/.test(text) ? 'ascii' : 'utf8',
      ...(start ? { string_start: true as const } : {}),
    };
  } catch {
    return result;
  }
}

/** Loader-bound import slots among `candidates` (keyed `image:space:value`). A
 * slot bound to conflicting symbols, a lazily bound slot (its pointer changes
 * when first called) or a stub entry is no data binding. Asserted name
 * annotations rename the symbol; any other annotation leaves it unnamed. */
export function recoverImportBindings(
  image: LoadedImage,
  candidates: ReadonlyMap<string, Address>,
  annotations: (importId: string) => { readonly asserted: readonly string[]; readonly annotated: boolean },
  context: OperationContext,
): ReadonlyMap<string, NonNullable<SourceAddress['import']>> {
  const key = (address: Address): string => `${address.image_id}:${address.space}:${address.value}`;
  const width = BigInt(image.target.address_bits / 8);
  const bound = new Map<string, LoadedImage['imports'][number][]>();
  for (const item of image.imports) {
    context.checkpoint(1);
    if (!item.slot || item.delayed || item.callable_entry || item.original_name === null) continue;
    const slot = key(item.slot);
    if (!candidates.has(slot) || item.slot.value % width !== 0n) continue;
    const list = bound.get(slot);
    if (list) list.push(item);
    else bound.set(slot, [item]);
  }
  const result = new Map<string, NonNullable<SourceAddress['import']>>();
  for (const [slot, items] of bound) {
    context.checkpoint(1);
    const entries: { item: (typeof items)[number]; name: string; source: string }[] = [];
    let ambiguous = false;
    for (const item of items) {
      const { asserted, annotated } = annotations(item.id);
      const names = new Set(asserted);
      if (names.size === 1) {
        const name = [...names][0]!;
        entries.push({ item, name, source: name });
      } else if (annotated) ambiguous = true;
      else {
        const name = item.original_name!;
        entries.push({ item, name, source: cSourceName(image.target.format, name) });
      }
    }
    const first = entries[0];
    if (
      ambiguous ||
      !first ||
      entries.some((entry) => entry.name !== first.name || entry.source !== first.source)
    )
      continue;
    const libraries = new Set(entries.map((entry) => entry.item.library));
    result.set(slot, {
      id: first.item.id,
      name: first.name,
      source_name: first.source,
      library: libraries.size === 1 ? first.item.library : null,
      evidence_ids: [...new Set(entries.flatMap((entry) => entry.item.evidence_ids))],
    });
  }
  return result;
}
