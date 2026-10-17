#include <stdint.h>

/* Source counterpart of the natively executed ARM oracle's finite arithmetic.
 * This crosscompiled image is analyzed only and is never executed. */
__attribute__((noinline)) double uncertainty_x86_fp(volatile uint64_t *p, double a, double b) {
  *p = 17;
  double first = a + b;
  *p = 23;
  return first * b;
}
