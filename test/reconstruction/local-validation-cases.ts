import assert from 'node:assert/strict';
import { createOperationContext, entityIdentity, OperationError } from '../../src/core/index.js';
import { localValidationSchema } from '../../src/core/tools.js';
import { IRBuilder, integer, type Expression, type Value } from '../../src/ir/index.js';
import {
  LocalValidationSession,
  ValidationAllowance,
  validateBitvectorCandidate,
  validateControlTarget,
  validateParallelMoves,
} from '../../src/reconstruction/local-validation.js';
import { validateStorageTrace } from '../../src/reconstruction/local-storage-validation.js';
import { structureControlFlow, type ParallelTransfer } from '../../src/presentation/index.js';
import { reconstruct } from '../../src/reconstruction/index.js';
import {
  validateEmittedControl,
  type EmittedEdge,
} from '../../src/reconstruction/local-control-validation.js';
import { normalizeSourceExpressions } from '../../src/reconstruction/source-expressions.js';
import { provenance, slice } from '../ir/support.js';

export function localValidationCounterexamples(): void {
  const value = (name: string, width: number): Value => ({
    id: entityIdentity(slice, 'value', name),
    type: integer(width),
  });
  const allowance = () =>
    new ValidationAllowance(createOperationContext({ budget: { work: 1_000_000 } }), 100_000);
  const x = value('x', 8),
    y = value('y', 8),
    result = value('result', 8);
  const carry = validateBitvectorCandidate(
    result,
    { kind: 'integer', op: 'add', left: x, right: y },
    { kind: 'integer', op: 'xor', left: x, right: y },
    new Map(),
    allowance(),
  );
  assert.equal(localValidationSchema.parse(carry).status, 'rejected');
  const carryX = BigInt(carry.counterexample![x.id]!),
    carryY = BigInt(carry.counterexample![y.id]!);
  assert.notEqual(BigInt.asUintN(8, carryX + carryY), carryX ^ carryY);
  const wide = value('wide', 64),
    count = value('count', 64),
    shifted = value('shifted', 64);
  const constants = new Map<string, Expression>([[count.id, { kind: 'constant', bits: 1n }]]);
  const signed = validateBitvectorCandidate(
    shifted,
    { kind: 'integer', op: 'ashr', left: wide, right: count },
    { kind: 'integer', op: 'lshr', left: wide, right: count },
    constants,
    allowance(),
  );
  assert.equal(localValidationSchema.parse(signed).status, 'rejected');
  const signedX = BigInt(signed.counterexample![wide.id]!);
  assert.notEqual(BigInt.asUintN(64, BigInt.asIntN(64, signedX) >> 1n), signedX >> 1n);
  for (const width of [32, 64]) {
    const input = value(`scale-${width}`, width),
      one = value(`one-${width}`, width),
      two = value(`two-${width}`, width);
    const definitions = new Map<string, Expression>([
      [one.id, { kind: 'constant', bits: 1n }],
      [two.id, { kind: 'constant', bits: 2n }],
    ]);
    assert.equal(
      validateBitvectorCandidate(
        input,
        { kind: 'integer', op: 'shl', left: input, right: one },
        { kind: 'integer', op: 'mul', left: input, right: two },
        definitions,
        allowance(),
      ).status,
      'verified',
    );
  }
  const sourceCount = value('source-count', 8),
    sourceResult = value('source-result', 8);
  const sourceValues = new Map([x, sourceCount, sourceResult].map((v) => [v.id, v]));
  const originalSource: Expression = { kind: 'integer', op: 'shl', left: x, right: sourceCount };
  const sourceDefinitions = new Map<string, Expression>([
    [sourceCount.id, { kind: 'constant', bits: 1n }],
    [sourceResult.id, originalSource],
  ]);
  const sourceOwner = new Map([x, sourceCount, sourceResult].map((v) => [v.id, 'entry']));
  const sourceContext = createOperationContext(),
    sourceValidation = new LocalValidationSession(sourceContext);
  let factors = 0;
  const makeWrongFactor: Parameters<typeof normalizeSourceExpressions>[3] = (
    _key,
    type,
    block,
    expression,
  ) => {
    // Deliberately corrupt a real normalization candidate at its builder boundary,
    // not the independent oracle or generated source text.
    assert.ok(expression?.kind === 'constant');
    const factor = { id: entityIdentity(slice, 'value', `wrong-source-factor-${factors++}`), type };
    sourceValues.set(factor.id, factor);
    sourceOwner.set(factor.id, block);
    sourceDefinitions.set(factor.id, { kind: 'constant', bits: expression.bits + 1n });
    return factor;
  };
  const sourceNormalization = normalizeSourceExpressions(
    sourceValues,
    sourceDefinitions,
    sourceOwner,
    makeWrongFactor,
    sourceContext,
    sourceValidation,
    // The shift-to-multiply candidate is the checked-view normalization: the source
    // view keeps a lone shift and only folds the strength-reduced patterns.
    undefined,
    false,
  );
  assert.equal(
    sourceDefinitions.get(sourceResult.id),
    originalSource,
    'rejected source candidate preserves original evidence and expression',
  );
  assert.ok(
    sourceValidation.records.some(
      (record) =>
        record.subject === sourceResult.id &&
        localValidationSchema.parse(record).status === 'rejected' &&
        record.counterexample,
    ),
  );
  for (let i = 0; i < 256; i++)
    sourceValidation.check('bitvector', result.id, 'exhaustion regression', () =>
      validateBitvectorCandidate(
        result,
        { kind: 'integer', op: 'add', left: x, right: y },
        { kind: 'integer', op: 'add', left: x, right: y },
        new Map(),
        sourceValidation.allowance,
      ),
    );
  sourceNormalization.changed(sourceResult.id);
  sourceNormalization.run();
  assert.equal(
    sourceDefinitions.get(sourceResult.id),
    originalSource,
    'resuming after proof/record exhaustion preserves the rewrite veto',
  );
  normalizeSourceExpressions(
    sourceValues,
    sourceDefinitions,
    sourceOwner,
    makeWrongFactor,
    sourceContext,
    sourceValidation,
  );
  assert.equal(
    sourceDefinitions.get(sourceResult.id),
    originalSource,
    'proof/record exhaustion cannot reapply a previously rejected rewrite',
  );
  assert.equal(factors, 1);
  const copies = [
    { destination: x, source: y },
    { destination: y, source: x },
  ];
  const wrong = validateParallelMoves(
    'cycle',
    copies,
    [
      { destination: x.id, source: y },
      { destination: y.id, source: x },
    ],
    () => undefined,
    allowance(),
  );
  assert.equal(localValidationSchema.parse(wrong).status, 'rejected');
  assert.notEqual(wrong.counterexample![x.id], wrong.counterexample![y.id]);
  assert.equal(
    validateParallelMoves(
      'cycle',
      copies,
      [
        { destination: 'capture', source: y },
        { destination: y.id, source: x },
        { destination: x.id, source: 'capture' },
      ],
      () => undefined,
      allowance(),
    ).status,
    'verified',
  );
  const uninitialized = validateStorageTrace(
    'slot',
    [{ kind: 'load', offset: -4n, bytes: 4, candidate: 'local' }],
    allowance(),
  );
  assert.equal(localValidationSchema.parse(uninitialized).status, 'rejected');
  assert.equal(uninitialized.counterexample!.original, 'uninitialized');
  const store = { kind: 'store' as const, offset: -4n, bytes: 4, value: 'x', promoted: true };
  const load = { kind: 'load' as const, offset: -4n, bytes: 4, candidate: 'local' };
  assert.equal(validateStorageTrace('slot', [store, load], allowance()).status, 'verified');
  assert.equal(
    localValidationSchema.parse(
      validateStorageTrace(
        'slot',
        [store, { kind: 'store', offset: null, bytes: 4, value: 'alias', promoted: false }, load],
        allowance(),
      ),
    ).status,
    'rejected',
  );
  assert.equal(
    validateStorageTrace('slot', [store, { ...load, endian: 'big' }], allowance()).status,
    'rejected',
  );
  assert.equal(
    localValidationSchema.parse(validateControlTarget('exit', 'intended', 'wrong')).status,
    'rejected',
  );
  assert.equal(validateControlTarget('exit', 'intended', 'intended').status, 'verified');
  const builder = new IRBuilder(
    slice,
    entityIdentity(slice, 'function', 'translation-rendered-exit'),
    provenance,
    'ssa',
  );
  const start = builder.block('start', [integer(8)]),
    yes = builder.block('yes'),
    no = builder.block('no');
  start.branch(
    start.compare('eq', start.parameters[0]!, start.constant(integer(8), 0n)),
    start.edge(yes),
    start.edge(no),
  );
  yes.return([yes.constant(integer(8), 1n)]);
  no.return([no.constant(integer(8), 2n)]);
  const structured = structureControlFlow(
    builder.finish(start, [integer(8)]),
    createOperationContext(),
  );
  assert.ok(structured.value);
  const program = reconstruct({ function: structured.value }, createOperationContext());
  const actions = new Map<ParallelTransfer, EmittedEdge>();
  for (const transfer of program.transfers.keys())
    actions.set(transfer, { kind: 'goto', target: transfer.target });
  const validExits = new LocalValidationSession(createOperationContext());
  validateEmittedControl(program.function, actions, 'c-like', validExits);
  assert.ok(
    validExits.records.some((record) => record.kind === 'control' && record.status === 'verified'),
  );
  const firstEdge = actions.keys().next().value!;
  actions.set(firstEdge, { kind: 'goto', target: 'wrong-rendered-exit' });
  const invalidExits = new LocalValidationSession(createOperationContext());
  validateEmittedControl(program.function, actions, 'c-like', invalidExits);
  assert.ok(
    invalidExits.records.some(
      (record) =>
        localValidationSchema.parse(record).status === 'rejected' &&
        record.counterexample?.actual === 'wrong-rendered-exit',
    ),
  );
  const unknown = value('unknown', 8);
  for (const state of ['unknown', 'undefined'] as const) {
    const unknownDefinitions = new Map<string, Expression>([
      [unknown.id, { kind: 'indeterminate', state, reason: 'machine unknown/poison' }],
    ]);
    assert.equal(
      validateBitvectorCandidate(
        result,
        { kind: 'cast', op: 'bitcast', value: unknown },
        { kind: 'constant', bits: 0n },
        unknownDefinitions,
        allowance(),
      ).status,
      'unverified',
    );
  }
  // Not congruent: identical candidates verify by congruence without a BDD.
  const pure: Expression = { kind: 'integer', op: 'add', left: x, right: y };
  const swapped: Expression = { kind: 'integer', op: 'add', left: y, right: x };
  assert.equal(
    validateBitvectorCandidate(
      result,
      pure,
      swapped,
      new Map(),
      new ValidationAllowance(createOperationContext(), 0),
    ).status,
    'unverified',
  );
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () =>
      validateBitvectorCandidate(
        result,
        pure,
        swapped,
        new Map(),
        new ValidationAllowance(createOperationContext({ signal: controller.signal })),
      ),
    (error: unknown) => error instanceof OperationError && error.code === 'cancelled',
  );
  assert.throws(
    () =>
      validateBitvectorCandidate(
        result,
        pure,
        swapped,
        new Map(),
        new ValidationAllowance(createOperationContext({ budget: { work: 1 } }), 100),
      ),
    (error: unknown) => error instanceof OperationError && error.code === 'resource_limit',
  );
  let charged = 0;
  const context = createOperationContext();
  const session = new LocalValidationSession({
    ...context,
    remainingWork: () => 640,
    checkpoint(work) {
      charged += work;
      context.checkpoint(work);
    },
  });
  for (let i = 0; i < 4; i++)
    session.check(
      'bitvector',
      result.id,
      'bounded',
      () => validateBitvectorCandidate(result, pure, swapped, new Map(), session.allowance),
      [result.id],
    );
  // Ten allowance ticks in total plus bounded structural steps per candidate
  // (congruence and cone walks are charged to the operation, not the allowance).
  assert.ok(session.allowance.exhausted, 'one shared allowance, not reset');
  assert.ok(charged < 256, `bounded structural work (${charged})`);
  assert.ok(session.records.every((record) => record.status === 'unverified'));
  assert.ok(
    session.records.every((record) => record.subject_ids?.[0] === result.id),
    'unverified results retain original mapped subjects',
  );
}
