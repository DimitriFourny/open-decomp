/* Public P3.7 trusted-source question fixture. Analysis only: never execute. */
#include <stdint.h>
struct record { uint32_t tag; uint32_t count; uint64_t total; };
__attribute__((noinline)) uint64_t investigation_mix(uint64_t x, uint64_t y) {
  return (x ^ UINT64_C(0x35)) + y;
}
__attribute__((noinline)) uint64_t investigation_caller(uint64_t x) {
  return investigation_mix(x, 7) + 3;
}
__attribute__((noinline)) uint64_t investigation_field(const struct record *p, uint32_t i) {
  return p[i].total + p[i].count;
}
__attribute__((noinline)) int64_t investigation_signed(int64_t x, int64_t y) {
  return x / y;
}
__attribute__((noinline)) uint64_t investigation_callback(uint64_t (*f)(uint64_t), uint64_t x) {
  return f(x) + 1;
}
