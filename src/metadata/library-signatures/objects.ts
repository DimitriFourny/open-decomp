/** Function bodies of relocatable objects (`.o`, and `ar` archives of them) with the bytes their
 * relocations make position-dependent: the input of signature generation, as FLIRT's sigmake
 * reads it. Supported: ELF64 little-endian x86-64 (ET_REL). */

export class ObjectFormatError extends Error {}

/** One function symbol's body in an object. */
export interface ObjectFunction {
  /** Symbol names at the address (aliases), in symbol-table order. */
  readonly names: readonly { readonly name: string; readonly binding: 'local' | 'global' | 'weak' }[];
  readonly bytes: Uint8Array;
  /** 1 where the byte is position-dependent (relocated or rewritable by the linker). */
  readonly masked: Uint8Array;
  /** Calls and jumps into other functions: `[rel32 field offset, symbol name]`. */
  readonly calls: readonly (readonly [number, string])[];
  readonly ifunc: boolean;
  /** The object section holding it (`member:section index`) and its offset there. */
  readonly place: { readonly object: string; readonly offset: number };
}

export interface ObjectMember {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Members of a System V / GNU `ar` archive (the symbol and long-name tables excluded). */
export function archiveMembers(bytes: Uint8Array): ObjectMember[] {
  const magic = '!<arch>\n';
  if (bytes.length < 8 || new TextDecoder().decode(bytes.subarray(0, 8)) !== magic)
    throw new ObjectFormatError('Not an ar archive');
  const text = (start: number, length: number) =>
    new TextDecoder('latin1').decode(bytes.subarray(start, start + length));
  const members: ObjectMember[] = [];
  let longNames = '';
  for (let offset = 8; offset + 60 <= bytes.length; ) {
    const rawName = text(offset, 16).trimEnd();
    const size = Number.parseInt(text(offset + 48, 10).trim(), 10);
    if (text(offset + 58, 2) !== '`\n' || !Number.isSafeInteger(size) || size < 0)
      throw new ObjectFormatError(`Invalid ar member header at ${offset}`);
    const start = offset + 60;
    if (start + size > bytes.length) throw new ObjectFormatError('Truncated ar member');
    const body = bytes.subarray(start, start + size);
    if (rawName === '//') longNames = text(start, size);
    else if (rawName !== '/' && rawName !== '/SYM64/' && rawName !== '__.SYMDEF') {
      let name = rawName;
      if (/^\/\d+$/.test(rawName)) {
        const from = Number(rawName.slice(1)),
          end = longNames.indexOf('\n', from);
        name = longNames.slice(from, end < 0 ? undefined : end);
      } else if (rawName.startsWith('#1/')) {
        // BSD long name: stored at the start of the body.
        const length = Number(rawName.slice(3));
        name = text(start, length).replace(/\0+$/, '');
        members.push({ name, bytes: body.subarray(length) });
        offset = start + size + (size & 1);
        continue;
      }
      members.push({ name: name.replace(/\/$/, ''), bytes: body });
    }
    offset = start + size + (size & 1);
  }
  return members;
}

const EM_X86_64 = 62;
/** Bytes a static linker may rewrite around an x86-64 relocation, beyond its field:
 * `[before, field width, after]`. Relaxations (GOTPCRELX `mov` -> `lea`, `call *` ->
 * `addr32 call`, TLS GD/LD/IE/DESC -> LE) change opcodes next to the field. */
const X86_64_RELOCATIONS: Readonly<Record<number, readonly [number, number, number]>> = {
  1: [0, 8, 0], // R_X86_64_64
  2: [0, 4, 0], // PC32
  3: [0, 4, 0], // GOT32
  4: [0, 4, 0], // PLT32
  9: [0, 4, 0], // GOTPCREL
  10: [0, 4, 0], // 32
  11: [0, 4, 0], // 32S
  12: [0, 2, 0], // 16
  13: [0, 2, 0], // PC16
  14: [0, 1, 0], // 8
  15: [0, 1, 0], // PC8
  19: [4, 4, 8], // TLSGD: data16 lea x@tlsgd(%rip),%rdi; data16 data16 rex64 call
  20: [3, 4, 5], // TLSLD: lea x@tlsld(%rip),%rdi; call __tls_get_addr
  21: [0, 4, 0], // DTPOFF32
  22: [3, 4, 0], // GOTTPOFF: mov/add x@gottpoff(%rip) -> mov/add $x
  23: [0, 4, 0], // TPOFF32
  24: [0, 8, 0], // PC64
  25: [0, 8, 0], // GOTOFF64
  26: [0, 4, 0], // GOTPC32
  32: [0, 4, 0], // SIZE32
  33: [0, 8, 0], // SIZE64
  34: [3, 4, 0], // GOTPC32_TLSDESC: lea -> mov $x
  35: [0, 2, 0], // TLSDESC_CALL: call *(%rax) -> nop
  41: [2, 4, 0], // GOTPCRELX
  42: [3, 4, 0], // REX_GOTPCRELX
};

/** Function bodies of one ELF64 x86-64 relocatable object. */
export function objectFunctions(member: ObjectMember): ObjectFunction[] {
  const b = member.bytes;
  const fail = (message: string): never => {
    throw new ObjectFormatError(`${member.name}: ${message}`);
  };
  if (b.length < 64 || b[0] !== 0x7f || b[1] !== 0x45 || b[2] !== 0x4c || b[3] !== 0x46)
    fail('not an ELF object');
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[4] !== 2 || b[5] !== 1) fail('not ELF64 little-endian');
  if (view.getUint16(16, true) !== 1) fail('not a relocatable object (ET_REL)');
  if (view.getUint16(18, true) !== EM_X86_64) fail('not x86-64');
  const u16 = (o: number) => view.getUint16(o, true),
    u32 = (o: number) => view.getUint32(o, true),
    u64 = (o: number) => Number(view.getBigUint64(o, true)),
    i64 = (o: number) => Number(view.getBigInt64(o, true));
  const shoff = u64(40),
    shentsize = u16(58),
    shnum = u16(60);
  if (shentsize !== 64 || shoff + shnum * 64 > b.length) fail('invalid section table');
  const sections = Array.from({ length: shnum }, (_, index) => {
    const p = shoff + index * 64;
    const section = {
      type: u32(p + 4),
      flags: u64(p + 8),
      offset: u64(p + 24),
      size: u64(p + 32),
      link: u32(p + 40),
      info: u32(p + 44),
      entsize: u64(p + 56),
    };
    if (section.type !== 8 && section.offset + section.size > b.length)
      fail(`section ${index} outside the file`);
    return section;
  });
  const cstring = (table: number, at: number): string => {
    const s = sections[table];
    if (!s || at >= s.size) return '';
    let end = s.offset + at;
    while (end < s.offset + s.size && b[end] !== 0) end++;
    return new TextDecoder('latin1').decode(b.subarray(s.offset + at, end));
  };
  const symtabIndex = sections.findIndex((s) => s.type === 2);
  if (symtabIndex < 0) return [];
  const symtab = sections[symtabIndex]!;
  const symbols = Array.from({ length: Math.floor(symtab.size / 24) }, (_, index) => {
    const p = symtab.offset + index * 24,
      info = b[p + 4]!;
    return {
      name: cstring(symtab.link, u32(p)),
      type: info & 15,
      binding: info >> 4,
      section: u16(p + 6),
      value: u64(p + 8),
      size: u64(p + 16),
    };
  });
  // Function symbols by section and address; aliases share one body.
  const bodies = new Map<string, { section: number; value: number; size: number; names: ObjectFunction['names']; ifunc: boolean }>();
  const functionAt = new Map<string, string>();
  for (const symbol of symbols) {
    if ((symbol.type !== 2 && symbol.type !== 10) || !symbol.name) continue;
    const section = sections[symbol.section];
    if (!section || !(section.flags & 4) || section.type !== 1) continue; // SHF_EXECINSTR, PROGBITS
    const key = `${symbol.section}:${symbol.value}`;
    const binding = symbol.binding === 0 ? 'local' : symbol.binding === 2 ? 'weak' : 'global';
    const prior = bodies.get(key);
    if (prior) {
      bodies.set(key, {
        ...prior,
        size: Math.max(prior.size, symbol.size),
        names: [...prior.names, { name: symbol.name, binding }],
        ifunc: prior.ifunc || symbol.type === 10,
      });
    } else
      bodies.set(key, {
        section: symbol.section,
        value: symbol.value,
        size: symbol.size,
        names: [{ name: symbol.name, binding }],
        ifunc: symbol.type === 10,
      });
    if (!functionAt.has(key)) functionAt.set(key, symbol.name);
  }
  // Relocations by the section they apply to.
  const relocations = new Map<number, { offset: number; type: number; symbol: number; addend: number }[]>();
  for (const section of sections) {
    if (section.type !== 4 || section.link !== symtabIndex) continue;
    const list = relocations.get(section.info) ?? [];
    for (let p = section.offset; p + 24 <= section.offset + section.size; p += 24) {
      const info = u64(p + 8);
      list.push({
        offset: u64(p),
        type: info % 2 ** 32,
        symbol: Math.floor(info / 2 ** 32),
        addend: i64(p + 16),
      });
    }
    relocations.set(section.info, list);
  }
  const functions: ObjectFunction[] = [];
  for (const body of bodies.values()) {
    if (body.size === 0) continue;
    const section = sections[body.section]!;
    if (body.value + body.size > section.size) continue;
    const start = section.offset + body.value;
    const bytes = b.slice(start, start + body.size);
    const masked = new Uint8Array(body.size);
    const calls: [number, string][] = [];
    for (const relocation of relocations.get(body.section) ?? []) {
      const at = relocation.offset - body.value;
      if (at < 0 || at >= body.size) continue;
      const [before, width, after] = X86_64_RELOCATIONS[relocation.type] ?? [0, 4, 0];
      masked.fill(1, Math.max(0, at - before), Math.min(body.size, at + width + after));
      // A rel32 call, jump or conditional jump into a function names its callee.
      if (relocation.type !== 2 && relocation.type !== 4) continue;
      const opcode = bytes[at - 1],
        isBranch =
          opcode === 0xe8 || opcode === 0xe9 || (bytes[at - 2] === 0x0f && (opcode! & 0xf0) === 0x80);
      const symbol = symbols[relocation.symbol];
      if (!isBranch || !symbol) continue;
      let name: string | undefined;
      if (symbol.type === 3) {
        // Section-relative: the function at the target offset of that section.
        name = functionAt.get(`${symbol.section}:${relocation.addend + 4}`);
        if (symbol.section === body.section && relocation.addend + 4 === body.value) name = undefined;
      } else if (symbol.name && relocation.addend === -4) name = symbol.name;
      if (name) calls.push([at, name]);
    }
    functions.push({
      names: body.names,
      bytes,
      masked,
      calls,
      ifunc: body.ifunc,
      place: { object: `${member.name}:${body.section}`, offset: body.value },
    });
  }
  return functions;
}
