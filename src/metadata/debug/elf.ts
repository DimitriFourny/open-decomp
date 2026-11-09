import { OperationError, type OperationContext } from '../../core/index.js';
import { DwarfReader, number } from '../dwarf/reader.js';
import { inflateZlib } from './inflate.js';

export interface ElfDebugHeaders {
  readonly machine: number;
  /** Lowercase hex GNU build ID (`.note.gnu.build-id`), or null. */
  readonly buildId: string | null;
  /** `.gnu_debuglink` file name and CRC-32 of the separate debug file, or null. */
  readonly debuglink: { readonly file: string; readonly crc: number } | null;
  /** Debug sections under the parser's Mach-O spelling (`__debug_info`). */
  readonly sections: Map<string, Uint8Array>;
  readonly diagnostics: string[];
  /** Embedded `.debug_*`/`.zdebug_*` data exists, decoded or not. */
  readonly present: boolean;
}
export interface ElfDebugSelection extends ElfDebugHeaders {
  /** How a supplied debug file was matched to the image; null for embedded DWARF. */
  readonly matched_by: 'build-id' | 'debuglink' | null;
}

// Only the sections the DWARF reader consumes; truncation mirrors Mach-O's 16-byte names.
const WANTED = new Set([
  '__debug_info',
  '__debug_abbrev',
  '__debug_str',
  '__debug_str_offs',
  '__debug_line',
  '__debug_line_str',
  '__debug_addr',
  '__debug_ranges',
  '__debug_rnglists',
  '__debug_loc',
  '__debug_loclists',
  '__debug_types',
]);
const MAX_SECTION_BYTES = 128 * 1024 * 1024;

function machOName(name: string): string {
  return `__${name.slice(name.startsWith('.zdebug_') ? 2 : 1)}`.slice(0, 16);
}

/** ELF64LE section headers only: no program headers, relocations or dependencies. */
function readElf(bytes: Uint8Array, context: OperationContext): ElfDebugHeaders {
  const r = new DwarfReader(bytes, 0, bytes.length, true);
  r.need(64);
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46)
    throw new Error('Debug input is not an ELF file');
  if (bytes[4] !== 2 || bytes[5] !== 1) throw new Error('Debug input must be ELF64 little-endian');
  r.position = 16;
  const type = r.u16(),
    machine = r.u16();
  if (type !== 2 && type !== 3)
    throw new Error(
      'Debug input must be a linked ELF (ET_EXEC/ET_DYN); relocatable objects are unsupported',
    );
  r.position = 0x28;
  const shoff = number(r.uint(8));
  r.position = 0x3a;
  const shentsize = r.u16(),
    shnum = r.u16(),
    shstrndx = r.u16();
  if (!shnum || shoff === 0) throw new Error('ELF debug input has no section table');
  if (shentsize !== 64 || shstrndx >= shnum || shstrndx === 0)
    throw new Error('Invalid ELF section table header');
  new DwarfReader(bytes, shoff).need(shnum * 64);
  interface Header {
    nameIndex: number;
    type: number;
    flags: bigint;
    offset: number;
    size: number;
  }
  const headers: Header[] = [];
  for (let index = 0; index < shnum; index++) {
    context.checkpoint(1);
    const h = new DwarfReader(bytes, shoff + index * 64, shoff + index * 64 + 64, true);
    const nameIndex = h.u32(),
      sectionType = h.u32(),
      flags = h.uint(8);
    h.uint(8);
    const offset = number(h.uint(8)),
      size = number(h.uint(8));
    if (sectionType !== 8 && sectionType !== 0) new DwarfReader(bytes, offset).need(size);
    headers.push({ nameIndex, type: sectionType, flags, offset, size });
  }
  const names = headers[shstrndx]!;
  if (names.type !== 3) throw new Error('ELF section-name table is not SHT_STRTAB');
  const name = (header: Header): string =>
    new DwarfReader(bytes, names.offset + header.nameIndex, names.offset + names.size).string();
  let buildId: string | null = null,
    debuglink: ElfDebugHeaders['debuglink'] = null,
    present = false;
  const sections = new Map<string, Uint8Array>(),
    diagnostics: string[] = [];
  for (const header of headers.slice(1)) {
    context.checkpoint(1);
    if (header.nameIndex >= names.size) throw new Error('ELF section name is outside its table');
    const sectionName = name(header);
    const data =
      header.type === 8 ? null : bytes.subarray(header.offset, header.offset + header.size);
    if (header.type === 7 && data && buildId === null) {
      // Notes: namesz, descsz, type, 4-byte padded name and descriptor.
      const n = new DwarfReader(data);
      while (n.end - n.position >= 12) {
        context.checkpoint(1);
        const nameSize = n.u32(),
          descriptorSize = n.u32(),
          noteType = n.u32();
        const owner = n.block(nameSize);
        n.block((4 - (nameSize % 4)) % 4);
        const descriptor = n.block(descriptorSize);
        n.block(Math.min((4 - (descriptorSize % 4)) % 4, n.end - n.position));
        if (
          noteType === 3 &&
          nameSize === 4 &&
          owner[0] === 0x47 &&
          owner[1] === 0x4e &&
          owner[2] === 0x55 &&
          owner[3] === 0 &&
          descriptorSize >= 1 &&
          descriptorSize <= 64
        ) {
          buildId = Array.from(descriptor, (byte) => byte.toString(16).padStart(2, '0')).join('');
          break;
        }
      }
    } else if (sectionName === '.gnu_debuglink' && data) {
      const link = new DwarfReader(data);
      const file = link.string();
      link.position = (link.position + 3) & ~3;
      debuglink = { file: file.slice(0, 4096), crc: link.u32() };
    }
    const compressedName = sectionName.startsWith('.zdebug_');
    if (!sectionName.startsWith('.debug_') && !compressedName) continue;
    present = true;
    const key = machOName(sectionName);
    if (!WANTED.has(key)) continue;
    if (!data) {
      diagnostics.push(`ELF debug section ${sectionName} has no file contents (SHT_NOBITS).`);
      continue;
    }
    if (header.flags & 2n) throw new Error(`ELF debug section ${sectionName} is allocated`);
    let contents: Uint8Array = data;
    try {
      if (header.flags & 0x800n) {
        // Elf64_Chdr: ch_type, ch_reserved, ch_size, ch_addralign.
        const c = new DwarfReader(data);
        const algorithm = c.u32();
        c.u32();
        const size = number(c.uint(8));
        c.uint(8);
        if (algorithm === 2) {
          diagnostics.push(
            `Unsupported zstd-compressed ELF debug section ${sectionName}; only zlib (ELFCOMPRESS_ZLIB) is decoded.`,
          );
          continue;
        }
        if (algorithm !== 1)
          throw new Error(`Unsupported ELF compression type ${algorithm} in ${sectionName}`);
        if (size > MAX_SECTION_BYTES) throw new Error(`${sectionName} exceeds 128 MiB`);
        contents = inflateZlib(data.subarray(24), size, () => context.checkpoint(1));
      } else if (compressedName) {
        // Legacy GNU `.zdebug_*`: "ZLIB" and a big-endian 64-bit size, then a zlib stream.
        const c = new DwarfReader(data, 0, data.length, false);
        if (c.u32() !== 0x5a4c4942) throw new Error(`${sectionName} lacks its ZLIB header`);
        const size = number(c.uint(8));
        if (size > MAX_SECTION_BYTES) throw new Error(`${sectionName} exceeds 128 MiB`);
        contents = inflateZlib(data.subarray(12), size, () => context.checkpoint(1));
      }
    } catch (error) {
      if (error instanceof OperationError) throw error;
      diagnostics.push(`Compressed ELF debug section ${sectionName}: ${String(error)}`);
      continue;
    }
    if (sections.has(key)) throw new Error(`Duplicate ELF debug section ${sectionName}`);
    sections.set(key, contents);
  }
  return { machine, buildId, debuglink, sections, diagnostics, present };
}

/** IEEE CRC-32 as `.gnu_debuglink` records it (same polynomial as zlib's crc32). */
export function debuglinkCrc(bytes: Uint8Array, context: OperationContext): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    if ((index & 0xffff) === 0) context.checkpoint(1);
    crc ^= bytes[index]!;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function mismatch(message: string): never {
  throw new OperationError({
    code: 'conflicting_evidence',
    severity: 'error',
    message,
    evidence_ids: [],
  });
}

/** Embedded DWARF of `targetBytes`, or the DWARF of a supplied separate debug file
 * (`objcopy --only-keep-debug` output). A supplied file must carry the image's GNU
 * build ID; an image without one is matched by its `.gnu_debuglink` CRC-32 of the
 * whole supplied file. No path in either file is ever opened. */
export function selectElfDebugSections(
  targetBytes: Uint8Array,
  context: OperationContext,
  bytes?: Uint8Array,
): ElfDebugSelection {
  context.checkpoint(0);
  if (targetBytes.length > MAX_SECTION_BYTES || (bytes?.length ?? 0) > MAX_SECTION_BYTES)
    throw new OperationError({
      code: 'resource_limit',
      severity: 'error',
      message: 'Debug input exceeds 128 MiB',
      evidence_ids: [],
    });
  const target = readElf(targetBytes, context);
  if (bytes === undefined) return { ...target, matched_by: null };
  const debug = readElf(bytes, context);
  if (debug.machine !== target.machine)
    mismatch('Debug file machine type does not match the selected image');
  if (target.buildId !== null) {
    if (debug.buildId !== target.buildId)
      mismatch(
        debug.buildId === null
          ? `Debug file has no GNU build ID; the image's is ${target.buildId}`
          : `Debug file build ID ${debug.buildId} does not match the image's ${target.buildId}`,
      );
    return { ...debug, matched_by: 'build-id' };
  }
  if (target.debuglink === null)
    mismatch(
      'Image has neither a GNU build ID nor a .gnu_debuglink; separate debug identity cannot be established',
    );
  const crc = debuglinkCrc(bytes, context);
  if (crc !== target.debuglink.crc)
    mismatch(
      `Debug file CRC-32 ${crc.toString(16).padStart(8, '0')} does not match the image's .gnu_debuglink (${target.debuglink.file}, ${target.debuglink.crc.toString(16).padStart(8, '0')})`,
    );
  return { ...debug, matched_by: 'debuglink' };
}
