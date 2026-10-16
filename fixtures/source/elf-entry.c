/* SPDX-License-Identifier: MIT */
#include "corpus.h"
/* First-party dynamic dependency, never a libc/kernel API stand-in. */
extern u32 fixture_external(u32 value);
API NOINLINE u32 fixture_native_call(u32 value) { return fixture_external(value) + 1; }
/* This is an analysis entry, not a runnable process startup or syscall wrapper. */
API NOINLINE u32 fixture_entry(void) { return fixture_native_call((u32)fixture_check()); }
