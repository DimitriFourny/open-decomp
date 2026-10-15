/* AArch64 decompilation: C-style reconstruction, not original source.
 * Widths are preserved; recovered locals and byte pointers do not imply original source types.
 */
#include <stdint.h>
#include <stdbool.h>

static uint32_t a64_sdiv32(uint32_t a, uint32_t b) {
    if (!b) return 0;
    if (a == ((uint32_t)1 << 31) && b == (uint32_t)-1) return a;
    return (uint32_t)((int32_t)a / (int32_t)b);
}

int32_t fixture_divide(int32_t arg0, int32_t arg1) {

    return a64_sdiv32((uint32_t)arg0, (uint32_t)arg1);
}

