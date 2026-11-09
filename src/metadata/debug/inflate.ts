/** Bounded zlib stream decoder (RFC 1950 wrapper around RFC 1951 deflate) for
 * SHF_COMPRESSED and `.zdebug_*` ELF debug sections. The output size is declared
 * by the section header and enforced exactly; the Adler-32 trailer is verified.
 * Synchronous and dependency-free so it behaves identically in Node and browsers.
 * Decoding follows the canonical-Huffman scheme of zlib's reference `puff.c`. */

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huffman {
  counts: Uint16Array;
  symbols: Uint16Array;
}

function huffman(lengths: ArrayLike<number>, count: number, incompleteAllowed: boolean): Huffman {
  const counts = new Uint16Array(16),
    symbols = new Uint16Array(count);
  for (let symbol = 0; symbol < count; symbol++) counts[lengths[symbol]!]!++;
  let left = 1;
  for (let length = 1; length < 16; length++) {
    left = left * 2 - counts[length]!;
    if (left < 0) throw new Error('Oversubscribed deflate Huffman code');
  }
  // Only a single-code distance tree may be incomplete (RFC 1951 3.2.7).
  if (left > 0 && !incompleteAllowed && count - counts[0]! !== 1)
    throw new Error('Incomplete deflate Huffman code');
  const offsets = new Uint16Array(16);
  for (let length = 1; length < 15; length++)
    offsets[length + 1] = offsets[length]! + counts[length]!;
  for (let symbol = 0; symbol < count; symbol++)
    if (lengths[symbol]) symbols[offsets[lengths[symbol]!]!++] = symbol;
  return { counts, symbols };
}

let fixed: { literal: Huffman; distance: Huffman } | undefined;
function fixedCodes(): { literal: Huffman; distance: Huffman } {
  if (!fixed) {
    const lengths = new Uint8Array(288);
    lengths.fill(8, 0, 144);
    lengths.fill(9, 144, 256);
    lengths.fill(7, 256, 280);
    lengths.fill(8, 280, 288);
    fixed = {
      literal: huffman(lengths, 288, true),
      distance: huffman(new Uint8Array(30).fill(5), 30, true),
    };
  }
  return fixed;
}

/** Inflates `input` (a zlib stream) to exactly `size` bytes. `checkpoint` runs once per
 * 64 KiB of output so callers can honour cancellation and work budgets. */
export function inflateZlib(input: Uint8Array, size: number, checkpoint: () => void): Uint8Array {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid decompressed size');
  if (input.length < 6) throw new Error('Truncated zlib stream');
  const cmf = input[0]!,
    flags = input[1]!;
  if ((cmf & 15) !== 8 || cmf >> 4 > 7 || ((cmf << 8) | flags) % 31 || flags & 32)
    throw new Error('Unsupported zlib stream header');
  const output = new Uint8Array(size);
  let position = 2,
    bitBuffer = 0,
    bitCount = 0,
    written = 0,
    nextCheckpoint = 65536;
  const bits = (need: number): number => {
    while (bitCount < need) {
      if (position >= input.length) throw new Error('Truncated deflate stream');
      bitBuffer |= input[position++]! << bitCount;
      bitCount += 8;
    }
    const value = bitBuffer & ((1 << need) - 1);
    bitBuffer >>>= need;
    bitCount -= need;
    return value;
  };
  const decode = (code: Huffman): number => {
    let value = 0,
      first = 0,
      index = 0;
    for (let length = 1; length < 16; length++) {
      value |= bits(1);
      const count = code.counts[length]!;
      if (value - first < count) return code.symbols[index + value - first]!;
      index += count;
      first = (first + count) << 1;
      value <<= 1;
    }
    throw new Error('Invalid deflate Huffman code');
  };
  const emitted = () => {
    if (written >= nextCheckpoint) {
      checkpoint();
      nextCheckpoint = written + 65536;
    }
  };
  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuffer = 0;
      bitCount = 0;
      if (position + 4 > input.length) throw new Error('Truncated stored deflate block');
      const length = input[position]! | (input[position + 1]! << 8);
      const complement = input[position + 2]! | (input[position + 3]! << 8);
      position += 4;
      if (length !== (~complement & 0xffff)) throw new Error('Invalid stored deflate block length');
      if (position + length > input.length) throw new Error('Truncated stored deflate block');
      if (written + length > size) throw new Error('Decompressed data exceeds its declared size');
      output.set(input.subarray(position, position + length), written);
      position += length;
      written += length;
      emitted();
      continue;
    }
    let literal: Huffman, distance: Huffman;
    if (type === 1) ({ literal, distance } = fixedCodes());
    else if (type === 2) {
      const literalCount = bits(5) + 257,
        distanceCount = bits(5) + 1,
        codeCount = bits(4) + 4;
      if (literalCount > 286 || distanceCount > 30) throw new Error('Invalid deflate code counts');
      const lengths = new Uint8Array(320);
      for (let index = 0; index < codeCount; index++) lengths[CODE_LENGTH_ORDER[index]!] = bits(3);
      const lengthCode = huffman(lengths, 19, false);
      lengths.fill(0);
      for (let index = 0; index < literalCount + distanceCount;) {
        let symbol = decode(lengthCode);
        if (symbol < 16) {
          lengths[index++] = symbol;
          continue;
        }
        let repeat: number,
          value = 0;
        if (symbol === 16) {
          if (!index) throw new Error('Deflate length repeat without a previous length');
          value = lengths[index - 1]!;
          repeat = 3 + bits(2);
        } else repeat = symbol === 17 ? 3 + bits(3) : 11 + bits(7);
        if (index + repeat > literalCount + distanceCount)
          throw new Error('Deflate code lengths overflow');
        for (symbol = 0; symbol < repeat; symbol++) lengths[index++] = value;
      }
      if (!lengths[256]) throw new Error('Deflate block lacks an end-of-block code');
      literal = huffman(lengths, literalCount, false);
      distance = huffman(lengths.subarray(literalCount), distanceCount, true);
    } else throw new Error('Invalid deflate block type');
    for (;;) {
      const symbol = decode(literal);
      if (symbol < 256) {
        if (written >= size) throw new Error('Decompressed data exceeds its declared size');
        output[written++] = symbol;
      } else if (symbol === 256) break;
      else {
        const lengthIndex = symbol - 257;
        if (lengthIndex >= 29) throw new Error('Invalid deflate length symbol');
        const length = LENGTH_BASE[lengthIndex]! + bits(LENGTH_EXTRA[lengthIndex]!);
        const distanceIndex = decode(distance);
        if (distanceIndex >= 30) throw new Error('Invalid deflate distance symbol');
        const back = DISTANCE_BASE[distanceIndex]! + bits(DISTANCE_EXTRA[distanceIndex]!);
        if (back > written) throw new Error('Deflate distance is before the stream start');
        if (written + length > size) throw new Error('Decompressed data exceeds its declared size');
        for (let index = 0; index < length; index++, written++)
          output[written] = output[written - back]!;
      }
      emitted();
    }
  }
  if (written !== size) throw new Error('Decompressed data is shorter than its declared size');
  if (position + 4 > input.length) throw new Error('Truncated zlib checksum');
  let a = 1,
    b = 0;
  for (let index = 0; index < size; index++) {
    a = (a + output[index]!) % 65521;
    b = (b + a) % 65521;
    if ((index & 0xffff) === 0xffff) checkpoint();
  }
  const expected =
    ((input[position]! << 24) |
      (input[position + 1]! << 16) |
      (input[position + 2]! << 8) |
      input[position + 3]!) >>>
    0;
  if (((b << 16) | a) >>> 0 !== expected) throw new Error('zlib Adler-32 checksum mismatch');
  return output;
}
