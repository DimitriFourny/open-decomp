// SPDX-License-Identifier: MIT
import {
  AddressMap,
  entityIdentity,
  fingerprint,
  sliceIdentity,
  type Address,
  type AddressRange,
  type Diagnostic,
  type Evidence,
  type ExportRecord,
  type HeaderRecord,
  type ImageMapping,
  type ImageSlice,
  type ImmutableBytes,
  type ImportRecord,
  type LoadedImage,
  type Loader,
  type LoaderHint,
  type MetadataField,
  type OperationContext,
  type Relocation,
  type Section,
  type SymbolRecord,
} from '../../core/index.js';
import { ELFLoadError, Reader, type ELFHeader } from './reader.js';
export { ELFLoadError } from './reader.js';

interface RawSection {
  readonly index: number;
  readonly p: bigint;
  readonly nameIndex: number;
  name: string;
  readonly type: number;
  readonly flags: bigint;
  readonly va: bigint;
  readonly offset: bigint;
  readonly size: bigint;
  readonly link: number;
  readonly info: number;
  readonly alignment: bigint;
  readonly stride: bigint;
}
interface NativeSymbol {
  readonly record: SymbolRecord;
  readonly undefined: boolean;
  readonly type: number;
  readonly p: bigint;
}
const RELOCATIONS: Readonly<Record<number, { readonly name: string; readonly width: number }>> = {
  1: { name: 'R_X86_64_64', width: 64 },
  2: { name: 'R_X86_64_PC32', width: 32 },
  4: { name: 'R_X86_64_PLT32', width: 32 },
  6: { name: 'R_X86_64_GLOB_DAT', width: 64 },
  7: { name: 'R_X86_64_JUMP_SLOT', width: 64 },
  8: { name: 'R_X86_64_RELATIVE', width: 64 },
  9: { name: 'R_X86_64_GOTPCREL', width: 32 },
  10: { name: 'R_X86_64_32', width: 32 },
  11: { name: 'R_X86_64_32S', width: 32 },
  16: { name: 'R_X86_64_DTPMOD64', width: 64 },
  17: { name: 'R_X86_64_DTPOFF64', width: 64 },
  18: { name: 'R_X86_64_TPOFF64', width: 64 },
  37: { name: 'R_X86_64_IRELATIVE', width: 64 },
  38: { name: 'R_X86_64_RELATIVE64', width: 64 },
  41: { name: 'R_X86_64_GOTPCRELX', width: 32 },
  42: { name: 'R_X86_64_REX_GOTPCRELX', width: 32 },
};
const integer = (name: string, value: bigint | number): MetadataField => ({
  kind: 'integer',
  name,
  value: BigInt(value),
});

class Parser extends Reader {
  readonly headers: HeaderRecord[] = [];
  readonly sections: Section[] = [];
  readonly mappings: ImageMapping[] = [];
  readonly symbols: SymbolRecord[] = [];
  readonly imports: ImportRecord[] = [];
  readonly exports: ExportRecord[] = [];
  readonly relocations: Relocation[] = [];
  readonly hints: LoaderHint[] = [];
  readonly evidence: Evidence[] = [];
  readonly diagnostics: Diagnostic[] = [];
  readonly capabilities: LoadedImage['capabilities'][number][] = [];
  readonly raw: RawSection[] = [];
  readonly symbolTables = new Map<number, readonly NativeSymbol[]>();
  readonly versions = new Map<
    number,
    { readonly library: string; readonly proof: readonly string[] }
  >();
  readonly symbolVersions = new Map<number, readonly number[]>();
  readonly versionSections = new Map<number, RawSection>();
  readonly neededLibraries = new Map<string, readonly string[]>();
  readonly unsupportedFeatures = new Set<string>();
  readonly proofs = new Map<string, readonly string[]>();
  readonly importSymbols = new Set<string>();
  orderedMappings: readonly ImageMapping[] = [];
  instructionSections: readonly RawSection[] = [];
  base = 0n;
  dynamicRange: { offset: bigint; size: bigint; va: bigint } | undefined;
  constructor(
    bytes: ImmutableBytes,
    image: string,
    context: OperationContext,
    readonly slice: ImageSlice,
  ) {
    super(bytes, image, context);
  }

  id(kind: string, offset: bigint | number): string {
    return entityIdentity(this.slice.id, `elf:${kind}`, BigInt(offset));
  }

  range(space: Address['space'], offset: bigint, size: bigint): AddressRange {
    this.end(offset, size);
    return { start: this.address(space, offset), size };
  }

  fact(offset: bigint, size: bigint, claim: string): readonly string[] {
    this.bounds(offset, size);
    const key = `${offset}:${size}:${claim}`,
      previous = this.proofs.get(key);
    if (previous) return previous;
    const id = `evidence_${fingerprint([this.slice.id, offset, size, claim])}`;
    this.evidence.push({
      id,
      origin: { kind: 'binary', range: this.range('file', offset, size), description: claim },
      claim,
      derived_from: [],
      conflicts_with: [],
      revision: 0,
    });
    const proof = [id];
    this.proofs.set(key, proof);
    return proof;
  }

  header(
    kind: HeaderRecord['kind'],
    name: string,
    offset: bigint,
    size: bigint,
    fields: readonly MetadataField[],
    stringProof: readonly string[] = [],
  ): void {
    this.headers.push({
      kind,
      name,
      range: this.range('file', offset, size),
      fields,
      evidence_ids: [...this.fact(offset, size, name), ...stringProof],
    });
  }

  own(offset: bigint, size: bigint, claim: string): void {
    if (size)
      this.hints.push({
        kind: 'data',
        range: this.range('file', offset, size),
        encoding: 'bytes',
        evidence_ids: this.fact(offset, size, claim),
      });
  }

  unsupported(feature: string, message: string, p?: bigint): void {
    if (this.unsupportedFeatures.has(feature)) return;
    if (this.unsupportedFeatures.size >= 900)
      throw new ELFLoadError('resource_limit', 'ELF unsupported feature count exceeds 900');
    this.unsupportedFeatures.add(feature);
    this.capabilities.push({
      layer: 'format',
      feature,
      status: 'unsupported',
      limitations: [message],
    });
    this.diagnostics.push({
      code: 'unsupported_target',
      severity: 'warning',
      message,
      evidence_ids: [],
      ...(p === undefined ? {} : { address: this.address('file', p) }),
    });
  }

  mapping(va: bigint, size: bigint, backed = false): ImageMapping | undefined {
    this.end(va, size);
    let low = 0,
      high = this.orderedMappings.length;
    while (low < high) {
      this.work();
      const mid = (low + high) >>> 1;
      if (this.orderedMappings[mid]!.va <= va) low = mid + 1;
      else high = mid;
    }
    const m = this.orderedMappings[low - 1];
    return m &&
      va >= m.va &&
      va < m.va + m.memory_size &&
      va + size <= m.va + (backed ? m.file_size : m.memory_size)
      ? m
      : undefined;
  }

  file(va: bigint, size: bigint): bigint {
    const m = this.mapping(va, size, true);
    if (!m) this.fail('ELF metadata is unmapped, zero-filled, or crosses backing bounds');
    return m.file_offset + va - m.va;
  }

  name(strings: RawSection, index: number | bigint): string {
    if (strings.flags & 0x800n)
      throw new ELFLoadError('unsupported_target', 'Compressed ELF string tables are unsupported');
    if (strings.type !== 3 || BigInt(index) >= strings.size)
      this.fail('ELF string index outside linked string table', strings.p);
    return this.string(strings.offset + BigInt(index), strings.offset + strings.size);
  }

  parseSegments(h: ELFHeader): void {
    this.header('elf_header', h.type === 2 ? 'ELF64 ET_EXEC' : 'ELF64 ET_DYN', 0n, 64n, [
      integer('EI_CLASS', 2),
      integer('EI_DATA', 1),
      integer('EI_OSABI', h.osabi),
      integer('EI_ABIVERSION', this.u8(8n)),
      integer('e_type', h.type),
      integer('e_machine', h.machine),
      integer('e_version', 1),
      integer('e_entry', h.entry),
      integer('e_phoff', h.phoff),
      integer('e_shoff', h.shoff),
      integer('e_flags', this.u32(48n)),
      integer('e_ehsize', 64),
      integer('e_phentsize', 56),
      integer('e_phnum', h.phnum),
      integer('e_shentsize', 64),
      integer('e_shnum', h.shnum),
      integer('e_shstrndx', h.shstrndx),
    ]);
    this.own(0n, 64n, 'ELF header is structural metadata');
    this.own(h.phoff, BigInt(h.phnum) * 56n, 'ELF program headers are structural metadata');
    this.own(h.shoff, BigInt(h.shnum) * 64n, 'ELF section headers are structural metadata');
    for (let i = 0; i < h.phnum; i++) {
      const p = h.phoff + BigInt(i) * 56n,
        type = this.u32(p),
        flags = this.u32(p + 4n),
        offset = this.u64(p + 8n),
        va = this.u64(p + 16n),
        physical = this.u64(p + 24n),
        fileSize = this.u64(p + 32n),
        size = this.u64(p + 40n),
        alignment = this.u64(p + 48n);
      this.bounds(offset, fileSize);
      this.end(va, size);
      if (alignment > 1n && alignment & (alignment - 1n))
        this.fail('ELF segment alignment is not a power of two', p);
      const fields = [
        integer('p_type', type),
        integer('p_flags', flags),
        integer('p_offset', offset),
        integer('p_vaddr', va),
        integer('p_paddr', physical),
        integer('p_filesz', fileSize),
        integer('p_memsz', size),
        integer('p_align', alignment),
      ];
      if (type === 3) {
        if (!fileSize) this.fail('Empty ELF interpreter path', p);
        fields.push({
          kind: 'text',
          name: 'interpreter',
          value: this.string(offset, offset + fileSize),
        });
        this.own(offset, fileSize, 'ELF interpreter path');
      }
      this.header('elf_program_header', `ELF program header ${i}`, p, 56n, fields);
      if (type === 1) {
        if (fileSize > size || (alignment > 1n && va % alignment !== offset % alignment))
          this.fail('Invalid ELF PT_LOAD size or alignment congruence', p);
        if (!size) continue;
        const permissions: ImageMapping['permissions'] = (
          ['execute', 'write', 'read'] as const
        ).filter((_, bit) => flags & (1 << bit));
        const id = this.id('segment', i);
        this.mappings.push({
          id,
          va,
          memory_size: size,
          file_offset: offset,
          file_size: fileSize,
          permissions,
        });
        this.sections.push({
          id,
          name: `PT_LOAD[${i}]`,
          kind: 'segment',
          segment_id: null,
          virtual_range: this.range('va', va, size),
          file_range: fileSize ? this.range('file', offset, fileSize) : null,
          permissions,
          flags: BigInt(flags),
          evidence_ids: this.fact(p, 56n, 'ELF PT_LOAD mapping and permissions'),
        });
      } else if (type === 2) {
        if (this.dynamicRange || fileSize > size || !fileSize)
          this.fail('Duplicate or invalid ELF PT_DYNAMIC', p);
        this.dynamicRange = { offset, size: fileSize, va };
      } else if (type === 4 || type === 6 || type === 0x6474e550)
        this.own(offset, fileSize, 'ELF native program metadata');
      else if (type === 7)
        this.unsupported(
          'ELF TLS execution',
          'PT_TLS bytes are retained; thread-local addresses and runtime allocation are not reconstructed',
          p,
        );
    }
    if (!this.mappings.length) this.fail('ELF has no nonempty PT_LOAD mapping');
    this.orderedMappings = [...this.mappings].sort((a, b) =>
      a.va < b.va ? -1 : a.va > b.va ? 1 : 0,
    );
    this.base = this.orderedMappings[0]!.va;
  }

  parseSections(h: ELFHeader): void {
    for (let i = 0; i < h.shnum; i++) {
      const p = h.shoff + BigInt(i) * 64n;
      const s: RawSection = {
        index: i,
        p,
        name: '',
        nameIndex: this.u32(p),
        type: this.u32(p + 4n),
        flags: this.u64(p + 8n),
        va: this.u64(p + 16n),
        offset: this.u64(p + 24n),
        size: this.u64(p + 32n),
        link: this.u32(p + 40n),
        info: this.u32(p + 44n),
        alignment: this.u64(p + 48n),
        stride: this.u64(p + 56n),
      };
      if (i === 0) {
        if (
          s.nameIndex ||
          s.type ||
          s.flags ||
          s.va ||
          s.offset ||
          s.size ||
          s.link ||
          s.info ||
          s.alignment ||
          s.stride
        )
          this.fail('Invalid ELF null section', p);
      } else {
        if (s.type !== 8) this.bounds(s.offset, s.size);
        this.end(s.va, s.size);
        if (s.alignment > 1n && s.alignment & (s.alignment - 1n))
          this.fail('ELF section alignment is not a power of two', p);
        if (s.link >= h.shnum) this.fail('ELF section link is outside section table', p);
        if (s.flags & 0x800n)
          this.unsupported(
            'ELF compressed sections',
            'Compressed ELF sections are retained without decompression',
            p,
          );
        if ((s.flags & 0x802n) === 0x802n)
          this.fail('ELF compressed sections cannot be allocated', p);
        if (
          s.type === 3 &&
          s.size &&
          !(s.flags & 0x800n) &&
          (this.u8(s.offset) !== 0 || this.u8(s.offset + s.size - 1n) !== 0)
        )
          this.fail('ELF string table must begin and end with a null byte', p);
      }
      this.raw.push(s);
    }
    const strings = this.raw[h.shstrndx]!;
    if (h.shstrndx !== 0 && strings.type !== 3)
      this.fail('ELF section-name table is not SHT_STRTAB', strings.p);
    const allocated: RawSection[] = [];
    for (const s of this.raw) {
      if (h.shstrndx === 0) {
        if (s.nameIndex) this.fail('ELF section names lack a string table', s.p);
      } else s.name = this.name(strings, s.nameIndex);
      this.header('elf_section_header', s.name || `ELF section ${s.index}`, s.p, 64n, [
        { kind: 'text', name: 'name', value: s.name },
        integer('sh_name', s.nameIndex),
        integer('sh_type', s.type),
        integer('sh_flags', s.flags),
        integer('sh_addr', s.va),
        integer('sh_offset', s.offset),
        integer('sh_size', s.size),
        integer('sh_link', s.link),
        integer('sh_info', s.info),
        integer('sh_addralign', s.alignment),
        integer('sh_entsize', s.stride),
      ]);
      if (!s.index) continue;
      const alloc = Boolean(s.flags & 2n),
        tls = Boolean(s.flags & 0x400n),
        m = alloc && s.size ? this.mapping(s.va, s.size) : undefined;
      if (alloc && s.size) {
        if (!m || (s.alignment > 1n && s.va % s.alignment))
          this.fail('Allocated ELF section is outside its PT_LOAD or misaligned', s.p);
        if (s.type !== 8 && this.file(s.va, s.size) !== s.offset)
          this.fail('ELF section file and virtual mappings disagree', s.p);
        if (s.type === 8 && !tls && s.va < m.va + m.file_size)
          this.fail('ELF NOBITS section contradicts file backing', s.p);
        if (
          (s.flags & 4n && !m.permissions.includes('execute')) ||
          (s.flags & 1n && !m.permissions.includes('write'))
        )
          this.fail('ELF section permissions contradict its PT_LOAD', s.p);
        if (!tls || s.type !== 8) allocated.push(s);
      }
      const permissions: ImageMapping['permissions'] = alloc
        ? [
            ...(m?.permissions.includes('read') ? ['read' as const] : []),
            ...(s.flags & 1n ? ['write' as const] : []),
            ...(s.flags & 4n && s.type === 1 ? ['execute' as const] : []),
          ]
        : [];
      const evidence = this.fact(s.p, 64n, 'ELF section extent, flags and ownership');
      this.sections.push({
        id: this.id('section', s.index),
        name: s.name,
        kind: 'section',
        segment_id: m?.id ?? null,
        virtual_range: this.range(alloc ? 'va' : 'file', alloc ? s.va : s.offset, s.size),
        file_range: s.type === 8 ? null : this.range('file', s.offset, s.size),
        permissions,
        flags: s.flags,
        evidence_ids: evidence,
      });
      if (s.size && (!(s.flags & 4n) || s.type !== 1)) {
        this.hints.push({
          kind: 'data',
          range: this.range(alloc ? 'va' : 'file', alloc ? s.va : s.offset, s.size),
          encoding: 'bytes',
          evidence_ids: evidence,
        });
      }
    }
    allocated.sort((a, b) => (a.va < b.va ? -1 : a.va > b.va ? 1 : 0));
    for (let i = 1; i < allocated.length; i++)
      if (allocated[i]!.va < allocated[i - 1]!.va + allocated[i - 1]!.size)
        this.fail('Overlapping allocated ELF sections', allocated[i]!.p);
    this.instructionSections = allocated.filter(
      (section) => section.type === 1 && Boolean(section.flags & 4n),
    );
    const backed = this.raw
      .filter((s) => s.type !== 0 && s.type !== 8 && s.size > 0n)
      .sort((a, b) => (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0));
    for (let i = 1; i < backed.length; i++)
      if (backed[i]!.offset < backed[i - 1]!.offset + backed[i - 1]!.size)
        this.fail('Overlapping file-backed ELF sections', backed[i]!.p);
  }

  parseSymbols(): void {
    for (const s of this.raw) {
      if (s.type !== 2 && s.type !== 11) continue;
      if (s.flags & 0x800n)
        throw new ELFLoadError(
          'unsupported_target',
          'Compressed ELF symbol tables are unsupported',
        );
      if (s.stride !== 24n || s.size % 24n || !s.link)
        this.fail('Invalid ELF symbol table entry size or string-table link', s.p);
      const count = this.table(s.offset, s.size / 24n, 24n),
        strings = this.raw[s.link]!;
      if (!count || strings.type !== 3 || s.info > count)
        this.fail('Invalid ELF symbol string table, null entry or local-symbol boundary', s.p);
      this.own(s.offset, s.size, 'ELF symbol table');
      this.own(strings.offset, strings.size, 'ELF symbol names');
      const records: NativeSymbol[] = [];
      for (let i = 0; i < count; i++) {
        const p = s.offset + BigInt(i) * 24n,
          nameIndex = this.u32(p),
          info = this.u8(p + 4n),
          visibility = this.u8(p + 5n) & 3,
          section = this.u16(p + 6n),
          value = this.u64(p + 8n),
          size = this.u64(p + 16n),
          type = info & 15,
          binding = info >>> 4;
        const name = this.name(strings, nameIndex);
        if (!i && (nameIndex || info || visibility || section || value || size))
          this.fail('Invalid ELF null symbol', p);
        if (section === 0xffff)
          throw new ELFLoadError('unsupported_target', 'ELF SHN_XINDEX symbols are unsupported');
        let address: Address | null = null;
        if (section > 0 && section < 0xff00) {
          const owner = this.raw[section];
          if (!owner) this.fail('ELF symbol section index outside table', p);
          if (owner.flags & 2n && type !== 6) {
            if (value < owner.va || this.end(value, size) > owner.va + owner.size)
              this.fail('ELF symbol exceeds its owning section', p);
            address = this.address('va', value);
          }
        } else if (section === 0xfff1) address = this.address('va', value);
        else if (section !== 0)
          this.unsupported(
            `ELF special symbol section ${section}`,
            `ELF special symbol section 0x${section.toString(16)} has no reconstructed address`,
            p,
          );
        if (type === 6)
          this.unsupported(
            'ELF TLS symbols',
            'TLS symbol values are thread-relative offsets, not linked VAs',
            p,
          );
        if (type === 10)
          this.unsupported(
            'ELF IFUNC resolution',
            'GNU IFUNC symbol identifies a resolver; the runtime-selected function is not inferred',
            p,
          );
        const evidence = [
          ...this.fact(p, 24n, 'ELF symbol value, size, type and binding'),
          ...this.fact(
            strings.offset + BigInt(nameIndex),
            BigInt(name.length + 1),
            'ELF symbol name',
          ),
        ];
        const record: SymbolRecord = {
          id: this.id('symbol', p),
          original_name: name || null,
          display_name: name || null,
          kind:
            section === 0xfff1
              ? 'absolute'
              : type === 2
                ? 'function'
                : type === 1
                  ? 'object'
                  : type === 3
                    ? 'section'
                    : 'unknown',
          address,
          size,
          binding:
            binding === 0 ? 'local' : binding === 1 ? 'global' : binding === 2 ? 'weak' : 'unknown',
          evidence_ids: evidence,
        };
        records.push({ record, undefined: section === 0, type, p });
        if (i) this.symbols.push(record);
        if (
          i &&
          s.type === 11 &&
          section !== 0 &&
          (binding === 1 || binding === 2 || binding === 10) &&
          (visibility === 0 || visibility === 3) &&
          name
        )
          this.exports.push({
            id: this.id('export', p),
            original_name: name,
            display_name: name,
            address: type === 6 || type === 10 ? null : address,
            ordinal: null,
            forwarder: null,
            evidence_ids: evidence,
          });
      }
      this.symbolTables.set(s.index, records);
    }
  }

  parseDynamic(): void {
    const tables = this.raw.filter((s) => s.type === 6);
    if (tables.length > 1) this.fail('Multiple ELF dynamic sections');
    const s = tables[0];
    if (this.dynamicRange) {
      const d = this.dynamicRange;
      if (this.file(d.va, d.size) !== d.offset)
        this.fail('ELF PT_DYNAMIC does not match PT_LOAD backing');
      if (!s || s.offset !== d.offset || s.size !== d.size || s.va !== d.va)
        this.fail('ELF PT_DYNAMIC and SHT_DYNAMIC disagree');
    } else if (s) this.fail('ELF dynamic section lacks PT_DYNAMIC', s.p);
    if (!s) return;
    if (s.flags & 0x800n)
      throw new ELFLoadError('unsupported_target', 'Compressed ELF dynamic tables are unsupported');
    if (s.stride !== 16n || s.size % 16n || !s.link || this.raw[s.link]!.type !== 3)
      this.fail('Invalid ELF dynamic table or linked string table', s.p);
    const count = this.table(s.offset, s.size / 16n, 16n),
      strings = this.raw[s.link]!;
    let terminated = false;
    const unique = new Map<bigint, bigint>();
    for (let i = 0; i < count; i++) {
      const p = s.offset + BigInt(i) * 16n,
        tag = this.u64(p),
        value = this.u64(p + 8n);
      if (terminated) {
        if (tag || value) this.fail('Non-null ELF dynamic record after DT_NULL', p);
        continue;
      }
      const fields: MetadataField[] = [integer('d_tag', tag), integer('d_val', value)];
      let stringProof: readonly string[] = [];
      if ([1n, 14n, 15n, 29n].includes(tag)) {
        const valueText = this.name(strings, value);
        stringProof = this.fact(
          strings.offset + value,
          BigInt(valueText.length + 1),
          'ELF dynamic string',
        );
        fields.push({
          kind: 'text',
          name: tag === 1n ? 'needed_library' : 'string',
          value: valueText,
        });
        if (tag === 1n)
          this.neededLibraries.set(valueText, [
            ...this.fact(p, 16n, 'ELF needed library'),
            ...stringProof,
          ]);
      }
      this.header(
        'elf_dynamic',
        tag === 1n ? 'DT_NEEDED' : `ELF dynamic tag 0x${tag.toString(16)}`,
        p,
        16n,
        fields,
        stringProof,
      );
      if (tag === 0n) terminated = true;
      else if (![1n, 0x7ffffffdn, 0x7fffffffn].includes(tag)) {
        if (unique.has(tag)) this.fail('Duplicate singleton ELF dynamic tag', p);
        unique.set(tag, value);
      }
    }
    if (!terminated) this.fail('Unterminated ELF dynamic table', s.offset);
    this.own(s.offset, s.size, 'ELF dynamic records');
    if (
      unique.get(5n) !== strings.va ||
      unique.get(10n) !== strings.size ||
      this.file(strings.va, strings.size) !== strings.offset
    )
      this.fail('ELF DT_STRTAB/DT_STRSZ contradict linked string backing', s.p);
    const dynamicRelocations: RawSection[] = [];
    const match = (
      tag: bigint,
      type: number,
      sizeTag?: bigint,
      strideTag?: bigint,
    ): RawSection | undefined => {
      const va = unique.get(tag);
      if (va === undefined) {
        if (sizeTag !== undefined && unique.has(sizeTag) && unique.get(sizeTag) !== 0n)
          this.fail('ELF dynamic table size lacks pointer', s.p);
        return;
      }
      const size = sizeTag === undefined ? undefined : unique.get(sizeTag);
      const candidates = this.raw.filter(
        (section) =>
          section.type === type &&
          section.va === va &&
          (size === undefined || section.size === size),
      );
      if (
        candidates.length !== 1 ||
        (strideTag !== undefined && unique.get(strideTag) !== candidates[0]!.stride)
      )
        this.fail('ELF dynamic table pointer/size/stride contradict section evidence', s.p);
      const table = candidates[0]!;
      if (this.file(va, table.size) !== table.offset)
        this.fail('ELF dynamic pointer contradicts section file backing', table.p);
      if (type === 4 || type === 9) dynamicRelocations.push(table);
      return table;
    };
    const dynamicSymbols = match(6n, 11, undefined, 11n);
    if (dynamicSymbols && dynamicSymbols.link !== s.link)
      this.fail('ELF dynamic symbols do not use DT_STRTAB strings', dynamicSymbols.p);
    match(7n, 4, 8n, 9n);
    match(17n, 9, 18n, 19n);
    const versionSymbols = match(0x6ffffff0n, 0x6fffffff);
    const versionNeeds = match(0x6ffffffen, 0x6ffffffe);
    if (versionSymbols && versionSymbols.link !== dynamicSymbols?.index)
      this.fail('ELF version indexes do not use DT_SYMTAB symbols', versionSymbols.p);
    if (versionNeeds && versionNeeds.link !== s.link)
      this.fail('ELF version requirements do not use DT_STRTAB strings', versionNeeds.p);
    for (const [pointer, countTag, type] of [
      [0x6ffffffen, 0x6fffffffn, 0x6ffffffen],
      [0x6ffffffcn, 0x6ffffffdn, 0x6ffffffdn],
    ] as const) {
      if (!unique.has(pointer) && !unique.has(countTag)) continue;
      const table = this.raw.find(
        (section) => BigInt(section.type) === type && section.va === unique.get(pointer),
      );
      if (!table || unique.get(countTag) !== BigInt(table.info))
        this.fail('ELF version dynamic pointer/count contradict section evidence', s.p);
      if (table.link !== s.link || this.file(table.va, table.size) !== table.offset)
        this.fail('ELF version dynamic metadata contradicts linked string/file backing', table.p);
    }
    if (unique.has(23n)) {
      const encoding = unique.get(20n);
      if (encoding !== 7n && encoding !== 17n) this.fail('Invalid ELF DT_PLTREL encoding', s.p);
      if (!unique.has(2n)) this.fail('ELF DT_JMPREL lacks DT_PLTRELSZ', s.p);
      match(23n, encoding === 7n ? 4 : 9, 2n);
    } else if (unique.get(2n)) this.fail('ELF DT_PLTRELSZ lacks DT_JMPREL', s.p);
    for (const table of dynamicRelocations)
      if (table.link !== dynamicSymbols?.index)
        this.fail('ELF dynamic relocations do not use DT_SYMTAB symbols', table.p);
    if (unique.has(36n) || unique.has(35n) || unique.has(37n))
      this.unsupported(
        'ELF RELR',
        'Packed RELR relocations are retained as native bytes without expansion',
        s.p,
      );
    for (const tag of [0x6000000fn, 0x60000010n, 0x60000011n, 0x60000012n])
      if (unique.has(tag))
        this.unsupported(
          'ELF Android packed relocations',
          'Android packed relocation metadata is not expanded',
          s.p,
        );
  }

  parseVersions(): void {
    for (const s of this.raw) {
      if ([0x6ffffffe, 0x6fffffff].includes(s.type) && s.flags & 0x800n)
        throw new ELFLoadError(
          'unsupported_target',
          'Compressed ELF version metadata is unsupported',
        );
      if (s.type === 0x6ffffffe) {
        const strings = this.raw[s.link]!;
        if (!s.link || strings.type !== 3) this.fail('Invalid ELF version-need string table', s.p);
        if (!s.info || s.size < 16n)
          this.fail('ELF version-need section has no bounded records', s.p);
        this.table(s.offset, BigInt(s.info), 16n);
        let p = s.offset;
        for (let i = 0; i < s.info; i++) {
          if (p < s.offset || p + 16n > s.offset + s.size)
            this.fail('ELF version-need record exceeds section', p);
          const version = this.u16(p),
            count = this.u16(p + 2n),
            libraryIndex = this.u32(p + 4n),
            aux = this.u32(p + 8n),
            next = this.u32(p + 12n),
            library = this.name(strings, libraryIndex);
          if (version !== 1 || !count || aux < 16) this.fail('Invalid ELF version-need record', p);
          // A version requirement names its own provider; retain both native proofs.
          const providerProof = [
            ...this.fact(p, 16n, 'ELF version requirement provider'),
            ...this.fact(
              strings.offset + BigInt(libraryIndex),
              BigInt(library.length + 1),
              'ELF version provider name',
            ),
            ...(this.neededLibraries.get(library) ?? []),
          ];
          let q = p + BigInt(aux);
          this.table(q, BigInt(count), 16n);
          for (let j = 0; j < count; j++) {
            if (q < p + 16n || q + 16n > s.offset + s.size)
              this.fail('ELF version auxiliary record exceeds section', q);
            const index = this.u16(q + 6n) & 0x7fff,
              nameIndex = this.u32(q + 8n),
              advance = this.u32(q + 12n);
            this.name(strings, nameIndex);
            if (index <= 1 || this.versions.has(index))
              this.fail('Invalid or duplicate ELF version requirement index', q);
            this.versions.set(index, {
              library,
              proof: [...providerProof, ...this.fact(q, 16n, 'ELF version requirement index')],
            });
            if (j + 1 < count) {
              if (advance < 16) this.fail('Invalid ELF version auxiliary chain', q);
              q += BigInt(advance);
            } else if (advance !== 0) this.fail('ELF version auxiliary count contradicts chain', q);
          }
          if (i + 1 < s.info) {
            if (next < 16 || p + BigInt(next) <= q) this.fail('Invalid ELF version-need chain', p);
            p += BigInt(next);
          } else if (next !== 0) this.fail('ELF version-need count contradicts chain', p);
        }
        this.own(s.offset, s.size, 'ELF version requirements');
      } else if (s.type === 0x6fffffff) {
        const symbols = this.symbolTables.get(s.link);
        if (
          !symbols ||
          this.raw[s.link]!.type !== 11 ||
          s.size !== BigInt(symbols.length) * 2n ||
          (s.stride !== 0n && s.stride !== 2n) ||
          this.symbolVersions.has(s.link)
        )
          this.fail('ELF version symbols contradict dynamic symbol table', s.p);
        this.table(s.offset, BigInt(symbols.length), 2n);
        const indexes: number[] = [];
        for (let i = 0; i < symbols.length; i++)
          indexes.push(this.u16(s.offset + BigInt(i * 2)) & 0x7fff);
        this.symbolVersions.set(s.link, indexes);
        this.versionSections.set(s.link, s);
        this.own(s.offset, s.size, 'ELF symbol version indexes');
      }
    }
  }

  importFor(
    table: number,
    index: number,
    symbol: NativeSymbol,
    slot: Address | null,
    relocationProof: readonly string[] = [],
  ): void {
    if (!symbol.record.original_name) return;
    const version = this.symbolVersions.get(table)?.[index],
      provider = version === undefined ? undefined : this.versions.get(version);
    if (version !== undefined && version > 1 && !provider)
      this.fail('Undefined ELF symbol version lacks a version requirement', symbol.p);
    const versionSection = this.versionSections.get(table);
    const evidence = [
      ...symbol.record.evidence_ids,
      ...relocationProof,
      ...(provider?.proof ?? []),
      ...(versionSection
        ? this.fact(
            versionSection.offset + BigInt(index * 2),
            2n,
            'ELF imported symbol version index',
          )
        : []),
    ];
    this.imports.push({
      id: this.id(slot ? 'import-slot' : 'import-symbol', slot?.value ?? symbol.p),
      original_name: symbol.record.original_name,
      display_name: symbol.record.display_name,
      library: provider?.library ?? null,
      ordinal: null,
      slot,
      callable_entry: null,
      delayed: false,
      weak: symbol.record.binding === 'weak',
      evidence_ids: evidence,
    });
    this.importSymbols.add(symbol.record.id);
  }

  parseRelocations(): void {
    const slots = new Set<bigint>();
    for (const s of this.raw) {
      if (s.type !== 4 && s.type !== 9) continue;
      const stride = s.type === 4 ? 24n : 16n,
        symbols = this.symbolTables.get(s.link);
      if (s.stride !== stride || s.size % stride || !symbols || s.info >= this.raw.length)
        this.fail('Invalid ELF relocation table or symbol/target link', s.p);
      if (s.flags & 0x800n)
        throw new ELFLoadError(
          'unsupported_target',
          'Compressed ELF relocation tables are unsupported',
        );
      const count = this.table(s.offset, s.size / stride, stride);
      this.own(s.offset, s.size, 'ELF relocation table');
      const owner = s.info ? this.raw[s.info]! : undefined;
      for (let i = 0; i < count; i++) {
        const p = s.offset + BigInt(i) * stride,
          va = this.u64(p),
          info = this.u64(p + 8n),
          index = Number(info >> 32n),
          type = Number(info & 0xffffffffn),
          symbol = symbols[index];
        if (!symbol) this.fail('ELF relocation symbol index exceeds symbol table', p);
        if (!type) continue;
        if ((type === 8 || type === 37 || type === 38) && index !== 0)
          this.fail('ELF relative relocation must not name a symbol', p);
        if ((type === 5 || type === 6 || type === 7) && index === 0)
          this.fail('ELF symbol relocation lacks a symbol', p);
        if (owner && !(owner.flags & 2n)) {
          this.unsupported(
            'ELF nonallocated relocations',
            'Nonallocated/debug relocation bytes are retained without VA interpretation',
            p,
          );
          continue;
        }
        if (!this.mapping(va, 1n) || (owner && (va < owner.va || va >= owner.va + owner.size)))
          this.fail('ELF relocation site is outside mapped target memory', p);
        if (type === 5) {
          this.unsupported(
            'ELF COPY relocation ownership',
            'COPY relocation bytes are retained; dependency object width and copied storage are not guessed',
            p,
          );
          continue;
        }
        const encoding = RELOCATIONS[type];
        if (!encoding) {
          this.unsupported(
            `ELF relocation ${type}`,
            `Unknown x86-64 relocation ${type} retained as native table bytes; width/target are not guessed`,
            p,
          );
          continue;
        }
        const width = BigInt(encoding.width / 8);
        const siteMapping = this.mapping(va, width);
        if (!siteMapping || (owner && (va < owner.va || va + width > owner.va + owner.size)))
          this.fail('ELF relocation site is outside mapped target memory', p);
        const zeroAddend = va >= siteMapping.va + siteMapping.file_size;
        const addend =
          s.type === 4
            ? this.signed(p + 16n, 64)
            : zeroAddend
              ? 0n
              : this.signed(this.file(va, width), encoding.width);
        let target: Address | null = null;
        const candidate =
          type === 8 || type === 38
            ? addend
            : (type === 1 || type === 6 || type === 7) &&
                symbol.type !== 10 &&
                symbol.record.address
              ? symbol.record.address.value + (type === 1 ? addend : 0n)
              : undefined;
        if (
          candidate !== undefined &&
          candidate >= 0n &&
          candidate < 1n << 64n &&
          this.mapping(candidate, 1n)
        )
          target = this.address('va', candidate);
        const evidence = [
          ...this.fact(p, stride, 'ELF relocation site, encoding, symbol and addend'),
          ...symbol.record.evidence_ids,
        ];
        if (s.type === 9) {
          if (zeroAddend)
            evidence.push(...this.fact(s.p, 64n, 'ELF implicit relocation addend is zero-fill'));
          else
            evidence.push(
              ...this.fact(this.file(va, width), width, 'ELF implicit relocation addend'),
            );
        }
        this.relocations.push({
          id: this.id('relocation', p),
          address: this.address('va', va),
          kind: symbol.undefined && index ? 'bind' : 'relocation',
          encoding: encoding.name,
          width_bits: encoding.width,
          target,
          symbol_id: index ? symbol.record.id : null,
          addend,
          authenticated: false,
          evidence_ids: evidence,
        });
        if (
          (type === 6 || type === 7 || (type === 1 && addend === 0n)) &&
          symbol.undefined &&
          index &&
          this.raw[s.link]!.type === 11
        ) {
          // SHF_EXECINSTR establishes possible instruction ownership, not proof of
          // standalone pointer storage. A relocation may patch an immediate.
          let low = 0,
            high = this.instructionSections.length;
          while (low < high) {
            this.work();
            const mid = (low + high) >>> 1,
              section = this.instructionSections[mid]!;
            if (section.va + section.size <= va) low = mid + 1;
            else high = mid;
          }
          const possibleCode = this.instructionSections[low];
          if (possibleCode && possibleCode.va < va + width) {
            if (!this.importSymbols.has(symbol.record.id))
              this.importFor(s.link, index, symbol, null, evidence);
            continue;
          }
          if (slots.has(va)) this.fail('Multiple ELF import relocations claim one slot', p);
          slots.add(va);
          this.importFor(s.link, index, symbol, this.address('va', va), evidence);
          this.hints.push({
            kind: 'data',
            range: this.range('va', va, width),
            encoding: 'bytes',
            evidence_ids: evidence,
          });
        }
        if (type === 37)
          this.unsupported(
            'ELF IRELATIVE resolution',
            'IRELATIVE resolver relocation is retained without executing or predicting its result',
            p,
          );
      }
    }
    for (const [table, symbols] of this.symbolTables) {
      if (this.raw[table]!.type !== 11) continue;
      for (let i = 1; i < symbols.length; i++) {
        const symbol = symbols[i]!;
        if (symbol.undefined && !this.importSymbols.has(symbol.record.id))
          this.importFor(table, i, symbol, null);
      }
    }
    if (this.imports.length)
      this.unsupported(
        'ELF PLT callable entries',
        'Import slots are relocation-evidenced; PLT callable entries and lazy-binding execution are not reconstructed',
      );
  }

  load(sha256: string): LoadedImage {
    const h = this.basic();
    this.parseSegments(h);
    let map: AddressMap;
    try {
      map = new AddressMap({
        image_id: this.image,
        image_base: this.base,
        byte_length: BigInt(this.bytes.length),
        slice_offset: 0n,
        slice_size: BigInt(this.bytes.length),
        mappings: this.mappings,
      });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      this.fail(`ELF PT_LOAD mappings violate unique VA/file translation: ${error.message}`);
    }
    this.parseSections(h);
    this.parseSymbols();
    this.parseDynamic();
    this.parseVersions();
    this.parseRelocations();
    const entries: Address[] = [];
    if (h.entry) {
      const mapping = this.mapping(h.entry, 1n, true);
      if (!mapping?.permissions.includes('execute'))
        this.fail('ELF entry point is not backed executable memory', 24n);
      entries.push(this.address('va', h.entry));
    }
    this.capabilities.unshift({
      layer: 'format',
      feature: 'ELF64LE EM_X86_64 ET_EXEC/ET_DYN static metadata',
      status: 'supported',
      limitations: [
        'Linked virtual addresses are preserved; no ASLR bias, dynamic linker, dependency loading, syscall semantics or relocation execution is inferred',
        'A bounded section table and unique PT_LOAD VA/file mappings are required',
        'System V OSABI does not establish a Linux kernel environment',
      ],
    });
    this.context.progress('ELF metadata', 1, 1);
    return {
      id: this.image,
      sha256,
      bytes: this.bytes,
      selected_slice_id: this.slice.id,
      slices: [this.slice],
      target: {
        format: 'elf',
        architecture: 'x86_64',
        abi: 'sysv-amd64',
        endian: 'little',
        address_bits: 64,
        features: [],
      },
      image_base: this.base,
      address_map: map,
      mappings: this.mappings,
      headers: this.headers,
      sections: this.sections,
      entry_points: entries,
      symbols: this.symbols,
      imports: this.imports,
      exports: this.exports,
      relocations: this.relocations,
      hints: this.hints,
      evidence: this.evidence,
      diagnostics: this.diagnostics,
      capabilities: this.capabilities,
    };
  }
}

/** Bounded static ELF inspection; never opens dependencies or executes target code.
 * Native layouts: https://refspecs.linuxfoundation.org/elf/gabi4+/contents.html
 * x86-64 relocations: https://gitlab.com/x86-psABIs/x86-64-ABI
 * Subset: linked ELF64LE EM_X86_64 ET_EXEC/ET_DYN, OSABI 0/3, bounded
 * sections and nonaliasing PT_LOAD mappings. Extended indexes/counts, sectionless
 * images, ET_REL and compressed native tables are explicitly unsupported.
 * Symbol sizes/bindings, dynamic strings, GNU import version providers and known
 * REL/RELA sites/addends are binary facts. Unknown relocations, COPY/RELR, TLS,
 * IFUNC and PLT execution are never guessed or applied. Noncode sections, native
 * tables and headers retain data ownership even under executable PT_LOAD flags.
 * The target supplies no CPUID feature restriction; long64 is a decoder mode.
 * Possible instruction operands are not asserted to be pointer slots/data.
 * Unwind/debug bytes are retained as sections, not interpreted as recovered CFI
 * or ELF DWARF. Limits: 128 MiB, 100000 metadata records, 4096-byte strings,
 * plus the caller's cancellation/work/deadline budget.
 */
export class ELFLoader implements Loader {
  readonly name = 'open-decomp-elf';
  readonly version = '1.0.0';
  readonly format = 'elf' as const;
  inspect(
    bytes: ImmutableBytes,
    imageId: string,
    context: OperationContext,
  ): { readonly slices: readonly ImageSlice[]; readonly diagnostics: readonly Diagnostic[] } {
    const r = new Reader(bytes, imageId, context),
      identification = r.identification();
    let supported = identification.supported,
      reason = identification.reason;
    if (supported) {
      try {
        r.basic();
      } catch (error) {
        if (!(error instanceof ELFLoadError) || error.diagnostic.code !== 'unsupported_target')
          throw error;
        supported = false;
        reason = error.diagnostic.message;
      }
    }
    const slice: ImageSlice = {
      id: sliceIdentity(imageId, 0n, BigInt(bytes.length), identification.architecture),
      image_id: imageId,
      offset: 0n,
      size: BigInt(bytes.length),
      architecture: identification.architecture,
      subtype: 'ELF64LE',
      supported,
    };
    return {
      slices: [slice],
      diagnostics: reason
        ? [{ code: 'unsupported_target', severity: 'error', message: reason, evidence_ids: [] }]
        : [],
    };
  }

  load(input: Parameters<Loader['load']>[0], context: OperationContext): LoadedImage {
    const inspection = this.inspect(input.bytes, input.image_id, context),
      slice = inspection.slices[0]!;
    if (input.slice_id !== null && input.slice_id !== slice.id)
      throw new ELFLoadError(
        'invalid_input',
        'Selected slice does not belong to this ELF container',
      );
    if (!slice.supported)
      throw new ELFLoadError('unsupported_target', inspection.diagnostics[0]!.message);
    return new Parser(input.bytes, input.image_id, context, slice).load(input.sha256);
  }
}
export const elfLoader = new ELFLoader();
