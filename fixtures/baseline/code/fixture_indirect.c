/* AArch64 decompilation: C-style reconstruction, not original source.
 * Widths are preserved; recovered locals and byte pointers do not imply original source types.
 * INCOMPLETE: one or more paths end at explicit analysis boundaries.
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

/* Deliberately unresolved: implement a non-returning analysis boundary, not a no-op. */
extern _Noreturn void a64_incomplete(uint64_t pc);

uint64_t fixture_indirect(uint64_t arg0, uint64_t initial_sp, uint64_t initial_x29, uint64_t initial_x30) {
    uint64_t sp = initial_sp;
    uint64_t x29 = initial_x29;
    uint64_t x30 = initial_x30;
    uint64_t value2;
    uint64_t value0;
    uint64_t value1;
    uint64_t x0;

    *(volatile unaligned_uint64_t *)(sp - 0x10ULL) = x29;
    *(volatile unaligned_uint64_t *)(sp - 8ULL) = x30;
    value2 = sp - 0x10ULL;
    /* Unresolved indirect call contract for arg0; argument and return conventions are unknown. */
    a64_incomplete(UINT64_C(0x100000618));
    /* Call-clobbered state is subsequently read: x0. A callee summary is required. */
    a64_incomplete(UINT64_C(0x100000618));
    value0 = (*(const volatile unaligned_uint64_t *)value2);
    value1 = (*(const volatile unaligned_uint64_t *)(value2 + 8ULL));
    return (uint32_t)(x0 + 1ULL);
}

