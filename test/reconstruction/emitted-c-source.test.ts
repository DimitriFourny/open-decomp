import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openBinary, type BinarySession, type ToolResult } from '../../src/api/index.js';
import type { WireEmission } from '../../src/core/index.js';
import { emittedFormals } from '../emitters/c/support.js';
import { CLANG, nativeOracleSkip } from '../support/host-tools.js';

// Trusted source is compiled twice: once as the analyzed Mach-O image (never
// executed) and once, renamed `source_<name>`, into a driver together with the
// exact emitted C. The driver runs both on the same inputs and reports any
// difference; only that driver executes.

interface Case {
  readonly name: string;
  readonly formals: number;
  /** C statements comparing `source_<name>` with `<name>`; `fail(...)` records a mismatch. */
  readonly driver: string;
  /** Patterns the emitted C text must contain. */
  readonly text?: readonly RegExp[];
  /** Patterns the python-like text must contain. */
  readonly python?: readonly RegExp[];
}

function compile(args: readonly string[]): void {
  const result = spawnSync(CLANG, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function checkEmittedC(
  prefix: string,
  source: string,
  cases: readonly Case[],
  t: { after(fn: () => Promise<void>): void },
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  let session: BinarySession | undefined;
  t.after(async () => {
    await session?.close();
    await rm(root, { recursive: true, force: true });
  });
  const file = join(root, 'source.c'),
    image = join(root, 'image');
  await writeFile(file, source);
  compile([
    '-target',
    'arm64-apple-macos13.0',
    '-std=c11',
    '-O2',
    '-g0',
    '-dynamiclib',
    file,
    '-o',
    image,
  ]);
  session = await openBinary(image, { cachePath: join(root, 'cache') });
  for (const item of cases) {
    for (const emitter of ['c-like', 'python-like'] as const) {
      const result: ToolResult<'function_decompile'> = await session.decompile(
        { name: `_${item.name}` },
        { emitter },
      );
      assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
      if (emitter === 'python-like') {
        for (const pattern of item.python ?? [])
          assert.match(result.data.emission.text, pattern, result.data.emission.text);
        continue;
      }
      const emission: WireEmission = result.data.emission;
      assert.equal(emittedFormals(emission).length, item.formals, emission.text);
      for (const pattern of item.text ?? []) assert.match(emission.text, pattern);
      const driver = join(root, `${item.name}.c`),
        binary = join(root, item.name);
      await writeFile(
        driver,
        `#include <stdint.h>
#include <stdio.h>
#define ${item.name} source_${item.name}
${source}
#undef ${item.name}
${emission.text}
static unsigned failures;
#define fail(...) (fprintf(stderr, __VA_ARGS__), fputc('\\n', stderr), ++failures)
int main(void) {
${item.driver}
  return failures != 0;
}
`,
      );
      compile(['-std=c11', '-O2', '-w', driver, '-o', binary]);
      const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(run.status, 0, `${run.stderr}\n${emission.text}`);
    }
  }
}

test(
  'a hexadecimal constant in [2^63, 2^64) keeps a 128-bit multiply 128-bit in emitted C',
  { skip: nativeOracleSkip(), timeout: 120_000 },
  async (t) => {
    // The multiply-high of a constant with its top bit set, once shared by two
    // uses and once inline; the 64-bit literal must not widen the product type.
    const source = `#include <stdint.h>
__attribute__((noinline, used)) uint64_t mulhi_mix(uint64_t t, uint64_t u) {
  uint64_t h = (uint64_t)(((__uint128_t)t * 0x9e3779b97f4a7c15ull) >> 64);
  return h ^ (h >> 7) ^ u;
}
__attribute__((noinline, used)) uint64_t mulhi_sum(uint64_t t, uint64_t u) {
  return (uint64_t)(((__uint128_t)t * 0xfedcba9876543211ull) >> 64) + u;
}
`;
    const vectors = `const uint64_t v[] = {0, 1, 0x7fffffffffffffffull, 0x8000000000000000ull,
    0xffffffffffffffffull, 0x123456789abcdef0ull, 0xdeadbeefcafef00dull, 86399, 1ull << 40};
  for (unsigned i = 0; i < sizeof v / sizeof v[0]; i++)
    for (unsigned j = 0; j < sizeof v / sizeof v[0]; j++)`;
    await checkEmittedC(
      'open-decomp-wide-literal-',
      source,
      ['mulhi_mix', 'mulhi_sum'].map((name) => ({
        name,
        formals: 2,
        driver: `  ${vectors}
      if (source_${name}(v[i], v[j]) != ${name}(v[i], v[j]))
        fail("${name}(%llx, %llx)", (unsigned long long)v[i], (unsigned long long)v[j]);`,
      })),
      t,
    );
  },
);

test(
  'a copied loop-exit tail is refused when its break would also print as a fallthrough',
  { skip: nativeOracleSkip(), timeout: 120_000 },
  async (t) => {
    // Two `goto bad` edges reach one loop exit: the tail copy for the first
    // would make the second's `break` print as a fallthrough as well.
    const source = `#include <stdint.h>
__attribute__((noinline, used)) uint32_t pairs(const uint8_t *in, uint32_t n, uint8_t *out, uint32_t *pos) {
  uint32_t i = 0, o = 0;
  while (i + 1 < n) {
    uint32_t a = in[i], b = in[i + 1];
    if (a >= '0' && a <= '9') a -= '0';
    else if (a >= 'A' && a <= 'F') a -= 'A' - 10;
    else goto bad;
    if (b >= '0' && b <= '9') b -= '0';
    else if (b >= 'A' && b <= 'F') b -= 'A' - 10;
    else goto bad;
    out[o++] = (uint8_t)(a << 4 | b);
    i += 2;
    continue;
  bad:
    o = 0xfffffffdu;
    break;
  }
  *pos = i;
  return o;
}
`;
    await checkEmittedC(
      'open-decomp-tail-copy-',
      source,
      [
        {
          name: 'pairs',
          formals: 4,
          driver: `  const char *inputs[] = {"", "4", "4A", "4a", "a4", "00FF7E", "0G12", "120G", "12G0", "9A9B9C9D1"};
  for (unsigned i = 0; i < sizeof inputs / sizeof inputs[0]; i++) {
    uint8_t expected[8] = {0}, observed[8] = {0};
    uint32_t n = 0, expected_pos = 0x55, observed_pos = 0x55;
    while (inputs[i][n]) n++;
    uint32_t want = source_pairs((const uint8_t *)inputs[i], n, expected, &expected_pos);
    uint32_t got = pairs((const uint8_t *)inputs[i], n, observed, &observed_pos);
    if (want != got || expected_pos != observed_pos)
      fail("pairs(%s): %x/%u vs %x/%u", inputs[i], want, expected_pos, got, observed_pos);
    for (unsigned k = 0; k < sizeof expected; k++)
      if (expected[k] != observed[k]) fail("pairs(%s): byte %u", inputs[i], k);
  }`,
        },
      ],
      t,
    );
  },
);

test(
  'a call-inlining retry reuses the reconstruction and still prints exact C',
  { skip: nativeOracleSkip(), timeout: 120_000 },
  async (t) => {
    // The `strchr` result is read only by the do-while test, which prints after
    // the repeat copies (`s++`, the counter), so the render is retried with that
    // call as a statement. Every attempt continues the same reconstruction and
    // validation state.
    const source = `#include <stdint.h>
#include <string.h>
__attribute__((noinline, used)) int skip(const char *s, int *out) {
  int n = 0;
  do {
    out[n & 3] = n;
    s++;
    n += 5;
  } while (strchr(s, ';') == 0);
  return n;
}
`;
    await checkEmittedC(
      'open-decomp-inlining-retry-',
      source,
      [
        {
          name: 'skip',
          formals: 2,
          text: [/^\s+\w+ = strchr\(/m, /\} while \(\w+ == 0\);/],
          driver: `  const char *cases[] = {"a;", "ab;", "abcdefghij;", "xy;zw", "...........;;"};
  for (unsigned c = 0; c < sizeof cases / sizeof cases[0]; c++) {
    int expected[4] = {7, 7, 7, 7}, observed[4] = {7, 7, 7, 7};
    int want = source_skip(cases[c], expected);
    int got = (int)skip((uint64_t)(uintptr_t)cases[c], (void *)observed);
    if (want != got) fail("skip case %u: %d vs %d", c, want, got);
    for (unsigned k = 0; k < 4; k++)
      if (expected[k] != observed[k]) fail("skip case %u: out[%u] %d vs %d", c, k, expected[k], observed[k]);
  }`,
        },
      ],
      t,
    );
  },
);

test(
  'forward gotos into shared tails print as labels (no run-once block) and run exactly like their source',
  { skip: nativeOracleSkip(), timeout: 120_000 },
  async (t) => {
    // Several `goto fail` / `goto done` edges into shared tails: each prints as a
    // `goto` to its forward label, and the emitted C runs identically to the source.
    const source = `#include <stdint.h>
#include <string.h>
__attribute__((noinline, used)) int params(int argc, const char **argv, int *flags) {
  int verbose = 0, quality = -1, i;
  const char *arg = 0;
  for (i = 1; i < argc; i++) {
    arg = argv[i];
    if (strcmp("verbose", arg) == 0) {
      if (verbose > 0) goto fail;
      verbose = 1;
      continue;
    }
    if (strcmp("version", arg) == 0) goto done;
    const char *eq = strchr(arg, '=');
    if (eq == 0) goto fail;
    if (eq - arg == 7 && arg[0] == 'q') {
      if (quality >= 0) goto fail;
      quality = eq[1] - '0';
      if (quality < 0 || quality > 9) goto fail;
      continue;
    }
    if (eq - arg == 5 && arg[0] == 'l') {
      flags[1] = eq[1];
      if (flags[1] == 'z') goto done;
      continue;
    }
    goto fail;
  }
  flags[2] = 4;
done:
  flags[0] = i;
  flags[4] += verbose;
  return verbose * 100 + quality;
fail:
  flags[3] = i;
  flags[5] = arg ? arg[0] : 0;
  flags[4] -= 1;
  return -1;
}
`;
    await checkEmittedC(
      'open-decomp-inlining-retry-',
      source,
      [
        {
          name: 'params',
          formals: 3,
          text: [/\bgoto label_\w+;/, /^\s*label_\w+:;$/m],
          driver: `  const char *cases[][4] = {
    {"p"}, {"p", "verbose"}, {"p", "verbose", "verbose"}, {"p", "version", "x"},
    {"p", "quality=3"}, {"p", "quality=3", "quality=4"}, {"p", "quality=x"},
    {"p", "large=a", "verbose"}, {"p", "large=z", "x"}, {"p", "x"}, {"p", "abc=1"},
    {"p", "qualit=1"}, {"p", "verbose", "quality=9", "large=b"}};
  const int counts[] = {1, 2, 3, 3, 2, 3, 2, 3, 3, 2, 2, 2, 4};
  for (unsigned c = 0; c < sizeof counts / sizeof counts[0]; c++) {
    int expected[6] = {7, 7, 7, 7, 7, 7}, observed[6] = {7, 7, 7, 7, 7, 7};
    int want = source_params(counts[c], cases[c], expected);
    int got = (int)params(counts[c], (void *)cases[c], (void *)observed);
    if (want != got) fail("params case %u: %d vs %d", c, want, got);
    for (unsigned k = 0; k < 6; k++)
      if (expected[k] != observed[k]) fail("params case %u: flags[%u] %d vs %d", c, k, expected[k], observed[k]);
  }`,
        },
      ],
      t,
    );
  },
);

test(
  'rotated loops print one header test and run like their source, also for zero iterations',
  { skip: nativeOracleSkip(), timeout: 120_000 },
  async (t) => {
    // Clang rotates both loops into a guard plus a bottom test of the same value.
    // `list_sum`'s joined test prints once as the `while` header in both dialects;
    // `walk`'s preheader computes `orr x8, xzr, x2`, which keeps it rotated, and
    // both must still run like their source, including for zero iterations.
    const source = `#include <stdint.h>
struct node { struct node *next; uint32_t value; };
__attribute__((noinline, used)) uint32_t list_sum(const struct node *p) {
  uint32_t s = 0;
  for (; p; p = p->next) s += p->value * 3 + 1;
  return s;
}
__attribute__((noinline, used)) int64_t walk(const int64_t *p, const int64_t *end, int64_t k) {
  int64_t s = k;
  while (p != end) { s = s * 3 + *p; p++; }
  return s - k;
}
`;
    await checkEmittedC(
      'open-decomp-rotated-loop-',
      source,
      [
        {
          name: 'list_sum',
          formals: 1,
          text: [/^\s*while \(\w+ != 0\) \{$/m],
          python: [/^\s*while \w+ != 0:\n(?!\s*pass\n)/m],
          driver: `  struct node n[4] = {{&n[1], 5}, {&n[2], 0}, {&n[3], 0xffffffffu}, {0, 9}};
  const struct node *starts[] = {0, &n[3], &n[1], &n[0]};
  for (unsigned i = 0; i < 4; i++)
    if (source_list_sum(starts[i]) != list_sum((uint64_t)(uintptr_t)starts[i]))
      fail("list_sum start %u", i);`,
        },
        {
          name: 'walk',
          formals: 3,
          driver: `  const int64_t v[] = {4, -9, 1ll << 40, 0, 7};
  for (unsigned a = 0; a <= 5; a++)
    for (unsigned b = a; b <= 5; b++)
      if (source_walk(v + a, v + b, 11) != (int64_t)walk((void *)(v + a), (void *)(v + b), 11))
        fail("walk %u..%u", a, b);`,
        },
      ],
      t,
    );
  },
);
