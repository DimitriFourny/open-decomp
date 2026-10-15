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

uint64_t fixture_stack_args(uint64_t arg0, uint64_t arg1, uint64_t arg2, uint64_t arg3, uint64_t arg4, uint64_t arg5, uint64_t arg6, uint64_t arg7, uint64_t initial_sp) {
    uint64_t sp = initial_sp;
    uint64_t value0;

    value0 = (*(const volatile unaligned_uint64_t *)sp);
    return arg0 + (arg1 << 1) + (arg2 + (arg2 << 1)) + (arg3 << 2) + (arg4 + (arg4 << 2)) + arg5 * 6ULL - arg6 + (arg6 << 3) + (arg7 << 3) + (value0 + (value0 << 3)) + (*(const volatile unaligned_uint64_t *)(sp + 8ULL)) * 0xaULL;
}

