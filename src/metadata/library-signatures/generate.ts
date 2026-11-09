import {
  SIGNATURE_HEAD,
  fixedBytes,
  maskRuns,
  signatureHash,
  type SignatureAlternative,
  type SignatureCall,
  type SignatureFunction,
  type SignatureLibrary,
} from './format.js';

/** A function body to sign: from a relocatable object or a linked image with symbols. */
export interface SignatureSource {
  readonly names: readonly {
    readonly name: string;
    readonly binding: 'local' | 'global' | 'weak';
  }[];
  readonly bytes: Uint8Array;
  /** 1 where the byte is position-dependent. */
  readonly masked: Uint8Array;
  readonly calls: readonly SignatureCall[];
  readonly ifunc: boolean;
  /** The object section (any key unique in the library) and the body's offset in it. */
  readonly place?: { readonly object: string; readonly offset: number };
}

export interface SignatureStats {
  /** Function bodies read. */
  readonly bodies: number;
  /** Signatures written (bodies equal after masking share one). */
  readonly signatures: number;
  /** Signatures with more than one alternative (equal bodies with different names or callees). */
  readonly shared: number;
  /** Bodies left out: compiler-split cold parts, and bodies with too few fixed bytes and no
   * named callee to confirm them. */
  readonly skipped: number;
}

/** Fewer fixed bytes than this: a body needs a matched callee to name a function. */
export const MIN_FIXED_BYTES = 12;

const leadingUnderscores = (name: string) => /^_*/.exec(name)![0].length;

/** Aliases in preference order: global before local, fewer leading underscores, plain C
 * identifiers before compiler clones (`foo.isra.0`), then shorter. */
export function preferredNames(names: SignatureSource['names']): string[] {
  const rank = (entry: SignatureSource['names'][number]) => [
    entry.binding === 'local' ? 1 : 0,
    leadingUnderscores(entry.name),
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name) ? 0 : 1,
    entry.name.length,
  ];
  return [
    ...new Set(
      [...names]
        .sort((a, b) => {
          const x = rank(a),
            y = rank(b);
          for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
          return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        })
        .map((entry) => entry.name),
    ),
  ];
}

/** Build a signature library from function bodies. Equal masked bodies merge into one
 * signature whose alternatives keep each name set with its callees. */
export function buildSignatureLibrary(
  sources: Iterable<SignatureSource>,
  header: Omit<SignatureLibrary, 'functions'>,
): { library: SignatureLibrary; stats: SignatureStats } {
  const byBody = new Map<
    string,
    { fn: Omit<SignatureFunction, 'alternatives'>; alternatives: Map<string, SignatureAlternative> }
  >();
  const objects = new Map<string, number>();
  let bodies = 0,
    skipped = 0;
  for (const source of sources) {
    bodies++;
    const names = preferredNames(
      source.names.filter((entry) => !/\.cold(\.\d+)?$/.test(entry.name)),
    );
    if (!names.length || !source.bytes.length) {
      skipped++;
      continue;
    }
    const mask = maskRuns(source.masked);
    const head = source.bytes.slice(0, SIGNATURE_HEAD);
    for (const [offset, length] of mask)
      if (offset < head.length) head.fill(0, offset, Math.min(head.length, offset + length));
    const fn = { length: source.bytes.length, head, mask, hash: signatureHash(source.bytes, mask) };
    const calls = [...source.calls].sort((a, b) => a[0] - b[0]);
    // A short body names nothing alone: it needs a named callee or a placed neighbour.
    if (
      fixedBytes({ ...fn, alternatives: [] }, header.architecture) < MIN_FIXED_BYTES &&
      !calls.length &&
      !source.place
    ) {
      skipped++;
      continue;
    }
    let object: number | undefined;
    if (source.place) {
      object = objects.get(source.place.object) ?? objects.size;
      objects.set(source.place.object, object);
    }
    const alternative: SignatureAlternative = {
      names,
      calls,
      ...(source.ifunc ? { ifunc: true as const } : {}),
      ...(source.names.every((entry) => entry.binding === 'local') ? { local: true as const } : {}),
      ...(object === undefined ? {} : { place: [object, source.place!.offset] as const }),
    };
    const key = `${fn.length}:${fn.hash}:${JSON.stringify(mask)}:${[...head].join(',')}`;
    let entry = byBody.get(key);
    if (!entry) {
      entry = { fn, alternatives: new Map() };
      byBody.set(key, entry);
    }
    entry.alternatives.set(JSON.stringify(alternative), alternative);
  }
  const functions = [...byBody.values()].map(({ fn, alternatives }) => ({
    ...fn,
    alternatives: [...alternatives.values()],
  }));
  return {
    library: { ...header, functions },
    stats: {
      bodies,
      signatures: functions.length,
      shared: functions.filter((fn) => fn.alternatives.length > 1).length,
      skipped,
    },
  };
}
