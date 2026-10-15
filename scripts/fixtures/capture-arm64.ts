// SPDX-License-Identifier: MIT
// Developer-only baseline collection. Neither app runtime nor tests import the sibling API.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { formatHexU64 } from '../../src/core/integers.js';
import { inspectMachO } from './inspect.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sibling = resolve(process.argv[2] ?? resolve(root,'../disass_arm'));
const apiPath = resolve(sibling,'src/decompiler/index.js');
interface Signature { parameters: string[]; returnType: string }
interface LegacyResult { stats: {instructions:number;blocks:number;supported:number}; diagnostics:{severity:string;message:string;address?:bigint}[]; code:string; instructions:{address:bigint;word:number;text:string;supported:boolean}[]; sourceMap:{line:number;addresses:bigint[]}[]; blocks:unknown[] }
// The caller selects an external checkout at runtime; a static sibling import would break offline consumers.
const { decompile } = await import(pathToFileURL(apiPath).href) as { decompile:(bytes:Uint8Array,options:Record<string,unknown>)=>LegacyResult };
const hash = (b:Buffer):string=>createHash('sha256').update(b).digest('hex');
const imagePath='fixtures/bin/macho-arm64-symbols', bytes=readFileSync(resolve(root,imagePath)), facts=inspectMachO(bytes);
const inventory=z.object({functions:z.array(z.object({name:z.string(),signature:z.string()}))}).parse(JSON.parse(readFileSync(resolve(root,'fixtures/inventory.json'),'utf8')) as unknown);
const signatures:Record<string,Signature> = {
  fixture_arithmetic:{parameters:['uint32_t','uint32_t'],returnType:'uint32_t'},
  fixture_maximum:{parameters:['int32_t','int32_t'],returnType:'int32_t'},
  fixture_loop:{parameters:['const void *','uint32_t'],returnType:'uint32_t'},
  fixture_stack:{parameters:['uint32_t'],returnType:'uint32_t'},
  fixture_memory:{parameters:['void *','uint64_t'],returnType:'uint64_t'},
  fixture_direct:{parameters:['uint32_t'],returnType:'uint32_t'},
  fixture_divide:{parameters:['int32_t','int32_t'],returnType:'int32_t'},
  fixture_width:{parameters:['uint32_t','uint32_t','uint32_t'],returnType:'uint64_t'},
};
const callees:Record<string,unknown>={};
for(const fn of facts.functions) {
  const name=fn.name.replace(/^_/,''), signature=signatures[name];
  if(signature) callees[fn.address]={name,...signature,abi:'darwin-arm64'};
}
mkdirSync(resolve(root,'fixtures/baseline/code'),{recursive:true});
const results=facts.functions.filter(fn=>fn.name.startsWith('_fixture_')).map(fn=>{
  const name=fn.name.slice(1), input=bytes.subarray(fn.fileOffset,fn.fileOffset+fn.size);
  const raw=decompile(input,{baseAddress:BigInt(fn.address),functionName:name});
  const signature=signatures[name];
  const contracted=signature ? decompile(input,{baseAddress:BigInt(fn.address),functionName:name,signature,callees:Object.fromEntries(Object.entries(callees).filter(([address])=>address!==fn.address))}):null;
  writeFileSync(resolve(root,`fixtures/baseline/code/${name}.c`),(contracted??raw).code+'\n');
  const output=contracted??raw;
  const outputSignature=output.code.split('\n').find(line=>line.includes(` ${name}(`) && line.endsWith(' {'));
  if(!outputSignature)throw new Error(`Missing rendered prototype for ${name}`);
  return {function:name,address:fn.address,fileOffset:fn.fileOffset,size:fn.size,inputSha256:hash(input),mode:signature?'source-derived integer signature/callee metadata':'raw API; source ABI cannot be fully expressed',sourceSignature:inventory.functions.find(f=>f.name===name)!.signature,apiSignature:signature??null,outputSignature,entryStateWarnings:output.diagnostics.filter(d=>d.message.startsWith('Entry state required')),raw,contracted};
});
const sources:{path:string;sha256:string}[]=[];
function walk(path:string):void { for(const entry of readdirSync(resolve(sibling,path),{withFileTypes:true})) {const child=`${path}/${entry.name}`; if(entry.isDirectory())walk(child);else if(/\.(?:js|ts|json)$/.test(child))sources.push({path:child,sha256:hash(readFileSync(resolve(sibling,child)))});} }
walk('src/decompiler');walk('third_parts/a64js/src');
function execute(path:string,args:string[]=[]):{command:string[];exitCode:number|null;signal:string|null;stdout:string;stderr:string;error:string|null} {
  const r=spawnSync(path,args,{encoding:'utf8',cwd:root});return {command:[path,...args],exitCode:r.status,signal:r.signal,stdout:r.stdout??'',stderr:r.stderr??'',error:r.error?.message??null};
}
const nativeExecution=process.platform==='darwin' && process.arch==='arm64' ? ['macho-arm64-symbols','macho-arm64-stripped','macho-universal'].map(n=>execute(resolve(root,`fixtures/bin/${n}`))):[];
const build=resolve(root,'fixtures/.baseline-build');mkdirSync(build,{recursive:true});
const libraryCompile=process.platform==='darwin'?execute(process.env.CC??'/usr/bin/clang',['-std=c11','-O1',resolve(root,'fixtures/source/library-runner.c'),'-o',resolve(build,'library-runner')]):null;
const libraryExecution=libraryCompile?.exitCode===0?['libcorpus-arm64-symbols.dylib','libcorpus-arm64-stripped.dylib'].map(name=>execute(resolve(build,'library-runner'),[resolve(root,`fixtures/bin/${name}`)])):[];
const harness=`#include <stdint.h>
#include <assert.h>
uint32_t fixture_arithmetic(uint32_t,uint32_t);
int32_t fixture_maximum(int32_t,int32_t);
uint32_t fixture_loop(const void *,uint32_t);
uint32_t fixture_stack(uint32_t);
uint64_t fixture_memory(void *,uint64_t);
int32_t fixture_divide(int32_t,int32_t);
uint64_t fixture_width(uint32_t,uint32_t,uint32_t);
uint32_t fixture_direct(uint32_t,uint64_t,uint64_t,uint64_t,uint64_t,uint64_t);
int main(int argc,char **argv){
(void)argv;
if(argc>1){_Alignas(16) uint64_t frame[16]={0};assert(fixture_direct(5,(uintptr_t)(frame+8),0,0,0,0)==106);return 0;}
assert(fixture_arithmetic(3,4)==90 && fixture_arithmetic(UINT32_MAX,1)==87);
assert(fixture_maximum(-7,3)==3 && fixture_maximum(-2,-8)==-2);
uint32_t a[]={1,7,19,UINT32_MAX};assert(fixture_loop(a,0)==0 && fixture_loop(a,4)==26);
assert(fixture_stack(35)==42 && fixture_stack(UINT32_MAX)==6);
uint64_t cell=UINT64_MAX;assert(fixture_memory(&cell,1)==0 && cell==0);assert(fixture_memory(&cell,42)==42 && cell==42);
assert(fixture_divide(-13,5)==-2 && fixture_divide(13,-5)==-2);
assert(fixture_width(UINT32_MAX,1,0)==UINT64_C(0x100000000));assert(fixture_width(UINT32_MAX,1,32)==1);assert(fixture_width(UINT32_MAX,1,64)==UINT64_C(0x100000000));
return 0;}
`;
writeFileSync(resolve(build,'harness.c'),harness);
const reconstructedCompile=execute(process.env.CC??'/usr/bin/clang',['-std=c11','-O1','-fsanitize=undefined',...Object.keys(signatures).map(n=>resolve(root,`fixtures/baseline/code/${n}.c`)),resolve(build,'harness.c'),'-o',resolve(build,'reconstructed')]);
const reconstructedExecution=reconstructedCompile.exitCode===0?execute(resolve(build,'reconstructed')):null;
const reconstructedDirectExecution=reconstructedCompile.exitCode===0?execute(resolve(build,'reconstructed'),['direct']):null;
// Probe public ABI boundaries directly; report rejection rather than converting FP to integers.
const signatureProbes=[['fixture_float',{parameters:['double','double'],returnType:'double'}],['fixture_stack_args',{parameters:Array<string>(10).fill('uint64_t'),returnType:'uint64_t'}]].map(([name,signature])=>{
  const fn=facts.functions.find(f=>f.name===`_${String(name)}`)!;
  try { decompile(bytes.subarray(fn.fileOffset,fn.fileOffset+fn.size),{baseAddress:BigInt(fn.address),signature});return {function:name,accepted:true,error:null}; }
  catch(error){return {function:name,accepted:false,error:error instanceof Error?error.message:String(error)};}
});
const report={schemaVersion:1,host:{platform:process.platform,architecture:process.arch,node:process.version},image:{path:imagePath,sha256:hash(bytes)},api:'src/decompiler/index.js#decompile',sourceHashes:sources,options:{unknownCalls:'strict default; source-derived contracts only where representable',noSyntheticInstructionInput:true},results,signatureProbes,nativeExecution,libraries:{compile:libraryCompile,execution:libraryExecution},reconstructed:{harness,compile:reconstructedCompile,execution:reconstructedExecution,directExecution:reconstructedDirectExecution},windowsExecution:{state:'not-run',reason:'No Windows host or Wine executable is available on this macOS ARM64 host; PE execution must be checked on Windows x86-64.'}};
writeFileSync(resolve(root,'fixtures/baseline/arm64.json'),JSON.stringify(report,(_key,value:unknown)=>typeof value==='bigint'?formatHexU64(value):value,2)+'\n');
rmSync(build,{recursive:true,force:true});
console.log(JSON.stringify({functions:results.length,supported:results.map(r=>({function:r.function,...(r.contracted??r.raw).stats,errors:(r.contracted??r.raw).diagnostics.filter(d=>d.severity==='error').length})),nativeExecution,libraryCompile,libraryExecution,reconstructedCompile,reconstructedExecution,reconstructedDirectExecution,signatureProbes},null,2));
