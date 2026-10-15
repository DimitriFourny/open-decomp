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

uint64_t fixture_check(uint64_t initial_sp, uint64_t initial_x19, uint64_t initial_x20, uint64_t initial_x29, uint64_t initial_x30) {
    uint64_t sp = initial_sp;
    uint64_t value0;
    uint64_t x20 = initial_x20;
    uint64_t x19 = initial_x19;
    uint64_t x29 = initial_x29;
    uint64_t x30 = initial_x30;

    value0 = sp - 0xc0ULL;
    *(volatile unaligned_uint64_t *)(value0 + 0xa0ULL) = x20;
    *(volatile unaligned_uint64_t *)(value0 + 0xa8ULL) = x19;
    *(volatile unaligned_uint64_t *)(value0 + 0xb0ULL) = x29;
    *(volatile unaligned_uint64_t *)(value0 + 0xb8ULL) = x30;
    /* missing features: FEAT_FP */
    a64_incomplete(UINT64_C(0x10000072c));
}

