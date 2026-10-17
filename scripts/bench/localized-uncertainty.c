#include <stdint.h>
#include <stdio.h>
#include <string.h>

__attribute__((noinline)) uint64_t uncertainty_mixed(volatile uint64_t *p, uint64_t x, uint64_t unresolved) {
  *p = x + 3;
  if (unresolved) {
    /* Deliberately outside the supported instruction subset. Its conservative
       effect boundary must not consume the known branch or the earlier store. */
    __asm__ volatile("mrs x9, cntvct_el0" ::: "x9", "memory");
  }
  return x * 5 + 1;
}

__attribute__((noinline)) double uncertainty_fp(volatile uint64_t *p, double a, double b) {
  *p = 17;
  double first = a + b;
  *p = 23;
  return first * b;
}

__attribute__((noinline)) void uncertainty_callback(void) {
  __asm__ volatile("" ::: "memory");
}

__attribute__((noinline)) double uncertainty_call_epoch(volatile uint64_t *p, double a, double b) {
  *p = 31;
  double first = a + b;
  uncertainty_callback();
  *p = 37;
  return first * b;
}

__attribute__((noinline)) double uncertainty_state_change(volatile uint64_t *p, double a, double b) {
  *p = 41;
  __asm__ volatile("msr fpcr, %0" :: "r"((uint64_t)1 << 22) : "memory");
  *p = 43;
  return a + b;
}

int main(void) {
#ifdef UNCERTAINTY_ORACLE
  __asm__ volatile("msr fpcr, %0" :: "r"((uint64_t)0));
  volatile uint64_t memory;
  uint64_t value = uncertainty_mixed(&memory, 7, 0);
  printf("mixed %016llx %016llx\n", (unsigned long long)value, (unsigned long long)memory);
  double result = uncertainty_fp(&memory, 4.0, 3.0);
  memcpy(&value, &result, sizeof(value));
  printf("fp %016llx %016llx\n", (unsigned long long)value, (unsigned long long)memory);
  result = uncertainty_call_epoch(&memory, 4.0, 3.0);
  memcpy(&value, &result, sizeof(value));
  printf("call %016llx %016llx\n", (unsigned long long)value, (unsigned long long)memory);
#endif
  return 0;
}
