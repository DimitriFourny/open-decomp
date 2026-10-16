import { type Address, type AddressMap, type ExportRecord, type SymbolRecord } from '../../core/index.js';
import { Cursor, MachOError, malformed, safe, vmEnd, type Payload } from './reader.js';
import { State } from './state.js';

export interface SymbolTable { offset: number; count: number; strings: number; stringSize: number }
export interface IndirectTable { offset: number; count: number }
export function readSymbols(s: State, table: SymbolTable | undefined, indirect: IndirectTable | undefined): void {
  if (!table) return;
  const r = s.r, raw: { record: SymbolRecord; type: number; desc: number; value: bigint }[] = [];
  s.readable(table.offset, table.count * 16); s.readable(table.strings, table.stringSize);
  for (let i = 0; i < table.count; i++) {
    r.context.checkpoint(1); const p = table.offset + i * 16, str = r.u32(p), type = r.byte(p + 4), sect = r.byte(p + 5), desc = r.u16(p + 6), value = r.u64(p + 8);
    if (str >= table.stringSize && str !== 0) malformed('Symbol string index exceeds table');
    const string = str ? r.string(table.strings + str, table.strings + table.stringSize) : null;
    const name = string?.text ?? '';
    const nameProof = string ? s.proof(table.strings + str, string.next - table.strings - str, 'Symbol string') : [];
    const section = sect ? s.rawSections[sect - 1] : undefined;
    if (!(type & 0xe0) && (type & 0xe) === 0xe && !section) malformed('Symbol section index exceeds section table');
    const defined = (type & 0xe) === 0xe || (type & 0xe) === 2;
    // n_sect associates a definition with a section; it does not prove that
    // n_value lies inside it (linkers also associate image-header symbols with
    // instruction sections). Only an in-section definition inherits its kind.
    const inSection = (type & 0xe) === 0xe && section && value >= section.va && value < section.va + section.size;
    const kind: SymbolRecord['kind'] = type & 0xe0 ? 'unknown' : (type & 0xe) === 2 ? 'absolute' : !inSection ? 'unknown' : section.flags & 0x80000400 || (section.flags & 255) === 8 ? 'function' : 'object';
    const record: SymbolRecord = { id: s.id('symbol', i), original_name: name || null, display_name: name || null, kind, address: defined ? s.va(value) : null, size: null, binding: desc & 0xc0 ? 'weak' : type & 1 ? 'global' : 'local', evidence_ids: [...s.proof(p, 16, 'Mach-O nlist_64 symbol'), ...nameProof, ...(section?.evidence ?? [])] };
    raw.push({ record, type, desc, value });
    if (!(type & 0xe0)) {
      s.symbols.push(record);
      if (defined && type & 1 && !(type & 0x10) && name) s.exports.push({ id: s.id('symbol_export', i), original_name: name, display_name: name, address: record.address, ordinal: null, forwarder: null, evidence_ids: record.evidence_ids });
    }
  }
  if (!indirect) return;
  s.readable(indirect.offset, indirect.count * 4);
  for (const section of s.rawSections) {
    const type = section.flags & 255;
    if (![6, 7, 8, 0x14].includes(type)) continue;
    const stride = type === 8 ? section.stride : 8;
    if (!stride || section.size % BigInt(stride)) malformed('Invalid indirect import stride');
    const count = safe(section.size / BigInt(stride));
    if (section.first > indirect.count || count > indirect.count - section.first) malformed('Indirect section exceeds symbol indices');
    for (let i = 0; i < count; i++) {
      r.context.checkpoint(1); const p = indirect.offset + (section.first + i) * 4, index = r.u32(p);
      if (index & 0xc0000000) continue;
      const symbol = raw[index]; if (!symbol) malformed('Indirect import symbol index outside table');
      if (symbol.type & 0xe0 || (symbol.type & 0xf) !== 1 || symbol.value !== 0n || !symbol.record.original_name) continue;
      s.readable(section.offset + i * stride, stride);
      const ordinal = symbol.desc >>> 8, libraryOrdinal = ordinal === 0xff ? -1 : ordinal === 0xfe ? -2 : ordinal;
      const address = s.va(section.va + BigInt(i * stride));
      s.imports.push({ id: s.id('indirect_import', `${section.id}:${i}`), original_name: symbol.record.original_name, display_name: symbol.record.display_name, library: s.library(libraryOrdinal), ordinal: null, slot: type === 8 ? null : address, callable_entry: type === 8 ? address : null, delayed: type === 7, weak: !!(symbol.desc & 0x40), evidence_ids: [...symbol.record.evidence_ids, ...section.evidence, ...s.proof(p, 4, 'Indirect symbol index')] });
    }
  }
}

export function readExports(s: State, payload: Payload): void {
  const r = s.r, start = payload.offset, end = start + payload.size;
  s.readable(start, payload.size); if (!payload.size) return;
  const trieProof = s.proof(start, payload.size, 'Dyld export trie names and terminals');
  const pending: { offset: number; name: string; leaving: boolean }[] = [{ offset: 0, name: '', leaving: false }], active = new Set<number>();
  while (pending.length) {
    const node = pending.pop()!; r.context.checkpoint(1 + node.name.length);
    if (node.leaving) { active.delete(node.offset); continue; }
    if (active.has(node.offset)) malformed('Export trie contains a cycle');
    active.add(node.offset); pending.push({ ...node, leaving: true });
    const c = new Cursor(r, start + node.offset, end), nodeStart = c.p, terminalSize = safe(c.leb()), terminalEnd = c.p + terminalSize;
    r.range(c.p, terminalSize, end);
    if (terminalSize) {
      const terminal = new Cursor(r, c.p, terminalEnd), flags = terminal.leb();
      let address: Address | null = null;
      let forwarder: ExportRecord['forwarder'] = null;
      let name: string;
      try { name = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(node.name, character => character.charCodeAt(0))); }
      catch { return malformed('Invalid UTF-8 export name'); }
      if (flags & 8n) {
        const ordinal = safe(terminal.leb()), symbol = terminal.string();
        const library = s.library(ordinal);
        if (library !== null) forwarder = { library, symbol: symbol || name };
      } else {
        const value = terminal.leb(), kind = flags & 3n;
        address = kind === 2n ? s.va(value) : kind === 0n || kind === 1n ? s.va(vmEnd(s.imageBase, value)) : null;
        if (flags & 16n) {
          const resolver = terminal.leb();
          s.hints.push({ kind: 'function', address: s.va(vmEnd(s.imageBase, resolver)), size: null, evidence_ids: s.proof(nodeStart, terminalEnd - nodeStart, 'Export resolver address') });
        }
        if (kind === 3n || flags & ~31n) s.warn(`Unsupported export flags ${flags.toString(16)}`, 'unsupported_target');
      }
      if (terminal.p !== terminalEnd) malformed('Export terminal has trailing bytes');
      if (name) s.exports.push({ id: s.id('trie_export', name), original_name: name, display_name: name, address, forwarder, ordinal: null, evidence_ids: [...trieProof, ...s.proof(nodeStart, terminalEnd - nodeStart, 'Dyld export trie terminal')] });
    }
    c.p = terminalEnd;
    const children = c.byte();
    for (let i = 0; i < children; i++) {
      const edge = c.rawString(), offset = safe(c.leb());
      if (!edge || offset >= payload.size) malformed('Invalid export trie child');
      if (node.name.length + edge.length > 8192) throw new MachOError('resource_limit', 'Export name exceeds 8192 bytes');
      r.context.checkpoint(node.name.length + edge.length);
      pending.push({ offset, name: node.name + edge, leaving: false });
    }
  }
}

export function readHints(s: State, map: AddressMap, starts: Payload | undefined, data: Payload | undefined): void {
  const r = s.r;
  if (starts) s.optional('Function starts', () => {
    s.readable(starts.offset, starts.size); const c = new Cursor(r, starts.offset, starts.offset + starts.size);
    let address = s.imageBase, terminated = false;
    while (c.p < c.end) {
      const p = c.p, delta = c.leb(); if (!delta) { terminated = true; break; }
      address = vmEnd(address, delta);
      const translation = map.translate(s.va(address), 'file');
      if (translation.kind !== 'mapped' || !s.rawSections.some(section => section.flags & 0x80000400 && address >= section.va && address < section.va + section.size)) malformed('Function start outside instruction sections');
      s.readable(safe(translation.address.value - s.slice.offset), 4);
      s.hints.push({ kind: 'function', address: s.va(address), size: null, evidence_ids: s.proof(p, c.p - p, 'LC_FUNCTION_STARTS delta') });
    }
    if (!terminated) malformed('Function starts lack terminator');
  });
  if (data) s.optional('Data in code', () => {
    s.readable(data.offset, data.size); if (data.size % 8) malformed('Data-in-code table is misaligned');
    for (let p = data.offset; p < data.offset + data.size; p += 8) {
      r.context.checkpoint(1); const offset = r.u32(p), size = r.u16(p + 4), kind = r.u16(p + 6);
      s.readable(offset, size);
      const translated = map.translate(s.file(offset, size).start, 'va');
      if (translated.kind !== 'mapped' || !map.spans(translated.address, BigInt(size)).every(span => span.kind === 'mapped' && span.file_offset === s.slice.offset + BigInt(offset) + span.range.start.value - translated.address.value)) malformed('Data-in-code range not contiguously file backed');
      if (size) s.hints.push({ kind: 'data', range: { start: translated.address, size: BigInt(size) }, encoding: kind >= 2 && kind <= 5 ? 'jump_table' : kind === 1 ? 'bytes' : 'unknown', evidence_ids: s.proof(p, 8, `LC_DATA_IN_CODE kind ${kind}`) });
    }
  });
  for (const section of s.rawSections) {
    if ([1, 0xc, 0x12].includes(section.flags & 255)) continue;
    if (section.name === '__compact_unwind') s.optional('Compact unwind records', () => {
      const size = safe(section.size); s.readable(section.offset, size);
      if (size % 32) malformed('Truncated 64-bit compact unwind records');
      for (let p = section.offset; p < section.offset + size; p += 32) {
        r.context.checkpoint(1);
        const start = r.u64(p), length = r.u32(p + 8), encoding = r.u32(p + 12), personality = r.u64(p + 16), lsda = r.u64(p + 24);
        vmEnd(start, BigInt(length));
        const proof = s.header('debug_record', 'compact_unwind_entry_64', p, 32, [{ kind: 'address', name: 'range_start', value: s.va(start) }, { kind: 'integer', name: 'range_length', value: BigInt(length) }, { kind: 'integer', name: 'encoding', value: BigInt(encoding) }, { kind: 'integer', name: 'personality_word', value: personality }, { kind: 'integer', name: 'lsda_word', value: lsda }]);
        const personalitySlot = section.va + BigInt(p - section.offset + 16);
        const fixed = s.relocations.find(record => record.address.value === personalitySlot);
        const handler = fixed ? fixed.target : personality ? s.va(personality) : null;
        if (length) s.hints.push({ kind: 'unwind', range: { start: s.va(start), size: BigInt(length) }, encoding: `compact-unwind-arm64:0x${encoding.toString(16)}`, record: s.file(p, 32), handler, evidence_ids: proof });
      }
    });
    if (section.name === '__unwind_info') s.optional('Compact unwind', () => readCompactUnwind(s, section.offset, safe(section.size)));
    if (section.name === '__eh_frame') {
      // Record framing is enough to preserve CFI for a later DWARF consumer; do not invent PC ranges from unparsed augmentation encodings.
      s.optional('DWARF CFI', () => {
        const end = section.offset + safe(section.size); let p = section.offset;
        while (p < end) {
          r.context.checkpoint(1); r.range(p, 4, end); const start = p; let length = BigInt(r.u32(p)); p += 4;
          if (!length) break;
          if (length === 0xffffffffn) { r.range(p, 8, end); length = r.u64(p); p += 8; }
          const size = safe(length); s.readable(p, size); r.range(p, size, end);
          s.header('debug_record', 'DWARF CFI record', start, p + size - start, [{ kind: 'bytes', name: 'CFI', range: s.file(p, size) }]);
          p += size;
        }
        s.warn('DWARF CFI records retained; PC ranges require DWARF augmentation decoding', 'unavailable_semantics', section.evidence);
      });
    }
  }
}

function readCompactUnwind(s: State, base: number, size: number): void {
  const r = s.r, end = base + size;
  s.readable(base, size); r.range(base, 28, end);
  if (r.u32(base) !== 1) throw new MachOError('unsupported_version', 'Unknown compact unwind version');
  const common = base + r.u32(base + 4), commonCount = r.u32(base + 8), personalities = base + r.u32(base + 12), personalityCount = r.u32(base + 16), index = base + r.u32(base + 20), count = r.u32(base + 24);
  r.range(common, commonCount * 4, end); r.range(personalities, personalityCount * 4, end); r.range(index, count * 12, end);
  if (count < 2 || commonCount > 256 || r.u32(index + (count - 1) * 12 + 4) !== 0) malformed('Invalid unwind index/sentinel or common encodings');
  const pages = new Set<number>(), sectionProof = s.proof(base, size, 'Compact unwind index, encodings and personality references');
  for (let i = 0; i + 1 < count; i++) {
    r.context.checkpoint(1); const first = index + i * 12, page = base + r.u32(first + 4), nextFunction = r.u32(first + 12);
    if (r.u32(first) >= nextFunction) malformed('Unwind index offsets are not increasing');
    if (!r.u32(first + 4)) continue;
    if (pages.has(page)) malformed('Repeated compact unwind page');
    pages.add(page);
    const pageEnd = Math.min(end, page + 4096);
    r.range(page, 8, end); const kind = r.u32(page), entries = page + r.u16(page + 4), entryCount = r.u16(page + 6);
    const lsda = base + r.u32(first + 8), lsdaEnd = base + r.u32(first + 20);
    if (lsdaEnd < lsda || (lsdaEnd - lsda) % 8) malformed('Invalid unwind LSDA table');
    r.range(lsda, lsdaEnd - lsda, end);
    if (kind !== 2 && kind !== 3) throw new MachOError('unsupported_target', `Unknown compact unwind page kind ${kind}`);
    if (entries < page + (kind === 2 ? 8 : 12)) malformed('Unwind entries overlap page header');
    r.range(entries, entryCount * (kind === 2 ? 8 : 4), pageEnd);
    let local = 0, localCount = 0;
    if (kind === 3) {
      r.range(page, 12, pageEnd); local = page + r.u16(page + 8); localCount = r.u16(page + 10);
      if (localCount && local < page + 12 || localCount + commonCount > 256) malformed('Invalid compressed unwind encoding table');
      r.range(local, localCount * 4, pageEnd);
    }
    const decoded: { offset: number; encoding: number; p: number }[] = [];
    for (let j = 0; j < entryCount; j++) {
      r.context.checkpoint(1); const p = entries + j * (kind === 2 ? 8 : 4), value = r.u32(p);
      let encoding: number;
      if (kind === 2) encoding = r.u32(p + 4);
      else {
        const encodingIndex = value >>> 24;
        if (encodingIndex >= commonCount + localCount) malformed('Unwind encoding index exceeds tables');
        encoding = encodingIndex < commonCount ? r.u32(common + encodingIndex * 4) : r.u32(local + (encodingIndex - commonCount) * 4);
      }
      decoded.push({ offset: kind === 2 ? value : r.u32(first) + (value & 0xffffff), encoding, p });
      if (j === 0 && decoded[j]!.offset !== r.u32(first)) malformed('Unwind page start disagrees with index');
    }
    for (let j = 0; j < decoded.length; j++) {
      r.context.checkpoint(1);
      const entry = decoded[j]!, next = decoded[j + 1]?.offset ?? nextFunction;
      if (next <= entry.offset || entry.offset < r.u32(first) || next > nextFunction) malformed('Unwind function ranges are not ordered');
      const personalityIndex = entry.encoding >>> 28 & 3;
      if (personalityIndex > personalityCount) malformed('Unwind personality index exceeds table');
      const personality = personalityIndex ? s.imageBase + BigInt(r.u32(personalities + (personalityIndex - 1) * 4)) : null;
      const fixed = personality === null ? undefined : s.relocations.find(record => record.address.value === personality);
      const direct = personality !== null && s.mappings.some(mapping => mapping.permissions.includes('execute') && personality >= mapping.va && personality < mapping.va + mapping.file_size);
      const handler = fixed ? fixed.target : direct && personality !== null ? s.va(personality) : null;
      s.hints.push({ kind: 'unwind', range: { start: s.va(s.imageBase + BigInt(entry.offset)), size: BigInt(next - entry.offset) }, encoding: `compact-unwind-arm64:0x${entry.encoding.toString(16)}`, record: s.file(entry.p, kind === 2 ? 8 : 4), handler, evidence_ids: [...sectionProof, ...s.proof(entry.p, kind === 2 ? 8 : 4, 'Compact unwind entry')] });
    }
  }
}
