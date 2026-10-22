import {
  buildOnce,
  useBuilt,
  type AbiProfile,
  type Address,
  type DecodedInstruction,
  type Decoder,
  type FunctionGraph,
  type FunctionRecord,
  type Lifter,
  type LoadedImage,
  type OperationContext,
  type ReferenceRecord,
  type RegisterDescriptor,
} from '../../core/index.js';
import type { BasicBlock, RegisterIR } from '../../ir/index.js';
import { buildCFG } from '../cfg/index.js';
import { constructSSA } from '../ssa/index.js';
import { observeCallResultDemands } from './result-demands.js';

/** Most instructions one result-use window lifts after a call's return address. */
export const MAX_RESULT_USE_WINDOW = 64;
/** A first, shorter window: most callers consume or overwrite the result at once. */
const FIRST_RESULT_USE_WINDOW = 12;

/** One direct control transfer to a function entry. */
export interface CallerSite {
  /** The transfer instruction (ARM64 BL/B; x86-64 CALL/JMP). */
  readonly address: Address;
  /** `call` returns to the caller (BL); `tail` forwards the caller's own return (B). */
  readonly kind: 'call' | 'tail';
  /** The function containing the site; null when none can be attributed or several
   * overlap there. */
  readonly caller: FunctionRecord | null;
  /** `ranges`: discovery owns the site (the caller's discovered ranges contain it, or
   * the reference names it). `next_entry`: no discovered range contains it; the caller
   * has the nearest function entry below the site and no other entry lies between
   * (an extent bound, not a proven range). */
  readonly attribution: 'ranges' | 'next_entry' | null;
  /** Bytes from the caller's entry to the next function entry; null for the last one. */
  readonly caller_extent: bigint | null;
}

/** Every listed direct transfer to `target`. `complete`: no other direct BL/B/CALL/JMP to
 * `target` exists in the image's instruction bytes (ARM64: a linear sweep of every
 * instruction section outside data-in-code ranges; x86-64: only a complete discovered
 * reference index). Indirect transfers and materialized addresses are never listed. */
export interface CallerSites {
  readonly target: Address;
  readonly sites: readonly CallerSite[];
  readonly complete: boolean;
}

interface IndexedSite {
  readonly address: bigint;
  readonly tail: boolean;
  /** Discovery's owner for a reference-index site. */
  readonly from_function: string | null;
}
interface Segment {
  readonly start: bigint;
  readonly end: bigint;
  readonly owner: FunctionRecord | null;
}
interface ByteRange {
  readonly start: bigint;
  readonly end: bigint;
}

/** Per-image direct call-site index. Built once per (image, functions, references)
 * snapshot through `buildOnce`; every operation using it pays its recorded cost once. */
export interface CallerSiteIndex {
  readonly functions: readonly FunctionRecord[];
  readonly references: readonly ReferenceRecord[];
  readonly references_complete: boolean;
  readonly image: LoadedImage;
  readonly complete: boolean;
  readonly sites_by_target: ReadonlyMap<bigint, readonly IndexedSite[]>;
  readonly functions_by_id: ReadonlyMap<string, FunctionRecord>;
  readonly entries: ReadonlySet<bigint>;
  /** Sorted distinct function entry VAs, and the functions at each. */
  readonly entry_order: readonly bigint[];
  readonly functions_by_entry: ReadonlyMap<bigint, readonly FunctionRecord[]>;
  /** Sorted disjoint VA segments of function ranges; `owner` null where ranges overlap. */
  readonly segments: readonly Segment[];
  /** Sorted disjoint VA ranges of instruction bytes: instruction sections minus data. */
  readonly code: readonly ByteRange[];
  /** Function entries that some instruction may reach or materialize other than through
   * a listed direct transfer, with the reason. ARM64: a conditional branch (B.cond,
   * CBZ/CBNZ, TBZ/TBNZ) to the entry, an ADR of it, or an ADRP of its page while some
   * 64-bit ADD immediate adds its page offset (or the offset is 0); x86-64: a reference
   * to it that is neither a call nor a tail call. */
  readonly escaped: ReadonlyMap<bigint, string>;
  /** Every loader function-start hint is a function entry here (and one exists), so a
   * site outside discovered ranges belongs to the nearest entry below it
   * (`next_entry` attribution is exact). */
  readonly starts_complete: boolean;
}

const indexes = new WeakMap<LoadedImage, CallerSiteIndex>();

function instructionSections(image: LoadedImage) {
  return image.sections
    .filter(
      (section) =>
        section.kind === 'section' &&
        section.file_range !== null &&
        section.virtual_range.start.space === 'va' &&
        // Mach-O segment permissions also cover constants: instruction attributes
        // establish code. Other formats mark code sections executable.
        (image.target.format === 'macho'
          ? (section.flags & 0x80000400n) !== 0n
          : section.permissions.includes('execute')),
    )
    .sort((a, b) =>
      a.virtual_range.start.value < b.virtual_range.start.value
        ? -1
        : a.virtual_range.start.value > b.virtual_range.start.value
          ? 1
          : 0,
    );
}

const rangeCount = (functions: readonly FunctionRecord[]): number =>
  functions.reduce((total, fn) => total + fn.ranges.length, 0);

/** The exact work `callerSiteIndex` charges when it builds: one per swept instruction
 * word (ARM64) or discovered reference (x86-64), one per function (entry order), three
 * per function range (segment map) and one per loader hint. Callers compare it with
 * their share before using the index. */
export function callerSiteIndexWork(
  image: LoadedImage,
  functions: readonly FunctionRecord[],
  references: readonly ReferenceRecord[],
): number {
  let words = 0;
  if (image.target.architecture === 'arm64')
    for (const section of instructionSections(image))
      words += Number(section.virtual_range.size / 4n);
  return (
    words + references.length + functions.length + 3 * rangeCount(functions) + image.hints.length
  );
}

export function callerSiteIndex(
  image: LoadedImage,
  functions: readonly FunctionRecord[],
  references: readonly ReferenceRecord[],
  referencesComplete: boolean,
  context: OperationContext,
): CallerSiteIndex {
  const cached = indexes.get(image);
  if (
    cached?.functions === functions &&
    cached.references === references &&
    cached.references_complete === referencesComplete
  )
    return useBuilt(context, cached);
  const built = buildOnce(context, (quiet) =>
    buildCallerSiteIndex(image, functions, references, referencesComplete, quiet),
  );
  indexes.set(image, built);
  return built;
}

/** Subtract sorted `holes` from sorted `ranges`. */
function subtract(ranges: readonly ByteRange[], holes: readonly ByteRange[]): ByteRange[] {
  const result: ByteRange[] = [];
  for (const range of ranges) {
    let start = range.start;
    for (const hole of holes) {
      if (hole.end <= start || hole.start >= range.end) continue;
      if (hole.start > start) result.push({ start, end: hole.start });
      if (hole.end > start) start = hole.end;
    }
    if (start < range.end) result.push({ start, end: range.end });
  }
  return result;
}

/** Most instructions `pageOffsets` follows after an ADRP. */
const PAGE_SCAN = 32;

/** The page offsets an ADRP into `register` is added to before its page value dies: a
 * linear scan of the following words (`from` up to `end`, byte offsets into `view`)
 * tracking the registers that hold the page. A 64-bit ADD immediate of a tracked
 * register lists its offset (the sum is a fully known address: further arithmetic on
 * it stays inside the object it designates, C pointer provenance); register moves copy
 * the page; unsigned-offset loads and stores may use it as a base; loads and MOVZ/MOVN
 * overwrite it. Any other instruction naming a tracked register in an operand field,
 * a branch, a store of the page, the scan bound or the end of the bytes with the page
 * still tracked leaves its use unknown (undefined). */
function pageOffsets(
  view: DataView,
  from: number,
  end: number,
  register: number,
): number[] | undefined {
  const offsets: number[] = [];
  if (register === 31) return offsets;
  const tracked = new Set<number>([register]);
  for (let at = from, count = 0; tracked.size; at += 4, count++) {
    if (count === PAGE_SCAN || at + 4 > end) return undefined;
    const word = view.getUint32(at, true),
      rd = word & 31,
      rn = (word >>> 5) & 31;
    if ((word & 0xffc00000) >>> 0 === 0x91000000) {
      // ADD Xd, Xn, #imm12
      if (tracked.has(rn)) offsets.push((word >>> 10) & 0xfff);
      tracked.delete(rd);
      continue;
    }
    if ((word & 0xffe0ffe0) >>> 0 === 0xaa0003e0) {
      // MOV Xd, Xm (ORR Xd, XZR, Xm)
      if (tracked.has((word >>> 16) & 31)) tracked.add(rd);
      else tracked.delete(rd);
      continue;
    }
    if ((word & 0x3b000000) >>> 0 === 0x39000000) {
      // Load/store, unsigned immediate offset: a tracked base is a memory access. SIMD&FP
      // transfers and PRFM name no general register in Rt.
      if (word & 0x04000000 || (word >>> 30 === 3 && ((word >>> 22) & 3) === 2)) continue;
      if ((word >>> 22) & 3) tracked.delete(rd);
      else if (tracked.has(rd)) return undefined;
      continue;
    }
    if ((word & 0x1f800000) >>> 0 === 0x12800000 && ((word >>> 29) & 3) !== 3) {
      // MOVN / MOVZ
      tracked.delete(rd);
      continue;
    }
    const branch =
      (word & 0x7c000000) >>> 0 === 0x14000000 ||
      (word & 0x7e000000) >>> 0 === 0x34000000 ||
      (word & 0x7e000000) >>> 0 === 0x36000000 ||
      (word & 0xff000010) >>> 0 === 0x54000000 ||
      word >>> 25 === 0x6b;
    if (
      branch ||
      [rd, rn, (word >>> 10) & 31, (word >>> 16) & 31].some((field) => tracked.has(field))
    )
      return undefined;
  }
  return offsets;
}

function buildCallerSiteIndex(
  image: LoadedImage,
  functions: readonly FunctionRecord[],
  references: readonly ReferenceRecord[],
  referencesComplete: boolean,
  context: OperationContext,
): CallerSiteIndex {
  context.checkpoint(image.hints.length + functions.length);
  const entries = new Set<bigint>();
  const functionsById = new Map<string, FunctionRecord>();
  const functionsByEntry = new Map<bigint, FunctionRecord[]>();
  for (const fn of functions) {
    functionsById.set(fn.id, fn);
    if (fn.entry.space !== 'va') continue;
    entries.add(fn.entry.value);
    const list = functionsByEntry.get(fn.entry.value);
    if (list) list.push(fn);
    else functionsByEntry.set(fn.entry.value, [fn]);
  }
  const entryOrder = [...entries].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // Function ranges as disjoint segments: one owner, or null where several overlap.
  context.checkpoint(3 * rangeCount(functions));
  const bounds: { at: bigint; fn: FunctionRecord; delta: 1 | -1 }[] = [];
  for (const fn of functions)
    for (const range of fn.ranges)
      if (range.start.space === 'va' && range.size > 0n) {
        bounds.push({ at: range.start.value, fn, delta: 1 });
        bounds.push({ at: range.start.value + range.size, fn, delta: -1 });
      }
  bounds.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.delta - b.delta));
  const segments: Segment[] = [];
  const open = new Map<FunctionRecord, number>();
  for (let index = 0; index < bounds.length;) {
    const at = bounds[index]!.at;
    for (; index < bounds.length && bounds[index]!.at === at; index++) {
      const { fn, delta } = bounds[index]!;
      const count = (open.get(fn) ?? 0) + delta;
      if (count) open.set(fn, count);
      else open.delete(fn);
    }
    const next = bounds[index]?.at;
    if (next !== undefined && open.size)
      segments.push({
        start: at,
        end: next,
        owner: open.size === 1 ? open.keys().next().value! : null,
      });
  }
  const sections = instructionSections(image);
  const data = image.hints
    .flatMap((hint) =>
      hint.kind === 'data' && hint.range.start.space === 'va'
        ? [{ start: hint.range.start.value, end: hint.range.start.value + hint.range.size }]
        : [],
    )
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const code = subtract(
    sections.map((section) => ({
      start: section.virtual_range.start.value,
      end: section.virtual_range.start.value + section.virtual_range.size,
    })),
    data,
  );
  const sitesByTarget = new Map<bigint, IndexedSite[]>();
  const add = (target: bigint, site: IndexedSite): void => {
    const list = sitesByTarget.get(target);
    if (list) list.push(site);
    else sitesByTarget.set(target, [site]);
  };
  const hinted = image.hints.filter((hint) => hint.kind === 'function');
  const startsComplete =
    hinted.length > 0 &&
    hinted.every((hint) => hint.address.space === 'va' && entries.has(hint.address.value));
  const escaped = new Map<bigint, string>();
  let complete: boolean;
  if (image.target.architecture === 'arm64') {
    // Linear 4-byte sweep: BL (100101) and B (000101) with a 26-bit word offset. The same
    // words also record every other way an instruction reaches or materializes an entry.
    const materialized = new Set<bigint>(),
      unpaired = new Set<bigint>(),
      offsets = new Set<number>(),
      falls = new Set<bigint>(),
      conditional: { readonly address: bigint; readonly target: bigint }[] = [];
    const entryPages = new Set(entryOrder.map((entry) => entry & ~0xfffn));
    for (const section of sections) {
      const base = section.virtual_range.start.value,
        size = section.virtual_range.size;
      context.checkpoint(Number(size / 4n));
      const bytes = image.bytes.read(section.file_range!.start.value, Number(size));
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const pieces = subtract([{ start: base, end: base + size }], data);
      for (const piece of pieces) {
        const first = Number(((piece.start - base + 3n) / 4n) * 4n),
          last = Number(piece.end - base);
        for (let offset = first; offset + 4 <= last; offset += 4) {
          const word = view.getUint32(offset, true),
            opcode = word >>> 26;
          const address = base + BigInt(offset);
          // Only an unconditional transfer, a trap or a call that never returns here
          // (its return address would be another function's entry) ends the code
          // before an entry; anything else may fall through into it.
          if (
            entries.has(address + 4n) &&
            opcode !== 0x25 &&
            opcode !== 0x05 &&
            !(word >>> 25 === 0x6b && ((word >>> 21) & 0xf) !== 1 && ((word >>> 21) & 0xf) !== 9) &&
            (word & 0xff80001f) >>> 0 !== 0xd4000000 &&
            word >>> 16 !== 0
          )
            falls.add(address + 4n);
          if (opcode !== 0x25 && opcode !== 0x05) {
            if ((word & 0x1f000000) === 0x10000000) {
              // ADR / ADRP: a 21-bit immediate, immhi:immlo.
              let imm = (((word >>> 5) & 0x7ffff) << 2) | ((word >>> 29) & 3);
              if (imm & 0x100000) imm -= 0x200000;
              if (!(word & 0x80000000)) materialized.add(address + BigInt(imm));
              else {
                const page = (address & ~0xfffn) + (BigInt(imm) << 12n);
                if (entryPages.has(page)) {
                  const added = pageOffsets(view, offset + 4, last, word & 0x1f);
                  if (added) for (const low of added) materialized.add(page + BigInt(low));
                  else unpaired.add(page);
                }
              }
            } else if ((word & 0xffc00000) >>> 0 === 0x91000000) offsets.add((word >>> 10) & 0xfff);
            else if (
              (word & 0xff000010) === 0x54000000 ||
              (word & 0x7e000000) === 0x34000000 ||
              (word & 0x7e000000) === 0x36000000
            ) {
              // B.cond, CBZ/CBNZ: imm19; TBZ/TBNZ: imm14 (word offsets).
              const test = (word & 0x7e000000) === 0x36000000;
              let imm = test ? (word >>> 5) & 0x3fff : (word >>> 5) & 0x7ffff;
              if (imm & (test ? 0x2000 : 0x40000)) imm -= test ? 0x4000 : 0x80000;
              const target = address + BigInt(imm * 4);
              if (entries.has(target)) conditional.push({ address, target });
            }
            continue;
          }
          let imm = word & 0x3ffffff;
          if (imm & 0x2000000) imm -= 0x4000000;
          const target = address + BigInt(imm * 4);
          if (entries.has(target))
            add(target, { address, tail: opcode === 0x05, from_function: null });
        }
      }
    }
    for (const entry of entryOrder) {
      const low = Number(entry & 0xfffn);
      if (falls.has(entry)) escaped.set(entry, 'the preceding instruction may fall through');
      else if (materialized.has(entry)) escaped.set(entry, 'an ADR or ADRP+ADD materializes it');
      else if (unpaired.has(entry & ~0xfffn) && (low === 0 || offsets.has(low)))
        escaped.set(
          entry,
          'an unfollowed ADRP of the entry page may pair with an ADD of its offset',
        );
    }
    for (const { address, target } of conditional) {
      // A loop back to a function's own entry stays inside it; only exact extents
      // (complete function starts) prove that.
      const next = entryOrder[entryBelow(entryOrder, target) + 1];
      if (!startsComplete || address < target || (next !== undefined && address >= next))
        escaped.set(target, 'a conditional branch from another function reaches the entry');
    }
    complete = true;
  } else {
    context.checkpoint(references.length);
    for (const reference of references) {
      if (
        reference.status === 'unresolved' ||
        reference.to?.space !== 'va' ||
        reference.from.space !== 'va' ||
        !entries.has(reference.to.value)
      )
        continue;
      if (reference.kind !== 'call' && reference.kind !== 'tail_call') {
        escaped.set(reference.to.value, `a ${reference.kind} reference reaches the entry`);
        continue;
      }
      add(reference.to.value, {
        address: reference.from.value,
        tail: reference.kind === 'tail_call',
        from_function: reference.from_function,
      });
    }
    complete = referencesComplete;
  }
  for (const list of sitesByTarget.values())
    list.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return {
    functions,
    references,
    references_complete: referencesComplete,
    image,
    complete,
    sites_by_target: sitesByTarget,
    functions_by_id: functionsById,
    entries,
    entry_order: entryOrder,
    functions_by_entry: functionsByEntry,
    segments,
    code,
    escaped,
    starts_complete: startsComplete,
  };
}

function segmentAt(index: CallerSiteIndex, address: bigint): Segment | undefined {
  let low = 0,
    high = index.segments.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1,
      segment = index.segments[middle]!;
    if (address < segment.start) high = middle - 1;
    else if (address >= segment.end) low = middle + 1;
    else return segment;
  }
  return undefined;
}

/** Index of the last entry at or below `address` in a sorted entry order, or -1. */
function entryBelow(order: readonly bigint[], address: bigint): number {
  let low = 0,
    high = order.length - 1,
    found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (order[middle]! <= address) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

/** The direct transfers to `target`, in address order, with their containing functions. */
export function callerSites(
  index: CallerSiteIndex,
  target: Address,
  context: OperationContext,
): CallerSites {
  const indexed = index.sites_by_target.get(target.value) ?? [];
  const sites: CallerSite[] = [];
  for (const site of indexed) {
    context.checkpoint(1);
    let caller: FunctionRecord | null = null,
      attribution: CallerSite['attribution'] = null;
    const segment = site.from_function === null ? segmentAt(index, site.address) : undefined;
    if (site.from_function !== null) {
      caller = index.functions_by_id.get(site.from_function) ?? null;
      attribution = caller && 'ranges';
    } else if (segment) {
      caller = segment.owner;
      attribution = caller && 'ranges';
    } else {
      const below = entryBelow(index.entry_order, site.address);
      const owners = below < 0 ? [] : index.functions_by_entry.get(index.entry_order[below]!)!;
      if (owners.length === 1) {
        caller = owners[0]!;
        attribution = 'next_entry';
      }
    }
    let extent: bigint | null = null;
    if (caller?.entry.space === 'va') {
      const next = index.entry_order[entryBelow(index.entry_order, caller.entry.value) + 1];
      if (next !== undefined) extent = next - caller.entry.value;
    }
    sites.push({
      address: { image_id: target.image_id, space: 'va', value: site.address },
      kind: site.tail ? 'tail' : 'call',
      caller,
      attribution,
      caller_extent: extent,
    });
  }
  return { target, sites, complete: index.complete };
}

/** How a caller uses the result registers (ABI integer and FP primary result roots)
 * after one call site returns.
 * - `semantic`: some path reads a result bit before overwriting it (`registers` are
 *   the reads found; positive evidence that the callee's result is consumed).
 * - `forwarded`: no path reads it; some path leaves it live into the caller's own
 *   return (`returns`) or into a tail transfer (`tails`: the targets; the tail callee
 *   may read it as an argument).
 * - `dead`: every path overwrites it (or traps) before any read or exit.
 * - `unknown`: some path reaches a call, an unknown effect, an indirect branch, a jump
 *   table, undecodable bytes or the window bound with the result still live. */
export type ResultUse =
  | { readonly kind: 'semantic'; readonly registers: readonly RegisterDescriptor[] }
  | { readonly kind: 'forwarded'; readonly returns: boolean; readonly tails: readonly Address[] }
  | { readonly kind: 'dead' }
  | { readonly kind: 'unknown'; readonly reason: string };
export interface ResultUseInput {
  readonly index: CallerSiteIndex;
  readonly decoder: Decoder;
  readonly lifter: Lifter<RegisterIR>;
  readonly abi: AbiProfile;
  /** The caller's already prepared body, consulted before any window: a classification
   * of the call node lifted from `instruction` (the decoded site), or undefined. */
  readonly prepared?: (site: CallerSite, instruction: string) => ResultUse | undefined;
  /** The result roots to track; default both ABI primary result roots
   * (`resultRoots`). A caller that knows one root carries no result of the callee
   * passes only the other. */
  readonly roots?: readonly RegisterDescriptor[];
}

/** The ABI primary integer and FP result registers (whole roots stay tracked). */
export function resultRoots(abi: AbiProfile): readonly RegisterDescriptor[] {
  const roots: RegisterDescriptor[] = [];
  for (const returns of [{ kind: 'pointer' }, { kind: 'float', bits: 64 }] as const) {
    const location = abi.classifyCall({
      returns,
      parameters: [],
      variadic: false,
      fixed_parameter_count: 0,
    }).returns[0];
    if (location?.kind === 'register' && !roots.some((r) => r.root === location.register.root))
      roots.push(location.register);
  }
  return roots;
}

/** Classify one site's result use. A `tail` site forwards the caller's own return without
 * a window. A `call` site lifts a bounded window from its return address: at most
 * `MAX_RESULT_USE_WINDOW` instructions, following direct and conditional branches,
 * stopping at calls, function entries, indirect branches, returns, tail branches,
 * traps and bytes outside instruction sections. */
export function classifyResultUse(
  input: ResultUseInput,
  site: CallerSite,
  context: OperationContext,
): ResultUse {
  if (site.kind === 'tail') return { kind: 'forwarded', returns: false, tails: [site.address] };
  if (!site.caller) return { kind: 'unknown', reason: 'no single containing function' };
  const { index } = input,
    image = index.image;
  const unit = image.target.architecture === 'arm64' ? 4n : 15n;
  const codeAt = (value: bigint): ByteRange | undefined => {
    let low = 0,
      high = index.code.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1,
        range = index.code[middle]!;
      if (value < range.start) high = middle - 1;
      else if (value >= range.end) low = middle + 1;
      else return range;
    }
    return undefined;
  };
  const decodeAt = (value: bigint): DecodedInstruction | undefined => {
    const range = codeAt(value);
    if (!range) return undefined;
    const end = range.end - value < unit ? range.end : value + unit;
    const start: Address = { image_id: image.id, space: 'va', value };
    return input.decoder
      .decode(
        {
          image,
          regions: [{ start, size: end - value }],
          mode: image.target.architecture === 'arm64' ? 'a64' : 'long64',
          features: image.target.features,
        },
        context,
      )
      .instructions.find((item) => item.address.value === value && item.validity === 'valid');
  };
  const call = decodeAt(site.address.value);
  if (call?.flow.kind !== 'call' || call.flow.indirect)
    return { kind: 'unknown', reason: 'site is not a decodable direct call' };
  const known = input.prepared?.(site, call.id);
  if (known) return known;
  const start = call.flow.fallthrough;
  // A noreturn callee may be followed by another function's first instruction.
  if (index.entries.has(start.value))
    return { kind: 'unknown', reason: 'return address is a function entry' };
  // The call itself heads the window (a loop may branch back to it).
  const decoded = new Map<bigint, DecodedInstruction>([[call.address.value, call]]);
  const queue: bigint[] = [start.value];
  let result: ResultUse = { kind: 'unknown', reason: 'empty result-use window' };
  for (const limit of [FIRST_RESULT_USE_WINDOW, MAX_RESULT_USE_WINDOW]) {
    // Breadth-first decode; calls, entries and undecodable bytes end a path.
    const pending: bigint[] = [];
    while (queue.length) {
      const value = queue.shift()!;
      if (decoded.has(value)) continue;
      if (value !== start.value && index.entries.has(value)) continue;
      if (decoded.size > limit) {
        pending.push(value);
        continue;
      }
      context.checkpoint(1);
      const instruction = decodeAt(value);
      if (!instruction) continue;
      decoded.set(value, instruction);
      const flow = instruction.flow;
      if (flow.kind === 'fallthrough') queue.push(flow.next.value);
      else if (flow.kind === 'branch') {
        if (!index.entries.has(flow.target.value)) queue.push(flow.target.value);
        if (flow.fallthrough) queue.push(flow.fallthrough.value);
      }
    }
    queue.push(...pending);
    result = classifyWindow(input, site.caller, call, [...decoded.values()], context);
    // Only an inconclusive window that stopped at its bound grows.
    if (result.kind !== 'unknown' || !queue.length) break;
  }
  return result;
}

/** Lift the call and its window as one graph. Walk the register IR from the call node
 * for the use class; a read of a live result bit is semantic only when the window's SSA
 * demand observer (`observeCallResultDemands`) reaches the call's result from a load,
 * store, branch, switch, indirect target or explicit return value. */
function classifyWindow(
  input: ResultUseInput,
  caller: FunctionRecord,
  call: DecodedInstruction,
  /** The call and every decoded window instruction. */
  instructions: readonly DecodedInstruction[],
  context: OperationContext,
): ResultUse {
  const image = input.index.image;
  const blocks = buildCFG(
    {
      slice_id: image.selected_slice_id,
      function_id: caller.id,
      entry: call.address,
      instructions,
      function_entries: input.index.entries,
      evidence: new Map(),
    },
    context,
  );
  const graph: FunctionGraph = {
    function: {
      ...caller,
      entry: call.address,
      ranges: [{ start: call.address, size: BigInt(call.size) }],
    },
    slice_id: image.selected_slice_id,
    blocks,
    instructions,
    gaps: [],
    coverage: {
      layer: 'decode',
      state: 'complete',
      completed_units: instructions.length,
      reasons: [],
    },
    diagnostics: [],
  };
  const ir = input.lifter.lift(graph, input.abi, context).ir;
  const byId = new Map<string, BasicBlock>(ir.blocks.map((block) => [block.id, block]));
  const roots = input.roots ?? resultRoots(input.abi);
  const slice = (register: RegisterDescriptor): bigint =>
    ((1n << BigInt(register.width_bits)) - 1n) << BigInt(register.offset_bits);
  const tails: Address[] = [];
  let returns = false,
    read = false,
    unknown: string | undefined;
  const seen = new Set<string>();
  // Nothing is live before the site's own call node defines the result.
  const stack: { block: string; live: readonly bigint[] | null }[] = [
    { block: ir.entry, live: null },
  ];
  walk: while (stack.length) {
    const { block: id, live: entering } = stack.pop()!;
    const key = `${id}:${entering?.join(',') ?? 'call'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const block = byId.get(id);
    if (!block) {
      unknown ??= 'missing window block';
      continue;
    }
    let live = entering && [...entering];
    const control = block.terminator;
    // Lifted return and tail exits read every possible result or argument
    // register for capacity only; those reads are not uses.
    const capacity =
      control.kind === 'return'
        ? new Set(control.provenance.instruction_ids)
        : control.kind === 'indirect' && control.tail_call
          ? null
          : undefined;
    let ended = false;
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (!live) {
        if (node.kind === 'call' && node.provenance.instruction_ids.includes(call.id))
          live = roots.map((root) => (1n << BigInt(root.root_width_bits)) - 1n);
        continue;
      }
      if (node.kind === 'read_register') {
        const at = roots.findIndex((root) => root.root === node.register.root);
        if (at < 0 || !(live[at]! & slice(node.register))) continue;
        if (
          capacity === null ||
          (capacity &&
            node.provenance.instruction_ids.length > 0 &&
            node.provenance.instruction_ids.every((instruction) => capacity.has(instruction)))
        )
          continue;
        read = true;
        break walk;
      }
      if (node.kind === 'write_register') {
        const at = roots.findIndex((root) => root.root === node.register.root);
        if (at < 0 || node.register.write_rule === 'discard') continue;
        live[at] =
          node.register.write_rule === 'preserve_other_bits'
            ? live[at]! & ~slice(node.register)
            : 0n;
        if (live.every((mask) => mask === 0n)) {
          ended = true;
          break;
        }
        continue;
      }
      if (node.kind === 'call' || node.kind === 'unknown_effect') {
        unknown ??=
          node.kind === 'call' ? 'a call precedes any use' : 'an unknown effect precedes any use';
        ended = true;
        break;
      }
    }
    if (ended) continue;
    switch (control.kind) {
      case 'jump':
        stack.push({ block: control.edge.target, live });
        break;
      case 'branch':
        stack.push({ block: control.when_false.target, live });
        stack.push({ block: control.when_true.target, live });
        break;
      case 'switch':
        for (const item of control.cases) stack.push({ block: item.edge.target, live });
        stack.push({ block: control.otherwise.target, live });
        break;
      case 'return':
        returns = true;
        break;
      case 'indirect':
        if (control.tail_call) {
          const target = tailTarget(block);
          if (target) tails.push(target);
          else unknown ??= 'unresolved tail target';
        } else unknown ??= `an indirect exit precedes any use (${control.reason})`;
        break;
      case 'trap':
        break;
      case 'unknown':
        unknown ??= control.reason;
        break;
    }
  }
  if (read) {
    const constructed = constructSSA(ir, {
      max_work: context.remainingWork?.() ?? context.budget.work,
      max_ir_nodes: context.budget.ir_nodes,
      max_blocks: context.budget.blocks,
      checkpoint: (work) => context.checkpoint(work),
    });
    if (constructed.state !== 'complete' || constructed.value.form !== 'ssa')
      return { kind: 'unknown', reason: 'window SSA construction stopped' };
    const ssa = constructed.value;
    const node = ssa.blocks
      .flatMap((block) => block.instructions)
      .find((item) => item.kind === 'call' && item.provenance.instruction_ids.includes(call.id));
    const demanded = node
      ? observeCallResultDemands(ssa, input.abi, context).semantic.get(node.id)
      : undefined;
    const registers = demanded?.filter((register) =>
      roots.some((root) => root.root === register.root),
    );
    return registers?.length
      ? { kind: 'semantic', registers }
      : { kind: 'unknown', reason: 'a result read has no consumer inside the window' };
  }
  if (unknown !== undefined) return { kind: 'unknown', reason: unknown };
  if (returns || tails.length) return { kind: 'forwarded', returns, tails };
  return { kind: 'dead' };
}

/** The constant target of a lifted tail exit block. */
function tailTarget(block: BasicBlock): Address | undefined {
  const control = block.terminator;
  if (control.kind !== 'indirect') return undefined;
  for (const node of block.instructions)
    if (
      node.kind === 'assign' &&
      node.result.id === control.target.id &&
      node.expression.kind === 'address'
    )
      return node.expression.address;
  return undefined;
}
