/* SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Open Decomp contributors.
 * Source-known analysis corpus. This file is never executed by the matrix runner.
 * Unsigned operations wrap; pointers/counts require valid object bounds. FP cases
 * assume ordinary finite values/default rounding; no exceptional-environment claim.
 */
typedef unsigned int u32;
#include "zlib.h"
typedef unsigned long long u64;
#define KEEP __attribute__((noinline,used))
typedef u64 (*callback)(u64, void *);
typedef struct { u64 total; u32 count; double weight; } aggregate;
#if defined(_WIN32)
/* MSVC ABI's required floating-point-use link marker; no runtime implementation. */
int _fltused = 0;
#endif

KEEP u64 matrix_multi_exit(const u32 *values, u32 count, u32 stop) {
    u64 sum = 0;
    for (u32 i = 0; i < count; ++i) {
        u32 value = values[i];
        if (value == stop) break;
        if (value == 0) continue;
        sum += value;
        if (sum > 65535) return sum ^ i;
    }
    return sum;
}

KEEP u64 matrix_switch(u32 operation, u64 a, u64 b) {
    switch (operation) {
    case 0: return a + b;
    case 1: return a ^ b;
    case 2: return a * 3 + b;
    case 3: return a - b;
    case 4: return (a << (b & 63)) | 1;
    case 5: return a & b;
    case 6: return a | b;
    case 7: return (a >> (b & 63)) + b;
    case 8: return (a + 17) ^ (b * 9);
    case 9: return a == b ? 42 : 99;
    default: return a;
    }
}

/* a and b may alias: the second load must observe the first write. */
KEEP u64 matrix_alias(u64 *a, u64 *b, u64 delta) {
    *a += delta;
    *b ^= *a;
    return *a + *b;
}

KEEP aggregate matrix_aggregate(aggregate input, u64 delta, double scale) {
    input.total += delta;
    input.count += 1;
    input.weight *= scale;
    return input;
}

KEEP u64 matrix_callback(callback visit, void *context, const u64 *values, u32 count) {
    u64 result = 0;
    for (u32 i = 0; i < count; ++i) {
        u64 next = visit(values[i], context);
        result += next;
        if (next == 0) break;
    }
    return result;
}

KEEP double matrix_variadic(u32 count, ...) {
    __builtin_va_list args;
    __builtin_va_start(args, count);
    double total = 0;
    for (u32 i = 0; i < count; ++i) total += __builtin_va_arg(args, double);
    __builtin_va_end(args);
    return total;
}

KEEP double matrix_mixed(u64 integer, double a, u32 count, double b) {
    double result = a * 1.5 + b * 0.5;
    if (count != 0) result += (double)(integer & 65535) / (double)count;
    return result;
}

KEEP double matrix_variadic_call(u32 count, double a, double b) {
    return count ? matrix_variadic(2, a, b) : matrix_variadic(0);
}
KEEP u64 matrix_checksum(const unsigned char *bytes, u32 count) {
    return ((u64)adler32_z(1, bytes, count) << 32) ^ crc32_z(0, bytes, count);
}


/* Entry is an analysis root, not a platform process-startup implementation. */
KEEP u64 matrix_entry(void) {
    return matrix_switch(2, 7, 9);
}
