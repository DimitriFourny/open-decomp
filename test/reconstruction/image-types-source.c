#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
/* One context object reaches two callees through the same pointer flow. */
struct context { uint32_t flags, pad; uint64_t total; uint32_t count; };
__attribute__((noinline)) void context_set(struct context *p, uint32_t flags) { p->flags = flags; }
__attribute__((noinline)) uint64_t context_get(struct context *p) { return p->total + p->count; }
__attribute__((noinline)) uint64_t context_drive(struct context *p, uint32_t flags) {
  context_set(p, flags);
  return context_get(p);
}
/* Incompatible views of one object (overlapping widths) stay separate. */
union views { uint64_t wide; uint32_t words[2]; };
__attribute__((noinline)) uint64_t views_wide(union views *p) { return p->wide; }
__attribute__((noinline)) uint32_t views_high(union views *p) { return p->words[1]; }
__attribute__((noinline)) uint64_t views_both(union views *p) { return views_wide(p) + views_high(p); }
/* An array of 32-byte elements reached through a member pointer. */
struct node { uint64_t id, link; uint8_t pad, shared, locked, spare; uint32_t wanted; };
struct slot { const char *name; struct node *node; uint8_t level, safety; uint8_t pad[6]; void *schema; };
struct database { uint8_t pad[32]; struct slot *slots; int32_t count; };
__attribute__((noinline)) void node_unlock(struct node *node) { node->locked = 0; }
/* The call may change db, so the slot array is reloaded on every iteration:
 * a loop-carried byte offset with constant stride beside the index counter. */
__attribute__((noinline)) void release_all(struct database *db) {
  for (int32_t i = 0; i < db->count; i++) {
    struct node *node = db->slots[i].node;
    if (node && node->shared && --node->wanted == 0) node_unlock(node);
  }
}
/* A callee that dereferences its argument and returns it: the caller's call result
 * is that object's pointer although the caller never dereferences it. */
__attribute__((noinline)) struct context *context_touch(struct context *p) { p->count++; return p; }
__attribute__((noinline)) struct context *context_pass(struct context *p) { return context_touch(p); }
/* Integer arithmetic on a parameter never makes the caller's argument a pointer. */
__attribute__((noinline)) uint64_t scale_value(uint64_t v) { return v * 3 + 7; }
__attribute__((noinline)) uint64_t scale_drive(uint64_t h) { return scale_value(h) + 1; }
/* A constant-size allocation, used and freed locally: named by site and size. */
struct pair { uint64_t a; uint32_t b; double c; };
__attribute__((noinline)) uint64_t pair_sum(uint32_t b) {
  struct pair *p = malloc(sizeof *p);
  if (!p) return 0;
  p->a = 1;
  p->b = b;
  p->c = 2.5;
  uint64_t sum = p->a + p->b + (uint64_t)p->c;
  free(p);
  return sum;
}
/* One member read as integer bits by one callee and as a double by another. */
union number { uint64_t bits; double value; };
struct sample { uint32_t id, tag; uint64_t spare; union number number; };
__attribute__((noinline)) uint64_t sample_bits(struct sample *p) { return p->number.bits + p->id; }
__attribute__((noinline)) double sample_scale(struct sample *p) { return p->number.value * p->tag; }
__attribute__((noinline)) double sample_drive(struct sample *p) {
  return (double)sample_bits(p) + sample_scale(p);
}
volatile uint64_t image_types_sink;
int main(void) {
  struct context context = {0, 0, 40, 2};
  printf("%llu %u\n", (unsigned long long)context_drive(&context, 7), context.flags);
  union views value = {.wide = UINT64_C(0x1234567887654321)};
  printf("%llu\n", (unsigned long long)views_both(&value));
  struct node nodes[3] = {{1, 0, 0, 1, 1, 0, 1}, {2, 0, 0, 0, 1, 0, 9}, {3, 0, 0, 1, 1, 0, 4}};
  struct slot slots[4] = {{"a", &nodes[0]}, {"b", 0}, {"c", &nodes[1]}, {"d", &nodes[2]}};
  struct database db = {{0}, slots, 4};
  release_all(&db);
  printf("%u %u %u %u %u %u\n", nodes[0].wanted, nodes[0].locked, nodes[1].wanted, nodes[1].locked,
         nodes[2].wanted, nodes[2].locked);
  struct sample sample = {1, 2, 0, {.value = 1.5}};
  image_types_sink =
      context_pass(&context)->count + scale_drive(5) + pair_sum(4) + (uint64_t)sample_drive(&sample);
  return 0;
}
