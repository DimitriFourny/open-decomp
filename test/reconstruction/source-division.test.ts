import assert from 'node:assert/strict';
import test from 'node:test';
import { exactMagicDivisor } from '../../src/reconstruction/source-division.js';

/** Brute force: the divisor floor(x*M/2^s) equals for every x < 2^bits, if any. */
function bruteDivisor(bits: number, multiplier: bigint, shift: number): bigint | null {
  const largest = (1n << BigInt(bits)) - 1n;
  const divisor = ((1n << BigInt(shift)) + multiplier - 1n) / multiplier;
  if (divisor < 1n || divisor > largest) return null;
  for (let x = 0n; x <= largest; x++)
    if ((x * multiplier) >> BigInt(shift) !== x / divisor) return null;
  return divisor;
}

test('magic divisor closed form agrees with exhaustive 8-bit search, including near misses', () => {
  for (let shift = 8; shift <= 16; shift++)
    for (let multiplier = 2n; multiplier < 1n << 10n; multiplier++)
      assert.equal(
        exactMagicDivisor(8, multiplier, shift),
        bruteDivisor(8, multiplier, shift),
        `M=${multiplier} s=${shift}`,
      );
});

test('magic divisor recognizes compiler constants and rejects off-by-one multipliers', () => {
  // unsigned x/7 (32-bit, add-back form 2^32 + 0x24924925, shift 32+1+2)
  assert.equal(exactMagicDivisor(32, (1n << 32n) + 0x24924925n, 35), 7n);
  // unsigned x/10 (32-bit) and x/65521 (64-bit add-back form, as emitted for adler32)
  assert.equal(exactMagicDivisor(32, 0xcccccccdn, 35), 10n);
  assert.equal(exactMagicDivisor(64, (1n << 64n) + 0xf00e10d2fc5cdn, 80), 65521n);
  assert.equal(exactMagicDivisor(32, 0xcccccccdn - 1n, 35), null);
  assert.equal(exactMagicDivisor(64, (1n << 64n) + 0xf00e10d2fc5cdn, 79), null);
  // divisor 1 and powers of two are exact multipliers 2^s / d
  assert.equal(exactMagicDivisor(16, 1n << 4n, 4), 1n);
  assert.equal(exactMagicDivisor(16, 1n, 3), 8n);
  // 16-bit random sample against brute force
  let seed = 12345n;
  for (let i = 0; i < 64; i++) {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    const divisor = ((seed >> 33n) % 65534n) + 2n,
      shift = 16 + Number(seed % 4n);
    const multiplier = ((1n << BigInt(shift)) + divisor - 1n) / divisor;
    assert.equal(exactMagicDivisor(16, multiplier, shift), bruteDivisor(16, multiplier, shift));
  }
});

test('division narrowing lemma holds at 8 bits within 16 for every dividend and allowed divisor', () => {
  const wrap = (bits: number, value: bigint): bigint => BigInt.asUintN(bits, value);
  const trunc = (a: bigint, b: bigint): bigint => a / b; // BigInt truncates toward zero
  for (let x = 0n; x < 256n; x++)
    for (let c = 1n; c < 256n; c++) {
      // unsigned: zext16(x) / c == zext16(x /_8 c), same for remainder
      assert.equal(x / c, wrap(8, x / c));
      assert.equal(x % c, wrap(8, x % c));
      // signed: sext16(x) /s c == sext16(x /s_8 c) for c not 0 or -1 (incl. INT8_MIN / 1)
      const sx = BigInt.asIntN(8, x),
        sc = BigInt.asIntN(8, c);
      if (sc === 0n || sc === -1n) continue;
      const wide = trunc(sx, sc),
        narrow = BigInt.asIntN(8, trunc(sx, sc));
      assert.equal(wide, narrow, `${sx}/${sc}`);
      assert.equal(sx - wide * sc, BigInt.asIntN(8, sx - narrow * sc));
    }
  // c = -1 is excluded: INT8_MIN / -1 overflows the narrow width.
  assert.notEqual(trunc(-128n, -1n), BigInt.asIntN(8, trunc(-128n, -1n)));
});

test('remainder identity x - (x/c)*c == x % c holds modulo 2^w at width edges', () => {
  for (const bits of [8, 16, 32, 64]) {
    const top = (1n << BigInt(bits)) - 1n;
    for (const x of [0n, 1n, top, top - 1n, 1n << BigInt(bits - 1)])
      for (const c of [1n, 2n, 3n, 0xfff1n % top || 3n, top]) {
        assert.equal(BigInt.asUintN(bits, x - (x / c) * c), x % c);
        const sx = BigInt.asIntN(bits, x),
          sc = BigInt.asIntN(bits, c);
        if (sc === 0n || sc === -1n) continue;
        assert.equal(BigInt.asIntN(bits, sx - (sx / sc) * sc), sx % sc);
      }
  }
});
