// SPDX-License-Identifier: MIT
// Explicit developer action on the checked-in trusted corpus, never a server operation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const manifest=z.object({images:z.array(z.object({path:z.string(),sha256:z.string()}))}).parse(JSON.parse(readFileSync(resolve(root,'fixtures/manifest.json'),'utf8')) as unknown);
function trusted(name:string):string {
  const entry=manifest.images.find(i=>i.path===`fixtures/bin/${name}`);assert.ok(entry);
  const path=resolve(root,entry.path);
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),entry.sha256,`Untrusted modified fixture ${name}`);
  return path;
}
if(!((process.platform==='darwin' && process.arch==='arm64') || (process.platform==='win32' && process.arch==='x64'))) {
  throw new Error(`Trusted execution requires macOS arm64 or Windows x86-64; got ${process.platform}/${process.arch}. Static fixture tests remain cross-host.`);
}
const temporary=mkdtempSync(join(tmpdir(),'open-decomp-trusted-fixtures-'));
try {
  const results:{fixture:string;exitCode:number|null;stdout?:string;library?:string}[]=[];
  if(process.platform==='darwin') {
    for(const name of ['macho-arm64-symbols','macho-arm64-stripped','macho-universal']) {
      const path=join(temporary,name);copyFileSync(trusted(name),path);chmodSync(path,0o755);
      const result=spawnSync(path,[],{encoding:'utf8',cwd:temporary});
      assert.ifError(result.error);assert.equal(result.status,0,result.stderr);assert.equal(result.signal,null);
      assert.equal(result.stdout,'open-decomp trusted fixture v1\n');assert.equal(result.stderr,'');
      results.push({fixture:name,exitCode:result.status,stdout:result.stdout});
    }
  } else {
    for(const variant of ['symbols','stripped']) {
      const name=`pe-x86_64-${variant}.exe`, path=join(temporary,name);
      copyFileSync(trusted(name),path);
      // Both EXEs import corpus-symbols.dll; isolated dirs let the stripped case really use stripped DLL bytes.
      copyFileSync(trusted(`corpus-${variant}.dll`),join(temporary,'corpus-symbols.dll'));
      const result=spawnSync(path,[],{encoding:'utf8',cwd:temporary});
      assert.ifError(result.error);assert.equal(result.status,0,result.stderr);assert.equal(result.signal,null);
      assert.equal(result.stdout,'');assert.equal(result.stderr,'');
      results.push({fixture:name,library:`corpus-${variant}.dll`,exitCode:result.status});
    }
  }
  console.log(JSON.stringify({platform:process.platform,architecture:process.arch,results},null,2));
} finally { rmSync(temporary,{recursive:true,force:true}); }
