/* SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Open Decomp contributors
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
struct Pair { int left; int right; };
volatile int debug_global;
static __attribute__((always_inline)) inline int inner(int value) {
  volatile int local = value + 3;
  return local;
}
static __attribute__((always_inline)) inline int outer(int value) {
  return inner(value) + 7;
}
__attribute__((noinline)) int debug_sum(int left, int right) {
  volatile int scoped = left + right;
  debug_global = scoped;
  return outer(scoped);
}
__attribute__((noinline)) int debug_pair(const struct Pair *pair) {
  return pair->left + pair->right;
}
__attribute__((noinline)) double debug_scale(double value) {
  return value * 2.0;
}
__attribute__((noinline)) int debug_empty() { return 3; }
