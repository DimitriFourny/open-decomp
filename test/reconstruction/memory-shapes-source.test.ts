import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { WireEmission } from '../../src/core/index.js';
import { project } from '../service/analysis/support.js';
import { emittedFormals, execute, type SourceCallOracle } from '../emitters/c/support.js';

function word(memory: ReadonlyMap<bigint, number>, address: bigint, bytes = 4): bigint {
  let value = 0n;
  for (let byte = 0; byte < bytes; byte++) value |= BigInt(memory.get(address + BigInt(byte))!) << BigInt(byte * 8);
  return value;
}
function store(memory: Map<bigint, number>, address: bigint, value: bigint, bytes = 4): void {
  for (let byte = 0; byte < bytes; byte++) memory.set(address + BigInt(byte), Number((value >> BigInt(byte * 8)) & 255n));
}
function inputs(emission: WireEmission, values: readonly bigint[]): Map<string, bigint> {
  const result = new Map<string, bigint>();
  let index = 0;
  for (const formal of emittedFormals(emission)) {
    if (formal.name === 'entry_sp') result.set(formal.statement_id, 0x10000n);
    else {
      assert.ok(index < values.length, `Unexpected formal ${formal.name}`);
      result.set(formal.statement_id, values[index++]!);
    }
  }
  assert.equal(index, values.length, emission.text);
  return result;
}
function firstFormalDeclaration(emission: WireEmission): string {
  const formal = emittedFormals(emission).find((formal) => formal.name !== 'entry_sp');
  assert.ok(formal);
  const mapping = emission.mappings.find((mapping) => emission.ids[mapping.semantic_refs[0]!] === formal.statement_id);
  assert.ok(mapping);
  return emission.text.slice(mapping.start, mapping.end);
}

test('source-built calls accumulate partial fields, strides and callback roles without erasing alias boundaries',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 60000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-memory-shapes-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, 'memory-shapes');
    const compiled = spawnSync('/usr/bin/clang', ['-target', 'arm64-apple-macos13.0', '-O1',
      '-fno-builtin', '-fno-optimize-sibling-calls', resolve('test/reconstruction/memory-shapes-source.c'), '-o', binary], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);
    const oracle = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(oracle.status, 0, oracle.stderr);
    const lines = oracle.stdout.trim().split('\n');
    assert.equal(lines.length, 9);
    const p = await project(t, new Uint8Array(await readFile(binary)));
    const find = (name: string) => {
      const fn = p.functions.find((candidate) => candidate.original_name === `_${name}`);
      assert.ok(fn, name); return fn;
    };
    for (const emitter of ['c-like', 'python-like'] as const) {
      const response = await p.decompile(find('shape_consumer').id, { options: { emitter } });
      assert.ok('data' in response.result);
      const emission = p.payload(response.result).result.data.emission;
      assert.match(firstFormalDeclaration(emission), emitter === 'c-like' ? /\*/ : /pointer\[/);
      assert.ok(emission.helpers.some((helper) => helper.name === 'field_view'), emission.text);
      for (const line of lines.slice(0, 8)) {
        const [alias, index, expected, expectedA, expectedB] = line.split(' ').map(BigInt);
        const a = 0x3000n, b = alias ? a : 0x4000n, value = 0xfffffff0n + index!;
        const memory = new Map<bigint, number>();
        for (const base of [0x3000n, 0x4000n]) {
          store(memory, base, base === a ? 5n : 9n);
          for (let slot = 0; slot < 4; slot++) store(memory, base + 8n + BigInt(slot * 4),
            BigInt((base === a ? 11 : 21) + slot));
          store(memory, base + 24n, 0x6000n, 8);
        }
        for (let offset = -256n; offset < 0n; offset++) memory.set(0x10000n + offset, 0xa5);
        const order: string[] = [];
        const calls = new Map<string, SourceCallOracle>([
          ['_shape_head', (args) => { order.push('head'); assert.deepEqual(args.map((x, i) => i ? BigInt.asUintN(32, x) : x), [a, value]);
            store(memory, args[0]!, args[1]!); return 0n; }],
          ['_shape_slot', (args) => { order.push('slot'); assert.deepEqual(args.map((x, i) => i ? BigInt.asUintN(32, x) : x), [b, index, BigInt.asUintN(32, value + 7n)]);
            store(memory, args[0]! + 8n + BigInt.asUintN(32, args[1]!) * 4n, args[2]!); return 0n; }],
          ['_shape_callback', (args) => { order.push('callback'); assert.deepEqual(args, [a]);
            assert.equal(word(memory, a + 24n, 8), 0x6000n);
            return BigInt.asUintN(32, word(memory, a) * 3n + 1n); }],
        ]);
        const observed = execute(emission, inputs(emission, [a, b, index!, value]), memory, 0n,
          new Map(), new Map([['non-argument entry register', 0n]]), calls);
        assert.equal(observed.exit, 'machine_return', emission.text);
        assert.deepEqual(observed.values.map((x) => BigInt.asUintN(32, x)), [expected]);
        assert.deepEqual(order, ['head', 'slot', 'callback']);
        assert.equal(word(observed.memory, a + 8n + index! * 4n), expectedA);
        assert.equal(word(observed.memory, 0x4008n + index! * 4n), expectedB);
        assert.equal(word(observed.memory, a + 24n, 8), 0x6000n, 'calls cannot alias away the callback field');
      }
      // Exercise the real loaded callback expression independently; argument
      // values are checked by an oracle, not supplied as an analyzed prototype.
      const callbackResponse = await p.decompile(find('shape_callback').id, { options: { emitter } });
      assert.ok('data' in callbackResponse.result);
      const callbackEmission = p.payload(callbackResponse.result).result.data.emission;
      const memory = new Map<bigint, number>();
      store(memory, 0x3000n, 37n); store(memory, 0x3018n, 0x6000n, 8);
      for (let offset = -256n; offset < 0n; offset++) memory.set(0x10000n + offset, 0xa5);
      let count = 0;
      const observed = execute(callbackEmission, inputs(callbackEmission, [0x3000n]), memory, 0n,
        new Map(), new Map([['non-argument entry register', 0n]]), new Map([['0x6000', (args: readonly bigint[]) => {
          count++; assert.deepEqual(args.map((x) => BigInt.asUintN(32, x)), [37n]); return 112n;
        }]]));
      assert.equal(observed.exit, 'machine_return');
      assert.deepEqual(observed.values, [112n]); assert.equal(count, 1);
      const unionResponse = await p.decompile(find('shape_union').id, { options: { emitter } });
      assert.ok('data' in unionResponse.result);
      const unionEmission = p.payload(unionResponse.result).result.data.emission;
      const unionObserved = execute(unionEmission, inputs(unionEmission, [0x5000n]),
        new Map(Array.from({ length: 256 }, (_, i) => [0xff00n + BigInt(i), 0xa5])), 0n, new Map(),
        new Map([['non-argument entry register', 0n]]), new Map([
          ['_shape_wide', (args: readonly bigint[]) => { assert.deepEqual(args, [0x5000n]); return 0x1234567887654321n; }],
          ['_shape_high', (args: readonly bigint[]) => { assert.deepEqual(args, [0x5000n]); return 0x12345678n; }],
        ]));
      assert.equal(unionObserved.exit, 'machine_return');
      assert.deepEqual(unionObserved.values, [BigInt(lines[8]!)]);
      assert.match(firstFormalDeclaration(unionEmission), /uint64_t/,
        'overlapping alternatives are not rendered as a proven compatible structure');
    }
  });
