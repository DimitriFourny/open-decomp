#include <stddef.h>
#include <string.h>
#define NOINLINE __attribute__((noinline))

/* Self-recursive results. Exits of recursive_compare: `mov w0, #0`, the
 * self-call result and the library `int` result of memcmp, joined in one
 * `int` variable. recursive_total returns nothing; after its self-call the
 * call result stays in x0 while the body stores the total. */
struct recursive_node {
  struct recursive_node *left;
  long value;
};
NOINLINE int recursive_compare(const unsigned char *a, const unsigned char *b, int n,
                               long *matched) {
  int rc;
  if (n <= 0) return 0;
  if (a[0] != b[0]) rc = memcmp(a, b, (size_t)n);
  else rc = recursive_compare(a + 1, b + 1, n - 1, matched);
  if (rc) return rc;
  ++*matched;
  return 0;
}

NOINLINE void recursive_total(struct recursive_node *node, long *total) {
  if (!node) return;
  recursive_total(node->left, total);
  *total += node->value;
}

int main(void) { return 0; }
