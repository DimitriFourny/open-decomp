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

uint64_t fixture_variadic(uint64_t initial_sp) {
    uint64_t sp = initial_sp;
    uint64_t value0;

    value0 = sp - 0x10ULL;
    *(volatile unaligned_uint64_t *)(value0 + 8ULL) = value0 + 0x10ULL;
    /* missing features: FEAT_AdvSIMD */
    a64_incomplete(UINT64_C(0x1000006dc));
}

