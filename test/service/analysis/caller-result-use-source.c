/* SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Open Decomp contributors.
 * Source-known corpus for positive caller result-use evidence. Compiled with -O1 and never
 * analyzed as source. Every analyzed function is `static noinline`, called directly and
 * stripped of debug info.
 *
 *   - `scale`: a plain result; its caller consumes it.
 *   - `post_call`: the result is the call result left in w0 while a store follows, so the callee
 *     alone is void-like (`incidental_result`); `use_post` stores the result, which refutes that.
 *   - `post_ignored`: the same body, but its only caller never reads w0, so it stays void.
 *   - `bump`: a real void function.
 *   - `tail_ignored`: a void function whose last action is a tail call to the int `h` (its body
 *     alone reads as `return h(...)`); its only caller discards the register, so closed-world
 *     caller consensus makes it `void`. `tail_recursive` is the same with a recursive call whose
 *     result reaches only its own return. `tail_table` has its address stored in a table and
 *     `tail_exported` is exported: both keep the forwarded result.
 */
volatile int g_vol, g_out;

__attribute__((noinline)) static int scale(int a) { return a * 7 + g_vol; }
__attribute__((noinline)) static int post_call(int a) { int r = scale(a); g_vol = r; return r; }
__attribute__((noinline)) static int post_ignored(int a) { int r = scale(a + 1); g_vol = r; return r; }
__attribute__((noinline)) static void bump(int a) { g_vol = g_vol + a; }

__attribute__((noinline)) int use_scale(int a) { g_out = scale(a) + 1; return a; }
__attribute__((noinline)) int use_post(int a) { g_out = post_call(a) + 1; return a; }
__attribute__((noinline)) int use_ignored(int a) { post_ignored(a); return a + 2; }
__attribute__((noinline)) int use_bump(int a) { bump(a); return a + 3; }

__attribute__((noinline)) static int h(int a) { g_vol = a; return a + 1; }
__attribute__((noinline)) static void tail_ignored(int a) { g_out = a; h(a + 1); }
__attribute__((noinline)) static void tail_table(int a) { g_out = a; h(a + 2); }
__attribute__((noinline)) void tail_exported(int a) { g_out = a; h(a + 3); }
__attribute__((noinline)) static void tail_recursive(int a) {
  if (a > 0) {
    tail_recursive(a - 1);
    g_out = a;
    return;
  }
  h(a);
}
void (*volatile table[])(int) = { tail_table };

__attribute__((noinline)) int use_h(int a) { g_out = h(a); return a; }
__attribute__((noinline)) int use_tails(int a) {
  tail_ignored(a);
  tail_table(a);
  tail_exported(a);
  tail_recursive(a);
  return a + 5;
}

int main(void) {
  table[0](2);
  return use_scale(1) + use_post(4) + use_ignored(5) + use_bump(6) + use_h(7) + use_tails(8);
}
