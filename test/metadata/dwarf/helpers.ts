import assert from 'node:assert/strict';
import { createOperationContext } from '../../../src/core/index.js';
import { parseDwarfSections } from '../../../src/metadata/dwarf/index.js';
import { selectDebugSections } from '../../../src/metadata/debug/index.js';
export const ADDRESS = 0x2000000000001000n;

export const UUID = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

export class Bytes {
  data: number[] = [];
  labels = new Map<string, number>();
  patches: { at: number; label: string }[] = [];
  byte(...values: number[]): this { this.data.push(...values); return this; }
  uint(value: number | bigint, size = 4): this {
    let n = BigInt(value);
    for (let i = 0; i < size; i++) { this.data.push(Number(n & 255n)); n >>= 8n; }
    return this;
  }
  uleb(value: number | bigint): this {
    let n = BigInt(value);
    do { const b = Number(n & 127n); n >>= 7n; this.data.push(b | (n ? 128 : 0)); } while (n);
    return this;
  }
  sleb(value: number): this {
    let n = BigInt(value);
    while (true) {
      const b = Number(n & 127n); n >>= 7n;
      const done = (n === 0n && !(b & 64)) || (n === -1n && !!(b & 64));
      this.data.push(b | (done ? 0 : 128));
      if (done) return this;
    }
  }
  string(value: string): this { this.data.push(...new TextEncoder().encode(value), 0); return this; }
  label(name: string): this { this.labels.set(name, this.data.length); return this; }
  ref(name: string): this { this.patches.push({ at: this.data.length, label: name }); return this.uint(0); }
  finish(): Uint8Array {
    const result = Uint8Array.from(this.data), view = new DataView(result.buffer);
    for (const patch of this.patches) { const offset = this.labels.get(patch.label); assert.notEqual(offset, undefined); view.setUint32(patch.at, offset!, true); }
    return result;
  }
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

export function lengthPrefixed(bytes: Uint8Array): Uint8Array { return concat(new Bytes().uint(bytes.length).finish(), bytes); }

export function abbreviation(b: Bytes, code: number, tag: number, children: boolean, attrs: [number, number, number?][]): void {
  b.uleb(code).uleb(tag).byte(children ? 1 : 0);
  for (const [name, form, constant] of attrs) { b.uleb(name).uleb(form); if (form === 0x21) b.sleb(constant!); }
  b.byte(0, 0);
}

export function macho(sections: Record<string, Uint8Array> = {}, subtype = 0, uuid = UUID): ArrayBuffer {
  const entries = Object.entries(sections), segmentSize = entries.length ? 72 + entries.length * 80 : 0;
  const commandSize = 24 + segmentSize, payloadOffset = 32 + commandSize;
  const size = payloadOffset + entries.reduce((total, [, bytes]) => total + bytes.length, 0);
  const buffer = new ArrayBuffer(size), view = new DataView(buffer), bytes = new Uint8Array(buffer);
  view.setUint32(0, 0xfeedfacf, true); view.setUint32(4, 0x100000c, true); view.setUint32(8, subtype, true);
  view.setUint32(12, entries.length ? 10 : 2, true); view.setUint32(16, entries.length ? 2 : 1, true); view.setUint32(20, commandSize, true);
  view.setUint32(32, 0x1b, true); view.setUint32(36, 24, true); bytes.set(uuid, 40);
  if (entries.length) {
    view.setUint32(56, 0x19, true); view.setUint32(60, segmentSize, true); bytes.set(new TextEncoder().encode('__DWARF'), 64);
    view.setUint32(120, entries.length, true);
    let payload = payloadOffset;
    for (let i = 0; i < entries.length; i++) {
      const [name, content] = entries[i]!, p = 128 + i * 80;
      bytes.set(new TextEncoder().encode(name), p); bytes.set(new TextEncoder().encode('__DWARF'), p + 16);
      view.setBigUint64(p + 40, BigInt(content.length), true); view.setUint32(p + 48, payload, true);
      bytes.set(content, payload); payload += content.length;
    }
  }
  return buffer;
}

export function load(sections: Record<string, Uint8Array>, targetSubtype = 0) {
  const file = new Uint8Array(macho({}, targetSubtype));
  return readDebug(file, macho(sections, targetSubtype));
}

export function lineProgram(version: 4 | 5, address = ADDRESS): Uint8Array {
  const h = new Bytes().byte(1, 1, 1, 251, 14, 13).byte(0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1);
  if (version === 4) h.byte(0).string('main.c').uleb(0).uleb(0).uleb(0).byte(0);
  else {
    h.byte(1).uleb(1).uleb(0x1f).uleb(1).uint(0);
    h.byte(3).uleb(1).uleb(0x1f).uleb(2).uleb(0xf).uleb(5).uleb(0x1e).uleb(1).uint(5).uleb(0);
    for (let i = 0; i < 16; i++) h.byte(i);
  }
  const body = new Bytes().uint(version, 2);
  if (version === 5) body.byte(8, 0);
  body.uint(h.data.length).byte(...h.data).byte(0, 9, 2).uint(address, 8);
  if (version === 5) body.byte(4).uleb(0);
  body.byte(3).sleb(9).byte(1, 2).uleb(4).byte(3).sleb(-2).byte(5).uleb(7).byte(1, 2).uleb(8).byte(0, 1, 1);
  return lengthPrefixed(body.finish());
}

export function v4Unit(name = 'sum', lineOffset = 0): { info: Uint8Array; abbrev: Uint8Array } {
  const a = new Bytes();
  abbreviation(a, 1, 0x11, true, [[3, 8], [0x1b, 8], [0x10, 0x17], [0x11, 1]]);
  abbreviation(a, 2, 0x24, false, [[3, 8], [0xb, 0xb], [0x3e, 0xb]]);
  abbreviation(a, 3, 0x13, true, [[3, 8], [0xb, 0xb]]);
  abbreviation(a, 4, 0xd, false, [[3, 8], [0x49, 0x13], [0x38, 0xf]]);
  abbreviation(a, 5, 0xf, false, [[0x49, 0x13]]);
  abbreviation(a, 6, 0x16, false, [[3, 8], [0x49, 0x13]]);
  abbreviation(a, 7, 4, true, [[3, 8], [0xb, 0xb]]);
  abbreviation(a, 8, 0x28, false, [[3, 8], [0x1c, 0xd]]);
  abbreviation(a, 9, 0x2e, true, [[3, 8], [0x49, 0x13], [0x3c, 0x19]]);
  abbreviation(a, 10, 5, false, [[3, 8], [0x49, 0x13]]);
  abbreviation(a, 11, 0x2e, false, [[0x47, 0x13], [0x11, 1], [0x12, 6]]);
  abbreviation(a, 12, 0x15, true, [[0x49, 0x13]]);
  a.byte(0);
  const b = new Bytes().uint(0).uint(4, 2).uint(0).byte(8);
  b.uleb(1).string('unit.c').string('/src').uint(lineOffset).uint(ADDRESS, 8);
  b.label('int').uleb(2).string('int').byte(4, 5);
  b.label('pair').uleb(3).string('Pair').byte(8);
  b.uleb(4).string('left').ref('int').uleb(0).uleb(4).string('right').ref('int').uleb(4).byte(0);
  b.label('pointer').uleb(5).ref('pair').uleb(6).string('PairPtr').ref('pointer');
  b.uleb(7).string('Sign').byte(4).uleb(8).string('negative').sleb(-1).byte(0);
  b.label('declaration').uleb(9).string(name).ref('int').uleb(10).string('pair').ref('pointer').byte(0);
  b.uleb(11).ref('declaration').uint(ADDRESS, 8).uint(12);
  b.uleb(12).ref('int').uleb(10).string('value').ref('int').byte(0, 0);
  const info = b.finish(); new DataView(info.buffer).setUint32(0, info.length - 4, true);
  return { info, abbrev: a.finish() };
}

export function v5Unit(): Record<string, Uint8Array> {
  const a = new Bytes();
  abbreviation(a, 1, 0x11, true, [[0x72, 0x17], [0x73, 0x17], [0x74, 0x17], [0x10, 0x17], [0x1b, 0x1f]]);
  abbreviation(a, 2, 0x24, false, [[3, 0x25], [0xb, 0x21, 4], [0x3e, 0xb]]);
  abbreviation(a, 3, 0x2e, false, [[3, 0x1a], [0x49, 0x13], [0x55, 0x23]]);
  a.byte(0);
  const b = new Bytes().uint(0).uint(5, 2).byte(1, 8).uint(0);
  b.uleb(1).uint(8).uint(8).uint(12).uint(0).uint(0);
  b.label('int').uleb(2).byte(0, 5).uleb(3).uleb(1).ref('int').uleb(0).byte(0);
  const info = b.finish(); new DataView(info.buffer).setUint32(0, info.length - 4, true);
  const strings = new Bytes().string('int').string('indexed').finish();
  const offsets = lengthPrefixed(new Bytes().uint(5, 2).uint(0, 2).uint(0).uint(4).finish());
  const addresses = lengthPrefixed(new Bytes().uint(5, 2).byte(8, 0).uint(ADDRESS, 8).finish());
  const ranges = lengthPrefixed(new Bytes().uint(5, 2).byte(8, 0).uint(1).uint(4).byte(3).uleb(0).uleb(12).byte(0).finish());
  return { __debug_info: info, __debug_abbrev: a.finish(), __debug_str: strings, __debug_str_offs: offsets, __debug_addr: addresses, __debug_rnglists: ranges, __debug_line: lineProgram(5), __debug_line_str: new Bytes().string('/src').string('main.c').finish() };
}

export function storageUnit(version: 4 | 5, listForm?: 0x17 | 0x22, expression = new Bytes().byte(0x8f).sleb(64).finish(), options: { locationBase?: number; addressBase?: number; frameList?: boolean; lexicalStart?: bigint } = {}): Record<string, Uint8Array> {
  const a = new Bytes();
  abbreviation(a, 1, 0x11, true, [[0x11, 1], [0x10, 0x17], [0x1b, 8], ...(version === 5 ? [[0x8c, 0x17], [0x73, 0x17]] as [number, number][] : [])]);
  abbreviation(a, 2, 0x24, false, [[3, 8], [0xb, 0xb], [0x3e, 0xb]]);
  abbreviation(a, 3, 0x2e, true, [[3, 8], [0x11, 1], [0x12, 6], [0x40, options.frameList ? 0x22 : 0x18]]);
  abbreviation(a, 4, 0xb, true, [[0x11, 1], [0x12, 6]]);
  abbreviation(a, 5, 0x34, false, [[3, 8], [0x49, 0x13], [2, listForm ?? 0x18]]);
  abbreviation(a, 6, 0x2e, true, [[3, 8]]);
  abbreviation(a, 7, 5, false, [[3, 8], [0x49, 0x13], [0x3a, 0xb], [0x3b, 0xb]]);
  abbreviation(a, 8, 0x1d, true, [[0x31, 0x13], [0x11, 1], [0x12, 6], [0x58, 0xb], [0x59, 0xb]]);
  abbreviation(a, 9, 5, false, [[0x31, 0x13], [2, 0x18]]);
  abbreviation(a, 10, 0x34, false, [[3, 8], [0x49, 0x13], [2, 0x18]]);
  abbreviation(a, 11, 1, true, [[0x49, 0x13]]);
  abbreviation(a, 12, 0x21, false, [[0x37, 0xf]]);
  abbreviation(a, 13, 0x13, true, [[3, 8], [0xb, 5]]);
  abbreviation(a, 14, 0xd, false, [[3, 8], [0x49, 0x13], [0x38, 0xf]]);
  abbreviation(a, 15, 0x16, false, [[3, 8], [0x49, 0x13]]);
  a.byte(0);
  const b = new Bytes().uint(0).uint(version, 2);
  if (version === 5) b.byte(1, 8).uint(0); else b.uint(0).byte(8);
  b.byte(1).uint(ADDRESS, 8).uint(0).string('/src');
  if (version === 5) b.uint(options.locationBase ?? 12).uint(options.addressBase ?? 8);
  b.label('int').byte(2).string('int').byte(4, 5);
  b.label('array').byte(11).ref('int').byte(12).uleb(32).byte(0);
  b.label('set').byte(13).string('set').uint(128, 2).byte(14).string('bits').ref('array').uleb(0).byte(0);
  b.label('fd_set').byte(15).string('fd_set').ref('set');
  b.label('abstract').byte(6).string('__darwin_fd_isset');
  b.label('fd').byte(7).string('_fd').ref('int').byte(version === 5 ? 0 : 1, 20).byte(0);
  b.label('check').byte(6).string('__darwin_check_fd_set');
  b.label('a').byte(7).string('_a').ref('int').byte(version === 5 ? 0 : 1, 21).byte(0);
  b.byte(3).string('runprogram').uint(ADDRESS, 8).uint(100);
  if (options.frameList) b.uleb(0); else b.uleb(1).byte(0x6d);
  b.byte(4).uint(options.lexicalStart ?? ADDRESS + 20n, 8).uint(60);
  b.byte(5).string('readfd').ref('fd_set');
  if (listForm === 0x17) b.uint(version === 5 ? (options.locationBase ?? 12) + 4 : 0);
  else if (listForm === 0x22) b.uleb(0);
  else b.uleb(expression.length).byte(...expression);
  b.byte(8).ref('abstract').uint(ADDRESS + 30n, 8).uint(30).byte(version === 5 ? 0 : 1, 42);
  b.byte(9).ref('fd').uleb(2).byte(0x91).sleb(-56);
  b.byte(8).ref('check').uint(ADDRESS + 40n, 8).uint(30).byte(version === 5 ? 0 : 1, 43);
  b.byte(9).ref('a').uleb(2).byte(0x91).sleb(-40).byte(0, 0, 0, 0);
  b.byte(10).string('masterpt').ref('int').uleb(9).byte(3).uint(ADDRESS + 0x1000n, 8).byte(0);
  const info = b.finish(); new DataView(info.buffer).setUint32(0, info.length - 4, true);
  return {
    __debug_info: info, __debug_abbrev: a.finish(), __debug_line: lineProgram(version),
    ...(version === 5 ? {
      __debug_line_str: new Bytes().string('/src').string('main.c').finish(),
      __debug_addr: lengthPrefixed(new Bytes().uint(5, 2).byte(8, 0).uint(ADDRESS, 8).uint(ADDRESS + 90n, 8).finish()),
    } : {}),
  };
}

export function locationContribution(entries: Bytes, offset = 4): Uint8Array {
  return lengthPrefixed(new Bytes().uint(5, 2).byte(8, 0).uint(1).uint(offset).byte(...entries.data).finish());
}
export function readDebug(target: Uint8Array, buffer: ArrayBuffer) {
 const context = createOperationContext({budget:{work:10_000_000,output_bytes:16*1024*1024}});
 const header=selectDebugSections(target,context,new Uint8Array(buffer));
 if(header.diagnostics.length) throw new Error(header.diagnostics.join(' '));
 const result=parseDwarfSections(header.sections,context,{littleEndian:header.little});
 assert.ok(result.data);
 return {uuid:header.uuid,...result.data};
}
