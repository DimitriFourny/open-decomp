#define LEAF(n, k) __attribute__((noinline)) long n(long x) { return x * k + (x >> k); }
LEAF(leaf0, 3) LEAF(leaf1, 5) LEAF(leaf2, 7) LEAF(leaf3, 9) LEAF(leaf4, 11)
LEAF(leaf5, 13) LEAF(leaf6, 15) LEAF(leaf7, 17) LEAF(leaf8, 19) LEAF(leaf9, 21)
/* A switch lowered to a jump table: discovering this body uses the image data index (the
 * table proof), a per-process structure each request pays once. No other body uses it. */
__attribute__((noinline)) long dispatch(long k, long x) {
  switch (k) {
  case 0: return leaf0(x); case 1: return leaf1(x); case 2: return leaf2(x);
  case 3: return leaf3(x); case 4: return leaf4(x); case 5: return leaf5(x);
  case 6: return leaf6(x); case 7: return leaf7(x); case 8: return leaf8(x);
  case 9: return leaf9(x); default: return -1;
  }
}
__attribute__((noinline)) long caller(long k, long x) { return dispatch(k, x) + dispatch(k + 1, x); }
int main(int argc, char **argv) { (void)argv; return (int)caller(argc, argc) & 1; }
