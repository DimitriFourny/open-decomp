import assert from 'node:assert/strict';
import test from 'node:test';
import { localValidationCounterexamples } from './local-validation-cases.js';
import { createOperationContext } from '../../src/core/index.js';
import { localValidationSchema } from '../../src/core/tools.js';
import {
  LocalValidationSession,
  validateBitvectorCandidate,
} from '../../src/reconstruction/local-validation.js';
import { integer, type Expression, type Value } from '../../src/ir/index.js';
import { normalizeSourceExpressions } from '../../src/reconstruction/source-expressions.js';

test(
  'independent bounded translation checks publish concrete counterexamples and honest scope',
  localValidationCounterexamples,
);

test('presentation records aggregate all subjects and split at the unchanged 64-reference bound', () => {
  const session = new LocalValidationSession(createOperationContext());
  for (let index = 0; index < 200; index++)
    assert.ok(
      session.presentation('same_rule', `node_${index}`, 'same function scope', [`value_${index}`]),
    );
  assert.equal(session.records.length, 7);
  const subjects = new Set(session.records.flatMap((record) => record.subject_ids ?? []));
  assert.equal(subjects.size, 400);
  for (let index = 0; index < 200; index++) {
    assert.ok(subjects.has(`node_${index}`));
    assert.ok(subjects.has(`value_${index}`));
  }
  for (const record of session.records) localValidationSchema.parse(record);
  assert.ok(session.presentation('same_rule', 'node_0', 'same function scope', ['value_0']));
  assert.equal(session.records.length, 7);
});

test('presentation scope and exact reasons remain separate premises', () => {
  const session = new LocalValidationSession(createOperationContext());
  session.presentation('effect', 'first', 'scope', [], 'first contract');
  session.presentation('effect', 'second', 'scope', [], 'second contract');
  session.presentation('effect', 'third', 'other scope', [], 'first contract');
  assert.equal(session.records.length, 3);
  assert.deepEqual(
    session.records.map((record) => record.reason),
    ['first contract', 'second contract', 'first contract'],
  );
});

test('presentation admission is atomic and never raises the 256-record bound', () => {
  const session = new LocalValidationSession(createOperationContext());
  for (let index = 0; index < 255; index++)
    assert.ok(session.presentation('occupied', `node_${index}`, `scope ${index}`));
  assert.equal(
    session.presentation(
      'large',
      'root',
      'large scope',
      Array.from({ length: 130 }, (_, index) => `ref_${index}`),
    ),
    false,
  );
  assert.equal(session.records.filter((record) => record.status === 'verified').length, 255);
  assert.ok(!session.records.some((record) => record.subject_ids?.includes('ref_0')));
  // Adding a checked subject to an existing premise does not need a new record.
  assert.ok(session.presentation('occupied', 'extra', 'scope 0'));
  assert.ok(session.records[0]!.subject_ids?.includes('extra'));
  assert.equal(session.presentation('new', 'new subject', 'new scope'), false);
});

test('ABI assumptions aggregate unique anchors without merging different explanations', () => {
  const session = new LocalValidationSession(createOperationContext());
  for (let index = 0; index < 130; index++)
    session.requireAbi('layout', [`anchor_${index}`], 'target layout');
  session.requireAbi('layout', ['anchor_0'], 'target layout');
  session.requireAbi('layout', ['other'], 'different target premise');
  assert.deepEqual(
    session.abiConformance.map((site) => site.anchor_ids.length),
    [64, 64, 2, 1],
  );
  assert.equal(
    new Set(session.abiConformance.slice(0, 3).flatMap((site) => site.anchor_ids)).size,
    130,
  );
});

test('a forked session continues the same state without sharing any later record', () => {
  const session = new LocalValidationSession(createOperationContext(), true, 'function');
  for (let index = 0; index < 70; index++)
    session.presentation('rule', `node_${index}`, 'scope', [`value_${index}`]);
  session.requireAbi('layout', ['anchor_0'], 'target layout');
  session.check('presentation', 'checked', 'scope', () => ({
    kind: 'presentation',
    subject: 'checked',
    scope: 'scope',
    status: 'unverified',
    reason: 'not applicable',
  }));
  const snapshot = JSON.stringify([session.records, session.abiConformance]);
  const replay = (target: LocalValidationSession): string => {
    target.presentation('rule', 'node_70', 'scope', ['value_70']);
    target.presentation('rule', 'node_0', 'scope', ['value_0']);
    target.requireAbi('layout', ['anchor_1'], 'target layout');
    target.check('presentation', 'checked', 'scope', () => ({
      kind: 'presentation',
      subject: 'checked',
      scope: 'scope',
      status: 'unverified',
      reason: 'not applicable',
    }));
    return JSON.stringify([target.records, target.abiConformance]);
  };
  const first = session.fork(),
    second = session.fork();
  const extended = replay(first);
  // The open 64-subject chunk and the ABI chunk grew only in the fork.
  assert.equal(JSON.stringify([session.records, session.abiConformance]), snapshot);
  assert.equal(replay(second), extended, 'every fork continues from the same state');
  assert.equal(replay(session), extended, 'a fork behaves as the original would have');
  assert.equal(first.allowance.exhausted, session.allowance.exhausted);
});

test('source-only verified proof batching still executes every independent bitvector check', () => {
  for (const source of [false, true]) {
    const session = new LocalValidationSession(createOperationContext(), source);
    const input: Value = { id: 'input', type: integer(8) };
    const identity: Expression = { kind: 'cast', op: 'bitcast', value: input };
    let executed = 0;
    for (let index = 0; index < 70; index++) {
      const value: Value = { id: `result_${index}`, type: integer(8) };
      const record = session.check('bitvector', value.id, 'identity', () => {
        executed++;
        return validateBitvectorCandidate(value, identity, identity, new Map(), session.allowance);
      });
      assert.equal(record.status, 'verified');
    }
    assert.equal(executed, 70);
    assert.equal(session.records.length, source ? 2 : 70);
    if (source)
      assert.equal(new Set(session.records.flatMap((record) => record.subject_ids ?? [])).size, 70);
    for (const record of session.records) localValidationSchema.parse(record);
  }
});

test('source proof aggregation never merges counterexamples or unsuccessful checks', () => {
  const session = new LocalValidationSession(createOperationContext(), true);
  const input: Value = { id: 'input', type: integer(8) };
  for (let index = 0; index < 2; index++) {
    const value: Value = { id: `rejected_${index}`, type: integer(8) };
    const record = session.check('bitvector', value.id, 'different constants', () =>
      validateBitvectorCandidate(
        value,
        { kind: 'constant', bits: 0n },
        { kind: 'constant', bits: 1n },
        new Map(),
        session.allowance,
      ),
    );
    assert.equal(record.status, 'rejected');
  }
  for (let index = 0; index < 2; index++) {
    const value: Value = { id: `unverified_${index}`, type: integer(128) };
    const wide: Value = { id: `wide_${index}`, type: integer(128) };
    // Not congruent (identical candidates verify without a BDD); a 128-bit leaf
    // is outside the BDD's symbolic width.
    const record = session.check('bitvector', value.id, 'wide unsupported proof', () =>
      validateBitvectorCandidate(
        value,
        { kind: 'cast', op: 'zero_extend', value: input },
        { kind: 'cast', op: 'bitcast', value: wide },
        new Map(),
        session.allowance,
      ),
    );
    assert.equal(record.status, 'unverified');
  }
  assert.equal(session.records.length, 4);
  assert.ok(session.records.slice(0, 2).every((record) => record.counterexample));
  assert.deepEqual(
    session.records.map((record) => record.subject),
    ['rejected_0', 'rejected_1', 'unverified_0', 'unverified_1'],
  );
});

test('exhausted source proof work retains later original forms and publishes one counted summary', () => {
  for (const source of [false, true]) {
    const context = createOperationContext();
    const session = new LocalValidationSession(context, source, 'function');
    while (!session.allowance.exhausted) session.allowance.charge();
    const input: Value = { id: 'input', type: integer(8) };
    const count: Value = { id: 'count', type: integer(8) };
    const first: Value = { id: 'first', type: integer(8) };
    const second: Value = { id: 'second', type: integer(8) };
    const wiring: Value = { id: 'wiring', type: integer(8) };
    const folded: Value = { id: 'folded', type: integer(8) };
    const refolded: Value = { id: 'refolded', type: integer(8) };
    const wide: Value = { id: 'wide', type: integer(16) };
    const other: Value = { id: 'other', type: integer(16) };
    const sum: Value = { id: 'sum', type: integer(16) };
    const difference: Value = { id: 'difference', type: integer(16) };
    const low: Value = { id: 'low', type: integer(8) };
    const lowDifference: Value = { id: 'low_difference', type: integer(8) };
    const values = new Map(
      [
        input,
        count,
        first,
        second,
        wiring,
        folded,
        refolded,
        wide,
        other,
        sum,
        difference,
        low,
        lowDifference,
      ].map((value) => [value.id, value]),
    );
    // Shift-to-multiply is the speculative arithmetic candidate of the checked
    // view (the source view keeps a lone shift); constant folding is one in both
    // views. Low-bits narrowing carries its own lemma in the source view, and a
    // same-width offset-zero extract is exact wiring: neither is gated by proof work.
    const definitions = new Map<string, Expression>([
      [count.id, { kind: 'constant', bits: 1n }],
      [first.id, { kind: 'integer', op: 'shl', left: input, right: count }],
      [second.id, { kind: 'integer', op: 'shl', left: input, right: count }],
      [wiring.id, { kind: 'extract', value: input, offset: 0 }],
      [folded.id, { kind: 'integer', op: 'add', left: count, right: count }],
      [refolded.id, { kind: 'integer', op: 'mul', left: count, right: count }],
      [sum.id, { kind: 'integer', op: 'add', left: wide, right: other }],
      [difference.id, { kind: 'integer', op: 'sub', left: wide, right: other }],
      [low.id, { kind: 'extract', value: sum, offset: 0 }],
      [lowDifference.id, { kind: 'extract', value: difference, offset: 0 }],
    ]);
    const owners = new Map([...definitions.keys()].map((id): [string, string] => [id, 'block']));
    normalizeSourceExpressions(
      values,
      definitions,
      owners,
      (id, type, block, expression) => {
        const value: Value = { id, type };
        values.set(id, value);
        if (expression) definitions.set(id, expression);
        owners.set(id, block);
        return value;
      },
      context,
      session,
      undefined,
      source,
    );
    for (const value of [first, second]) {
      const definition = definitions.get(value.id)!;
      assert.ok(definition.kind === 'integer');
      assert.equal(definition.op, source ? 'shl' : 'mul');
    }
    for (const value of [low, lowDifference])
      assert.equal(definitions.get(value.id)!.kind, 'integer');
    for (const value of [folded, refolded])
      assert.equal(definitions.get(value.id)!.kind, source ? 'integer' : 'constant');
    assert.equal(definitions.get(wiring.id)!.kind, 'cast');
    const summaries = session.records.filter((record) => record.scope.includes('not attempted'));
    assert.equal(summaries.length, source ? 1 : 0);
    if (source) {
      assert.equal(summaries[0]!.subject, 'function');
      assert.match(summaries[0]!.reason!, /^2 later candidates were not attempted/);
      localValidationSchema.parse(summaries[0]);
    }
  }
});

/** A phi-copy check as the renderer runs it: the allowance is charged before any
 * proof step. */
const phiCopy = (session: LocalValidationSession, index: number) =>
  session.check(
    'parallel-copy',
    `destination_${index}`,
    'actual phi-copy emission',
    () => {
      session.allowance.charge();
      return {
        kind: 'parallel-copy',
        subject: `destination_${index}`,
        scope: 'actual phi-copy emission',
        status: 'verified',
      };
    },
    [`origin_${index}`],
  );

test('exhausted phi-copy checks publish one counted record and leave the bound to later presentations', () => {
  for (const source of [false, true]) {
    const session = new LocalValidationSession(createOperationContext(), source, 'function');
    for (let index = 0; index < 10; index++)
      assert.ok(session.presentation('rule', `node_${index}`, `scope ${index}`));
    while (!session.allowance.exhausted) session.allowance.charge();
    for (let index = 0; index < 300; index++) {
      const record = phiCopy(session, index);
      assert.equal(record.status, 'unverified');
      assert.equal(record.subject, `destination_${index}`);
      if (source || index < 246)
        assert.equal(record.reason, 'local validation work allowance exhausted');
    }
    const copies = session.records.filter((record) => record.kind === 'parallel-copy');
    for (const record of session.records) localValidationSchema.parse(record);
    if (!source) {
      // The checked view keeps one record per check: they fill the bound.
      assert.equal(session.records.length, 257);
      assert.equal(session.presentation('later', 'node', 'later scope'), false);
      continue;
    }
    assert.equal(copies.length, 1);
    assert.equal(copies[0]!.subject, 'function');
    assert.equal(copies[0]!.status, 'unverified');
    assert.equal(
      copies[0]!.reason,
      '300 later phi-copy emissions not validated; local validation allowance exhausted',
    );
    assert.equal(session.records.length, 11);
    // Rewrites whose side conditions are checked are still admitted and recorded.
    assert.ok(session.presentation('later', 'node', 'later scope'));
    assert.equal(session.records.length, 12);
    assert.equal(session.records.at(-1)!.rule, 'later');
    // The summary keeps its slot and its count as more checks fold into it.
    phiCopy(session, 300);
    assert.equal(session.records.length, 12);
    assert.match(session.records[10]!.reason!, /^301 later phi-copy emissions/);
  }
});

test('exhaustion summaries of both kinds share the terminal slots of a full record bound', () => {
  const session = new LocalValidationSession(createOperationContext(), true, 'function');
  for (let index = 0; index < 256; index++)
    assert.ok(session.presentation('rule', `node_${index}`, `scope ${index}`));
  assert.equal(session.presentation('rule', 'refused', 'new scope'), false);
  assert.equal(session.records.length, 257);
  assert.equal(session.records[256]!.subject, '*');
  while (!session.allowance.exhausted) session.allowance.charge();
  assert.ok(session.skipExhaustedBitvector('first'));
  for (let index = 0; index < 3; index++) phiCopy(session, index);
  assert.ok(session.skipExhaustedBitvector('second'));
  assert.equal(session.records.length, 258);
  assert.deepEqual(
    session.records.slice(256).map((record) => [record.kind, record.reason]),
    [
      [
        'bitvector',
        'local validation record bound exceeded; 2 later candidates were not attempted because the local validation allowance was exhausted',
      ],
      [
        'parallel-copy',
        'local validation record bound exceeded; 3 later phi-copy emissions not validated; local validation allowance exhausted',
      ],
    ],
  );
  // A fork continues each count without changing the original's records.
  const fork = session.fork();
  phiCopy(fork, 3);
  assert.match(fork.records[257]!.reason!, /; 4 later phi-copy emissions/);
  assert.match(session.records[257]!.reason!, /; 3 later phi-copy emissions/);
  for (const record of fork.records) localValidationSchema.parse(record);
});
