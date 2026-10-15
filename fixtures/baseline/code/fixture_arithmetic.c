/* AArch64 decompilation: C-style reconstruction, not original source.
 * Widths are preserved; recovered locals and byte pointers do not imply original source types.
 */
#include <stdint.h>
#include <stdbool.h>

uint32_t fixture_arithmetic(uint32_t arg0, uint32_t arg1) {

    return arg1 + (uint32_t)((uint64_t)arg1 << 1) + arg0 ^ 0x55U;
}

