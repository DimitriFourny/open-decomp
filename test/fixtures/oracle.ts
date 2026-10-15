// SPDX-License-Identifier: MIT
// Test-only source-level reference semantics, never imported by service/runtime code.
import { z } from 'zod';
const valueSchema = z.union([z.string(), z.array(z.string())]);
export const caseSchema = z.object({
  function:z.string(), family:z.string(), arguments:z.array(valueSchema), result:valueSchema, memoryAfter:z.string().optional(),
});
export const expectedSchema = z.object({schemaVersion:z.literal(1),cases:z.array(caseSchema),trustedExecution:z.object({successExitCode:z.literal(0),failureCodes:z.record(z.string(),z.string())}),exclusions:z.array(z.string())});
export type SemanticCase = z.infer<typeof caseSchema>;
export interface Evaluation { result:string|string[]; memoryAfter?:string }
const u32=(n:bigint):bigint=>BigInt.asUintN(32,n), u64=(n:bigint):bigint=>BigInt.asUintN(64,n);
function scalar(c:SemanticCase,index:number):string {
  const value=c.arguments[index];
  if(typeof value!=='string')throw new TypeError(`Expected scalar ${c.function} argument ${index}`);
  return value;
}
function vector(c:SemanticCase,index:number):string[] {
  const value=c.arguments[index];
  if(!Array.isArray(value))throw new TypeError(`Expected vector ${c.function} argument ${index}`);
  return value;
}
function arithmetic(a:bigint,b:bigint):bigint { return u32(u32(a+3n*b)^0x55n); }
export function evaluate(c:SemanticCase):Evaluation {
  const int=(i:number):bigint=>BigInt(scalar(c,i));
  const fp=(i:number):number=>Number(scalar(c,i));
  switch(c.function) {
    case 'fixture_arithmetic':return {result:String(arithmetic(int(0),int(1)))};
    case 'fixture_maximum':{
      const a=BigInt.asIntN(32,int(0)),b=BigInt.asIntN(32,int(1));return {result:String(a>b?a:b)};
    }
    case 'fixture_loop':{
      const values=vector(c,0), n=Number(u32(int(1)));
      if(n>values.length)throw new RangeError('Oracle array bounds');
      return {result:String(values.slice(0,n).reduce((sum,v)=>u32(sum+BigInt(v)),0n))};
    }
    case 'fixture_stack':return {result:String(u32(int(0)+7n))};
    case 'fixture_memory':{
      const memoryAfter=String(u64(int(0)+int(1)));return {result:memoryAfter,memoryAfter};
    }
    case 'fixture_direct':return {result:String(u32(u32(int(0)+7n)+arithmetic(int(0),2n)))};
    case 'fixture_indirect':{
      if(scalar(c,0)!=='fixture_stack')throw new Error('No oracle contract for this callback');
      return {result:String(u32(u32(int(1)+7n)+1n))};
    }
    case 'fixture_divide':{
      const a=BigInt.asIntN(32,int(0)),b=BigInt.asIntN(32,int(1));
      if(b===0n || (a===-0x80000000n && b===-1n))throw new RangeError('Undefined source C division');
      return {result:String(a/b)};
    }
    case 'fixture_width':return {result:String((u32(int(0))+u32(int(1)))>>(int(2)&63n))};
    case 'fixture_stack_args':return {result:String(u64(c.arguments.reduce<bigint>((sum,_,i)=>sum+BigInt(i+1)*int(i),0n)))};
    case 'fixture_float':return {result:String(fp(0)*1.5+fp(1)/2)};
    case 'fixture_vector':{
      const a=vector(c,0),b=vector(c,1);
      if(a.length!==4 || b.length!==4)throw new RangeError('Expected four lanes');
      return {result:a.map((v,i)=>String(Math.fround(Math.fround(Math.fround(Number(v))*2)+Math.fround(Number(b[i]!)))))};
    }
    case 'fixture_vector_integer':{
      const a=vector(c,0),b=vector(c,1);
      if(a.length!==4 || b.length!==4)throw new RangeError('Expected four lanes');
      return {result:a.map((v,i)=>String(u32(u32(BigInt(v)+BigInt(b[i]!))^0x55n)))};
    }
    case 'fixture_variadic':{
      const count=Number(u32(int(0)));
      if(count!==c.arguments.length-1)throw new RangeError('Vararg count mismatch');
      let sum=0;for(let i=1;i<=count;i++)sum+=fp(i);return {result:String(sum)};
    }
    case 'fixture_string':return {result:'open-decomp trusted fixture v1'};
    default:throw new Error(`No oracle for ${c.function}`);
  }
}
