const U64_MAX = (1n << 64n) - 1n;

/** Decode a wire-format unsigned machine address without passing through Number. */
export function parseHexU64(value: string): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(value)) {
    throw new TypeError('Expected a hexadecimal unsigned 64-bit integer prefixed with 0x');
  }
  return BigInt(value);
}

/** Canonical hexadecimal encoding; reject values that would lose machine width. */
export function formatHexU64(value: bigint): string {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) {
    throw new RangeError('Value is outside the unsigned 64-bit range');
  }
  return `0x${value.toString(16)}`;
}
