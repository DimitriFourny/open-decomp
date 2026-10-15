// SPDX-License-Identifier: MIT
// Fixture-only metadata reader; not the production loader or a hostile-input API.
import { formatHexU64 as hex } from '../../src/core/integers.js';
export interface Mapping { name: string; address: string; virtualSize: number; fileOffset: number; fileSize: number }
export interface FunctionRange { name: string; address: string; fileOffset: number; size: number }
export interface ImageFacts {
  format: 'macho' | 'pe'; architecture: 'arm64' | 'x86_64'; kind: 'executable' | 'library';
  imageBase: string; entryAddress: string | null; mappings: Mapping[]; functions: FunctionRange[];
  symbols: string[]; imports: string[]; exports: string[]; directories: { index: number; rva: number; size: number }[];
}
function cstring(b: Buffer, offset: number): string {
  const end = b.indexOf(0, offset);
  if (end < offset) throw new Error('Unterminated fixture string');
  return b.toString('utf8', offset, end);
}
export function inspectMachO(b: Buffer): ImageFacts {
  if (b.readUInt32LE(0) !== 0xfeedfacf) throw new Error('Expected thin Mach-O');
  const cpu = b.readUInt32LE(4), filetype = b.readUInt32LE(12);
  const mappings: Mapping[] = [], symbols: string[] = [], imports: string[] = [], functions: FunctionRange[] = [];
  const textSections = new Set<number>();
  let textAddress = 0n, textSize = 0n;
  let command = 32, sectionIndex = 1, symoff = 0, nsyms = 0, stroff = 0, entryOffset: bigint | null = null;
  let exportOffset = 0, exportSize = 0;
  for (let n = 0; n < b.readUInt32LE(16); n++) {
    const kind = b.readUInt32LE(command), size = b.readUInt32LE(command + 4);
    if (size < 8 || command + size > b.length) throw new Error('Invalid fixture command');
    if (kind === 0x19) {
      const name = b.toString('ascii', command + 8, command + 24).replace(/\0.*$/s, '');
      mappings.push({ name, address: hex(b.readBigUInt64LE(command + 24)), virtualSize: Number(b.readBigUInt64LE(command + 32)), fileOffset: Number(b.readBigUInt64LE(command + 40)), fileSize: Number(b.readBigUInt64LE(command + 48)) });
      for (let i = 0; i < b.readUInt32LE(command + 64); i++, sectionIndex++) {
        const s = command + 72 + i * 80;
        if (b.toString('ascii', s, s + 16).replace(/\0.*$/s, '') === '__text') {
          textSections.add(sectionIndex);
          textAddress = b.readBigUInt64LE(s + 32);
          textSize = b.readBigUInt64LE(s + 40);
        }
      }
    } else if (kind === 2) { symoff = b.readUInt32LE(command + 8); nsyms = b.readUInt32LE(command + 12); stroff = b.readUInt32LE(command + 16); }
    else if (kind === 0x80000028) entryOffset = b.readBigUInt64LE(command + 8);
    else if (kind === 0x80000033) { exportOffset=b.readUInt32LE(command+8); exportSize=b.readUInt32LE(command+12); }
    else if (kind === 0x80000022) { exportOffset=b.readUInt32LE(command+40); exportSize=b.readUInt32LE(command+44); }
    command += size;
  }
  for (let n = 0; n < nsyms; n++) {
    const s = symoff + 16*n, type = b[s + 4]!, section = b[s + 5]!;
    if ((type & 0xe0) !== 0) continue;
    const name = cstring(b, stroff + b.readUInt32LE(s));
    symbols.push(name);
    if ((type & 0x0e) === 0) { imports.push(name); continue; }
    const address = b.readBigUInt64LE(s + 8);
    if (!textSections.has(section) || address < textAddress || address >= textAddress + textSize) continue;
    const mapping = mappings.find(m => address >= BigInt(m.address) && address < BigInt(m.address) + BigInt(m.fileSize));
    if (mapping) functions.push({ name, address: hex(address), fileOffset: mapping.fileOffset + Number(address - BigInt(mapping.address)), size: 0 });
  }
  functions.sort((a,b) => a.fileOffset - b.fileOffset || a.name.localeCompare(b.name));
  // Compiler text symbols have no sizes in nlist; bound the final function to __text, not constants/unwind data.
  let textEnd = 0;
  command = 32;
  for (let n = 0; n < b.readUInt32LE(16); n++) {
    if (b.readUInt32LE(command) === 0x19) for (let i = 0; i < b.readUInt32LE(command + 64); i++) {
      const s = command + 72 + i*80;
      if (b.toString('ascii', s, s+16).replace(/\0.*$/s, '') === '__text') textEnd = b.readUInt32LE(s+48) + Number(b.readBigUInt64LE(s+40));
    }
    command += b.readUInt32LE(command+4);
  }
  functions.forEach((f,i) => { f.size = (functions[i+1]?.fileOffset ?? textEnd) - f.fileOffset; });
  const text = mappings.find(m => m.name === '__TEXT');
  if (!text) throw new Error('Missing text mapping');
  const exports: string[] = [];
  if(exportSize) {
    const trie=b.subarray(exportOffset,exportOffset+exportSize), active=new Set<number>();
    function uleb(cursor:{offset:number}):number {
      let value=0n,shift=0n;
      for(;;) {
        const byte=trie[cursor.offset++];
        if(byte===undefined || shift>63n)throw new Error('Invalid fixture export ULEB');
        value|=BigInt(byte&127)<<shift;
        if(!(byte&128))return Number(value);
        shift+=7n;
      }
    }
    function visit(offset:number,prefix:string):void {
      if(active.has(offset))throw new Error('Cyclic fixture export trie');
      active.add(offset);
      const cursor={offset},terminalSize=uleb(cursor);
      if(terminalSize)exports.push(prefix);
      cursor.offset+=terminalSize;
      const count=trie[cursor.offset++];
      if(count===undefined)throw new Error('Truncated fixture export trie');
      for(let i=0;i<count;i++) {
        const edge=cstring(trie,cursor.offset);cursor.offset+=Buffer.byteLength(edge)+1;
        visit(uleb(cursor),prefix+edge);
      }
      active.delete(offset);
    }
    visit(0,'');
  }
  return { format: 'macho', architecture: cpu === 0x100000c ? 'arm64' : 'x86_64', kind: filetype === 6 ? 'library' : 'executable', imageBase: text.address, entryAddress: entryOffset === null ? null : hex(BigInt(text.address) + entryOffset), mappings, functions, symbols: symbols.sort(), imports: imports.sort(), exports: exports.sort(), directories: [] };
}
export function inspectPE(b: Buffer): ImageFacts {
  const p = b.readUInt32LE(0x3c), optional = p+24, base = b.readBigUInt64LE(optional+24);
  if (b.toString('ascii',p,p+4) !== 'PE\0\0' || b.readUInt16LE(optional) !== 0x20b) throw new Error('Expected PE32+');
  const mappings: Mapping[] = [], directories: ImageFacts['directories'] = [], imports: string[] = [], exports: string[] = [], functions: FunctionRange[] = [];
  const sections = optional + b.readUInt16LE(p+20);
  const symbolTable = b.readUInt32LE(p+12), symbolCount = b.readUInt32LE(p+16), strings = symbolTable+symbolCount*18;
  const symbols: string[] = [];
  for (let i=0;i<symbolCount;i++) {
    const s=symbolTable+i*18;
    symbols.push(b.readUInt32LE(s)===0 ? cstring(b,strings+b.readUInt32LE(s+4)) : b.toString('ascii',s,s+8).replace(/\0.*$/s,''));
    i+=b[s+17]!;
  }
  for (let i = 0; i < b.readUInt16LE(p+6); i++) {
    const s = sections+i*40;
    const rawName = b.toString('ascii',s,s+8).replace(/\0.*$/s,'');
    const name = /^\/\d+$/.test(rawName) ? cstring(b,strings+Number(rawName.slice(1))) : rawName;
    mappings.push({ name, address: hex(base+BigInt(b.readUInt32LE(s+12))), virtualSize: b.readUInt32LE(s+8), fileOffset: b.readUInt32LE(s+20), fileSize: b.readUInt32LE(s+16) });
  }
  const offset = (rva: number): number => {
    const va = base+BigInt(rva), m = mappings.find(m => va >= BigInt(m.address) && va < BigInt(m.address)+BigInt(m.fileSize));
    if (!m) throw new Error(`Unmapped fixture RVA ${rva}`);
    return m.fileOffset+Number(va-BigInt(m.address));
  };
  for (let i = 0; i < b.readUInt32LE(optional+108); i++) {
    const d = optional+112+i*8;
    directories.push({ index: i, rva: b.readUInt32LE(d), size: b.readUInt32LE(d+4) });
  }
  const imp = directories[1];
  if (imp?.rva) for (let d = offset(imp.rva); b.readUInt32LE(d+12) !== 0; d+=20) {
    const dll = cstring(b, offset(b.readUInt32LE(d+12)));
    for (let t = offset(b.readUInt32LE(d) || b.readUInt32LE(d+16)); b.readBigUInt64LE(t) !== 0n; t+=8) {
      const value = b.readBigUInt64LE(t);
      imports.push(`${dll}!${value >> 63n ? `#${value & 0xffffn}` : cstring(b,offset(Number(value))+2)}`);
    }
  }
  const exp = directories[0];
  if (exp?.rva) {
    const e = offset(exp.rva), addresses = offset(b.readUInt32LE(e+28)), names = offset(b.readUInt32LE(e+32)), ordinals = offset(b.readUInt32LE(e+36));
    for (let i = 0; i < b.readUInt32LE(e+24); i++) {
      const name = cstring(b,offset(b.readUInt32LE(names+i*4))), ordinal = b.readUInt16LE(ordinals+i*2), rva = b.readUInt32LE(addresses+ordinal*4);
      exports.push(name);
      const m = mappings.find(m => m.name === '.text');
      if (m && base+BigInt(rva) >= BigInt(m.address) && base+BigInt(rva) < BigInt(m.address)+BigInt(m.virtualSize)) functions.push({ name, address: hex(base+BigInt(rva)), fileOffset: offset(rva), size: 0 });
    }
  }
  functions.sort((a,b) => a.fileOffset-b.fileOffset);
  const text = mappings.find(m => m.name === '.text');
  functions.forEach((f,i) => { f.size = (functions[i+1]?.fileOffset ?? ((text?.fileOffset ?? 0)+(text?.virtualSize ?? 0)))-f.fileOffset; });
  const entry = b.readUInt32LE(optional+16);
  return { format:'pe', architecture:'x86_64', kind: b.readUInt16LE(p+22)&0x2000 ? 'library':'executable', imageBase:hex(base), entryAddress:entry ? hex(base+BigInt(entry)):null, mappings, functions, symbols:symbols.sort(), imports:imports.sort(), exports:exports.sort(), directories };
}
