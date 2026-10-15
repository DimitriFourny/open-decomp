/* SPDX-License-Identifier: MIT
 * Trusted compiler input for offline ABI evidence; never executed by the tests.
 */
#define API __declspec(dllexport) __declspec(noinline)
int _fltused = 0; /* Link-time FP marker; no CRT dependency. */
typedef unsigned long long u64;
typedef float v4f __attribute__((vector_size(16)));
typedef unsigned v2u __attribute__((vector_size(8)));
typedef struct { unsigned char bytes[3]; } S3;
typedef struct { unsigned a, b; } S8;
typedef struct { unsigned a, b, c; } S12;
typedef struct { u64 a, b; } S16;
_Static_assert(sizeof(long) == 4, "Windows LLP64 long");
_Static_assert(sizeof(void *) == 8, "Windows LLP64 pointer");
_Static_assert(sizeof(long double) == 8, "Microsoft long double");
API double abi_mixed(unsigned a, double b, unsigned c, float d, u64 e) {
    return a + b + c + d + e;
}
API S8 abi_ret8(unsigned a, unsigned b) { S8 value = {a,b}; return value; }
API S12 abi_sret12(unsigned a, double b, unsigned c, float d) {
    S12 value = {a, (unsigned)b + c, (unsigned)d}; return value;
}
API S16 abi_sret16(u64 a, u64 b) { S16 value = {a,b}; return value; }
API unsigned abi_aggregate(S3 a, S8 b) { return a.bytes[0] + b.a + b.b; }
API v4f abi_vector(v4f a) { return a + (v4f){1,2,3,4}; }
API v2u abi_vector64(v2u a) { return a + (v2u){1,2}; }
API double abi_variadic(unsigned count, ...) {
    __builtin_va_list args;
    __builtin_va_start(args, count);
    double result = __builtin_va_arg(args, double);
    __builtin_va_end(args);
    return result + count;
}
API double abi_call_variadic(void) { return abi_variadic(1, 3.5); }
API double abi_preserve(double a, double b, void (*call)(void)) {
    double c = a + b;
    call();
    return a + b + c;
}
