// A C++ function that is both a local symbol target and a dynamic export: its call
// sites must print the name its own header prints.
__attribute__((noinline)) int scale(int x, int y) { return x * 3 + y; }
extern "C" int entry(int a) { return scale(a, a + 1) + scale(a + 2, a); }
