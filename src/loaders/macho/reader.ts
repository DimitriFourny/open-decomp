import { OperationError, checkedEnd, type ImmutableBytes, type OperationContext, type Diagnostic } from '../../core/index.js';

export class MachOError extends OperationError {
  constructor(code: Diagnostic['code'], message: string) {
    super({ code, severity: 'error', message, evidence_ids: [] });
    this.name = 'MachOError';
  }
}
export function malformed(message: string): never { throw new MachOError('malformed_image', message); }
export function safe(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) malformed('File offset/count exceeds safe integer range');
  return Number(value);
}
export function vmEnd(address: bigint, size: bigint): bigint {
  try { return checkedEnd(address, size); } catch { return malformed('Virtual range overflows 64 bits'); }
}
export class Reader {
  constructor(readonly bytes: ImmutableBytes, readonly base: bigint, readonly size: number, readonly context: OperationContext, readonly little = true) {
    this.range(0, size);
    if (base < 0n || base + BigInt(size) > BigInt(bytes.length)) malformed('Slice outside container');
  }
  range(p: number, n: number, end = this.size): void {
    if (!Number.isSafeInteger(p) || !Number.isSafeInteger(n) || p < 0 || n < 0 || p > end || n > end - p || end > this.size) malformed('Truncated or out-of-range Mach-O bytes');
  }
  byte(p: number): number { this.range(p, 1); return this.bytes.at(safe(this.base) + p); }
  u16(p: number): number { this.range(p, 2); return this.little ? this.byte(p) | this.byte(p + 1) << 8 : this.byte(p) << 8 | this.byte(p + 1); }
  u32(p: number): number { this.range(p, 4); return this.bytes.u32(this.base + BigInt(p), this.little); }
  u64(p: number): bigint { this.range(p, 8); return this.bytes.u64(this.base + BigInt(p), this.little); }
  fixed(p: number, n: number): string {
    this.range(p, n); let end = p;
    while (end < p + n && this.byte(end)) end++;
    return new TextDecoder().decode(this.bytes.read(this.base + BigInt(p), end - p));
  }
  string(p: number, end: number): { text: string; next: number } {
    this.range(p, 0, end); const start = p;
    while (p < end && p - start <= 8192) {
      this.context.checkpoint(1);
      if (this.byte(p++) === 0) {
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(this.bytes.read(this.base + BigInt(start), p - start - 1)); }
        catch { return malformed('Invalid UTF-8 metadata string'); }
        return { text, next: p };
      }
    }
    return malformed('Unterminated or oversized metadata string');
  }
}
export class Cursor {
  constructor(readonly r: Reader, public p: number, readonly end: number) { r.range(p, end - p); }
  byte(): number { this.r.context.checkpoint(1); this.r.range(this.p, 1, this.end); return this.r.byte(this.p++); }
  leb(signed = false): bigint {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      const b = this.byte();
      if (i === 9 && (signed ? b !== 0 && b !== 0x7f : (b & 0xfe) !== 0)) malformed('LEB128 exceeds 64 bits');
      value |= BigInt(b & 127) << BigInt(i * 7);
      if (!(b & 128)) return signed && (b & 64) ? value - (1n << BigInt((i + 1) * 7)) : value;
    }
    return malformed('Unterminated LEB128');
  }
  string(): string { const result = this.r.string(this.p, this.end); this.p = result.next; return result.text; }
  rawString(): string {
    let value = '';
    while (true) {
      const b = this.byte();
      if (!b) return value;
      if (value.length >= 8192) malformed('Oversized trie edge');
      value += String.fromCharCode(b);
    }
  }
}
export interface Payload { readonly offset: number; readonly size: number }
export interface Segment { readonly id: string; readonly name: string; readonly va: bigint; readonly size: bigint; readonly offset: number; readonly fileSize: number; readonly protection: number }
export interface RawSection { readonly id: string; readonly name: string; readonly va: bigint; readonly size: bigint; readonly offset: number; readonly flags: number; readonly first: number; readonly stride: number; readonly relocOffset: number; readonly relocCount: number; readonly evidence: readonly string[] }
