import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../../src/core/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { assertValidIR, evaluateIR, integer, type Expression } from '../../../src/ir/index.js';
import {
  nativeCallContext,
  nativeContextKey,
  specializeNativeSSA,
} from '../../../src/service/analysis/native-context.js';
import { builder, register, returned } from '../../ir/support.js';

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
