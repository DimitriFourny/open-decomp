#include <stdint.h>
#include <stdio.h>
#define NOINLINE __attribute__((noinline))

NOINLINE double return_probe_fp_scratch(uint64_t value, double input) {
  register uint64_t carrier __asm__("x0") = value;
  __asm__ volatile("add %0, %0, #1" : "+r"(carrier));
  return input + 1.25;
}
NOINLINE double return_probe_fp_clean(uint64_t value, double input) {
  (void)value;
  return input + 1.25;
}
#ifdef NATIVE_RETURN_TRUSTED_ORACLE
/* Force/capture actual ABI carriers in the trusted executable. Ordinary C calls
 * may omit a known-unused integer argument, so they are not this machine-state oracle. */
#define CAPTURE_FP_CALL(symbol, gp, fp) \
  __asm__ volatile("bl _" #symbol : "+r"(gp), "+w"(fp) : : \
    "x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8", "x9", "x10", "x11", \
    "x12", "x13", "x14", "x15", "x16", "x17", "x30", \
    "v1", "v2", "v3", "v4", "v5", "v6", "v7", \
    "v16", "v17", "v18", "v19", "v20", "v21", "v22", "v23", \
    "v24", "v25", "v26", "v27", "v28", "v29", "v30", "v31", "cc", "memory")
static NOINLINE uint64_t capture_fp(uint64_t value, double input, double *primary, int clean) {
  register uint64_t gp __asm__("x0") = value;
  register double fp __asm__("d0") = input;
  if (clean) { CAPTURE_FP_CALL(return_probe_fp_clean, gp, fp); }
  else { CAPTURE_FP_CALL(return_probe_fp_scratch, gp, fp); }
  *primary = fp;
  return gp;
}
#endif
int main(void) {
#ifdef NATIVE_RETURN_TRUSTED_ORACLE
  __asm__ volatile("msr fpcr, xzr" ::: "memory");
  const uint64_t values[] = { 0, 1, 0x7fffffff, 0x80000000, UINT64_C(0xffffffffffffffff), UINT64_C(0x1234567887654321) };
  for (unsigned index = 0; index < sizeof(values) / sizeof(values[0]); index++) {
    union { double value; uint64_t bits; } result;
    uint64_t scratch = capture_fp(values[index], 1.5, &result.value, 0);
    printf("scratch %u %016llx %016llx\n", index, (unsigned long long)result.bits, (unsigned long long)scratch);
    uint64_t clean = capture_fp(values[index], 1.5, &result.value, 1);
    printf("clean %u %016llx %016llx\n", index, (unsigned long long)result.bits, (unsigned long long)clean);
  }
#endif
  return 0;
}
