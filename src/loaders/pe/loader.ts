// SPDX-License-Identifier: MIT
import {
  AddressMap, OperationError, checkedEnd, checkedU64, entityIdentity, fingerprint, sliceIdentity,
  type Address, type AddressRange, type Diagnostic, type Evidence, type ExportRecord,
  type HeaderRecord, type ImageMapping, type ImageSlice, type ImmutableBytes,
  type ImportRecord, type LoadedImage, type Loader, type LoaderHint, type MetadataField,
  type OperationContext, type Relocation, type Section, type SymbolRecord,
} from '../../core/index.js';

/** Static inspection only. Semantics: Microsoft PE/COFF and x64 exception specifications.
 * https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
 * https://learn.microsoft.com/en-us/cpp/build/exception-handling-x64
 * No dependencies, DLLs, PDBs, or referenced paths are opened by this loader.
 */
export class PELoadError extends OperationError {
  constructor(code: Diagnostic['code'], message: string, address?: Address) {
    super({ code, severity: 'error', message, evidence_ids: [], ...(address ? { address } : {}) });
    this.name = 'PELoadError';
  }
}
const DIRECTORY_NAMES = ['export', 'import', 'resource', 'exception', 'certificate', 'base_relocation', 'debug', 'architecture', 'global_pointer', 'tls', 'load_config', 'bound_import', 'iat', 'delay_import', 'clr', 'reserved'] as const;
const MAX_RECORDS = 100_000;
const MAX_STRING = 4096;
interface Directory { readonly index: number; readonly rva: bigint; readonly size: bigint; readonly field: bigint }
interface BasicHeader {
  readonly pe: bigint; readonly coff: bigint; readonly optional: bigint; readonly optionalSize: number;
  readonly machine: number; readonly count: number; readonly characteristics: number; readonly magic: number;
}
const integer = (name: string, value: bigint | number): MetadataField => ({ kind: 'integer', name, value: BigInt(value) });

class Reader {
  constructor(readonly bytes: ImmutableBytes, readonly image: string, readonly context: OperationContext) {}
  address(space: Address['space'], value: bigint): Address { return { image_id: this.image, space, value: checkedU64(value) }; }
  fail(message: string, offset?: bigint): never { throw new PELoadError('malformed_image', message, offset === undefined ? undefined : this.address('file', offset)); }
  work(units = 1): void {
    if (this.context.signal.aborted) throw new PELoadError('cancelled', 'PE inspection cancelled');
    this.context.checkpoint(units);
  }
  bounds(offset: bigint, size: bigint): void {
    if (offset < 0n || size < 0n || offset + size > BigInt(this.bytes.length)) this.fail('PE file range exceeds container', offset < 0n ? undefined : offset);
  }
  u8(offset: bigint): number { this.work(); this.bounds(offset, 1n); return this.bytes.at(Number(offset)); }
  u16(offset: bigint): number { this.bounds(offset, 2n); return this.u8(offset) + 256 * this.u8(offset + 1n); }
  u32(offset: bigint): number { this.work(); this.bounds(offset, 4n); return this.bytes.u32(offset); }
  u64(offset: bigint): bigint { this.work(); this.bounds(offset, 8n); return this.bytes.u64(offset); }
  fixed(offset: bigint, size: number): string {
    this.bounds(offset, BigInt(size));
    let text = '';
    for (let i = 0; i < size; i++) { const c = this.u8(offset + BigInt(i)); if (!c) break; text += String.fromCharCode(c); }
    return text;
  }
  string(offset: bigint, end = BigInt(this.bytes.length)): string {
    let text = '';
    for (let i = 0; i <= MAX_STRING; i++) {
      if (offset + BigInt(i) >= end) this.fail('Unterminated PE string', offset);
      const c = this.u8(offset + BigInt(i));
      if (!c) return text;
      if (i === MAX_STRING) throw new PELoadError('resource_limit', 'PE string exceeds 4096 bytes', this.address('file', offset));
      if (c > 127) this.fail('PE ASCII name contains non-ASCII bytes', offset);
      text += String.fromCharCode(c);
    }
    return text;
  }
  count(count: number, stride: number, offset: bigint): void {
    this.bounds(offset, BigInt(count) * BigInt(stride));
    if (count > MAX_RECORDS) throw new PELoadError('resource_limit', 'PE table exceeds 100000 records', this.address('file', offset));
  }
  basic(): BasicHeader {
    this.bounds(0n, 64n);
    if (this.u16(0n) !== 0x5a4d) this.fail('Missing DOS MZ signature', 0n);
    const pe = BigInt(this.u32(0x3cn));
    if (pe < 64n) this.fail('PE header overlaps DOS header', pe);
    this.bounds(pe, 24n);
    if (this.u32(pe) !== 0x4550) this.fail('Missing PE signature', pe);
    const coff = pe + 4n;
    const optional = coff + 20n;
    const optionalSize = this.u16(coff + 16n);
    this.bounds(optional, BigInt(optionalSize));
    if (optionalSize < 2) this.fail('Missing optional header', optional);
    return { pe, coff, optional, optionalSize, machine: this.u16(coff), count: this.u16(coff + 2n), characteristics: this.u16(coff + 18n), magic: this.u16(optional) };
  }
}

class Parser extends Reader {
  readonly headers: HeaderRecord[] = [];
  readonly sections: Section[] = [];
  readonly mappings: ImageMapping[] = [];
  readonly imports: ImportRecord[] = [];
  readonly exports: ExportRecord[] = [];
  readonly symbols: SymbolRecord[] = [];
  readonly relocations: Relocation[] = [];
  readonly hints: LoaderHint[] = [];
  readonly evidence: Evidence[] = [];
  readonly diagnostics: Diagnostic[] = [];
  readonly directories: Directory[] = [];
  readonly capabilities: LoadedImage['capabilities'][number][] = [];
  readonly entries: Address[] = [];
  readonly unsupportedFeatures = new Set<string>();
  base = 0n;
  imageSize = 0n;
  map!: AddressMap;
  constructor(bytes: ImmutableBytes, image: string, context: OperationContext, readonly slice: ImageSlice) { super(bytes, image, context); }
  id(kind: string, offset: bigint | number): string { return entityIdentity(this.slice.id, `pe:${kind}`, BigInt(offset)); }
  range(space: Address['space'], offset: bigint, size: bigint): AddressRange { checkedEnd(offset, size); return { start: this.address(space, offset), size }; }
  fact(offset: bigint, size: bigint, claim: string): string[] {
    const id = `evidence_${fingerprint([this.slice.id, offset, size, claim])}`;
    this.evidence.push({ id, origin: { kind: 'binary', range: this.range('file', offset, size), description: claim }, claim, derived_from: [], conflicts_with: [], revision: 0 });
    return [id];
  }
  header(kind: HeaderRecord['kind'], name: string, offset: bigint, size: bigint, fields: readonly MetadataField[]): void {
    this.headers.push({ kind, name, range: this.range('file', offset, size), fields, evidence_ids: this.fact(offset, size, name) });
  }
  unsupported(feature: string, message: string, offset?: bigint): void {
    if (this.unsupportedFeatures.has(feature)) return;
    if (this.capabilities.length >= 1000) throw new PELoadError('resource_limit', 'PE capability count exceeds 1000');
    this.unsupportedFeatures.add(feature);
    this.capabilities.push({ layer: 'format', feature, status: 'unsupported', limitations: [message] });
    this.diagnostics.push({ code: 'unsupported_target', severity: 'warning', message, evidence_ids: [], ...(offset === undefined ? {} : { address: this.address('file', offset) }) });
  }
  /** Metadata reads must be backed by one contiguous mapping, never by virtual zero-fill. */
  file(rva: bigint, size: bigint): bigint {
    if (rva < 0n || rva + size > this.imageSize) this.fail('PE RVA range exceeds SizeOfImage');
    const va = this.base + rva;
    const mapping = this.mappings.find(m => va >= m.va && va < m.va + m.file_size && va + size <= m.va + m.file_size);
    if (!mapping) this.fail(`PE metadata RVA 0x${rva.toString(16)} is unmapped, zero-filled, or crosses backing bounds`);
    return mapping.file_offset + va - mapping.va;
  }
  memory(rva: bigint, size: bigint, executable = false): Address {
    if (size <= 0n || rva + size > this.imageSize) this.fail('Invalid PE memory range');
    const va = this.base + rva;
    if (!this.mappings.some(m => va >= m.va && va + size <= m.va + m.memory_size && (!executable || m.permissions.includes('execute')))) this.fail('PE reference is outside a suitable mapped region');
    return this.address('va', va);
  }
  rvaString(rva: bigint, endRva?: bigint): string {
    const file = this.file(rva, 1n);
    const mapping = this.mappings.find(m => file >= m.file_offset && file < m.file_offset + m.file_size)!;
    let end = mapping.file_offset + mapping.file_size;
    if (endRva !== undefined && file + endRva - rva < end) end = file + endRva - rva;
    return this.string(file, end);
  }
  vaRva(value: bigint): bigint {
    if (value < this.base || value - this.base >= this.imageSize) this.fail('PE VA reference is outside image');
    return value - this.base;
  }
  directory(index: number): Directory | undefined { return this.directories.find(d => d.index === index && d.size !== 0n); }
  parseHeaders(h: BasicHeader): void {
    if (h.machine !== 0x8664 || h.magic !== 0x20b) throw new PELoadError('unsupported_target', 'Only AMD64 PE32+ images are supported');
    if (!(h.characteristics & 2) || (h.characteristics & 0x1000)) throw new PELoadError('unsupported_target', 'Only native user-mode PE EXE/DLL images are supported');
    if (h.optionalSize < 112) this.fail('Truncated PE32+ optional header', h.optional);
    if (h.count === 0 || h.count > 96) this.fail('PE section count must be between 1 and 96', h.coff + 2n);
    this.base = this.u64(h.optional + 24n);
    this.imageSize = BigInt(this.u32(h.optional + 56n));
    try { checkedEnd(this.base, this.imageSize); } catch { this.fail('PE preferred image range overflows uint64'); }
    const headerSize = BigInt(this.u32(h.optional + 60n));
    const sectionAlignment = this.u32(h.optional + 32n), fileAlignment = this.u32(h.optional + 36n);
    const powerOfTwo = (n: number): boolean => n > 0 && Number.isInteger(Math.log2(n));
    if (!powerOfTwo(sectionAlignment) || !powerOfTwo(fileAlignment) || sectionAlignment < fileAlignment ||
      (sectionAlignment < 4096 ? sectionAlignment !== fileAlignment : fileAlignment < 512 || fileAlignment > 65536) ||
      this.base % 65536n !== 0n || this.imageSize === 0n || this.imageSize % BigInt(sectionAlignment) !== 0n || headerSize % BigInt(fileAlignment) !== 0n) this.fail('Invalid PE image alignment/size');
    const sectionTable = h.optional + BigInt(h.optionalSize);
    this.count(h.count, 40, sectionTable);
    if (headerSize < sectionTable + BigInt(h.count * 40) || headerSize > this.imageSize) this.fail('SizeOfHeaders does not contain section headers');
    this.bounds(0n, headerSize);
    this.mappings.push({ id: this.id('headers', 0), va: this.base, memory_size: headerSize, file_offset: 0n, file_size: headerSize, permissions: ['read'] });
    const dosFields: MetadataField[] = [];
    for (const [index, name] of ['e_magic', 'e_cblp', 'e_cp', 'e_crlc', 'e_cparhdr', 'e_minalloc', 'e_maxalloc', 'e_ss', 'e_sp', 'e_csum', 'e_ip', 'e_cs', 'e_lfarlc', 'e_ovno'].entries()) dosFields.push(integer(name, this.u16(BigInt(index * 2))));
    dosFields.push({ kind: 'bytes', name: 'e_res', range: this.range('file', 28n, 8n) }, integer('e_oemid', this.u16(36n)), integer('e_oeminfo', this.u16(38n)), { kind: 'bytes', name: 'e_res2', range: this.range('file', 40n, 20n) }, { kind: 'address', name: 'e_lfanew', value: this.address('file', h.pe) });
    this.header('dos_header', 'IMAGE_DOS_HEADER', 0n, 64n, dosFields);
    this.header('coff_header', 'IMAGE_FILE_HEADER', h.coff, 20n, [integer('Machine', h.machine), integer('NumberOfSections', h.count), integer('TimeDateStamp', this.u32(h.coff + 4n)), integer('PointerToSymbolTable', this.u32(h.coff + 8n)), integer('NumberOfSymbols', this.u32(h.coff + 12n)), integer('SizeOfOptionalHeader', h.optionalSize), integer('Characteristics', h.characteristics)]);
    const fields: MetadataField[] = [];
    for (const [name, offset, size] of [
      ['Magic', 0, 2], ['MajorLinkerVersion', 2, 1], ['MinorLinkerVersion', 3, 1], ['SizeOfCode', 4, 4], ['SizeOfInitializedData', 8, 4], ['SizeOfUninitializedData', 12, 4], ['AddressOfEntryPoint', 16, 4], ['BaseOfCode', 20, 4], ['ImageBase', 24, 8], ['SectionAlignment', 32, 4], ['FileAlignment', 36, 4], ['MajorOperatingSystemVersion', 40, 2], ['MinorOperatingSystemVersion', 42, 2], ['MajorImageVersion', 44, 2], ['MinorImageVersion', 46, 2], ['MajorSubsystemVersion', 48, 2], ['MinorSubsystemVersion', 50, 2], ['Win32VersionValue', 52, 4], ['SizeOfImage', 56, 4], ['SizeOfHeaders', 60, 4], ['CheckSum', 64, 4], ['Subsystem', 68, 2], ['DllCharacteristics', 70, 2], ['SizeOfStackReserve', 72, 8], ['SizeOfStackCommit', 80, 8], ['SizeOfHeapReserve', 88, 8], ['SizeOfHeapCommit', 96, 8], ['LoaderFlags', 104, 4], ['NumberOfRvaAndSizes', 108, 4],
    ] as const) {
      const p = h.optional + BigInt(offset);
      fields.push(integer(name, size === 8 ? this.u64(p) : size === 4 ? this.u32(p) : size === 2 ? this.u16(p) : this.u8(p)));
    }
    this.header('optional_header', h.characteristics & 0x2000 ? 'PE32+ DLL' : 'PE32+ EXE', h.optional, BigInt(h.optionalSize), fields);
    const subsystem = this.u16(h.optional + 68n);
    if (subsystem !== 2 && subsystem !== 3) throw new PELoadError('unsupported_target', `Unsupported PE subsystem ${subsystem}; only Windows GUI/CUI native images are supported`);
    for (let i = 0; i < h.count; i++) {
      const p = sectionTable + BigInt(i * 40);
      const name = this.fixed(p, 8);
      const virtualSize = BigInt(this.u32(p + 8n)), rva = BigInt(this.u32(p + 12n));
      const rawSize = BigInt(this.u32(p + 16n)), raw = BigInt(this.u32(p + 20n)), flags = this.u32(p + 36n);
      // Raw alignment padding is backed; VirtualSize beyond raw size is zero-fill.
      const memorySize = virtualSize > rawSize ? virtualSize : rawSize;
      if (rva % BigInt(sectionAlignment) || (rawSize && (raw % BigInt(fileAlignment) || rawSize % BigInt(fileAlignment))) || rva + memorySize > this.imageSize) this.fail('Invalid PE section range/alignment', p);
      this.bounds(raw, rawSize);
      const permissions: ('read' | 'write' | 'execute')[] = [];
      if (flags & 0x40000000) permissions.push('read');
      if (flags & 0x80000000) permissions.push('write');
      if (flags & 0x20000000) permissions.push('execute');
      const id = this.id('section', i);
      this.mappings.push({ id, va: this.base + rva, memory_size: memorySize, file_offset: raw, file_size: rawSize, permissions });
      const evidence_ids = this.fact(p, 40n, `Section ${name}`);
      this.sections.push({ id, name, segment_id: null, kind: 'section', virtual_range: this.range('va', this.base + rva, memorySize), file_range: rawSize ? this.range('file', raw, rawSize) : null, flags: BigInt(flags), permissions, evidence_ids });
      this.header('optional_header', `Section header ${name}`, p, 40n, [integer('VirtualSize', virtualSize), integer('VirtualAddress', rva), integer('SizeOfRawData', rawSize), integer('PointerToRawData', raw), integer('PointerToRelocations', this.u32(p + 24n)), integer('PointerToLinenumbers', this.u32(p + 28n)), integer('NumberOfRelocations', this.u16(p + 32n)), integer('NumberOfLinenumbers', this.u16(p + 34n)), integer('Characteristics', flags)]);
    }
    try { this.map = new AddressMap({ image_id: this.image, image_base: this.base, byte_length: BigInt(this.bytes.length), slice_offset: 0n, slice_size: BigInt(this.bytes.length), mappings: this.mappings }); }
    catch (error) { this.fail(`Invalid PE mapping: ${error instanceof Error ? error.message : String(error)}`); }
    const count = this.u32(h.optional + 108n);
    if (count > Math.floor((h.optionalSize - 112) / 8)) this.fail('NumberOfRvaAndSizes exceeds optional header', h.optional + 108n);
    for (let i = 0; i < count; i++) {
      const field = h.optional + 112n + BigInt(i * 8), rva = BigInt(this.u32(field)), size = BigInt(this.u32(field + 4n));
      if (!rva && size) this.fail('Nonempty PE data directory has a null address', field);
      if (rva && !size && i !== 8) this.fail('PE data directory address has no size', field);
      this.directories.push({ index: i, rva, size, field });
      this.header('data_directory', DIRECTORY_NAMES[i] ?? `unknown_${i}`, field, 8n, [{ kind: 'address', name: i === 4 ? 'FileOffset' : 'RVA', value: this.address(i === 4 ? 'file' : 'rva', rva) }, integer('Size', size)]);
      if (size) {
        if (i === 4) this.bounds(rva, size); else this.file(rva, size);
        this.hints.push({ kind: 'data', range: this.range(i === 4 ? 'file' : 'va', i === 4 ? rva : this.base + rva, size), encoding: 'bytes', evidence_ids: this.fact(field, 8n, `PE ${DIRECTORY_NAMES[i] ?? i} directory body`) });
        if (![0, 1, 3, 5, 6, 9, 12, 13, 14].includes(i)) this.unsupported(`directory:${DIRECTORY_NAMES[i] ?? i}`, `Directory ${DIRECTORY_NAMES[i] ?? i} retained as a raw reference; its body is not interpreted`, field);
      }
    }
    if (this.directory(14)) throw new PELoadError('unsupported_target', 'Managed CLR image: native body analysis is not supported');
    const entry = BigInt(this.u32(h.optional + 16n));
    if (entry) { const address = this.memory(entry, 1n, true); this.file(entry, 1n); this.entries.push(address); this.hints.push({ kind: 'function', address, size: null, evidence_ids: this.fact(h.optional + 16n, 4n, 'Native PE entry point') }); }
    this.capabilities.push({ layer: 'format', feature: 'pe32+ x86_64 native EXE/DLL', status: 'supported', limitations: ['Static mappings use preferred ImageBase; no runtime slide is applied. Packed or self-modifying bodies cannot be identified reliably from headers alone.'] });
  }

  table(rva: bigint, count: number, stride: number): bigint {
    if (count > MAX_RECORDS) throw new PELoadError('resource_limit', 'PE table exceeds 100000 records');
    if (!count) return 0n;
    if (!rva) this.fail('Nonempty PE table has a null RVA');
    const p = this.file(rva, BigInt(count) * BigInt(stride));
    this.count(count, stride, p);
    return p;
  }
  parseImports(delayed: boolean): void {
    const d = this.directory(delayed ? 13 : 1);
    if (!d) return;
    const stride = delayed ? 32 : 20, start = this.file(d.rva, d.size);
    const count = Number(d.size / BigInt(stride));
    this.count(count, stride, start);
    let terminated = false;
    for (let i = 0; i < count; i++) {
      const p = start + BigInt(i * stride);
      const values: number[] = [];
      for (let n = 0; n < stride; n += 4) values.push(this.u32(p + BigInt(n)));
      if (values.every(v => v === 0)) { terminated = true; break; }
      const rvaMode = !delayed || (values[0]! & 1) !== 0;
      if (delayed && values[0]! > 1) throw new PELoadError('unsupported_target', 'Unknown delay-import descriptor attributes');
      const pointer = (v: number): bigint => !v || rvaMode ? BigInt(v) : this.vaRva(BigInt(v));
      const nameRva = pointer(values[delayed ? 1 : 3]!);
      if (!nameRva) this.fail('Import descriptor has no DLL name', p);
      const library = this.rvaString(nameRva);
      if (!library) this.fail('Empty import library name', p);
      const iat = pointer(values[delayed ? 3 : 4]!);
      const lookup = pointer(values[delayed ? 4 : 0]!) || iat;
      if (!delayed && !values[0] && values[1]) throw new PELoadError('unsupported_target', 'Bound imports without an original lookup table cannot recover symbol identities safely');
      if (!iat || !lookup) this.fail('Import descriptor has no thunk table', p);
      if (delayed) {
        const fields: MetadataField[] = [integer('Attributes', values[0]!), integer('TimeDateStamp', values[7]!)];
        for (let n = 1; n <= 6; n++) {
          const rva = pointer(values[n]!);
          if (rva) this.memory(rva, n === 2 ? 8n : 1n);
          fields.push({ kind: 'address', name: ['Attributes', 'DllName', 'ModuleHandle', 'IAT', 'INT', 'BoundIAT', 'UnloadIAT'][n]!, value: this.address('rva', rva) });
        }
        this.header('data_directory', 'Delay import descriptor', p, 32n, fields);
      }
      const evidence_ids = this.fact(p, BigInt(stride), delayed ? `Delay imports from ${library}` : `Imports from ${library}`);
      let end = false;
      for (let n = 0; n < MAX_RECORDS; n++) {
        const lookupRva = lookup + BigInt(n * 8), slotRva = iat + BigInt(n * 8);
        const thunk = this.u64(this.file(lookupRva, 8n));
        this.memory(slotRva, 8n);
        if (!thunk) { end = true; break; }
        let name: string | null = null, ordinal: number | null = null;
        if (thunk & (1n << 63n)) {
          if ((thunk & 0x7fffffffffff0000n) !== 0n) this.fail('Ordinal import thunk contains reserved bits');
          ordinal = Number(thunk & 0xffffn);
        } else {
          const namePointer = delayed && !rvaMode ? this.vaRva(thunk) : thunk;
          if (namePointer > 0xffffffffn) this.fail('Name import thunk is not a 32-bit RVA (bound IAT without lookup is not supported)');
          this.file(namePointer, 3n); // includes WORD hint and at least the string terminator
          name = this.rvaString(namePointer + 2n);
          if (!name) this.fail('Empty imported symbol name');
        }
        if (this.imports.length >= MAX_RECORDS) throw new PELoadError('resource_limit', 'PE total import count exceeds 100000');
        this.imports.push({ id: this.id(delayed ? 'delay-import' : 'import', slotRva), original_name: name, display_name: name, library, ordinal, slot: this.address('va', this.base + slotRva), callable_entry: null, delayed, weak: false, evidence_ids });
      }
      if (!end) throw new PELoadError('resource_limit', 'Unterminated or oversized PE thunk table');
    }
    if (!terminated) this.fail('Import descriptor directory lacks a terminating null descriptor', start);
  }
  parseExports(): void {
    const d = this.directory(0);
    if (!d) return;
    if (d.size < 40n) this.fail('Truncated PE export directory');
    const p = this.file(d.rva, d.size), baseOrdinal = this.u32(p + 16n), functions = this.u32(p + 20n), names = this.u32(p + 24n);
    const moduleName = BigInt(this.u32(p + 12n));
    this.header('data_directory', 'IMAGE_EXPORT_DIRECTORY', p, 40n, [integer('Characteristics', this.u32(p)), integer('TimeDateStamp', this.u32(p + 4n)), integer('MajorVersion', this.u16(p + 8n)), integer('MinorVersion', this.u16(p + 10n)), integer('NameRVA', moduleName), ...(moduleName ? [{ kind: 'text' as const, name: 'ModuleName', value: this.rvaString(moduleName) }] : []), integer('Base', baseOrdinal), integer('NumberOfFunctions', functions), integer('NumberOfNames', names), integer('AddressOfFunctions', this.u32(p + 28n)), integer('AddressOfNames', this.u32(p + 32n)), integer('AddressOfNameOrdinals', this.u32(p + 36n))]);
    if (BigInt(baseOrdinal) + BigInt(functions) > 0x100000000n) this.fail('Export ordinal range overflows');
    const eat = this.table(BigInt(this.u32(p + 28n)), functions, 4), nameTable = this.table(BigInt(this.u32(p + 32n)), names, 4), ordinalTable = this.table(BigInt(this.u32(p + 36n)), names, 2);
    const byIndex = new Map<number, string[]>();
    for (let i = 0; i < names; i++) {
      const index = this.u16(ordinalTable + BigInt(i * 2));
      if (index >= functions) this.fail('Export name ordinal is outside EAT', ordinalTable + BigInt(i * 2));
      const name = this.rvaString(BigInt(this.u32(nameTable + BigInt(i * 4))));
      if (!name) this.fail('Empty export name');
      const aliases = byIndex.get(index) ?? [];
      aliases.push(name); byIndex.set(index, aliases);
    }
    for (let i = 0; i < functions; i++) {
      const entry = eat + BigInt(i * 4), rva = BigInt(this.u32(entry));
      if (!rva) { if (byIndex.has(i)) this.fail('Named export refers to empty EAT slot', entry); continue; }
      let forwarder: ExportRecord['forwarder'] = null, address: Address | null = null;
      if (rva >= d.rva && rva < d.rva + d.size) {
        const text = this.rvaString(rva, d.rva + d.size), dot = text.lastIndexOf('.');
        if (dot <= 0 || dot === text.length - 1) this.fail('Malformed export forwarder', entry);
        const symbol = text.slice(dot + 1);
        if (symbol.startsWith('#') && (!/^#[0-9]+$/.test(symbol) || BigInt(symbol.slice(1)) > 0xffffn)) this.fail('Malformed export ordinal forwarder', entry);
        forwarder = { library: text.slice(0, dot), symbol };
      } else address = this.memory(rva, 1n);
      const evidence_ids = this.fact(entry, 4n, `Export ordinal ${baseOrdinal + i}`);
      for (const [alias, name] of (byIndex.get(i) ?? [null]).entries()) {
        if (this.exports.length >= MAX_RECORDS) throw new PELoadError('resource_limit', 'PE total export count exceeds 100000');
        this.exports.push({ id: entityIdentity(this.slice.id, 'pe:export', [i, alias]), original_name: name, display_name: name, address, ordinal: baseOrdinal + i, forwarder, evidence_ids });
      }
    }
  }
  parseRelocations(): void {
    const d = this.directory(5);
    if (!d) return;
    const start = this.file(d.rva, d.size);
    let cursor = 0n, records = 0;
    while (cursor < d.size) {
      this.work();
      if (d.size - cursor < 8n) this.fail('Truncated base relocation block', start + cursor);
      const p = start + cursor, page = BigInt(this.u32(p)), size = this.u32(p + 4n);
      if (size < 8 || size % 4 || cursor + BigInt(size) > d.size || page % 4096n) this.fail('Invalid base relocation block size/page', p);
      const evidence_ids = this.fact(p, BigInt(size), 'PE base relocation block');
      for (let n = 8; n < size; n += 2) {
        if (++records > MAX_RECORDS) throw new PELoadError('resource_limit', 'PE relocation count exceeds 100000');
        const bits = this.u16(p + BigInt(n)), type = bits >>> 12, rva = page + BigInt(bits & 0xfff);
        if (!type) continue;
        if (type !== 10) { this.unsupported(`relocation:${type}`, `Unsupported AMD64 base relocation type ${type}`, p + BigInt(n)); if (type === 4) { n += 2; if (n >= size) this.fail('Truncated HIGHADJ relocation pair', p); } continue; }
        const address = this.memory(rva, 8n), file = this.file(rva, 8n), targetValue = this.u64(file);
        this.relocations.push({ id: this.id('rebase', rva), address, kind: 'rebase', encoding: 'IMAGE_REL_BASED_DIR64', width_bits: 64, target: targetValue ? this.address('va', targetValue) : null, symbol_id: null, addend: 0n, authenticated: false, evidence_ids });
      }
      cursor += BigInt(size);
    }
  }
  parseExceptions(): void {
    const d = this.directory(3);
    if (!d) return;
    if (d.size % 12n || d.rva % 4n) this.fail('Misaligned or truncated AMD64 runtime function table');
    const count = Number(d.size / 12n), p = this.table(d.rva, count, 12);
    let previousEnd = 0n;
    for (let i = 0; i < count; i++) {
      const entry = p + BigInt(i * 12), begin = BigInt(this.u32(entry)), end = BigInt(this.u32(entry + 4n)), unwind = BigInt(this.u32(entry + 8n));
      if (end <= begin || begin < previousEnd) this.fail('Invalid/unsorted/overlapping runtime function range', entry);
      this.memory(begin, end - begin, true); this.file(begin, end - begin); previousEnd = end;
      const evidence_ids = this.fact(entry, 12n, 'AMD64 runtime function range (boundary evidence, not a source signature)');
      this.hints.push({ kind: 'function', address: this.address('va', this.base + begin), size: end - begin, evidence_ids });
      this.unwind(unwind, begin, end, evidence_ids);
    }
  }
  unwind(initial: bigint, begin: bigint, end: bigint, evidence: readonly string[]): void {
    const visited = new Set<bigint>();
    let rva = initial;
    for (let depth = 0; depth < 64; depth++) {
      this.work();
      if (rva % 4n || visited.has(rva)) this.fail('Misaligned or cyclic UNWIND_INFO chain');
      visited.add(rva);
      const p = this.file(rva, 4n), versionFlags = this.u8(p), version = versionFlags & 7, flags = versionFlags >>> 3;
      if (version !== 1 || flags > 7) { this.unsupported(`unwind:version:${version}`, `UNWIND_INFO version ${version}/flags ${flags} retained without interpretation`, p); return; }
      if ((flags & 4) && (flags & 3)) this.fail('Chained UNWIND_INFO also specifies a handler', p);
      const prolog = this.u8(p + 1n), count = this.u8(p + 2n), frame = this.u8(p + 3n), tail = 4 + 2 * (count + count % 2);
      if (!((frame & 15)) && (frame >>> 4)) this.fail('UNWIND_INFO frame offset has no frame register', p);
      const length = tail + (flags & 4 ? 12 : flags & 3 ? 4 : 0);
      this.file(rva, BigInt(length));
      let lastOffset = 256;
      for (let slot = 0; slot < count;) {
        const code = p + 4n + BigInt(slot * 2), offset = this.u8(code), opInfo = this.u8(code + 1n), op = opInfo & 15, info = opInfo >>> 4;
        if (offset > prolog || offset > lastOffset) this.fail('Invalid UNWIND_CODE prolog offset ordering', code);
        lastOffset = offset;
        let slots: number;
        switch (op) {
          case 0: case 2: slots = 1; break;
          case 1: if (info > 1) this.fail('Invalid UWOP_ALLOC_LARGE OpInfo', code); slots = info === 0 ? 2 : 3; break;
          case 3: if (info !== 0 || !(frame & 15)) this.fail('Invalid UWOP_SET_FPREG', code); slots = 1; break;
          case 4: case 8: slots = 2; break;
          case 5: case 9: slots = 3; break;
          case 10: if (info > 1) this.fail('Invalid UWOP_PUSH_MACHFRAME OpInfo', code); slots = 1; break;
          default: this.unsupported(`unwind:opcode:${op}`, `Unknown UNWIND_CODE ${op}; no unwind semantics inferred`, code); return;
        }
        if (slot + slots > count) this.fail('UNWIND_CODE operand slots exceed CountOfCodes', code);
        slot += slots;
      }
      const handler = flags & 3 ? this.memory(BigInt(this.u32(p + BigInt(tail))), 1n, true) : null;
      const evidence_ids = [...evidence, ...this.fact(p, BigInt(length), 'AMD64 UNWIND_INFO v1; language-specific handler payload not interpreted')];
      this.hints.push({ kind: 'unwind', range: this.range('va', this.base + begin, end - begin), encoding: 'PE_AMD64_UNWIND_INFO_V1', record: this.range('file', p, BigInt(length)), handler, evidence_ids });
      if (handler) this.unsupported('unwind:language-handler', 'Language-specific exception handler payload is not interpreted', p + BigInt(tail));
      if (!(flags & 4)) return;
      const chain = p + BigInt(tail), nextBegin = BigInt(this.u32(chain)), nextEnd = BigInt(this.u32(chain + 4n));
      if (nextEnd <= nextBegin) this.fail('Invalid chained runtime function range', chain);
      this.memory(nextBegin, nextEnd - nextBegin, true);
      rva = BigInt(this.u32(chain + 8n));
    }
    throw new PELoadError('resource_limit', 'PE unwind chain exceeds 64 records');
  }
  parseTls(): void {
    const d = this.directory(9);
    if (!d) return;
    if (d.size < 40n) this.fail('Truncated IMAGE_TLS_DIRECTORY64');
    const p = this.file(d.rva, d.size), start = this.u64(p), end = this.u64(p + 8n), index = this.u64(p + 16n), callbacks = this.u64(p + 24n), zeroFill = this.u32(p + 32n), flags = this.u32(p + 36n);
    if (end < start || (!!start !== !!end)) this.fail('Invalid TLS template range', p);
    if (start && end > start) { const rva = this.vaRva(start); this.file(rva, end - start); this.hints.push({ kind: 'data', range: this.range('va', start, end - start), encoding: 'bytes', evidence_ids: this.fact(p, 16n, 'TLS initialization template') }); }
    if (!index) this.fail('TLS directory has no index address', p);
    this.memory(this.vaRva(index), 4n);
    this.header('tls_record', 'IMAGE_TLS_DIRECTORY64', p, 40n, [
      { kind: 'address', name: 'StartAddressOfRawData', value: this.address('va', start) }, { kind: 'address', name: 'EndAddressOfRawData', value: this.address('va', end) }, { kind: 'address', name: 'AddressOfIndex', value: this.address('va', index) }, { kind: 'address', name: 'AddressOfCallbacks', value: this.address('va', callbacks) }, integer('SizeOfZeroFill', zeroFill), integer('Characteristics', flags),
    ]);
    if (!callbacks) return;
    const rva = this.vaRva(callbacks);
    for (let i = 0; i < MAX_RECORDS; i++) {
      const file = this.file(rva + BigInt(i * 8), 8n), callback = this.u64(file);
      if (!callback) return;
      if (this.entries.length >= 1000) throw new PELoadError('resource_limit', 'PE entry point count exceeds 1000');
      const address = this.memory(this.vaRva(callback), 1n, true);
      this.file(callback - this.base, 1n);
      const evidence_ids = this.fact(file, 8n, 'TLS callback entry');
      this.entries.push(address);
      this.hints.push({ kind: 'function', address, size: null, evidence_ids });
    }
    throw new PELoadError('resource_limit', 'TLS callback table exceeds 100000 entries');
  }
  parseDebug(): void {
    const d = this.directory(6);
    if (!d) return;
    if (d.size % 28n) this.fail('Truncated IMAGE_DEBUG_DIRECTORY');
    const count = Number(d.size / 28n), start = this.table(d.rva, count, 28);
    for (let i = 0; i < count; i++) {
      const p = start + BigInt(i * 28), type = this.u32(p + 12n), size = BigInt(this.u32(p + 16n)), rva = BigInt(this.u32(p + 20n)), raw = BigInt(this.u32(p + 24n));
      const fields: MetadataField[] = [integer('Characteristics', this.u32(p)), integer('TimeDateStamp', this.u32(p + 4n)), integer('MajorVersion', this.u16(p + 8n)), integer('MinorVersion', this.u16(p + 10n)), integer('Type', type), integer('SizeOfData', size), { kind: 'address', name: 'AddressOfRawData', value: this.address('rva', rva) }, { kind: 'address', name: 'PointerToRawData', value: this.address('file', raw) }];
      if (size) {
        if (!raw) this.fail('Debug record has data size but no file pointer', p);
        this.bounds(raw, size);
        if (rva && this.file(rva, size) !== raw) this.fail('Debug RVA and raw file pointer disagree', p);
        fields.push({ kind: 'bytes', name: 'RawData', range: this.range('file', raw, size) });
        if (type === 2) {
          if (size < 4n) this.fail('Truncated CodeView signature', raw);
          const signature = this.u32(raw);
          fields.push(integer('CodeViewSignature', signature));
          if (signature === 0x53445352) {
            if (size < 25n) this.fail('Truncated RSDS record', raw);
            let guid = '';
            for (let n = 4; n < 20; n++) guid += this.u8(raw + BigInt(n)).toString(16).padStart(2, '0');
            fields.push({ kind: 'text', name: 'PdbGuidBytes', value: guid }, integer('PdbAge', this.u32(raw + 20n)), { kind: 'text', name: 'PdbPath', value: this.string(raw + 24n, raw + size) });
          } else if (signature === 0x3031424e) {
            if (size < 17n) this.fail('Truncated NB10 record', raw);
            fields.push(integer('PdbOffset', this.u32(raw + 4n)), integer('PdbTimeDateStamp', this.u32(raw + 8n)), integer('PdbAge', this.u32(raw + 12n)), { kind: 'text', name: 'PdbPath', value: this.string(raw + 16n, raw + size) });
          } else this.unsupported(`codeview:${signature}`, `CodeView signature 0x${signature.toString(16)} is not RSDS/NB10; no PDB identity inferred`, raw);
        } else this.unsupported(`debug:${type}`, `Debug type ${type} retained as a raw reference`, p);
      }
      this.header('debug_record', 'IMAGE_DEBUG_DIRECTORY', p, 28n, fields);
    }
  }
  parseSymbols(h: BasicHeader): void {
    const pointer = BigInt(this.u32(h.coff + 8n)), count = this.u32(h.coff + 12n);
    if (!pointer && !count) return;
    if (!pointer) this.fail('COFF symbol count has no symbol table');
    this.count(count, 18, pointer);
    const strings = pointer + BigInt(count * 18), size = this.u32(strings);
    if (size < 4) this.fail('COFF string table size is smaller than header', strings);
    this.bounds(strings, BigInt(size));
    const longName = (offset: number): string => {
      if (offset < 4 || offset >= size) this.fail('COFF string offset outside table', strings);
      return this.string(strings + BigInt(offset), strings + BigInt(size));
    };
    for (let i = 0; i < count;) {
      const p = pointer + BigInt(i * 18), name = this.u32(p) === 0 ? longName(this.u32(p + 4n)) : this.fixed(p, 8), value = BigInt(this.u32(p + 8n)), sectionBits = this.u16(p + 12n), section = sectionBits > 0x7fff ? sectionBits - 0x10000 : sectionBits, type = this.u16(p + 14n), storage = this.u8(p + 16n), auxiliaries = this.u8(p + 17n);
      if (i + auxiliaries >= count) this.fail('COFF auxiliary symbols exceed symbol table', p);
      if (section > this.sections.length || section < -2) this.fail('Invalid COFF symbol section', p);
      let address: Address | null = null;
      if (section > 0) {
        const s = this.sections[section - 1]!;
        if (value > s.virtual_range.size) this.fail('COFF symbol exceeds its section', p);
        address = this.address('va', s.virtual_range.start.value + value);
      } else if (section === -1) address = this.address('va', value);
      const kind: SymbolRecord['kind'] = section === -1 ? 'absolute' : type & 0x20 ? 'function' : storage === 3 && auxiliaries ? 'section' : section > 0 ? 'object' : 'unknown';
      this.symbols.push({ id: this.id('symbol', i), original_name: name, display_name: name, kind, address, size: null, binding: storage === 2 ? 'global' : storage === 3 ? 'local' : storage === 105 ? 'weak' : 'unknown', evidence_ids: this.fact(p, 18n, 'COFF symbol') });
      i += 1 + auxiliaries;
    }
    // PE long section names use the same COFF string table, never host paths.
    for (let i = 0; i < this.sections.length; i++) {
      const section = this.sections[i]!;
      if (/^\/[0-9]+$/.test(section.name)) this.sections[i] = { ...section, name: longName(Number(section.name.slice(1))) };
    }
  }
  load(sha256: string): LoadedImage {
    const h = this.basic();
    this.parseHeaders(h);
    this.parseImports(false); this.parseImports(true); this.parseExports(); this.parseRelocations();
    this.parseExceptions(); this.parseTls(); this.parseDebug(); this.parseSymbols(h);
    this.context.progress('PE metadata', 1, 1);
    return { id: this.image, sha256, bytes: this.bytes, selected_slice_id: this.slice.id, slices: [this.slice], target: { format: 'pe', architecture: 'x86_64', abi: 'windows-x64', endian: 'little', address_bits: 64, features: [] }, image_base: this.base, address_map: this.map, mappings: this.mappings, headers: this.headers, sections: this.sections, entry_points: this.entries, symbols: this.symbols, imports: this.imports, exports: this.exports, relocations: this.relocations, hints: this.hints, evidence: this.evidence, diagnostics: this.diagnostics, capabilities: this.capabilities };
  }
}

export class PELoader implements Loader {
  readonly name = 'open-decomp-pe';
  readonly version = '1.0.0';
  readonly format = 'pe' as const;
  inspect(bytes: ImmutableBytes, imageId: string, context: OperationContext): { readonly slices: readonly ImageSlice[]; readonly diagnostics: readonly Diagnostic[] } {
    const reader = new Reader(bytes, imageId, context), h = reader.basic();
    let supported = h.machine === 0x8664 && h.magic === 0x20b;
    let reason = supported ? '' : `Unsupported PE machine 0x${h.machine.toString(16)} / optional magic 0x${h.magic.toString(16)}`;
    if (supported) {
      if (h.optionalSize < 112) reader.fail('Truncated PE32+ optional header', h.optional);
      const count = reader.u32(h.optional + 108n);
      if (count > Math.floor((h.optionalSize - 112) / 8)) reader.fail('NumberOfRvaAndSizes exceeds optional header', h.optional + 108n);
      if (count > 14 && (reader.u32(h.optional + 224n) || reader.u32(h.optional + 228n))) { supported = false; reason = 'Managed CLR image; native bodies are unsupported'; }
      if (!(h.characteristics & 2) || (h.characteristics & 0x1000) || ![2, 3].includes(reader.u16(h.optional + 68n))) { supported = false; reason = 'Not a supported native Windows user-mode EXE/DLL'; }
    }
    const architecture = h.machine === 0x8664 ? 'x86_64' : `machine_0x${h.machine.toString(16)}`;
    const slice: ImageSlice = { id: sliceIdentity(imageId, 0n, BigInt(bytes.length), architecture), image_id: imageId, offset: 0n, size: BigInt(bytes.length), architecture, subtype: `PE_0x${h.magic.toString(16)}`, supported };
    return { slices: [slice], diagnostics: reason ? [{ code: 'unsupported_target', severity: 'error', message: reason, evidence_ids: [] }] : [] };
  }
  load(input: Parameters<Loader['load']>[0], context: OperationContext): LoadedImage {
    const inspection = this.inspect(input.bytes, input.image_id, context), slice = inspection.slices[0]!;
    if (input.slice_id !== null && input.slice_id !== slice.id) throw new PELoadError('invalid_input', 'Selected slice does not belong to this PE container');
    if (!slice.supported) throw new PELoadError('unsupported_target', inspection.diagnostics[0]!.message);
    return new Parser(input.bytes, input.image_id, context, slice).load(input.sha256);
  }
}
export const peLoader = new PELoader();
