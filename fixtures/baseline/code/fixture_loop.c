/* AArch64 decompilation: C-style reconstruction, not original source.
 * Widths are preserved; recovered locals and byte pointers do not imply original source types.
 */
#include <stdint.h>
#include <stdbool.h>
#if !defined(__BYTE_ORDER__) || !defined(__ORDER_LITTLE_ENDIAN__) || __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "Direct memory accesses require a little-endian C target"
#endif
#if !defined(__GNUC__) && !defined(__clang__)
#error "Memory access types require GCC/Clang aligned and may_alias support"
#endif
typedef uint32_t unaligned_uint32_t __attribute__((__aligned__(1), __may_alias__));

uint32_t fixture_loop(const void * arg0, uint32_t arg1) {
    uint64_t x8;
    uint64_t x0;
    uint64_t x9;
    uint32_t value0;
    uint64_t value1;

    if (arg1 == 0) {
        return 0;
    } else {
        x8 = ((uint64_t)(uintptr_t)arg0);
        x0 = 0;
        x9 = arg1;
        while (1) {
            value0 = (*(const volatile unaligned_uint32_t *)x8);
            x8 = x8 + 4ULL;
            x0 = value0 + (uint32_t)x0;
            value1 = x9;
            x9 = x9 - 1ULL;
            if (value1 == 0x1ULL) {
                break;
            }
        }
        return x0;
    }
}

