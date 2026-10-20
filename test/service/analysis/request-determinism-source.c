struct node { long a, b, c, d; struct node *next; int e, f; };
#define LEAF(n, field) __attribute__((noinline)) long n(struct node *p, long x) { p->field += x; return p->field * 3 + x; }
LEAF(leaf_a, a) LEAF(leaf_b, b) LEAF(leaf_c, c) LEAF(leaf_d, d)
__attribute__((noinline)) long mid_one(struct node *p, long x) { return leaf_a(p, x) + leaf_b(p, x + 1) + p->e; }
__attribute__((noinline)) long mid_two(struct node *p, long x) { return leaf_c(p, x) + leaf_d(p->next, x + 2) + p->f; }
__attribute__((noinline)) long mid_three(struct node *p, long x) { return mid_one(p, x) * mid_two(p, x ^ 5); }
__attribute__((noinline)) long root(struct node *p, long x) {
  long total = mid_three(p, x);
  for (struct node *q = p->next; q; q = q->next) total += mid_one(q, total) - mid_two(q, x);
  return total + leaf_a(p, 9) + leaf_d(p, 4);
}
int main(int argc, char **argv) { struct node n = {0}; n.next = &n; return (int)root(&n, argc) & 1; }
