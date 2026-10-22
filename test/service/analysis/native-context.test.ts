import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openBinary, type BinarySession } from '../../../src/api/index.js';
import { createOperationContext } from '../../../src/core/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { assertValidIR, evaluateIR, integer, type Expression } from '../../../src/ir/index.js';
import {
  nativeCallContext,
  nativeContextKey,
  specializeNativeSSA,
} from '../../../src/service/analysis/native-context.js';
import { builder, register, returned } from '../../ir/support.js';
import { acknowledgeRequirements, emittedFormals, execute } from '../../emitters/c/support.js';
import { nativeOracleSkip } from '../../support/host-tools.js';
import { compileContextResultFixture } from './native-context-result-fixture.js';

const first = register('arg0', 64, 0, 'replace_root', 'arg0');
const second = register('arg1', 64, 0, 'replace_root', 'arg1');

test('native context requires complete carriers and keeps distinct values may-alias', () => {
  const context = createOperationContext();
  const low = { id: 'low', type: integer(32) },
    high = { id: 'high', type: integer(32) };
  const expressions = new Map<string, Expression>([['low', { kind: 'constant', bits: 3n }]]);
  const bindings = [
    { register: { ...first, width_bits: 32 }, value: low },
    { register: { ...first, offset_bits: 32, width_bits: 32 }, value: high },
  ];
  assert.equal(
    nativeCallContext(bindings, [first], expressions, 'scope', context, 'image'),
    undefined,
  );
  expressions.set('high', { kind: 'constant', bits: 5n });
  const known = nativeCallContext(bindings, [first], expressions, 'scope', context, 'image')!;
  assert.equal(known.constants[0]!.bits, (5n << 32n) | 3n);
  assert.notEqual(
    nativeContextKey('callee', known),
    nativeContextKey('callee', { ...known, type_evidence_scope: 'corrected' }),
  );
  const identity = nativeCallContext(
    [
      { register: first, value: { id: 'p', type: integer(64) } },
      { register: second, value: { id: 'p', type: integer(64) } },
    ],
    [first, second],
    new Map(),
    'scope',
    context,
    'image',
  )!;
  assert.deepEqual(identity.aliases, [[first, second]]);
  assert.equal(
    nativeCallContext(
      [
        { register: first, value: { id: 'p', type: integer(64) } },
        { register: second, value: { id: 'q', type: integer(64) } },
      ],
      [first, second],
      new Map(),
      'scope',
      context,
      'image',
    ),
    undefined,
  );
  const pointer = { id: 'p', type: integer(64) },
    zero = { id: 'zero', type: integer(64) },
    moved = { id: 'moved', type: integer(64) };
  const moves = new Map<string, Expression>([
    ['zero', { kind: 'constant', bits: 0n }],
    ['moved', { kind: 'integer', op: 'or', left: zero, right: pointer }],
  ]);
  assert.deepEqual(
    nativeCallContext(
      [
        { register: first, value: pointer },
        { register: second, value: moved },
      ],
      [first, second],
      moves,
      'scope',
      context,
      'image',
    )?.aliases,
    [[first, second]],
  );
});

test('native specialization reuses immutable baseline and isolates two constant contexts', () => {
  const input = builder('native context'),
    entry = input.block('entry'),
    yes = input.block('yes'),
    no = input.block('no');
  const condition = entry.compare('ne', entry.readRegister(first), entry.constant(integer(64), 0n));
  entry.branch(condition, entry.edge(yes), entry.edge(no));
  yes.return([yes.constant(integer(64), 11n)]);
  no.return([no.constant(integer(64), 29n)]);
  const baseline = constructSSA(input.finish(entry, [integer(64)])).value;
  assert.equal(baseline.form, 'ssa');
  if (baseline.form !== 'ssa') throw new Error('Expected SSA fixture');
  const before = JSON.stringify(baseline, (_, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  const view = (bits: bigint) =>
    specializeNativeSSA(
      baseline,
      { constants: [{ register: first, bits }], aliases: [], type_evidence_scope: 'scope' },
      createOperationContext(),
    );
  assert.ok(!view(0n).blocks.some((block) => block.id === yes.id));
  assert.ok(!view(1n).blocks.some((block) => block.id === no.id));
  assert.equal(
    JSON.stringify(baseline, (_, value) => (typeof value === 'bigint' ? value.toString() : value)),
    before,
  );
});

test('context assumptions seed only the invocation, not a backedge to the original entry', () => {
  const input = builder('native context entry loop'),
    entry = input.block('entry'),
    exit = input.block('exit');
  const next = entry.int('add', entry.readRegister(first), entry.constant(integer(64), 1n));
  entry.writeRegister(first, next);
  entry.branch(
    entry.compare('ult', next, entry.constant(integer(64), 3n)),
    entry.edge(entry),
    entry.edge(exit),
  );
  exit.return([exit.readRegister(first)]);
  const baseline = constructSSA(input.finish(entry, [integer(64)])).value;
  if (baseline.form !== 'ssa') throw new Error('Expected SSA fixture');
  const view = specializeNativeSSA(
    baseline,
    { constants: [{ register: first, bits: 0n }], aliases: [], type_evidence_scope: 'scope' },
    createOperationContext(),
  );
  assertValidIR(view);
  assert.deepEqual(returned(evaluateIR(view, { registers: new Map([[first.root, 0n]]) })), [3n]);
});

// Analyze the assembled fixture only; both dialects run in the source oracle
// with a stub callee, never the analyzed image.
test(
  'tail calls to the count 0 and count 2 contexts of one double callee return double',
  { skip: nativeOracleSkip(), timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'native-context-result-'));
    const session: BinarySession = await openBinary(await compileContextResultFixture(root), {
      cachePath: join(root, 'cache'),
    });
    t.after(async () => {
      await session.close();
      await rm(root, { recursive: true, force: true });
    });
    const f64 = (value: number): bigint => {
      const bytes = new DataView(new ArrayBuffer(8));
      bytes.setFloat64(0, value, true);
      return bytes.getBigUint64(0, true);
    };
    for (const emitter of ['c-like', 'python-like'] as const) {
      const result = await session.decompile({ name: 'r3_call' }, { emitter });
      assert.ok('data' in result && result.data.delivery === 'inline');
      const emission = result.data.emission;
      assert.match(
        emission.text,
        emitter === 'c-like' ? /^double r3_call\(/m : /^def r3_call\(.*\) -> double:/m,
        emission.text,
      );
      assert.doesNotMatch(emission.text, /physical_return|ABI scratch/, emission.text);
      const formals = emittedFormals(emission);
      assert.equal(formals.length, 2, emission.text);
      for (const count of [0n, 1n, 2n, 0x80000000n, 0xffffffffn]) {
        const calls: (readonly bigint[])[] = [];
        const observed = execute(
          emission,
          new Map([
            [formals[0]!.statement_id, count],
            [formals[1]!.statement_id, 0x5000n],
          ]),
          new Map(),
          0n,
          new Map(),
          new Map(),
          new Map([
            [
              'r3_sum',
              (args) => {
                calls.push(args);
                return f64(Number(args[0]) + 0.25);
              },
            ],
          ]),
          acknowledgeRequirements(emission),
        );
        // The count 0 context reads no values pointer; count 2 forwards it.
        // Both results are the callee's double.
        const zero = count === 0n;
        assert.deepEqual(calls, [zero ? [0n] : [2n, 0x5000n]]);
        assert.deepEqual(observed.values, [f64(zero ? 0.25 : 2.25)], emission.text);
      }
    }
  },
);
