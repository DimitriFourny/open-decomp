import { checkedIndex, OperationError, U64_LIMIT } from '../../core/index.js';
// All offsets are section-relative; readers never cross their declared contribution.
export const DWARF_LIMITS = {
  dies: 100_000,
  depth: 128,
  rows: 500_000,
  steps: 2_000_000,
  string: 1_048_576,
  text: 64 * 1024 * 1024,
};
export const MAX_ADDRESS = U64_LIMIT - 1n;
export function number(value: bigint, label = 'offset'): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`${label} exceeds the safe integer range`);
  return checkedIndex(value, Number.MAX_SAFE_INTEGER);
}
/** Shared across contributions; charge decoded bytes and generated characters before allocation. */
export class DwarfTextBudget {
  constructor(public remaining = DWARF_LIMITS.text) {}

  consume(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.remaining) {
      this.remaining = 0;
      throw new OperationError({
        code: 'resource_limit',
        severity: 'error',
        message: 'DWARF aggregate text budget exceeded',
        evidence_ids: [],
      });
    }
    this.remaining -= size;
  }
}
export class DwarfReader {
  constructor(
    readonly bytes: Uint8Array,
    public position = 0,
    readonly end = bytes.length,
    readonly little = true,
  ) {
    if (
      !Number.isSafeInteger(position) ||
      !Number.isSafeInteger(end) ||
      position < 0 ||
      end < position ||
      end > bytes.length
    )
      throw new Error('Invalid reader bounds');
  }

  need(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.end - this.position)
      throw new Error('Truncated DWARF data');
  }

  uint(size: number): bigint {
    this.need(size);
    if (![1, 2, 3, 4, 8].includes(size)) throw new Error(`Unsupported integer width ${size}`);
    let value = 0n;
    for (let i = 0; i < size; i++)
      value |=
        BigInt(this.bytes[this.position + i]!) << BigInt((this.little ? i : size - i - 1) * 8);
    this.position += size;
    return value;
  }

  u8(): number {
    return Number(this.uint(1));
  }

  u16(): number {
    return Number(this.uint(2));
  }

  u32(): number {
    return Number(this.uint(4));
  }

  leb(signed = false): bigint {
    let value = 0n,
      shift = 0n;
    for (let i = 0; i < 10; i++) {
      const byte = this.u8();
      value |= BigInt(byte & 127) << shift;
      shift += 7n;
      if (!(byte & 128)) {
        if (signed && byte & 64) value -= 1n << shift;
        if (value < -(1n << 63n) || value > (signed ? (1n << 63n) - 1n : MAX_ADDRESS))
          throw new Error('LEB128 exceeds 64 bits');
        return value;
      }
    }
    throw new Error('LEB128 exceeds 10-byte limit');
  }

  nleb(): number {
    return number(this.leb(), 'LEB128 value');
  }

  block(size: number): Uint8Array {
    this.need(size);
    const result = this.bytes.subarray(this.position, this.position + size);
    this.position += size;
    return result;
  }

  string(budget?: DwarfTextBudget): string {
    const start = this.position;
    try {
      while (this.position < this.end && this.bytes[this.position]) {
        if (this.position - start >= DWARF_LIMITS.string)
          throw new Error('DWARF string exceeds 1 MiB limit');
        if (budget && this.position - start >= budget.remaining)
          budget.consume(budget.remaining + 1);
        this.position++;
      }
      this.need(1);
    } finally {
      // Even malformed strings consume their scan allowance across contributions.
      budget?.consume(this.position - start);
    }
    const result = new TextDecoder().decode(this.bytes.subarray(start, this.position));
    this.position++;
    return result;
  }

  initialLength(): { start: number; end: number; offsetSize: number } {
    const start = this.position,
      first = this.u32();
    if (first >= 0xfffffff0 && first !== 0xffffffff)
      throw new Error('Reserved DWARF initial length');
    const offsetSize = first === 0xffffffff ? 8 : 4;
    const length = first === 0xffffffff ? number(this.uint(8)) : first;
    this.need(length);
    return { start, end: this.position + length, offsetSize };
  }
}
export type DwarfSections = ReadonlyMap<string, Uint8Array>;
export function sectionReader(
  sections: DwarfSections,
  name: string,
  offset = 0,
  little = true,
): DwarfReader {
  const bytes = sections.get(name);
  if (!bytes) throw new Error(`Missing ${name} section`);
  return new DwarfReader(bytes, offset, bytes.length, little);
}
export function stringAt(
  sections: DwarfSections,
  name: string,
  offset: bigint,
  little = true,
  budget?: DwarfTextBudget,
): string {
  return sectionReader(sections, name, number(offset), little).string(budget);
}
