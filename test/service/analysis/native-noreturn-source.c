/* Trusted fixture: a stack-protected function whose final instruction is the
 * `bl ___stack_chk_fail` guard call, followed directly by the next function. */
__attribute__((noinline)) unsigned fill(volatile char *buffer, unsigned count) {
  unsigned sum = 0;
  for (unsigned index = 0; index < count && index < 64; index++) {
    buffer[index] = (char)index;
    sum += (unsigned char)buffer[index];
  }
  return sum;
}

__attribute__((noinline)) unsigned guarded(unsigned count) {
  volatile char buffer[64];
  return fill(buffer, count) + 1;
}

__attribute__((noinline)) unsigned after_guarded(unsigned value) { return value * 3; }

int main(int argc, char **argv) {
  (void)argv;
  return (int)(guarded((unsigned)argc) + after_guarded((unsigned)argc)) & 1;
}
