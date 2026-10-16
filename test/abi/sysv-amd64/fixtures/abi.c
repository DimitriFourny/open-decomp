/* SPDX-License-Identifier: MIT */
/* SDK/CRT-free, first-party SysV compiler evidence. Never executed. */
#define API __attribute__((visibility("default"), noinline))
typedef unsigned long long u64;
typedef struct { u64 i; double f; } Mixed;
typedef struct { double f; u64 i; } Reverse;
typedef struct { u64 a, b; } Integers;
typedef struct { double a, b; } Floats;
typedef struct { u64 a, b, c; } Large;
API double abi_mixed(unsigned a, double b, unsigned c, float d, u64 e) { return a + b + c + d + e; }
API double abi_aggregate(Mixed first, Reverse second) { return (double)(first.i+second.i)+first.f+second.f; }
/* Mixed cannot partially consume XMM0 after INTEGER registers are exhausted. */
API double abi_rollback(u64 a, u64 b, u64 c, u64 d, u64 e, u64 f, Mixed pair, double tail) {
    return (double)(a+b+c+d+e+f+pair.i) + pair.f + tail;
}
/* Exhaust SSE first: failed aggregate must not consume the available RDI. */
API double abi_sse_rollback(double a, double b, double c, double d, double e, double f, double g, double h, Mixed pair, u64 tail) {
    return a+b+c+d+e+f+g+h+pair.f+(double)(pair.i+tail);
}
API double abi_sse_overflow(double a, double b, double c, double d, double e, double f, double g, double h, double i) { return a+b+c+d+e+f+g+h+i; }
API u64 abi_stack_args(u64 a, u64 b, u64 c, u64 d, u64 e, u64 f, u64 g, u64 h) { return a+b+c+d+e+f+g+h; }
API Integers abi_ret_integer(u64 a, u64 b) { return (Integers){a+1,b+2}; }
API Floats abi_ret_sse(double a, double b) { return (Floats){a+1,b+2}; }
API Mixed abi_ret_mixed(u64 a, double b) { return (Mixed){a+1,b+2}; }
API Reverse abi_ret_reverse(double a, u64 b) { return (Reverse){a+1,b+2}; }
API Large abi_sret(u64 a, u64 b) { return (Large){a,b,a+b}; }
API u64 abi_red_zone(u64 a) { volatile u64 local[3] = {a,7,9}; return local[0]+local[1]+local[2]; }
API u64 abi_stack(u64 a, unsigned index) { volatile u64 local[40]; local[0]=a; local[index%40]=7; return local[0]; }
API double abi_variadic(unsigned count, ...) {
    __builtin_va_list args;
    __builtin_va_start(args, count);
    double result=0;
    for (unsigned i=0; i<count; ++i) result+=__builtin_va_arg(args,double);
    __builtin_va_end(args);
    return result;
}
API double abi_call_variadic(double a, double b) { return abi_variadic(2,a,b)+1; }
/* Preserve 80-bit value / 128-bit storage without claiming x87 reconstruction. */
_Static_assert(sizeof(long double)==16, "SysV long double storage");
API unsigned abi_long_double_size(void) { return sizeof(long double); }
API unsigned char abi_long_double_storage(const long double *p) { return *(const unsigned char *)(p+1); }
