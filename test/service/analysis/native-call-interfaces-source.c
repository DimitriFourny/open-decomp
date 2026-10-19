#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define KEEP __attribute__((noinline))
#define OPAQUE(value) __asm__ volatile("" : "+r"(value))

// A growable op list whose append tail-calls its grow path, which tail-calls
// the append again (the SQLite VdbeAddOp3/growOp3 shape): op and p1 pass
// through the recursive group unchanged, and the grow path's own call leaves
// every other argument register live.
typedef struct {
  uint64_t used, capacity, ops[8];
} native_ops;
KEEP uint64_t native_reserve(native_ops *ops) {
  OPAQUE(ops);
  if (ops->capacity >= 8) return 1;
  ops->capacity += 1;
  return 0;
}
KEEP uint64_t native_grow(native_ops *ops, uint64_t op, uint64_t p1);
KEEP uint64_t native_append(native_ops *ops, uint64_t op, uint64_t p1) {
  uint64_t index = ops->used;
  if (index >= ops->capacity) return native_grow(ops, op, p1);
  ops->ops[index] = op * 3 + p1;
  ops->used = index + 1;
  return index;
}
KEEP uint64_t native_grow(native_ops *ops, uint64_t op, uint64_t p1) {
  if (native_reserve(ops)) return 99;
  return native_append(ops, op, p1);
}
KEEP uint64_t native_append_caller(native_ops *ops, uint64_t value) {
  return native_append(ops, value, 5) + 1;
}

// An indirect call reached only by computed values closes; one that an
// unused argument register may still reach stays open.
typedef uint64_t (*native_unary)(uint64_t);
KEEP uint64_t native_mix(uint64_t value) {
  OPAQUE(value);
  return value ^ UINT64_C(0x5a5a5a5a5a5a5a5a);
}
KEEP uint64_t native_apply(native_unary function, uint64_t value) {
  uint64_t mixed = native_mix(value);
  return function(mixed) + 3;
}
KEEP uint64_t native_apply_open(native_unary function, uint64_t value) {
  return function(value + 1) + 3;
}
// The callers forward an opaque function pointer, so no calling context can
// resolve the indirect target.
KEEP uint64_t native_apply_caller(native_unary function, uint64_t value) {
  return native_apply(function, value) + 1;
}
KEEP uint64_t native_apply_open_caller(native_unary function, uint64_t value) {
  return native_apply_open(function, value) + 1;
}

// A void body whose final call is not its last action (another loop
// iteration may follow): the call result left in x0 is not a return value,
// and callers must not consume it.
KEEP uint64_t native_unlock(uint64_t *slot) {
  OPAQUE(slot);
  *slot = 0;
  return (uint64_t)slot;
}
KEEP void native_release(native_ops *ops) {
  for (uint64_t index = 0; index < ops->used; index++)
    if (ops->ops[index] == 1) native_unlock(&ops->ops[index]);
}
KEEP uint64_t native_release_caller(native_ops *ops) {
  native_release(ops);
  return ops->capacity;
}

// Darwin `open` reads its stack mode exactly when every possible flag value
// sets O_CREAT.
KEEP int native_create(const char *path, int force) {
  int fd = open(path, O_CREAT | O_WRONLY | (force ? O_TRUNC : O_EXCL), 0600);
  if (fd < 0) return -1;
  return close(fd);
}

// Darwin variadic arguments live on the stack. Both paths store their own
// arguments and join one shared fprintf call, the shape clang emits for
// tail-merged error reports; explicit ISA source fixes the registers: the path
// is one value stored on both edges, the code is carried into the join by x21.
__attribute__((naked, noinline)) int native_report(FILE *stream, const char *path, int code) {
  __asm__("sub sp, sp, #0x40\n"
          "stp x22, x21, [sp, #0x10]\n"
          "stp x20, x19, [sp, #0x20]\n"
          "stp x29, x30, [sp, #0x30]\n"
          "add x29, sp, #0x30\n"
          "mov x19, x0\n"
          "mov x20, x1\n"
          "cbz w2, 1f\n"
          "mov x21, x2\n"
          "stp x20, x21, [sp]\n"
          "adrp x1, Lnative_report_input@PAGE\n"
          "add x1, x1, Lnative_report_input@PAGEOFF\n"
          "b 2f\n"
          "1:\n"
          "mov x21, #7\n"
          "stp x20, x21, [sp]\n"
          "adrp x1, Lnative_report_output@PAGE\n"
          "add x1, x1, Lnative_report_output@PAGEOFF\n"
          "2:\n"
          "mov x0, x19\n"
          "bl _fprintf\n"
          "mov x0, x21\n"
          "ldp x29, x30, [sp, #0x30]\n"
          "ldp x20, x19, [sp, #0x20]\n"
          "ldp x22, x21, [sp, #0x10]\n"
          "add sp, sp, #0x40\n"
          "ret\n"
          ".section __TEXT,__cstring,cstring_literals\n"
          "Lnative_report_input: .asciz \"failed to open input file [%s]: %d\\n\"\n"
          "Lnative_report_output: .asciz \"failed to open output file [%s]: %d\\n\"\n"
          ".text\n");
}

int main(void) {
  const uint64_t values[] = {0, 1, UINT64_C(0x7fffffff), UINT64_C(0xffffffff), UINT64_C(0x1234567887654321)};
  for (unsigned i = 0; i < sizeof(values) / sizeof(values[0]); i++) {
    uint64_t v = values[i];
    printf("apply %u %llx\n", i, (unsigned long long)native_apply_caller(native_mix, v));
    printf("apply_open %u %llx\n", i, (unsigned long long)native_apply_open_caller(native_mix, v));
  }
  native_ops ops = {0, 0, {0}};
  for (unsigned i = 0; i < 10; i++) printf("append %u %llx\n", i, (unsigned long long)native_append_caller(&ops, i));
  ops.ops[0] = 1;
  printf("release %llx %llx\n", (unsigned long long)native_release_caller(&ops), (unsigned long long)ops.ops[0]);
  return 0;
}
