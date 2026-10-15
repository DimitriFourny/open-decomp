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
typedef uint64_t unaligned_uint64_t __attribute__((__aligned__(1), __may_alias__));

uint64_t fixture_memory(void * arg0, uint64_t arg1) {
    uint64_t value0;

    value0 = (*(const volatile unaligned_uint64_t *)((uint64_t)(uintptr_t)arg0));
    *(volatile unaligned_uint64_t *)((uint64_t)(uintptr_t)arg0) = value0 + arg1;
    return value0 + arg1;
}

