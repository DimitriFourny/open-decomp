import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { entityIdentity } from '../../../src/core/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { IRBuilder, integer, type SSAForm, type Value } from '../../../src/ir/index.js';
import { image, provenance, slice } from '../../ir/support.js';
import { emit, execute, type SourceCallOracle } from './support.js';

const i8 = integer(8),
  i32 = integer(32),
  i64 = integer(64);
const source = { abi: new DarwinArm64Abi(), callees: [], addresses: [] };
const writing = { registers: [], flags: [], memory: 'unknown_read_write' as const };
const target = (value: bigint) => ({
  kind: 'direct' as const,
  address: { image_id: image, space: 'va' as const, value },
});

/** `if ((*p & 0xfd) == 0) { rc = save(p); if (rc != bound) { fail(rc); return rc; } }
 * release(p); return 0;` with `rc` read again after its test, so the call stays a
 * statement. `loaded`: the bound is `*(uint32_t *)(p + 4)`, read in the test after
 * the call (C prints the comma operator); otherwise 0 (the test reads rc once). */
function shape(loaded: boolean): { input: SSAForm; pointer: Value } {
  const b = new IRBuilder(
    slice,
    entityIdentity(slice, 'function', `comma-condition-${loaded}`),
    provenance,
    'ssa',
  );
  const entry = b.block('entry', [i64]),
    save = b.block('save'),
    fail = b.block('fail'),
    done = b.block('done');
  const [pointer] = entry.parameters as [Value];
  entry.branch(
    entry.compare(
      'eq',
      entry.int('and', entry.load(i8, pointer), entry.constant(i8, 0xfdn)),
      entry.constant(i8, 0n),
    ),
    entry.edge(save),
    entry.edge(done),
  );
  const [rc] = save.call(target(0x4000n), [pointer], [i32], writing);
  const bound = loaded
    ? save.load(i32, save.int('add', pointer, save.constant(i64, 4n)))
    : save.constant(i32, 0n);
  save.branch(save.compare('ne', rc!, bound), save.edge(fail), save.edge(done));
  fail.call(target(0x5000n), [rc!], [], writing);
  fail.return([rc!]);
  done.call(target(0x6000n), [pointer], [], writing);
  done.return([done.constant(i32, 0n)]);
  return { input: b.finish(entry, [i32]), pointer };
}

const rules = (records: readonly { readonly rule?: string | undefined }[] | undefined): string[] =>
  (records ?? []).flatMap((record) => (record.rule ? [record.rule] : []));

for (const language of ['c-like', 'python-like'] as const)
  describe(`source comma conditions ${language}`, () => {
    const c = language === 'c-like';
    for (const loaded of [false, true])
      test(`a call assignment its test reads joins && (${loaded ? 'test loads after the call' : 'test reads it once'}); it runs exactly when the test runs`, () => {
        const { input, pointer } = shape(loaded);
        const output = emit(input, { source }, language).emission;
        const text = output.text;
        if (!loaded)
          assert.match(
            text,
            c ? /&& \(\w+ = sub_4000\(\w+\)\) != 0/ : /and \(\w+ := sub_4000\(\w+\)\) != 0/,
            text,
          );
        else if (c) assert.match(text, /&& \(\w+ = sub_4000\(\w+\), \w+ != /, text);
        // Python-like has no comma operator: the call stays a statement.
        else assert.match(text, /^\s+\w+ = sub_4000\(\w+\)$/m, text);
        if (c || !loaded) assert.ok(rules(output.local_validation).includes('short_circuit_structure'));
        for (const [flags, result, stored] of [
          [0, 0n, 0],
          [0, 7n, 0],
          [0, 7n, 7],
          [2, 9n, 0],
          [1, 7n, 0],
          [0xff, 7n, 0],
        ] as const) {
          const memory = new Map<bigint, number>([
            [0x1000n, flags],
            [0x1004n, stored],
            [0x1005n, 0],
            [0x1006n, 0],
            [0x1007n, 0],
          ]);
          const observed = execute(
            output,
            new Map([[pointer.id, 0x1000n]]),
            memory,
            0n,
            new Map(),
            new Map(),
            new Map<string, SourceCallOracle>([
              ['sub_4000', () => result],
              ['sub_5000', () => []],
              ['sub_6000', () => []],
            ]),
          );
          // The source: save runs only when the flags test holds, once, before its test.
          const saved = (flags & 0xfd) === 0;
          const failed = saved && result !== BigInt(loaded ? stored : 0);
          assert.deepEqual(
            observed.source_calls?.map((call) => call.name),
            saved ? (failed ? ['sub_4000', 'sub_5000'] : ['sub_4000', 'sub_6000']) : ['sub_6000'],
            text,
          );
          assert.deepEqual(observed.values, [failed ? result : 0n], text);
        }
      });
  });
