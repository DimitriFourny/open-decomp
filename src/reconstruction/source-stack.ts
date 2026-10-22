import {
  fingerprint,
  type AbiProfile,
  type OperationContext,
  type PresentationView,
  type RegisterDescriptor,
} from '../core/index.js';
import type { EmissionInput } from '../emitters/model.js';
import { classifyStackRegion } from '../analysis/stack/index.js';
import { instructionOperands, terminatorOperands } from '../analysis/effects/index.js';
import {
  bitWidth,
  expressionOperands,
  integer,
  sameType,
  type DataType,
  type Expression,
  type Instruction,
  type RegisterBinding,
  type Value,
} from '../ir/index.js';
import type { BlockRegion, ParallelTransfer } from '../presentation/index.js';
import type { BoundaryProjection } from './model.js';
import type {
  FrameMember,
  FrameSaves,
  IncomingObject,
  SourceLocal,
  SourceStackStorage,
  SourceVariadic,
} from './source-model.js';
import type { Requirement } from '../core/inference.js';
import { LocalValidationSession } from './local-validation.js';
import { type ForwardedByte, validateStackPromotion } from './local-storage-validation.js';
import { sourceRequirementPredicates } from './source-requirements.js';
import { classifyIndirectTails } from './source-tails.js';
import { classifySysvVaStart, classifyVariadicArea } from './source-variadic.js';

type MemoryNode = Extract<Instruction, { kind: 'load' | 'store' }>;
const FRAME_OBJECT_SCOPE =
  'frame bytes kept as memory print as one local frame object at their entry-SP offsets: one scalar member per exact (offset, width) access set, a transport access (copy, constant or zero initialization) wider than the members it covers printing as a cast at the member holding its first byte, byte arrays where other accesses overlap or a frame address is indexed or points inside, padding between; every load and store keeps its address, width, order and aliasing, nothing is forwarded';
const INCOMING_OBJECT_SCOPE =
  'incoming stack-argument bytes kept as memory print as one by-value struct formal at their entry-SP offsets: one scalar member per exact (offset, width) access set, a transport access (copy, constant or zero initialization) wider than the members it covers printing as a cast at the member holding its first byte, byte arrays where other accesses overlap or an address points inside, padding between; no exposure can designate incoming bytes and no frame escape is unbounded; no retained access spans the first incoming byte; every load and store keeps its address, width, order and aliasing, nothing is forwarded';
const FRAME_SAVE_PREMISE =
  'Frame save/restore elision assumes ABI conformance: callees preserve callee-saved registers and never write their caller’s frame outside outgoing argument storage, the saved slots are not stack arguments, and a frame address handed to a callee (or indexed from) designates its own object, never a save slot. Each hidden store and reload remains in the checked view and the original mappings.';
const ESCAPED_SLOT_SCOPE =
  'with no unbounded escape and no live entry SP, each escaped or indexed frame address reaches the bytes from the lowest offset it can take up to the lowest proven save slot above it (or the entry SP); overlapping reaches merge. A reach that is exactly one member, with no other access, taken address or indexed base inside it except at its start, is a local object of its own, declared outside the frame object and addressed as &local_N; the frame object keeps its other members and the reaches that hold them; every load and store keeps its address, width, order and aliasing, nothing is forwarded';
const ESCAPED_SLOT_PREMISE =
  'An escaped frame address reaches only bytes at or above the lowest entry-SP offset it can take (callees, memory holding the address and code reached through it never step below the address they were given), and, with a frame save above it, never the save slot (frame_save): the object it designates ends below that slot. A local declared on its own holds exactly such a reach, so no address derived from another frame object designates it, and no address derived from it designates another. Every load and store keeps its address, width, order and aliasing; the checked view keeps the entry-SP form.';
const SCALAR_BYTES = new Set([1n, 2n, 4n, 8n, 16n]);

/** Member layout of a source-view stack object at its entry-SP offsets.
 * One scalar member per exact (offset, width) access set. Overlapping accesses
 * keep the narrowest ones as scalar members when those are disjoint scalars
 * and no wider access starts or ends strictly inside one, every wider access
 * being a transport access (a copy or an initialization: a wide access over
 * two u32 members, or over a u32 and padding): the uncovered bytes of the
 * span are byte-array padding members, the wide access is spelled as a cast at
 * the member holding its first byte and sits in no member's `access_ids`. Any
 * other overlap, an address strictly inside a member or padding, and an
 * indexed base (with the accesses that continue it without a gap) form one
 * byte array; a taken address in a gap
 * starts a byte array that runs to the next member.
 * `below` (the frame): the object ends at `top` (the entry SP, or the
 * lowest byte of a save area that is wholly hidden saves) and its bottom is
 * lowered to a stack-aligned address; offsets at or above `top` are not
 * frame-object bytes and are ignored. `above` (the incoming area, S4): the object
 * starts at the first incoming byte (`returnAddressBytes`, stack-aligned by the
 * call) and ends at its last member; offsets below that byte are ignored, and a
 * taken address above every member starts a byte array to the next
 * `alignment` boundary. `va` (S7, `below` only): the entry-SP offset of the
 * SysV `va_list`, one 24-byte member that holds every access inside it. */
export function frameLayout(
  accesses: readonly {
    readonly offset: bigint;
    readonly end: bigint;
    readonly id: string;
    /** A transport access: it only moves bytes (a load whose every use is the
     * datum of a store, a store of a constant or a load result). */
    readonly transport?: boolean;
  }[],
  taken: readonly bigint[],
  indexed: ReadonlySet<bigint>,
  alignment: number,
  returnAddressBytes: bigint,
  direction: 'below' | 'above' = 'below',
  va?: bigint,
  top = 0n,
): { minimum_offset: bigint; size: bigint; members: FrameMember[] } {
  const unit = BigInt(alignment);
  const order = (left: bigint, right: bigint): number => (left < right ? -1 : left > right ? 1 : 0);
  type Cluster = { offset: bigint; end: bigint; scalar: boolean; access_ids: string[] };
  const skipped = (offset: bigint): boolean =>
    direction === 'below' ? offset >= top : offset < returnAddressBytes;
  const takenSorted = taken.filter((offset) => !skipped(offset)).sort(order),
    indexedSorted = [...indexed].filter((offset) => !skipped(offset)).sort(order);
  // First position of `list` (sorted) at or above `offset`.
  const lowerBound = (list: readonly bigint[], offset: bigint): number => {
    let low = 0,
      high = list.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (list[middle]! < offset) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  /** A group of overlapping accesses (sorted by offset, then end) that holds
   * several distinct intervals keeps its narrowest ones as scalar members when
   * those are disjoint scalars and no wider access starts or ends strictly
   * inside one: padding members fill the uncovered bytes of the span, and the
   * wide access is a cast at the member holding its first byte. Every wider
   * access must be a transport access (a copy, a zero or constant
   * initialization): a wide value that is computed on or dereferenced is a
   * slot of its own width. Null keeps the group one byte array. */
  const split = (
    group: readonly { offset: bigint; end: bigint; id: string; transport?: boolean }[],
  ): Cluster[] | null => {
    const distinct = group.filter(
      (access, index) =>
        index === 0 ||
        access.offset !== group[index - 1]!.offset ||
        access.end !== group[index - 1]!.end,
    );
    if (distinct.length < 2) return null;
    // Narrowest intervals: those containing no other distinct interval.
    const narrow: { offset: bigint; end: bigint }[] = [],
      wide: { offset: bigint; end: bigint }[] = [];
    let smallestEnd: bigint | undefined;
    for (let last = distinct.length - 1; last >= 0;) {
      let first = last;
      while (first > 0 && distinct[first - 1]!.offset === distinct[last]!.offset) first--;
      const lowest = distinct[first]!;
      if (smallestEnd === undefined || smallestEnd > lowest.end) narrow.push(lowest);
      else wide.push(lowest);
      for (let index = first + 1; index <= last; index++) wide.push(distinct[index]!);
      if (smallestEnd === undefined || lowest.end < smallestEnd) smallestEnd = lowest.end;
      last = first - 1;
    }
    narrow.reverse();
    if (!wide.length) return null;
    for (let index = 0; index < narrow.length; index++)
      if (
        !SCALAR_BYTES.has(narrow[index]!.end - narrow[index]!.offset) ||
        (index > 0 && narrow[index]!.offset < narrow[index - 1]!.end)
      )
        return null;
    // Whether a member strictly contains byte `offset` (so an access starting
    // or ending there would cut it).
    const cuts = (offset: bigint): boolean => {
      let low = 0,
        high = narrow.length - 1,
        before = -1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if (narrow[middle]!.offset < offset) {
          before = middle;
          low = middle + 1;
        } else high = middle - 1;
      }
      return before >= 0 && narrow[before]!.end > offset;
    };
    const spanStart = group[0]!.offset;
    let spanEnd = narrow.at(-1)!.end;
    for (const interval of wide) {
      if (
        !SCALAR_BYTES.has(interval.end - interval.offset) ||
        cuts(interval.offset) ||
        cuts(interval.end)
      )
        return null;
      if (interval.end > spanEnd) spanEnd = interval.end;
    }
    const narrowKeys = new Set(narrow.map((interval) => `${interval.offset}:${interval.end}`));
    if (
      group.some((access) => !narrowKeys.has(`${access.offset}:${access.end}`) && !access.transport)
    )
      return null;
    // Members tile the span: the narrow scalars, padding between them.
    const members: Cluster[] = [];
    let cursor = spanStart;
    const pad = (end: bigint) => {
      if (end > cursor) members.push({ offset: cursor, end, scalar: false, access_ids: [] });
    };
    for (const interval of narrow) {
      pad(interval.offset);
      members.push({
        offset: interval.offset,
        end: interval.end,
        scalar: true,
        access_ids: group
          .filter((access) => access.offset === interval.offset && access.end === interval.end)
          .map((access) => access.id),
      });
      cursor = interval.end;
    }
    pad(spanEnd);
    // An address taken inside a member or padding (not at its start), or an
    // indexed base inside the span, would need a byte array.
    const starts = new Set(members.map((member) => member.offset));
    for (
      let index = lowerBound(takenSorted, spanStart);
      index < takenSorted.length && takenSorted[index]! < spanEnd;
      index++
    )
      if (!starts.has(takenSorted[index]!)) return null;
    const indexedAt = lowerBound(indexedSorted, spanStart);
    if (indexedAt < indexedSorted.length && indexedSorted[indexedAt]! < spanEnd) return null;
    return members;
  };
  const clusters: Cluster[] = [];
  // The `va_list` bytes (S7) are an access of their own (no id); the member
  // merge below makes them one member.
  const reserved = va === undefined ? [] : [{ offset: va, end: va + 24n, id: '' }];
  const sorted = [...accesses, ...reserved].sort(
    (left, right) => order(left.offset, right.offset) || order(left.end, right.end),
  );
  for (let first = 0; first < sorted.length;) {
    let last = first + 1,
      end = sorted[first]!.end;
    while (last < sorted.length && sorted[last]!.offset < end) {
      if (sorted[last]!.end > end) end = sorted[last]!.end;
      last++;
    }
    const group = sorted.slice(first, last),
      offset = group[0]!.offset;
    clusters.push(
      ...(split(group) ?? [
        {
          offset,
          end,
          scalar:
            SCALAR_BYTES.has(end - offset) &&
            group.every((access) => access.offset === offset && access.end === end),
          access_ids: group.flatMap((access) => (access.id ? [access.id] : [])),
        },
      ]),
    );
    first = last;
  }
  // Index of the cluster holding byte `offset`, or -1.
  const containing = (offset: bigint): number => {
    for (let low = 0, high = clusters.length - 1; low <= high;) {
      const middle = (low + high) >> 1,
        cluster = clusters[middle]!;
      if (offset < cluster.offset) high = middle - 1;
      else if (offset >= cluster.end) low = middle + 1;
      else return middle;
    }
    return -1;
  };
  const gaps = new Set<bigint>();
  for (const offset of taken) {
    if (skipped(offset)) continue;
    const index = containing(offset);
    if (index < 0) gaps.add(offset);
    else if (clusters[index]!.offset !== offset) clusters[index]!.scalar = false;
  }
  for (const offset of indexed) {
    if (skipped(offset)) continue;
    const index = containing(offset);
    if (index < 0) {
      gaps.add(offset);
      continue;
    }
    const cluster = clusters[index]!;
    cluster.scalar = false;
    while (clusters[index + 1]?.offset === cluster.end) {
      cluster.end = clusters[index + 1]!.end;
      cluster.access_ids.push(...clusters[index + 1]!.access_ids);
      clusters.splice(index + 1, 1);
    }
  }
  let members: FrameMember[] = clusters.map((cluster) => ({
    offset: cluster.offset,
    size: cluster.end - cluster.offset,
    scalar: cluster.scalar,
    access_ids: cluster.access_ids,
  }));
  const starts = [...gaps].sort(order);
  for (let index = 0, next = 0; index < starts.length; index++) {
    const start = starts[index]!;
    while (next < clusters.length && clusters[next]!.offset <= start) next++;
    let end = starts[index + 1];
    if (next < clusters.length && (end === undefined || clusters[next]!.offset < end))
      end = clusters[next]!.offset;
    end ??= direction === 'below' ? top : start + unit - ((start - returnAddressBytes) % unit);
    members.push({ offset: start, size: end - start, scalar: false, access_ids: [] });
  }
  members.sort((left, right) => order(left.offset, right.offset));
  if (va !== undefined) {
    // Every member over the `va_list` bytes is the one `va` member.
    const inside = members.filter(
      (member) => member.offset < va + 24n && member.offset + member.size > va,
    );
    const start = inside.reduce((low, member) => (member.offset < low ? member.offset : low), va),
      end = inside.reduce(
        (high, member) => (member.offset + member.size > high ? member.offset + member.size : high),
        va + 24n,
      );
    members = [
      ...members.filter((member) => !inside.includes(member)),
      {
        offset: start,
        size: end - start,
        scalar: false,
        access_ids: inside.flatMap((member) => member.access_ids),
        ...(start === va && end === va + 24n ? { va: true as const } : {}),
      },
    ].sort((left, right) => order(left.offset, right.offset));
  }
  if (direction === 'above') {
    // Members are sorted and disjoint: the last one ends the object.
    const last = members.at(-1);
    return {
      minimum_offset: returnAddressBytes,
      size: last ? last.offset + last.size - returnAddressBytes : 0n,
      members,
    };
  }
  const lowest = (members[0]?.offset ?? top) + returnAddressBytes,
    minimum = lowest - (((lowest % unit) + unit) % unit) - returnAddressBytes;
  return { minimum_offset: minimum, size: top - minimum, members };
}

/** A memory access at a known entry-SP offset; `key` is `offset:end`. */
export interface FrameAccess {
  readonly node: MemoryNode;
  readonly block: string;
  readonly offset: bigint;
  readonly end: bigint;
  readonly key: string;
}
/** Exact bits `[low, low + width)` of one entry register root. */
export interface EntryBits {
  readonly root: string;
  readonly low: number;
  readonly width: number;
}
/** A frame-private save of entry-register bits and the reloads restoring it. */
export interface FrameSave {
  readonly key: string;
  readonly save: FrameAccess & { readonly node: Extract<MemoryNode, { kind: 'store' }> };
  readonly loads: readonly FrameAccess[];
  readonly bits: EntryBits;
}
export interface FrameSaveQualifier {
  /** The slots that qualify as saves when every block of `exits` must restore
   * them, in slot order. `accept`, when given, decides each qualifying slot
   * before the next one is examined, so expressions it rewrites (reload
   * aliases) are visible to later slots; without it the check changes nothing. */
  qualify(exits: readonly BlockRegion[], accept?: (save: FrameSave) => boolean): FrameSave[];
  /** Every binding of `bits`'s root at `exit` that overlaps `bits` holds
   * exactly its bits, from reloads of `members` or as the unmodified entry
   * value, and together they cover `bits`. */
  restores(exit: BlockRegion, bits: EntryBits, members: ReadonlySet<string>): boolean;
}

/** Source view: frame-private save/restore of an entry register, qualified
 * against an explicit exit list. A slot is a save when (i) its only store
 * writes the entry value of a preserved register or the link register, (ii)
 * every given exit restores that register from a dominated load of exactly
 * this slot and no other access overlaps it, (iii) no stack address of it
 * escapes and (iv) it is not established outgoing argument storage. Under ABI
 * conformance callees never write it, so each reload equals the saved value and
 * neither access is source-observable. The caller checks that the frame as a
 * whole is not exposed. */
export function frameSaveQualifier(
  facts: {
    readonly accesses: readonly FrameAccess[];
    readonly groups: ReadonlyMap<string, readonly FrameAccess[]>;
    readonly exposedOffsets: ReadonlySet<bigint>;
    readonly outgoingRanges: readonly { readonly start: bigint; readonly end: bigint }[];
    readonly entry: BlockRegion;
    /** Read at each use: aliases applied by an accepted save are visible. */
    readonly expressions: ReadonlyMap<string, Expression>;
    readonly incoming: ReadonlyMap<string, readonly Value[]>;
    readonly dominates: (first: FrameAccess, second: FrameAccess) => boolean;
    readonly abi: AbiProfile;
  },
  context: OperationContext,
): FrameSaveQualifier {
  const { accesses, expressions, incoming, abi } = facts;
  let entryCells: ReadonlyMap<string, RegisterDescriptor> | undefined,
    loadsByResult: ReadonlyMap<string, string> | undefined;
  const indexes = () => {
    if (!entryCells || !loadsByResult) {
      entryCells = new Map(
        facts.entry.register_entry.map((binding) => [binding.value.id, binding.register]),
      );
      const loads = new Map<string, string>();
      for (const access of accesses)
        if (access.node.kind === 'load') loads.set(access.node.result.id, access.node.id);
      loadsByResult = loads;
    }
    return { entryCells, loadsByResult };
  };
  // Exact entry bits through bitcasts, extracts and ordered concatenation only.
  const entryBits = (value: Value, depth = 0): EntryBits | null => {
    context.checkpoint(1);
    const cell = indexes().entryCells.get(value.id);
    if (cell) return { root: cell.root, low: cell.offset_bits, width: cell.width_bits };
    const expression = depth < 16 ? expressions.get(value.id) : undefined;
    const width = bitWidth(value.type);
    if (expression?.kind === 'cast' && expression.op === 'bitcast')
      return bitWidth(expression.value.type) === width
        ? entryBits(expression.value, depth + 1)
        : null;
    if (expression?.kind === 'extract') {
      const inner = entryBits(expression.value, depth + 1);
      return inner && expression.offset + width <= inner.width
        ? { root: inner.root, low: inner.low + expression.offset, width }
        : null;
    }
    if (expression?.kind === 'concat') {
      let result: EntryBits | null = null;
      for (const part of expression.values) {
        const bits = entryBits(part, depth + 1);
        if (!bits) return null;
        if (!result) result = bits;
        else if (bits.root === result.root && bits.low === result.low + result.width)
          result = { root: result.root, low: result.low, width: result.width + bits.width };
        else return null;
      }
      return result;
    }
    return null;
  };
  // Bit offset within a reload of `members` on every incoming path, or null.
  // An unmodified entry value of the saved register equals the reload at the
  // same bit position (the slot holds exactly the saved entry bits), so a
  // shrink-wrapped save that some path never executes still restores.
  const reloadBits = (
    value: Value,
    members: ReadonlySet<string>,
    active: Set<string>,
    saved: EntryBits,
    depth = 0,
  ): number | null => {
    context.checkpoint(1);
    const load = indexes().loadsByResult.get(value.id);
    if (load !== undefined) return members.has(load) ? 0 : null;
    const unmodified = entryBits(value);
    if (unmodified)
      return unmodified.root === saved.root &&
        unmodified.low >= saved.low &&
        unmodified.low + unmodified.width <= saved.low + saved.width
        ? unmodified.low - saved.low
        : null;
    if (depth >= 32 || active.has(value.id)) return null;
    const expression = expressions.get(value.id);
    if (expression?.kind === 'cast' && expression.op === 'bitcast')
      return bitWidth(expression.value.type) === bitWidth(value.type)
        ? reloadBits(expression.value, members, active, saved, depth + 1)
        : null;
    if (expression?.kind === 'extract') {
      const inner = reloadBits(expression.value, members, active, saved, depth + 1);
      return inner === null ? null : inner + expression.offset;
    }
    if (expression?.kind === 'concat') {
      let start: number | null = null,
        width = 0;
      for (const part of expression.values) {
        const offset = reloadBits(part, members, active, saved, depth + 1);
        if (offset === null) return null;
        if (start === null) start = offset;
        else if (offset !== start + width) return null;
        width += bitWidth(part.type);
      }
      return width === bitWidth(value.type) ? start : null;
    }
    const sources = expression ? undefined : incoming.get(value.id);
    if (!sources?.length) return null;
    active.add(value.id);
    let result: number | null | undefined;
    for (const source of sources) {
      const bits = reloadBits(source, members, active, saved, depth + 1);
      if (bits === null || (result !== undefined && result !== bits)) {
        result = null;
        break;
      }
      result = bits;
    }
    active.delete(value.id);
    return result ?? null;
  };
  const restores = (exit: BlockRegion, bits: EntryBits, members: ReadonlySet<string>): boolean => {
    let covered = 0;
    for (const binding of exit.register_exit) {
      const register = binding.register;
      if (
        register.root !== bits.root ||
        register.offset_bits + register.width_bits <= bits.low ||
        register.offset_bits >= bits.low + bits.width
      )
        continue;
      if (
        register.offset_bits < bits.low ||
        register.offset_bits + register.width_bits > bits.low + bits.width ||
        reloadBits(binding.value, members, new Set(), bits) !== register.offset_bits - bits.low
      )
        return false;
      covered += register.width_bits;
    }
    return covered === bits.width;
  };
  const qualify = (
    exits: readonly BlockRegion[],
    accept?: (save: FrameSave) => boolean,
  ): FrameSave[] => {
    const saves: FrameSave[] = [];
    for (const [key, group] of facts.groups) {
      context.checkpoint(group.length);
      const first = group[0]!;
      const stores = group.filter((access) => access.node.kind === 'store'),
        loads = group.filter((access) => access.node.kind === 'load');
      const save = stores[0],
        saved = save?.node.kind === 'store' ? save.node : null;
      if (
        !save ||
        !saved ||
        stores.length !== 1 ||
        !loads.length ||
        first.offset >= 0n ||
        first.end > 0n ||
        group.some(
          (access) =>
            access.node.access.volatile ||
            access.node.access.endian !== saved.access.endian ||
            (access.node.kind === 'load' && !sameType(access.node.result.type, saved.value.type)),
        ) ||
        accesses.some(
          (access) => access.key !== key && access.offset < first.end && access.end > first.offset,
        ) ||
        [...facts.exposedOffsets].some((offset) => offset >= first.offset && offset < first.end) ||
        facts.outgoingRanges.some((range) => range.start < first.end && range.end > first.offset)
      )
        continue;
      const bits = entryBits(saved.value);
      if (
        !bits ||
        bits.width !== bitWidth(saved.value.type) ||
        !(
          abi.link_register?.root === bits.root ||
          abi.preserved.some(
            (register) =>
              register.root === bits.root &&
              register.offset_bits <= bits.low &&
              register.offset_bits + register.width_bits >= bits.low + bits.width,
          )
        ) ||
        loads.some((load) => !facts.dominates(save, load))
      )
        continue;
      const members = new Set(loads.map((load) => load.node.id));
      if (!exits.every((exit) => restores(exit, bits, members))) continue;
      const found: FrameSave = { key, save: { ...save, node: saved }, loads, bits };
      if (!accept || accept(found)) saves.push(found);
    }
    return saves;
  };
  return { qualify, restores };
}

/** Exact private slots only. Escapes and overlapping access intervals retain one
 * shared frame; promoting a slot never changes an observable memory operation. */
export function planSourceStack(
  input: EmissionInput,
  blocks: ReadonlyMap<string, BlockRegion>,
  expressions: Map<string, Expression>,
  transfers: readonly { transfer: ParallelTransfer; block: BlockRegion }[],
  calls: Map<string, BoundaryProjection>,
  returns: ReadonlyMap<string, BoundaryProjection>,
  alias: (value: Value, expression: Expression) => void,
  /** A source-only value, defined in `block` by `expression`. */
  make: (key: string, type: DataType, block: string, expression?: Expression) => Value,
  context: OperationContext,
  incomingStack: (offset: bigint, type: DataType, contributors: readonly Value[]) => Value | null,
  entryStack: () => Value,
  /** Source view (S4): the struct formal of the incoming object starting at
   * entry-SP `offset` whose kept bytes end at `end`, or null when the
   * interface cannot gain one. */
  incomingObject: (offset: bigint, end: bigint) => Value | null,
  validation = new LocalValidationSession(context),
  view: PresentationView = 'checked',
  requirements?: readonly Requirement[],
  /** Source view: the planner's callee-side variadic interface (`...`). */
  variadic?: {
    /** The named formals of these argument registers, in order; null when
     * a register has no formal or a declaration names other ones. */
    readonly named: (registers: readonly RegisterDescriptor[]) => readonly Value[] | null;
    /** Commits `...`: creates the `va` area value at entry-SP `offset`. */
    readonly area: (offset: bigint, named: readonly Value[] | null) => Value | null;
    /** Commits `...` after exactly these named formals (SysV `va_list`), the
     * first anonymous stack argument at entry-SP `overflow`. */
    readonly list: (named: readonly Value[], overflow: bigint) => boolean;
  },
) {
  const addresses = new Map<string, bigint>(),
    facts = input.types?.calls?.stack;
  if (facts?.state === 'complete')
    for (const [id, fact] of facts.values)
      if (fact.value.kind === 'stack') addresses.set(id, fact.value.offset);
  const entry = blocks.get(input.function.entry)!;
  for (const binding of entry.register_entry)
    if (
      binding.register.root === input.source!.abi.stack_pointer.root &&
      binding.register.width_bits === input.source!.abi.stack_pointer.width_bits
    )
      addresses.set(binding.value.id, 0n);
  // A bounded monotone affine pass also supports synthetic source callers that
  // do not carry the native stack analysis. Conflicting phis never get an offset.
  const incoming = new Map<string, Value[]>();
  for (const { transfer } of transfers)
    for (const copy of transfer.copies) {
      const row = incoming.get(copy.destination.id) ?? [];
      row.push(copy.source);
      incoming.set(copy.destination.id, row);
    }
  // The value whose low-to-high extracts `parts` tile exactly, or null.
  const recombined = (parts: readonly Value[]): Value | null => {
    let base: Value | null = null,
      width = 0;
    for (const part of parts) {
      const expression = expressions.get(part.id);
      if (
        expression?.kind !== 'extract' ||
        expression.offset !== width ||
        (base !== null && base.id !== expression.value.id)
      )
        return null;
      base = expression.value;
      width += bitWidth(part.type);
    }
    return base && width === bitWidth(base.type) ? base : null;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, expression] of expressions) {
      context.checkpoint(1);
      if (addresses.has(id)) continue;
      let offset: bigint | undefined;
      if (expression.kind === 'cast' && expression.op === 'bitcast')
        offset = addresses.get(expression.value.id);
      else if (expression.kind === 'concat') {
        // Register-cell halves of one value, recombined in order, are that value.
        const whole = recombined(expression.values);
        if (whole) offset = addresses.get(whole.id);
      } else if (
        expression.kind === 'integer' &&
        (expression.op === 'add' || expression.op === 'sub')
      ) {
        const base = addresses.get(expression.left.id),
          constant = expressions.get(expression.right.id);
        if (base !== undefined && constant?.kind === 'constant')
          offset =
            base +
            (expression.op === 'add' ? 1n : -1n) *
              BigInt.asIntN(bitWidth(expression.right.type), constant.bits);
      }
      if (offset !== undefined) {
        addresses.set(id, offset);
        changed = true;
      }
    }
    for (const [id, sources] of incoming) {
      context.checkpoint(1);
      if (addresses.has(id) || !sources.length) continue;
      const offset = addresses.get(sources[0]!.id);
      if (offset !== undefined && sources.every((value) => addresses.get(value.id) === offset)) {
        addresses.set(id, offset);
        changed = true;
      }
    }
  }
  const tainted = new Set(addresses.keys());
  const memory = [...blocks.values()].flatMap((block) =>
    block.statements.filter(
      (node): node is MemoryNode => node.kind === 'load' || node.kind === 'store',
    ),
  );
  // Index the bounded access widths, not every store against every load.
  // Byte membership preserves partial overlaps and differently sized accesses.
  const storesByByte = new Map<bigint, Extract<MemoryNode, { kind: 'store' }>[]>();
  for (const node of memory) {
    context.checkpoint(1);
    if (node.kind !== 'store') continue;
    const offset = addresses.get(node.address.id);
    if (offset === undefined) continue;
    const end = offset + BigInt(Math.ceil(bitWidth(node.value.type) / 8));
    for (let byte = offset; byte < end; byte++) {
      context.checkpoint(1);
      const row = storesByByte.get(byte) ?? [];
      row.push(node);
      storesByByte.set(byte, row);
    }
  }
  const memoryDependencies = new Map<string, Value[]>(),
    dependenciesByRange = new Map<string, Value[]>(),
    // Ranges every overlapping store writes exactly: a reload there holds one
    // whole stored value, never bytes combined from several stores.
    exactRanges = new Set<string>(),
    rangeOfLoad = new Map<string, string>();
  for (const load of memory) {
    context.checkpoint(1);
    if (load.kind !== 'load') continue;
    const offset = addresses.get(load.address.id);
    if (offset === undefined) continue;
    const end = offset + BigInt(Math.ceil(bitWidth(load.result.type) / 8)),
      key = `${offset}:${end}`;
    let sources = dependenciesByRange.get(key);
    if (!sources) {
      const stores = new Set<Extract<MemoryNode, { kind: 'store' }>>();
      for (let byte = offset; byte < end; byte++) {
        context.checkpoint(1);
        for (const store of storesByByte.get(byte) ?? []) {
          context.checkpoint(1);
          stores.add(store);
        }
      }
      sources = [];
      let exact = true;
      for (const store of stores) {
        context.checkpoint(1);
        sources.push(store.value);
        if (
          addresses.get(store.address.id) !== offset ||
          bitWidth(store.value.type) !== bitWidth(load.result.type)
        )
          exact = false;
      }
      if (exact) exactRanges.add(key);
      dependenciesByRange.set(key, sources);
    }
    memoryDependencies.set(load.result.id, sources);
    rangeOfLoad.set(load.result.id, key);
  }
  changed = true;
  while (changed) {
    changed = false;
    for (const [id, expression] of expressions) {
      context.checkpoint(1);
      if (
        !tainted.has(id) &&
        expressionOperands(expression).some((value) => tainted.has(value.id))
      ) {
        tainted.add(id);
        changed = true;
      }
    }
    for (const [id, sources] of incoming)
      if (!tainted.has(id) && sources.some((value) => tainted.has(value.id))) {
        tainted.add(id);
        changed = true;
      }
    for (const [id, sources] of memoryDependencies)
      if (!tainted.has(id) && sources.some((value) => tainted.has(value.id))) {
        context.checkpoint(1);
        tainted.add(id);
        changed = true;
      }
  }
  let escaped = false,
    unknownCallStorage = false,
    // Frame saves rest on ABI conformance: an unresolved callee reads only
    // argument registers/stack and never writes its caller's frame. For frame
    // saves only an address of unknown offset exposes the whole frame
    // (`frameExposed`); an escaped address of known offset designates its own
    // object, never a compiler-owned save slot elsewhere.
    frameExposed = view !== 'source',
    // Source-view promotion is per slot. An escaped frame address reaches only
    // bytes at or above the lowest entry-SP offset it can take
    // (`frame_object_base`): the stack grows downward, so an object designated
    // by an escaped pointer extends toward the entry SP and the caller frame.
    // Every byte at or above `reachFloor` may be reached; `reachAll` records an
    // escape without a lower bound (unknown effects, unbounded arithmetic).
    reachFloor: bigint | undefined,
    // Source view (S1): the lowest floor among exposures that can designate
    // incoming argument storage, i.e. whose known bases include an offset >= 0
    // (mixed-sign phis and spill/reload sources included), whose bases are
    // unknown, or whose floor itself lies at or above the entry SP. Exposures
    // here are call arguments and open-call argument registers, stored and
    // returned addresses, indirect-exit arguments, and the address operands of
    // indexed or dynamic loads and stores. Every incoming byte below it is
    // reached by no address derived from this activation's incoming area;
    // callers, callees, globals and loaded or returned pointers cannot designate
    // it under the `incoming_arguments_private` premise. Undefined: no such
    // exposure. Unbounded exposures set `reachAll` instead. Incoming slots
    // wholly below it are entry values for the whole activation when only
    // loaded (incoming formals); later items (frame object, reloaded stack
    // addresses, by-value aggregates, va_start) use the same bound.
    incomingFloor: bigint | undefined,
    reachAll = false;
  const exposedOffsets = new Set<bigint>(),
    // Source view: floors of exposures derived from the incoming area alone:
    // every base is known and at or above the entry SP (a pointer into the
    // incoming arguments, stepped or indexed).
    incomingBased = new Set<bigint>(),
    // Source view (A3): the floor of every bounded exposure, true when the
    // exposure's only base is the floor itself (an exact address, or one
    // stepped by nonnegative index addends), so every address it can take
    // lies in the object holding that base.
    escapeFloors = new Map<bigint, boolean>();
  // Known frame offsets of every address a tainted value is derived from (cell
  // halves, indexed/phi'd pointers, pointers spilled to the frame and reloaded),
  // or null when some tainted leaf has no known origin.
  const baseOffsets = (start: Value): bigint[] | null => {
    const bases = new Set<bigint>(),
      seen = new Set<string>(),
      pending = [start];
    while (pending.length) {
      context.checkpoint(1);
      const value = pending.pop()!;
      if (seen.has(value.id) || !tainted.has(value.id)) continue;
      seen.add(value.id);
      const offset = addresses.get(value.id);
      if (offset !== undefined) {
        bases.add(offset);
        continue;
      }
      const expression = expressions.get(value.id);
      if (expression) pending.push(...expressionOperands(expression));
      else {
        const sources = incoming.get(value.id) ?? memoryDependencies.get(value.id);
        if (!sources?.length) return null;
        pending.push(...sources);
      }
    }
    return [...bases];
  };
  // Number of low bits that can be nonzero; fewer than the width means the
  // value is a nonnegative two's-complement addend.
  const significantBits = (value: Value, depth = 0): number => {
    const width = bitWidth(value.type),
      expression = depth < 8 ? expressions.get(value.id) : undefined;
    if (!expression) return width;
    const bits = (operand: Value): number => significantBits(operand, depth + 1);
    const constant = (operand: Value): bigint | undefined => {
      const found = expressions.get(operand.id);
      return found?.kind === 'constant'
        ? BigInt.asUintN(bitWidth(operand.type), found.bits)
        : undefined;
    };
    switch (expression.kind) {
      case 'constant':
        return BigInt.asUintN(width, expression.bits).toString(2).replace(/^0$/, '').length;
      case 'cast':
        return expression.op === 'zero_extend' || expression.op === 'bitcast'
          ? Math.min(width, bits(expression.value))
          : width;
      case 'concat': {
        let low = 0,
          result = 0;
        for (const part of expression.values) {
          const used = bits(part);
          if (used) result = low + used;
          low += bitWidth(part.type);
        }
        return Math.min(width, result);
      }
      case 'integer': {
        const shift = constant(expression.right);
        switch (expression.op) {
          case 'and':
            return Math.min(bits(expression.left), bits(expression.right));
          case 'add':
            return Math.min(width, Math.max(bits(expression.left), bits(expression.right)) + 1);
          case 'mul':
            return Math.min(width, bits(expression.left) + bits(expression.right));
          case 'shl':
            return shift !== undefined && shift < BigInt(width)
              ? Math.min(width, bits(expression.left) + Number(shift))
              : width;
          case 'lshr':
            return shift !== undefined && shift < BigInt(width)
              ? Math.max(0, bits(expression.left) - Number(shift))
              : width;
          default:
            return width;
        }
      }
      default:
        return width;
    }
  };
  // Lowest entry-SP offset each tainted value can take; null when unbounded
  // below, absent when it cannot carry a frame address (a comparison result).
  // Exact offsets, constant steps, nonnegative (zero-extended, masked or
  // shifted) index addends, cell halves, phis and spill/reload sources keep a
  // bound. Any other derivation, or a cycle that keeps lowering it, loses it.
  const floors = new Map<string, bigint | null>();
  if (view === 'source') {
    const lower = (left: bigint | null | undefined, right: bigint | null | undefined) =>
      left === undefined
        ? right
        : right === undefined
          ? left
          : left === null || right === null
            ? null
            : left < right
              ? left
              : right;
    const floorOf = (value: Value): bigint | null | undefined =>
      tainted.has(value.id) ? floors.get(value.id) : undefined;
    const derive = (id: string): bigint | null | undefined => {
      const offset = addresses.get(id);
      if (offset !== undefined) return offset;
      const expression = expressions.get(id);
      if (expression) {
        switch (expression.kind) {
          case 'compare':
          case 'float_compare':
            return undefined;
          case 'cast':
            return expression.op === 'truncate' ||
              expression.op === 'zero_extend' ||
              expression.op === 'sign_extend' ||
              expression.op === 'bitcast'
              ? floorOf(expression.value)
              : null;
          case 'extract':
            return floorOf(expression.value);
          case 'concat': {
            const whole = recombined(expression.values);
            return whole ? floorOf(whole) : null;
          }
          case 'select':
            return tainted.has(expression.when_true.id) || tainted.has(expression.when_false.id)
              ? lower(floorOf(expression.when_true), floorOf(expression.when_false))
              : undefined;
          case 'integer': {
            if (expression.op !== 'add' && expression.op !== 'sub') return null;
            const left = tainted.has(expression.left.id),
              right = tainted.has(expression.right.id);
            if (left === right || (expression.op === 'sub' && right)) return null;
            const base = left ? expression.left : expression.right,
              step = left ? expression.right : expression.left,
              floor = floorOf(base);
            if (floor === null || floor === undefined) return floor;
            const constant = expressions.get(step.id);
            if (constant?.kind === 'constant') {
              const amount = BigInt.asIntN(bitWidth(step.type), constant.bits);
              return floor + (expression.op === 'add' ? amount : -amount);
            }
            return expression.op === 'add' && significantBits(step) < bitWidth(step.type)
              ? floor
              : null;
          }
          default:
            return null;
        }
      }
      const phi = incoming.get(id);
      if (phi?.length) {
        let result: bigint | null | undefined;
        for (const source of phi) result = lower(result, floorOf(source));
        return result;
      }
      const stored = memoryDependencies.get(id);
      if (stored?.length) {
        // A reload combining bytes of several stores holds only some bits of a
        // stored address: no bound.
        if (!exactRanges.has(rangeOfLoad.get(id)!)) return null;
        let result: bigint | null | undefined;
        for (const source of stored) result = lower(result, floorOf(source));
        return result;
      }
      return null;
    };
    // Unvisited operands are optimistic until reached; after eight passes a
    // value whose bound still drops (a lowering cycle) becomes unbounded.
    for (let pass = 0, moved = true; moved; pass++) {
      moved = false;
      for (const id of tainted) {
        context.checkpoint(1);
        const previous = floors.get(id);
        if (previous === null) continue;
        let next = derive(id);
        if (next === undefined) continue;
        if (previous !== undefined && next !== null) {
          if (next >= previous) continue;
          if (pass >= 8) next = null;
        }
        floors.set(id, next);
        moved = true;
      }
    }
  }
  /** Records an escape of `value`; returns its known frame base offsets. */
  const expose = (value: Value): readonly bigint[] | null => {
    if (!tainted.has(value.id)) return [];
    const bases = baseOffsets(value);
    if (bases) for (const offset of bases) exposedOffsets.add(offset);
    else frameExposed = true;
    if (view !== 'source' || !floors.has(value.id)) {
      const expression = expressions.get(value.id);
      if (expression?.kind !== 'compare' && expression?.kind !== 'float_compare') reachAll = true;
      return bases;
    }
    const floor = floors.get(value.id)!;
    if (floor === null) reachAll = true;
    else {
      if (reachFloor === undefined || floor < reachFloor) reachFloor = floor;
      escapeFloors.set(
        floor,
        (escapeFloors.get(floor) ?? true) && bases?.length === 1 && bases[0] === floor,
      );
      if (bases === null || floor >= 0n || bases.some((offset) => offset >= 0n)) {
        if (incomingFloor === undefined || floor < incomingFloor) incomingFloor = floor;
        if (bases?.length && bases.every((offset) => offset >= 0n)) incomingBased.add(floor);
      }
    }
    return bases;
  };
  // Source view: frame offsets that dynamically indexed accesses derive from.
  const indexedBases = new Set<bigint>();
  const abi = input.source!.abi;
  const preservedRoot = (root: string): boolean =>
    abi.preserved.some((register) => register.root === root);
  // Condition flags are never argument or result storage under any supported
  // ABI; flags computed from frame arithmetic do not hand a callee an address.
  const argumentBindings = (bindings: readonly RegisterBinding[]): RegisterBinding[] =>
    bindings.filter(
      (binding) =>
        binding.register.root !== abi.stack_pointer.root &&
        binding.register.bank !== 'flags' &&
        !preservedRoot(binding.register.root) &&
        tainted.has(binding.value.id),
    );
  // Validate closure before classifying outgoing storage: a fully analyzed
  // register-only callee cannot observe private spills merely because the caller
  // wrote them. Refused presentation records keep the conservative open area.
  if (view === 'source')
    for (const block of blocks.values())
      for (const node of block.statements) {
        if (node.kind !== 'call') continue;
        const projection = calls.get(node.id)!;
        const closure = input.source?.source_callees?.find(
          (callee) => callee.call_id === node.id,
        )?.argument_list_closure;
        if (
          projection.kind === 'inferred' &&
          projection.argument_list_complete === true &&
          !validation.presentation(
            'arity_closure',
            node.id,
            closure === 'library_contract'
              ? 'library_contract: complete native reads propagated through established import-tail contracts prove a register-only interface; caller frame writes cannot supply additional arguments'
              : closure === 'objc_selector'
                ? 'objc_selector: the statically resolved selector fixes the keyword argument count; argument classes follow its unique image type encoding or integer/pointer class, and the caller prepares no further argument register'
                : 'callee_reads: complete nonrecursive native summary reads only the observed register prefix, no incoming stack and no escaping incoming-stack address; caller frame writes cannot supply additional arguments',
            [node.id],
          )
        )
          calls.set(node.id, { ...projection, argument_list_complete: false });
        if (closure === 'library_contract' && calls.get(node.id)!.argument_list_complete === true)
          validation.requireAbi(
            'arity_closure',
            [node.id],
            'Native closure through imported tail contracts assumes the established library interface and ABI-conforming arguments and results; incomplete dependencies and unresolved targets stay open.',
          );
        if (closure === 'objc_selector' && calls.get(node.id)!.argument_list_complete === true)
          validation.requireAbi(
            'arity_closure',
            [node.id],
            'Objective-C selector closure assumes the receiver implements a non-variadic method for the selector with the assumed argument classes; known variadic selectors and unresolved selectors stay open.',
          );
      }
  const openArguments = (projection: BoundaryProjection): boolean =>
    projection.kind !== 'source' &&
    !(view === 'source' && projection.argument_list_complete === true);
  const callNodes: Extract<Instruction, { kind: 'call' }>[] = [];
  const accesses: { node: MemoryNode; block: string; offset: bigint; end: bigint; key: string }[] =
    [];
  // Source view: as in the source signature, an FP-environment guard's failure
  // arm is not executed under its recorded fp_environment requirement, and its
  // unknown exit ends modeled execution. Its unknown effect is no frame escape.
  const fpFailureArms = new Set<string>();
  if (view === 'source') {
    const predicates = sourceRequirementPredicates(requirements),
      entries = new Map<string, number>();
    for (const { transfer } of transfers)
      entries.set(transfer.target, (entries.get(transfer.target) ?? 0) + 1);
    for (const block of blocks.values()) {
      context.checkpoint(1);
      const control = block.control,
        predicate = control.kind === 'if' ? predicates.get(control.id) : undefined;
      if (control.kind !== 'if' || predicate?.requirement.kind !== 'fp_environment') continue;
      const failure = (
        predicate.site.supported_predicate_value ? control.when_false : control.when_true
      ).transfer.target;
      if (entries.get(failure) === 1 && blocks.get(failure)?.control.kind === 'unknown')
        fpFailureArms.add(failure);
    }
  }
  const guardEffects = new Set<string>();
  for (const block of blocks.values()) {
    for (const node of block.statements) {
      context.checkpoint(1);
      if (node.kind === 'call') {
        callNodes.push(node);
        const projection = calls.get(node.id)!;
        for (const value of projection.arguments) expose(value);
        if (openArguments(projection))
          for (const binding of argumentBindings(node.register_inputs)) expose(binding.value);
      }
      if (node.kind === 'call' && openArguments(calls.get(node.id)!)) unknownCallStorage = true;
      if (
        node.kind === 'call' &&
        (calls.get(node.id)!.kind === 'physical' ||
          calls.get(node.id)!.arguments.some((value) => tainted.has(value.id)))
      )
        escaped = true;
      if (node.kind === 'unknown_effect') {
        escaped = true;
        if (fpFailureArms.has(block.id)) guardEffects.add(block.id);
        else reachAll = frameExposed = true;
      }
      if (node.kind !== 'load' && node.kind !== 'store') continue;
      const offset = addresses.get(node.address.id),
        width = bitWidth(node.kind === 'load' ? node.result.type : node.value.type);
      if (
        node.kind === 'store' &&
        tainted.has(node.value.id) &&
        (offset === undefined || offset >= 0n)
      ) {
        escaped = true;
        expose(node.value);
      }
      if (offset === undefined && tainted.has(node.address.id)) {
        escaped = true;
        const bases = expose(node.address);
        if (view === 'source') for (const base of bases ?? []) indexedBases.add(base);
      }
      if (offset === undefined || width % 8) continue;
      const end = offset + BigInt(width / 8);
      accesses.push({ node, block: block.id, offset, end, key: `${offset}:${end}` });
    }
    if (
      block.control.kind === 'return' &&
      returns.get(block.control.id)!.results.some((value) => tainted.has(value.id))
    ) {
      escaped = true;
      for (const value of returns.get(block.control.id)!.results) expose(value);
    }
    // Like private promotion, unmodeled exits do not observe frame-private
    // bytes; an indirect target may still receive a stack address as argument.
    if (block.control.kind === 'indirect')
      for (const binding of argumentBindings(block.register_exit)) expose(binding.value);
  }
  for (const id of guardEffects)
    if (
      frameExposed ||
      !validation.presentation(
        'fp_guard_frame',
        id,
        'FP-environment guard failure arm, unexecuted under its recorded fp_environment requirement and ending in an unknown exit; its unknown effect is not a frame address escape',
        [id],
      )
    )
      reachAll = frameExposed = true;
  // A frame address stored into bytes an escaped address reaches escapes too:
  // whoever holds the outer address can read it back.
  const storedEscapes = new Set<string>();
  for (let lowered = true; lowered && view === 'source' && !reachAll;) {
    lowered = false;
    for (const access of accesses) {
      context.checkpoint(1);
      const node = access.node;
      if (
        node.kind !== 'store' ||
        storedEscapes.has(node.id) ||
        !tainted.has(node.value.id) ||
        reachFloor === undefined ||
        access.end <= reachFloor
      )
        continue;
      storedEscapes.add(node.id);
      const floor = reachFloor;
      expose(node.value);
      if (reachAll || reachFloor !== floor) lowered = true;
    }
  }
  // Established ABI stack locations are outgoing argument storage at a call,
  // even when their entry-SP offsets are negative. They are not private spills.
  const outgoingRanges = (input.types?.calls?.calls ?? []).flatMap((call) =>
    call.contracts
      .filter((contract) => contract.status === 'established')
      .flatMap((contract) =>
        contract.parameters.flatMap((parameter) =>
          parameter.locations.flatMap((observation) =>
            observation.location.kind === 'stack' && observation.stack_offset !== null
              ? [
                  {
                    start: observation.stack_offset,
                    end: observation.stack_offset + observation.location.size,
                  },
                ]
              : [],
          ),
        ),
      ),
  );
  const groups = new Map<string, typeof accesses>();
  for (const access of accesses) {
    const group = groups.get(access.key) ?? [];
    group.push(access);
    groups.set(access.key, group);
  }
  const aliased =
    facts?.frame.aliased === true ||
    memory.some((node) => node.kind === 'store' && !addresses.has(node.address.id));
  // Source view: on an ABI whose call pushes the return address, the bytes at
  // the callee-entry SP are by definition that return address. The last store
  // before the call (only pure assignments between) writing exactly those bytes
  // with a code address, originating from the call's own instruction, is the
  // call's push. When no other access touches those bytes and no escaped frame
  // address reaches them, only the callee's return consumes it: call mechanics,
  // not a source local. The checked view retains every store.
  const returnAddressPushes = new Set<string>();
  if (view === 'source' && !reachAll && abi.stack_return_address_bytes > 0n) {
    const pushes: (typeof accesses)[number][] = [];
    const byStore = new Map(accesses.map((access) => [access.node.id, access]));
    for (const block of blocks.values())
      for (let index = 0; index < block.statements.length; index++) {
        context.checkpoint(1);
        const call = block.statements[index]!;
        if (call.kind !== 'call') continue;
        let previous = index - 1;
        while (previous >= 0 && block.statements[previous]!.kind === 'assign') previous--;
        const push = previous >= 0 ? byStore.get(block.statements[previous]!.id) : undefined,
          stack = call.register_inputs.find(
            (binding) =>
              binding.register.root === abi.stack_pointer.root &&
              binding.register.width_bits === abi.stack_pointer.width_bits,
          ),
          value = push?.node.kind === 'store' ? expressions.get(push.node.value.id) : undefined;
        if (
          !push ||
          push.node.kind !== 'store' ||
          push.node.access.volatile ||
          !stack ||
          addresses.get(stack.value.id) !== push.offset ||
          push.end - push.offset !== abi.stack_return_address_bytes ||
          value?.kind !== 'address' ||
          !push.node.provenance.instruction_ids.length ||
          push.node.provenance.instruction_ids.some(
            (id) => !call.provenance.instruction_ids.includes(id),
          )
        )
          continue;
        pushes.push(push);
      }
    const pushIds = new Set(pushes.map((push) => push.node.id));
    for (const push of pushes) {
      context.checkpoint(accesses.length);
      if (
        (reachFloor !== undefined && push.end > reachFloor) ||
        accesses.some(
          (access) =>
            !pushIds.has(access.node.id) && access.offset < push.end && access.end > push.offset,
        ) ||
        !validation.presentation(
          'call_return_address',
          push.node.id,
          `call instruction's own push of its fall-through address at callee-entry SP ${push.offset}; no other frame access overlaps; no escaped frame address reaches it`,
          [push.node.id],
        )
      )
        continue;
      returnAddressPushes.add(push.node.id);
    }
    if (returnAddressPushes.size)
      validation.requireAbi(
        'call_return_address',
        [...returnAddressPushes].slice(0, 64),
        'Hiding a call’s return-address push assumes ABI conformance: the callee consumes the pushed fall-through address only to return and it is not argument storage. Each store remains in the checked view and the original mappings.',
      );
  }
  // An open argument list describes an unbounded caller-SP-relative area: any
  // slot accessed before such a call may be its stack argument. Observed
  // registers or written bytes never bound it. Under ABI conformance a call's
  // stack arguments form one contiguous callee-owned area starting at its
  // callee-entry SP (above a pushed return address), and the callee may
  // overwrite it, so a caller never reads back after the call the pre-call
  // contents of its bytes. A slot written before the call and read after it
  // with no write, call or unknown effect between therefore lies above that
  // area: every slot at or above the lowest such slot is not argument storage
  // of that call (`open_call_argument_area`). A slot used only after the call
  // cannot supply its arguments either.
  const positions = new Map<string, number>();
  for (const block of blocks.values())
    for (let index = 0; index < block.statements.length; index++) {
      context.checkpoint(1);
      positions.set(block.statements[index]!.id, index);
    }
  const predecessors = new Map<string, string[]>(),
    successors = new Map<string, string[]>();
  for (const { transfer, block } of transfers) {
    const before = predecessors.get(transfer.target) ?? [];
    before.push(block.id);
    predecessors.set(transfer.target, before);
    const after = successors.get(block.id) ?? [];
    after.push(transfer.target);
    successors.set(block.id, after);
  }
  const openCalls: {
    readonly block: string;
    readonly position: number;
    /** Blocks from which the call's block is reachable through some edge. */
    readonly reachers: ReadonlySet<string>;
    /** Lowest offset known to lie above the call's argument area, or null. */
    readonly bound: bigint | null;
  }[] = [];
  if (view === 'source' && unknownCallStorage) {
    // Bounded search; an exhausted allowance leaves the remaining areas open.
    let allowance = 4096;
    // Private slots in ascending offset order with the stores covering them.
    // A covering store contains the slot's first byte.
    const storeAccesses = new Map<string, (typeof accesses)[number]>();
    for (const access of accesses)
      if (access.node.kind === 'store') storeAccesses.set(access.node.id, access);
    const slotsByOffset = [...groups.values()]
      .map((group) => group[0]!)
      .filter((slot) => slot.end <= 0n)
      .sort((left, right) => (left.offset < right.offset ? -1 : 1))
      .map((slot) => ({
        slot,
        covering: (storesByByte.get(slot.offset) ?? []).flatMap((node) => {
          const access = storeAccesses.get(node.id);
          return access && access.end >= slot.end ? [access] : [];
        }),
      }));
    for (const block of blocks.values())
      for (let position = 0; position < block.statements.length; position++) {
        const call = block.statements[position]!;
        if (call.kind !== 'call' || !openArguments(calls.get(call.id)!)) continue;
        const reachers = new Set<string>(),
          pending = [block.id];
        while (pending.length) {
          context.checkpoint(1);
          for (const id of predecessors.get(pending.pop()!) ?? [])
            if (!reachers.has(id)) {
              reachers.add(id);
              pending.push(id);
            }
        }
        const precedes = (access: (typeof accesses)[number]): boolean =>
          reachers.has(access.block) ||
          (access.block === block.id && positions.get(access.node.id)! < position);
        const stack = call.register_inputs.find(
            (binding) =>
              binding.register.root === abi.stack_pointer.root &&
              binding.register.width_bits === abi.stack_pointer.width_bits,
          ),
          entrySp = stack && addresses.get(stack.value.id);
        let bound: bigint | null = null;
        if (entrySp !== undefined) {
          const area = entrySp + abi.stack_return_address_bytes;
          const candidates = slotsByOffset.filter(
            ({ slot, covering }) => slot.offset >= area && covering.some(precedes),
          );
          for (const { slot } of candidates) {
            if (allowance-- <= 0) break;
            // Does a load of exactly this slot read its contents at the call?
            const scan = (id: string, start: number): 'read' | 'written' | 'open' => {
              const statements = blocks.get(id)!.statements;
              for (let index = start; index < statements.length; index++) {
                const node = statements[index]!;
                if (node.kind === 'call' || node.kind === 'unknown_effect') return 'written';
                if (node.kind === 'store') {
                  const offset = addresses.get(node.address.id);
                  if (
                    offset === undefined ||
                    (offset < slot.end &&
                      offset + BigInt(Math.ceil(bitWidth(node.value.type) / 8)) > slot.offset)
                  )
                    return 'written';
                }
                if (
                  node.kind === 'load' &&
                  !node.access.volatile &&
                  addresses.get(node.address.id) === slot.offset &&
                  slot.offset + BigInt(Math.ceil(bitWidth(node.result.type) / 8)) === slot.end
                )
                  return 'read';
              }
              return 'open';
            };
            let state = scan(block.id, position + 1);
            const visited = new Set<string>(),
              frontier = state === 'open' ? [...(successors.get(block.id) ?? [])] : [];
            while (state !== 'read' && frontier.length && allowance > 0) {
              const id = frontier.pop()!;
              if (visited.has(id)) continue;
              visited.add(id);
              allowance--;
              context.checkpoint(1);
              const result = scan(id, 0);
              if (result === 'read') state = 'read';
              else if (result === 'open') frontier.push(...(successors.get(id) ?? []));
            }
            if (state === 'read') {
              bound = slot.offset;
              break;
            }
          }
        }
        openCalls.push({ block: block.id, position, reachers, bound });
      }
  }
  // Under activation-private storage ownership an external pointer cannot name
  // this activation's negative entry-SP offsets that no escaped frame address
  // reaches. The original alias facts stay intact; source promotion records
  // this ABI premise and the independent byte validator receives the exact
  // disjoint set, which holds only for the slots below every escaped address.
  const disjointStores =
    view === 'source' && !reachAll
      ? new Set(
          memory
            .filter((node) => node.kind === 'store' && !addresses.has(node.address.id))
            .map((node) => node.id),
        )
      : undefined;
  const eligible = new Set<string>(),
    // Source view: narrower loads wholly inside a promoted integer slot, keyed
    // by that slot; each reads its endian-determined bits of the slot value.
    slotParts = new Map<string, typeof accesses>(),
    partSlot = new Map<string, string>(),
    // Source view: same-width accesses of differing types; promoted only when
    // every load forwards (as a bitcast of) its reaching stored value.
    punnedSlots = new Set<string>(),
    // Slots accessed before an open-arity call that lie above its bounded area.
    boundedSlots = new Set<string>(),
    // Source view: exact private slots that may be open-call stack-argument
    // storage and are otherwise promotable.
    argumentSlots = new Set<string>();
  if (view === 'source' ? !reachAll : !escaped && !unknownCallStorage && !aliased)
    for (const [key, group] of groups) {
      const first = group[0]!;
      context.checkpoint(accesses.length);
      const overlapping = accesses.filter(
        (access) => access.key !== key && access.offset < first.end && access.end > first.offset,
      );
      const members = [...group, ...overlapping];
      const preceded = openCalls.filter((call) =>
        members.some(
          (access) =>
            call.reachers.has(access.block) ||
            (access.block === call.block && positions.get(access.node.id)! < call.position),
        ),
      );
      if (
        returnAddressPushes.has(first.node.id) ||
        first.offset >= 0n ||
        first.end > 0n ||
        (reachFloor !== undefined && first.end > reachFloor) ||
        group.some((access) => access.node.access.volatile) ||
        outgoingRanges.some((range) => range.start < first.end && range.end > first.offset)
      )
        continue;
      if (
        overlapping.length &&
        !(
          view === 'source' &&
          (first.node.kind === 'load' ? first.node.result.type : first.node.value.type).kind ===
            'integer' &&
          overlapping.every(
            (part) =>
              (part.node.kind === 'load' ? part.node.result.type : part.node.value.type).kind ===
                'integer' &&
              !part.node.access.volatile &&
              part.node.access.endian === first.node.access.endian &&
              part.offset >= first.offset &&
              part.end <= first.end,
          )
        )
      )
        continue;
      if (group.some((access) => access.node.access.endian !== first.node.access.endian)) continue;
      const punned = group.some(
        (access) =>
          !sameType(
            access.node.kind === 'load' ? access.node.result.type : access.node.value.type,
            first.node.kind === 'load' ? first.node.result.type : first.node.value.type,
          ),
      );
      if (punned && (view !== 'source' || overlapping.length)) continue;
      if (overlapping.length) {
        slotParts.set(key, overlapping);
        for (const part of overlapping) partSlot.set(part.node.id, key);
      }
      if (preceded.some((call) => call.bound === null || first.offset < call.bound)) {
        // Possible stack-argument storage keeps its stores in memory; its
        // reloads may still read the bytes stored before them.
        if (view === 'source') argumentSlots.add(key);
        continue;
      }
      if (punned) punnedSlots.add(key);
      eligible.add(key);
      if (preceded.length) boundedSlots.add(key);
    }
  // Source view: frame-private save/restore of entry registers
  // (`frameSaveQualifier`), restored on every return and tail exit.
  const saveStores = new Set<string>(),
    saveReloads = new Set<string>(),
    saveBytes = new Set<bigint>();
  const tailExits = [...blocks.values()].filter(
    (block) =>
      block.control.kind === 'return' ||
      (block.control.kind === 'indirect' && block.control.tail_call === true),
  );
  const dominates = (
    first: (typeof accesses)[number],
    second: (typeof accesses)[number],
  ): boolean => {
    if (first.block === second.block)
      return positions.get(first.node.id)! < positions.get(second.node.id)!;
    for (
      let id = blocks.get(second.block)!.dominator;
      id !== null;
      id = blocks.get(id)?.dominator ?? null
    ) {
      context.checkpoint(1);
      if (id === first.block) return true;
    }
    return false;
  };
  const frameSaves = frameSaveQualifier(
    {
      accesses,
      groups,
      exposedOffsets,
      outgoingRanges,
      entry,
      expressions,
      incoming,
      dominates,
      abi,
    },
    context,
  );
  // Source view: indirect exits proven to transfer like a call by this
  // function's caller are tail exits too.
  const indirectTails =
    view === 'source'
      ? classifyIndirectTails({
          input,
          blocks,
          expressions,
          incoming,
          stackOffset: (value) => addresses.get(value.id),
          frameEscapes:
            frameExposed || reachAll || reachFloor !== undefined || exposedOffsets.size > 0,
          stores: accesses.filter((access) => access.node.kind === 'store'),
          unknownStores: memory.some(
            (node) => node.kind === 'store' && !addresses.has(node.address.id),
          ),
          exits: tailExits,
          frameSaves,
          validation,
          context,
        })
      : new Set<string>();
  const exits = indirectTails.size
    ? [...tailExits, ...[...blocks.values()].filter((block) => indirectTails.has(block.control.id))]
    : tailExits;
  if (!frameExposed && exits.length) {
    frameSaves.qualify(exits, ({ key, save, loads, bits }) => {
      if (
        !validation.presentation(
          'frame_save',
          `stack:${key}`,
          `frame-private save of ${bits.root}[${bits.low}:${bits.width}] at entry SP ${save.offset}; restored from this exact slot on every return/tail exit; nonescaping, nonoverlapping, not established outgoing argument storage`,
          [save.node.id, ...loads.map((load) => load.node.id)].slice(0, 64),
        )
      )
        return false;
      // A proven save is machine bookkeeping, not a scalar source local.
      // Classify it before promotion even in leaf functions without calls.
      eligible.delete(key);
      saveStores.add(save.node.id);
      for (let byte = save.offset; byte < save.end; byte++) saveBytes.add(byte);
      for (const load of loads) {
        saveReloads.add(load.node.id);
        if (load.node.kind === 'load')
          alias(load.node.result, { kind: 'cast', op: 'bitcast', value: save.node.value });
      }
      return true;
    });
    if (saveStores.size)
      validation.requireAbi('frame_save', [exits[0]!.control.id, ...saveStores], FRAME_SAVE_PREMISE);
  }
  // Source view: a non-volatile frame load dominated by a store covering its
  // bytes cannot fault. If its result is dead, reconstruct() may drop it.
  const deadReloadCandidates = new Set<string>();
  const byNode = new Map(accesses.map((access) => [access.node.id, access]));
  if (view === 'source')
    for (const load of accesses) {
      if (load.node.kind !== 'load' || load.node.access.volatile || saveReloads.has(load.node.id))
        continue;
      // A covering store must cover the first byte; filter only that bucket.
      // Valid IR memory accesses are byte-width, so every indexed store is an access.
      for (const node of storesByByte.get(load.offset) ?? []) {
        context.checkpoint(1);
        const store = byNode.get(node.id)!;
        if (store.end >= load.end && dominates(store, load)) {
          deadReloadCandidates.add(load.node.id);
          break;
        }
      }
    }
  // Register observations establish a prefix, not the absence of further
  // stack arguments. Written bytes may also be saves or locals: retain the
  // uncertainty instead of inventing an argument count from their extent.
  // Proven frame saves are not possible stack arguments. A source-view closure
  // validated above is callee-proven register-only and is not reopened.
  for (const node of callNodes) {
    context.checkpoint(1);
    const projection = calls.get(node.id)!;
    if (projection.kind !== 'inferred' || projection.argument_list_complete === true) continue;
    const snapshot = facts?.snapshots.get(node.id);
    let writtenStack = false;
    if (snapshot)
      for (const offset of snapshot.memory.keys()) {
        context.checkpoint(1);
        if (!saveBytes.has(offset)) {
          writtenStack = true;
          break;
        }
      }
    else
      writtenStack = memory.some(
        (access) =>
          access.kind === 'store' && addresses.has(access.address.id) && !saveStores.has(access.id),
      );
    if (writtenStack) {
      // Caller-written outgoing stack bytes may be arguments (or the variadic tail):
      // no heuristic may close the list over them.
      const { likely: _guess, ...kept } = projection;
      calls.set(node.id, { ...kept, argument_list_complete: false });
    }
  }
  // State is exact reaching stored byte / definitely initialized but differing
  // values / uninitialized. Unvisited predecessors are ignored until reached,
  // then joins can only lose precision, so backedges converge without inventing
  // assignment. A slot without parts keeps one cell for its whole value (byte
  // significance 0 marks it); a slot with parts keeps one cell per byte.
  type Cell = ForwardedByte | null | undefined;
  const outgoing = new Map<string, Map<string, Cell>>(),
    // Reaching byte of each tracked load, least significant first.
    before = new Map<string, readonly Cell[]>();
  for (const key of argumentSlots)
    if (
      groups
        .get(key)!
        .some((access) => saveStores.has(access.node.id) || saveReloads.has(access.node.id))
    )
      argumentSlots.delete(key);
  const tracked: string[] = [],
    // State cells a call or unknown effect may overwrite.
    argumentCells: string[] = [];
  for (const key of [...eligible, ...argumentSlots]) {
    const first = groups.get(key)![0]!,
      cells = tracked.length;
    if (!slotParts.has(key)) tracked.push(key);
    else for (let byte = first.offset; byte < first.end; byte++) tracked.push(`${key}@${byte}`);
    if (argumentSlots.has(key)) argumentCells.push(...tracked.slice(cells));
  }
  // Byte significance of memory byte `byte` within an access.
  const significance = (access: (typeof accesses)[number], byte: bigint): number =>
    Number(access.node.access.endian === 'big' ? access.end - 1n - byte : byte - access.offset);
  changed = true;
  const indegree = new Map([...blocks.keys()].map((id) => [id, 0]));
  for (const { transfer } of transfers)
    indegree.set(transfer.target, (indegree.get(transfer.target) ?? 0) + 1);
  const acyclicQueue = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
  for (let cursor = 0; cursor < acyclicQueue.length; cursor++)
    for (const target of successors.get(acyclicQueue[cursor]!) ?? []) {
      context.checkpoint(1);
      const count = indegree.get(target)! - 1;
      indegree.set(target, count);
      if (count === 0) acyclicQueue.push(target);
    }
  const acyclic = acyclicQueue.length === blocks.size;
  while (changed) {
    changed = false;
    for (const block of blocks.values()) {
      context.checkpoint(1);
      const parents = (predecessors.get(block.id) ?? [])
        .map((id) => outgoing.get(id))
        .filter((state): state is Map<string, Cell> => state !== undefined);
      if (block.id !== input.function.entry && !parents.length) continue;
      const state = new Map<string, Cell>();
      for (const key of tracked) {
        let cell: Cell = block.id === input.function.entry ? undefined : parents[0]?.get(key);
        for (const parent of parents) {
          const other = parent.get(key);
          cell =
            cell === undefined || other === undefined
              ? undefined
              : cell === null ||
                  other === null ||
                  cell.value.id !== other.value.id ||
                  cell.index !== other.index
                ? null
                : cell;
        }
        state.set(key, cell);
      }
      for (const node of block.statements) {
        context.checkpoint(1);
        // A call may write its own stack arguments; an unknown effect anything.
        if (node.kind === 'call' || node.kind === 'unknown_effect')
          for (const cell of argumentCells) state.set(cell, null);
        const access = byNode.get(node.id);
        const key = access && (partSlot.get(node.id) ?? access.key);
        if (!access || !key || !(eligible.has(key) || argumentSlots.has(key))) continue;
        const width = Number(access.end - access.offset);
        if (!slotParts.has(key)) {
          if (access.node.kind === 'store') state.set(key, { value: access.node.value, index: 0 });
          else {
            const cell = state.get(key);
            before.set(
              node.id,
              Array.from({ length: width }, (_, index) =>
                cell ? { value: cell.value, index } : cell,
              ),
            );
          }
          continue;
        }
        const cells: Cell[] = new Array<Cell>(width);
        for (let byte = access.offset; byte < access.end; byte++)
          if (access.node.kind === 'store')
            state.set(`${key}@${byte}`, {
              value: access.node.value,
              index: significance(access, byte),
            });
          else cells[significance(access, byte)] = state.get(`${key}@${byte}`);
        if (access.node.kind === 'load') before.set(node.id, cells);
      }
      const old = outgoing.get(block.id);
      if (
        !old ||
        [...state].some(([key, cell]) => {
          const previous = old.get(key);
          return (
            (previous === null) !== (cell === null) ||
            previous?.value.id !== cell?.value.id ||
            previous?.index !== cell?.index
          );
        })
      ) {
        outgoing.set(block.id, state);
        changed = true;
      }
    }
  }
  const hidden = new Set<string>([...saveStores, ...saveReloads, ...returnAddressPushes]),
    privateLoads = new Set<string>(),
    locals = new Map<string, SourceLocal>(),
    // Source view: loads bound to incoming formals (named stack arguments).
    incomingFormalLoads = new Set<string>();
  const saves: FrameSaves = { stores: saveStores, reloads: saveReloads, bytes: saveBytes };
  // An unchanged incoming slot is entry storage supplied by the caller, not a
  // byte array allocated by this function. Bind only exact, loads-only,
  // nonoverlapping accesses to proven ABI scalar slots; partial/overlapping or
  // modified storage retains its ordered memory representation until a richer
  // storage model is available. The checked view requires a nonescaping frame,
  // no store through an unknown address and clear per-load alias facts. The
  // source view decides per slot (S1): no unbounded escape, and the slot lies
  // wholly below `incomingFloor`, so no address derived from the incoming area
  // reaches it; under `incoming_arguments_private` nothing else can.
  const incomingPrivate = `Incoming stack argument storage belongs to this activation for its whole lifetime: callers, callees, globals, unknown stores and loaded or returned pointers never designate it; only addresses this function derives from its own incoming area can${incomingFloor === undefined ? ', and none escapes or indexes memory' : `, and those that escape or index memory reach only bytes at or above the lowest offset they can take (here ${incomingFloor})`}. Each slot presented as a formal lies wholly below that bound, is only loaded, and so holds its entry value at every load. Original loads remain in the checked view.`;
  if (
    (view === 'source' ? !reachAll : !escaped) &&
    facts?.state === 'complete' &&
    (view === 'source' ||
      !memory.some((node) => node.kind === 'store' && !addresses.has(node.address.id)))
  )
    for (const group of groups.values()) {
      const first = group[0]!;
      if (
        classifyStackRegion(input.source!.abi, first.offset, first.end - first.offset) !==
          'incoming_candidate' ||
        (view === 'source' && incomingFloor !== undefined && first.end > incomingFloor) ||
        group.some((access) => access.node.kind !== 'load' || access.node.access.volatile) ||
        accesses.some(
          (access) =>
            access.key !== first.key && access.offset < first.end && access.end > first.offset,
        )
      )
        continue;
      const loads = group.map((access) => access.node as Extract<Instruction, { kind: 'load' }>);
      if (
        loads.some(
          (node) =>
            !sameType(node.result.type, loads[0]!.result.type) ||
            node.access.endian !== input.source!.abi.layout.endian ||
            (view !== 'source' &&
              (facts?.snapshots.get(node.id)?.aliased || facts?.snapshots.get(node.id)?.escaped)),
        )
      )
        continue;
      const value = incomingStack(
        first.offset,
        loads[0]!.result.type,
        loads.map((node) => node.result),
      );
      if (!value) continue;
      if (view === 'source') {
        const subjects = loads.slice(0, 64).map((node) => node.id);
        // An unused incoming value is no formal: finalize keeps live ones only.
        if (
          !validation.presentation(
            'incoming_formal',
            `stack:${first.key}`,
            'exact nonvolatile nonoverlapping ABI stack-parameter slot at or above the entry SP, only loaded, all loads of one type; wholly below the lowest offset any escaping or indexing address derived from the incoming area can take; no unbounded frame escape or unknown effect; every load reads the entry value and prints as the incoming formal',
            subjects,
          )
        )
          continue;
        validation.requireAbi('incoming_arguments_private', subjects, incomingPrivate);
      }
      for (const node of loads) {
        hidden.add(node.id);
        incomingFormalLoads.add(node.id);
        alias(node.result, { kind: 'cast', op: 'bitcast', value });
      }
    }
  const frameObjectBase = `An escaped frame address reaches only bytes at or above the lowest entry-SP offset it can take (here ${reachFloor}): callees, memory holding the address and code reached through it never step below the address they were given. Code that steps backward from an interior pointer (container_of, negative indexing) is outside this premise. Each slot this rewrite touches lies wholly below that offset.`;
  // A reaching stored SSA value still holds the stored instance at the load:
  // no loop can redefine it in between (acyclic CFG, a single block, or every
  // store in an entry block no edge returns to).
  const sameInstances = (members: readonly (typeof accesses)[number][], block: string) =>
    acyclic ||
    members.every((access) => access.block === block) ||
    (view === 'source' &&
      !predecessors.get(input.function.entry)?.length &&
      members.every(
        (access) => access.node.kind !== 'store' || access.block === input.function.entry,
      ));
  // The value a forwarded load reads from its reaching stored bytes: the whole
  // stored value, a bit range of one integer value, or adjacent stored integer
  // pieces concatenated low to high. Null when the bytes have no such spelling.
  /** Stored value -> reloads that read exactly its whole bits (bitcast forward). */
  const forwardedReloads = new Map<string, string[]>();
  const forward = (reload: Value, read: Expression): void => {
    if (read.kind !== 'cast' || read.op !== 'bitcast' || !sameType(read.value.type, reload.type))
      return;
    const list = forwardedReloads.get(read.value.id) ?? [];
    list.push(reload.id);
    forwardedReloads.set(read.value.id, list);
  };
  const forwardedRead = (
    access: (typeof accesses)[number],
    cells: readonly ForwardedByte[],
  ): Expression | null => {
    const load = access.node as Extract<Instruction, { kind: 'load' }>;
    const runs: { value: Value; index: number; bytes: number }[] = [];
    for (const cell of cells) {
      const last = runs.at(-1);
      if (last && last.value.id === cell.value.id && last.index + last.bytes === cell.index)
        last.bytes++;
      else runs.push({ value: cell.value, index: cell.index, bytes: 1 });
    }
    const whole = (run: (typeof runs)[number]): boolean =>
      run.index === 0 && bitWidth(run.value.type) === run.bytes * 8;
    if (runs.length === 1 && whole(runs[0]!))
      return { kind: 'cast', op: 'bitcast', value: runs[0]!.value };
    if (
      load.result.type.kind !== 'integer' ||
      runs.some((run) => run.value.type.kind !== 'integer')
    )
      return null;
    if (runs.length === 1)
      return { kind: 'extract', value: runs[0]!.value, offset: runs[0]!.index * 8 };
    return {
      kind: 'concat',
      values: runs.map((run, index) =>
        whole(run)
          ? run.value
          : make(`stack-part:${load.id}:${index}`, integer(run.bytes * 8), access.block, {
              kind: 'extract',
              value: run.value,
              offset: run.index * 8,
            }),
      ),
    };
  };
  for (const key of eligible) {
    const group = groups.get(key)!,
      parts = slotParts.get(key) ?? [],
      members = parts.length ? [...group, ...parts] : group,
      loads = members.filter((access) => access.node.kind === 'load');
    if (
      loads.some(
        (access) => before.get(access.node.id)?.every((cell) => cell !== undefined) !== true,
      )
    )
      continue;
    const exact =
      loads.every((access) => before.get(access.node.id)!.every((cell) => cell !== null)) &&
      sameInstances(members, group[0]!.block);
    const reads = new Map<string, Expression>();
    if (exact)
      for (const access of loads) {
        const read = forwardedRead(access, before.get(access.node.id) as ForwardedByte[]);
        if (!read) break;
        reads.set(access.node.id, read);
      }
    const forwarded = exact && reads.size === loads.length;
    // A part reads or writes some bytes of the slot value: no scalar local
    // spelling exists for it unless every read forwards.
    if (parts.length && !forwarded) continue;
    // A punned local converts its other-typed accesses by exact bit
    // reinterpretation: 32/64-bit integer and IEEE scalars only.
    const punned = punnedSlots.has(key);
    if (
      punned &&
      !forwarded &&
      group.some((access) => {
        const type = access.node.kind === 'load' ? access.node.result.type : access.node.value.type;
        return (
          (type.kind !== 'integer' && type.kind !== 'float') ||
          (type.bits !== 32 && type.bits !== 64)
        );
      })
    )
      continue;
    const first = group[0]!;
    const subjects = [first.node.id];
    const checked = validation.check(
      'stack-promotion',
      `stack:${key}`,
      'private stack promotion',
      () => {
        const ids = new Set<string>(),
          proposed = new Map<string, readonly ForwardedByte[]>();
        for (const access of members) {
          validation.allowance.charge();
          ids.add(access.node.id);
          if (subjects.length < 64 && access.node.id !== subjects[0]) subjects.push(access.node.id);
          if (forwarded && access.node.kind === 'load')
            proposed.set(access.node.id, before.get(access.node.id) as ForwardedByte[]);
        }
        return validateStackPromotion(
          `stack:${key}`,
          input.function.entry,
          blocks,
          transfers,
          addresses,
          ids,
          forwarded ? proposed : null,
          expressions,
          validation.allowance,
          disjointStores,
        );
      },
      subjects,
    );
    if (checked.status === 'rejected') continue;
    if (
      view === 'source' &&
      !(parts.length
        ? validation.presentation(
            'wide_slot_parts',
            `stack:${key}`,
            'exact nonvolatile negative entry-SP integer slot; every other overlapping access is a narrower integer load or store wholly inside it; each load forwards the endian-determined bytes the reaching stores wrote (a bit range of one value, or adjacent stored values concatenated low to high); no escaped frame address reaches it; definitely initialized reads; no established outgoing argument overlap; any access preceding an open-arity call lies above that call’s bounded argument area',
            subjects,
          )
        : validation.presentation(
            'private_stack_promotion',
            `stack:${key}`,
            punned
              ? forwarded
                ? 'exact nonvolatile nonoverlapping negative entry-SP slot accessed with same-width types; every load forwards a bitcast of its reaching stored value; no escaped frame address reaches it; definitely initialized reads; no established outgoing argument overlap; any access preceding an open-arity call lies above that call’s bounded argument area'
                : 'exact nonvolatile nonoverlapping negative entry-SP slot accessed with same-width integer and IEEE types: one local of one type, every other-typed access converts by exact bit reinterpretation; no escaped frame address reaches it; definitely initialized reads; no established outgoing argument overlap; any access preceding an open-arity call lies above that call’s bounded argument area'
              : 'exact nonvolatile nonoverlapping negative entry-SP slot; no escaped frame address reaches it; definitely initialized reads; no established outgoing argument overlap; any access preceding an open-arity call lies above that call’s bounded argument area',
            subjects,
          ))
    )
      continue;
    if (view === 'source' && (disjointStores?.size || callNodes.length))
      validation.requireAbi(
        'frame_private_to_activation',
        subjects,
        'Nonescaping frame-private storage belongs to this activation: pointers supplied by callers, globals, external loads and call results cannot alias it. Callees observe only declared argument storage. Original memory effects and alias facts remain in the checked view.',
      );
    if (view === 'source' && reachFloor !== undefined)
      validation.requireAbi('frame_object_base', subjects, frameObjectBase);
    if (boundedSlots.has(key))
      validation.requireAbi(
        'open_call_argument_area',
        subjects,
        'An open-arity call’s stack arguments form one contiguous callee-owned area starting at its callee-entry SP, which the callee may overwrite, so a caller never reads back after the call the pre-call contents of those bytes. A slot written before the call and read after it with no write, call or unknown effect between bounds that area; this promoted slot lies at or above that bound.',
      );
    if (forwarded) {
      for (const access of members) {
        hidden.add(access.node.id);
        if (access.node.kind !== 'load') continue;
        const read = reads.get(access.node.id)!;
        alias(access.node.result, read);
        forward(access.node.result, read);
      }
    } else {
      // A punned local takes its stores' common type (else the first access's);
      // every other-typed access converts by exact bit reinterpretation.
      const stored = group.flatMap((access) =>
        access.node.kind === 'store' ? [access.node.value.type] : [],
      );
      const local: SourceLocal = {
        id: `entity_${fingerprint(['source-local', input.function.id, key])}`,
        type:
          stored.length && stored.every((type) => sameType(type, stored[0]!))
            ? stored[0]!
            : first.node.kind === 'load'
              ? first.node.result.type
              : first.node.value.type,
        ...(view === 'source' ? { stack_offset: first.offset } : {}),
      };
      for (const access of group) {
        locals.set(access.node.id, local);
        if (access.node.kind === 'load') privateLoads.add(access.node.id);
      }
    }
  }
  // Source view: a slot that may be an open call's stack argument keeps every
  // store in memory, but a reload whose bytes hold, on every path, exactly the
  // value of one store with no call, unknown effect or other write between
  // reads that value: an O0 spill/reload of an argument is the argument.
  for (const key of argumentSlots) {
    const group = groups.get(key)!,
      members = [...group, ...(slotParts.get(key) ?? [])];
    const reads = new Map<string, Expression>();
    if (sameInstances(members, group[0]!.block))
      for (const access of members) {
        const cells = before.get(access.node.id);
        if (
          access.node.kind !== 'load' ||
          !cells?.every((cell) => cell !== null && cell !== undefined)
        )
          continue;
        const read = forwardedRead(access, cells as ForwardedByte[]);
        if (read) reads.set(access.node.id, read);
      }
    const reloads = members.filter((access) => reads.has(access.node.id));
    if (!reloads.length) continue;
    const ids = [...members.filter((access) => access.node.kind === 'store'), ...reloads].map(
        (access) => access.node.id,
      ),
      subjects = ids.slice(0, 64);
    const checked = validation.check(
      'stack-promotion',
      `stack:${key}`,
      'stack-argument slot reload forwarding',
      () => {
        const proposed = new Map<string, readonly ForwardedByte[]>();
        for (const access of reloads) {
          validation.allowance.charge();
          proposed.set(access.node.id, before.get(access.node.id) as ForwardedByte[]);
        }
        return validateStackPromotion(
          `stack:${key}`,
          input.function.entry,
          blocks,
          transfers,
          addresses,
          new Set(ids),
          proposed,
          expressions,
          validation.allowance,
          disjointStores,
        );
      },
      subjects,
    );
    if (
      checked.status === 'rejected' ||
      !validation.presentation(
        'argument_slot_reload',
        `stack:${key}`,
        'exact nonvolatile negative entry-SP slot that may be open-call stack-argument storage: its stores stay in memory; each forwarded reload reads the bytes the stores reaching it on every path wrote (one stored value, a bit range of one, or adjacent stored pieces), with no call, unknown effect or other write to the slot between; no escaped frame address reaches it',
        subjects,
      )
    )
      continue;
    validation.requireAbi(
      'frame_private_to_activation',
      subjects,
      'Nonescaping frame-private storage belongs to this activation: pointers supplied by callers, globals, external loads and call results cannot alias it. Callees observe only declared argument storage. Original memory effects and alias facts remain in the checked view.',
    );
    if (reachFloor !== undefined)
      validation.requireAbi('frame_object_base', subjects, frameObjectBase);
    for (const access of reloads) {
      hidden.add(access.node.id);
      if (access.node.kind !== 'load') continue;
      const read = reads.get(access.node.id)!;
      alias(access.node.result, read);
      forward(access.node.result, read);
    }
  }
  // Source view (S6): the callee's `va_start` area (`classifyVariadicArea`).
  // Its address replaces the entry SP as the base of every address at or above
  // it, and Win64's home stores of the anonymous argument registers, which
  // are `va_start`'s own effect, are hidden.
  let variadicArea: SourceVariadic | null = null;
  if (view === 'source' && variadic && !reachAll && facts?.state === 'complete') {
    const area = classifyVariadicArea(
      {
        input,
        blocks,
        expressions,
        incoming,
        calls,
        returns,
        accesses,
        bound: incomingFormalLoads,
        floor: incomingFloor,
        based: incomingBased,
        unknownOffset: (node) => tainted.has(node.address.id) && !addresses.has(node.address.id),
        reentered: (predecessors.get(input.function.entry)?.length ?? 0) > 0,
      },
      context,
    );
    const named = area?.named ? variadic.named(area.named) : null;
    if (
      area &&
      (!area.named || named) &&
      validation.presentation(
        'va_start',
        input.function.id,
        `callee-side variadic interface: the named formals, then ...; va_start's result (the address of the first anonymous argument, entry SP ${area.offset}) is the source-only va (va_list, char *) and the base of every address at or above it; ${area.stores.length ? `the ${area.stores.length} home-area stores of the anonymous argument registers are va_start's own effect and are hidden; ` : ''}a value based there is dereferenced at non-constant offsets or escapes, and only named formals are accessed below it`,
        [input.function.id, ...area.stores],
      )
    ) {
      const value = variadic.area(area.offset, named);
      if (value) {
        validation.requireAbi(
          'variadic_convention',
          [input.function.id, ...area.stores],
          `Presenting ... and va_start assumes the ${input.source!.abi.id} variadic calling convention: callers pass the anonymous arguments in consecutive 8-byte slots starting at entry SP ${area.offset}${area.stores.length ? ' (the anonymous register arguments spilled to their home slots, as va_start does)' : ''}, and the named formals are exactly those printed before .... Every remaining load and store keeps its address, width and order; the checked view keeps the entry-SP form and the home stores.`,
        );
        for (const id of area.stores) hidden.add(id);
        variadicArea = { kind: 'area', area: value, offset: area.offset };
      }
    }
  }
  // Source view: the presentation map, a subset of the analysis map
  // `addresses` (which keeps every offset for taint, escape, floors and slot
  // decisions). An address read back from memory by a load that stays in the
  // program, and every value computed from such a reload, prints through the
  // load's declared variable: spelling it as an address constant instead
  // would leave the retained load assigning an undeclared name. Hidden loads
  // print nowhere, so their results keep the constant spelling. The checked
  // view presents the analysis map unchanged.
  let presented: ReadonlyMap<string, bigint> = addresses;
  if (view === 'source') {
    const reloaded = new Set<string>();
    for (const node of memory)
      if (node.kind === 'load' && !hidden.has(node.id) && addresses.has(node.result.id))
        reloaded.add(node.result.id);
    for (let changed = reloaded.size > 0; changed;) {
      changed = false;
      for (const [id, expression] of expressions) {
        context.checkpoint(1);
        if (
          !reloaded.has(id) &&
          addresses.has(id) &&
          expressionOperands(expression).some((operand) => reloaded.has(operand.id))
        ) {
          reloaded.add(id);
          changed = true;
        }
      }
      for (const [id, sources] of incoming) {
        context.checkpoint(1);
        if (
          !reloaded.has(id) &&
          addresses.has(id) &&
          sources.some((value) => reloaded.has(value.id))
        ) {
          reloaded.add(id);
          changed = true;
        }
      }
    }
    if (reloaded.size) {
      const map = new Map(addresses);
      for (const id of reloaded) map.delete(id);
      presented = map;
    }
  }
  const dynamicStorage = memory.some(
    (node) => tainted.has(node.address.id) && !addresses.has(node.address.id),
  );
  const sharedEntry = escaped || aliased || dynamicStorage;
  // Source view (S7): the SysV `va_start` footprint (`classifySysvVaStart`).
  // Its stores are `va_start`'s own effect and are hidden; the `va_list` stays
  // the frame-object member `va`, the register save area leaves the frame
  // (va_arg reaches it only through `reg_save_area`), and the `al` guard
  // around the vector register stores prints nothing. Every frame address
  // must have known origins (no unknown effect): under the frame-object
  // premise each designates bytes of the object it derives from, so only
  // addresses derived from the save area's own (checked) or `reg_save_area`
  // reach it, even where a stepped pointer has no proven lower bound.
  let saveArea: { readonly start: bigint; readonly end: bigint } | null = null;
  if (
    view === 'source' &&
    variadic &&
    !variadicArea &&
    !frameExposed &&
    facts?.state === 'complete'
  ) {
    const found = classifySysvVaStart(
      {
        input,
        blocks,
        expressions,
        incoming,
        predecessors,
        calls,
        returns,
        accesses,
        addresses,
        presented,
        tainted: (value) => tainted.has(value.id),
        kept: (id) => !hidden.has(id) && !locals.has(id),
        bound: incomingFormalLoads,
        indexed: indexedBases,
      },
      context,
    );
    const named = found && variadic.named(found.named);
    if (
      found &&
      named &&
      validation.presentation(
        'va_start',
        input.function.id,
        `callee-side SysV variadic interface: the ${named.length} named register formals, then ...; the ${found.stores.length} stores of the va_start lowering (register save area at entry SP ${found.save}: the anonymous integer argument registers, and under the al != 0 guard the anonymous vector argument registers; va_list at entry SP ${found.va}: gp_offset, fp_offset, overflow_arg_area = entry SP + ${found.overflow}, reg_save_area) are hidden and print as va_start(frame.va, <last named>) at the last of them, on every path before any other access to these areas, call or escape; the guard prints nothing; va is a frame member whose every other access is exactly one of its fields; the save area, its addresses, the saved registers and al have no other use`,
        [input.function.id, ...found.stores],
      ) &&
      (sharedEntry ||
        validation.presentation('frame_object', input.function.id, FRAME_OBJECT_SCOPE)) &&
      variadic.list(named, found.overflow)
    ) {
      validation.requireAbi(
        'variadic_convention',
        [input.function.id, ...found.stores],
        `Presenting ... and va_start assumes the ${abi.id} variadic calling convention: callers pass the anonymous arguments in the integer and vector argument registers after the named ones and then in consecutive 8-byte stack slots from the first unnamed one, set al to an upper bound of the vector registers used (so the al guard skips only vector registers no anonymous argument occupies), and the named formals are exactly those printed before .... The hidden stores are va_start's own effect; va_arg reads the register save area only through va's reg_save_area. Every remaining load and store keeps its address, width and order; the checked view keeps every store and the guard.`,
      );
      for (const id of found.stores) hidden.add(id);
      variadicArea = {
        kind: 'va_list',
        offset: found.va,
        anchor: found.anchor,
        guard: found.guard,
      };
      saveArea = { start: found.save, end: found.save + 176n };
    }
  }
  const entryAddresses = new Set(
    accesses
      .filter(
        (access) =>
          !hidden.has(access.node.id) &&
          classifyStackRegion(input.source!.abi, access.offset, access.end - access.offset) !==
            'local_candidate',
      )
      .map((access) => access.node.address.id),
  );
  // Source view: the frame bytes kept as memory print as one local frame
  // object ending at the entry SP instead of `entry_sp` arithmetic. Only an
  // address at or above the entry SP (incoming stack arguments, the return
  // address, the caller's frame) still needs the entry SP as an input; such an
  // address, when live, keeps its `entry_sp + k` form beside the object. A
  // load through a reloaded address prints through the reload, so the stored
  // address at or above the entry SP is what designates those bytes.
  const frameObject =
    view === 'source' &&
    sharedEntry &&
    validation.presentation('frame_object', input.function.id, FRAME_OBJECT_SCOPE);
  // Source view (S4): with no exposure that can designate incoming bytes
  // (`incomingFloor` undefined) and no unbounded escape, the incoming bytes kept
  // as memory (a by-value aggregate modified in place, slots S1 did not bind)
  // are one object of their own: caller-supplied (the indirect-result pointer
  // among them), global and loaded pointers and stores through unknown
  // addresses never designate it, and no address this function derives from it
  // escapes or indexes memory. It prints as one source-only struct formal whose
  // members sit at their entry-SP offsets (`incoming`); every load and store
  // keeps its address, width, order and aliasing, and nothing is forwarded.
  // Offsets below the first incoming byte (the return address) keep their
  // forms; an access spanning that byte keeps the whole function unchanged.
  const incomingOrigin = abi.stack_return_address_bytes;
  const incomingKept = accesses.filter(
    (access) => !hidden.has(access.node.id) && access.end > incomingOrigin,
  );
  const incomingCandidate =
    view === 'source' &&
    !reachAll &&
    !variadicArea &&
    incomingFloor === undefined &&
    facts?.state === 'complete' &&
    (frameObject || !sharedEntry) &&
    incomingKept.length > 0 &&
    incomingKept.every((access) => access.offset >= incomingOrigin)
      ? incomingObject(
          incomingOrigin,
          incomingKept.reduce((end, access) => (access.end > end ? access.end : end), 0n),
        )
      : null;
  const incomingFormal =
    incomingCandidate &&
    validation.presentation('incoming_object', input.function.id, INCOMING_OBJECT_SCOPE)
      ? incomingCandidate
      : null;
  /** Source view (S4): a presented address inside the incoming object. */
  const requiresIncoming = (id: string): boolean =>
    incomingFormal !== null && (presented.get(id) ?? -1n) >= incomingOrigin;
  // A variadic area stands in for the entry SP: entry SP = va - offset.
  const area = variadicArea?.kind === 'area' ? variadicArea : null;
  const entryStorage = area ? area.area : sharedEntry || entryAddresses.size ? entryStack() : null;
  const requiresEntry = (id: string): boolean =>
    !requiresIncoming(id) &&
    (entryAddresses.has(id) ||
      (view === 'source' && presented.get(id)! >= 0n) ||
      (!frameObject && sharedEntry));
  if (entryStorage)
    for (const binding of entry.register_entry)
      if (
        binding.register.root === input.source!.abi.stack_pointer.root &&
        sameType(binding.value.type, entryStorage.type)
      )
        alias(
          binding.value,
          area?.offset
            ? {
                kind: 'integer',
                op: 'sub',
                left: entryStorage,
                right: make('variadic-entry-offset', entryStorage.type, entry.id, {
                  kind: 'constant',
                  bits: area.offset,
                }),
              }
            : { kind: 'cast', op: 'bitcast', value: entryStorage },
        );
  const returnAddressLoads = new Map<
    string,
    { node: Extract<Instruction, { kind: 'load' }>; block: string }
  >();
  for (const access of accesses)
    if (
      access.node.kind === 'load' &&
      !access.node.access.volatile &&
      access.offset === 0n &&
      access.end <= input.source!.abi.stack_return_address_bytes
    )
      returnAddressLoads.set(access.node.result.id, { node: access.node, block: access.block });
  // Source view: whether an access only moves bytes. A store is transport when
  // its datum is a constant or a load result, possibly rewrapped by bitcasts,
  // extracts and concatenations; a load, when every use of its result is the
  // datum of a store, directly or through such rewrapping. Uses are counted on
  // the plan's own facts: expression operands, statement operands (the store
  // datum and the register bindings of loads and stores aside), call arguments, control operands, return results and
  // transfer copies.
  let flow: { loads: Set<string>; other: Set<string>; wrapped: Map<string, string[]> } | undefined;
  const rewrap = (expression: Expression): boolean =>
    expression.kind === 'extract' ||
    expression.kind === 'concat' ||
    (expression.kind === 'cast' && expression.op === 'bitcast');
  const transport = (node: MemoryNode): boolean => {
    if (!flow) {
      const loads = new Set<string>(),
        other = new Set<string>(),
        wrapped = new Map<string, string[]>();
      const use = (values: readonly Value[]) => {
        for (const value of values) other.add(value.id);
      };
      const flowing = (id: string, expression: Expression) => {
        if (rewrap(expression))
          for (const operand of expressionOperands(expression))
            wrapped.set(operand.id, [...(wrapped.get(operand.id) ?? []), id]);
        else use(expressionOperands(expression));
      };
      for (const [id, expression] of expressions) flowing(id, expression);
      for (const { transfer } of transfers) use(transfer.copies.map((copy) => copy.source));
      for (const block of blocks.values()) {
        context.checkpoint(block.statements.length + 1);
        for (const statement of block.statements) {
          if (statement.kind === 'load') loads.add(statement.result.id);
          // The register bindings of a load or store only record the register
          // cells its operands came from; their values are the address and datum.
          if (statement.kind === 'store') use([statement.address]);
          else if (statement.kind === 'load') use([statement.address]);
          else if (statement.kind === 'assign') flowing(statement.result.id, statement.expression);
          else use(instructionOperands(statement));
          if (statement.kind === 'call') use(calls.get(statement.id)?.arguments ?? []);
        }
        const control = block.control;
        if (control.kind === 'if') use([control.condition]);
        else if (control.kind === 'switch') use([control.value]);
        else if (control.kind === 'return' || control.kind === 'indirect')
          use(terminatorOperands(control));
        if (control.kind === 'return') use(returns.get(control.id)?.results ?? []);
      }
      flow = { loads, other, wrapped };
    }
    const { loads, other, wrapped } = flow;
    // Every use of `id` is a store datum or a rewrapping whose result is.
    const moved = (id: string, depth = 0): boolean => {
      context.checkpoint(1);
      return (
        !other.has(id) &&
        (wrapped.get(id) ?? []).every((result) => depth < 16 && moved(result, depth + 1))
      );
    };
    // `id` is a constant or a load result, possibly rewrapped.
    const source = (id: string, depth = 0): boolean => {
      context.checkpoint(1);
      if (loads.has(id)) return true;
      const expression = expressions.get(id);
      return (
        expression !== undefined &&
        (expression.kind === 'constant' ||
          (rewrap(expression) &&
            depth < 16 &&
            expressionOperands(expression).every((operand) => source(operand.id, depth + 1))))
      );
    };
    return node.kind === 'load' ? moved(node.result.id) : source(node.value.id);
  };
  const frame = (
    retained: ReadonlySet<string>,
    live: ReadonlySet<string>,
  ): SourceStackStorage | null => {
    // The incoming object (S4) holds every incoming byte kept as memory.
    const remaining = accesses.filter(
      (access) =>
        retained.has(access.node.id) &&
        !hidden.has(access.node.id) &&
        !locals.has(access.node.id) &&
        !(incomingFormal && access.offset >= incomingOrigin),
    );
    let minimum = 0n,
      maximum = 0n;
    for (const access of remaining) {
      if (access.offset < minimum) minimum = access.offset;
      if (access.end > maximum) maximum = access.end;
    }
    // A pointer remains representable even after its private memory traffic dies.
    let addressLive = false;
    for (const [id, offset] of presented)
      if (live.has(id) && !requiresIncoming(id)) {
        addressLive = true;
        if (offset < minimum) minimum = offset;
        if (offset >= maximum) maximum = offset + 1n;
      }
    // `va_start(frame.va, …)` (S7) needs the frame object even when nothing else does.
    if (!remaining.length && !addressLive && variadicArea?.kind !== 'va_list') return null;
    const alignment = input.source!.abi.layout.stack_alignment;
    const entryLive = entryStorage !== null && live.has(entryStorage.id);
    const fallback = (): SourceStackStorage =>
      entryLive
        ? {
            kind: 'entry',
            base: entryStorage!,
            dynamic: dynamicStorage,
            minimum_offset: minimum,
            size: maximum - minimum,
            alignment,
          }
        : { kind: 'private', minimum_offset: minimum, size: maximum - minimum, alignment };
    // With the entry SP live, the object holds the bytes below it; no retained
    // access may span the entry SP, since its bytes would lie in both forms.
    if (
      view !== 'source' ||
      (entryLive
        ? remaining.some((access) => access.offset < 0n && access.end > 0n)
        : maximum > 0n) ||
      (sharedEntry && !frameObject)
    )
      return fallback();
    const below = entryLive ? remaining.filter((access) => access.end <= 0n) : remaining;
    // The register save area (S7) is va_start's, reached only through
    // `reg_save_area`: no frame member.
    const outside = (offset: bigint): boolean =>
      !saveArea || offset < saveArea.start || offset >= saveArea.end;
    const taken: bigint[] = [];
    for (const [id, offset] of presented)
      if (live.has(id) && offset < 0n && outside(offset)) taken.push(offset);
    context.checkpoint(below.length + taken.length);
    const indexed = saveArea ? new Set([...indexedBases].filter(outside)) : indexedBases,
      va = variadicArea?.kind === 'va_list' ? variadicArea.offset : undefined;
    // A3: with no unbounded escape and no live entry SP, a save area that is
    // wholly hidden save bytes up to the entry SP ends the object at its lowest
    // byte: no retained access, live address, indexed base, escape or `va`
    // lies there, and no escaped object reaches a save slot (`frame_save`).
    let top = 0n;
    if (!entryLive && !reachAll && saveBytes.size) {
      let lowest = 0n;
      for (const byte of saveBytes) if (byte < lowest) lowest = byte;
      const clear = (offset: bigint): boolean => offset < lowest || offset >= 0n;
      if (
        BigInt(saveBytes.size) === -lowest &&
        below.every((access) => access.end <= lowest) &&
        taken.every(clear) &&
        [...indexed].every(clear) &&
        [...escapeFloors.keys()].every(clear) &&
        (va === undefined || va + 24n <= lowest)
      )
        top = lowest;
    }
    const lay = (end: bigint) =>
      frameLayout(
        below.map((access) => ({
          offset: access.offset,
          end: access.end,
          id: access.node.id,
          transport: transport(access.node),
        })),
        taken,
        indexed,
        alignment,
        input.source!.abi.stack_return_address_bytes,
        'below',
        va,
        end,
      );
    let layout = lay(top);
    // An object needs a member: no frame byte below the entry SP stays memory
    // and no address of one is live, so the entry-SP form alone remains.
    if (
      !layout.members.length ||
      (!sharedEntry &&
        !validation.presentation('frame_object', input.function.id, FRAME_OBJECT_SCOPE)) ||
      (entryLive &&
        !validation.presentation(
          'frame_object_beside_entry_sp',
          input.function.id,
          'with the entry SP live, the frame object holds every frame byte below it; addresses at or above the entry SP (incoming stack arguments, the return address, the caller frame) keep the entry_sp + k form and every address below it prints through the object; no retained access spans the entry SP; every load and store keeps its address, width, order and aliasing, nothing is forwarded',
        ))
    )
      return fallback();
    const saveSubjects = [input.function.id, ...[...saveStores].slice(0, 63)];
    if (
      top < 0n &&
      !validation.presentation(
        'frame_object_save_area',
        input.function.id,
        'the frame object ends at the lowest frame save slot when every byte from it to the entry SP is a hidden save byte: no retained access, live address, indexed base or escape lies there and no escaped object reaches a save slot; every load and store keeps its address, width, order and aliasing, nothing is forwarded',
        saveSubjects,
      )
    ) {
      top = 0n;
      layout = lay(top);
    }
    if (top < 0n) validation.requireAbi('frame_save', saveSubjects, FRAME_SAVE_PREMISE);
    if (!entryLive && !reachAll && !saveArea && escapeFloors.size)
      layout = escapedSlots(layout, below, taken, indexed, top);
    if (sharedEntry) {
      validation.requireAbi(
        'frame_object',
        [input.function.id, ...below.slice(0, 63).map((access) => access.node.id)],
        "The frame object is this activation's stack frame: its bytes end at the entry SP, and its start is stack-aligned. Under ABI conformance a frame address handed to a callee, stored or indexed designates bytes inside it (never the caller's frame, incoming stack arguments or the return address), and no caller-supplied, global, loaded or returned pointer designates its bytes. Every load and store keeps its address, width, order and aliasing; the checked view and the original mappings keep the entry-SP form.",
      );
      if (entryLive)
        validation.requireAbi(
          'frame_object',
          [input.function.id, ...remaining.slice(0, 63).map((access) => access.node.id)],
          'Beside the frame object, an address at or above the entry SP designates incoming stack arguments, the return address or the caller frame, and no arithmetic on it (stored, reloaded, indexed or handed to a callee) reaches the frame object; under ABI conformance the incoming argument area and the caller frame are objects distinct from this activation frame.',
        );
    }
    return {
      kind: 'object',
      id: `entity_${fingerprint(['source-frame', input.function.id])}`,
      alignment,
      entry: entryLive ? entryStorage : null,
      ...layout,
    };
  };
  /** Source view (A3): each bounded escape reaches the bytes from its floor to
   * the lowest proven save slot above it (an exact escape, whose every address
   * lies in the object holding its one base) or to `top`; overlapping reaches
   * merge. A reach that is exactly one member, with no other access, taken
   * address or indexed base inside it except at its start, is an independent
   * local. The frame object then spans its other members and the remaining
   * reaches (none: no object bytes). */
  const escapedSlots = (
    layout: { minimum_offset: bigint; size: bigint; members: FrameMember[] },
    below: readonly FrameAccess[],
    taken: readonly bigint[],
    indexed: ReadonlySet<bigint>,
    top: bigint,
  ): { minimum_offset: bigint; size: bigint; members: FrameMember[] } => {
    const order = (left: bigint, right: bigint): number =>
      left < right ? -1 : left > right ? 1 : 0;
    const saveOffsets = [...saveBytes].sort(order);
    const reaches: { start: bigint; end: bigint }[] = [];
    for (const [floor, exact] of escapeFloors) {
      context.checkpoint(1);
      if (floor >= top) continue;
      let end = top;
      if (exact)
        for (const byte of saveOffsets)
          if (byte > floor) {
            if (byte < end) end = byte;
            break;
          }
      reaches.push({ start: floor, end });
    }
    reaches.sort((left, right) => order(left.start, right.start));
    const merged: { start: bigint; end: bigint }[] = [];
    for (const reach of reaches) {
      const last = merged.at(-1);
      if (last && reach.start < last.end) {
        if (reach.end > last.end) last.end = reach.end;
      } else merged.push({ ...reach });
    }
    // Reaches that are exactly one member; `ok` drops on a disqualifying offset.
    const members = layout.members,
      candidates: { start: bigint; end: bigint; member: FrameMember; ok: boolean }[] = [];
    for (let index = 0, cursor = 0; index < merged.length; index++) {
      const reach = merged[index]!;
      while (cursor < members.length && members[cursor]!.offset + members[cursor]!.size <= reach.start)
        cursor++;
      const member = members[cursor];
      if (
        member &&
        !member.va &&
        member.offset === reach.start &&
        member.offset + member.size === reach.end
      )
        candidates.push({ ...reach, member, ok: true });
    }
    const holding = (offset: bigint) => {
      for (let low = 0, high = candidates.length - 1; low <= high; ) {
        const middle = (low + high) >> 1,
          candidate = candidates[middle]!;
        if (offset < candidate.start) high = middle - 1;
        else if (offset >= candidate.end) low = middle + 1;
        else return candidate;
      }
      return undefined;
    };
    context.checkpoint(below.length + taken.length + indexed.size + escapeFloors.size);
    for (const access of below) {
      // An access overlapping a candidate lies inside it. None can span one:
      // a candidate ends at a save slot (which no access overlaps) or at `top`.
      const first = holding(access.offset),
        last = holding(access.end - 1n);
      if (first !== last) {
        if (first) first.ok = false;
        if (last) last.ok = false;
      }
    }
    for (const offset of [...taken, ...indexed, ...escapeFloors.keys()]) {
      const candidate = holding(offset);
      if (candidate && offset !== candidate.start) candidate.ok = false;
    }
    const chosen = candidates.filter((candidate) => candidate.ok);
    const subjects = [
      input.function.id,
      ...chosen.flatMap((candidate) => candidate.member.access_ids),
    ].slice(0, 64);
    if (
      !chosen.length ||
      !validation.presentation('escaped_slot_object', input.function.id, ESCAPED_SLOT_SCOPE, subjects)
    )
      return layout;
    validation.requireAbi('frame_object_base', subjects, ESCAPED_SLOT_PREMISE);
    if (chosen.some((candidate) => saveBytes.has(candidate.end)))
      validation.requireAbi('frame_save', subjects, FRAME_SAVE_PREMISE);
    const independent = new Set(chosen.map((candidate) => candidate.member)),
      starts = new Set(chosen.map((candidate) => candidate.start));
    let low: bigint | undefined, high: bigint | undefined;
    const span = (start: bigint, end: bigint) => {
      if (low === undefined || start < low) low = start;
      if (high === undefined || end > high) high = end;
    };
    for (const member of members)
      if (!independent.has(member)) span(member.offset, member.offset + member.size);
    for (const reach of merged) if (!starts.has(reach.start)) span(reach.start, reach.end);
    const returnAddress = input.source!.abi.stack_return_address_bytes,
      unit = BigInt(input.source!.abi.layout.stack_alignment),
      base = (low ?? top) + returnAddress,
      minimum = base - (((base % unit) + unit) % unit) - returnAddress;
    return {
      minimum_offset: minimum,
      size: (high ?? minimum) - minimum,
      members: members.map((member) =>
        independent.has(member)
          ? {
              ...member,
              independent: {
                id: `entity_${fingerprint(['source-frame-local', input.function.id, member.offset.toString()])}`,
              },
            }
          : member,
      ),
    };
  };
  /** Source view (S4): the incoming object when its formal is live, laid out
   * from the retained incoming accesses and live incoming addresses. */
  const incomingStorage = (
    retained: ReadonlySet<string>,
    live: ReadonlySet<string>,
  ): IncomingObject | null => {
    if (!incomingFormal || !live.has(incomingFormal.id)) return null;
    const kept = accesses.filter(
      (access) =>
        retained.has(access.node.id) &&
        !hidden.has(access.node.id) &&
        access.offset >= incomingOrigin,
    );
    const taken: bigint[] = [];
    for (const [id, offset] of presented)
      if (live.has(id) && offset >= incomingOrigin) taken.push(offset);
    context.checkpoint(kept.length + taken.length);
    const layout = frameLayout(
      kept.map((access) => ({
        offset: access.offset,
        end: access.end,
        id: access.node.id,
        transport: transport(access.node),
      })),
      taken,
      new Set(),
      input.source!.abi.layout.stack_alignment,
      incomingOrigin,
      'above',
    );
    validation.requireAbi(
      'incoming_object',
      [input.function.id, ...kept.slice(0, 63).map((access) => access.node.id)],
      'The incoming stack-argument bytes this function keeps as memory are one object of this activation, distinct from every other: under ABI conformance caller-supplied pointers (the indirect-result pointer among them), globals, loaded or returned pointers and stores through unknown addresses never designate them, and no address derived from them escapes or indexes memory here. Every load and store keeps its address, width, order and aliasing; nothing is forwarded; the checked view and the original mappings keep the entry-SP form.',
    );
    return {
      formal: incomingFormal,
      id: `entity_${fingerprint(['source-incoming', input.function.id])}`,
      ...layout,
    };
  };
  return {
    hidden,
    privateLoads,
    locals,
    addresses: presented,
    returnAddressLoads,
    frame,
    incomingStorage,
    entryStorage,
    requiresEntry,
    /** Source view (S4): the incoming object's formal, when one is presented. */
    incomingFormal,
    requiresIncoming,
    saves,
    deadReloadCandidates,
    forwardedReloads,
    /** Source view: indirect exits accepted by `classifyIndirectTails`. */
    indirectTails,
    /** Source view: the callee-side variadic interface, or null. */
    variadic: variadicArea,
  };
}
