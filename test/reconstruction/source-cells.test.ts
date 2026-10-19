import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../src/core/index.js';
import { effectType, integer, type Expression, type Value } from '../../src/ir/index.js';
import type { BlockRegion, ParallelTransfer } from '../../src/presentation/index.js';
import { LocalValidationSession } from '../../src/reconstruction/local-validation.js';
import { recombineSourceCells } from '../../src/reconstruction/source-cells.js';
import { provenance, register } from '../ir/support.js';

const recombined = [
  'whole',
  'constant',
  'zero-extend',
  'sign-extend',
  'sign-extend-slice',
  'carried',
] as const;
for (const scenario of [
  ...recombined,
  'different-base',
  'wrong-offset',
  'independent-high',
  'unread',
  'partial-root',
  'missing-edge',
  'record-bound',
] as const) {
  test(`register cell recombination: ${scenario}`, () => {
    const value = (id: string, bits = 32): Value => ({ id, type: integer(bits) });
    const low = value('low'),
      high = value('high'),
      a = value('a', 64),
      b = value('b', 64),
      narrow = value('narrow'),
      extended = value('extended', 64),
      truncated = value('truncated'),
      widened = value('widened', 64);
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
    // The first edge enters the loop; the second is its back edge.
    const first = transfer(aLow, aHigh),
      second =
        scenario === 'carried'
          ? transfer(low, high)
          : transfer(bLow, bHigh, scenario === 'missing-edge');
    const first32: Record<(typeof recombined)[number], [Expression, Expression]> = {
      whole: [
        { kind: 'extract', value: a, offset: 0 },
        { kind: 'extract', value: a, offset: 32 },
      ],
      carried: [
        { kind: 'extract', value: a, offset: 0 },
        { kind: 'extract', value: a, offset: 32 },
      ],
      // A 32-bit immediate write that clears the upper cell.
      constant: [
        { kind: 'constant', bits: 0x80000000n },
        { kind: 'constant', bits: 0n },
      ],
      // A 32-bit arithmetic write that clears the upper cell.
      'zero-extend': [
        { kind: 'cast', op: 'bitcast', value: narrow },
        { kind: 'constant', bits: 0n },
      ],
      // A sign-extending write: the upper cell slices sign_extend(low).
      'sign-extend': [
        { kind: 'cast', op: 'bitcast', value: narrow },
        { kind: 'extract', value: extended, offset: 32 },
      ],
      // movsxd from the low half of a 64-bit value: the low cells slice that
      // value, the upper cell slices sign_extend(its low half).
      'sign-extend-slice': [
        { kind: 'extract', value: a, offset: 0 },
        { kind: 'extract', value: widened, offset: 32 },
      ],
    };
    const [lowSource, highSource] = (recombined as readonly string[]).includes(scenario)
      ? first32[scenario as (typeof recombined)[number]]
      : first32.whole;
    const definitions = new Map<string, Expression>([
      [aLow.id, lowSource],
      [aHigh.id, highSource],
      [extended.id, { kind: 'cast', op: 'sign_extend', value: narrow }],
      [truncated.id, { kind: 'cast', op: 'truncate', value: a }],
      [widened.id, { kind: 'cast', op: 'sign_extend', value: truncated }],
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
    // An independently computed upper cell is an opaque 32-bit value.
    if (scenario === 'independent-high') definitions.delete(aHigh.id);
    // The loop reads both cells as one 64-bit register.
    if (scenario !== 'unread') definitions.set('read', { kind: 'concat', values: [low, high] });
    const incoming = new Map([
      [low.id, [aLow, second.copies[0]!.source]],
      [high.id, [aHigh, second.copies[1]?.source ?? bHigh]],
    ]);
    const blocks = new Map([[block.id, block]]),
      context = createOperationContext();
    const validation = new LocalValidationSession(context);
    if (scenario === 'record-bound')
      for (let index = 0; index < 256; index++)
        validation.presentation('fixture', String(index), `record capacity ${index}`);
    const result = recombineSourceCells(
      blocks,
      [
        { transfer: first, block },
        { transfer: second, block },
      ],
      definitions,
      incoming,
      {
        make: (key, type, _block, expression) => {
          if (expression) definitions.set(key, expression);
          return { id: key, type };
        },
        alias: (target, expression) => {
          definitions.set(target.id, expression);
        },
      },
      validation,
      context,
    );
    if ((recombined as readonly string[]).includes(scenario)) {
      const whole = result.get(first)![0]!.destination;
      const entered = result.get(first)![0]!.source;
      assert.deepEqual(result.get(first), [{ destination: whole, source: entered }]);
      const repeated = scenario === 'carried' ? whole : b;
      assert.deepEqual(result.get(second), [{ destination: whole, source: repeated }]);
      assert.deepEqual(definitions.get(low.id), { kind: 'extract', value: whole, offset: 0 });
      assert.deepEqual(definitions.get(high.id), { kind: 'extract', value: whole, offset: 32 });
      assert.deepEqual(incoming.get(whole.id), [entered, repeated]);
      assert.ok(blocks.get(block.id)!.parameters.includes(whole));
      assert.ok(validation.records.some((record) => record.rule === 'register_cell_recombination'));
      if (scenario === 'whole' || scenario === 'carried') assert.equal(entered, a);
      else if (scenario === 'sign-extend') assert.equal(entered, extended);
      else if (scenario === 'sign-extend-slice') assert.equal(entered, widened);
      else if (scenario === 'constant')
        assert.deepEqual(definitions.get(entered.id), { kind: 'constant', bits: 0x80000000n });
      else
        assert.deepEqual(definitions.get(entered.id), {
          kind: 'cast',
          op: 'zero_extend',
          value: narrow,
        });
    } else {
      assert.equal(result.size, 0);
      assert.equal(definitions.has(low.id), false);
      assert.equal(definitions.has(high.id), false);
      assert.equal(blocks.get(block.id), block);
    }
    assert.equal(first.copies.length, 2, 'original machine transfer remains immutable');
  });
}

type Unavailable = Extract<Expression, { kind: 'indeterminate' }>;
for (const scenario of ['same-reason', 'different-reason', 'undefined-state', 'mixed'] as const)
  test(`register cell recombination of unavailable cells: ${scenario}`, () => {
    const value = (id: string, bits = 32): Value => ({ id, type: integer(bits) });
    const low = value('low'),
      high = value('high'),
      b = value('b', 64),
      unknownLow = value('unknown-low'),
      unknownHigh = value('unknown-high'),
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
        { register: register('hi', 32, 32), value: high },
      ],
      control: { id: 'return', kind: 'return', provenance, values: [], effect },
    };
    const transfer = (lo: Value, hi: Value): ParallelTransfer => ({
      kind: 'transfer',
      target: block.id,
      mode: 'next',
      effect: { source: effect, destination: effect },
      copies: [
        { destination: low, source: lo },
        { destination: high, source: hi },
      ],
    });
    const first = transfer(unknownLow, unknownHigh),
      second = transfer(bLow, bHigh);
    const unavailable = (reason: string, state: Unavailable['state'] = 'unknown'): Expression => ({
      kind: 'indeterminate',
      state,
      reason,
    });
    const definitions = new Map<string, Expression>([
      [unknownLow.id, unavailable('non-argument entry register')],
      [
        unknownHigh.id,
        unavailable(
          scenario === 'different-reason' ? 'FPCR environment' : 'non-argument entry register',
          scenario === 'undefined-state' ? 'undefined' : 'unknown',
        ),
      ],
      [bLow.id, { kind: 'extract', value: b, offset: 0 }],
      [bHigh.id, { kind: 'extract', value: b, offset: 32 }],
    ]);
    if (scenario === 'mixed') definitions.set(unknownHigh.id, { kind: 'constant', bits: 1n });
    // The loop reads both cells as one 64-bit register.
    definitions.set('read', { kind: 'concat', values: [low, high] });
    const incoming = new Map([
      [low.id, [unknownLow, bLow]],
      [high.id, [unknownHigh, bHigh]],
    ]);
    const blocks = new Map([[block.id, block]]),
      context = createOperationContext();
    const validation = new LocalValidationSession(context);
    const result = recombineSourceCells(
      blocks,
      [
        { transfer: first, block },
        { transfer: second, block },
      ],
      definitions,
      incoming,
      {
        make: (key, type, _block, expression) => {
          if (expression) definitions.set(key, expression);
          return { id: key, type };
        },
        alias: (target, expression) => {
          definitions.set(target.id, expression);
        },
      },
      validation,
      context,
    );
    if (scenario !== 'same-reason') {
      assert.equal(result.size, 0);
      assert.deepEqual(blocks.get(block.id)!.parameters, [low, high]);
      return;
    }
    const whole = result.get(first)![0]!.destination;
    const entered = result.get(first)![0]!.source;
    assert.deepEqual(definitions.get(entered.id), unavailable('non-argument entry register'));
    assert.equal(entered.type.kind === 'integer' && entered.type.bits, 64);
    assert.deepEqual(result.get(second), [{ destination: whole, source: b }]);
    assert.deepEqual(definitions.get(low.id), { kind: 'extract', value: whole, offset: 0 });
    assert.deepEqual(definitions.get(high.id), { kind: 'extract', value: whole, offset: 32 });
    assert.ok(validation.records.some((record) => record.rule === 'register_cell_recombination'));
  });
