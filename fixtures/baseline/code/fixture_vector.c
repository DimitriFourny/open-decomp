/* AArch64 decompilation: C-style reconstruction, not original source.
 * Widths are preserved; recovered locals and byte pointers do not imply original source types.
 * INCOMPLETE: one or more paths end at explicit analysis boundaries.
 * Assumptions and entry-state requirements are listed in diagnostics.
 */
#include <stdint.h>
#include <stdbool.h>

/* Deliberately unresolved: implement a non-returning analysis boundary, not a no-op. */
extern _Noreturn void a64_incomplete(uint64_t pc);

uint64_t fixture_vector(void) {
    /* missing features: FEAT_FP */
    a64_incomplete(UINT64_C(0x10000069c));
}

