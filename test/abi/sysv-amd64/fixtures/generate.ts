// SPDX-License-Identifier: MIT
// node --import tsx test/abi/sysv-amd64/fixtures/generate.ts
// No target execution, SDK/CRT, network or normal-test compiler dependency.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('.', import.meta.url));
const llvm = process.env['LLVM_BIN'] ?? '/opt/homebrew/opt/llvm/bin';
const clang = process.env['ELF_CC'] ?? join(llvm, 'clang');
const linker = process.env['LD_LLD'] ?? join(llvm, 'ld.lld');
const objdump = join(llvm, 'llvm-objdump'), readobj = join(llvm, 'llvm-readobj');
const temporary = mkdtempSync(join(tmpdir(), 'open-decomp-sysv-abi-'));
const compilerFlags = ['--target=x86_64-unknown-linux-gnu', '-std=c11', '-O1', '-ffreestanding', '-fPIC', '-ffp-contract=off', '-fno-vectorize', '-fno-slp-vectorize', '-fno-stack-protector', '-fno-builtin', `-ffile-prefix-map=${directory}=<fixture>/`, '-c', join(directory, 'abi.c'), '-o', join(temporary, 'abi.o')];
const linkerFlags = ['-m', 'elf_x86_64', '-shared', '--build-id=none', '-z', 'noexecstack', '--soname=abi.so', '-o', join(directory, 'abi.so'), join(temporary, 'abi.o')];
const commands: string[][] = [];
function run(executable: string, args: string[], record = true): string {
  const output = execFileSync(executable, args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', SOURCE_DATE_EPOCH: '0' } });
  if (record) commands.push([executable, ...args].map(part => part.replaceAll(directory, '<fixture>/').replaceAll(temporary, '<temporary>')));
  return output.replaceAll(directory, '<fixture>/');
}
try {
  run(clang, compilerFlags);
  run(linker, linkerFlags);
  writeFileSync(join(directory, 'abi.disassembly.txt'), run(objdump, ['--disassemble', join(directory, 'abi.so')]));
  writeFileSync(join(directory, 'abi.metadata.txt'), run(readobj, ['--file-headers', '--program-headers', '--sections', '--symbols', '--dyn-symbols', '--relocations', join(directory, 'abi.so')]));
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify({
    license: 'MIT (fixtures/LICENSE)', target_execution: 'never executed; static compiler evidence only',
    tools: Object.fromEntries([['clang', clang], ['lld', linker], ['objdump', objdump], ['readobj', readobj]].map(([name, path]) => [name!, { path: path!, version: run(path!, ['--version'], false).trim(), sha256: createHash('sha256').update(readFileSync(path!)).digest('hex') }])),
    commands,
    sha256: Object.fromEntries(['abi.c', 'generate.ts', 'abi.so', 'abi.disassembly.txt', 'abi.metadata.txt'].map(name => [name, createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')])),
  }, null, 2) + '\n');
} finally { rmSync(temporary, { recursive: true, force: true }); }
