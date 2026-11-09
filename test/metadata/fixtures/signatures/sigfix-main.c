/* The program linked with libsigfix.a (sigfix-symbols, and sigfix-stripped without symbols). */
#include <stdio.h>
#include <stdlib.h>

int sig_count(const char *s);
int sig_twice(int x);
char *sig_dup(const char *s);
int sig_mix(unsigned x);
int sig_mix_copy(unsigned x);

int main(int argc, char **argv) {
  char *d = sig_dup(argc > 1 ? argv[1] : "fixture");
  printf("%d %d %d %d %s\n", sig_count(d), sig_twice(argc), sig_mix((unsigned)argc), sig_mix_copy(7u), d);
  free(d);
  return 0;
}
