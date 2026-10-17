import assert from 'node:assert/strict';
import { createOperationContext, entityIdentity, OperationError } from '../../src/core/index.js';
import { mapExpression } from '../../src/analysis/effects/index.js';
import { IRBuilder, integer, type Expression, type Value } from '../../src/ir/index.js';
import {
  normalizeSourceExpressions,
  sourceExpressionDemand,
} from '../../src/reconstruction/source-expressions.js';
import { LocalValidationSession } from '../../src/reconstruction/local-validation.js';
import { provenance, slice } from '../ir/support.js';
import { emit, execute } from '../emitters/c/support.js';

/** Exercise definition-order and factory boundaries directly, then consume the
 * resulting shared DAG through both real emitters. Expected arithmetic comes
 * from the unsigned source formulas below, not a second normalization run. */
export function checkSourceExpressionWorklist(): { outcomes: number; scenarios: number } {
  let outcomes = 0;
  const input = (name: string, width = 64): Value => ({
    id: entityIdentity(slice, 'value', ['normalization-worklist', name]),
    type: integer(width),
  });
  const x = input('x'),
    y = input('y');
  const samples = [
    0n,
    1n,
    0x7fffffffn,
    0x80000000n,
    0xffffffffn,
    0x8000000000000000n,
    0xffffffffffffffffn,
  ];
  const check = (
    name: string,
    root: Value,
    entries: readonly (readonly [Value, Expression])[],
    expected: (x: bigint, y: bigint) => bigint,
    inspect: (definitions: ReadonlyMap<string, Expression>) => void,
    aliases: readonly (readonly [Value, Value])[] = [],
  ): void => {
    const dead = input(`undemanded-${name}`),
      deadCount = input(`undemanded-count-${name}`);
    const values = new Map(
      [x, y, dead, deadCount, ...entries.map(([value]) => value)].map((value) => [value.id, value]),
    );
    const definitions = new Map(entries.map(([value, expression]) => [value.id, expression]));
    definitions.set(deadCount.id, { kind: 'constant', bits: 1n });
    definitions.set(dead.id, { kind: 'integer', op: 'shl', left: x, right: deadCount });
    const owners = new Map([...values.keys()].map((id) => [id, 'entry']));
    const context = createOperationContext(),
      validation = new LocalValidationSession(context);
    const make: Parameters<typeof normalizeSourceExpressions>[3] = (
      key,
      type,
      block,
      expression,
    ) => {
      context.checkpoint(1);
      const id = entityIdentity(slice, 'value', ['normalization-created', name, key]);
      const previous = values.get(id);
      if (previous) return previous;
      const value = { id, type };
      values.set(id, value);
      owners.set(id, block);
      if (expression) definitions.set(id, expression);
      return value;
    };
    const demand = sourceExpressionDemand([root], definitions, new Map(), context);
    const normalization = normalizeSourceExpressions(
      values,
      definitions,
      owners,
      make,
      context,
      validation,
      demand,
    );
    for (const [value, source] of aliases) {
      definitions.set(value.id, { kind: 'cast', op: 'bitcast', value: source });
      normalization.changed(value.id);
    }
    normalization.run();
    inspect(definitions);
    assert.ok(validation.records.every((record) => record.status !== 'rejected'));
    const undemanded = definitions.get(dead.id);
    assert.ok(undemanded?.kind === 'integer' && undemanded.op === 'shl');
    assert.ok(
      !validation.records.some((record) => record.subject === dead.id),
      'an unperformed rewrite has no fabricated/dropped proof record',
    );
    const builder = new IRBuilder(
      slice,
      entityIdentity(slice, 'function', ['normalization-output', name]),
      provenance,
      'ssa',
    );
    const block = builder.block('entry', [x.type, y.type]);
    const rebuilt = new Map<string, Value>([
      [x.id, block.parameters[0]!],
      [y.id, block.parameters[1]!],
    ]);
    const copy = (value: Value): Value => {
      const previous = rebuilt.get(value.id);
      if (previous) return previous;
      const expression = definitions.get(value.id);
      assert.ok(expression, `Missing normalized definition ${value.id}`);
      const result = block.assign(value.type, mapExpression(expression, copy));
      rebuilt.set(value.id, result);
      return result;
    };
    block.return([copy(root)]);
    const ir = builder.finish(block, [root.type]);
    for (const language of ['c-like', 'python-like'] as const) {
      // No source reconstruction here: emit exactly the normalized definitions,
      // rather than allowing another source-normalization pass to fix a miss.
      const output = emit(ir, {}, language);
      for (const [index, left] of samples.entries()) {
        const right = samples[samples.length - 1 - index]!;
        const observed = execute(
          output.emission,
          new Map([
            [block.parameters[0]!.id, left],
            [block.parameters[1]!.id, right],
          ]),
        );
        assert.equal(observed.exit, 'machine_return', `${name}/${language}`);
        assert.deepEqual(observed.values, [expected(left, right)], `${name}/${language}/${index}`);
        assert.deepEqual(observed.events, []);
        outcomes++;
      }
    }
  };
  // Readers precede all inspected definitions. A cached identity prefix must be
  // invalidated when its terminal becomes an alias, and scaled() must observe a
  // not-yet-constant shift count through another identity prefix.
  const root = input('late-root'),
    scaleAlias = input('late-scale-alias'),
    scale = input('late-scale');
  const alias = input('late-alias'),
    pack = input('late-pack'),
    countAlias = input('late-count-alias');
  const count = input('late-count'),
    one = input('late-one');
  for (const shift of [1n, 2n]) {
    check(
      `late-definitions-${shift}`,
      root,
      [
        [root, { kind: 'integer', op: 'add', left: x, right: scaleAlias }],
        [scaleAlias, { kind: 'cast', op: 'bitcast', value: scale }],
        [scale, { kind: 'integer', op: 'shl', left: alias, right: countAlias }],
        [alias, { kind: 'cast', op: 'bitcast', value: pack }],
        [pack, { kind: 'concat', values: [x] }],
        [countAlias, { kind: 'cast', op: 'bitcast', value: count }],
        [count, { kind: 'cast', op: 'zero_extend', value: one }],
        [one, { kind: 'constant', bits: shift }],
      ],
      (value) => BigInt.asUintN(64, value * (1n + (1n << shift))),
      (definitions) => {
        const normalized = definitions.get(root.id);
        assert.ok(normalized?.kind === 'integer' && normalized.op === 'mul');
        assert.equal(normalized.left.id, x.id);
        assert.deepEqual(definitions.get(normalized.right.id), {
          kind: 'constant',
          bits: 1n + (1n << shift),
        });
        assert.deepEqual(
          definitions.get(pack.id),
          { kind: 'cast', op: 'bitcast', value: x },
          'single-part concat needs self-requeue',
        );
      },
    );
  }
  // Extracting the low word manufactures new low-bits definitions. Those nodes
  // themselves become arithmetic only after the original shift becomes mul.
  const low = input('narrow-root', 32),
    sum = input('narrow-sum'),
    shifted = input('narrow-shifted');
  check(
    'new-low-bits-definitions',
    low,
    [
      [low, { kind: 'extract', value: sum, offset: 0 }],
      [sum, { kind: 'integer', op: 'add', left: x, right: shifted }],
      [shifted, { kind: 'integer', op: 'shl', left: x, right: one }],
      [one, { kind: 'constant', bits: 1n }],
    ],
    (value) => BigInt.asUintN(32, 3n * value),
    (definitions) => {
      const normalized = definitions.get(low.id);
      assert.ok(normalized?.kind === 'integer' && normalized.op === 'mul');
      assert.deepEqual(definitions.get(normalized.right.id), { kind: 'constant', bits: 3n });
      assert.ok(
        [...definitions.values()].every(
          (expression) =>
            expression.kind !== 'extract' ||
            !['integer', 'constant'].includes(definitions.get(expression.value.id)?.kind ?? ''),
        ),
        'newly inserted narrowing definitions are processed to their own fixed point',
      );
    },
  );
  const distinct = input('distinct-root'),
    twice = input('distinct-twice');
  check(
    'distinct-input-identities',
    distinct,
    [
      [distinct, { kind: 'integer', op: 'add', left: x, right: twice }],
      [twice, { kind: 'integer', op: 'shl', left: y, right: one }],
      [one, { kind: 'constant', bits: 1n }],
    ],
    (left, right) => BigInt.asUintN(64, left + 2n * right),
    (definitions) => {
      const normalized = definitions.get(distinct.id);
      assert.ok(normalized?.kind === 'integer' && normalized.op === 'add');
    },
  );
  check(
    'resumed-proven-identity',
    distinct,
    [
      [distinct, { kind: 'integer', op: 'add', left: x, right: twice }],
      [twice, { kind: 'integer', op: 'shl', left: y, right: one }],
      [one, { kind: 'constant', bits: 1n }],
    ],
    (value) => BigInt.asUintN(64, 3n * value),
    (definitions) => {
      const normalized = definitions.get(distinct.id);
      assert.ok(normalized?.kind === 'integer' && normalized.op === 'mul');
      assert.equal(normalized.left.id, x.id);
      assert.deepEqual(definitions.get(normalized.right.id), { kind: 'constant', bits: 3n });
    },
    [[y, x]],
  );
  const signed = input('signed-root');
  check(
    'signed-shift-retained',
    signed,
    [
      [signed, { kind: 'integer', op: 'ashr', left: x, right: one }],
      [one, { kind: 'constant', bits: 1n }],
    ],
    (value) => BigInt.asUintN(64, BigInt.asIntN(64, value) >> 1n),
    (definitions) => {
      const normalized = definitions.get(signed.id);
      assert.ok(normalized?.kind === 'integer' && normalized.op === 'ashr');
    },
  );
  // A prior invocation with the same value IDs cannot seed a later invocation,
  // even when its expressions/constant assumptions differ (the two late cases).
  const controller = new AbortController();
  controller.abort();
  for (const [context, code] of [
    [createOperationContext({ signal: controller.signal }), 'cancelled'],
    [createOperationContext({ budget: { work: 1 } }), 'resource_limit'],
  ] as const) {
    const definitions = new Map<string, Expression>([
      [root.id, { kind: 'integer', op: 'add', left: x, right: y }],
    ]);
    assert.throws(
      () =>
        normalizeSourceExpressions(
          new Map([[root.id, root]]),
          definitions,
          new Map([[root.id, 'entry']]),
          () => assert.fail('unexpected synthetic value'),
          context,
        ),
      (error: unknown) => error instanceof OperationError && error.code === code,
    );
  }
  const resumedController = new AbortController();
  const emptySession = normalizeSourceExpressions(
    new Map([[root.id, root]]),
    new Map([[root.id, { kind: 'constant', bits: 0n }]]),
    new Map([[root.id, 'entry']]),
    () => assert.fail('unexpected synthetic value'),
    createOperationContext({ signal: resumedController.signal }),
  );
  resumedController.abort();
  assert.throws(
    () => emptySession.run(),
    (error: unknown) => error instanceof OperationError && error.code === 'cancelled',
  );
  return { outcomes, scenarios: 6 };
}
