#include <stdint.h>
#include <stdio.h>
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
  return 0;
}
