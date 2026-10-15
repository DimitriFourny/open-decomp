/* AArch64 decompilation: C-style reconstruction, not original source.
 * Widths are preserved; recovered locals and byte pointers do not imply original source types.
 */
#include <stdint.h>
#include <stdbool.h>

uint64_t fixture_width(uint32_t arg0, uint32_t arg1, uint32_t arg2) {

    return (uint64_t)arg1 + (uint64_t)arg0 >> (((uint64_t)arg2) & 63ULL);
}

