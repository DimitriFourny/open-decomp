import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { nativeOracleSkip } from '../support/host-tools.js';
import type { WireEmission } from '../../src/core/index.js';
import { createOperationContext } from '../../src/core/index.js';
import { executeImageTypes } from '../../src/service/analysis/index.js';
import { project } from '../service/analysis/support.js';
import { emittedFormals, execute, type SourceCallOracle } from '../emitters/c/support.js';

function store(memory: Map<bigint, number>, address: bigint, value: bigint, bytes: number): void {
  for (let byte = 0; byte < bytes; byte++)
    memory.set(address + BigInt(byte), Number((value >> BigInt(byte * 8)) & 255n));
}
function load(memory: ReadonlyMap<bigint, number>, address: bigint, bytes: number): bigint {
  let value = 0n;
  for (let byte = 0; byte < bytes; byte++)
    value |= BigInt(memory.get(address + BigInt(byte)) ?? 0) << BigInt(byte * 8);
  return value;
}
/** The declared structure behind the first formal: its name and member offsets. */
function formalStruct(text: string): { name: string; declaration: string; members: string[] } {
  const name = /^\w[\w ]*\((\w+)\* address\b/m.exec(text)?.[1];
  assert.ok(name, text);
  const declaration = new RegExp(`^struct ${name} \\{.*\\};$`, 'm').exec(text)?.[0];
  assert.ok(declaration, text);
  return {
    name,
    declaration,
    members: [...declaration.matchAll(/ (f_[0-9a-f]+)/g)].map((m) => m[1]!),
  };
}

test(
  'source-built pointer flows share one image-wide structure identity and keep conflicting views apart',
  { skip: nativeOracleSkip(), timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-image-types-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, 'image-types');
    const compiled = spawnSync(
      '/usr/bin/clang',
      [
        '-target',
        'arm64-apple-macos13.0',
        '-O2',
        '-fno-builtin',
        '-fno-optimize-sibling-calls',
        resolve('test/reconstruction/image-types-source.c'),
        '-o',
        binary,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    const oracle = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(oracle.status, 0, oracle.stderr);
    const lines = oracle.stdout.trim().split('\n');
    assert.equal(lines.length, 3);
    const p = await project(t, new Uint8Array(await readFile(binary)));
    const decompile = async (name: string, emitter: 'c-like' | 'python-like' = 'c-like') => {
      const fn = p.functions.find((candidate) => candidate.original_name === `_${name}`);
      assert.ok(fn, name);
      const response = await p.decompile(fn.id, { options: { emitter } });
      assert.ok('data' in response.result);
      return p.payload(response.result).result.data.emission as WireEmission;
    };

    // context_set writes +0; context_get reads +8 and +16. context_drive passes
    // its own argument to both, so both name one merged type; each function
    // declares only the members its own text accesses.
    const set = formalStruct((await decompile('context_set')).text);
    const get = formalStruct((await decompile('context_get')).text);
    assert.equal(set.name, get.name);
    assert.deepEqual(set.members, ['f_0']);
    assert.deepEqual(get.members, ['f_8', 'f_10']);
    assert.match(set.declaration, /gap_0\[|f_0;/);
    assert.match(get.declaration, /gap_0\[8\]/);

    // The whole-image header declares the same name with the same layout and
    // is valid C on its own.
    const dump = executeImageTypes(
      {
        store: p.state.store,
        context: createOperationContext(),
        job_id: p.job('function_decompile'),
      },
      p.state.store.snapshot().revision,
      p.image,
      1 << 20,
    );
    assert.equal(dump.analyzed, dump.total);
    // ...and the whole-image header holds the complete merged layout.
    const merged = new RegExp(`^struct ${set.name} \\{.*\\};$`, 'm').exec(dump.text)?.[0];
    assert.ok(merged, dump.text);
    assert.deepEqual(
      [...merged.matchAll(/ (f_[0-9a-f]+)/g)].map((m) => m[1]),
      ['f_0', 'f_8', 'f_10'],
    );
    const header = spawnSync('/usr/bin/clang', ['-x', 'c', '-fsyntax-only', '-std=c11', '-'], {
      input: dump.text,
      encoding: 'utf8',
    });
    assert.equal(header.status, 0, header.stderr);

    // views_wide reads 64 bits at +0, views_high 32 bits at +4: one object,
    // but incompatible overlapping views never share a name or a layout.
    const high = (await decompile('views_high')).text;
    const wide = (await decompile('views_wide')).text;
    const conflict = /conflicts with (\w+) \*\/\nstruct (\w+) /.exec(dump.text);
    assert.ok(conflict, dump.text);
    const [, otherName, highName] = conflict;
    assert.notEqual(otherName, highName);
    assert.doesNotMatch(wide, new RegExp(`\\b${highName}\\b`));
    assert.doesNotMatch(high, new RegExp(`\\b${otherName}\\b`));

    // db->slots[i].node: the slot array is reloaded after each call, so the
    // compiler keeps a byte offset (+32 per iteration) beside the counter i.
    const [expected] = lines.slice(2);
    for (const emitter of ['c-like', 'python-like'] as const) {
      const emission = await decompile('release_all', emitter);
      if (emitter === 'c-like') assert.match(emission.text, /->f_20\[\w+\]\.f_8\b/, emission.text);
      const memory = new Map<bigint, number>();
      const db = 0x3000n,
        slots = 0x4000n,
        nodes = [0x5000n, 0n, 0x5100n, 0x5200n];
      store(memory, db + 0x20n, slots, 8);
      store(memory, db + 0x28n, 4n, 4);
      const initial = [
        { shared: 1n, wanted: 1n },
        null,
        { shared: 0n, wanted: 9n },
        { shared: 1n, wanted: 4n },
      ];
      for (const [index, node] of nodes.entries()) {
        store(memory, slots + BigInt(index * 32), BigInt(index), 8);
        store(memory, slots + BigInt(index * 32) + 8n, node, 8);
        const fields = initial[index];
        if (!fields) continue;
        store(memory, node + 0x11n, fields.shared, 1);
        store(memory, node + 0x12n, 1n, 1);
        store(memory, node + 0x14n, fields.wanted, 4);
      }
      for (let offset = -256n; offset < 0n; offset++) memory.set(0x10000n + offset, 0xa5);
      const unlocked: bigint[] = [];
      const calls = new Map<string, SourceCallOracle>([
        [
          'node_unlock',
          (args) => {
            unlocked.push(args[0]!);
            store(memory, args[0]! + 0x12n, 0n, 1);
            return args[0]!;
          },
        ],
      ]);
      const inputs = new Map<string, bigint>();
      for (const formal of emittedFormals(emission))
        inputs.set(formal.statement_id, formal.name === 'entry_sp' ? 0x10000n : db);
      const observed = execute(
        emission,
        inputs,
        memory,
        0n,
        new Map(),
        new Map([['non-argument entry register', 0n]]),
        calls,
      );
      assert.equal(observed.exit, 'machine_return', emission.text);
      const result = [0, 2, 3].flatMap((index) => [
        load(observed.memory, nodes[index]! + 0x14n, 4),
        load(observed.memory, nodes[index]! + 0x12n, 1),
      ]);
      assert.equal(result.join(' '), expected, emission.text);
      assert.deepEqual(unlocked, [nodes[0]]);
    }
  },
);
