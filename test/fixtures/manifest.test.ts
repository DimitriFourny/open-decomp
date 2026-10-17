// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { z } from 'zod';
import { parseHexU64 } from '../../src/core/integers.js';
import { inspectMachO, inspectPE } from '../../scripts/fixtures/inspect.js';
import { evaluate, expectedSchema } from './oracle.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const read=(path:string):Buffer=>readFileSync(resolve(root,path));
const json=(path:string):unknown=>JSON.parse(read(path).toString('utf8')) as unknown;
const hash=(bytes:Buffer):string=>createHash('sha256').update(bytes).digest('hex');
const hashSchema=z.string().regex(/^[0-9a-f]{64}$/);
const addressSchema=z.string().refine(s=>{try{parseHexU64(s);return true;}catch{return false;}});
const rangeSchema=z.object({name:z.string(),address:addressSchema,fileOffset:z.number().int().nonnegative(),size:z.number().int().positive()});
const factsSchema=z.object({
  format:z.enum(['macho','pe']),architecture:z.enum(['arm64','x86_64']),kind:z.enum(['executable','library']),
  imageBase:addressSchema,entryAddress:addressSchema.nullable(),
  mappings:z.array(z.object({name:z.string(),address:addressSchema,virtualSize:z.number().int().nonnegative(),fileOffset:z.number().int().nonnegative(),fileSize:z.number().int().nonnegative()})),
  functions:z.array(rangeSchema),symbols:z.array(z.string()),imports:z.array(z.string()),exports:z.array(z.string()),
  directories:z.array(z.object({index:z.number().int(),rva:z.number().int().nonnegative(),size:z.number().int().nonnegative()})),
});
const artifactSchema=z.object({path:z.string(),size:z.number().int().nonnegative(),sha256:hashSchema});
const manifestSchema=z.object({
  schemaVersion:z.literal(1),license:z.literal('MIT'),sourceFiles:z.array(z.object({path:z.string(),sha256:hashSchema})),
  images:z.array(artifactSchema.extend({facts:factsSchema.nullable(),slices:z.array(z.object({architecture:z.enum(['arm64','x86_64']),offset:z.number().int().nonnegative(),size:z.number().int().positive(),sha256:hashSchema})),metadataPath:z.string(),metadataSha256:hashSchema,disassemblyPath:z.string(),disassemblySha256:hashSchema,symbolState:z.enum(['debug-stripped','symbol-bearing'])})),
  codeRanges:z.array(artifactSchema.extend({architecture:z.enum(['arm64','x86_64']),image:z.string(),symbol:z.string(),address:addressSchema,fileOffset:z.number().int().nonnegative(),boundaryEvidence:z.string()})),
  malformed:z.array(artifactSchema.extend({source:z.string(),mutation:z.string(),expected:z.string()})),
  expected:z.string(),inventory:z.string(),loaderExpectations:z.string(),rebuild:z.string(),
  commands:z.array(z.object({executable:z.string(),arguments:z.array(z.string())})),tools:z.object({clang:z.string(),lld:z.string(),appleLinker:z.string()}),notes:z.array(z.string()),
});
const manifest=manifestSchema.parse(json('fixtures/manifest.json'));
const expected=expectedSchema.parse(json(manifest.expected));
function image(path:string) {
  const value=manifest.images.find(i=>i.path===`fixtures/bin/${path}`);
  assert.ok(value,`Missing fixture ${path}`);return value;
}

test('independent data/zero-fill and relocation expectations match physical fields, not just generated facts',()=>{
  const facts=z.object({
    macho:z.object({path:z.string(),zeroFill:z.object({address:addressSchema,size:z.number().int(),sectionFileOffset:z.number().int(),sectionType:z.number().int()}),message:z.object({address:addressSchema,bytes:z.string()})}),
    pe:z.object({path:z.string(),callback:z.object({fileOffset:z.number().int(),targetAddress:addressSchema}),message:z.object({fileOffset:z.number().int(),bytes:z.string()})}),
    universal:z.object({offset:z.number().int(),size:z.number().int()}),
  }).parse(json(manifest.loaderExpectations));
  const mac=read(facts.macho.path);
  let command=32, found=0;
  for(let n=0;n<mac.readUInt32LE(16);n++) {
    if(mac.readUInt32LE(command)===0x19)for(let i=0;i<mac.readUInt32LE(command+64);i++) {
      const s=command+72+i*80;
      if(mac.toString('ascii',s,s+16).replace(/\0.*$/s,'')!=='__common')continue;
      found++;assert.equal(mac.readBigUInt64LE(s+32),parseHexU64(facts.macho.zeroFill.address));
      assert.equal(Number(mac.readBigUInt64LE(s+40)),facts.macho.zeroFill.size);
      assert.equal(mac.readUInt32LE(s+48),facts.macho.zeroFill.sectionFileOffset);
      assert.equal(mac.readUInt32LE(s+64)&0xff,facts.macho.zeroFill.sectionType);
    }
    command+=mac.readUInt32LE(command+4);
  }
  assert.equal(found,1);
  const messageOffset=Number(parseHexU64(facts.macho.message.address)-0x100000000n);
  assert.deepEqual(mac.subarray(messageOffset,messageOffset+Buffer.byteLength(facts.macho.message.bytes)),Buffer.from(facts.macho.message.bytes));
  const dll=read(facts.pe.path);
  assert.equal(dll.readBigUInt64LE(facts.pe.callback.fileOffset),parseHexU64(facts.pe.callback.targetAddress));
  assert.deepEqual(dll.subarray(facts.pe.message.fileOffset,facts.pe.message.fileOffset+Buffer.byteLength(facts.pe.message.bytes)),Buffer.from(facts.pe.message.bytes));
  // Independent LLD debug-directory record: Type CodeView but no RSDS signature/PDB identity.
  assert.equal(dll.readUInt32LE(0xcd8+12),2);assert.equal(dll.readUInt32LE(0xcd8+16),25);
  assert.equal(dll.readUInt32LE(0xcd8+20),0x20f4);assert.equal(dll.readUInt32LE(0xcf4),0);
  assert.equal(facts.universal.offset,32768);assert.equal(facts.universal.size,52368);
});

test('all fixture inputs, recipes and independent tool evidence match recorded SHA-256',()=>{
  assert.equal(manifest.images.length,9);
  assert.equal(manifest.malformed.length,13);
  assert.equal(manifest.codeRanges.length,32);
  for(const entry of [...manifest.images,...manifest.malformed,...manifest.codeRanges]) {
    const bytes=read(entry.path);assert.equal(bytes.length,entry.size,entry.path);assert.equal(hash(bytes),entry.sha256,entry.path);
  }
  for(const entry of manifest.sourceFiles)assert.equal(hash(read(entry.path)),entry.sha256,entry.path);
  for(const entry of manifest.images) {
    assert.equal(hash(read(entry.metadataPath)),entry.metadataSha256);
    assert.equal(hash(read(entry.disassemblyPath)),entry.disassemblySha256);
    if(entry.facts)assert.deepEqual(entry.facts.format==='macho'?inspectMachO(read(entry.path)):inspectPE(read(entry.path)),entry.facts);
    for(const mapping of entry.facts?.mappings??[])assert.ok(mapping.fileOffset+mapping.fileSize<=entry.size,`${entry.path} ${mapping.name}`);
  }
});

test('Mach-O facts establish entry, import, stripped symbols and an exact ARM64 universal slice',()=>{
  const symbols=image('macho-arm64-symbols'), stripped=image('macho-arm64-stripped'), library=image('libcorpus-arm64-symbols.dylib');
  assert.equal(symbols.facts?.entryAddress,'0x100000a8c');
  assert.equal(symbols.facts?.imageBase,'0x100000000');
  assert.equal(symbols.facts?.architecture,'arm64');
  assert.deepEqual(symbols.facts?.imports,['_puts']);
  assert.ok(symbols.facts?.symbols.includes('_fixture_arithmetic'));
  assert.equal(stripped.facts?.symbols.includes('_fixture_arithmetic'),false);
  assert.equal(stripped.facts?.entryAddress,symbols.facts?.entryAddress);
  assert.equal(library.facts?.kind,'library');assert.equal(library.facts?.entryAddress,null);
  assert.ok(library.facts?.exports.includes('_fixture_arithmetic'));
  assert.ok(image('libcorpus-arm64-stripped.dylib').facts?.exports.includes('_fixture_arithmetic'));
  const universal=image('macho-universal'), arm=universal.slices.find(s=>s.architecture==='arm64');assert.ok(arm);
  assert.deepEqual(read(universal.path).subarray(arm.offset,arm.offset+arm.size),read(symbols.path));
  assert.equal(arm.sha256,symbols.sha256);assert.deepEqual(universal.slices.map(s=>s.architecture).sort(),['arm64','x86_64']);
});

test('PE32+ facts establish Windows imports, exports, relocation/unwind metadata and zero-fill',()=>{
  const exe=image('pe-x86_64-symbols.exe'), dll=image('corpus-symbols.dll'), stripped=image('corpus-stripped.dll');
  const bytes=read(exe.path), p=bytes.readUInt32LE(0x3c);
  assert.equal(bytes.readUInt16LE(p+4),0x8664);assert.equal(bytes.readUInt16LE(p+24),0x20b);
  assert.equal(exe.facts?.entryAddress,'0x140001000');assert.equal(exe.facts?.imageBase,'0x140000000');
  assert.deepEqual(exe.facts?.imports,['KERNEL32.dll!ExitProcess','corpus-symbols.dll!fixture_check']);
  assert.equal(dll.facts?.imageBase,'0x180000000');assert.equal(dll.facts?.entryAddress,null);
  assert.ok(dll.facts?.exports.includes('fixture_arithmetic'));assert.deepEqual(stripped.facts?.exports,dll.facts?.exports);
  assert.ok(dll.facts?.directories.find(d=>d.index===3 && d.size===72));
  assert.ok(dll.facts?.directories.find(d=>d.index===5 && d.size===12));
  const data=dll.facts?.mappings.find(m=>m.name==='.data');assert.ok(data);assert.equal(data.virtualSize-data.fileSize,20);
  assert.ok(dll.facts?.mappings.some(m=>m.name==='.debug_info'));
  assert.equal(stripped.facts?.mappings.some(m=>m.name.startsWith('.debug')),false);
});

test('raw compiler function bytes are independently addressable without a loader or sibling API',()=>{
  for(const range of manifest.codeRanges) {
    const parent=image(range.image.slice('fixtures/bin/'.length)), bytes=read(parent.path);
    assert.deepEqual(read(range.path),bytes.subarray(range.fileOffset,range.fileOffset+range.size));
    const symbol=parent.facts?.functions.find(f=>f.name===range.symbol);assert.ok(symbol);
    assert.equal(range.address,symbol.address);assert.equal(range.size,symbol.size);
    if(range.architecture==='arm64')assert.equal(range.size%4,0);
  }
  const arithmetic=manifest.codeRanges.find(r=>r.architecture==='arm64' && r.symbol==='_fixture_arithmetic');assert.ok(arithmetic);
  assert.equal(arithmetic.address,'0x100000574');assert.equal(arithmetic.fileOffset,1396);assert.equal(arithmetic.size,20);
  assert.equal(read(arithmetic.path).readUInt32LE(0),0x0b010428);assert.equal(read(arithmetic.path).readUInt32LE(16),0xd65f03c0);
  const x86=manifest.codeRanges.find(r=>r.architecture==='x86_64' && r.symbol==='fixture_arithmetic');assert.ok(x86);
  assert.equal(x86.address,'0x180001030');assert.deepEqual([...read(x86.path).subarray(0,9)],[0x8d,0x04,0x52,0x01,0xc8,0x83,0xf0,0x55,0xc3]);
});

test('malformed boundaries contain the advertised exact mutations, not unexplained synthetic containers',()=>{
  for(const entry of manifest.malformed) {
    const b=read(entry.path);
    switch(entry.path.split('/').at(-1)) {
      case 'empty.bin':assert.equal(b.length,0);break;
      case 'macho-header-truncated.bin':assert.equal(b.length,31);break;
      case 'macho-command-overrun.bin':assert.equal(b.readUInt32LE(36),0xfffffff8);break;
      case 'macho-command-zero.bin':assert.equal(b.readUInt32LE(36),0);break;
      case 'macho-unsupported-cpu.bin':assert.equal(b.readUInt32LE(4),18);break;
      case 'fat-slice-overrun.bin':assert.equal(b.readUInt32BE(16),0xfffff000);break;
      case 'pe-dos-truncated.bin':assert.equal(b.length,63);break;
      case 'pe-header-overrun.bin':assert.equal(b.readUInt32LE(0x3c),0xfffffff0);break;
      case 'pe-section-overrun.bin':{const p=b.readUInt32LE(0x3c);assert.equal(b.readUInt32LE(p+24+b.readUInt16LE(p+20)+20),0xfffffff0);break;}
      case 'pe-directory-overrun.bin':assert.equal(b.readUInt32LE(b.readUInt32LE(0x3c)+24+120),0xfffff000);break;
      case 'pe-unsupported-machine.bin':assert.equal(b.readUInt16LE(b.readUInt32LE(0x3c)+4),0x1c4);break;
      case 'arm64-trailing-byte.bin':assert.equal(b.length%4,3);assert.deepEqual(b,read(entry.source).subarray(0,-1));break;
      case 'x86-call-truncated.bin':assert.equal(b.length,3);assert.equal(b[0],0xe8);assert.deepEqual(b,read(entry.source).subarray(8,11));break;
      default:assert.fail(`Unasserted malformed fixture ${entry.path}`);
    }
  }
});

test('all deterministic source expectations agree with isolated finite-width/FP/vector oracles',()=>{
  assert.equal(expected.cases.length,24);
  for(const c of expected.cases)assert.deepEqual(evaluate(c),{result:c.result,...(c.memoryAfter===undefined?{}:{memoryAfter:c.memoryAfter})},`${c.function} ${JSON.stringify(c.arguments)}`);
  const inventory=z.object({functions:z.array(z.object({name:z.string(),signature:z.string(),families:z.array(z.string()),arm64:z.array(z.string()),x86_64:z.array(z.string()),oracle:z.string()})),notExercised:z.array(z.string())}).parse(json(manifest.inventory));
  for(const c of expected.cases)assert.ok(inventory.functions.some(f=>f.name===c.function && f.families.includes(c.family)),`${c.function}/${c.family}`);
  for(const f of inventory.functions) {
    assert.ok(manifest.codeRanges.some(r=>r.architecture==='arm64' && r.symbol===`_${f.name}`));
    assert.ok(manifest.codeRanges.some(r=>r.architecture==='x86_64' && r.symbol===f.name));
  }
});
