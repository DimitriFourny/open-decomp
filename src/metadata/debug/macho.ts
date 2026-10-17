import { OperationError, type OperationContext } from '../../core/index.js';
import { DwarfReader, number, type DwarfSections } from '../dwarf/reader.js';

export interface ImageHeaders {
  cpu: number;
  subtype: number;
  uuid: string;
  little: boolean;
  sections: DwarfSections;
  diagnostics: string[];
}

function readHeaders(
  bytes: Uint8Array,
  collectSections: boolean,
  context: OperationContext,
): ImageHeaders {
  const magic = new DwarfReader(bytes, 0, bytes.length, false).u32();
  if (magic !== 0xcffaedfe && magic !== 0xfeedfacf)
    throw new Error('Debug input must contain a 64-bit Mach-O image');
  const little = magic === 0xcffaedfe,
    r = new DwarfReader(bytes, 4, bytes.length, little);
  const cpu = r.u32(),
    subtype = r.u32();
  r.u32();
  const count = r.u32(),
    commandSize = r.u32();
  r.uint(8);
  r.need(commandSize);
  const commandEnd = 32 + commandSize;
  if (count > commandSize / 8) throw new Error('Invalid Mach-O command count');
  let uuid = '';
  const sections = new Map<string, Uint8Array>(),
    diagnostics: string[] = [];
  const sectionRanges: { start: number; end: number }[] = [];
  for (let i = 0; i < count; i++) {
    context.checkpoint(1);
    const start = r.position,
      command = r.u32(),
      size = r.u32();
    if (size < 8 || size % 8 || size > commandEnd - start)
      throw new Error('Invalid Mach-O load command bounds');
    const c = new DwarfReader(bytes, start + 8, start + size, little);
    if (command === 0x1b) {
      if (uuid || size !== 24) throw new Error('Invalid or duplicate LC_UUID');
      const hex = Array.from(c.block(16), (byte) => byte.toString(16).padStart(2, '0')).join('');
      uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    } else if (command === 0x19 && collectSections) {
      c.block(56);
      const sectionCount = c.u32();
      c.u32();
      if (size !== 72 + sectionCount * 80) throw new Error('Invalid DWARF segment section table');
      for (let j = 0; j < sectionCount; j++) {
        context.checkpoint(1);
        const name = new TextDecoder().decode(c.block(16)).replace(/\0.*$/, '');
        const segment = new TextDecoder().decode(c.block(16)).replace(/\0.*$/, '');
        c.uint(8);
        const length = number(c.uint(8)),
          offset = c.u32();
        c.block(8);
        const relocations = c.u32();
        const flags = c.u32();
        c.block(12);
        if (segment !== '__DWARF') continue;
        if (name.startsWith('__zdebug')) {
          diagnostics.push(
            `Unsupported compressed DWARF section ${name}; decompress the dSYM before loading.`,
          );
          continue;
        }
        if (!name.startsWith('__debug_')) continue;
        if (relocations) {
          diagnostics.push(
            `Unsupported unresolved relocations in ${name}; load the linked dSYM rather than an object file.`,
          );
          continue;
        }
        if (length && offset < commandEnd)
          throw new Error(`DWARF section ${name} overlaps Mach-O headers`);
        if ([1, 12, 18].includes(flags & 255))
          throw new Error(`DWARF section ${name} is zero-fill`);
        const data = new DwarfReader(bytes, offset).block(length);
        if (length) sectionRanges.push({ start: offset, end: offset + length });
        if (data[0] === 0x5a && data[1] === 0x4c && data[2] === 0x49 && data[3] === 0x42) {
          diagnostics.push(
            `Unsupported compressed DWARF section ${name}; decompress the dSYM before loading.`,
          );
          continue;
        }
        if (sections.has(name)) throw new Error(`Duplicate DWARF section ${name}`);
        sections.set(name, data);
      }
    }
    r.position = start + size;
  }
  if (r.position !== commandEnd) throw new Error('Mach-O load command size mismatch');
  sectionRanges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < sectionRanges.length; i++)
    if (sectionRanges[i]!.start < sectionRanges[i - 1]!.end)
      throw new Error('Overlapping DWARF sections');
  return { cpu, subtype, uuid, little, sections, diagnostics };
}

/** Only supplied bytes are inspected; UUID/CPU identity is checked before DWARF parsing.
 * The target argument is the selected thin slice, not its fat container. */
export function selectDebugSections(
  targetBytes: Uint8Array,
  context: OperationContext,
  bytes?: Uint8Array,
): ImageHeaders {
  context.checkpoint(0);
  if (targetBytes.length > 128 * 1024 * 1024 || (bytes?.length ?? 0) > 128 * 1024 * 1024)
    throw new OperationError({
      code: 'resource_limit',
      severity: 'error',
      message: 'Debug input exceeds 128 MiB',
      evidence_ids: [],
    });
  const target = readHeaders(targetBytes, bytes === undefined, context);
  if (bytes === undefined) return target;
  if (!target.uuid)
    throw new OperationError({
      code: 'conflicting_evidence',
      severity: 'error',
      message: 'Selected image has no LC_UUID; external debug identity cannot be established',
      evidence_ids: [],
    });
  const header = new DwarfReader(bytes, 0, bytes.length, false),
    magic = header.u32();
  const candidates: ImageHeaders[] = [];
  if ([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) {
    const fat64 = magic === 0xcafebabf || magic === 0xbfbafeca;
    const r = new DwarfReader(bytes, 4, bytes.length, magic === 0xbebafeca || magic === 0xbfbafeca);
    const count = r.u32(),
      stride = fat64 ? 32 : 20;
    if (!count || count > 128) throw new Error('Universal debug input exceeds the 128-slice limit');
    r.need(count * stride);
    const entries: { cpu: number; subtype: number; offset: number; size: number }[] = [];
    for (let i = 0; i < count; i++) {
      context.checkpoint(1);
      const cpu = r.u32(),
        subtype = r.u32(),
        offset = number(r.uint(fat64 ? 8 : 4)),
        size = number(r.uint(fat64 ? 8 : 4));
      const alignment = r.u32();
      if (fat64) r.u32();
      if (
        !size ||
        offset < 8 + count * stride ||
        alignment > 63 ||
        BigInt(offset) % (1n << BigInt(alignment))
      )
        throw new Error('Invalid universal debug slice');
      new DwarfReader(bytes, offset).need(size);
      entries.push({ cpu, subtype, offset, size });
    }
    const sorted = [...entries].sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < sorted.length; i++)
      if (sorted[i]!.offset < sorted[i - 1]!.offset + sorted[i - 1]!.size)
        throw new Error('Overlapping universal debug slices');
    for (const entry of entries) {
      if (entry.cpu !== target.cpu || entry.subtype !== target.subtype) continue;
      const candidate = readHeaders(
        bytes.subarray(entry.offset, entry.offset + entry.size),
        true,
        context,
      );
      if (candidate.cpu !== entry.cpu || candidate.subtype !== entry.subtype)
        throw new Error('Universal architecture table disagrees with debug Mach-O header');
      candidates.push(candidate);
    }
  } else candidates.push(readHeaders(bytes, true, context));
  const matched = candidates.filter(
    (candidate) =>
      candidate.cpu === target.cpu &&
      candidate.subtype === target.subtype &&
      candidate.uuid === target.uuid,
  );
  if (matched.length !== 1)
    throw new OperationError({
      code: 'conflicting_evidence',
      severity: 'error',
      message: matched.length
        ? 'Ambiguous matching debug slices'
        : 'dSYM UUID or CPU type/subtype does not exactly match the selected image',
      evidence_ids: [],
    });
  const matchedImage = matched[0]!;
  return matchedImage;
}
