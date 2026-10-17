/* Trusted source-only conversion oracle and public-analysis inputs. MIT. */
#include <stdint.h>
#ifndef QC_INPUT_ONLY
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#endif

#define NOINLINE __attribute__((noinline))
NOINLINE float qc_s32_f32(int32_t x) { return (float)x; }
NOINLINE double qc_s32_f64(int32_t x) { return (double)x; }
NOINLINE float qc_s64_f32(int64_t x) { return (float)x; }
NOINLINE double qc_s64_f64(int64_t x) { return (double)x; }
NOINLINE float qc_u32_f32(uint32_t x) { return (float)x; }
NOINLINE double qc_u32_f64(uint32_t x) { return (double)x; }
NOINLINE float qc_u64_f32(uint64_t x) { return (float)x; }
NOINLINE double qc_u64_f64(uint64_t x) { return (double)x; }

#if defined(__aarch64__)
/* Exact observed SIMD-scalar encoding, independently checked against C casts.
 * Deliberately no formatted-text repair or target-name-based analysis behavior. */
__attribute__((naked)) float qc_simd_s32(int32_t x) {
  __asm__("fmov s0, w0\nscvtf s0, s0\nret");
}
__attribute__((naked)) double qc_simd_s64(int64_t x) {
  __asm__("fmov d0, x0\nscvtf d0, d0\nret");
}
__attribute__((naked)) float qc_simd_u32(uint32_t x) {
  __asm__("fmov s0, w0\nucvtf s0, s0\nret");
}
__attribute__((naked)) double qc_simd_u64(uint64_t x) {
  __asm__("fmov d0, x0\nucvtf d0, d0\nret");
}
#endif

#ifndef QC_INPUT_ONLY
static uint64_t bits64(double value) {
  uint64_t bits; memcpy(&bits, &value, sizeof bits); return bits;
}
static uint32_t bits32(float value) {
  uint32_t bits; memcpy(&bits, &value, sizeof bits); return bits;
}
int main(void) {
#if defined(__aarch64__)
  __asm__ volatile("msr fpcr, %0" :: "r"((uint64_t)0));
#endif
  const uint64_t values[] = {0, 1, UINT64_MAX, UINT32_MAX, INT32_MAX,
    UINT64_C(0x80000000), UINT64_C(0x8000000000000000), INT64_MAX,
    UINT64_C(16777217), UINT64_C(16777219), UINT64_C(9007199254740993),
    UINT64_C(0x1000001000000001), UINT64_C(0xefffffefffffffff)};
  for (unsigned i = 0; i < sizeof values / sizeof values[0]; ++i) {
    const uint64_t x = values[i];
    printf("%016" PRIx64 " %08" PRIx32 " %016" PRIx64 " %08" PRIx32
           " %016" PRIx64 " %08" PRIx32 " %016" PRIx64 " %08" PRIx32
           " %016" PRIx64 "\n", x,
      bits32(qc_s32_f32((int32_t)x)), bits64(qc_s32_f64((int32_t)x)),
      bits32(qc_s64_f32((int64_t)x)), bits64(qc_s64_f64((int64_t)x)),
      bits32(qc_u32_f32((uint32_t)x)), bits64(qc_u32_f64((uint32_t)x)),
      bits32(qc_u64_f32(x)), bits64(qc_u64_f64(x)));
#if defined(__aarch64__)
    if (bits32(qc_simd_s32((int32_t)x)) != bits32(qc_s32_f32((int32_t)x)) ||
        bits64(qc_simd_s64((int64_t)x)) != bits64(qc_s64_f64((int64_t)x)) ||
        bits32(qc_simd_u32((uint32_t)x)) != bits32(qc_u32_f32((uint32_t)x)) ||
        bits64(qc_simd_u64(x)) != bits64(qc_u64_f64(x))) return 2;
#endif
  }
  return 0;
}
#endif
