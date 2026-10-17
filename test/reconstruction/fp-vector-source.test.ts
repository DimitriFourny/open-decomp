import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { openBinary, type BinarySession } from '../../src/api/index.js';
import { execute } from '../emitters/c/support.js';

const variadicCases = [
  [],
  [7.5],
  [4, -2, 0.5],
  [2 ** -1022, 2 ** -1022, -(2 ** -1022), Number.MIN_VALUE, 0],
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  [2 ** 52, 1, -(2 ** 52)],
] as const;
const vectorCases = [
  [[1, -2, 0, 3.125], [3, 4, -0, 10]],
  [[2 ** -126, 2 ** -149, 2 ** 24, -0], [-(2 ** -126), 2 ** -149, 1, -0]],
  [[2 ** 120, -(2 ** 120), 1.25, -2.5], [-(2 ** 120), 2 ** 120, -2.5, 5]],
] as const;
const mixedCases = [[0, 4, 3], [7, -2, 0.5], [0xffffffff, 0.5, -1.5]] as const;
const storage = new DataView(new ArrayBuffer(8));
function floatBits(value: number, width: 32 | 64): bigint {
  if (width === 32) {
    storage.setFloat32(0, value, true);
    return BigInt(storage.getUint32(0, true));
  }
  storage.setFloat64(0, value, true);
  return storage.getBigUint64(0, true);
}
function floatNumber(value: bigint): number {
  storage.setBigUint64(0, value, true);
  return storage.getFloat64(0, true);
}
function vectorBits(lanes: readonly number[]): bigint {
  let packed = 0n;
  for (const [lane, value] of lanes.entries()) packed |= floatBits(value, 32) << BigInt(lane * 32);
  return packed;
}
function store(memory: Map<bigint, number>, address: bigint, bits: bigint, size: number): void {
  for (let byte = 0; byte < size; byte++)
    memory.set(address + BigInt(byte), Number((bits >> BigInt(byte * 8)) & 255n));
}
function formals(emission: Parameters<typeof execute>[0], args: readonly bigint[], entrySp: bigint): Map<string, bigint> {
  const result = new Map<string, bigint>();
  const python = /^def /m.test(emission.text);
  const headerEnd = python ? emission.text.indexOf(':\n') : emission.text.indexOf('{');
  const seen = new Set<number>();
  for (const mapping of emission.mappings) {
    if (mapping.end > headerEnd) continue;
    const text = emission.text.slice(mapping.start, mapping.end).trim();
    const match = python
      ? /^(arg(\d+)|entry_sp)\s*:\s*[^,\n]+,?$/.exec(text)
      : /^\S+\s+(arg(\d+)|entry_sp),?$/.exec(text);
    if (!match) continue;
    if (match[1] === 'entry_sp') result.set(mapping.statement_id, entrySp);
    else {
      const index = Number(match[2]);
      assert.ok(index < args.length, `Unexpected formal ${match[1]}: ${emission.text}`);
      seen.add(index);
      result.set(mapping.statement_id, args[index]!);
    }
  }
  assert.equal(seen.size, args.length, emission.text);
  return result;
}

// The native source oracle and the independent OUTPUT interpreter share only
// concrete inputs. No IR interpreter or target image is executed by the product.
// Supported environment: nearest-even, gradual underflow, disabled traps, finite
// arithmetic and no contraction. Unobserved preserved entry registers are chosen
// as zero; this never supplies a missing source argument or a call remainder.
test(
  'source-built Darwin varargs, vector lanes/results/stores and mixed calls survive both dialects',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-fp-vector-regression-'));
    let session: BinarySession | undefined;
    t.after(async () => {
      await session?.close();
      await rm(root, { recursive: true, force: true });
    });
    const binary = join(root, 'fp-vector');
    const compiled = spawnSync('/usr/bin/clang', [
      '-target', 'arm64-apple-macos13.0', '-O1', '-ffp-contract=off', '-fno-builtin',
      resolve('test/reconstruction/fp-vector-source.c'), '-o', binary,
    ], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);
    const native = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    const oracle = new Map<string, readonly bigint[]>();
    for (const line of native.stdout.trim().split('\n')) {
      const [name, index, ...bits] = line.split(' ');
      assert.ok(name && index && bits.length);
      oracle.set(`${name}:${index}`, bits.map((value) => BigInt(`0x${value}`)));
    }
    assert.equal(oracle.size, variadicCases.length + vectorCases.length * 2 + mixedCases.length);
    session = await openBinary(binary, { cachePath: join(root, 'cache') });
    const environment = new Map<string, bigint>();
    environment.set('FPCR environment', 0n);
    environment.set('call clobbers fpcr', 0n);
    environment.set('non-argument entry register', 0n);
    const entrySp = 0x9000n;
    for (const emitter of ['c-like', 'python-like'] as const) {
      const variadic = await session.decompile({ name: '_fixture_variadic' }, { emitter });
      assert.ok('data' in variadic && variadic.data.delivery === 'inline');
      const variadicEmission = variadic.data.emission;
      assert.match(variadicEmission.text, /entry_sp/);
      assert.match(variadicEmission.text, /nearest-even/);
      for (const [index, args] of variadicCases.entries())
        for (const poison of [0xa5, 0x5a]) {
          const memory = new Map<bigint, number>();
          // The reserved va_list cursor bytes are mapped stack backing, not
          // source-initialized zero. The native prologue overwrites all eight.
          for (let offset = -8; offset < 0; offset++) memory.set(entrySp + BigInt(offset), poison);
          args.forEach((value, argument) => store(memory, entrySp + BigInt(argument * 8), floatBits(value, 64), 8));
          const observed = execute(variadicEmission,
            formals(variadicEmission, [BigInt(args.length)], entrySp), memory, 0n, new Map(), environment);
          assert.equal(observed.exit, 'machine_return', `${emitter}: variadic ${index}`);
          assert.deepEqual(observed.values, oracle.get(`variadic:${index}`));
          assert.equal(observed.events[0], 'store');
          if (args.length === 0)
            assert.ok(!observed.events.includes('load'), 'count zero never reads incoming arguments');
        }
      const vector = await session.decompile({ name: '_fixture_vector_return' }, { emitter });
      assert.ok('data' in vector && vector.data.delivery === 'inline');
      const vectorEmission = vector.data.emission;
      assert.match(vectorEmission.text, /vector_f32x4_t/);
      for (const [index, [left, right]] of vectorCases.entries()) {
        const observed = execute(vectorEmission,
          formals(vectorEmission, [vectorBits(left), vectorBits(right)], entrySp),
          new Map(), 0n, new Map(), environment);
        assert.equal(observed.exit, 'machine_return', `${emitter}: vector ${index}`);
        const expected = oracle.get(`vector:${index}`)!;
        assert.deepEqual(observed.values, [expected.reduce((packed, lane, i) => packed | (lane << BigInt(i * 32)), 0n)]);
      }
      const stored = await session.decompile({ name: '_fixture_vector_store' }, { emitter });
      assert.ok('data' in stored && stored.data.delivery === 'inline');
      const storeEmission = stored.data.emission;
      for (const [index, [left, right]] of vectorCases.entries()) {
        const memory = new Map<bigint, number>();
        store(memory, 0x2000n, vectorBits(left), 16);
        store(memory, 0x3000n, vectorBits(right), 16);
        store(memory, 0x1000n, (1n << 128n) - 1n, 16);
        const observed = execute(storeEmission,
          formals(storeEmission, [0x1000n, 0x2000n, 0x3000n], entrySp),
          memory, 0n, new Map(), environment);
        assert.equal(observed.exit, 'machine_return', `${emitter}: store ${index}`);
        // The source returns void: caller-saved result-register contents are
        // not an observable return contract without native prototype evidence.
        const lanes: bigint[] = [];
        for (let lane = 0; lane < 4; lane++) {
          let bits = 0n;
          for (let byte = 0; byte < 4; byte++)
            bits |= BigInt(observed.memory.get(0x1000n + BigInt(lane * 4 + byte))!) << BigInt(byte * 8);
          lanes.push(bits);
        }
        assert.deepEqual(lanes, oracle.get(`store:${index}`));
        assert.ok(observed.events.indexOf('load') < observed.events.indexOf('store'));
      }
      const mixed = await session.decompile({ name: '_fixture_mixed_caller' }, { emitter });
      assert.ok('data' in mixed && mixed.data.delivery === 'inline');
      const mixedEmission = mixed.data.emission;
      assert.doesNotMatch(mixedEmission.text, /unknown_arguments/);
      const calls = new Map<string, (args: readonly bigint[]) => bigint>();
      calls.set('_fixture_mixed', (args) => {
        assert.equal(args.length, 3);
        return floatBits(Number(BigInt.asUintN(32, args[0]!)) +
          floatNumber(args[1]!) * 1.5 + floatNumber(args[2]!) * 0.5, 64);
      });
      for (const [index, [count, left, right]] of mixedCases.entries())
        for (const poison of [0xa5, 0x5a]) {
          const memory = new Map<bigint, number>();
          // Writable caller-frame backing has arbitrary incoming contents.
          // Saved registers must be stored before restoration loads consume it.
          for (let offset = -256; offset < 0; offset++) memory.set(entrySp + BigInt(offset), poison);
          const observed = execute(mixedEmission,
            formals(mixedEmission, [BigInt(count), floatBits(left, 64), floatBits(right, 64)], entrySp),
            memory, 0n, new Map(), environment, calls);
          assert.equal(observed.exit, 'machine_return', `${emitter}: mixed ${index}`);
          assert.deepEqual(observed.values, oracle.get(`mixed:${index}`));
          assert.deepEqual(observed.source_calls, [
            { name: '_fixture_mixed', arguments: [BigInt(count), floatBits(left, 64), floatBits(right, 64)] },
            { name: '_fixture_mixed', arguments: [BigInt.asUintN(32, BigInt(count) + 1n), floatBits(right, 64), floatBits(left, 64)] },
          ]);
          const firstStore = observed.events.indexOf('store'), firstLoad = observed.events.indexOf('load');
          assert.ok(firstStore >= 0 && (firstLoad < 0 || firstStore < firstLoad));
        }
    }
  },
);
