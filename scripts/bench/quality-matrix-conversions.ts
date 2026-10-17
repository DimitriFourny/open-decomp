#!/usr/bin/env node
/** Focused trusted-source smoke, not a matrix rerun or baseline target execution. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openBinary } from '../../src/api/index.js';
import { acknowledgeRequirements, emittedFormals, execute } from '../../test/emitters/c/support.js';
import { liftBytes, register, run } from '../../test/lifters/x86_64/helpers.js';
import { evaluate, fromWords, lift, registerBits } from '../../test/lifters/arm64/support.js';

const root = resolve(process.argv[2] ?? '/tmp/open-decomp-conversions');
await mkdir(root);
function command(program: string, args: string[]): string {
  const result = spawnSync(program, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const source = resolve('scripts/bench/quality-matrix-conversions.c');
const native = join(root, 'oracle');
command('/usr/bin/clang', ['-std=c11', '-O2', '-ffp-contract=off', source, '-o', native]);
const oracleText = command(native, []);
await writeFile(join(root, 'oracle.txt'), oracleText);
const oracle = oracleText.trim().split('\n').map((line) => line.split(' ').map((bits) => BigInt(`0x${bits}`)));
assert.equal(oracle.length, 13);
let x86Cases = 0, armCases = 0, outputCases = 0;
const sentinel = (1n << 512n) - 1n;
const x86Variants = [
  { prefix: 'f3', input: 32, output: 32, column: 1 },
  { prefix: 'f2', input: 32, output: 64, column: 2 },
  { prefix: 'f3 48', input: 64, output: 32, column: 3 },
  { prefix: 'f2 48', input: 64, output: 64, column: 4 },
] as const;
for (const variant of x86Variants) {
  for (const memory of [false, true]) {
    const lifted = liftBytes(`${variant.prefix} 0f 2a ${memory ? '01' : 'c1'} c3`);
    assert.ok(!lifted.diagnostics.some((d) => d.message.startsWith('Instruction family')));
    const flagWitness = liftBytes(`0c 00 ${variant.prefix} 0f 2a ${memory ? '01' : 'c1'} c3`);
    for (const row of oracle) {
      const bytes = new Uint8Array(variant.input / 8);
      const storage = new DataView(bytes.buffer);
      if (variant.input === 32) storage.setUint32(0, Number(BigInt.asUintN(32, row[0]!)), true);
      else storage.setBigUint64(0, row[0]!, true);
      const result = run(lifted.ir, { rcx: memory ? 0x10000n : row[0]!, zmm0: sentinel },
        memory ? { memory: [{ base: 0x10000n, bytes, writable: false }] } : {});
      assert.equal(register(result, 'zmm0', variant.output), row[variant.column]);
      assert.equal(register(result, 'zmm0', 512 - variant.output, variant.output),
        sentinel >> BigInt(variant.output), 'legacy SSE preserves upper vector state');
      const flags = run(flagWitness.ir, { rax: 0x80n, rcx: memory ? 0x10000n : row[0]!, zmm0: sentinel },
        memory ? { memory: [{ base: 0x10000n, bytes, writable: false }] } : {});
      // OR AL,0 establishes SF=1, CF=OF=ZF=0, PF=0; conversion must not alter them.
      assert.equal(register(flags, 'rflags', 1, 7), 1n);
      for (const offset of [0, 2, 6, 11]) assert.equal(register(flags, 'rflags', 1, offset), 0n);
      assert.equal(run(lifted.ir, { rcx: 0x10000n, zmm0: sentinel, mxcsr: 0n }).status, 'unknown');
      if (memory) assert.equal(run(lifted.ir, { rcx: 0x10000n, zmm0: sentinel }).status, 'memory_fault');
      x86Cases++;
    }
  }
}
for (const variant of [
  { word: 0x5e21d820, width: 32, column: 1 },
  { word: 0x5e61d820, width: 64, column: 4 },
  { word: 0x7e21d820, width: 32, column: 5 },
  { word: 0x7e61d820, width: 64, column: 8 },
] as const) {
  const lifted = lift(fromWords([variant.word, 0xd65f03c0]));
  assert.ok(!lifted.diagnostics.some((d) => d.message.startsWith('Unsupported ARM64 encoding')));
  const flagWitness = lift(fromWords([0xf100041f, variant.word, 0xd65f03c0]));
  for (const row of oracle) {
    const result = evaluate(lifted.ir, new Map([['arm64:v1', row[0]! | (sentinel << 64n)], ['arm64:v0', sentinel]]));
    assert.equal(registerBits(result, 'arm64:v0', 128), row[variant.column], 'scalar SIMD clears upper Vd bits');
    assert.equal(evaluate(lifted.ir, new Map([['arm64:fpcr', 1n << 22n]])).status, 'unknown');
    const flags = evaluate(flagWitness.ir, new Map([['arm64:x0', 0n], ['arm64:v1', row[0]!]]));
    assert.equal(registerBits(flags, 'arm64:nzcv', 32), 0x80000000n);
    armCases++;
  }
}
const unsupportedX86 = liftBytes('c5 f3 2a c1 c3');
assert.ok(unsupportedX86.diagnostics.some((d) => d.message.includes('VEX/EVEX')));
assert.equal(run(unsupportedX86.ir).status, 'unknown');
const unsupportedArm = lift(fromWords([0x6e61d820, 0xd65f03c0]));
assert.ok(unsupportedArm.diagnostics.some((d) => d.message.includes('Unsupported ARM64 encoding')));
assert.equal(evaluate(unsupportedArm.ir).status, 'unknown');
const binaries = [
  { target: 'arm64-apple-macos13.0', file: join(root, 'conversions.dylib'), flags: ['-dynamiclib'], prefix: '_',
    functions: [['qc_simd_s32', 1], ['qc_simd_s64', 4], ['qc_simd_u32', 5], ['qc_simd_u64', 8],
      ['qc_u64_f32', 7]] as const },
  { target: 'x86_64-unknown-linux-gnu', file: join(root, 'conversions.so'),
    flags: ['-fuse-ld=lld', '-nostdlib', '-shared'], prefix: '',
    functions: [['qc_s32_f32', 1], ['qc_s32_f64', 2], ['qc_s64_f32', 3], ['qc_s64_f64', 4]] as const },
];
const emissions: { target: string; function: string; emitter: string; text: string; state: string }[] = [];
for (const binary of binaries) {
  command('/usr/bin/clang', ['-target', binary.target, '-O2', '-ffreestanding', '-DQC_INPUT_ONLY', ...binary.flags,
    source, '-o', binary.file]);
  const session = await openBinary(binary.file, { cachePath: join(root, binary.prefix ? 'arm-cache' : 'x86-cache') });
  try {
    for (const [name, column] of binary.functions) {
      for (const emitter of ['c-like', 'python-like'] as const) {
        const result = await session.decompile({ name: binary.prefix + name }, { emitter });
        assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
        const emission = result.data.emission;
        assert.doesNotMatch(emission.text, /Instruction family cvtsi2s|Unsupported ARM64 encoding [SU]CVTF/);
        const formals = emittedFormals(emission);
        assert.equal(formals.length, 1, emission.text);
        const environment = new Map([['non-argument entry register', binary.prefix ? 0n : 0x7en]]);
        for (const row of oracle) {
          const observed = execute(emission, new Map([[formals[0]!.statement_id, row[0]!]]),
            new Map(), 0n, new Map(), environment, new Map(), acknowledgeRequirements(emission));
          assert.equal(observed.exit, 'machine_return', emission.text);
          assert.deepEqual(observed.values, [row[column]!], `${binary.target}/${name}/${emitter}/${row[0]}`);
          outputCases++;
        }
        emissions.push({ target: binary.target, function: name, emitter, text: emission.text, state: result.state });
      }
    }
  } finally { await session.close(); }
}
await writeFile(join(root, 'public-emissions.json'), JSON.stringify(emissions, null, 2) + '\n');
const evidence = { schema: 1, source, oracle_cases: oracle.length, x86_machine_cases: x86Cases,
  source_sha256: createHash('sha256').update(await readFile(source)).digest('hex'),
  oracle_sha256: createHash('sha256').update(await readFile(native)).digest('hex'),
  compiler_version: command('/usr/bin/clang', ['--version']).trim(),
  node_version: process.version,
  arm_machine_cases: armCases, both_dialect_output_cases: outputCases, public_emissions: emissions.length,
  scope: 'Trusted native C oracle; independent emitted-output interpreter; no retained matrix target execution',
  remaining: ['Non-nearest-even/trapping/FTZ/DAZ environments stay unknown; FP status remains abstracted.',
    'VEX/EVEX conversion, packed conversion, FP16/fixed-point variants remain unsupported.',
    'Historical matrix discovery, resources, source interfaces, FP assumptions are not resolved by this family.'] };
await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
