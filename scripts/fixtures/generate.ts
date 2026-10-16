// SPDX-License-Identifier: MIT
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectMachO, inspectPE } from './inspect.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(root);
const llvm = process.env.LLVM_BIN ?? '/opt/homebrew/opt/llvm/bin';
const cc = process.env.CC ?? '/usr/bin/clang';
const linker = process.env.LLD_LINK ?? 'lld-link';
const tool = (name: string): string => `${llvm}/${name}`;
const commands: { executable: string; arguments: string[] }[] = [];
function run(executable: string, args: string[], record = true): string {
  const result = spawnSync(executable, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`${executable} ${args.join(' ')}\n${result.error?.message ?? result.stderr}`);
  if (record) commands.push({ executable, arguments: args });
  return result.stdout + result.stderr;
}
const version = (path: string): string => run(path,['--version'],false).trim();
const versions = {
  clang:version(cc), lld:version(linker), appleLinker:run('/usr/bin/ld',['-v'],false).trim(),
  objcopy:version(tool('llvm-objcopy')), readobj:version(tool('llvm-readobj')), objdump:version(tool('llvm-objdump')),
  node:process.version, sdk:run('/usr/bin/xcrun',['--show-sdk-path'],false).trim(),
  toolHashes:['/usr/bin/ld','/usr/bin/strip','/usr/bin/lipo',tool('llvm-dlltool')].map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')})),
};
for (const p of ['fixtures/bin','fixtures/malformed','fixtures/metadata','fixtures/.build']) mkdirSync(p,{recursive:true});
const common = ['-std=c11','-O1','-g','-ffp-contract=off','-fno-vectorize','-fno-slp-vectorize','-fno-stack-protector','-fno-builtin',`-ffile-prefix-map=${root}=.`,`-fdebug-prefix-map=${root}=.`];
const mac = ['-target','arm64-apple-macos13.0',...common];
run(cc,[...mac,'-DFIXTURE_MAIN','fixtures/source/corpus.c','fixtures/source/check.c','-o','fixtures/bin/macho-arm64-symbols']);
run(cc,[...mac,'-dynamiclib','fixtures/source/corpus.c','fixtures/source/check.c','-Wl,-install_name,@rpath/libcorpus.dylib','-o','fixtures/bin/libcorpus-arm64-symbols.dylib']);
copyFileSync('fixtures/bin/macho-arm64-symbols','fixtures/bin/macho-arm64-stripped');
run('/usr/bin/strip',['fixtures/bin/macho-arm64-stripped']);
copyFileSync('fixtures/bin/libcorpus-arm64-symbols.dylib','fixtures/bin/libcorpus-arm64-stripped.dylib');
run('/usr/bin/strip',['-S','-x','fixtures/bin/libcorpus-arm64-stripped.dylib']);
run(cc,['-target','x86_64-apple-macos13.0',...common,'-DFIXTURE_MAIN','fixtures/source/corpus.c','fixtures/source/check.c','-o','fixtures/.build/macho-x86_64']);
run('/usr/bin/lipo',['-create','fixtures/bin/macho-arm64-symbols','fixtures/.build/macho-x86_64','-output','fixtures/bin/macho-universal']);
const win = ['--target=x86_64-pc-windows-msvc',...common,'-gdwarf','-c'];
run(cc,[...win,'fixtures/source/corpus.c','-o','fixtures/.build/corpus.obj']);
run(cc,[...win,'fixtures/source/check.c','-o','fixtures/.build/check-library.obj']);
run(linker,['/dll','/noentry','/nodefaultlib','/machine:x64','/timestamp:0','/debug:dwarf','/base:0x180000000','/out:fixtures/bin/corpus-symbols.dll','/implib:fixtures/.build/corpus.lib','fixtures/.build/corpus.obj','fixtures/.build/check-library.obj']);
run(tool('llvm-dlltool'),['-m','i386:x86-64','-d','fixtures/source/kernel32.def','-l','fixtures/.build/kernel32.lib']);
run(cc,[...win,'-DFIXTURE_IMPORT','-DFIXTURE_WINDOWS_ENTRY','fixtures/source/check.c','-o','fixtures/.build/entry.obj']);
run(linker,['/nodefaultlib','/machine:x64','/subsystem:console','/entry:fixture_entry','/timestamp:0','/debug:dwarf','/base:0x140000000','/out:fixtures/bin/pe-x86_64-symbols.exe','fixtures/.build/entry.obj','fixtures/.build/corpus.lib','fixtures/.build/kernel32.lib']);
run(tool('llvm-objcopy'),['--strip-debug','fixtures/bin/corpus-symbols.dll','fixtures/bin/corpus-stripped.dll']);
run(tool('llvm-objcopy'),['--strip-debug','fixtures/bin/pe-x86_64-symbols.exe','fixtures/bin/pe-x86_64-stripped.exe']);
const files = ['macho-arm64-symbols','macho-arm64-stripped','libcorpus-arm64-symbols.dylib','libcorpus-arm64-stripped.dylib','macho-universal','corpus-symbols.dll','corpus-stripped.dll','pe-x86_64-symbols.exe','pe-x86_64-stripped.exe'];
const hash = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const images = files.map(name => {
  const path = `fixtures/bin/${name}`, bytes = readFileSync(path);
  const universal = name === 'macho-universal';
  const facts = universal ? null : name.includes('.dll') || name.endsWith('.exe') ? inspectPE(bytes) : inspectMachO(bytes);
  const metadataPath = `fixtures/metadata/${name}.txt`;
  writeFileSync(metadataPath,run(tool('llvm-readobj'),['--file-headers','--sections','--symbols','--macho-segment','--macho-dysymtab','--macho-indirect-symbols','--coff-imports','--coff-exports','--coff-basereloc','--coff-debug-directory','--unwind',path]));
  writeFileSync(`fixtures/metadata/${name}.disassembly.txt`,run(tool('llvm-objdump'),['--disassemble',path]));
  let slices: { architecture:string; offset:number; size:number; sha256:string }[] = [];
  if (universal) {
    for (let i=0;i<bytes.readUInt32BE(4);i++) {
      const s=8+i*20, offset=bytes.readUInt32BE(s+8), size=bytes.readUInt32BE(s+12);
      slices.push({architecture:bytes.readUInt32BE(s)===0x100000c?'arm64':'x86_64',offset,size,sha256:hash(bytes.subarray(offset,offset+size))});
    }
  }
  return { path, size:bytes.length, sha256:hash(bytes), facts, slices, metadataPath, metadataSha256:hash(readFileSync(metadataPath)), disassemblyPath:`fixtures/metadata/${name}.disassembly.txt`, disassemblySha256:hash(readFileSync(`fixtures/metadata/${name}.disassembly.txt`)), symbolState:name.includes('stripped')?'debug-stripped':'symbol-bearing' };
});
const codeRanges: {path:string;sha256:string;size:number;architecture:string;image:string;symbol:string;address:string;fileOffset:number;boundaryEvidence:string}[] = [];
for (const image of images.filter(i=>i.path==='fixtures/bin/macho-arm64-symbols' || i.path==='fixtures/bin/corpus-symbols.dll')) {
  const facts=image.facts!;
  mkdirSync(`fixtures/code/${facts.architecture}`,{recursive:true});
  const bytes=readFileSync(image.path);
  for(const fn of facts.functions.filter(f=>f.name.replace(/^_/,'').startsWith('fixture_'))) {
    const path=`fixtures/code/${facts.architecture}/${fn.name.replace(/^_/,'')}.bin`, code=bytes.subarray(fn.fileOffset,fn.fileOffset+fn.size);
    writeFileSync(path,code);
    codeRanges.push({path,sha256:hash(code),size:code.length,architecture:facts.architecture,image:image.path,symbol:fn.name,address:fn.address,fileOffset:fn.fileOffset,boundaryEvidence:'Compiler text symbol to next text symbol; final symbol to text section end. Includes compiler alignment padding, not a proven instruction-only extent.'});
  }
}
const malformed: {path:string;size:number;sha256:string;source:string;mutation:string;expected:string}[]=[];
function bad(name:string, source:string, mutation:string, expected:string, mutate:(b:Buffer)=>Buffer): void {
  const bytes=mutate(readFileSync(source)), path=`fixtures/malformed/${name}`;
  writeFileSync(path,bytes); malformed.push({path,size:bytes.length,sha256:hash(bytes),source,mutation,expected});
}
const macho='fixtures/bin/macho-arm64-symbols', pe='fixtures/bin/pe-x86_64-symbols.exe';
bad('empty.bin',macho,'truncate to zero bytes','reject: truncated container',b=>b.subarray(0,0));
bad('macho-header-truncated.bin',macho,'truncate to 31 bytes','reject: incomplete mach_header_64',b=>b.subarray(0,31));
bad('macho-command-overrun.bin',macho,'first load command cmdsize = 0xfffffff8','reject: load command exceeds file',b=>{b.writeUInt32LE(0xfffffff8,36);return b;});
bad('macho-command-zero.bin',macho,'first load command cmdsize = 0','reject: nonadvancing load command',b=>{b.writeUInt32LE(0,36);return b;});
bad('macho-unsupported-cpu.bin',macho,'cputype = 18 (PowerPC)','unsupported architecture, never infer host ARM64',b=>{b.writeUInt32LE(18,4);return b;});
bad('fat-slice-overrun.bin','fixtures/bin/macho-universal','first slice offset = 0xfffff000','reject: slice outside container',b=>{b.writeUInt32BE(0xfffff000,16);return b;});
bad('pe-dos-truncated.bin',pe,'truncate to 63 bytes','reject: incomplete DOS header',b=>b.subarray(0,63));
bad('pe-header-overrun.bin',pe,'e_lfanew = 0xfffffff0','reject: PE header outside file',b=>{b.writeUInt32LE(0xfffffff0,0x3c);return b;});
bad('pe-section-overrun.bin',pe,'first section PointerToRawData = 0xfffffff0','reject: raw section outside file',b=>{const p=b.readUInt32LE(0x3c);b.writeUInt32LE(0xfffffff0,p+24+b.readUInt16LE(p+20)+20);return b;});
bad('pe-directory-overrun.bin',pe,'import directory RVA = 0xfffff000','reject or explicit unmapped import directory diagnostic',b=>{b.writeUInt32LE(0xfffff000,b.readUInt32LE(0x3c)+24+120);return b;});
bad('pe-unsupported-machine.bin',pe,'COFF machine = 0x1c4 (ARMNT)','unsupported machine, never infer x86-64',b=>{b.writeUInt16LE(0x1c4,b.readUInt32LE(0x3c)+4);return b;});
bad('arm64-trailing-byte.bin','fixtures/code/arm64/fixture_arithmetic.bin','remove final byte from compiler function','decoder: trailing 3-byte incomplete instruction',b=>b.subarray(0,b.length-1));
bad('x86-call-truncated.bin','fixtures/code/x86_64/fixture_direct.bin','take bytes [8,11) of compiler CALL rel32 at function+8','decoder: 3-byte truncated 5-byte CALL rel32',b=>b.subarray(8,11));
const sourcePaths=['fixtures/source/corpus.h','fixtures/source/corpus.c','fixtures/source/check.c','fixtures/source/kernel32.def','fixtures/source/library-runner.c','fixtures/expected.json','fixtures/inventory.json','fixtures/loader-expectations.json','fixtures/LICENSE','scripts/fixtures/generate.ts','scripts/fixtures/inspect.ts','scripts/fixtures/execute-trusted.ts'];
writeFileSync('fixtures/manifest.json',JSON.stringify({
  schemaVersion:1,license:'MIT',
  sourceFiles:sourcePaths.map(path=>({path,sha256:hash(readFileSync(path))})),
  tools:versions,commands,images,codeRanges,malformed,
  expected:'fixtures/expected.json',inventory:'fixtures/inventory.json',loaderExpectations:'fixtures/loader-expectations.json',baseline:'fixtures/baseline/arm64.json',documentation:'fixtures/README.md',licenseFile:'fixtures/LICENSE',
  rebuild:'node --import tsx scripts/fixtures/generate.ts',
  notes:[
    'Real compiler/linker output; malformed files are explicitly mutated copies, never called real compiler output.',
    'Symbol ranges include compiler alignment padding; not a recovered instruction-only function-size oracle.',
    'PE exports survive debug stripping; symbol-bearing files carry DWARF, stripped files do not.',
    'No sibling checkout or compiler is required to consume prebuilt bytes.',
    'Legacy double/vector semantics, ten-argument signatures and raw indirect call contracts have explicit gaps; see inventory and baseline.',
    'The ARM64 baseline is frozen historical migration evidence, not regenerated output or a current semantic oracle.',
  ],
},null,2)+'\n');
for (const name of ['macho-arm64-symbols','macho-arm64-stripped','macho-universal']) chmodSync(`fixtures/bin/${name}`,0o755);
rmSync('fixtures/.build',{recursive:true,force:true});
console.log(`Generated ${images.length} images and ${malformed.length} malformed fixtures.`);
