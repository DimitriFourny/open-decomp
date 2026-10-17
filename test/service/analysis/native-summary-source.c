#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define KEEP __attribute__((noinline))
#define OPAQUE(value) __asm__ volatile("" : "+r"(value))

KEEP uint32_t native_leaf32(uint32_t value) { OPAQUE(value); return value * 3u + 7u; }
KEEP uint64_t native_leaf64(uint64_t value) { OPAQUE(value); return value ^ UINT64_C(0xfedcba9876543210); }
KEEP uint64_t native_nested(uint64_t value) { return native_leaf32((uint32_t)value) + UINT64_C(0x100000000); }
KEEP uint64_t native_outer(uint64_t value) { return native_nested(value) + 11; }
KEEP int64_t native_signed(int32_t value) { OPAQUE(value); return (int64_t)value; }
KEEP int64_t native_signed_caller(int32_t value) { return native_signed(value) + 13; }
KEEP uint64_t native_preserved(uint64_t first, uint64_t second) {
  uint64_t saved = first;
  return saved + native_leaf64(second);
}
KEEP uint64_t native_identity(uint64_t value) { OPAQUE(value); return value; }
KEEP uint64_t native_identity_caller(uint64_t value) { return native_identity(value) + UINT64_C(0x300000000); }
KEEP uint64_t native_recursive(uint64_t count, uint64_t value) {
  OPAQUE(count);
  if (count == 0) return native_leaf32((uint32_t)value);
  return native_recursive(count - 1, value + 5) + 1;
}
KEEP uint64_t native_mutual_b(uint64_t count, uint64_t value);
KEEP uint64_t native_mutual_a(uint64_t count, uint64_t value) {
  OPAQUE(count);
  if (!count) return native_leaf32((uint32_t)value);
  return native_mutual_b(count - 1, value + 3) + 1;
}
KEEP uint64_t native_mutual_b(uint64_t count, uint64_t value) {
  OPAQUE(count);
  if (!count) return native_leaf32((uint32_t)value);
  return native_mutual_a(count - 1, value + 7) + 2;
}
KEEP uint64_t native_stack_leaf(uint64_t a, uint64_t b, uint64_t c, uint64_t d,
  uint64_t e, uint64_t f, uint64_t g, uint64_t h, uint64_t i, uint64_t j) {
  OPAQUE(a); OPAQUE(b); OPAQUE(c); OPAQUE(d); OPAQUE(e);
  OPAQUE(f); OPAQUE(g); OPAQUE(h); OPAQUE(i); OPAQUE(j);
  return a + 2*b + 3*c + 4*d + 5*e + 6*f + 7*g + 8*h + 9*i + 10*j;
}
KEEP uint64_t native_stack_caller(uint64_t value) {
  return native_stack_leaf(value, 2, 3, 4, 5, 6, 7, 8, value + 9, value + 10);
}
KEEP double native_fp_leaf(uint64_t a, double b, uint64_t c, float d) {
  OPAQUE(a); OPAQUE(c);
  return (double)a + b + (double)c + (double)d;
}
KEEP double native_fp_caller(uint64_t a, double b, uint64_t c, float d) {
  return native_fp_leaf(a, b, c, d) + 0.5;
}
typedef uint32_t native_vector __attribute__((vector_size(16)));
KEEP native_vector native_vector_leaf(native_vector value) {
  __asm__ volatile("" : "+w"(value));
  return value + (native_vector){1, 1, 1, 1};
}
KEEP native_vector native_vector_caller(native_vector value) {
  return native_vector_leaf(value) + (native_vector){5, 5, 5, 5};
}
// Explicit ISA source establishes a real direct tail transfer independently of
// compiler sibling-call heuristics. The analyzer receives no declaration.
__attribute__((naked,noinline)) uint32_t native_tail(uint32_t value) {
  __asm__("b _native_leaf32");
}
KEEP uint64_t native_tail_caller(uint32_t value) { return native_tail(value) + UINT64_C(0x200000000); }

static uint64_t bits(double value) { uint64_t result; memcpy(&result, &value, 8); return result; }
int main(void) {
  const uint64_t values[] = {0, 1, UINT64_C(0x7fffffff), UINT64_C(0x80000000), UINT64_C(0xffffffff), UINT64_C(0x1234567887654321)};
  for (unsigned i = 0; i < sizeof(values)/sizeof(values[0]); i++) {
    uint64_t v = values[i];
    printf("outer %u %llx\n", i, (unsigned long long)native_outer(v));
    printf("signed %u %llx\n", i, (unsigned long long)native_signed_caller((int32_t)v));
    printf("preserved %u %llx\n", i, (unsigned long long)native_preserved(v, v + 17));
    printf("identity %u %llx\n", i, (unsigned long long)native_identity_caller(v));
    printf("recursive %u %llx\n", i, (unsigned long long)native_recursive(3, v));
    printf("mutual %u %llx\n", i, (unsigned long long)native_mutual_a(3, v));
    printf("stack %u %llx\n", i, (unsigned long long)native_stack_caller(v));
    printf("tail %u %llx\n", i, (unsigned long long)native_tail_caller((uint32_t)v));
    printf("tail_body %u %llx\n", i, (unsigned long long)native_tail((uint32_t)v));
    printf("fp %u %llx\n", i, (unsigned long long)bits(native_fp_caller(i, 1.25, i + 3, 2.5f)));
    native_vector vector = native_vector_caller((native_vector){(uint32_t)v, (uint32_t)(v >> 32), i, ~(uint32_t)v});
    uint64_t packed[2]; memcpy(packed, &vector, sizeof(packed));
    printf("vector %u %016llx%016llx\n", i, (unsigned long long)packed[1], (unsigned long long)packed[0]);
  }
}
