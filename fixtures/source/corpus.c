/* SPDX-License-Identifier: MIT */
#include "corpus.h"
API volatile u64 fixture_zero_fill[64];
API const char fixture_message[] = "open-decomp trusted fixture v1";
API unary volatile fixture_callback = fixture_stack;
API NOINLINE u32 fixture_arithmetic(u32 a, u32 b) { return (a + b * 3u) ^ 0x55u; }
API NOINLINE i32 fixture_maximum(i32 a, i32 b) { return a > b ? a : b; }
API NOINLINE u32 fixture_loop(const u32 *p, u32 n) {
    u32 result = 0;
    for (u32 i = 0; i < n; ++i) result += p[i];
    return result;
}
API NOINLINE u32 fixture_stack(u32 a) { volatile u32 local[3] = {a, 7, 9}; return local[0] + local[1]; }
API NOINLINE u64 fixture_memory(u64 *p, u64 delta) { *p += delta; return *p; }
API NOINLINE u32 fixture_direct(u32 a) { return fixture_stack(a) + fixture_arithmetic(a, 2); }
API NOINLINE u32 fixture_indirect(unary fn, u32 a) { return fn(a) + 1; }
/* Inputs deliberately exclude C's undefined divide-by-zero and INT_MIN/-1. */
API NOINLINE i32 fixture_divide(i32 a, i32 b) { return a / b; }
API NOINLINE u64 fixture_width(u32 a, u32 b, u32 shift) { return ((u64)a + (u64)b) >> (shift & 63); }
API NOINLINE u64 fixture_stack_args(u64 a,u64 b,u64 c,u64 d,u64 e,u64 f,u64 g,u64 h,u64 i,u64 j) {
    return a + 2*b + 3*c + 4*d + 5*e + 6*f + 7*g + 8*h + 9*i + 10*j;
}
API NOINLINE double fixture_float(double a, double b) { return a * 1.5 + b / 2.0; }
API NOINLINE void fixture_vector(float *out, const float *a, const float *b) {
    v4f x, y, z;
    __builtin_memcpy(&x, a, 16); __builtin_memcpy(&y, b, 16);
    z = x * (v4f){2,2,2,2} + y;
    __builtin_memcpy(out, &z, 16);
}
API NOINLINE void fixture_vector_integer(u32 *out, const u32 *a, const u32 *b) {
    v4u x, y, z;
    __builtin_memcpy(&x, a, 16); __builtin_memcpy(&y, b, 16);
    z = (x + y) ^ (v4u){0x55,0x55,0x55,0x55};
    __builtin_memcpy(out, &z, 16);
}
API NOINLINE double fixture_variadic(u32 count, ...) {
    __builtin_va_list args;
    __builtin_va_start(args, count);
    double sum = 0;
    for (u32 i = 0; i < count; ++i) sum += __builtin_va_arg(args, double);
    __builtin_va_end(args);
    return sum;
}
API NOINLINE const char *fixture_string(void) { return fixture_message; }
