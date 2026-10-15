import { OperationError } from '../../core/index.js';
import type { DebugLocation, DebugLocationEntry, DebugRange } from './model.js';
import { DwarfReader, MAX_ADDRESS, number } from './reader.js';

interface LocationContext {
  addressSize: number;
  little: boolean;
  indexedAddress: (index: bigint) => bigint;
  spend: () => void;
  diagnose: (message: string) => void;
}

/** Recognize one complete storage description, never evaluate arbitrary DWARF code. */
export function decodeLocation(bytes: Uint8Array, context: LocationContext): DebugLocation | undefined {
  if (!bytes.length) return undefined; // An empty expression explicitly means unavailable.
  if (bytes.length > 1024) throw new Error('DWARF location expression exceeds 1024 bytes');
  context.spend();
  const r = new DwarfReader(bytes, 0, bytes.length, context.little), opcode = r.u8();
  let result: DebugLocation;
  if (opcode >= 0x50 && opcode <= 0x6f) result = { kind: 'register', register: opcode - 0x50 };
  else if (opcode >= 0x70 && opcode <= 0x8f) result = { kind: 'register-offset', register: opcode - 0x70, offset: r.leb(true) };
  else if (opcode === 0x90) result = { kind: 'register', register: r.nleb() };
  else if (opcode === 0x91) result = { kind: 'frame-offset', offset: r.leb(true) };
  else if (opcode === 0x92) result = { kind: 'register-offset', register: r.nleb(), offset: r.leb(true) };
  else if (opcode === 0x03) result = { kind: 'address', address: r.uint(context.addressSize) };
  else if (opcode === 0xa1) result = { kind: 'address', address: context.indexedAddress(r.leb()) };
  else throw new Error(`Unsupported DWARF location opcode 0x${opcode.toString(16)}`);
  if (r.position !== r.end) throw new Error(`Unsupported compound DWARF location expression after opcode 0x${opcode.toString(16)}`);
  return result;
}

export function normalizeRanges(ranges: readonly DebugRange[], spend: () => void): DebugRange[] {
  const sorted = [...ranges].sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0), result: DebugRange[] = [];
  for (const range of sorted) {
    spend();
    if (range.start < 0n || range.end < range.start || range.end > MAX_ADDRESS) throw new Error('Invalid DWARF location address range');
    if (range.start === range.end) continue;
    const last = result[result.length - 1];
    if (last && range.start <= last.end) { if (range.end > last.end) last.end = range.end; }
    else result.push({ ...range });
  }
  return result;
}

/** Inputs are normalized; an empty scope never means global validity. */
export function intersectRanges(a: readonly DebugRange[], b: readonly DebugRange[], spend: () => void): DebugRange[] {
  const result: DebugRange[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    spend();
    const start = a[i]!.start > b[j]!.start ? a[i]!.start : b[j]!.start, end = a[i]!.end < b[j]!.end ? a[i]!.end : b[j]!.end;
    if (start < end) result.push({ start, end });
    if (a[i]!.end < b[j]!.end) i++; else j++;
  }
  return result;
}

/** Decode v2-v4 .debug_loc or one bounded v5 .debug_loclists contribution. */
export function readLocationList(r: DwarfReader, version: number, base: bigint, scope: DebugRange[] | undefined, context: LocationContext): DebugLocationEntry[] {
  const result: DebugLocationEntry[] = [], covered: DebugRange[] = [];
  let defaultLocation: DebugLocation | undefined, hasDefault = false;
  const decode = (bytes: Uint8Array) => {
    try { return decodeLocation(bytes, context); }
    catch (error) { if (error instanceof OperationError) throw error; context.diagnose(String(error)); return undefined; }
  };
  const expression = () => r.block(version < 5 ? r.u16() : r.nleb());
  const add = (start: bigint, end: bigint) => {
    if (start < 0n || end < start || end > ((1n << BigInt(context.addressSize * 8)) - 1n)) throw new Error('Invalid DWARF location-list range');
    const location = decode(expression());
    if (start === end) return;
    covered.push({ start, end });
    const ranges = scope === undefined ? [{ start, end }] : intersectRanges([{ start, end }], scope, context.spend);
    if (location && ranges.length) result.push({ ranges, location });
  };
  const finish = () => {
    const occupied = normalizeRanges(covered, context.spend);
    // Overlapping entries are ambiguous even if one expression is unsupported.
    const sorted = [...covered].sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
    for (let i = 1; i < sorted.length; i++) if (sorted[i]!.start < sorted[i - 1]!.end) throw new Error('Overlapping DWARF location-list entries');
    if (defaultLocation) {
      if (scope === undefined) {
        if (occupied.length) context.diagnose('Unbounded DWARF default location cannot be represented safely');
        else result.push({ ranges: [], location: defaultLocation });
      } else {
        const remaining: DebugRange[] = [];
        let j = 0;
        for (const range of scope) {
          let start = range.start;
          while (j < occupied.length && occupied[j]!.end <= start) { context.spend(); j++; }
          let k = j;
          while (k < occupied.length && occupied[k]!.start < range.end) {
            context.spend();
            if (occupied[k]!.start > start) remaining.push({ start, end: occupied[k]!.start });
            if (occupied[k]!.end > start) start = occupied[k]!.end;
            k++;
          }
          if (start < range.end) remaining.push({ start, end: range.end });
        }
        if (remaining.length) result.push({ ranges: remaining, location: defaultLocation });
      }
    }
    return result;
  };
  for (let i = 0; i < 100_000; i++) {
    context.spend();
    if (version < 5) {
      const start = r.uint(context.addressSize), end = r.uint(context.addressSize);
      if (!start && !end) return finish();
      if (start === (1n << BigInt(context.addressSize * 8)) - 1n) base = end;
      else add(base + start, base + end);
      continue;
    }
    const kind = r.u8();
    if (kind === 0) return finish();
    if (kind === 1) base = context.indexedAddress(r.leb());
    else if (kind === 2) { const start = context.indexedAddress(r.leb()); add(start, context.indexedAddress(r.leb())); }
    else if (kind === 3) { const start = context.indexedAddress(r.leb()); add(start, start + r.leb()); }
    else if (kind === 4) { const start = r.leb(); add(base + start, base + r.leb()); }
    else if (kind === 5) {
      if (hasDefault) throw new Error('Duplicate DWARF default location');
      hasDefault = true; defaultLocation = decode(expression());
    } else if (kind === 6) base = r.uint(context.addressSize);
    else if (kind === 7) { const start = r.uint(context.addressSize); add(start, r.uint(context.addressSize)); }
    else if (kind === 8) { const start = r.uint(context.addressSize); add(start, start + r.leb()); }
    else throw new Error(`Unsupported DWARF location-list opcode 0x${kind.toString(16)}`);
  }
  throw new Error('DWARF location-list entry limit exceeded or missing terminator');
}

/** Constant member displacement only; no memory reads or general expression evaluator. */
export function memberOffset(bytes: Uint8Array, little: boolean): number {
  const r = new DwarfReader(bytes, 0, bytes.length, little), opcode = r.u8();
  if (opcode !== 0x23) throw new Error(`Unsupported DWARF member location opcode 0x${opcode.toString(16)}`);
  const offset = number(r.leb(), 'member offset');
  if (r.position !== r.end) throw new Error('Unsupported compound DWARF member location expression');
  return offset;
}
