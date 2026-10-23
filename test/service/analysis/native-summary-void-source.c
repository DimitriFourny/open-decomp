/* V3 fixture: compiled -O1 -g0 with sibling calls; never executed by the test.
 * `void_like` leaves the result of `value_leaf` in x0 before a later store: its
 * native summary is void-like (`result_incidental`). Every function is exported,
 * so closed-world caller consensus abstains. */
__attribute__((noinline)) long value_leaf(long value) { return value * 3 + 7; }

__attribute__((noinline)) void void_like(long *cell) { cell[1] = value_leaf(cell[0]); }

/* A tail transfer to the void-like callee. */
__attribute__((noinline)) void tail_void(long *cell) {
  cell[2] = 1;
  void_like(cell);
}

/* `return f()` with a value `f`: a tail transfer that forwards a result. */
__attribute__((noinline)) long tail_value(long value) { return value_leaf(value + 1); }

int main(void) {
  long cell[3] = {1, 0, 0};
  tail_void(cell);
  return (int)(tail_value(cell[1]) & 1);
}
