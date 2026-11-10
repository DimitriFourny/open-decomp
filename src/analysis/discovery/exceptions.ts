import type { LoadedImage, OperationContext } from '../../core/index.js';

/** Whether a function can be re-entered by an exception unwinder at a landing pad or handler:
 * `handler` when its own unwind record names one (ELF `.eh_frame` FDE with a non-null LSDA, PE
 * UNWIND_INFO with a language handler, Mach-O compact unwind entry with a personality),
 * `none` when its record names none or it has no unwind record (an exception cannot unwind
 * through it), `unknown` when the image's unwind data could not be read for it. */
export type ExceptionFact = 'none' | 'handler' | 'unknown';

export interface ExceptionFacts {
  /** The fact of the unwind record covering a function entry (its own record only). */
  at(entry: bigint, context: OperationContext): ExceptionFact;
}

interface Covered {
  readonly start: bigint;
  readonly end: bigint;
  readonly fact: ExceptionFact;
}

/** Exception facts per function entry, read once per image. ELF parses `.eh_frame` CIE/FDE
 * framing and the `zPLR` augmentation (pointer encodings absptr/udata/sdata, pc-relative or
 * absolute); any record it cannot read makes every entry `unknown`. PE and Mach-O read the
 * loaders' unwind hints; dropped unwind metadata (a partial PE exception directory, a Mach-O
 * compact unwind warning) and Mach-O entries that defer to DWARF CFI are `unknown`. */
export function exceptionFacts(image: LoadedImage, context: OperationContext): ExceptionFacts {
  const ranges: Covered[] = [];
  let complete = true;
  if (image.target.format === 'elf') {
    for (const section of image.sections) {
      context.checkpoint(1);
      if (section.kind !== 'section' || section.name !== '.eh_frame') continue;
      const parsed = parseEhFrame(image, section, context);
      if (!parsed) complete = false;
      else ranges.push(...parsed);
    }
  } else {
    if (
      image.capabilities.some(
        (item) =>
          item.layer === 'format' &&
          item.status === 'partial' &&
          /exception|unwind/i.test(item.feature),
      ) ||
      image.diagnostics.some((item) => /^(Compact unwind|DWARF CFI)/.test(item.message))
    )
      complete = false;
    for (const hint of image.hints) {
      context.checkpoint(1);
      if (hint.kind !== 'unwind') continue;
      const start = virtual(image, hint.range.start);
      if (start === null) continue;
      // arm64 compact unwind mode 3 defers to a DWARF FDE whose personality is not read here.
      const dwarf =
        /^compact-unwind-arm64:/.test(hint.encoding) &&
        ((Number.parseInt(hint.encoding.slice(hint.encoding.indexOf(':') + 1), 16) >>> 24) &
          0xf) ===
          3;
      ranges.push({
        start,
        end: start + hint.range.size,
        fact: hint.handler ? 'handler' : dwarf ? 'unknown' : 'none',
      });
    }
  }
  ranges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return {
    at(entry, operation) {
      if (!complete) return 'unknown';
      let fact: ExceptionFact = 'none';
      // Records may overlap (PE chained records): the strongest fact of any covering one wins.
      let low = 0,
        high = ranges.length;
      while (low < high) {
        operation.checkpoint(1);
        const mid = (low + high) >>> 1;
        if (ranges[mid]!.start <= entry) low = mid + 1;
        else high = mid;
      }
      // Sorted by start only: the covering records are among the last starts at or below the
      // entry (records of one image overlap only through PE chaining).
      for (let index = low - 1; index >= 0 && index >= low - 64; index--) {
        operation.checkpoint(1);
        const range = ranges[index]!;
        if (range.end <= entry) continue;
        if (range.fact === 'handler') return 'handler';
        if (range.fact === 'unknown') fact = 'unknown';
      }
      return fact;
    },
  };
}

function virtual(image: LoadedImage, address: LoadedImage['entry_points'][number]): bigint | null {
  const translated = image.address_map.translate(address, 'va');
  return translated.kind === 'mapped' ? translated.address.value : null;
}

/** `.eh_frame` FDE ranges and whether each has a non-null LSDA, or null when any record cannot
 * be read exactly. */
function parseEhFrame(
  image: LoadedImage,
  section: LoadedImage['sections'][number],
  context: OperationContext,
): Covered[] | null {
  if (section.file_range?.start.space !== 'file') return null;
  const vaStart = virtual(image, section.virtual_range.start);
  if (vaStart === null || section.file_range.size !== section.virtual_range.size) return null;
  const size = Number(section.file_range.size);
  if (!Number.isSafeInteger(size) || size > 1 << 28) return null;
  const bytes = image.bytes.read(section.file_range.start.value, size);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (): never => {
    throw new RangeError('eh_frame');
  };
  const u8 = (p: number): number => (p < size ? bytes[p]! : fail());
  const uleb = (p: number): [bigint, number] => {
    let value = 0n,
      shift = 0n;
    for (;;) {
      const byte = u8(p++);
      value |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if (!(byte & 0x80)) return [value, p];
      if (shift > 63n) fail();
    }
  };
  const sleb = (p: number): [bigint, number] => {
    let value = 0n,
      shift = 0n,
      byte: number;
    do {
      byte = u8(p++);
      value |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if (shift > 70n) fail();
    } while (byte & 0x80);
    if (byte & 0x40) value -= 1n << shift;
    return [value, p];
  };
  /** One encoded pointer at `p`: its value (pc-relative applied; 0 stays 0, the null
   * pointer) and the next offset. Only absptr/udata/sdata formats, absolute or pcrel. */
  const pointer = (encoding: number, p: number): [bigint, number] => {
    const format = encoding & 0x0f,
      application = encoding & 0x70;
    if (encoding & 0x80 || (application !== 0 && application !== 0x10)) fail();
    let raw: bigint, next: number;
    const need = (n: number) => (p + n <= size ? n : fail());
    switch (format) {
      case 0x00:
      case 0x04:
        need(8);
        raw = view.getBigUint64(p, true);
        next = p + 8;
        break;
      case 0x0c:
        need(8);
        raw = view.getBigInt64(p, true);
        next = p + 8;
        break;
      case 0x02:
        need(2);
        raw = BigInt(view.getUint16(p, true));
        next = p + 2;
        break;
      case 0x0a:
        need(2);
        raw = BigInt(view.getInt16(p, true));
        next = p + 2;
        break;
      case 0x03:
        need(4);
        raw = BigInt(view.getUint32(p, true));
        next = p + 4;
        break;
      case 0x0b:
        need(4);
        raw = BigInt(view.getInt32(p, true));
        next = p + 4;
        break;
      case 0x01:
        [raw, next] = uleb(p);
        break;
      case 0x09:
        [raw, next] = sleb(p);
        break;
      default:
        return fail();
    }
    if (raw === 0n) return [0n, next];
    return [BigInt.asUintN(64, application === 0x10 ? vaStart + BigInt(p) + raw : raw), next];
  };
  interface Cie {
    readonly fdeEncoding: number;
    readonly lsdaEncoding: number | null;
    readonly augmented: boolean;
  }
  const cies = new Map<number, Cie>();
  const readCie = (p: number, end: number): Cie => {
    const version = u8(p++);
    if (version !== 1 && version !== 3) fail();
    let augmentation = '';
    for (;;) {
      const byte = u8(p++);
      if (!byte) break;
      augmentation += String.fromCharCode(byte);
      if (augmentation.length > 16) fail();
    }
    if (augmentation && augmentation[0] !== 'z') fail();
    [, p] = uleb(p);
    [, p] = sleb(p);
    if (version === 1) p++;
    else [, p] = uleb(p);
    let fdeEncoding = 0x00,
      lsdaEncoding: number | null = null;
    if (augmentation) {
      const [length, data] = uleb(p);
      const dataEnd = data + Number(length);
      if (dataEnd > end) fail();
      p = data;
      for (const letter of augmentation.slice(1)) {
        if (letter === 'L') lsdaEncoding = u8(p++);
        else if (letter === 'R') fdeEncoding = u8(p++);
        else if (letter === 'P') {
          // The personality pointer is only skipped: any application or indirection.
          const encoding = u8(p++);
          [, p] = pointer(encoding & 0x0f, p);
        } else if (letter !== 'S' && letter !== 'B') fail();
      }
      if (p > dataEnd) fail();
    }
    if (p > end) fail();
    return { fdeEncoding, lsdaEncoding, augmented: augmentation.length > 0 };
  };
  const ranges: Covered[] = [];
  try {
    let p = 0;
    while (p < size) {
      context.checkpoint(1);
      if (p + 4 > size) fail();
      const length = view.getUint32(p, true);
      if (length === 0) break;
      if (length === 0xffffffff) fail();
      const body = p + 4,
        end = body + length;
      if (end > size || length < 4) fail();
      const id = view.getUint32(body, true);
      if (id === 0) cies.set(p, readCie(body + 4, end));
      else {
        const cieOffset = body - id;
        let cie = cies.get(cieOffset);
        if (!cie) {
          // A CIE may follow its FDEs only in theory; read it where it is.
          if (cieOffset < 0 || cieOffset + 8 > size) fail();
          const cieLength = view.getUint32(cieOffset, true);
          if (view.getUint32(cieOffset + 4, true) !== 0) fail();
          cie = readCie(cieOffset + 8, cieOffset + 4 + cieLength);
          cies.set(cieOffset, cie);
        }
        let q = body + 4;
        let begin: bigint, range: bigint;
        [begin, q] = pointer(cie.fdeEncoding, q);
        [range, q] = pointer(cie.fdeEncoding & 0x0f, q);
        let lsda = 0n;
        if (cie.augmented) {
          const [dataLength, data] = uleb(q);
          q = data;
          if (cie.lsdaEncoding !== null && cie.lsdaEncoding !== 0xff)
            [lsda] = pointer(cie.lsdaEncoding, q);
          q = data + Number(dataLength);
        }
        if (q > end) fail();
        if (begin !== 0n && range > 0n)
          ranges.push({ start: begin, end: begin + range, fact: lsda ? 'handler' : 'none' });
      }
      p = end;
    }
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  return ranges;
}
