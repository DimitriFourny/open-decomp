import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, entityIdentity } from '../../src/core/index.js';
import {
  IRBuilder,
  evaluateExpression,
  evaluateIR,
  integer,
  type Expression,
  type RuntimeValue,
  type SSAForm,
  type Value,
} from '../../src/ir/index.js';
import { foldExpressions } from '../../src/reconstruction/expressions.js';
import type { Assignment } from '../../src/reconstruction/model.js';
import { provenance, slice } from '../ir/support.js';

const i1 = integer(1),
  i8 = integer(8),
  i32 = integer(32);
function folded(input: SSAForm) {
  const assignments = input.blocks.flatMap((block) =>
    block.instructions.filter((node): node is Assignment => node.kind === 'assign'),
  );
  // Consumers deliberately precede definitions: newly exposed dependencies must
  // participate in the worklist, not depend on the builder's insertion order.
  const expressions = foldExpressions(
    new Map(assignments.toReversed().map((node) => [node.result.id, node])),
    createOperationContext(),
  );
  const rewritten: SSAForm = {
    ...input,
    blocks: input.blocks.map((block) => ({
      ...block,
      instructions: block.instructions.map((node) =>
        node.kind === 'assign' ? { ...node, expression: expressions.get(node.result.id)! } : node,
      ),
    })),
  };
  const again = foldExpressions(
    new Map(
      assignments.map((node) => [
        node.result.id,
        { ...node, expression: expressions.get(node.result.id)! },
      ]),
    ),
    createOperationContext(),
  );
  assert.deepEqual(again, expressions, 'the completed worklist is a fixpoint');
  return { expressions, rewritten };
}
function results(
  input: SSAForm,
  arguments_: readonly RuntimeValue[],
  outputs: readonly Value[],
): RuntimeValue[] {
  const block = input.blocks[0]!;
  const values = new Map(block.parameters.map((value, index) => [value.id, arguments_[index]!]));
  for (const node of block.instructions)
    if (node.kind === 'assign')
      values.set(
        node.result.id,
        evaluateExpression(node.result.type, node.expression, (value) => values.get(value.id)!),
      );
  return outputs.map((value) => values.get(value.id)!);
}
function comparison(expressions: ReadonlyMap<string, Expression>, value: Value, op: string): void {
  const expression = expressions.get(value.id);
  assert.equal(expression?.kind, 'compare');
  if (expression?.kind === 'compare') assert.equal(expression.op, op);
}

for (const width of [8, 32, 64])
  for (const architecture of ['arm64', 'x86_64'])
    test(`${architecture} ${width}-bit lifted conditions preserve overflow and indeterminate precedence`, () => {
      const type = integer(width),
        b = new IRBuilder(
          slice,
          entityIdentity(slice, 'function', `lifted-conditions-${architecture}-${width}`),
          provenance,
          'ssa',
        );
      const block = b.block('entry', [type, type]);
      const [a, c] = block.parameters as readonly [Value, Value];
      const identity = (value: Value) =>
        block.cast('bitcast', value.type, block.cast('bitcast', value.type, value));
      const carry = identity(block.constant(i1, 0n));
      const difference = identity(
        block.int(
          'sub',
          block.int('sub', identity(a), identity(c)),
          block.cast('zero_extend', type, carry),
        ),
      );
      let negative: Value, zero: Value, overflow: Value, unsigned: Value;
      if (architecture === 'arm64') {
        const flags = (['negative', 'zero', 'carry', 'overflow'] as const).map((flag) =>
          block.flag('sub', flag, identity(a), identity(c), carry),
        );
        let packed = block.constant(i32, 0n);
        for (let index = 0; index < flags.length; index++)
          packed = block.insert(packed, flags[index]!, 31 - index);
        packed = identity(packed);
        negative = block.extract(packed, 31, 1);
        zero = block.extract(packed, 30, 1);
        overflow = block.extract(packed, 28, 1);
        unsigned = block.int('and', block.extract(packed, 29, 1), block.unary('not', zero));
      } else {
        negative = block.extract(difference, width - 1, 1);
        zero = block.compare('eq', difference, block.constant(type, 0n));
        overflow = block.flag('sub', 'overflow', identity(a), identity(c), carry);
        const borrow = block.flag('sub', 'borrow', identity(a), identity(c), carry);
        unsigned = block.unary('not', block.int('or', borrow, identity(zero)));
      }
      const signed =
        architecture === 'arm64'
          ? block.int(
              'and',
              block.compare('eq', identity(negative), identity(overflow)),
              block.unary('not', identity(zero)),
            )
          : block.unary(
              'not',
              block.int(
                'or',
                identity(zero),
                block.int('xor', identity(negative), identity(overflow)),
              ),
            );
      const nonzero = block.compare('ne', difference, block.constant(type, 0n));
      const maximum = block.select(signed, a, c);
      const outputs = [signed, unsigned, zero, nonzero, maximum, negative];
      block.return(outputs);
      const input = b.finish(
          block,
          outputs.map((value) => value.type),
        ),
        { expressions, rewritten } = folded(input);
      comparison(expressions, signed, 'sgt');
      comparison(expressions, unsigned, 'ugt');
      comparison(expressions, nonzero, 'ne');
      const edge = 1n << BigInt(width - 1),
        known = [0n, 1n, edge - 1n, edge, edge + 1n, edge * 2n - 1n];
      for (const left of known)
        for (const right of known)
          assert.deepEqual(
            evaluateIR(rewritten, { arguments: [left, right] }),
            evaluateIR(input, { arguments: [left, right] }),
          );
      const states: RuntimeValue[] = [
        ...known.map((bits) => ({ kind: 'bits' as const, bits })),
        { kind: 'unknown', reason: 'first unknown' },
        { kind: 'unknown', reason: 'second unknown' },
        { kind: 'undefined', reason: 'first undefined' },
        { kind: 'undefined', reason: 'second undefined' },
      ];
      for (const left of states)
        for (const right of states)
          assert.deepEqual(
            results(rewritten, [left, right], outputs),
            results(input, [left, right], outputs),
          );
    });

test('packed extraction never discards independent, reordered, or partial-operation taint', () => {
  const b = new IRBuilder(
    slice,
    entityIdentity(slice, 'function', 'packed-taint'),
    provenance,
    'ssa',
  );
  const block = b.block('entry', [i8, i8, i32, i1]);
  const [a, c, ambient, extra] = block.parameters as readonly [Value, Value, Value, Value];
  const zero = block.constant(i1, 0n),
    base = block.constant(i32, 0n);
  const selected = block.flag('sub', 'negative', a, c, zero);
  const reverse = block.flag('sub', 'overflow', c, a, zero);
  const matching = block.flag('sub', 'overflow', a, c, zero);
  const partial = block.int('udiv', a, c);
  const undefinedValue = block.indeterminate(i1, 'undefined', 'discarded undefined bit');
  const unknownValue = block.indeterminate(i1, 'unknown', 'discarded unknown bit');
  const packed = [
    block.insert(ambient, selected, 31),
    block.insert(block.insert(base, extra, 30), selected, 31),
    block.insert(block.insert(base, reverse, 30), selected, 31),
    block.insert(block.insert(base, partial, 0), selected, 31),
    block.insert(block.insert(base, undefinedValue, 30), selected, 31),
    block.insert(block.insert(base, unknownValue, 30), selected, 31),
    block.insert(block.insert(base, matching, 30), selected, 31),
    block.insert(block.insert(base, selected, 31), matching, 30),
  ];
  const outputs = packed.map((value) => block.extract(value, 31, 1));
  // Even complete overwrite retains the base's indeterminate result.
  const overwritten = block.insert(ambient, block.constant(i32, 7n), 0);
  outputs.push(block.extract(overwritten, 0, 32));
  block.return(outputs);
  const input = b.finish(
      block,
      outputs.map((value) => value.type),
    ),
    { expressions, rewritten } = folded(input);
  for (const output of outputs.slice(0, 6))
    assert.equal(expressions.get(output.id)?.kind, 'extract');
  for (const output of outputs.slice(6, 8)) assert.equal(expressions.get(output.id)?.kind, 'cast');
  assert.deepEqual(expressions.get(outputs[8]!.id), {
    kind: 'cast',
    op: 'bitcast',
    value: overwritten,
  });
  const states: RuntimeValue[] = [
    { kind: 'bits', bits: 0n },
    { kind: 'bits', bits: 1n },
    { kind: 'bits', bits: 255n },
    { kind: 'unknown', reason: 'input unknown' },
    { kind: 'undefined', reason: 'input undefined' },
  ];
  for (const left of states)
    for (const right of states)
      for (const ambientValue of states)
        for (const extraValue of states.slice(0, 2).concat(states.slice(3))) {
          const arguments_ = [left, right, ambientValue, extraValue];
          assert.deepEqual(
            results(rewritten, arguments_, outputs),
            results(input, arguments_, outputs),
          );
        }
});

test('identity cycles terminate without inventing constants or comparison operands', () => {
  const b = new IRBuilder(
    slice,
    entityIdentity(slice, 'function', 'cyclic-condition-identities'),
    provenance,
    'ssa',
  );
  const block = b.block('entry'),
    a = block.constant(i8, 1n),
    c = block.constant(i8, 2n);
  block.return([a]);
  const input = b.finish(block, [i8]);
  const nodes = input.blocks[0]!.instructions.filter(
    (node): node is Assignment => node.kind === 'assign',
  );
  const assignments = new Map(
    nodes.map((node) => [
      node.result.id,
      {
        ...node,
        expression: {
          kind: 'cast',
          op: 'bitcast',
          value: node.result.id === a.id ? c : a,
        } as Expression,
      },
    ]),
  );
  assert.deepEqual(
    foldExpressions(assignments, createOperationContext({ budget: { work: 200 } })),
    new Map([...assignments].map(([id, node]) => [id, node.expression])),
  );
});
