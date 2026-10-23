import { buildOnce, useBuilt } from '../../core/index.js';
import type {
  Address,
  LoadedImage,
  OperationContext,
  Section,
  SymbolRecord,
} from '../../core/index.js';
import { findVariable } from '../../metadata/library-contracts/catalog.js';
import { cSourceName, libraryLookupName } from '../../metadata/symbols/c-names.js';
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
  /** Every addressed symbol, bucketed by start page. */
  readonly pages: Pages<{ readonly start: bigint; readonly symbol: SymbolRecord }>;
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
  if (cached) return useBuilt(context, cached);
  const indexed = buildOnce(context, 'symbol-index', (quiet) => buildSymbolIndex(symbols, quiet));
  symbolIndexes.set(symbols, indexed);
  return indexed;
}
function buildSymbolIndex(
  symbols: readonly SymbolRecord[],
  context: OperationContext,
): SymbolIndex {
  const objects = new Map<string, Interval<SymbolRecord>[]>(),
    pages = new Map<string, { start: bigint; symbol: SymbolRecord }[]>();
  symbols.forEach((symbol, order) => {
    context.checkpoint(1);
    if (!symbol.address) return;
    const page = pageKey(symbol.address),
      starts = pages.get(page);
    if (starts) starts.push({ start: symbol.address.value, symbol });
    else pages.set(page, [{ start: symbol.address.value, symbol }]);
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
  return { objects: treesByCoordinate(objects, context), pages };
}
function imageDataIndex(image: LoadedImage, context: OperationContext): ImageDataIndex {
  const cached = imageIndexes.get(image);
  if (cached) return useBuilt(context, cached);
  const indexed = buildOnce(context, 'image-data-index', (quiet) =>
    buildImageDataIndex(image, quiet),
  );
  return indexed;
}
function buildImageDataIndex(image: LoadedImage, context: OperationContext): ImageDataIndex {
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

/** The object symbol a covered-by-nothing `va` is named relative to: the nearest
 * symbol start before `va` (within one string window, inside `section`) belongs
 * only to size-less object symbols of one name, and no data record starts in
 * between. The symbol's extent stays unknown: this is naming, not ownership. */
function precedingObject(
  owned: SymbolIndex,
  indexed: ImageDataIndex,
  section: Section,
  va: Address,
  context: OperationContext,
): { readonly symbol: SymbolRecord; readonly name: string; readonly start: bigint } | undefined {
  const sectionStart = section.virtual_range.start.value;
  const low =
    va.value - sectionStart < STRING_WINDOW ? sectionStart : va.value - STRING_WINDOW + 1n;
  let start: bigint | undefined,
    found: SymbolRecord[] = [];
  for (let page = low / STRING_WINDOW; page <= va.value / STRING_WINDOW; page++)
    for (const entry of owned.pages.get(pageKey(va, page)) ?? []) {
      context.checkpoint(1);
      if (entry.start < low || entry.start > va.value) continue;
      if (start === undefined || entry.start > start) {
        start = entry.start;
        found = [entry.symbol];
      } else if (entry.start === start) found.push(entry.symbol);
    }
  if (start === undefined || start === va.value) return undefined;
  const names = new Set(found.map((symbol) => symbol.display_name ?? symbol.original_name));
  const name = names.size === 1 ? [...names][0] : undefined;
  if (
    !name ||
    found.some(
      (symbol) => symbol.kind !== 'object' || (symbol.size !== null && symbol.size !== 0n),
    ) ||
    nearestStart(indexed.hint_pages, { ...va, value: start }, va.value + 1n, context) <= va.value
  )
    return undefined;
  return { symbol: found[0]!, name, start };
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
  // A size-less immutable object ends no later than the next symbol, data
  // record or relocation slot after its base, or its section's file-backed end.
  let spanBound: bigint | undefined;
  if (
    !mutable &&
    size === null &&
    kind === 'bytes' &&
    translated.kind === 'mapped' &&
    section.file_range &&
    base.value >= section.virtual_range.start.value
  ) {
    let spanEnd = section.virtual_range.start.value + section.virtual_range.size;
    const fileEnd = section.virtual_range.start.value + section.file_range.size;
    if (fileEnd < spanEnd) spanEnd = fileEnd;
    if (base.value + STRING_WINDOW < spanEnd) spanEnd = base.value + STRING_WINDOW;
    spanEnd = nearestStart(owned.pages, base, spanEnd, context);
    spanEnd = nearestStart(indexed.hint_pages, base, spanEnd, context);
    spanEnd = nearestStart(indexed.relocations, base, spanEnd, context);
    if (spanEnd > base.value) spanBound = spanEnd - base.value;
  }
  const relative =
    objects.length === 0 && hints.length === 0
      ? precedingObject(owned, indexed, section, va, context)
      : undefined;
  const object = {
    address: base,
    byte_length: size,
    ...(spanBound === undefined ? {} : { span_bound: spanBound }),
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
  const result: SourceAddress = {
    address,
    ...(name === undefined ? {} : { name }),
    ...(relative
      ? {
          symbol_relative: {
            symbol_id: relative.symbol.id,
            evidence_ids: relative.symbol.evidence_ids,
            name: relative.name,
            offset: va.value - relative.start,
          },
        }
      : {}),
    object,
  };
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

/** Half-open VA range `[start, end)`. */
interface LoaderWrittenRange {
  readonly start: bigint;
  readonly end: bigint;
}
/** Address ranges only the loader writes: Mach-O non-lazy pointer sections
 * (`S_NON_LAZY_SYMBOL_POINTERS`, `__got`, `__auth_got`) and segments read-only after
 * fixups (`__DATA_CONST`, `SG_READ_ONLY`), ELF `PT_GNU_RELRO`, and every mapping
 * without write permission. PE import slots are IAT entries and need no range. */
function loaderWrittenRanges(
  image: LoadedImage,
  context: OperationContext,
): readonly LoaderWrittenRange[] {
  const ranges: LoaderWrittenRange[] = [];
  for (const mapping of image.mappings) {
    context.checkpoint(1);
    if (!mapping.permissions.includes('write'))
      ranges.push({ start: mapping.va, end: mapping.va + mapping.memory_size });
  }
  if (image.target.format === 'macho') {
    const segments = new Map<string, Section>();
    for (const section of image.sections) {
      context.checkpoint(1);
      if (section.kind === 'segment') segments.set(section.id, section);
    }
    for (const section of image.sections) {
      context.checkpoint(1);
      const segment = section.segment_id === null ? undefined : segments.get(section.segment_id);
      if (
        section.kind === 'section' &&
        ((section.flags & 255n) === 6n ||
          section.name === '__got' ||
          section.name === '__auth_got' ||
          segment?.name === '__DATA_CONST' ||
          (segment !== undefined && (segment.flags & 0x10n) !== 0n))
      )
        ranges.push({
          start: section.virtual_range.start.value,
          end: section.virtual_range.start.value + section.virtual_range.size,
        });
    }
  } else if (image.target.format === 'elf')
    for (const header of image.headers) {
      context.checkpoint(1);
      if (header.kind !== 'elf_program_header') continue;
      const field = (name: string): bigint | undefined => {
        const found = header.fields.find((item) => item.name === name);
        return found?.kind === 'integer' ? found.value : undefined;
      };
      const start = field('p_vaddr'),
        size = field('p_memsz');
      if (field('p_type') === 0x6474e552n && start !== undefined && size !== undefined)
        ranges.push({ start, end: start + size });
    }
  return ranges;
}

/** Loader-bound import slots among `candidates` (keyed `image:space:value`). A
 * slot bound to conflicting symbols, a lazily bound slot (its pointer changes
 * when first called) or a stub entry is no data binding. Asserted name
 * annotations rename the symbol; any other annotation leaves it unnamed.
 * `bindings` holds the slots in storage only the loader writes; a bind in
 * writable program data stays plain storage and only states the symbol whose
 * exact address it holds at load time (`initial`, C spelling). */
export function recoverImportBindings(
  image: LoadedImage,
  candidates: ReadonlyMap<string, Address>,
  annotations: (importId: string) => {
    readonly asserted: readonly string[];
    readonly annotated: boolean;
  },
  context: OperationContext,
): {
  readonly bindings: ReadonlyMap<string, NonNullable<SourceAddress['import']>>;
  readonly initial: ReadonlyMap<string, string>;
} {
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
  // A relocation addend makes the slot hold the symbol's address plus an offset:
  // the header declaration then describes a different object than the slot reads.
  const adjusted = new Set<string>();
  // A slot with an addend holds the symbol's address plus an offset at load time.
  const offsetSlots = new Set<string>();
  for (const relocation of image.relocations) {
    context.checkpoint(1);
    if (relocation.symbol_id !== null && relocation.addend !== 0n)
      adjusted.add(relocation.symbol_id);
    if (relocation.addend !== 0n) offsetSlots.add(key(relocation.address));
  }
  const result = new Map<string, NonNullable<SourceAddress['import']>>(),
    initial = new Map<string, string>();
  let writers: readonly LoaderWrittenRange[] | undefined;
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
    const at = first.item.slot!.value;
    if (image.target.format !== 'pe') {
      writers ??= loaderWrittenRanges(image, context);
      if (!writers.some((range) => at >= range.start && at < range.end)) {
        if (!offsetSlots.has(slot)) initial.set(slot, first.source);
        continue;
      }
    }
    const libraries = new Set(entries.map((entry) => entry.item.library));
    const library = libraries.size === 1 ? first.item.library : null;
    const declared =
      library !== null && entries.every((entry) => !entry.item.weak && !adjusted.has(entry.item.id))
        ? findVariable(
            libraryLookupName(image.target.format, first.item.original_name!),
            library,
            image.target.format,
          )
        : undefined;
    result.set(slot, {
      id: first.item.id,
      name: first.name,
      source_name: first.source,
      library,
      evidence_ids: [...new Set(entries.flatMap((entry) => entry.item.evidence_ids))],
      ...(declared
        ? {
            variable: {
              type: declared.type,
              constant: declared.constant,
              source: declared.source,
            },
          }
        : {}),
    });
  }
  return { bindings: result, initial };
}
