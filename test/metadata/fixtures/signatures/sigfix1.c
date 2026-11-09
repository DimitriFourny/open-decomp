/* Library signature fixture, object 1 (build.sh, provenance.json). */
#include <stdlib.h>
#include <string.h>

static int counter;

int sig_count(const char *s) {
  counter += (int)strlen(s);
  return counter;
}

int sig_twice(int x) { return x * 2 + 1; }

char *sig_dup(const char *s) {
  size_t n = strlen(s) + 1;
  char *p = malloc(n);
  if (!p) return NULL;
  return memcpy(p, s, n);
}

int sig_mix(unsigned x) {
  unsigned h = 2166136261u;
  for (int i = 0; i < 4; i++) {
    h ^= (x >> (8 * i)) & 0xff;
    h *= 16777619u;
  }
  return (int)h;
}
