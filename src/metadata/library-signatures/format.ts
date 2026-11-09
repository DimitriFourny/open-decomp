/** Library signatures: the functions of one library build, recognizable in a linked image by
 * their bytes with the position-dependent bytes masked out (IDA FLIRT, Binary Ninja WARP and
 * Ghidra Function ID solve the same problem).
 *
 * A signature is the whole function: its length, its first bytes (the lookup key) and a hash
 * of every byte, with masked bytes excluded. Masks come from the object's relocations (plus
 * the bytes a static linker may rewrite around a relaxable relocation), or, for signatures made
 * from a linked image, from the instructions that reference addresses. Bodies that are equal
 * after masking share one signature with several alternatives; an alternative may name the
 * functions its calls reach, which the matcher uses to choose between alternatives. */

export const SIGNATURE_FORMAT = 'open-decomp-signatures';
export const SIGNATURE_VERSION = 1;
/** Leading bytes kept in clear in a signature (the lookup key and a first check). */
export const SIGNATURE_HEAD = 32;

export type SignatureArchitecture = 'x86_64' | 'arm64';

/** One callable reached from a function: a call or jump into another function. `offset` is
 * the rel32 field on x86-64 (target = entry + offset + 4 + rel32) and the B/BL instruction on
 * ARM64 (target = entry + offset + imm26 * 4). */
export type SignatureCall = readonly [offset: number, name: string];

export interface SignatureAlternative {
  /** Symbol names at the function's address, the preferred name first. */
  readonly names: readonly string[];
  readonly calls: readonly SignatureCall[];
  /** A GNU IFUNC resolver: its body selects an implementation, it is not the declared function. */
  readonly ifunc?: true;
  /** Only local (static) symbols name it. */
  readonly local?: true;
  /** Where the body sits in its object: `[object, offset]`, the object an index unique in the
   * library. A linker keeps an object's section contiguous, so two functions of one object
   * keep their distance in the image. */
  readonly place?: readonly [number, number];
}

export interface SignatureFunction {
  readonly length: number;
  /** The first `min(length, SIGNATURE_HEAD)` bytes. Masked bytes hold 0. */
  readonly head: Uint8Array;
  /** Masked byte runs `[offset, length]` over the whole function, sorted and disjoint. */
  readonly mask: readonly (readonly [number, number])[];
  /** `signatureHash` of the whole function. */
  readonly hash: number;
  readonly alternatives: readonly SignatureAlternative[];
}

export interface SignatureLibrary {
  /** Stable identifier including the version, e.g. `glibc-2.41-x86_64`. */
  readonly id: string;
  /** Human-readable library and version. */
  readonly title: string;
  readonly architecture: SignatureArchitecture;
  /** Nominal import library whose C declarations the named functions implement (`libc.so.6`,
   * `ucrtbase.dll`, `/usr/lib/libSystem.B.dylib`), or null: matched names then carry no
   * library contract. */
  readonly contracts: string | null;
  /** Where the signatures come from (input files and package versions). */
  readonly source: string;
  readonly functions: readonly SignatureFunction[];
}

/** FNV-1a over the function: a masked byte hashes as 0x100, distinct from every byte value. */
export function signatureHash(bytes: Uint8Array, mask: readonly (readonly [number, number])[]) {
  let hash = 0x811c9dc5,
    run = 0;
  for (let offset = 0; offset < bytes.length; offset++) {
    while (run < mask.length && mask[run]![0] + mask[run]![1] <= offset) run++;
    const masked = run < mask.length && mask[run]![0] <= offset;
    hash = Math.imul(hash ^ (masked ? 0x100 : bytes[offset]!), 0x01000193);
  }
  return hash >>> 0;
}

/** Masked runs from a per-byte mask. */
export function maskRuns(masked: Uint8Array): [number, number][] {
  const runs: [number, number][] = [];
  for (let offset = 0; offset < masked.length; offset++) {
    if (!masked[offset]) continue;
    const last = runs[runs.length - 1];
    if (last && last[0] + last[1] === offset) last[1]++;
    else runs.push([offset, 1]);
  }
  return runs;
}

/** Bytes outside the mask, not counting a leading x86-64 `endbr64`: a body with few of them
 * carries too little evidence to name a function on its own. */
export function fixedBytes(fn: SignatureFunction, architecture: SignatureArchitecture): number {
  let fixed = fn.length;
  for (const [, length] of fn.mask) fixed -= length;
  const h = fn.head;
  if (architecture === 'x86_64' && h[0] === 0xf3 && h[1] === 0x0f && h[2] === 0x1e && h[3] === 0xfa)
    fixed -= 4;
  return fixed;
}

// ------------------------------------------------------------------ serialized form

/** The JSON file: `functions` rows are `[length, head hex, hash, mask, alternatives]`, an
 * alternative `[names, calls, flags]` or `[names, calls, flags, object, offset]` with flags
 * 1 = IFUNC resolver, 2 = local. */
interface SignatureFile {
  readonly format: typeof SIGNATURE_FORMAT;
  readonly version: typeof SIGNATURE_VERSION;
  readonly id: string;
  readonly title: string;
  readonly architecture: SignatureArchitecture;
  readonly contracts: string | null;
  readonly source: string;
  readonly functions: readonly (readonly [
    number,
    string,
    number,
    readonly (readonly [number, number])[],
    readonly (
      | readonly [readonly string[], readonly SignatureCall[], number]
      | readonly [readonly string[], readonly SignatureCall[], number, number, number]
    )[],
  ])[];
}

function hex(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0');
  return text;
}

export function encodeSignatureLibrary(library: SignatureLibrary): string {
  const file: SignatureFile = {
    format: SIGNATURE_FORMAT,
    version: SIGNATURE_VERSION,
    id: library.id,
    title: library.title,
    architecture: library.architecture,
    contracts: library.contracts,
    source: library.source,
    functions: library.functions.map((fn) => [
      fn.length,
      hex(fn.head),
      fn.hash,
      fn.mask,
      fn.alternatives.map((alternative) => {
        const flags = (alternative.ifunc ? 1 : 0) | (alternative.local ? 2 : 0);
        return alternative.place
          ? ([alternative.names, alternative.calls, flags, ...alternative.place] as const)
          : ([alternative.names, alternative.calls, flags] as const);
      }),
    ]),
  };
  // One function per line keeps the files diffable.
  const { functions, ...header } = file;
  return `${JSON.stringify(header).slice(0, -1)},"functions":[\n${functions
    .map((row) => JSON.stringify(row))
    .join(',\n')}\n]}\n`;
}

export class SignatureFormatError extends Error {}

const isInteger = (value: unknown, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;

/** Parse and validate a signature library file (untrusted input: a user's file). */
export function decodeSignatureLibrary(text: string): SignatureLibrary {
  let file: SignatureFile;
  try {
    file = JSON.parse(text) as SignatureFile;
  } catch {
    throw new SignatureFormatError('Not a signature library (invalid JSON)');
  }
  if (typeof file !== 'object' || file === null || file.format !== SIGNATURE_FORMAT)
    throw new SignatureFormatError('Not a signature library');
  if (file.version !== SIGNATURE_VERSION)
    throw new SignatureFormatError(`Unsupported signature library version ${String(file.version)}`);
  const text1024 = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 1024;
  if (
    !text1024(file.id) ||
    typeof file.title !== 'string' ||
    typeof file.source !== 'string' ||
    (file.architecture !== 'x86_64' && file.architecture !== 'arm64') ||
    (file.contracts !== null && !text1024(file.contracts)) ||
    !Array.isArray(file.functions)
  )
    throw new SignatureFormatError('Invalid signature library header');
  const functions = file.functions.map((row, index): SignatureFunction => {
    const fail = (): never => {
      throw new SignatureFormatError(`Invalid signature function #${index}`);
    };
    if (!Array.isArray(row) || row.length !== 5) fail();
    const [length, head, hash, mask, alternatives] = row as unknown as [
      number,
      string,
      number,
      [number, number][],
      unknown[],
    ];
    if (!isInteger(length, 1 << 24) || length === 0 || !isInteger(hash, 0xffffffff)) fail();
    if (
      typeof head !== 'string' ||
      head.length !== 2 * Math.min(length, SIGNATURE_HEAD) ||
      !/^[0-9a-f]*$/.test(head)
    )
      fail();
    let end = 0;
    if (!Array.isArray(mask)) fail();
    for (const run of mask) {
      if (!Array.isArray(run) || run.length !== 2 || !isInteger(run[0], length)) fail();
      if (!isInteger(run[1], length) || run[1] === 0 || run[0] < end || run[0] + run[1] > length)
        fail();
      end = run[0] + run[1];
    }
    if (!Array.isArray(alternatives) || !alternatives.length) fail();
    const parsed = alternatives.map((alternative): SignatureAlternative => {
      if (!Array.isArray(alternative) || (alternative.length !== 3 && alternative.length !== 5))
        fail();
      const [names, calls, flags, object, offset] = alternative as unknown as [
        string[],
        SignatureCall[],
        number,
        number?,
        number?,
      ];
      if (
        object !== undefined &&
        (!isInteger(object, Number.MAX_SAFE_INTEGER) || !isInteger(offset, 1 << 30))
      )
        fail();
      if (!Array.isArray(names) || !names.length || !names.every(text1024)) fail();
      if (!Array.isArray(calls) || !isInteger(flags, 3)) fail();
      for (const call of calls)
        if (
          !Array.isArray(call) ||
          call.length !== 2 ||
          !isInteger(call[0], length) ||
          !text1024(call[1])
        )
          fail();
      return {
        names,
        calls,
        ...(flags & 1 ? { ifunc: true as const } : {}),
        ...(flags & 2 ? { local: true as const } : {}),
        ...(object === undefined ? {} : { place: [object, offset!] as const }),
      };
    });
    const bytes = new Uint8Array(head.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(head.slice(2 * i, 2 * i + 2), 16);
    return { length, head: bytes, mask, hash, alternatives: parsed };
  });
  return {
    id: file.id,
    title: file.title,
    architecture: file.architecture,
    contracts: file.contracts,
    source: file.source,
    functions,
  };
}
