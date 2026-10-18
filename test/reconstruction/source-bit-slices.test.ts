import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, entityIdentity } from '../../src/core/index.js';
import { mapExpression } from '../../src/analysis/effects/index.js';
import { IRBuilder, integer, type Expression, type Value } from '../../src/ir/index.js';
import { normalizeSourceExpressions } from '../../src/reconstruction/source-expressions.js';
import { LocalValidationSession } from '../../src/reconstruction/local-validation.js';
import { provenance, slice } from '../ir/support.js';
import { emit, execute } from '../emitters/c/support.js';

for (const scenario of [
  'whole',
  'nested',
  'pair128',
  'insert-identity',
  'byte-insert',
  'word-insert',
  'middle-insert',
  'zero-upper',
  'signed-upper',
  'shift-or',
  'shift-xor',
  'packing-shift',
  'packing-xor',
  'overlap-or',
  'checked',
  'different-halves',
  'wrong-offset',
  'discarded-unknown',
  'capacity',
] as const) {
  test(`source register wiring: ${scenario}`, () => {
    const values = new Map<string, Value>(),
      definitions = new Map<string, Expression>(),
      owners = new Map<string, string>();
    const make: Parameters<typeof normalizeSourceExpressions>[3] = (
      key,
      type,
      block,
      expression,
    ) => {
      const id = entityIdentity(slice, 'value', ['source-bit-slices', scenario, key]);
      const previous = values.get(id);
      if (previous) return previous;
      const value = { id, type };
      values.set(id, value);
      owners.set(id, block);
      if (expression) definitions.set(id, expression);
      return value;
    };
    const x = make('x', integer(64), 'entry'),
      y = make('y', integer(64), 'entry');
    const add = (key: string, width: number, expression: Expression) =>
      make(key, integer(width), 'entry', expression);
    const low = add('low', 32, { kind: 'extract', value: x, offset: 0 });
    const high = add('high', 32, {
      kind: 'extract',
      value: scenario === 'different-halves' ? y : x,
      offset: scenario === 'wrong-offset' ? 24 : 32,
    });
    let root: Value;
    let expected = (a: bigint, _b: bigint) => a;
    let applied = true;
    switch (scenario) {
      case 'whole':
      case 'capacity':
      case 'different-halves':
      case 'wrong-offset':
        root = add('root', 64, { kind: 'concat', values: [low, high] });
        if (scenario === 'different-halves')
          expected = (a, b) => (a & 0xffffffffn) | (b & 0xffffffff00000000n);
        if (scenario === 'wrong-offset')
          expected = (a) => (a & 0xffffffffn) | (((a >> 24n) & 0xffffffffn) << 32n);
        if (scenario === 'capacity') applied = false;
        break;
      case 'nested': {
        const alias = add('alias', 64, { kind: 'cast', op: 'bitcast', value: x });
        const shifted = add('shifted', 64, {
          kind: 'integer',
          op: 'lshr',
          left: alias,
          right: add('count', 64, { kind: 'constant', bits: 32n }),
        });
        const upper = add('upper', 32, { kind: 'cast', op: 'truncate', value: shifted });
        root = add('root', 64, { kind: 'concat', values: [low, upper] });
        break;
      }
      case 'pair128': {
        const pair = add('pair', 64, { kind: 'concat', values: [low, high] });
        const zero = add('zero', 64, { kind: 'constant', bits: 0n });
        root = add('root', 128, { kind: 'concat', values: [pair, zero] });
        break;
      }
      case 'insert-identity':
        root = add('root', 64, { kind: 'insert', base: x, value: low, offset: 0 });
        break;
      case 'byte-insert':
      case 'word-insert':
      case 'middle-insert': {
        const width = scenario === 'byte-insert' ? 8 : 16,
          offset = scenario === 'middle-insert' ? 16 : 0;
        const part = add('part', width, { kind: 'extract', value: y, offset: 0 });
        root = add('root', 64, { kind: 'insert', base: x, value: part, offset });
        const mask = (1n << BigInt(width)) - 1n;
        expected = (a, b) => (a & ~(mask << BigInt(offset))) | ((b & mask) << BigInt(offset));
        break;
      }
      case 'zero-upper': {
        const zero = add('zero', 32, { kind: 'constant', bits: 0n });
        root = add('root', 64, { kind: 'concat', values: [low, zero] });
        expected = (a) => a & 0xffffffffn;
        break;
      }
      case 'signed-upper': {
        const signed = add('signed', 64, { kind: 'cast', op: 'sign_extend', value: low });
        const upper = add('upper', 32, { kind: 'extract', value: signed, offset: 32 });
        root = add('root', 64, { kind: 'concat', values: [low, upper] });
        expected = (a) => BigInt.asUintN(64, BigInt.asIntN(32, a));
        break;
      }
      case 'packing-shift':
      case 'packing-xor':
      case 'overlap-or':
      case 'checked': {
        const upper = add('upper', 64, {
          kind: 'integer',
          op: 'mul',
          left: y,
          right: add('factor', 64, { kind: 'constant', bits: 0x100000000n }),
        });
        const left =
          scenario === 'overlap-or'
            ? x
            : add('extended', 64, { kind: 'cast', op: 'zero_extend', value: low });
        root = add('root', 64, {
          kind: 'integer',
          op: scenario === 'packing-xor' ? 'xor' : 'or',
          left,
          right: upper,
        });
        expected = (a, b) =>
          (scenario === 'overlap-or' ? a : a & 0xffffffffn) | BigInt.asUintN(64, b << 32n);
        applied = false;
        break;
      }
      case 'shift-or':
      case 'shift-xor': {
        const extended = add('extended', 64, { kind: 'cast', op: 'zero_extend', value: low });
        const upper = add('upper', 64, { kind: 'cast', op: 'zero_extend', value: high });
        const shifted = add('shifted', 64, {
          kind: 'integer',
          op: 'mul',
          left: upper,
          right: add('factor', 64, { kind: 'constant', bits: 0x100000000n }),
        });
        root = add('root', 64, {
          kind: 'integer',
          op: scenario === 'shift-xor' ? 'xor' : 'or',
          left: extended,
          right: shifted,
        });
        break;
      }
      case 'discarded-unknown': {
        root = add('root', 64, { kind: 'insert', base: y, value: x, offset: 0 });
        applied = false;
        break;
      }
    }
    const context = createOperationContext(),
      validation = new LocalValidationSession(context);
    if (scenario === 'capacity')
      for (let i = 0; i < 256; i++) validation.presentation('fixture', `${i}`, 'capacity');
    normalizeSourceExpressions(
      values,
      definitions,
      owners,
      make,
      context,
      validation,
      undefined,
      scenario !== 'checked',
    );
    const normalized = definitions.get(root.id)!;
    assert.equal(
      validation.records.some(
        (record) => record.rule === 'register_cell_recombination' && record.subject === root.id,
      ),
      applied,
    );
    if (['whole', 'nested', 'insert-identity', 'shift-or', 'shift-xor'].includes(scenario))
      assert.deepEqual(normalized, { kind: 'cast', op: 'bitcast', value: x });
    if (scenario.endsWith('insert')) assert.equal(normalized.kind, 'integer');
    if (scenario === 'pair128' || scenario === 'zero-upper') assert.equal(normalized.kind, 'cast');
    if (scenario === 'capacity') assert.equal(normalized.kind, 'concat');
    if (scenario === 'different-halves' || scenario === 'wrong-offset')
      assert.equal(normalized.kind, 'integer');
    if (scenario === 'discarded-unknown') assert.equal(normalized.kind, 'insert');
    if (scenario === 'packing-shift' || scenario === 'packing-xor' || scenario === 'checked') {
      const scale = [...definitions.values()].find(
        (item) => item.kind === 'integer' && item.left.id === y.id,
      );
      assert.ok(scale?.kind === 'integer');
      assert.equal(scale.op, scenario === 'checked' ? 'mul' : 'shl');
    }
    assert.ok(validation.records.every((record) => record.status !== 'rejected'));
    const builder = new IRBuilder(
      slice,
      entityIdentity(slice, 'function', ['bit-slices', scenario]),
      provenance,
      'ssa',
    );
    const block = builder.block('entry', [integer(64), integer(64)]);
    const rebuilt = new Map([
      [x.id, block.parameters[0]!],
      [y.id, block.parameters[1]!],
    ]);
    const copy = (value: Value): Value => {
      const previous = rebuilt.get(value.id);
      if (previous) return previous;
      const result = block.assign(value.type, mapExpression(definitions.get(value.id)!, copy));
      rebuilt.set(value.id, result);
      return result;
    };
    block.return([copy(root)]);
    const ir = builder.finish(block, [root.type]);
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(ir, {}, language);
      for (const a of [0n, 1n, 0x123456789abcdef0n, 0x80000000ffffffffn, 0xffffffffffffffffn]) {
        const b = BigInt.asUintN(64, ~a);
        const observed = execute(
          output.emission,
          new Map([
            [block.parameters[0]!.id, a],
            [block.parameters[1]!.id, b],
          ]),
        );
        assert.equal(observed.exit, 'machine_return');
        assert.deepEqual(observed.values, [expected(a, b)]);
        assert.deepEqual(observed.events, []);
      }
    }
  });
}
