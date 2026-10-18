import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../src/core/index.js';
import { effectType, integer, type Expression, type Value } from '../../src/ir/index.js';
import type { BlockRegion, ParallelTransfer } from '../../src/presentation/index.js';
import { LocalValidationSession } from '../../src/reconstruction/local-validation.js';
import { recombineSourceCells } from '../../src/reconstruction/source-cells.js';
import { provenance, register } from '../ir/support.js';

for (const scenario of [
  'whole',
  'different-base',
  'wrong-offset',
  'partial-root',
  'missing-edge',
  'record-bound',
] as const) {
  test(`register cell recombination: ${scenario}`, () => {
    const value = (id: string, bits = 32): Value => ({ id, type: integer(bits) });
    const low = value('low'),
      high = value('high'),
      a = value('a', 64),
      b = value('b', 64);
    const aLow = value('a-low'),
      aHigh = value('a-high'),
      bLow = value('b-low'),
      bHigh = value('b-high');
    const effect = { id: 'effect', type: effectType };
    const block: BlockRegion = {
      id: 'join',
      kind: 'block',
      provenance,
      parameters: [low, high],
      effect_parameter: effect,
      dominator: null,
      register_exit: [],
      statements: [],
      register_entry: [
        { register: register('lo', 32), value: low },
        ...(scenario === 'partial-root' ? [] : [{ register: register('hi', 32, 32), value: high }]),
      ],
      control: { id: 'return', kind: 'return', provenance, values: [], effect },
    };
    const transfer = (lo: Value, hi: Value, omit = false): ParallelTransfer => ({
      kind: 'transfer',
      target: block.id,
      mode: 'next',
      effect: { source: effect, destination: effect },
      copies: [
        { destination: low, source: lo },
        ...(omit ? [] : [{ destination: high, source: hi }]),
      ],
    });
    const first = transfer(aLow, aHigh),
      second = transfer(bLow, bHigh, scenario === 'missing-edge');
    const definitions = new Map<string, Expression>([
      [aLow.id, { kind: 'extract', value: a, offset: 0 }],
      [aHigh.id, { kind: 'extract', value: a, offset: 32 }],
      [bLow.id, { kind: 'extract', value: b, offset: 0 }],
      [
        bHigh.id,
        {
          kind: 'extract',
          value: scenario === 'different-base' ? a : b,
          offset: scenario === 'wrong-offset' ? 0 : 32,
        },
      ],
    ]);
    const incoming = new Map([
      [low.id, [aLow, bLow]],
      [high.id, [aHigh, bHigh]],
    ]);
    const blocks = new Map([[block.id, block]]),
      context = createOperationContext();
    const validation = new LocalValidationSession(context);
    if (scenario === 'record-bound')
      for (let index = 0; index < 256; index++)
        validation.presentation('fixture', String(index), 'record capacity');
    const result = recombineSourceCells(
      blocks,
      [
        { transfer: first, block },
        { transfer: second, block },
      ],
      definitions,
      incoming,
      {
        make: (key, type) => ({ id: key, type }),
        alias: (target, expression) => {
          definitions.set(target.id, expression);
        },
      },
      validation,
      context,
    );
    if (scenario === 'whole') {
      const whole = result.get(first)![0]!.destination;
      assert.deepEqual(result.get(first), [{ destination: whole, source: a }]);
      assert.deepEqual(result.get(second), [{ destination: whole, source: b }]);
      assert.deepEqual(definitions.get(low.id), { kind: 'extract', value: whole, offset: 0 });
      assert.deepEqual(definitions.get(high.id), { kind: 'extract', value: whole, offset: 32 });
      assert.deepEqual(incoming.get(whole.id), [a, b]);
      assert.ok(blocks.get(block.id)!.parameters.includes(whole));
      assert.ok(validation.records.some((record) => record.rule === 'register_cell_recombination'));
    } else {
      assert.equal(result.size, 0);
      assert.equal(definitions.has(low.id), false);
      assert.equal(definitions.has(high.id), false);
      assert.equal(blocks.get(block.id), block);
    }
    assert.equal(first.copies.length, 2, 'original machine transfer remains immutable');
  });
}
