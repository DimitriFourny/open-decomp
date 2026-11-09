import type { OperationContext } from '../../core/index.js';

/** Bounds of one PDB decode. Exceeding a count bound stops that table with a diagnostic. */
export const PDB_LIMITS = {
  bytes: 128 * 1024 * 1024,
  streams: 100_000,
  /** Bytes copied out of non-contiguous stream blocks, across all streams. */
  copied: 256 * 1024 * 1024,
  typeRecords: 1_000_000,
  symbols: 2_000_000,
  rows: 500_000,
  depth: 64,
  string: 4096,
};

/** Little-endian cursor over one stream. Every read is bounds-checked against `end`. */
export class PdbReader {
  readonly view: DataView;
  constructor(
    readonly bytes: Uint8Array,
    public position = 0,
    readonly end = bytes.length,
  ) {
    if (position < 0 || end < position || end > bytes.length)
      throw new Error('Invalid PDB reader bounds');
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  need(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.end - this.position)
      throw new Error('Truncated PDB data');
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.position++);
  }

  u16(): number {
    this.need(2);
    const value = this.view.getUint16(this.position, true);
    this.position += 2;
    return value;
  }

  u32(): number {
    this.need(4);
    const value = this.view.getUint32(this.position, true);
    this.position += 4;
    return value;
  }

  i32(): number {
    this.need(4);
    const value = this.view.getInt32(this.position, true);
    this.position += 4;
    return value;
  }

  skip(size: number): void {
    this.need(size);
    this.position += size;
  }

  block(size: number): Uint8Array {
    this.need(size);
    const result = this.bytes.subarray(this.position, this.position + size);
    this.position += size;
    return result;
  }

  /** A NUL-terminated UTF-8 string; a missing terminator ends it at `end`. */
  string(): string {
    const start = this.position;
    while (this.position < this.end && this.bytes[this.position]) {
      if (this.position - start >= PDB_LIMITS.string) throw new Error('PDB string exceeds 4 KiB');
      this.position++;
    }
    const text = new TextDecoder().decode(this.bytes.subarray(start, this.position));
    if (this.position < this.end) this.position++;
    return text;
  }

  /** A CodeView numeric leaf (LF_CHAR..LF_UQUADWORD, or an immediate value below 0x8000). */
  numeric(): bigint {
    const leaf = this.u16();
    if (leaf < 0x8000) return BigInt(leaf);
    switch (leaf) {
      case 0x8000:
        this.need(1);
        return BigInt(this.view.getInt8(this.position++));
      case 0x8001: {
        this.need(2);
        const value = this.view.getInt16(this.position, true);
        this.position += 2;
        return BigInt(value);
      }
      case 0x8002:
        return BigInt(this.u16());
      case 0x8003:
        return BigInt(this.i32());
      case 0x8004:
        return BigInt(this.u32());
      case 0x8009:
      case 0x800a: {
        this.need(8);
        const value =
          leaf === 0x8009
            ? this.view.getBigInt64(this.position, true)
            : this.view.getBigUint64(this.position, true);
        this.position += 8;
        return value;
      }
      default:
        throw new Error(`Unsupported CodeView numeric leaf 0x${leaf.toString(16)}`);
    }
  }
}

const MAGIC = 'Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0';

/** Whether `bytes` start with the MSF 7.0 superblock magic of a PDB. */
export function isPdb(bytes: Uint8Array): boolean {
  return bytes.length >= 32 && [...MAGIC].every((c, i) => bytes[i] === c.charCodeAt(0));
}

/** An MSF 7.0 multi-stream file: the superblock, the stream directory and its streams. Old
 * (MSF 2.0, "JG") PDBs are refused. Streams are read lazily and cached. */
export class MsfFile {
  readonly blockSize: number;
  readonly streamCount: number;
  readonly #sizes: number[] = [];
  readonly #blocks: number[][] = [];
  readonly #cache = new Map<number, Uint8Array>();
  #copied = 0;

  constructor(
    readonly bytes: Uint8Array,
    readonly context: OperationContext,
  ) {
    if (bytes.length > PDB_LIMITS.bytes) throw new Error('PDB exceeds 128 MiB');
    if (!isPdb(bytes)) throw new Error('Not an MSF 7.0 program database (PDB)');
    const r = new PdbReader(bytes, 32);
    this.blockSize = r.u32();
    r.u32(); // free block map block
    const blockCount = r.u32(),
      directoryBytes = r.u32();
    r.u32();
    const blockMap = r.u32();
    if (![512, 1024, 2048, 4096, 8192, 16384, 32768].includes(this.blockSize))
      throw new Error(`Invalid MSF block size ${this.blockSize}`);
    if (blockCount * this.blockSize > bytes.length)
      throw new Error('MSF block count exceeds the file size');
    const directoryBlocks = Math.ceil(directoryBytes / this.blockSize);
    if (directoryBlocks * 4 > this.blockSize)
      throw new Error('MSF stream directory exceeds one block map block');
    const map = new PdbReader(this.#block(blockMap), 0);
    const indices: number[] = [];
    for (let i = 0; i < directoryBlocks; i++) indices.push(map.u32());
    const directory = new PdbReader(this.#gather(indices, directoryBytes), 0);
    this.streamCount = directory.u32();
    if (this.streamCount > PDB_LIMITS.streams) throw new Error('MSF stream count exceeds limit');
    for (let i = 0; i < this.streamCount; i++) {
      const size = directory.u32();
      // 0xffffffff marks a deleted (nil) stream.
      this.#sizes.push(size === 0xffffffff ? 0 : size);
    }
    for (let i = 0; i < this.streamCount; i++) {
      context.checkpoint(1);
      const count = Math.ceil(this.#sizes[i]! / this.blockSize),
        list: number[] = [];
      directory.need(count * 4);
      for (let n = 0; n < count; n++) list.push(directory.u32());
      this.#blocks.push(list);
    }
  }

  #block(index: number): Uint8Array {
    const start = index * this.blockSize;
    if (!Number.isSafeInteger(start) || start + this.blockSize > this.bytes.length)
      throw new Error(`MSF block ${index} is outside the file`);
    return this.bytes.subarray(start, start + this.blockSize);
  }

  #gather(indices: readonly number[], size: number): Uint8Array {
    if (!indices.length) return new Uint8Array(0);
    // Contiguous blocks (the common case for a freshly linked PDB) are viewed, not copied.
    if (indices.every((block, i) => block === indices[0]! + i)) {
      const start = indices[0]! * this.blockSize;
      if (start + size > this.bytes.length) throw new Error('MSF stream is outside the file');
      return this.bytes.subarray(start, start + size);
    }
    this.#copied += size;
    if (this.#copied > PDB_LIMITS.copied) throw new Error('PDB stream copy limit exceeded');
    const result = new Uint8Array(size);
    for (let i = 0; i < indices.length; i++) {
      this.context.checkpoint(1);
      const length = Math.min(this.blockSize, size - i * this.blockSize);
      result.set(this.#block(indices[i]!).subarray(0, length), i * this.blockSize);
    }
    return result;
  }

  /** Stream `index`, or null when it does not exist (index 0xffff means "no stream"). */
  stream(index: number): Uint8Array | null {
    if (index === 0xffff || index >= this.streamCount) return null;
    const cached = this.#cache.get(index);
    if (cached) return cached;
    const result = this.#gather(this.#blocks[index]!, this.#sizes[index]!);
    this.#cache.set(index, result);
    return result;
  }
}
