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
      if (emitter === 'python-like') continue;
      const emission: WireEmission = result.data.emission;
      assert.equal(emittedFormals(emission).length, item.formals, emission.text);
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
