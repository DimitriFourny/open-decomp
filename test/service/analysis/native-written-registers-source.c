/* Callee written-register sets (gcc -O2, x86-64 ELF). gcc's interprocedural
 * register allocation (-fipa-ra) keeps caller values in caller-saved registers
 * that a local callee provably never writes; the hand-written callees and
 * callers below pin exact register effects the decompiler must not overclaim. */
#include <stdint.h>

/* x stays in rcx and a in rdx across the leaf: it writes only rax. */
__attribute__((noinline)) static uint32_t ipa_scale(uint32_t v) { return v * 3u + 1u; }
__attribute__((noinline)) uint64_t ipa_keep_arg(uint32_t x, uint32_t y) {
  uint32_t a = ipa_scale(y);
  return (uint64_t)a * 1000u + ipa_scale(x);
}
/* b stays in xmm1 across a callee that writes only xmm0. */
__attribute__((noinline)) static double ipa_half(double v) { return v * 0.5; }
__attribute__((noinline)) double ipa_keep_fp(double a, double b) {
  double h = ipa_half(a);
  return h + b * ipa_half(b);
}
/* Through a local callee that calls the leaf: its set is the leaf's plus its own. */
__attribute__((noinline)) static uint32_t ipa_twice(uint32_t v) { return ipa_scale(ipa_scale(v)); }
__attribute__((noinline)) uint64_t ipa_nested(uint32_t x, uint32_t y) {
  uint32_t a = ipa_twice(y);
  return (uint64_t)a * 7u + ipa_twice(x);
}

/* q stays in esi across the leaf: ipa_two's summary must not close its argument
 * list on the reads its stack facts see (only p), or its caller would drop q. */
__attribute__((noinline)) uint32_t ipa_two(uint32_t p, uint32_t q) { return ipa_scale(p) + q; }
__attribute__((noinline)) uint32_t ipa_two_caller(uint32_t x) { return ipa_two(x, x + 5u) * 2u; }
/* The pointer result is in rax; xmm0 keeps the double it stored, written last. */
struct carrier {
  double w;
  int key;
};
__attribute__((noinline)) struct carrier *ipa_carrier(struct carrier *c, int key) {
  c->key = key;
  c->w = key * 1.5;
  return c;
}
__attribute__((noinline)) int ipa_carrier_caller(struct carrier *c, int key) {
  return ipa_carrier(c, key)->key + 1;
}

__asm__(".text\n"
        /* writes r11 on one path only */
        ".globl asm_one_path\n.type asm_one_path,@function\nasm_one_path:\n"
        "  test %edi, %edi\n  je 1f\n  mov $7, %r11d\n1:\n  ret\n"
        ".size asm_one_path,.-asm_one_path\n"
        /* writes only r11b: the other bits of r11 survive */
        ".globl asm_low_byte\n.type asm_low_byte,@function\nasm_low_byte:\n"
        "  mov $1, %r11b\n  ret\n.size asm_low_byte,.-asm_low_byte\n"
        /* writes r10, then tail-calls asm_one_path (which may write r11) */
        ".globl asm_tail\n.type asm_tail,@function\nasm_tail:\n"
        "  mov $5, %r10d\n  jmp asm_one_path\n.size asm_tail,.-asm_tail\n"
        /* saves and restores r9 through the stack */
        ".globl asm_spill\n.type asm_spill,@function\nasm_spill:\n"
        "  push %r9\n  mov $9, %r9d\n  pop %r9\n  ret\n.size asm_spill,.-asm_spill\n"
        /* callers that read caller-saved registers after the call (not ABI code) */
        ".globl caller_one_path\n.type caller_one_path,@function\ncaller_one_path:\n"
        "  mov %rsi, %r11\n  mov %rsi, %r8\n  call asm_one_path\n"
        "  lea (%r11,%r8,2), %rax\n  ret\n.size caller_one_path,.-caller_one_path\n"
        ".globl caller_low_byte\n.type caller_low_byte,@function\ncaller_low_byte:\n"
        "  mov %rdi, %r11\n  mov %rsi, %r8\n  call asm_low_byte\n"
        "  lea (%r11,%r8,2), %rax\n  ret\n.size caller_low_byte,.-caller_low_byte\n"
        ".globl caller_tail\n.type caller_tail,@function\ncaller_tail:\n"
        "  mov %rsi, %r10\n  mov %rsi, %r9\n  mov %rdx, %r8\n  call asm_tail\n"
        "  lea (%r9,%r8,2), %rax\n  add %r10, %rax\n  ret\n.size caller_tail,.-caller_tail\n"
        ".globl caller_spill\n.type caller_spill,@function\ncaller_spill:\n"
        "  mov %rdi, %r9\n  mov %rsi, %r8\n  call asm_spill\n"
        "  lea (%r9,%r8,2), %rax\n  ret\n.size caller_spill,.-caller_spill\n");
uint64_t caller_one_path(uint64_t, uint64_t);
uint64_t caller_low_byte(uint64_t, uint64_t);
uint64_t caller_tail(uint64_t, uint64_t, uint64_t);
uint64_t caller_spill(uint64_t, uint64_t);

#ifdef WRITTEN_ORACLE
#include <stdio.h>
#include <string.h>
static const uint32_t cases[] = {0u, 1u, 0x7fffffffu, 0x80000000u, 0xffffffffu};
int main(void) {
  for (unsigned i = 0; i < 5; i++) {
    uint32_t x = cases[i], y = cases[(i + 2) % 5];
    double a = (double)i * 1.5 - 2.0, b = (double)i + 0.25, r = ipa_keep_fp(a, b);
    uint64_t bits;
    memcpy(&bits, &r, sizeof bits);
    printf("keep_arg %u %llx\n", i, (unsigned long long)ipa_keep_arg(x, y));
    printf("nested %u %llx\n", i, (unsigned long long)ipa_nested(x, y));
    printf("keep_fp %u %llx\n", i, (unsigned long long)bits);
  }
  struct carrier c;
  printf("carrier %d %u\n", ipa_carrier_caller(&c, 3), ipa_two_caller(3));
  /* Referenced so the hand-written functions are linked and discovered. */
  printf("asm %llx %llx %llx %llx\n", (unsigned long long)caller_one_path(1, 2),
         (unsigned long long)caller_low_byte(0x1234, 3), (unsigned long long)caller_tail(0, 4, 5),
         (unsigned long long)caller_spill(6, 7));
  return 0;
}
#endif
