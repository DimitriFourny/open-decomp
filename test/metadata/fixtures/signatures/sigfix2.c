/* Library signature fixture, object 2: the body of sig_mix under another name. */
int sig_mix_copy(unsigned x) {
  unsigned h = 2166136261u;
  for (int i = 0; i < 4; i++) {
    h ^= (x >> (8 * i)) & 0xff;
    h *= 16777619u;
  }
  return (int)h;
}
