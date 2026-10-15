// SPDX-License-Identifier: MIT
// Explicit developer-only regeneration: node --import tsx test/abi/windows-x64/fixtures/generate.ts
// No target execution, SDK/CRT, network access, or normal-test compiler dependency.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('.', import.meta.url));
const clang = process.env['CC'] ?? '/usr/bin/clang';
const linker = process.env['LLD_LINK'] ?? '/opt/homebrew/bin/lld-link';
const objdump = process.env['LLVM_OBJDUMP'] ?? '/opt/homebrew/opt/llvm/bin/llvm-objdump';
const temporary = mkdtempSync(join(tmpdir(), 'open-decomp-windows-abi-'));
const compilerFlags = ['--target=x86_64-pc-windows-msvc', '-std=c11', '-O1', '-ffp-contract=off', '-fno-stack-protector', '-fno-builtin', '-c', join(directory, 'abi.c'), '-o', join(temporary, 'abi.obj')];
const linkerFlags = ['/dll', '/noentry', '/nodefaultlib', '/timestamp:0', '/machine:x64', '/base:0x180000000', `/out:${join(directory, 'abi.dll')}`, `/implib:${join(temporary, 'abi.lib')}`, join(temporary, 'abi.obj')];
const hash = (name: string): string => createHash('sha256').update(readFileSync(join(directory, name))).digest('hex');
try {
  execFileSync(clang, compilerFlags, { stdio: 'pipe' });
  execFileSync(linker, linkerFlags, { stdio: 'pipe' });
  const disassembly = execFileSync(objdump, ['--disassemble', '--no-show-raw-insn', join(directory, 'abi.dll')], { encoding: 'utf8' }).replaceAll(directory, '<fixture>/');
  writeFileSync(join(directory, 'abi.disassembly.txt'), disassembly);
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify({
    license: 'MIT (repository LICENSE)', target_execution: 'not run; no Windows host available',
    compiler: execFileSync(clang, ['--version'], { encoding: 'utf8' }).trim(),
    linker: execFileSync(linker, ['--version'], { encoding: 'utf8' }).trim(),
    inspector: execFileSync(objdump, ['--version'], { encoding: 'utf8' }).trim(),
    commands: [[clang, ...compilerFlags], [linker, ...linkerFlags], [objdump, '--disassemble', '--no-show-raw-insn', 'abi.dll']].map(command => command.map(part => part.replaceAll(directory, '<fixture>/').replaceAll(temporary, '<temporary>'))),
    sha256: { 'abi.c': hash('abi.c'), 'abi.dll': hash('abi.dll'), 'abi.disassembly.txt': hash('abi.disassembly.txt') },
  }, null, 2) + '\n');
} finally { rmSync(temporary, { recursive: true, force: true }); }
