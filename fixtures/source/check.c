/* SPDX-License-Identifier: MIT */
#include "corpus.h"
#if defined(_WIN32)
/* MSVC-compatible compiler's floating-point-use marker; no CRT initialization is needed. */
int _fltused = 0;
#endif
#if !defined(FIXTURE_IMPORT)
/* Stable nonzero failure IDs; no CRT, assertions, or host-dependent printf. */
API NOINLINE int fixture_check(void) {
    u32 array[] = {1, 7, 19, 0xffffffffu};
    u64 cell = 0xffffffffffffffffull;
    float a[] = {1, -2, 0.5f, 8}, b[] = {3, 4, -1, 0.25f}, out[4];
    u32 x[] = {0, 1, 0xffffffffu, 0x80000000u}, y[] = {1, 2, 1, 0x80000000u}, z[4];
    if (fixture_arithmetic(3,4) != 90 || fixture_arithmetic(0xffffffffu,1) != 87) return 1;
    if (fixture_maximum(-7,3) != 3 || fixture_maximum(-2,-8) != -2) return 2;
    if (fixture_loop(array,0) != 0 || fixture_loop(array,4) != 26) return 3;
    if (fixture_stack(35) != 42 || fixture_stack(0xffffffffu) != 6) return 4;
    if (fixture_memory(&cell,1) != 0 || cell != 0 || fixture_memory(&cell,42) != 42 || cell != 42) return 5;
    if (fixture_direct(5) != 106 || fixture_indirect(fixture_stack,35) != 43) return 6;
    if (fixture_divide(-13,5) != -2 || fixture_divide(13,-5) != -2) return 7;
    if (fixture_width(0xffffffffu,1,0) != 0x100000000ull || fixture_width(0xffffffffu,1,32) != 1 || fixture_width(0xffffffffu,1,64) != 0x100000000ull) return 8;
    if (fixture_stack_args(1,2,3,4,5,6,7,8,9,10) != 385) return 9;
    if (fixture_float(4,3) != 7.5 || fixture_float(-2,0.5) != -2.75) return 10;
    fixture_vector(out,a,b);
    if (out[0] != 5 || out[1] != 0 || out[2] != 0 || out[3] != 16.25f) return 11;
    fixture_vector_integer(z,x,y);
    if (z[0] != 84 || z[1] != 86 || z[2] != 85 || z[3] != 85) return 12;
    if (fixture_variadic(3,1.0,2.5,-0.5) != 3.0) return 13;
    if (fixture_string()[0] != 'o' || fixture_string()[29] != '1') return 14;
    return 0;
}
#endif
#if defined(FIXTURE_WINDOWS_ENTRY)
__declspec(dllimport) void __stdcall ExitProcess(unsigned int);
void fixture_entry(void) { ExitProcess((unsigned int)fixture_check()); }
#elif defined(FIXTURE_MAIN)
extern int puts(const char *);
int main(void) {
    int result = fixture_check();
    if (!result) puts(fixture_string());
    return result;
}
#endif
