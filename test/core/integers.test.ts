import assert from 'node:assert/strict';
import test from 'node:test';
import { formatHexU64, parseHexU64 } from '../../src/core/integers.js';

test('wire integers retain bits beyond the Number precision boundary', () => {
  assert.equal(parseHexU64('0x20000000000001'), 9007199254740993n);
  assert.equal(parseHexU64('0xffffffffffffffff'), (1n << 64n) - 1n);
  assert.equal(formatHexU64(parseHexU64('0x0000ABcd')), '0xabcd');
  assert.equal(formatHexU64(0n), '0x0');
});

test('wire integers reject ambiguous, signed, and over-width encodings', () => {
  for (const value of ['42', '-0x1', '0x', '0x10000000000000000', '0x 1', ' 0x1', '0x1g']) {
    assert.throws(() => parseHexU64(value), TypeError);
  }
  assert.throws(() => formatHexU64(-1n), RangeError);
  assert.throws(() => formatHexU64(1n << 64n), RangeError);
});
