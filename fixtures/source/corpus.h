/* SPDX-License-Identifier: MIT */
#ifndef OPEN_DECOMP_CORPUS_H
#define OPEN_DECOMP_CORPUS_H
#if defined(_WIN32)
# if defined(FIXTURE_IMPORT)
#  define API __declspec(dllimport)
# else
#  define API __declspec(dllexport)
# endif
#else
# define API __attribute__((visibility("default")))
#endif
#define NOINLINE __attribute__((noinline))
typedef unsigned int u32;
typedef unsigned long long u64;
typedef int i32;
typedef float v4f __attribute__((ext_vector_type(4)));
typedef u32 v4u __attribute__((ext_vector_type(4)));
typedef u32 (*unary)(u32);
API u32 fixture_arithmetic(u32 a, u32 b);
API i32 fixture_maximum(i32 a, i32 b);
API u32 fixture_loop(const u32 *p, u32 n);
API u32 fixture_stack(u32 a);
API u64 fixture_memory(u64 *p, u64 delta);
API u32 fixture_direct(u32 a);
API u32 fixture_indirect(unary fn, u32 a);
API i32 fixture_divide(i32 a, i32 b);
API u64 fixture_width(u32 a, u32 b, u32 shift);
API u64 fixture_stack_args(u64 a,u64 b,u64 c,u64 d,u64 e,u64 f,u64 g,u64 h,u64 i,u64 j);
API double fixture_float(double a, double b);
API void fixture_vector(float *out, const float *a, const float *b);
API void fixture_vector_integer(u32 *out, const u32 *a, const u32 *b);
API double fixture_variadic(u32 count, ...);
API const char *fixture_string(void);
API int fixture_check(void);
#endif
