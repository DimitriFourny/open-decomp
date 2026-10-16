// SPDX-License-Identifier: MIT
// Trusted fixture-only reader, independent of the production loader and decoder.
import { formatHexU64 as hex } from '../../src/core/integers.js';

export function inspectELF(bytes: Buffer) {
  if (bytes.toString('hex', 0, 6) !== '7f454c460201' || bytes.readUInt16LE(18) !== 62) throw new Error('Expected little-endian ELF64 x86-64 fixture');
  const number = (offset: number) => {
    const value = bytes.readBigUInt64LE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Fixture field exceeds exact integer range');
    return Number(value);
  };
  const string = (offset: number) => {
    const end = bytes.indexOf(0, offset);
    if (end < offset) throw new Error('Unterminated fixture string');
    return bytes.toString('utf8', offset, end);
  };
  const mappings = [];
  for (let i = 0; i < bytes.readUInt16LE(56); i++) {
    const p = number(32) + i * bytes.readUInt16LE(54);
    if (bytes.readUInt32LE(p) !== 1) continue;
    mappings.push({ name: `PT_LOAD[${i}]`, address: hex(bytes.readBigUInt64LE(p + 16)), virtualSize: number(p + 40), fileOffset: number(p + 8), fileSize: number(p + 32), flags: bytes.readUInt32LE(p + 4) });
  }
  const sections = Array.from({ length: bytes.readUInt16LE(60) }, (_, i) => {
    const s = number(40) + i * bytes.readUInt16LE(58);
    return { nameOffset: bytes.readUInt32LE(s), type: bytes.readUInt32LE(s + 4), flags: number(s + 8), address: bytes.readBigUInt64LE(s + 16), fileOffset: number(s + 24), size: number(s + 32), link: bytes.readUInt32LE(s + 40), entrySize: number(s + 56) };
  });
  const names = sections[bytes.readUInt16LE(62)];
  if (!names) throw new Error('Missing fixture section names');
  const symbols: string[] = [], imports = new Set<string>(), exports = new Set<string>();
  const functions = new Map<string, { name: string; address: string; fileOffset: number; size: number }>();
  for (const table of sections.filter(s => s.type === 2 || s.type === 11)) {
    const strings = sections[table.link];
    if (!strings || table.entrySize !== 24) throw new Error('Invalid fixture symbol table');
    for (let s = table.fileOffset; s < table.fileOffset + table.size; s += table.entrySize) {
      const name = string(strings.fileOffset + bytes.readUInt32LE(s)), info = bytes[s + 4]!, visibility = bytes[s + 5]! & 3;
      const section = bytes.readUInt16LE(s + 6), value = bytes.readBigUInt64LE(s + 8), size = number(s + 16);
      if (!name) continue;
      if (table.type === 2) symbols.push(name);
      if (table.type === 11 && (info >> 4) !== 0) {
        if (section === 0) imports.add(name);
        else if (visibility === 0 || visibility === 3) exports.add(name);
      }
      const owner = sections[section];
      if ((info & 15) === 2 && size && owner && (owner.flags & 4)) functions.set(name, { name, address: hex(value), fileOffset: owner.fileOffset + Number(value - owner.address), size });
    }
  }
  const needed: string[] = [];
  for (const dynamic of sections.filter(s => s.type === 6)) {
    const strings = sections[dynamic.link];
    if (!strings) throw new Error('Missing dynamic strings');
    for (let d = dynamic.fileOffset; d < dynamic.fileOffset + dynamic.size; d += 16) {
      const tag = bytes.readBigInt64LE(d);
      if (tag === 0n) break;
      if (tag === 1n) needed.push(string(strings.fileOffset + number(d + 8)));
    }
  }
  const entry = bytes.readBigUInt64LE(24);
  return {
    format: 'elf' as const, architecture: 'x86_64' as const, abi: 'sysv-amd64' as const,
    kind: bytes.readUInt16LE(16) === 2 ? 'executable' as const : 'library' as const,
    imageBase: hex(mappings.reduce((min, m) => BigInt(m.address) < min ? BigInt(m.address) : min, BigInt(mappings[0]?.address ?? 0))),
    entryAddress: entry === 0n ? null : hex(entry), mappings,
    sections: sections.map(s => ({ name: string(names.fileOffset + s.nameOffset), type: s.type, address: hex(s.address), size: s.size, fileOffset: s.fileOffset, flags: s.flags })),
    functions: [...functions.values()].sort((a, b) => a.fileOffset - b.fileOffset),
    symbols: [...new Set(symbols)].sort(), imports: [...imports].sort(), exports: [...exports].sort(), needed: needed.sort(),
  };
}
