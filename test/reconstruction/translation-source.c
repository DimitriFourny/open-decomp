#include <stdint.h>
#include <stdio.h>
#include <inttypes.h>

__attribute__((noinline)) uint64_t translation_arithmetic(uint64_t x, int64_t y) {
  return x * UINT64_C(9) + (uint64_t)(y >> 3);
}
__attribute__((noinline)) uint64_t translation_stack(uint64_t x) {
  volatile uint64_t slot = x;
  return slot + UINT64_C(7);
}
__attribute__((noinline)) uint64_t translation_loop(uint64_t x, uint64_t y, uint64_t n) {
  while (n--) {
    uint64_t saved = x;
    x = y;
    y = saved + UINT64_C(1);
  }
  return x ^ y;
}
int main(void) {
  const uint64_t inputs[] = {0, 1, UINT64_MAX, UINT64_C(0x8000000000000000), UINT64_C(0x5555555555555555)};
  for (unsigned i = 0; i < sizeof(inputs) / sizeof(inputs[0]); i++) {
    uint64_t x = inputs[i], y = inputs[4 - i];
    printf("%u %016" PRIx64 " %016" PRIx64 " %016" PRIx64 "\n", i,
      translation_arithmetic(x, (int64_t)y), translation_stack(x), translation_loop(x, y, i));
  }
  return 0;
}
