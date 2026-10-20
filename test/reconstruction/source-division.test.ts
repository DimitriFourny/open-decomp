import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exactMagicDivisor,
  exactSignedMagicDivisor,
} from '../../src/reconstruction/source-division.js';

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

/** Brute force: floor(x*M/2^s) + [x*M < 0] == trunc(x/d) for every 8-bit x
 * (INT8_MIN included), d = sign(M)*ceil(2^s/|M|), 2 <= |d| < 128. */
function bruteSignedDivisor(multiplier: bigint, shift: number): bigint | null {
  const a = multiplier < 0n ? -multiplier : multiplier;
  const magnitude = ((1n << BigInt(shift)) + a - 1n) / a;
  const divisor = multiplier < 0n ? -magnitude : magnitude;
  if (magnitude < 2n || magnitude >= 128n) return null;
  for (let x = -128n; x < 128n; x++) {
    const product = x * multiplier;
    if ((product >> BigInt(shift)) + (product < 0n ? 1n : 0n) !== x / divisor) return null;
  }
  return divisor;
}

test('signed magic divisor closed form agrees with exhaustive 8-bit search, both signs', () => {
  for (let shift = 0; shift <= 16; shift++)
    for (let multiplier = -700n; multiplier <= 700n; multiplier++) {
      if (multiplier === 0n) continue;
      assert.equal(
        exactSignedMagicDivisor(8, multiplier, shift),
        bruteSignedDivisor(multiplier, shift),
        `M=${multiplier} s=${shift}`,
      );
    }
});

test('signed magic divisor recognizes compiler constants and rejects near misses', () => {
  const signed32 = (bits: bigint) => BigInt.asIntN(32, bits);
  // x/7: smull by 0x92492493 then + x (M - 2^32 + 2^32), >> 2
  assert.equal(exactSignedMagicDivisor(32, signed32(0x92492493n) + (1n << 32n), 34), 7n);
  // x/-7: smull by 0x6db6db6d then - x, >> 2
  assert.equal(exactSignedMagicDivisor(32, 0x6db6db6dn - (1n << 32n), 34), -7n);
  assert.equal(exactSignedMagicDivisor(32, 0x55555556n, 32), 3n);
  assert.equal(exactSignedMagicDivisor(32, 0x66666667n, 34), 10n);
  assert.equal(exactSignedMagicDivisor(32, 0x10624dd3n, 38), 1000n);
  assert.equal(exactSignedMagicDivisor(64, 0x4924924924924925n, 65), 7n);
  assert.equal(exactSignedMagicDivisor(64, -0x4924924924924925n, 65), -7n);
  assert.equal(exactSignedMagicDivisor(32, 0x55555555n, 32), null);
  assert.equal(exactSignedMagicDivisor(32, 0x66666667n, 33), 5n);
  assert.equal(exactSignedMagicDivisor(32, 0x66666666n, 34), null);
  assert.equal(exactSignedMagicDivisor(64, 0x4924924924924924n, 65), null);
  // An exact power-of-two multiplier is a floor shift, never truncation.
  assert.equal(exactSignedMagicDivisor(32, 1n, 3), null);
  // |d| = 1 and |d| = 2^(w-1) are excluded.
  assert.equal(exactSignedMagicDivisor(8, 1n, 0), null);
  assert.equal(exactSignedMagicDivisor(8, 1n, 7), null);
  // 16-bit sample against brute force over every dividend.
  let seed = 99n;
  for (let i = 0; i < 48; i++) {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    const d = ((seed >> 33n) % 32000n) + 2n,
      shift = 16 + Number(seed % 6n),
      negative = (seed & 1n) === 1n;
    const magnitude = (1n << BigInt(shift)) / d + 1n;
    const multiplier = negative ? -magnitude : magnitude;
    const candidate = ((1n << BigInt(shift)) + magnitude - 1n) / magnitude;
    const divisor = negative ? -candidate : candidate;
    let exact = candidate >= 2n && candidate < 1n << 15n;
    for (let x = -32768n; exact && x < 32768n; x++) {
      const product = x * multiplier;
      exact = (product >> BigInt(shift)) + (product < 0n ? 1n : 0n) === x / divisor;
    }
    assert.equal(
      exactSignedMagicDivisor(16, multiplier, shift),
      exact ? divisor : null,
      `d=${d} s=${shift}`,
    );
  }
});

test('signed power-of-two identities hold for every 8-bit dividend', () => {
  for (let k = 1; k < 8; k++) {
    const d = 1n << BigInt(k),
      mask = d - 1n;
    for (let x = -128n; x < 128n; x++) {
      const bias = x < 0n ? mask : 0n,
        biased = x + bias;
      assert.equal(biased >> BigInt(k), x / d, `bias shift k=${k} x=${x}`);
      // x - (biased & -2^k), ((x + bias) & (2^k-1)) - bias
      assert.equal(x - (biased & ~mask), x % d);
      assert.equal((biased & mask) - bias, x % d);
      // x > 0 ? x & m : -((-x) & m), with -x wrapping at INT8_MIN
      const negated = BigInt.asIntN(8, -x);
      assert.equal(BigInt.asIntN(8, x > 0n ? x & mask : -(negated & mask)), x % d);
      // the csneg test is -x < 0 (true at INT8_MIN): both arms agree there
      assert.equal(BigInt.asIntN(8, negated < 0n ? x & mask : -(negated & mask)), x % d);
    }
  }
});
