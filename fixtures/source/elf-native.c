/* SPDX-License-Identifier: MIT */
/* Self-authored dependency: no SDK, CRT, system library or runtime objects. */
__attribute__((visibility("default"), noinline))
unsigned int fixture_external(unsigned int value) { return value ^ 0x1234u; }
