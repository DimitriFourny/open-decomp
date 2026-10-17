#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef float v4f __attribute__((ext_vector_type(4)));
#define NOINLINE __attribute__((noinline))

NOINLINE double fixture_variadic(unsigned count, ...) {
  va_list args;
  va_start(args, count);
  double sum = 0.0;
  for (unsigned i = 0; i < count; ++i) sum += va_arg(args, double);
  va_end(args);
  return sum;
}

NOINLINE v4f fixture_vector_return(v4f a, v4f b) { return a * 2.0f + b; }

NOINLINE void fixture_vector_store(float *out, const float *a, const float *b) {
  v4f x, y, result;
  __builtin_memcpy(&x, a, sizeof(x));
  __builtin_memcpy(&y, b, sizeof(y));
  result = x * 2.0f + y;
  __builtin_memcpy(out, &result, sizeof(result));
}

NOINLINE double fixture_mixed(unsigned n, double a, double b) {
  return (double)n + a * 1.5 + b * 0.5;
}

NOINLINE double fixture_mixed_caller(unsigned n, double a, double b) {
  const double first = fixture_mixed(n, a, b);
  const double second = fixture_mixed(n + 1, b, a);
  return first + second;
}

static void scalar(const char *name, unsigned index, double value) {
  uint64_t bits;
  __builtin_memcpy(&bits, &value, sizeof(bits));
  printf("%s %u %016llx\n", name, index, (unsigned long long)bits);
}

static void lanes(const char *name, unsigned index, const void *value) {
  uint32_t bits[4];
  __builtin_memcpy(bits, value, sizeof(bits));
  printf("%s %u %08x %08x %08x %08x\n", name, index,
         bits[0], bits[1], bits[2], bits[3]);
}

int main(void) {
  // These trusted native oracles deliberately select the supported FP environment.
  __asm__ volatile("msr fpcr, %0" :: "r"((uint64_t)0));
  scalar("variadic", 0, fixture_variadic(0));
  scalar("variadic", 1, fixture_variadic(1, 7.5));
  scalar("variadic", 2, fixture_variadic(3, 4.0, -2.0, 0.5));
  scalar("variadic", 3, fixture_variadic(5, 0x1p-1022, 0x1p-1022,
                                      -0x1p-1022, 0x0.0000000000001p-1022, 0.0));
  scalar("variadic", 4, fixture_variadic(10, 1.0, 2.0, 3.0, 4.0, 5.0,
                                       6.0, 7.0, 8.0, 9.0, 10.0));
  scalar("variadic", 5, fixture_variadic(3, 0x1p+52, 1.0, -0x1p+52));
  const v4f a[] = {
    {1.0f, -2.0f, 0.0f, 3.125f},
    {0x1p-126f, 0x1p-149f, 0x1p+24f, -0.0f},
    {0x1p+120f, -0x1p+120f, 1.25f, -2.5f},
  };
  const v4f b[] = {
    {3.0f, 4.0f, -0.0f, 10.0f},
    {-0x1p-126f, 0x1p-149f, 1.0f, -0.0f},
    {-0x1p+120f, 0x1p+120f, -2.5f, 5.0f},
  };
  for (unsigned i = 0; i < sizeof(a) / sizeof(a[0]); i++) {
    const v4f result = fixture_vector_return(a[i], b[i]);
    lanes("vector", i, &result);
    float out[4];
    fixture_vector_store(out, (const float *)&a[i], (const float *)&b[i]);
    lanes("store", i, out);
  }
  const unsigned counts[] = {0, 7, UINT32_MAX};
  const double left[] = {4.0, -2.0, 0.5}, right[] = {3.0, 0.5, -1.5};
  for (unsigned i = 0; i < sizeof(counts) / sizeof(counts[0]); i++)
    scalar("mixed", i, fixture_mixed_caller(counts[i], left[i], right[i]));
  return 0;
}
