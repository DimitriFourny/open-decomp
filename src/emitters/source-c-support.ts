import { bitWidth, type Expression } from '../ir/index.js';
import type { Reconstruction } from '../reconstruction/model.js';
import type { Writer } from './writer.js';
import { integerStorageBits } from './expressions.js';

/** Implement only helpers with exact ordinary C bit-vector semantics. Unknown
 * values, machine effects and FP-environment operations deliberately stay opaque. */
export function declareCScalarSupport(
  program: Pick<Reconstruction, 'values' | 'expressions' | 'source'>,
  writer: Writer,
): void {
  writer.line(0, '#include <stdbool.h>');
  const operations = new Set<Extract<Expression, { kind: 'integer' }>['op']>();
  const widths = new Set<number>();
  let wide = false;
  let floating = false;
  let inserts = false,
    integerInserts = true;
  let subtractionOverflow = false,
    boundedSubtraction = true;
  let additionCarry = false,
    boundedAddition = true;
  for (const value of program.values.values()) {
    writer.context.checkpoint(1);
    if (bitWidth(value.type) === 128) wide = true;
    if (value.type.kind === 'float' && (value.type.bits === 32 || value.type.bits === 64))
      floating = true;
  }
  for (const expression of program.expressions.values()) {
    writer.context.checkpoint(1);
    if (expression.kind === 'insert') {
      inserts = true;
      if (
        expression.base.type.kind !== 'integer' ||
        expression.value.type.kind !== 'integer' ||
        bitWidth(expression.base.type) > 128
      )
        integerInserts = false;
      else widths.add(bitWidth(expression.base.type));
    }
    if (expression.kind === 'flag' && expression.op === 'sub' && expression.flag === 'overflow') {
      subtractionOverflow = true;
      if (bitWidth(expression.left.type) > 128) boundedSubtraction = false;
    }
    if (expression.kind === 'flag' && expression.op === 'add' && expression.flag === 'carry') {
      additionCarry = true;
      if (bitWidth(expression.left.type) > 128) boundedAddition = false;
    }
    if (expression.kind !== 'integer' || bitWidth(expression.left.type) > 128) continue;
    if (bodies[expression.op]) {
      operations.add(expression.op);
      widths.add(bitWidth(expression.left.type));
    }
  }
  if (
    wide ||
    operations.size ||
    (inserts && integerInserts) ||
    (subtractionOverflow && boundedSubtraction) ||
    (additionCarry && boundedAddition)
  ) {
    writer.line(0, '#define uint128_t __uint128_t');
    writer.line(0, '#define int128_t __int128_t');
  }
  for (const width of widths)
    writer.line(0, `#define __od_uint_${width}_t uint${integerStorageBits(width)}_t`);
  for (const operation of operations) {
    writer.line(
      0,
      `static inline uint128_t __od_bv_${operation}(unsigned width, uint128_t a, uint128_t b) { ${bodies[operation]} }`,
    );
    writer.line(
      0,
      `#define bv_${operation}(width, a, b) ((__od_uint_##width##_t)__od_bv_${operation}(width, a, b))`,
    );
  }
  if (inserts && integerInserts) {
    writer.line(
      0,
      'static inline uint128_t __od_insert_bits(unsigned width, uint128_t base, unsigned value_width, uint128_t value, unsigned offset) { uint128_t mask = ~(uint128_t)0 >> (128 - value_width); return ((base & ~(mask << offset)) | ((value & mask) << offset)) & (~(uint128_t)0 >> (128 - width)); }',
    );
    writer.line(
      0,
      '#define insert_bits(width, base, value_width, value, offset) ((__od_uint_##width##_t)__od_insert_bits(width, base, value_width, value, offset))',
    );
  }
  if (subtractionOverflow && boundedSubtraction)
    writer.line(
      0,
      'static inline uint8_t flag_sub_overflow(unsigned width, uint128_t a, uint128_t b, uint8_t borrow) { return (uint8_t)(((a ^ b) & (a ^ (a - b - borrow))) >> (width - 1)) & 1; }',
    );
  if (additionCarry && boundedAddition)
    writer.line(
      0,
      'static inline uint8_t flag_add_carry(unsigned width, uint128_t a, uint128_t b, uint8_t carry) { uint128_t room = (~(uint128_t)0 >> (128 - width)) - b; return a > room || (carry && a == room); }',
    );
  if (floating) {
    writer.line(0, '#include <string.h>');
    for (const [bits, type] of [
      [32, 'float'],
      [64, 'double'],
    ] as const) {
      writer.line(
        0,
        `static inline ${type} __od_bitcast_f${bits}_u${bits}(uint${bits}_t value) { ${type} result; _Static_assert(sizeof(result) == sizeof(value), "matching IEEE storage"); memcpy(&result, &value, sizeof(result)); return result; }`,
      );
      writer.line(
        0,
        `static inline uint${bits}_t __od_bitcast_u${bits}_f${bits}(${type} value) { uint${bits}_t result; _Static_assert(sizeof(result) == sizeof(value), "matching IEEE storage"); memcpy(&result, &value, sizeof(result)); return result; }`,
      );
    }
  }
  if (program.source?.addresses.some((address) => address.object)) {
    writer.line(
      0,
      'static inline uintptr_t data_address(const char *name, uintptr_t base, uintptr_t offset, ...) { (void)name; return base + offset; }',
    );
  }
}

const bodies: Partial<Record<Extract<Expression, { kind: 'integer' }>['op'], string>> = {
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
