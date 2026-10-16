// SPDX-License-Identifier: MIT
// Developer-only generation. No target execution, Linux SDK, CRT, downloads or test-time compiler.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectELF } from './inspect-elf.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(root);
const llvm = process.env['LLVM_BIN'] ?? '/opt/homebrew/opt/llvm/bin';
const clang = process.env['ELF_CC'] ?? join(llvm, 'clang');
const linker = process.env['LD_LLD'] ?? join(llvm, 'ld.lld');
const temporary = mkdtempSync(join(tmpdir(), 'open-decomp-elf-'));
const commands: { executable: string; arguments: string[] }[] = [];
function run(executable: string, args: string[], record = true): string {
  const result = spawnSync(executable, args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', SOURCE_DATE_EPOCH: '0' } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed: ${result.stderr}`);
  if (record) commands.push({ executable, arguments: args.map(arg => arg.replaceAll(temporary, '<temporary>')) });
  return result.stdout;
}
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const record = (path: string) => { const bytes = readFileSync(path); return { path, size: bytes.length, sha256: hash(bytes) }; };
try {
  for (const path of ['fixtures/bin', 'fixtures/metadata', 'fixtures/code/elf-x86_64']) mkdirSync(path, { recursive: true });
  const tools = Object.fromEntries([['clang', clang], ['lld', linker], ['readobj', join(llvm, 'llvm-readobj')], ['objdump', join(llvm, 'llvm-objdump')], ['objcopy', join(llvm, 'llvm-objcopy')]].map(([name, path]) => [name!, { path: path!, version: run(path!, ['--version'], false).trim(), sha256: hash(readFileSync(path!)) }]));
  const flags = ['--target=x86_64-unknown-linux-gnu', '-std=c11', '-O1', '-g', '-ffreestanding', '-fPIC', '-ffp-contract=off', '-fno-vectorize', '-fno-slp-vectorize', '-fno-stack-protector', '-fno-builtin', `-ffile-prefix-map=${root}=.`, `-fdebug-prefix-map=${root}=.`, '-c'];
  const objects = ['corpus', 'check', 'elf-entry', 'elf-native'].map(name => {
    const object = join(temporary, `${name}.o`);
    run(clang, [...flags, `fixtures/source/${name}.c`, '-o', object]);
    return object;
  });
  const dependency = 'fixtures/bin/libfixture-native.so';
  run(linker, ['-m', 'elf_x86_64', '--build-id=none', '-shared', '--soname=libfixture-native.so', '-o', dependency, objects[3]!]);
  const linked = ['--build-id=none', '-m', 'elf_x86_64', '-z', 'noexecstack', '--hash-style=both', ...objects.slice(0, 3), dependency];
  run(linker, [...linked, '--export-dynamic', '--entry=fixture_entry', '--image-base=0x400000', '--dynamic-linker=/lib64/ld-linux-x86-64.so.2', '-o', 'fixtures/bin/elf-x86_64-symbols']);
  run(linker, [...linked, '-shared', '-Bsymbolic', '--soname=libcorpus-elf-x86_64.so', '-o', 'fixtures/bin/libcorpus-elf-x86_64-symbols.so']);
  for (const [source, output] of [['elf-x86_64-symbols', 'elf-x86_64-stripped'], ['libcorpus-elf-x86_64-symbols.so', 'libcorpus-elf-x86_64-stripped.so']]) {
    run(join(llvm, 'llvm-objcopy'), ['--strip-all', `fixtures/bin/${source}`, `fixtures/bin/${output}`]);
  }
  const files = ['elf-x86_64-symbols', 'elf-x86_64-stripped', 'libcorpus-elf-x86_64-symbols.so', 'libcorpus-elf-x86_64-stripped.so', 'libfixture-native.so'];
  const images = files.map(name => {
    const path = `fixtures/bin/${name}`, facts = inspectELF(readFileSync(path));
    const metadataPath = `fixtures/metadata/${name}.txt`, disassemblyPath = `fixtures/metadata/${name}.disassembly.txt`;
    writeFileSync(metadataPath, run(join(llvm, 'llvm-readobj'), ['--file-headers', '--program-headers', '--sections', '--symbols', '--dyn-symbols', '--dynamic-table', '--needed-libs', '--relocations', path]));
    writeFileSync(disassemblyPath, run(join(llvm, 'llvm-objdump'), ['--disassemble', path]));
    const arithmetic = facts.functions.find(fn => fn.name === 'fixture_arithmetic');
    const string = facts.functions.find(fn => fn.name === 'fixture_string');
    return { ...record(path), facts, symbolState: name.includes('stripped') ? 'stripped' : 'symbol-bearing', metadataPath, metadataSha256: record(metadataPath).sha256, disassemblyPath, disassemblySha256: record(disassemblyPath).sha256, workflow: arithmetic && string ? { arithmetic: arithmetic.address, entry: string.address } : null };
  });
  const parent = images.find(image => image.path === 'fixtures/bin/libcorpus-elf-x86_64-symbols.so')!;
  const bytes = readFileSync(parent.path);
  const codeRanges = parent.facts.functions.filter(fn => /^fixture_/.test(fn.name)).map(fn => {
    const path = `fixtures/code/elf-x86_64/${fn.name}.bin`;
    writeFileSync(path, bytes.subarray(fn.fileOffset, fn.fileOffset + fn.size));
    return { ...record(path), architecture: 'x86_64', format: 'elf', abi: 'sysv-amd64', image: parent.path, symbol: fn.name, address: fn.address, fileOffset: fn.fileOffset, boundaryEvidence: 'ELF STT_FUNC st_value/st_size from compiler symbol table; independently recorded by llvm-readobj' };
  });
  const sourcePaths = ['fixtures/source/corpus.h', 'fixtures/source/corpus.c', 'fixtures/source/check.c', 'fixtures/source/elf-entry.c', 'fixtures/source/elf-native.c', 'fixtures/expected.json', 'fixtures/inventory.json', 'fixtures/LICENSE', 'scripts/fixtures/generate-elf.ts', 'scripts/fixtures/inspect-elf.ts'];
  writeFileSync('fixtures/elf-manifest.json', JSON.stringify({ schemaVersion: 1, license: 'MIT', target_execution: 'never executed; offline static analysis only', tools, commands, sourceFiles: sourcePaths.map(record), images, codeRanges, expected: 'fixtures/expected.json', inventory: 'fixtures/inventory.json', malformed: [], notes: ['SDK/CRT-free LLVM cross-compilation; explicit analysis entry is not process startup.', 'Stripping removes static/debug symbols; dynamic exports/imports and symbol-sized function ranges remain.', 'DT_NEEDED does not attribute individual imports to libraries.', 'ELF ranges use code/elf-x86_64, never overwrite Windows code/x86_64.'] }, null, 2) + '\n');
  console.log(`Generated ELF corpus: ${images.map(image => image.path).join(', ')}; fixtures/elf-manifest.json; fixtures/code/elf-x86_64/*.bin; fixtures/metadata/*elf* and libfixture-native.so reports.`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
