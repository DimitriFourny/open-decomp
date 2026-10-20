/* SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Open Decomp contributors.
 * Source-known corpus for the opt-in `likely` inference mode. Compiled with -O1 and never
 * analyzed as source: `hub` and `hub2` read one argument and then pass unobserved argument
 * registers into an indirect call, so no proven rule closes their argument lists.
 */
typedef unsigned long long u64;
typedef u64 (*sink_t)(u64, u64, u64);
sink_t g_sink;

__attribute__((noinline)) u64 hub(u64 value) {
  if (value == 0) return 0;
  return g_sink(value, 7, 9);
}
__attribute__((noinline)) u64 hub2(u64 value) {
  if (value == 0) return 0;
  return g_sink(value, 7, 9);
}
/* Every caller of `hub` prepares exactly one argument. */
__attribute__((noinline)) u64 caller_a(u64 a) { return hub(a ^ 3) + 1; }
__attribute__((noinline)) u64 caller_b(u64 b) { return hub(b ^ 5) * 3; }
/* The callers of `hub2` disagree: one passes a second argument through a cast. */
__attribute__((noinline)) u64 split_a(u64 a) { return hub2(a ^ 3) + 1; }
__attribute__((noinline, optnone)) u64 split_b(u64 a, u64 b) { return ((u64 (*)(u64, u64))hub2)(a ^ 3, b ^ 1) + 2; }
int main(void) { return (int)(caller_a(1) + caller_b(2) + split_a(3) + split_b(4, 5)); }
