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
    const identity: Expression = { kind: 'cast', op: 'zero_extend', value: input };
    const record = session.check('bitvector', value.id, 'wide unsupported proof', () =>
      validateBitvectorCandidate(value, identity, identity, new Map(), session.allowance),
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
    const values = new Map([input, count, first, second, wiring].map((value) => [value.id, value]));
    // Shift-to-multiply is a speculative arithmetic candidate; a same-width
    // offset-zero extract is exact wiring and is not gated by proof work.
    const definitions = new Map<string, Expression>([
      [count.id, { kind: 'constant', bits: 1n }],
      [first.id, { kind: 'integer', op: 'shl', left: input, right: count }],
      [second.id, { kind: 'integer', op: 'shl', left: input, right: count }],
      [wiring.id, { kind: 'extract', value: input, offset: 0 }],
    ]);
    const owners = new Map([
      [count.id, 'block'],
      [first.id, 'block'],
      [second.id, 'block'],
      [wiring.id, 'block'],
    ]);
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
