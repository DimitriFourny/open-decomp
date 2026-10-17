// SPDX-License-Identifier: MIT
import {
  OperationError,
  checkedEnd,
  type Address,
  type Diagnostic,
  type ImmutableBytes,
  type OperationContext,
} from '../../core/index.js';

export class ELFLoadError extends OperationError {
  constructor(code: Diagnostic['code'], message: string, address?: Address) {
    super({ code, severity: 'error', message, evidence_ids: [], ...(address ? { address } : {}) });
    this.name = 'ELFLoadError';
  }
}
export const MAX_RECORDS = 100_000;
export interface ELFHeader {
  readonly type: number;
  readonly machine: number;
  readonly osabi: number;
  readonly entry: bigint;
  readonly phoff: bigint;
  readonly shoff: bigint;
  readonly phnum: number;
  readonly shnum: number;
  readonly shstrndx: number;
}
export class Reader {
  private records = 0;
  constructor(
    readonly bytes: ImmutableBytes,
    readonly image: string,
    readonly context: OperationContext,
  ) {}
  address(space: Address['space'], value: bigint): Address {
    return { image_id: this.image, space, value };
  }
  fail(message: string, offset?: bigint): never {
    throw new ELFLoadError(
      'malformed_image',
      message,
      offset === undefined ? undefined : this.address('file', offset),
    );
  }
  work(units = 1): void {
    if (this.context.signal.aborted)
      throw new ELFLoadError('cancelled', 'ELF inspection cancelled');
    this.context.checkpoint(units);
  }
  bounds(offset: bigint, size: bigint): void {
    if (offset < 0n || size < 0n || offset + size > BigInt(this.bytes.length))
      this.fail('ELF file range exceeds container', offset < 0n ? undefined : offset);
  }
  end(start: bigint, size: bigint): bigint {
    try {
      return checkedEnd(start, size);
    } catch {
      return this.fail('ELF address range overflows uint64');
    }
  }
  u8(p: bigint): number {
    this.work();
    this.bounds(p, 1n);
    return this.bytes.at(Number(p));
  }
  u16(p: bigint): number {
    this.bounds(p, 2n);
    return this.u8(p) + 256 * this.u8(p + 1n);
  }
  u32(p: bigint): number {
    this.work();
    this.bounds(p, 4n);
    return this.bytes.u32(p);
  }
  u64(p: bigint): bigint {
    this.work();
    this.bounds(p, 8n);
    return this.bytes.u64(p);
  }
  signed(p: bigint, width: number): bigint {
    const value = width === 64 ? this.u64(p) : BigInt(this.u32(p));
    return BigInt.asIntN(width, value);
  }
  table(p: bigint, count: bigint, stride: bigint): number {
    if (stride <= 0n) this.fail('ELF table has zero entry size', p);
    this.bounds(p, count * stride);
    if (count > BigInt(MAX_RECORDS - this.records))
      throw new ELFLoadError(
        'resource_limit',
        'ELF metadata exceeds 100000 records',
        this.address('file', p),
      );
    this.records += Number(count);
    this.work(Number(count));
    return Number(count);
  }
  string(p: bigint, end: bigint): string {
    this.bounds(p, 0n);
    this.bounds(end, 0n);
    let value = '';
    for (let i = 0; i <= 4096; i++) {
      if (p + BigInt(i) >= end) this.fail('Unterminated ELF string', p);
      const c = this.u8(p + BigInt(i));
      if (!c) return value;
      if (i === 4096)
        throw new ELFLoadError(
          'resource_limit',
          'ELF string exceeds 4096 bytes',
          this.address('file', p),
        );
      // ELF names are byte strings; preserve bytes without lossy UTF-8 replacement.
      value += String.fromCharCode(c);
    }
    return value;
  }
  identification(): { supported: boolean; architecture: string; reason: string } {
    this.work();
    if (this.bytes.length > 128 * 1024 * 1024)
      throw new ELFLoadError('resource_limit', 'ELF container exceeds 128 MiB');
    this.bounds(0n, 16n);
    if (this.u32(0n) !== 0x464c457f)
      throw new ELFLoadError('unsupported_target', 'Missing ELF magic');
    const cls = this.u8(4n),
      endian = this.u8(5n),
      version = this.u8(6n),
      osabi = this.u8(7n);
    if (version !== 1) this.fail('Invalid ELF identification version', 6n);
    if (cls !== 2 || endian !== 1)
      return {
        supported: false,
        architecture: 'unknown',
        reason: 'Only ELF64 little-endian images are supported',
      };
    this.bounds(0n, 64n);
    const machine = this.u16(18n),
      type = this.u16(16n);
    const supported = machine === 62 && (type === 2 || type === 3) && (osabi === 0 || osabi === 3);
    return {
      supported,
      architecture: machine === 62 ? 'x86_64' : `machine_${machine}`,
      reason: supported
        ? ''
        : `Unsupported ELF machine ${machine}, type ${type}, OSABI ${osabi}; require EM_X86_64 ET_EXEC/ET_DYN System V/Linux`,
    };
  }
  basic(): ELFHeader {
    if (this.u32(20n) !== 1 || this.u16(52n) !== 64)
      this.fail('Invalid ELF64 header version or size');
    const phoff = this.u64(32n),
      shoff = this.u64(40n),
      phnum = this.u16(56n),
      shnum = this.u16(60n),
      shstrndx = this.u16(62n);
    if (phnum === 0xffff || (shoff !== 0n && shnum === 0) || shstrndx === 0xffff)
      throw new ELFLoadError(
        'unsupported_target',
        'ELF extended table counts/indexes are unsupported',
      );
    if (shoff === 0n && shnum === 0)
      throw new ELFLoadError(
        'unsupported_target',
        'Sectionless ELF images are outside the supported subset',
      );
    if (!phnum || !phoff || !shnum || !shoff || this.u16(54n) !== 56 || this.u16(58n) !== 64)
      this.fail('Missing or invalid ELF program/section table');
    if (phoff < 64n || shoff < 64n || shstrndx >= shnum)
      this.fail('Invalid ELF table offset or section-name index');
    this.table(phoff, BigInt(phnum), 56n);
    this.table(shoff, BigInt(shnum), 64n);
    if (phoff < shoff + BigInt(shnum) * 64n && shoff < phoff + BigInt(phnum) * 56n)
      this.fail('ELF program and section tables overlap');
    return {
      type: this.u16(16n),
      machine: this.u16(18n),
      osabi: this.u8(7n),
      entry: this.u64(24n),
      phoff,
      shoff,
      phnum,
      shnum,
      shstrndx,
    };
  }
}
