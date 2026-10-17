import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { openBinary, type BinarySession, type ToolResult } from '../../src/api/index.js';
import { contentHash, createOperationContext, imageIdentity, ImmutableBytes, type LoadedImage, type WireEmission } from '../../src/core/index.js';
import { MachOLoader } from '../../src/loaders/macho/index.js';
import { emittedFormals, execute, type SourceCallOracle } from '../emitters/c/support.js';

const dbAddress = 0x1000n, mutexAddress = 0x2000n, sqlAddress = 0x3000n, entrySp = 0x9000n;
const enterTarget = 0x6000n, leaveTarget = 0x7000n;
// Exact VAs from the hash-bound SQLite disassembly and immutable data image.
const enterSlot = 0x100168d70n, leaveSlot = 0x100168d80n, hardLimits = 0x1001337d0n;
const sqlCases = [null, '', '   \t', ';', 'SELECT 1;', 'SELECT 1', 'SELECT (', 'SELECT ((',
  'SELECT )', 'CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END;',
  'CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END', "'unterminated", '/* comment',
  '[identifier', '-- comment', "SELECT 'é';"] as const;
const limitIds = [0, -1, 15, 2, 2, 0, 0, 2, 2] as const;
const newLimits = [1, 7, 7, -1, 1000000000, 0, 1000000001, 17, 17] as const;
const directValues = [0n, 1n, 0x80000000n, 0xffffffffn] as const;
interface SourceOracleCase {
  readonly operation: string;
  readonly index: number;
  readonly result: bigint;
  readonly changes: bigint;
  readonly total: bigint;
  readonly errCode: bigint;
  readonly errMask: bigint;
  readonly mallocFailed: bigint;
  readonly mutex: boolean;
  readonly limits: readonly bigint[];
  readonly trace: string;
}
function store(memory: Map<bigint, number>, address: bigint, value: bigint, size: number): void {
  for (let byte = 0; byte < size; byte++)
    memory.set(address + BigInt(byte), Number((value >> BigInt(byte * 8)) & 255n));
}
function load(memory: ReadonlyMap<bigint, number>, address: bigint, size: number): bigint {
  let value = 0n;
  for (let byte = 0; byte < size; byte++) {
    const bits = memory.get(address + BigInt(byte));
    assert.ok(bits !== undefined, `Unmapped oracle byte 0x${(address + BigInt(byte)).toString(16)}`);
    value |= BigInt(bits) << BigInt(byte * 8);
  }
  return value;
}
function cstring(memory: ReadonlyMap<bigint, number>, address: bigint): string {
  const bytes: number[] = [];
  for (let offset = 0; offset < 4096; offset++) {
    const value = Number(load(memory, address + BigInt(offset), 1));
    if (value === 0) return new TextDecoder().decode(Uint8Array.from(bytes));
    bytes.push(value);
  }
  assert.fail('Oracle string exceeds its supported bound');
}
function imageMemory(image: LoadedImage): Map<bigint, number> {
  const memory = new Map<bigint, number>();
  for (const section of image.sections) {
    if (section.kind !== 'section' || !section.file_range || !section.permissions.includes('read') ||
        (section.flags & 0x80000400n) !== 0n) continue;
    const bytes = image.bytes.read(section.file_range.start.value, Number(section.file_range.size));
    for (const [offset, value] of bytes.entries()) memory.set(section.virtual_range.start.value + BigInt(offset), value);
  }
  return memory;
}
function bindInputs(emission: WireEmission, values: readonly bigint[]): Map<string, bigint> {
  const inputs = new Map<string, bigint>();
  let index = 0;
  for (const formal of emittedFormals(emission)) {
    if (formal.name === 'entry_sp') inputs.set(formal.statement_id, entrySp);
    else {
      assert.ok(index < values.length, `Unexpected source argument ${formal.name}`);
      inputs.set(formal.statement_id, values[index++]!);
    }
  }
  assert.equal(index, values.length, 'Every source-observed argument must remain an explicit input');
  return inputs;
}
async function decompiled(session: BinarySession, name: string, emitter: WireEmission['language']): Promise<WireEmission> {
  // No budgets, prototypes, annotations, debug data or source are supplied.
  const result: ToolResult<'function_decompile'> = await session.decompile({ name: `_${name}` }, { emitter });
  assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
  return result.data.emission;
}

// Execute only this repository's newly compiled source-excerpt oracle. Retained
// SQLite/corpus binaries are analyzed, never executed. Native output is the
// independent return/memory/logging/callback oracle, not a second IR evaluation.
test('actual SQLite interfaces preserve safety/logging/mutex inputs and full-width results under defaults',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 180000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-sqlite-interfaces-regression-'));
    const sessions: BinarySession[] = [];
    t.after(async () => {
      for (const session of sessions) await session.close();
      await rm(root, { recursive: true, force: true });
    });
    const extracted = spawnSync('/usr/bin/tar', ['-xzf',
      resolve('scripts/bench/quality-evidence/baseline-2026-10-17.tar.gz'), '-C', root,
      'inputs/sqlite3-arm64', 'inputs/corpus-arm64'], { encoding: 'utf8' });
    assert.equal(extracted.status, 0, extracted.stderr);
    const sqlitePath = join(root, 'inputs/sqlite3-arm64');
    const bytes = await readFile(sqlitePath), sha256 = contentHash(bytes);
    assert.equal(sha256, '4e01e37ea6fc2cfb008521558f999ac06cdbb4504e3eeb422c1a84b5ead57e56');
    const image = new MachOLoader().load({ image_id: imageIdentity(sha256), sha256,
      bytes: new ImmutableBytes(bytes), slice_id: null }, createOperationContext());
    const memory = imageMemory(image);
    const configured = Array.from({ length: 15 }, (_, index) =>
      Number(load(memory, hardLimits + BigInt(index * 4), 4)));
    const oraclePath = join(root, 'source-oracle');
    const compiled = spawnSync('/usr/bin/clang', ['-target', 'arm64-apple-macos13.0', '-O2',
      '-ffp-contract=off', '-fno-builtin', '-fno-optimize-sibling-calls',
      resolve('test/reconstruction/sqlite-interfaces-source.c'), '-o', oraclePath], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);
    const native = spawnSync(oraclePath, configured.map(String), { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    const oracle = new Map<string, SourceOracleCase>();
    for (const line of native.stdout.trim().split('\n')) {
      const fields = line.split(' ');
      assert.equal(fields.length, 25);
      const [operation, index, result, changes, total, errCode, errMask, mallocFailed, mutex] = fields;
      const record: SourceOracleCase = { operation: operation!, index: Number(index),
        result: BigInt(`0x${result}`), changes: BigInt(`0x${changes}`), total: BigInt(`0x${total}`),
        errCode: BigInt(`0x${errCode}`), errMask: BigInt(`0x${errMask}`), mallocFailed: BigInt(mallocFailed!),
        mutex: mutex === '1', limits: fields.slice(9, 24).map(BigInt),
        trace: fields[24] === '-' ? '' : Buffer.from(fields[24]!, 'hex').toString('utf8') };
      oracle.set(`${operation}:${index}`, record);
    }
    assert.equal(oracle.size, 63);
    assert.ok(oracle.get('incomplete:6')!.result > 0xffffffffn);
    assert.ok(oracle.get('incomplete:8')!.result >> 32n === 0xffffffffn);
    const sqlite = await openBinary(sqlitePath, { cachePath: join(root, 'sqlite-cache') });
    const corpus = await openBinary(join(root, 'inputs/corpus-arm64'), { cachePath: join(root, 'corpus-cache') });
    sessions.push(sqlite, corpus);
    const unknown = new Map<string, bigint>();
    unknown.set('non-argument entry register', 0n);
    for (const emitter of ['c-like', 'python-like'] as const) {
      for (const [operation, functionName, count] of [
        ['changes', 'sqlite3_changes64', 6], ['total', 'sqlite3_total_changes64', 6],
        ['errcode', 'sqlite3_errcode', 6], ['limit', 'sqlite3_limit', 9],
        ['complete', 'sqlite3_complete', sqlCases.length], ['incomplete', 'sqlite3_incomplete', sqlCases.length],
      ] as const) {
        const emission: WireEmission = await decompiled(sqlite, functionName, emitter);
        for (let index = 0; index < count; index++) for (const poison of [0xa5, 0x5a]) {
          const expected = oracle.get(`${operation}:${index}`)!;
          const isSql = operation === 'complete' || operation === 'incomplete';
          const state = index === 4 && operation !== 'limit' ? 0xba :
            index === (operation === 'limit' ? 8 : 5) ? 0xce : 0x76;
          const hasMutex = operation === 'limit' ? index === 7 : index === 2 || index === 3;
          const mode = operation === 'changes' || operation === 'total' ? index === 2 ? 1 : index === 3 ? 3 : 0 :
            operation === 'errcode' ? index === 2 ? 1 : 0 : operation === 'limit' && index === 7 ? 1 : 0;
          for (let offset = 0; offset < 200; offset++) memory.set(dbAddress + BigInt(offset), 0);
          for (let offset = -512; offset < 0; offset++) memory.set(entrySp + BigInt(offset), poison);
          store(memory, dbAddress + 24n, !isSql && hasMutex ? mutexAddress : 0n, 8);
          store(memory, dbAddress + 80n, 0x81234567n, 4);
          store(memory, dbAddress + 88n, 0xffffn, 4);
          store(memory, dbAddress + 103n, operation === 'errcode' && index === 3 ? 1n : 0n, 1);
          store(memory, dbAddress + 113n, BigInt(isSql ? 0x76 : state), 1);
          store(memory, dbAddress + 120n, 0x123456789abcdefn, 8);
          store(memory, dbAddress + 128n, 0x7f123456789abcden, 8);
          for (let limit = 0; limit < 15; limit++) store(memory, dbAddress + 136n + BigInt(limit * 4), BigInt(40 + limit), 4);
          store(memory, mutexAddress, 17n, 4);
          store(memory, enterSlot, enterTarget, 8);
          store(memory, leaveSlot, leaveTarget, 8);
          const sql = isSql ? sqlCases[index]! : null;
          if (sql !== null) {
            const text = new TextEncoder().encode(`${sql}\0`);
            for (const [offset, byte] of text.entries()) memory.set(sqlAddress + BigInt(offset), byte);
          }
          let trace = '';
          const models = new Map<string, SourceCallOracle>();
          const sickOrOk = (): bigint => {
            const actual = Number(load(memory, dbAddress + 113n, 1));
            if ([0xba, 0x76, 0x6d].includes(actual)) return 1n;
            trace += 'log:21:API call with invalid database connection pointer;';
            return 0n;
          };
          const input = index === 0 ? 0n : dbAddress;
          models.set('_sqlite3SafetyCheckOk', (args) => {
            assert.deepEqual(args, [input]);
            if (input === 0n) { trace += 'log:21:API call with NULL database connection pointer;'; return 0n; }
            if (load(memory, dbAddress + 113n, 1) === 0x76n) return 1n;
            if (sickOrOk()) trace += 'log:21:API call with unopened database connection pointer;';
            return 0n;
          });
          models.set('_sqlite3SafetyCheckSickOrOk', (args) => {
            assert.deepEqual(args, [input]);
            assert.notEqual(input, 0n, 'The source NULL branch must avoid the nonnull-only safety helper');
            return sickOrOk();
          });
          models.set(`0x${enterTarget.toString(16)}`, (args) => {
            assert.deepEqual(args, [mutexAddress]);
            trace += 'enter:17;';
            if (mode & 1) {
              store(memory, dbAddress + 120n, load(memory, dbAddress + 120n, 8) + 7n, 8);
              store(memory, dbAddress + 128n, load(memory, dbAddress + 128n, 8) + 11n, 8);
              store(memory, dbAddress + 80n, 0x1234n, 4);
              store(memory, dbAddress + 88n, 0xffn, 4);
              store(memory, dbAddress + 144n, load(memory, dbAddress + 144n, 4) + 3n, 4);
            }
            if (mode & 2) store(memory, dbAddress + 24n, 0n, 8);
            return [];
          });
          models.set(`0x${leaveTarget.toString(16)}`, (args) => {
            assert.deepEqual(args, [mutexAddress]);
            trace += 'leave:17;';
            store(memory, dbAddress + 120n, load(memory, dbAddress + 120n, 8) + 100n, 8);
            store(memory, dbAddress + 128n, load(memory, dbAddress + 128n, 8) + 200n, 8);
            store(memory, dbAddress + 144n, load(memory, dbAddress + 144n, 4) ^ 0x55n, 4);
            return [];
          });
          models.set('_sqlite3_log', (args, context) => {
            assert.ok(args.length >= 2, 'Logging must retain its observed error-code/format prefix');
            assert.equal(args[0], 21n);
            assert.equal(cstring(memory, args[1]!), '%s at line %d of [%.10s]');
            // Darwin anonymous arguments are actual outgoing bytes. An unknown
            // remainder is not an empty list or an established complete arity.
            const sp = entrySp - (operation === 'limit' ? 80n : 64n);
            const supplied = [load(memory, sp, 8), load(memory, sp + 8n, 8), load(memory, sp + 16n, 8)];
            assert.ok(args.length <= 5);
            args.slice(2).forEach((value, i) => assert.equal(value, supplied[i]));
            if (context.arguments_complete) assert.equal(args.length, 5);
            trace += `log:21:${cstring(memory, supplied[0]!)} at line ${Number(BigInt.asIntN(32, supplied[1]!))} of [${cstring(memory, supplied[2]!).slice(0, 10)}];`;
            return [];
          });
          models.set('_sqlite3_incomplete', (args) => {
            assert.deepEqual(args, [sql === null ? 0n : sqlAddress]);
            const result = oracle.get(`incomplete:${index}`)!;
            trace += result.trace;
            return result.result;
          });
          const args = isSql ? [sql === null ? 0n : sqlAddress] : operation === 'limit'
            ? [input, BigInt.asUintN(32, BigInt(limitIds[index]!)), BigInt.asUintN(32, BigInt(newLimits[index]!))]
            : [input];
          const observed = execute(emission, bindInputs(emission, args), memory, 0n, new Map(), unknown, models);
          assert.equal(observed.exit, 'machine_return', `${emitter}: ${operation}:${index}`);
          const resultWidth = operation === 'changes' || operation === 'total' || operation === 'incomplete' ? 64 : 32;
          assert.deepEqual(observed.values.map((value) => BigInt.asUintN(resultWidth, value)), [expected.result],
            `${emitter}: ${operation}:${index} result`);
          assert.equal(trace, expected.trace, `${emitter}: ${operation}:${index} effects/order`);
          assert.equal(load(memory, dbAddress + 120n, 8), expected.changes);
          assert.equal(load(memory, dbAddress + 128n, 8), expected.total);
          assert.equal(load(memory, dbAddress + 80n, 4), expected.errCode);
          assert.equal(load(memory, dbAddress + 88n, 4), expected.errMask);
          assert.equal(load(memory, dbAddress + 103n, 1), expected.mallocFailed);
          assert.equal(load(memory, dbAddress + 24n, 8) !== 0n, expected.mutex);
          assert.deepEqual(Array.from({ length: 15 }, (_, limit) => load(memory, dbAddress + 136n + BigInt(limit * 4), 4)), expected.limits);
        }
      }
      const direct: WireEmission = await decompiled(corpus, 'fixture_direct', emitter);
      for (const [index, value] of directValues.entries()) {
        for (let offset = -256; offset < 0; offset++) memory.set(entrySp + BigInt(offset), 0xa5);
        const models = new Map<string, SourceCallOracle>();
        models.set('_fixture_stack', (args) => { assert.deepEqual(args, [value]); return BigInt.asUintN(32, value + 7n); });
        models.set('_fixture_arithmetic', (args) => { assert.deepEqual(args, [value, 2n]); return BigInt.asUintN(32, value + 6n) ^ 0x55n; });
        const observed = execute(direct, bindInputs(direct, [value]), memory, 0n, new Map(), unknown, models);
        assert.equal(observed.exit, 'machine_return');
        assert.deepEqual(observed.values.map((result) => BigInt.asUintN(32, result)), [oracle.get(`direct:${index}`)!.result]);
        assert.equal(observed.source_calls?.filter((call) => call.name === '_fixture_stack').length, 1);
        assert.equal(observed.source_calls?.filter((call) => call.name === '_fixture_arithmetic').length, 1);
      }
    }
  });
