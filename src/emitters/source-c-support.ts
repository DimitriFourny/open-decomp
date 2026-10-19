import type { Expression } from '../ir/index.js';
import { integerStorageBits } from './expressions.js';

type IntegerOperation = Extract<Expression, { kind: 'integer' }>['op'];

/** Comments and literals can name a helper without calling it. */
const NON_CODE = /\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
const REFERENCE =
  /\b(?:(bv_[a-z]+|insert_bits|flag_sub_overflow|flag_add_carry)\((?:\s*(\d+))?|(__od_bitcast_(?:f32_u32|u32_f32|f64_u64|u64_f64)|u?int128_t|bool|true|false|isunordered)\b)/g;

const BITCASTS = [
  ['f32_u32', 'float', 'uint32_t'],
  ['u32_f32', 'uint32_t', 'float'],
  ['f64_u64', 'double', 'uint64_t'],
  ['u64_f64', 'uint64_t', 'double'],
] as const;

/** Prelude lines that the emitted C text actually references: exact ordinary C
 * bit-vector helpers plus the `#include`/`#define` lines they (transitively) and
 * the text itself need. Unknown values, machine effects and FP-environment
 * operations deliberately stay opaque. Order is fixed, never first-use. */
export function cScalarSupport(text: string): string[] {
  const operations = new Set<IntegerOperation>();
  const widths = new Set<number>();
  const called = new Set<string>();
  const used = new Set<string>();
  for (const match of text.replace(NON_CODE, ' ').matchAll(REFERENCE)) {
    const [, call, width, token] = match;
    if (token) {
      used.add(token);
      continue;
    }
    const bits = width === undefined ? undefined : Number(width);
    if (bits !== undefined && (bits < 1 || bits > 128)) continue;
    if (call!.startsWith('bv_')) {
      const operation = call!.slice(3) as IntegerOperation;
      if (!Object.hasOwn(bodies, operation)) continue;
      operations.add(operation);
    } else called.add(call!);
    if (bits !== undefined && (call!.startsWith('bv_') || call === 'insert_bits')) widths.add(bits);
  }
  const bitcasts = BITCASTS.filter(([name]) => used.has(`__od_bitcast_${name}`));
  const signedDivision = operations.has('sdiv') || operations.has('srem');
  const wide = used.has('uint128_t') || operations.size > 0 || called.size > 0;
  const lines: string[] = [];
  if (used.has('bool') || used.has('true') || used.has('false')) lines.push('#include <stdbool.h>');
  if (used.has('isunordered')) lines.push('#include <math.h>');
  if (bitcasts.length) lines.push('#include <string.h>');
  if (wide) lines.push('#define uint128_t __uint128_t');
  if (used.has('int128_t') || signedDivision) lines.push('#define int128_t __int128_t');
  for (const width of [...widths].sort((a, b) => a - b))
    lines.push(`#define __od_uint_${width}_t uint${integerStorageBits(width)}_t`);
  for (const operation of Object.keys(bodies) as IntegerOperation[]) {
    if (!operations.has(operation)) continue;
    lines.push(
      `static inline uint128_t __od_bv_${operation}(unsigned width, uint128_t a, uint128_t b) { ${bodies[operation]} }`,
      `#define bv_${operation}(width, a, b) ((__od_uint_##width##_t)__od_bv_${operation}(width, a, b))`,
    );
  }
  if (called.has('insert_bits'))
    lines.push(
      'static inline uint128_t __od_insert_bits(unsigned width, uint128_t base, unsigned value_width, uint128_t value, unsigned offset) { uint128_t mask = ~(uint128_t)0 >> (128 - value_width); return ((base & ~(mask << offset)) | ((value & mask) << offset)) & (~(uint128_t)0 >> (128 - width)); }',
      '#define insert_bits(width, base, value_width, value, offset) ((__od_uint_##width##_t)__od_insert_bits(width, base, value_width, value, offset))',
    );
  if (called.has('flag_sub_overflow'))
    lines.push(
      'static inline uint8_t flag_sub_overflow(unsigned width, uint128_t a, uint128_t b, uint8_t borrow) { return (uint8_t)(((a ^ b) & (a ^ (a - b - borrow))) >> (width - 1)) & 1; }',
    );
  if (called.has('flag_add_carry'))
    lines.push(
      'static inline uint8_t flag_add_carry(unsigned width, uint128_t a, uint128_t b, uint8_t carry) { uint128_t room = (~(uint128_t)0 >> (128 - width)) - b; return a > room || (carry && a == room); }',
    );
  for (const [name, result, parameter] of bitcasts)
    lines.push(
      `static inline ${result} __od_bitcast_${name}(${parameter} value) { ${result} result; _Static_assert(sizeof(result) == sizeof(value), "matching IEEE storage"); memcpy(&result, &value, sizeof(result)); return result; }`,
    );
  return lines;
}

const bodies: Partial<Record<IntegerOperation, string>> = {
  udiv: '(void)width; return a / b;',
  urem: '(void)width; return a % b;',
  sdiv: 'uint128_t sign = (uint128_t)1 << (width - 1); int128_t x = (int128_t)((a ^ sign) - sign), y = (int128_t)((b ^ sign) - sign); uint128_t mask = ~(uint128_t)0 >> (128 - width); if (a == sign && b == mask) __builtin_unreachable(); return (uint128_t)(x / y) & mask;',
  srem: 'uint128_t sign = (uint128_t)1 << (width - 1); int128_t x = (int128_t)((a ^ sign) - sign), y = (int128_t)((b ^ sign) - sign); uint128_t mask = ~(uint128_t)0 >> (128 - width); if (a == sign && b == mask) __builtin_unreachable(); return (uint128_t)(x % y) & mask;',
  rol: 'unsigned n = (unsigned)(b % width); uint128_t mask = ~(uint128_t)0 >> (128 - width); return n ? ((a << n) | (a >> (width - n))) & mask : a;',
  ror: 'unsigned n = (unsigned)(b % width); uint128_t mask = ~(uint128_t)0 >> (128 - width); return n ? ((a >> n) | (a << (width - n))) & mask : a;',
  shl: 'return b >= width ? 0 : (a << (unsigned)b) & (~(uint128_t)0 >> (128 - width));',
  lshr: 'return b >= width ? 0 : a >> (unsigned)b;',
  ashr: 'uint128_t sign = (uint128_t)1 << (width - 1), mask = ~(uint128_t)0 >> (128 - width); if (b >= width) return a & sign ? mask : 0; unsigned n = (unsigned)b; return n && (a & sign) ? (a >> n) | (mask ^ (mask >> n)) : a >> n;',
};
