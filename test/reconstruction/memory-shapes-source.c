#include <stdint.h>
#include <stdio.h>
typedef uint32_t (*callback)(uint32_t);
struct record { uint32_t head, padding, slots[4]; callback invoke; };
__attribute__((noinline)) void shape_head(struct record *p, uint32_t value) { p->head = value; }
__attribute__((noinline)) void shape_slot(struct record *p, uint32_t index, uint32_t value) { p->slots[index] = value; }
__attribute__((noinline)) uint32_t shape_callback(struct record *p) { return p->invoke(p->head); }
__attribute__((noinline)) uint32_t shape_consumer(struct record *p, struct record *q, uint32_t index, uint32_t value) {
  shape_head(p, value);
  shape_slot(q, index, value + 7);
  return shape_callback(p) + p->slots[index];
}
union views { uint64_t wide; uint32_t words[2]; };
__attribute__((noinline)) uint64_t shape_wide(union views *p) { return p->wide; }
__attribute__((noinline)) uint32_t shape_high(union views *p) { return p->words[1]; }
__attribute__((noinline)) uint64_t shape_union(union views *p) {
  uint64_t wide = shape_wide(p);
  return wide + shape_high(p);
}
static uint32_t triple(uint32_t value) { return value * 3 + 1; }
int main(void) {
  for (unsigned alias = 0; alias < 2; alias++)
    for (unsigned index = 0; index < 4; index++) {
      struct record a = { 5, 0, {11, 12, 13, 14}, triple };
      struct record b = { 9, 0, {21, 22, 23, 24}, triple };
      uint32_t result = shape_consumer(&a, alias ? &a : &b, index, 0xfffffff0u + index);
      printf("%u %u %u %u %u\n", alias, index, result, a.slots[index], b.slots[index]);
    }
  union views value = {.wide = UINT64_C(0x1234567887654321)};
  printf("%llu\n", (unsigned long long)shape_union(&value));
  return 0;
}
