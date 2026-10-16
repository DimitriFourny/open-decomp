import { AddressMap, sliceIdentity, type ImageSlice, type ImmutableBytes, type Loader, type LoadedImage, type MetadataField, type OperationContext, type Diagnostic, type ImageMapping } from '../../core/index.js';
import { MachOError, Reader, malformed, safe, vmEnd, type Payload } from './reader.js';
import { State } from './state.js';
import { readDyld } from './dyld.js';
import { readExports, readHints, readSymbols, type SymbolTable, type IndirectTable } from './metadata.js';
export { MachOError } from './reader.js';

const COMMAND_NAMES: Record<number, string> = {
  1: 'LC_SEGMENT', 2: 'LC_SYMTAB', 5: 'LC_UNIXTHREAD', 11: 'LC_DYSYMTAB', 12: 'LC_LOAD_DYLIB', 13: 'LC_ID_DYLIB', 14: 'LC_LOAD_DYLINKER', 15: 'LC_ID_DYLINKER', 25: 'LC_SEGMENT_64', 27: 'LC_UUID', 29: 'LC_CODE_SIGNATURE', 30: 'LC_SEGMENT_SPLIT_INFO', 32: 'LC_LAZY_LOAD_DYLIB', 33: 'LC_ENCRYPTION_INFO', 34: 'LC_DYLD_INFO', 36: 'LC_VERSION_MIN_MACOSX', 37: 'LC_VERSION_MIN_IPHONEOS', 38: 'LC_FUNCTION_STARTS', 41: 'LC_DATA_IN_CODE', 42: 'LC_SOURCE_VERSION', 43: 'LC_DYLIB_CODE_SIGN_DRS', 44: 'LC_ENCRYPTION_INFO_64', 46: 'LC_LINKER_OPTIMIZATION_HINT', 47: 'LC_VERSION_MIN_TVOS', 48: 'LC_VERSION_MIN_WATCHOS', 50: 'LC_BUILD_VERSION',
  0x80000018: 'LC_LOAD_WEAK_DYLIB', 0x8000001c: 'LC_RPATH', 0x8000001f: 'LC_REEXPORT_DYLIB', 0x80000022: 'LC_DYLD_INFO_ONLY', 0x80000023: 'LC_LOAD_UPWARD_DYLIB', 0x80000028: 'LC_MAIN', 0x80000033: 'LC_DYLD_EXPORTS_TRIE', 0x80000034: 'LC_DYLD_CHAINED_FIXUPS',
};
const LINKEDIT: Record<number, true> = { 29: true, 30: true, 38: true, 41: true, 43: true, 46: true, 0x80000033: true, 0x80000034: true };
const DYLIB: Record<number, true> = { 12: true, 13: true, 32: true, 0x80000018: true, 0x8000001f: true, 0x80000023: true };
const SUBTYPES: Record<number, string> = { 0: 'arm64', 1: 'arm64v8', 2: 'arm64e' };

/**
 * Static ARM64/ARM64v8/ARM64e executable and dylib loading, including FAT32/FAT64
 * in either byte order. All file coordinates are original-container offsets.
 *
 * Safety limits: 128 MiB containers, 1,024 slices, 65,536 load commands,
 * 100,000 nlist symbols, 8,192-byte names, plus the caller's work/deadline budget.
 * Optional malformed metadata remains explicit in diagnostics and capabilities.
 * Unknown commands/subtypes are retained, never guessed. Kernel/cache/32-bit
 * chained formats, compressed chained names, threaded binds, SG_HIGHVM, and full
 * DWARF CFI augmentation semantics are diagnosed, not silently approximated.
 * Compact unwind provides ranges; CFI bytes are retained for the DWARF layer.
 * Adapted from the checked range, export-trie, dyld and indirect-import behavior
 * in disass_arm; no sibling module, browser API, native tool or target execution
 * is used at runtime.
 */
export class MachOLoader implements Loader {
  readonly name = 'open-decomp-macho';
  readonly version = '1.0.2';
  readonly format = 'macho' as const;
  inspect(bytes: ImmutableBytes, imageId: string, context: OperationContext): { slices: readonly ImageSlice[]; diagnostics: readonly Diagnostic[] } {
    context.checkpoint(1);
    if (bytes.length < 4) malformed('Truncated Mach-O magic');
    if (bytes.length > 128 * 1024 * 1024) throw new MachOError('resource_limit', 'Mach-O container exceeds 128 MiB parser limit');
    const magic = bytes.u32(0n, false), fat64 = magic === 0xcafebabf || magic === 0xbfbafeca;
    const fat = fat64 || magic === 0xcafebabe || magic === 0xbebafeca;
    const diagnostics: Diagnostic[] = [], slices: ImageSlice[] = [];
    const add = (offset: bigint, size: bigint, expected?: { cpu: number; subtype: number }) => {
      context.checkpoint(1);
      if (size < 4n || offset < 0n || offset + size > BigInt(bytes.length)) malformed('Mach-O slice outside container');
      const sliceMagic = bytes.u32(offset, false), little = sliceMagic === 0xcffaedfe || sliceMagic === 0xcefaedfe;
      if (![0xcffaedfe, 0xfeedfacf, 0xcefaedfe, 0xfeedface].includes(sliceMagic)) {
        if (!expected) throw new MachOError('unsupported_target', `Unknown executable magic 0x${sliceMagic.toString(16)}`);
        malformed('Universal slice is not Mach-O');
      }
      const is64 = sliceMagic === 0xcffaedfe || sliceMagic === 0xfeedfacf;
      if (size < BigInt(is64 ? 32 : 28)) malformed('Truncated Mach-O header');
      const r = new Reader(bytes, offset, safe(size), context, little), cpu = r.u32(4), subtype = r.u32(8), filetype = r.u32(12), baseSubtype = subtype & 0xffffff;
      if (expected && (expected.cpu !== cpu || expected.subtype !== subtype)) malformed('Fat architecture table disagrees with slice header');
      const architecture = cpu === 0x100000c ? 'arm64' : cpu === 0x1000007 ? 'x86_64' : `cpu-0x${cpu.toString(16)}`;
      const supported = cpu === 0x100000c && is64 && little && SUBTYPES[baseSubtype] !== undefined && (filetype === 2 || filetype === 6);
      const slice = { id: sliceIdentity(imageId, offset, size, architecture), image_id: imageId, offset, size, architecture, subtype: cpu === 0x100000c ? `${SUBTYPES[baseSubtype] ?? `unknown-${baseSubtype}`}:0x${subtype.toString(16)}` : `0x${subtype.toString(16)}`, supported };
      slices.push(slice);
      if (!supported) diagnostics.push({ code: 'unsupported_target', severity: 'warning', message: `Unsupported Mach-O target: CPU 0x${cpu.toString(16)}, subtype 0x${subtype.toString(16)}, filetype ${filetype}, ${is64 ? 64 : 32}-bit ${little ? 'little' : 'big'} endian`, evidence_ids: [] });
    };
    if (!fat) { add(0n, BigInt(bytes.length)); return { slices, diagnostics }; }
    const r = new Reader(bytes, 0n, bytes.length, context, magic === 0xbebafeca || magic === 0xbfbafeca), count = r.u32(4), stride = fat64 ? 32 : 20;
    if (count < 1 || count > 1024) malformed('Universal architecture count outside 1..1024');
    r.range(8, count * stride);
    const entries: { offset: bigint; size: bigint; cpu: number; subtype: number }[] = [];
    for (let i = 0; i < count; i++) {
      context.checkpoint(1); const p = 8 + i * stride, offset = fat64 ? r.u64(p + 8) : BigInt(r.u32(p + 8)), size = fat64 ? r.u64(p + 16) : BigInt(r.u32(p + 12)), align = r.u32(p + (fat64 ? 24 : 16));
      if (!size || offset < BigInt(8 + count * stride) || offset + size > BigInt(bytes.length) || align > 63 || offset % (1n << BigInt(align))) malformed('Invalid universal slice range/alignment');
      if (fat64 && r.u32(p + 28) !== 0) malformed('Reserved FAT64 field is nonzero');
      entries.push({ offset, size, cpu: r.u32(p), subtype: r.u32(p + 4) });
    }
    const ordered = [...entries].sort((a, b) => a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0);
    for (let i = 1; i < ordered.length; i++) if (ordered[i]!.offset < ordered[i - 1]!.offset + ordered[i - 1]!.size) malformed('Overlapping universal slices');
    for (const entry of entries) add(entry.offset, entry.size, entry);
    return { slices, diagnostics };
  }
  load(input: Parameters<Loader['load']>[0], context: OperationContext): LoadedImage {
    const inspection = this.inspect(input.bytes, input.image_id, context), supported = inspection.slices.filter(slice => slice.supported);
    let slice: ImageSlice | undefined;
    if (input.slice_id !== null) {
      slice = inspection.slices.find(candidate => candidate.id === input.slice_id);
      if (!slice) throw new MachOError('not_found', 'Selected slice does not belong to this container');
      if (!slice.supported) throw new MachOError('unsupported_target', `Selected slice is unsupported: ${slice.architecture} ${slice.subtype}`);
    } else {
      if (supported.length > 1) {
        const error = new MachOError('ambiguous_slice', 'More than one supported ARM64 slice; select an explicit slice ID');
        throw Object.assign(error, { diagnostic: { ...error.diagnostic, details: { kind: 'slice_selection', slices: inspection.slices.map(({ id, architecture, subtype, supported: available }) => ({ id, architecture, subtype, supported: available })) } } });
      }
      slice = supported[0];
      if (!slice) throw new MachOError('unsupported_target', 'No supported little-endian ARM64 executable/dylib slice');
    }
    const s = new State(new Reader(input.bytes, slice.offset, safe(slice.size), context), slice);
    const image = parseImage(s, input, inspection.slices);
    // Nonselected architectures are container facts, not lost metadata in this
    // slice. Add their diagnostics only after selected-slice capabilities form.
    for (const diagnostic of inspection.diagnostics) {
      if (s.diagnostics.length >= 1000) break;
      s.diagnostics.push(diagnostic);
    }
    return image;
  }
}

function parseImage(s: State, input: Parameters<Loader['load']>[0], slices: readonly ImageSlice[]): LoadedImage {
  const r = s.r, count = r.u32(16), commandSize = r.u32(20), commandEnd = 32 + commandSize;
  r.range(32, commandSize);
  if (count > Math.floor(commandSize / 8)) malformed('Load-command count exceeds table');
  if (count > 65_536) throw new MachOError('resource_limit', 'Load-command count exceeds 65,536');
  const fields: MetadataField[] = ['magic', 'cputype', 'cpusubtype', 'filetype', 'ncmds', 'sizeofcmds', 'flags', 'reserved'].map((name, index) => ({ kind: 'integer', name, value: BigInt(r.u32(index * 4)) }));
  s.header('mach_header', 'mach_header_64', 0, 32, fields);
  let p = 32, symtab: SymbolTable | undefined, indirect: IndirectTable | undefined, starts: Payload | undefined, data: Payload | undefined, exports: Payload | undefined, legacyExports: Payload | undefined, chained: Payload | undefined, entryOffset: bigint | undefined, threadEntry: bigint | undefined;
  const streams = new Map<string, Payload>(), seen = new Set<number>();
  for (let i = 0; i < count; i++) {
    r.context.checkpoint(1); r.range(p, 8, commandEnd);
    const cmd = r.u32(p), size = r.u32(p + 4), name = COMMAND_NAMES[cmd] ?? `LC_UNKNOWN_0x${cmd.toString(16)}`;
    if (size < 8 || size % 8) malformed(`Invalid ${name} size ${size}`);
    r.range(p, size, commandEnd);
    const need = (minimum: number) => { if (size < minimum) malformed(`Truncated ${name}`); };
    if ([2, 11, 34, 38, 41, 0x80000022, 0x80000028, 0x80000033, 0x80000034].includes(cmd) && seen.has(cmd)) malformed(`Duplicate ${name}`);
    seen.add(cmd);
    const values: MetadataField[] = [{ kind: 'integer', name: 'cmd', value: BigInt(cmd) }, { kind: 'integer', name: 'cmdsize', value: BigInt(size) }];
    // Preserve structured raw fields for every command, including unknown versions.
    if (size <= 3800) for (let offset = 8; offset < size; offset += 4) { r.context.checkpoint(1); values.push({ kind: 'integer', name: `word_${offset}`, value: BigInt(r.u32(p + offset)) }); }
    else values.push({ kind: 'bytes', name: 'payload', range: s.file(p + 8, size - 8) });
    const evidence = s.header('load_command', name, p, size, values);
    if (cmd === 25) {
      need(72); const segmentName = r.fixed(p + 8, 16), va = r.u64(p + 24), memorySize = r.u64(p + 32), offset = safe(r.u64(p + 40)), fileSize = safe(r.u64(p + 48)), protection = r.u32(p + 60), sectionCount = r.u32(p + 64), segmentFlags = r.u32(p + 68);
      values.push({ kind: 'text', name: 'segname', value: segmentName }, { kind: 'integer', name: 'vmaddr', value: va }, { kind: 'integer', name: 'vmsize', value: memorySize }, { kind: 'integer', name: 'fileoff', value: BigInt(offset) }, { kind: 'integer', name: 'filesize', value: BigInt(fileSize) }, { kind: 'integer', name: 'initprot', value: BigInt(protection) });
      vmEnd(va, memorySize); r.range(offset, fileSize);
      if (BigInt(fileSize) > memorySize || size !== 72 + sectionCount * 80) malformed('Segment size or section count is invalid');
      if (segmentFlags & 1) throw new MachOError('unsupported_target', 'SG_HIGHVM segment mapping is unsupported');
      const permissions: ImageMapping['permissions'] = (['read', 'write', 'execute'] as const).filter((_, index) => protection & 1 << index);
      const id = s.id('segment', s.segments.length);
      s.segments.push({ id, name: segmentName, va, size: memorySize, offset, fileSize, protection });
      s.sections.push({ id, name: segmentName, segment_id: null, kind: 'segment', virtual_range: { start: s.va(va), size: memorySize }, file_range: fileSize ? s.file(offset, fileSize) : null, permissions, flags: BigInt(segmentFlags), evidence_ids: evidence });
      const zeroRanges: { start: bigint; end: bigint }[] = [];
      for (let j = 0; j < sectionCount; j++) {
        r.context.checkpoint(1); const q = p + 72 + j * 80, sectionName = r.fixed(q, 16), sectionVa = r.u64(q + 32), sectionSize = r.u64(q + 40), sectionOffset = r.u32(q + 48), flags = r.u32(q + 64), type = flags & 255;
        const end = vmEnd(sectionVa, sectionSize), zero = type === 1 || type === 0xc || type === 0x12;
        if (r.fixed(q + 16, 16) !== segmentName || sectionVa < va || end > va + memorySize) malformed('Section outside its declared segment');
        if (zero) { if (sectionSize) zeroRanges.push({ start: sectionVa, end }); }
        else if (sectionSize) {
          r.range(sectionOffset, safe(sectionSize));
          if (sectionOffset < offset || BigInt(sectionOffset) + sectionSize > BigInt(offset + fileSize) || sectionVa - va !== BigInt(sectionOffset - offset)) malformed('Section file and virtual mappings disagree');
        }
        const relocOffset = r.u32(q + 56), relocCount = r.u32(q + 60); r.range(relocOffset, relocCount * 8);
        const sectionId = s.id('section', s.rawSections.length), sectionProof = s.proof(q, 80, `section_64 ${segmentName},${sectionName}`);
        if (flags & 0x80000400 && !zero && (sectionVa % 4n || sectionSize % 4n || sectionOffset % 4)) malformed('ARM64 instruction section is not four-byte aligned');
        s.rawSections.push({ id: sectionId, name: sectionName, va: sectionVa, size: sectionSize, offset: sectionOffset, flags, first: r.u32(q + 68), stride: r.u32(q + 72), relocOffset, relocCount, evidence: sectionProof });
        s.sections.push({ id: sectionId, name: sectionName, segment_id: id, kind: 'section', virtual_range: { start: s.va(sectionVa), size: sectionSize }, file_range: zero ? null : s.file(sectionOffset, safe(sectionSize)), permissions, flags: BigInt(flags), evidence_ids: sectionProof });
        // Executable segment permissions also cover constants and runtime metadata.
        // Section instruction attributes (or a stub section type) establish code;
        // the remaining declared sections are data, even inside __TEXT.
        if (sectionSize && !(flags & 0x80000400) && type !== 8) s.hints.push({ kind: 'data', range: { start: s.va(sectionVa), size: sectionSize }, encoding: 'bytes', evidence_ids: sectionProof });
      }
      // Segment mappings are split only where a declared zero-fill section overrides file backing.
      // Sections remain metadata, never a second overlapping set of maps.
      zeroRanges.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
      const boundaries = [va, ...zeroRanges.flatMap(range => [range.start, range.end]), va + memorySize];
      for (let j = 0; j + 1 < boundaries.length; j++) {
        const start = boundaries[j]!, end = boundaries[j + 1]!; if (end < start) malformed('Overlapping zero-fill sections'); if (end === start) continue;
        const delta = start - va, zero = j % 2 === 1, backing = !zero && delta < BigInt(fileSize) ? (end - start < BigInt(fileSize) - delta ? end - start : BigInt(fileSize) - delta) : 0n;
        s.mappings.push({ id: s.id('mapping', `${id}:${j}`), va: start, memory_size: end - start, file_offset: s.slice.offset + BigInt(offset) + (backing ? delta : 0n), file_size: backing, permissions });
      }
    } else if (LINKEDIT[cmd]) {
      need(16); const payload = { offset: r.u32(p + 8), size: r.u32(p + 12) }; r.range(payload.offset, payload.size);
      if (cmd === 38) starts = payload;
      else if (cmd === 41) data = payload;
      else if (cmd === 0x80000033) exports = payload;
      else if (cmd === 0x80000034) chained = payload;
    } else if (cmd === 2) {
      need(24); symtab = { offset: r.u32(p + 8), count: r.u32(p + 12), strings: r.u32(p + 16), stringSize: r.u32(p + 20) };
      r.range(symtab.offset, symtab.count * 16); r.range(symtab.strings, symtab.stringSize);
      if (symtab.count > 100_000) throw new MachOError('resource_limit', 'Symbol count exceeds 100,000');
    } else if (cmd === 11) {
      need(80); indirect = { offset: r.u32(p + 56), count: r.u32(p + 60) }; r.range(indirect.offset, indirect.count * 4);
      for (const [field, width] of [[32, 8], [40, 56], [48, 4], [64, 8], [72, 8]] as const) r.range(r.u32(p + field), r.u32(p + field + 4) * width);
      for (const field of [64, 72]) s.relocationTables.push({ offset: r.u32(p + field), count: r.u32(p + field + 4) });
    } else if (cmd === 34 || cmd === 0x80000022) {
      need(48);
      if (seen.has(cmd === 34 ? 0x80000022 : 34)) malformed('Duplicate dyld info mechanisms');
      for (const [index, kind] of ['rebase', 'bind', 'weak bind', 'lazy bind', 'exports'].entries()) {
        const payload = { offset: r.u32(p + 8 + index * 8), size: r.u32(p + 12 + index * 8) }; r.range(payload.offset, payload.size);
        if (kind === 'exports') legacyExports = payload; else if (payload.size) streams.set(kind, payload);
      }
    } else if (cmd === 0x80000028) {
      need(24); entryOffset = r.u64(p + 8); r.range(safe(entryOffset), 1);
    } else if (cmd === 5) {
      let q = p + 8;
      while (q < p + size) {
        r.context.checkpoint(1); r.range(q, 8, p + size); const flavor = r.u32(q), words = r.u32(q + 4); r.range(q + 8, words * 4, p + size);
        if (flavor === 6 && words === 68) threadEntry = r.u64(q + 8 + 256); else s.warn(`Unsupported ARM thread state flavor ${flavor}`, 'unsupported_target', evidence);
        q += 8 + words * 4;
      }
    } else if (DYLIB[cmd] || [14, 15, 0x8000001c].includes(cmd)) {
      const minimum = DYLIB[cmd] ? 24 : 12; need(minimum); const stringOffset = r.u32(p + 8);
      if (stringOffset < minimum || stringOffset >= size) malformed('Invalid load-command string offset');
      const text = r.string(p + stringOffset, p + size).text;
      values.push({ kind: 'text', name: 'name', value: text });
      if (DYLIB[cmd] && cmd !== 13) s.libraries.push(text);
    } else if (cmd === 33 || cmd === 44) {
      need(cmd === 44 ? 24 : 20); const offset = r.u32(p + 8), length = r.u32(p + 12); r.range(offset, length);
      if (r.u32(p + 16) && length) { s.encrypted.push({ offset, size: length }); s.warn('Encrypted bytes are excluded from code/function metadata', 'unsupported_target', evidence); }
    } else if (cmd === 27) { need(24); values.push({ kind: 'bytes', name: 'uuid', range: s.file(p + 8, 16) }); }
    else if (cmd === 50) { need(24); r.range(p + 24, r.u32(p + 20) * 8, p + size); if (r.u32(p + 8) !== 1) s.warn(`Non-macOS Mach-O platform ${r.u32(p + 8)}`, 'unsupported_target', evidence); }
    else if ([36, 37, 47, 48, 42].includes(cmd)) need(16);
    else if (!COMMAND_NAMES[cmd]) s.warn(`Unknown load command 0x${cmd.toString(16)} retained as raw fields${cmd & 0x80000000 ? '; required dyld feature unavailable' : ''}`, 'unsupported_target', evidence);
    else s.warn(`Unsupported load command ${name} retained as raw fields`, 'unsupported_target', evidence);
    p += size;
  }
  if (p !== commandEnd) malformed('Load commands do not fill sizeofcmds');
  const bases = s.segments.filter(segment => segment.offset === 0 && segment.fileSize >= commandEnd);
  if (bases.length !== 1) malformed('Image has no unambiguous header-bearing segment');
  s.imageBase = bases[0]!.va;
  // Check overlapping section claims independently of segment mappings.
  const sectionOrder = s.rawSections.filter(section => section.size).sort((a, b) => a.va < b.va ? -1 : a.va > b.va ? 1 : 0);
  for (let i = 1; i < sectionOrder.length; i++) if (sectionOrder[i]!.va < sectionOrder[i - 1]!.va + sectionOrder[i - 1]!.size) malformed('Overlapping Mach-O sections');
  let addressMap: AddressMap;
  try { addressMap = new AddressMap({ image_id: s.slice.image_id, image_base: s.imageBase, byte_length: BigInt(input.bytes.length), slice_offset: s.slice.offset, slice_size: s.slice.size, mappings: s.mappings }); }
  catch (error) { return malformed(`Invalid segment mappings: ${error instanceof Error ? error.message : String(error)}`); }
  let entry = threadEntry;
  if (entryOffset !== undefined) {
    const result = addressMap.translate(s.file(safe(entryOffset), 1).start, 'va');
    if (result.kind !== 'mapped') malformed('Entry offset is not mapped');
    entry = result.address.value;
  }
  if (entry !== undefined) {
    const entryVa = entry, entryMap = addressMap.translate(s.va(entryVa), 'file');
    if (entryMap.kind !== 'mapped' || !s.mappings.some(mapping => mapping.permissions.includes('execute') && entryVa >= mapping.va && entryVa < mapping.va + mapping.file_size)) malformed('Entry point is not executable file-backed memory');
    s.entries.push(s.va(entry));
  }
  for (const encrypted of s.encrypted) {
    const translated = addressMap.translate(s.file(encrypted.offset, encrypted.size).start, 'va');
    if (translated.kind === 'mapped') s.hints.push({ kind: 'data', range: { start: translated.address, size: BigInt(encrypted.size) }, encoding: 'unknown', evidence_ids: s.proof(encrypted.offset, encrypted.size, 'Encrypted bytes: not decodable code') });
  }
  s.optional('Symbols/indirect imports', () => readSymbols(s, symtab, indirect));
  const exportPayload = exports?.size ? exports : legacyExports;
  if (exportPayload) s.optional('Exports', () => readExports(s, exportPayload));
  readDyld(s, streams, chained);
  readHints(s, addressMap, starts, data);
  readRelocations(s);
  // Avoid two entries for exactly the same export fact while retaining independent proof.
  const uniqueExports = new Map<string, LoadedImage['exports'][number]>();
  for (const record of s.exports) {
    const key = `${record.original_name}:${record.address?.value}:${record.forwarder?.library}:${record.forwarder?.symbol}`, previous = uniqueExports.get(key);
    uniqueExports.set(key, previous ? { ...previous, evidence_ids: [...previous.evidence_ids, ...record.evidence_ids] } : record);
  }
  const capabilities: LoadedImage['capabilities'] = [{ layer: 'format', feature: 'Mach-O ARM64 thin/fat static metadata', status: s.diagnostics.length ? 'partial' : 'supported', limitations: s.diagnostics.map(diagnostic => diagnostic.message) }];
  return { id: input.image_id, sha256: input.sha256, bytes: input.bytes, selected_slice_id: s.slice.id, slices, target: { format: 'macho', architecture: 'arm64', abi: 'darwin-arm64', endian: 'little', address_bits: 64, features: (r.u32(8) & 0xffffff) === 2 ? ['FEAT_FP', 'FEAT_AdvSIMD', 'FEAT_PAuth'] : ['FEAT_FP', 'FEAT_AdvSIMD'] }, image_base: s.imageBase, address_map: addressMap, mappings: s.mappings, headers: s.headers, sections: s.sections, entry_points: s.entries, symbols: s.symbols, imports: s.imports, exports: [...uniqueExports.values()], relocations: s.relocations, hints: s.hints, evidence: s.evidence, diagnostics: s.diagnostics, capabilities };
}

function readRelocations(s: State): void {
  const r = s.r, symbolIds = new Set(s.symbols.map(symbol => symbol.id));
  const writable = s.segments.find(segment => segment.protection & 2);
  const tables = [
    ...s.rawSections.map(section => ({ offset: section.relocOffset, count: section.relocCount, base: section.va, size: section.size, name: section.name })),
    ...s.relocationTables.map(table => ({ ...table, base: r.u32(24) & 0x20 ? writable?.va ?? s.imageBase : s.imageBase, size: 0xffffffffffffffffn, name: 'LC_DYSYMTAB' })),
  ];
  for (const table of tables) s.optional(`Relocations ${table.name}`, () => {
    for (let i = 0; i < table.count; i++) {
      r.context.checkpoint(1); const p = table.offset + i * 8; s.readable(p, 8);
      const offsetWord = r.u32(p), word = r.u32(p + 4);
      if (offsetWord & 0x80000000) { s.warn('Scattered relocation unsupported for ARM64', 'unsupported_target', s.proof(p, 8, 'Scattered relocation')); continue; }
      const type = word >>> 28, external = !!(word & 0x08000000), width = 8 << (word >>> 25 & 3), symbolIndex = word & 0xffffff;
      if (BigInt(offsetWord) + BigInt(width / 8) > table.size) malformed('Relocation outside section');
      const location = vmEnd(table.base, BigInt(offsetWord));
      if (!s.mappings.some(mapping => location >= mapping.va && location + BigInt(width / 8) <= mapping.va + mapping.memory_size)) malformed('Relocation location outside mapped memory');
      const symbolId = external && type !== 10 ? s.id('symbol', symbolIndex) : null;
      let target: LoadedImage['relocations'][number]['target'] = null;
      let addend = 0n;
      if (type === 10) addend = BigInt.asIntN(24, BigInt(symbolIndex));
      else if (!external && symbolIndex) { const targetSection = s.rawSections[symbolIndex - 1]; if (!targetSection) malformed('Relocation section ordinal outside table'); target = s.va(targetSection.va); }
      else if (external && !symbolIds.has(symbolId!)) malformed('Relocation symbol ordinal outside table');
      s.relocations.push({ id: s.id('relocation', p), address: s.va(location), kind: 'relocation', encoding: `ARM64_RELOC_${type}${word & 0x1000000 ? '_PCREL' : ''}`, width_bits: width, target, symbol_id: symbolId, addend, authenticated: type === 11, evidence_ids: s.proof(p, 8, 'Mach-O relocation_info') });
      if (type > 11) s.warn(`Unknown ARM64 relocation type ${type}`, 'unsupported_target');
    }
  });
}

export const machoLoader: Loader = new MachOLoader();
