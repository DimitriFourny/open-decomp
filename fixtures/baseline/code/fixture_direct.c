/* AArch64 decompilation: C-style reconstruction, not original source.
 * Widths are preserved; recovered locals and byte pointers do not imply original source types.
 * Assumptions and entry-state requirements are listed in diagnostics.
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

/* Proven callee contracts; unresolved calls end at explicit boundaries. */
extern uint32_t fixture_arithmetic(uint32_t, uint32_t);
extern uint32_t fixture_stack(uint32_t);

uint32_t fixture_direct(uint32_t arg0, uint64_t initial_sp, uint64_t initial_x19, uint64_t initial_x20, uint64_t initial_x29, uint64_t initial_x30) {
    uint64_t sp = initial_sp;
    uint64_t x20 = initial_x20;
    uint64_t x19 = initial_x19;
    uint64_t value4;
    uint64_t x29 = initial_x29;
    uint64_t x30 = initial_x30;
    uint32_t value5;
    uint32_t value6;
    uint32_t value7;
    uint64_t value0;
    uint64_t value1;
    uint64_t value2;
    uint64_t value3;

    *(volatile unaligned_uint64_t *)(sp - 0x20ULL) = x20;
    *(volatile unaligned_uint64_t *)(sp - 0x18ULL) = x19;
    value4 = sp - 0x20ULL;
    *(volatile unaligned_uint64_t *)(value4 + 0x10ULL) = x29;
    *(volatile unaligned_uint64_t *)(value4 + 0x18ULL) = x30;
    value5 = fixture_stack(arg0);
    value6 = value5;
    value7 = fixture_arithmetic(arg0, 2);
    value0 = (*(const volatile unaligned_uint64_t *)(value4 + 0x10ULL));
    value1 = (*(const volatile unaligned_uint64_t *)(value4 + 0x18ULL));
    value2 = (*(const volatile unaligned_uint64_t *)value4);
    value3 = (*(const volatile unaligned_uint64_t *)(value4 + 8ULL));
    return value7 + value6;
}

