import type { Target } from '../../core/index.js';
import { findDeclaration } from '../library-contracts/catalog.js';
import { libraryLookupName } from '../symbols/c-names.js';
import {
  SIGNATURE_HEAD,
  fixedBytes,
  signatureHash,
  type SignatureAlternative,
  type SignatureArchitecture,
  type SignatureFunction,
  type SignatureLibrary,
} from './format.js';
import { MIN_FIXED_BYTES } from './generate.js';

/** The image a signature library is matched against: its discovered function entries and its
 * bytes. Matching never invents an entry: it names functions the index already has. */
export interface MatchTarget {
  readonly architecture: SignatureArchitecture;
  readonly format: Target['format'];
  /** Image bytes at a virtual address; shorter (or empty) where memory is not mapped. */
  read(address: bigint, length: number): Uint8Array;
  /** `name` is a native or asserted name, null for a generated one (`sub_…`): only unnamed
   * functions are matched, named ones are evidence for call constraints. */
  readonly functions: readonly {
    readonly id: string;
    readonly entry: bigint;
    readonly name: string | null;
  }[];
  /** Pointer slots a loader initializes to a code address (ELF IRELATIVE: slot -> resolver). */
  readonly resolvers?: ReadonlyMap<bigint, bigint>;
}

export interface LibraryMatch {
  readonly function_id: string;
  readonly entry: bigint;
  /** Signature library id. */
  readonly library: string;
  /** The name to present. */
  readonly name: string;
  /** Every symbol name the library gives the body. */
  readonly names: readonly string[];
  /** The library declaration the function implements, or null (an IFUNC resolver, an internal
   * function, or a library without declarations). */
  readonly contract: { readonly library: string; readonly name: string } | null;
  /** `ifunc_resolver`: a GNU IFUNC resolver; `ifunc_stub`: the PLT entry whose slot the
   * resolver fills, which is what callers call. */
  readonly kind: 'function' | 'ifunc_resolver' | 'ifunc_stub';
  /** Calls whose target was confirmed by name, and calls checked in all. */
  readonly confirmed_calls: number;
  readonly calls: number;
}

export interface AmbiguousMatch {
  readonly function_id: string;
  readonly entry: bigint;
  /** Names the body could be (several alternatives survive the call constraints). */
  readonly candidates: readonly { readonly library: string; readonly name: string }[];
}

export interface MatchReport {
  readonly matches: readonly LibraryMatch[];
  readonly ambiguous: readonly AmbiguousMatch[];
  /** Per library: functions named from it. */
  readonly libraries: readonly { readonly id: string; readonly matched: number }[];
}

interface Candidate {
  readonly library: SignatureLibrary;
  readonly fn: SignatureFunction;
  readonly alternative: SignatureAlternative;
  readonly weak: boolean;
}

/** Leading bytes used as the hash key. */
const KEY_BYTES = 12;

/** Signatures grouped by which of their leading bytes are masked, then by those bytes:
 * a lookup costs one hash probe per distinct leading mask, not one comparison per signature. */
class SignatureIndex {
  readonly groups = new Map<string, { length: number; fixed: number[]; table: Map<string, Candidate[]> }>();

  constructor(libraries: readonly SignatureLibrary[]) {
    for (const library of libraries)
      for (const fn of library.functions) {
        const length = Math.min(KEY_BYTES, fn.length);
        const masked = new Uint8Array(length);
        for (const [offset, size] of fn.mask)
          if (offset < length) masked.fill(1, offset, Math.min(length, offset + size));
        const fixed = [...masked.keys()].filter((offset) => !masked[offset]);
        const groupKey = `${length}:${fixed.join(',')}`;
        let group = this.groups.get(groupKey);
        if (!group) {
          group = { length, fixed, table: new Map() };
          this.groups.set(groupKey, group);
        }
        const key = fixed.map((offset) => fn.head[offset]).join(',');
        const list = group.table.get(key) ?? [];
        const weak = fixedBytes(fn, library.architecture) < MIN_FIXED_BYTES;
        for (const alternative of fn.alternatives) list.push({ library, fn, alternative, weak });
        group.table.set(key, list);
      }
  }

  candidates(bytes: Uint8Array): Candidate[] {
    const found: Candidate[] = [];
    for (const group of this.groups.values()) {
      if (bytes.length < group.length) continue;
      const hit = group.table.get(group.fixed.map((offset) => bytes[offset]).join(','));
      if (hit) found.push(...hit);
    }
    return found;
  }
}

/** Whether `bytes` (read at the function entry) is the signed body. */
function verify(fn: SignatureFunction, read: (length: number) => Uint8Array): boolean {
  const bytes = read(fn.length);
  if (bytes.length < fn.length) return false;
  let run = 0;
  for (let offset = 0; offset < Math.min(fn.length, SIGNATURE_HEAD); offset++) {
    while (run < fn.mask.length && fn.mask[run]![0] + fn.mask[run]![1] <= offset) run++;
    const masked = run < fn.mask.length && fn.mask[run]![0] <= offset;
    if (!masked && bytes[offset] !== fn.head[offset]) return false;
  }
  return signatureHash(bytes.subarray(0, fn.length), fn.mask) === fn.hash;
}

function callTarget(
  architecture: SignatureArchitecture,
  entry: bigint,
  offset: number,
  bytes: Uint8Array,
): bigint | null {
  if (offset + 4 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (architecture === 'x86_64')
    return entry + BigInt(offset + 4) + BigInt(view.getInt32(offset, true));
  const word = view.getUint32(offset, true);
  if ((word & 0x7c000000) !== 0x14000000) return null; // B / BL
  return entry + BigInt(offset) + BigInt(((word & 0x3ffffff) << 6) >> 6) * 4n;
}

/** An x86-64 PLT entry `[endbr64] [bnd] jmp *slot(%rip)`: its slot, else null. */
function pltSlot(entry: bigint, bytes: Uint8Array): bigint | null {
  let at = 0;
  if (bytes[0] === 0xf3 && bytes[1] === 0x0f && bytes[2] === 0x1e && bytes[3] === 0xfa) at = 4;
  if (bytes[at] === 0xf2) at++;
  if (bytes[at] !== 0xff || bytes[at + 1] !== 0x25 || at + 6 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return entry + BigInt(at + 6) + BigInt(view.getInt32(at + 2, true));
}

type TargetFunction = MatchTarget['functions'][number];

/** Surviving alternatives that give a function one name. */
interface NameGroup {
  readonly name: string;
  readonly contract: string | null;
  readonly ifunc: boolean;
  readonly members: readonly { readonly candidate: Candidate; readonly confirmed: number }[];
  /** A member sits at its distance from a matched function of the same object. */
  readonly placed: boolean;
  /** A member sits at its distance from other candidate bodies of its object (weaker than
   * `placed`: objects with the same layout and bodies all agree). */
  readonly clustered: boolean;
  /** A matched caller's call names the function so. */
  readonly claimed: boolean;
}

/** Name the unnamed functions of an image whose bodies a signature library knows.
 *
 * A body matches when its masked bytes equal a signature's (leading bytes, length and a hash
 * of the whole body). Each alternative of the signature is then checked against what is
 * already known:
 * - calls: an alternative is out when one of its calls reaches a function known (natively, or
 *   from a match) by another name; a call reaching the expected name confirms it;
 * - placement: a function of the same object already matched at the expected distance;
 * - claims: a matched function calls this one under one of the alternative's names;
 * - clusters: other candidate bodies of the same object found at their expected distances.
 * A short body (fewer than `MIN_FIXED_BYTES` fixed bytes) needs one of those. A function is
 * named when its surviving alternatives give it one name, or when exactly one of the names is
 * placed (else claimed, else clustered). Matches propagate until nothing changes, and a final
 * pass drops a match that a later match contradicts. Bodies left with several names are
 * reported as ambiguous, never named.
 *
 * x86-64 IFUNC: a resolver is named `<name>_resolver` without a contract, and the PLT entry
 * whose IRELATIVE slot it fills (what callers call) is named `<name>` with the contract. */
export function matchSignatures(
  libraries: readonly SignatureLibrary[],
  target: MatchTarget,
): MatchReport {
  const usable = libraries.filter((library) => library.architecture === target.architecture);
  const index = new SignatureIndex(usable);
  const reads = new Map<bigint, Uint8Array>();
  const read = (entry: bigint, length: number): Uint8Array => {
    const cached = reads.get(entry);
    if (cached && cached.length >= length) return cached.subarray(0, length);
    const bytes = target.read(entry, Math.max(length, 64));
    reads.set(entry, bytes);
    return bytes.subarray(0, length);
  };
  // Names each entry is known by, matched object bases, and names matched callers give.
  const known = new Map<bigint, Set<string>>();
  const bases = new Map<string, Set<bigint>>(),
    clusterBases = new Map<string, Set<bigint>>();
  const claims = new Map<bigint, Map<string, SignatureLibrary>>();
  for (const fn of target.functions)
    if (fn.name !== null) {
      const names = known.get(fn.entry) ?? new Set<string>();
      names.add(fn.name);
      names.add(libraryLookupName(target.format, fn.name));
      known.set(fn.entry, names);
    }
  const pending = new Map<string, { fn: TargetFunction; candidates: Candidate[] }>();
  for (const fn of target.functions) {
    if (fn.name !== null) continue;
    const candidates = index
      .candidates(read(fn.entry, KEY_BYTES))
      .filter((candidate) => verify(candidate.fn, (length) => read(fn.entry, length)));
    if (candidates.length) pending.set(fn.id, { fn, candidates });
  }
  // Bodies of one object found at their mutual distances place each other, even when each is
  // too short to name a function alone (a distinct base per pairing: identical bodies of one
  // object agree on a base only in their true order).
  const clusters = new Map<string, Map<bigint, number>>();
  for (const { fn, candidates } of pending.values())
    for (const candidate of candidates) {
      const place = candidate.alternative.place;
      if (!place) continue;
      const key = `${candidate.library.id}\0${place[0]}\0${fn.entry - BigInt(place[1])}`;
      const members = clusters.get(key) ?? new Map<bigint, number>();
      const fixed = fixedBytes(candidate.fn, target.architecture);
      members.set(fn.entry, Math.max(members.get(fn.entry) ?? 0, fixed));
      clusters.set(key, members);
    }
  for (const [key, members] of clusters) {
    let fixed = 0;
    for (const bytes of members.values()) fixed += bytes;
    if (members.size < 2 || fixed < 2 * MIN_FIXED_BYTES) continue;
    const at = key.lastIndexOf('\0');
    const object = key.slice(0, at),
      set = clusterBases.get(object) ?? new Set<bigint>();
    set.add(BigInt(key.slice(at + 1)));
    clusterBases.set(object, set);
  }
  // IFUNC PLT entries and the resolvers their slots name.
  const stubs = new Map<string, { fn: TargetFunction; resolver: bigint }>();
  const stubOf = new Map<bigint, bigint>();
  if (target.architecture === 'x86_64' && target.resolvers?.size)
    for (const fn of target.functions) {
      if (fn.name !== null) continue;
      const slot = pltSlot(fn.entry, read(fn.entry, 16));
      const resolver = slot === null ? undefined : target.resolvers.get(slot);
      if (resolver === undefined) continue;
      stubs.set(fn.id, { fn, resolver });
      stubOf.set(resolver, fn.entry);
    }
  const contractName = (library: SignatureLibrary, names: readonly string[]): string | null => {
    if (library.contracts === null) return null;
    return (
      names.find((name) =>
        findDeclaration(libraryLookupName(target.format, name), library.contracts!, target.format),
      ) ?? null
    );
  };
  const callTargets = (entry: bigint, candidate: Candidate) => {
    const bytes = read(entry, candidate.fn.length);
    return candidate.alternative.calls.map(
      ([offset, name]) => [callTarget(target.architecture, entry, offset, bytes), name] as const,
    );
  };
  const check = (entry: bigint, candidate: Candidate) => {
    let confirmed = 0,
      contradicted = 0;
    for (const [to, name] of callTargets(entry, candidate)) {
      const names = to === null ? undefined : known.get(to);
      if (!names) continue;
      if (names.has(name)) confirmed++;
      else contradicted++;
    }
    return { confirmed, contradicted };
  };
  const placeKey = (candidate: Candidate) =>
    candidate.alternative.place && `${candidate.library.id}\0${candidate.alternative.place[0]}`;
  const isPlaced = (entry: bigint, candidate: Candidate, among = bases) => {
    const key = placeKey(candidate);
    return !!key && !!among.get(key)?.has(entry - BigInt(candidate.alternative.place![1]));
  };
  const claimedAs = (entry: bigint): ReadonlyMap<string, SignatureLibrary> | undefined => {
    // Calls of an IFUNC function reach its PLT entry, not its resolver.
    const stub = stubOf.get(entry);
    return claims.get(stub ?? entry);
  };
  const groupsOf = (fn: TargetFunction, candidates: readonly Candidate[]) => {
    let waiting = false;
    const groups = new Map<string, NameGroup>();
    const claimed = claimedAs(fn.entry);
    for (const candidate of candidates) {
      const { confirmed, contradicted } = check(fn.entry, candidate);
      if (contradicted) continue;
      const names = candidate.alternative.names;
      const placed = isPlaced(fn.entry, candidate),
        clustered = isPlaced(fn.entry, candidate, clusterBases),
        isClaimed = !!claimed && names.some((name) => claimed.has(name));
      if (candidate.weak && !confirmed && !placed && !clustered && !isClaimed) {
        waiting = true;
        continue;
      }
      const ifunc = candidate.alternative.ifunc === true;
      const contract = ifunc ? null : contractName(candidate.library, names);
      const name = contract ?? names[0]!;
      const prior = groups.get(name);
      groups.set(name, {
        name,
        contract: prior?.contract ?? contract,
        ifunc: (prior?.ifunc ?? false) || ifunc,
        members: [...(prior?.members ?? []), { candidate, confirmed }],
        placed: (prior?.placed ?? false) || placed,
        clustered: (prior?.clustered ?? false) || clustered,
        claimed: (prior?.claimed ?? false) || isClaimed,
      });
    }
    return { groups: [...groups.values()], waiting };
  };
  const matches = new Map<string, LibraryMatch>();
  const record = (match: LibraryMatch, members: readonly NameGroup['members'][number][]) => {
    matches.set(match.function_id, match);
    known.set(match.entry, new Set([match.name, ...match.names]));
    for (const { candidate } of members) {
      const key = placeKey(candidate);
      if (key) {
        const set = bases.get(key) ?? new Set<bigint>();
        set.add(match.entry - BigInt(candidate.alternative.place![1]));
        bases.set(key, set);
      }
      for (const [to, name] of callTargets(match.entry, candidate)) {
        if (to === null || known.has(to)) continue;
        const names = claims.get(to) ?? new Map<string, SignatureLibrary>();
        names.set(name, candidate.library);
        claims.set(to, names);
      }
    }
  };
  /** Name one function from its groups: 'named', 'ambiguous', 'waiting' or 'none'. */
  const decide = (fn: TargetFunction, candidates: readonly Candidate[]) => {
    const { groups, waiting } = groupsOf(fn, candidates);
    if (!groups.length) return waiting ? 'waiting' : 'none';
    let chosen = groups.length === 1 ? groups[0] : undefined;
    if (!chosen) {
      // The strongest discriminating evidence that singles out one name.
      for (const evidence of ['placed', 'claimed', 'clustered'] as const) {
        const having = groups.filter((group) => group[evidence]);
        if (having.length === 1) chosen = having[0];
        if (having.length) break;
      }
    }
    if (!chosen) return 'ambiguous';
    const library = chosen.members[0]!.candidate.library;
    record(
      {
        function_id: fn.id,
        entry: fn.entry,
        library: library.id,
        name: chosen.ifunc ? `${chosen.name}_resolver` : chosen.name,
        names: [...new Set(chosen.members.flatMap(({ candidate }) => candidate.alternative.names))],
        contract:
          chosen.contract === null ? null : { library: library.contracts!, name: chosen.contract },
        kind: chosen.ifunc ? 'ifunc_resolver' : 'function',
        confirmed_calls: Math.min(...chosen.members.map((member) => member.confirmed)),
        calls: Math.min(...chosen.members.map(({ candidate }) => candidate.alternative.calls.length)),
      },
      chosen.members,
    );
    return 'named';
  };
  /** An IFUNC PLT entry takes the name of its matched resolver, else the one callers give it. */
  const nameStub = (id: string, fn: TargetFunction, resolver: bigint): boolean => {
    const matched = [...matches.values()].find(
      (match) => match.entry === resolver && match.kind === 'ifunc_resolver',
    );
    let name: string, names: readonly string[], library: SignatureLibrary;
    if (matched) {
      name = matched.name.replace(/_resolver$/, '');
      names = matched.names;
      library = usable.find((item) => item.id === matched.library)!;
    } else {
      const claimed = claims.get(fn.entry);
      if (!claimed || claimed.size !== 1 || known.has(resolver)) return false;
      [name, library] = [...claimed][0]!;
      names = [name];
    }
    const contract = contractName(library, names);
    record(
      {
        function_id: id,
        entry: fn.entry,
        library: library.id,
        name: contract ?? name,
        names,
        contract: contract === null ? null : { library: library.contracts!, name: contract },
        kind: 'ifunc_stub',
        confirmed_calls: 0,
        calls: 0,
      },
      [],
    );
    return true;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id, { fn, resolver }] of stubs)
      if (nameStub(id, fn, resolver)) {
        stubs.delete(id);
        changed = true;
      }
    for (const [id, { fn, candidates }] of pending) {
      const outcome = decide(fn, candidates);
      if (outcome === 'named' || outcome === 'none') pending.delete(id);
      if (outcome === 'named') changed = true;
    }
  }
  // A match made before a callee was named can be contradicted by that callee's match.
  for (const [id, match] of matches) {
    if (match.kind === 'ifunc_stub') continue;
    const candidates = index
      .candidates(read(match.entry, KEY_BYTES))
      .filter(
        (candidate) =>
          candidate.library.id === match.library &&
          candidate.alternative.names.some((name) => match.names.includes(name)) &&
          verify(candidate.fn, (length) => read(match.entry, length)),
      );
    if (candidates.every((candidate) => check(match.entry, candidate).contradicted)) {
      matches.delete(id);
      known.delete(match.entry);
    }
  }
  const ambiguous: AmbiguousMatch[] = [];
  for (const { fn, candidates } of pending.values()) {
    const { groups } = groupsOf(fn, candidates);
    if (groups.length > 1)
      ambiguous.push({
        function_id: fn.id,
        entry: fn.entry,
        candidates: groups.map((group) => ({
          library: group.members[0]!.candidate.library.id,
          name: group.name,
        })),
      });
  }
  const all = [...matches.values()].sort((a, b) => (a.entry < b.entry ? -1 : 1));
  return {
    matches: all,
    ambiguous,
    libraries: usable.map((library) => ({
      id: library.id,
      matched: all.filter((match) => match.library === library.id).length,
    })),
  };
}
