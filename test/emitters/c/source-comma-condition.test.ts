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

/** `if (p[1] != 0) { if ((*p & 0xfd) != 0) goto out; rc = save(p); if (rc == 0)
 * goto out; *(p + 4) = rc; } after(p); out: leave(p) five times; return 0;` — both exits
 * jump over `after`, which the entry's other arm also reaches. `carried`: the call
 * ends its own block, which jumps to the test. */
function joinedExits(carried: boolean): { input: SSAForm; pointer: Value } {
  const b = new IRBuilder(
    slice,
    entityIdentity(slice, 'function', `joined-exits-${carried}`),
    provenance,
    'ssa',
  );
  const entry = b.block('entry', [i64]),
    check = b.block('check'),
    save = b.block('save'),
    store = b.block('store'),
    after = b.block('after'),
    out = b.block('out');
  const [pointer] = entry.parameters as [Value];
  entry.branch(
    entry.compare(
      'ne',
      entry.load(i8, entry.int('add', pointer, entry.constant(i64, 1n))),
      entry.constant(i8, 0n),
    ),
    entry.edge(check),
    entry.edge(after),
  );
  check.branch(
    check.compare(
      'ne',
      check.int('and', check.load(i8, pointer), check.constant(i8, 0xfdn)),
      check.constant(i8, 0n),
    ),
    check.edge(out),
    check.edge(save),
  );
  const [rc] = save.call(target(0x4000n), [pointer], [i32], writing);
  const test = carried ? b.block('test') : save;
  if (carried) save.jump(test);
  test.branch(test.compare('eq', rc!, test.constant(i32, 0n)), test.edge(out), test.edge(store));
  store.store(store.int('add', pointer, store.constant(i64, 4n)), rc!);
  store.jump(after);
  after.call(target(0x6000n), [pointer], [], writing);
  after.jump(out);
  // Five calls: too large a tail to copy onto the exits.
  for (let index = 0; index < 5; index++) out.call(target(0x5000n), [pointer], [], writing);
  out.return([out.constant(i32, 0n)]);
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
        if (c || !loaded) {
          assert.ok(rules(output.local_validation).includes('short_circuit_structure'));
          assert.ok(rules(output.local_validation).includes('comma_condition'));
        }
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

    for (const carried of [false, true])
      test(`exits leaving by one goto join || with a comma operand${carried ? ' (the call ends its own block)' : ''}; the call runs exactly when its test runs`, () => {
        const { input, pointer } = joinedExits(carried);
        const output = emit(input, { source }, language).emission;
        const text = output.text;
        assert.match(
          text,
          c
            ? /if \(.+ \|\| \(\w+ = sub_4000\(\w+\)\) == 0\) \{\n\s+goto (\w+);\n/
            : /if .+ or \(\w+ := sub_4000\(\w+\)\) == 0:\n\s+goto (\w+)\n/,
          text,
        );
        assert.equal(text.match(/\bgoto\b/g)?.length, 1, text);
        assert.ok(rules(output.local_validation).includes('joined_exit_condition'), text);
        for (const [enter, flags, result] of [
          [0, 0, 7n],
          [1, 0, 7n],
          [1, 0, 0n],
          [1, 2, 7n],
          [1, 1, 0n],
        ] as const) {
          const memory = new Map<bigint, number>([
            [0x1000n, flags],
            [0x1001n, enter],
            [0x1004n, 0],
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
          // The source: save runs only when entered with the flags test clear,
          // once, before its own test; a nonzero result is stored, then sub_6000.
          const saved = enter !== 0 && (flags & 0xfd) === 0;
          const stored = saved && result !== 0n;
          assert.deepEqual(
            observed.source_calls?.map((call) => call.name),
            [
              ...(saved ? ['sub_4000'] : []),
              ...(enter === 0 || stored ? ['sub_6000'] : []),
              ...Array<string>(5).fill('sub_5000'),
            ],
            text,
          );
          assert.equal(observed.memory.get(0x1004n), stored ? Number(result) : 0, text);
        }
      });
  });

/** `last = 0; for each of COUNTED bytes p[8 + i]: if (p[8 + i] != 0) last = tick(p);`
 * unrolled, then shape(false)'s `if ((*p & 0xfd) == 0) { rc = save(p); if (rc != 0)
 * { fail(rc); return rc; } } release(p); return last;`. Every unrolled join receives
 * `last` by two whole-variable edge copies (cheap to validate), so printing
 * publishes more phi-copy records than the 256-record bound holds before the
 * comma operand's call prints. */
const COUNTED = 140;
function copiesBeforeComma(): { input: SSAForm; pointer: Value } {
  const b = new IRBuilder(
    slice,
    entityIdentity(slice, 'function', 'copies-before-comma'),
    provenance,
    'ssa',
  );
  const entry = b.block('entry', [i64]);
  const tests = Array.from({ length: COUNTED + 1 }, (_, index) => b.block(`test_${index}`, [i32]));
  const save = b.block('save', [i32]),
    fail = b.block('fail'),
    done = b.block('done', [i32]);
  const [pointer] = entry.parameters as [Value];
  entry.jump(tests[0]!, [entry.constant(i32, 0n)]);
  for (let index = 0; index < COUNTED; index++) {
    const test = tests[index]!,
      next = tests[index + 1]!,
      tick = b.block(`tick_${index}`);
    const [acc] = test.parameters as [Value];
    test.branch(
      test.compare(
        'ne',
        test.load(i8, test.int('add', pointer, test.constant(i64, BigInt(8 + index)))),
        test.constant(i8, 0n),
      ),
      test.edge(tick),
      test.edge(next, [acc]),
    );
    const [latest] = tick.call(target(0x7000n), [pointer], [i32], writing);
    tick.jump(next, [latest!]);
  }
  const last = tests[COUNTED]!;
  const [counted] = last.parameters as [Value];
  last.branch(
    last.compare(
      'eq',
      last.int('and', last.load(i8, pointer), last.constant(i8, 0xfdn)),
      last.constant(i8, 0n),
    ),
    last.edge(save, [counted]),
    last.edge(done, [counted]),
  );
  const [acc] = save.parameters as [Value];
  const [rc] = save.call(target(0x4000n), [pointer], [i32], writing);
  save.branch(
    save.compare('ne', rc!, save.constant(i32, 0n)),
    save.edge(fail),
    save.edge(done, [acc]),
  );
  fail.call(target(0x5000n), [rc!], [], writing);
  fail.return([rc!]);
  const [result] = done.parameters as [Value];
  done.call(target(0x6000n), [pointer], [], writing);
  done.return([result]);
  return { input: b.finish(entry, [i32]), pointer };
}

for (const language of ['c-like', 'python-like'] as const)
  test(`${language}: a comma operand call's call_effects is admitted when planned, so records filled while printing never print its boundary in the test`, () => {
    const { input, pointer } = copiesBeforeComma();
    const output = emit(input, { source }, language).emission;
    const text = output.text;
    const records = output.local_validation ?? [];
    // The record bound is reached while the copies print, after planning: later
    // calls print their clobber contract as a boundary statement before them.
    assert.ok(records.length >= 256, `${records.length} records`);
    assert.ok(rules(records).includes('comma_condition'), text);
    assert.match(text, /\(\w+ :?= sub_4000\(\w+\)\) != 0/, text);
    const lines = text.split('\n');
    assert.ok(
      lines.some((line) => line.includes('boundary(')),
      text,
    );
    lines.forEach((line, index) => {
      if (line.includes('boundary('))
        assert.match(lines[index + 1]!, /^\s+(\w+ = )?sub_[567]000\(\w+\);?$/, text);
    });
    for (const [flags, result] of [
      [0, 0n],
      [0, 7n],
      [2, 9n],
      [1, 7n],
    ] as const)
      for (const ticks of [0, 3, COUNTED]) {
        const memory = new Map<bigint, number>([[0x1000n, flags]]);
        for (let index = 0; index < COUNTED; index++)
          memory.set(0x1008n + BigInt(index), index < ticks ? (index % 2) + 1 : 0);
        let tick = 0;
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
            ['sub_7000', () => BigInt(++tick * 3)],
          ]),
        );
        const saved = (flags & 0xfd) === 0,
          failed = saved && result !== 0n;
        assert.deepEqual(
          observed.source_calls?.map((call) => call.name),
          [
            ...Array<string>(ticks).fill('sub_7000'),
            ...(saved ? ['sub_4000'] : []),
            failed ? 'sub_5000' : 'sub_6000',
          ],
          text,
        );
        assert.deepEqual(observed.values, [failed ? result : BigInt(ticks * 3)], text);
      }
  });
