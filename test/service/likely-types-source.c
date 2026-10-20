/* SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Open Decomp contributors.
 * Source-known corpus for the pointer/result type heuristics of the opt-in `likely` inference
 * mode. Compiled with -O1 and never analyzed as source. Each function leaves one formal or the
 * result integer-typed under every proven rule while source declares an address.
 */
typedef unsigned long long u64;
typedef u64 (*callback_t)(u64);
typedef u64 (*sink_t)(u64, u64, u64);
sink_t g_sink;
u64 g_word;
u64 g_table[8];

/* `fn` is called through: an address (indirect_call_target). `count` is arithmetic. */
__attribute__((noinline)) u64 run(callback_t fn, u64 count) { return fn(count + 1) + 2; }

/* `handle` is only tested against zero and carried on to a callee (opaque_word_formal);
 * `mask` is used as an integer and stays integer. */
void *g_kept;
__attribute__((noinline)) u64 keep(void *slot, u64 salt) { g_kept = slot; return salt + 1; }
__attribute__((noinline)) u64 carry(void *handle, u64 mask) {
  if (handle == 0) return mask & 0xff;
  return keep(handle, mask ^ 5);
}

/* Integer use inside, address use in every caller (caller_argument_pointer). */
__attribute__((noinline)) u64 tag(u64 address) { return ((address >> 4) ^ address) + 7; }
__attribute__((noinline)) u64 tag_user_a(u64 *p) { p[1] = 3; return tag((u64)p) + p[0]; }
__attribute__((noinline)) u64 tag_user_b(u64 *p) { p[2] = 4; return tag((u64)p) * 3 + p[5]; }

/* The result is an address in every caller that dereferences it (caller_result_pointer). */
__attribute__((noinline)) u64 fetch(void) { return g_word; }
__attribute__((noinline)) u64 fetch_user_a(void) { return *(u64 *)fetch() + 1; }
__attribute__((noinline)) u64 fetch_user_b(void) { return ((u64 *)fetch())[3] ^ 2; }

/* Integer formals and results stay integer: no heuristic fires. */
__attribute__((noinline)) u64 plain(u64 a, u64 b) { return (a * 7 + b) >> 3; }

int main(void) {
  u64 local[8] = {0};
  g_word = (u64)g_table;
  return (int)(run(0, 1) + carry(local, 2) + tag_user_a(local) + tag_user_b(local) +
               fetch_user_a() + fetch_user_b() + plain(3, 4));
}
