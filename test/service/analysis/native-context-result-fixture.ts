import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CLANG } from '../../support/host-tools.js';

/** SysV callee `double sum(count, values)` with an open argument list (the
 * incoming stack address escapes like a `va_list` setup, which also writes rax
 * on every exit). `count == 0` returns through `xorpd %xmm0, %xmm0` alone; the
 * loop exit `addsd`s into xmm0. `call(count, values)` tail-calls it with the
 * constant counts 0 and 2, so each call site gets its own native context. */
export const contextResultAssembly = `\t.text
\t.globl\tr3_sum
\t.hidden\tr3_sum
\t.type\tr3_sum,@function
r3_sum:
\tleaq\t8(%rsp), %rax
\tmovq\t%rax, -8(%rsp)
\ttestl\t%edi, %edi
\tje\t.Lzero
\txorpd\t%xmm0, %xmm0
.Lloop:
\taddsd\t(%rsi), %xmm0
\taddq\t$8, %rsi
\tdecl\t%edi
\tjne\t.Lloop
\tretq
.Lzero:
\txorpd\t%xmm0, %xmm0
\tretq
\t.size\tr3_sum, .-r3_sum

\t.globl\tr3_call
\t.type\tr3_call,@function
r3_call:
\ttestl\t%edi, %edi
\tje\t.Lcall0
\tmovl\t$2, %edi
\tjmp\tr3_sum
.Lcall0:
\txorl\t%edi, %edi
\tjmp\tr3_sum
\t.size\tr3_call, .-r3_call
`;

/** Assemble the fixture into an x86-64 ELF shared object for analysis only. */
export async function compileContextResultFixture(root: string): Promise<string> {
  const source = join(root, 'context-result.s'),
    binary = join(root, 'context-result.so');
  await writeFile(source, contextResultAssembly);
  const result = spawnSync(
    CLANG,
    [
      '-target',
      'x86_64-unknown-linux-gnu',
      '-nostdlib',
      '-shared',
      '-fuse-ld=lld',
      source,
      '-o',
      binary,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return binary;
}
