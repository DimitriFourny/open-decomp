import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../src/core/index.js';
import { floating, integer, vector, type Expression, type Value } from '../../src/ir/index.js';
import { createRegisterTypeGraph, registerTypeSlices, registerTypes, type StorageCopy } from '../../src/reconstruction/source-register-types.js';
import { register } from '../ir/support.js';

const i64 = integer(64), i128 = integer(128), f64 = floating(64), v4f = vector(floating(32), 4);

test('a scalar FP input is a low lane of wide SIMD transport, not a 128-bit argument', () => {
  const raw: Value = { id: 'raw', type: i128 };
  const low: Value = { id: 'low', type: i64 };
  const scalar: Value = { id: 'scalar', type: f64 };
  const values = new Map([raw, low, scalar].map((value) => [value.id, value]));
  const expressions = new Map<string, Expression>([
    [low.id, { kind: 'extract', value: raw, offset: 0 }],
    [scalar.id, { kind: 'cast', op: 'bitcast', value: low }],
  ]);
  const context = createOperationContext();
  const slices = registerTypeSlices(values, expressions, [], [], context);
  const bindings = [{ register: register('v0', 128, 0, 'replace_root', 'arm64:v0'), value: raw }];
  assert.deepEqual(registerTypes(bindings, 'arm64:v0', 0, slices, context), [f64]);
  assert.deepEqual(registerTypes(bindings, 'arm64:v0', 0, slices, context, true), []);
});

test('a written vector result assembles both cells with lane offsets independent of binding order', () => {
  const left: Value = { id: 'left', type: v4f }, right: Value = { id: 'right', type: v4f };
  const computed: Value = { id: 'computed', type: v4f }, raw: Value = { id: 'raw', type: i128 };
  const low: Value = { id: 'low', type: i64 }, high: Value = { id: 'high', type: i64 };
  const values = new Map([left, right, computed, raw, low, high].map((value) => [value.id, value]));
  const expressions = new Map<string, Expression>([
    [computed.id, { kind: 'vector_float', op: 'add', left, right }],
    [raw.id, { kind: 'cast', op: 'bitcast', value: computed }],
    [low.id, { kind: 'extract', value: raw, offset: 0 }],
    [high.id, { kind: 'extract', value: raw, offset: 64 }],
  ]);
  const context = createOperationContext();
  const slices = registerTypeSlices(values, expressions, [], [], context);
  const bindings = [
    { register: register('v0-high', 64, 64, 'preserve_other_bits', 'arm64:v0'), value: high },
    { register: register('v0-low', 64, 0, 'preserve_other_bits', 'arm64:v0'), value: low },
  ];
  assert.deepEqual(registerTypes(bindings, 'arm64:v0', 0, slices, context, true), [v4f]);
});

test('a written double plus cleared SIMD high bits remains a scalar return', () => {
  const left: Value = { id: 'left', type: f64 }, right: Value = { id: 'right', type: f64 };
  const computed: Value = { id: 'computed', type: f64 }, raw: Value = { id: 'raw', type: i64 };
  const high: Value = { id: 'high', type: i64 };
  const values = new Map([left, right, computed, raw, high].map((value) => [value.id, value]));
  const expressions = new Map<string, Expression>([
    [computed.id, { kind: 'float', op: 'add', left, right }],
    [raw.id, { kind: 'cast', op: 'bitcast', value: computed }],
    [high.id, { kind: 'constant', bits: 0n }],
  ]);
  const context = createOperationContext();
  const slices = registerTypeSlices(values, expressions, [], [], context);
  const bindings = [
    { register: register('v0-low', 64, 0, 'preserve_other_bits', 'arm64:v0'), value: raw },
    { register: register('v0-high', 64, 64, 'preserve_other_bits', 'arm64:v0'), value: high },
  ];
  assert.deepEqual(registerTypes(bindings, 'arm64:v0', 0, slices, context, true), [f64]);
});

test('integer-only storage does not construct an unconsumed typed adjacency graph', () => {
  const values = Array.from({ length: 1000 }, (_, index): Value => ({ id: `integer-${index}`, type: i64 }));
  const expressions = new Map<string, Expression>(values.slice(1).map((value, index) =>
    [value.id, { kind: 'cast', op: 'bitcast', value: values[index]! }]));
  const copies = values.slice(1).map((destination, index) => ({ source: values[index]!, destination }));
  const controller = new AbortController();
  const context = createOperationContext({ signal: controller.signal, budget: { work: 1 } });
  assert.equal(registerTypeSlices(new Map(values.map((value) => [value.id, value])),
    expressions, copies, [], context).size, 0);
  assert.equal(context.remainingWork!(), 1);
  controller.abort();
  assert.throws(() => registerTypeSlices(new Map(), new Map(), [], [], context), { code: 'cancelled' });
});

test('late call-return FP seeds still propagate through an otherwise integer-only graph', () => {
  const returned: Value = { id: 'call-return-f64', type: f64 };
  const raw: Value = { id: 'call-raw', type: i64 }, copied: Value = { id: 'call-copy', type: i64 };
  const values = new Map([raw, copied].map((value) => [value.id, value]));
  const expressions = new Map<string, Expression>([[raw.id, { kind: 'cast', op: 'bitcast', value: returned }]]);
  let reads = 0;
  function* callResults() { reads++; yield [returned]; }
  const context = createOperationContext();
  const slices = registerTypeSlices(values, expressions, [{ source: raw, destination: copied }],
    callResults(), context);
  assert.equal(reads, 1);
  assert.deepEqual(registerTypes([{ register: register('v0', 64, 0, 'preserve_other_bits', 'arm64:v0'),
    value: copied }], 'arm64:v0', 0, slices, context, true), [f64]);
});

test('late additional integer-vector seed prevents the empty-consumer fast path', () => {
  const raw: Value = { id: 'additional-raw', type: i128 }, copied: Value = { id: 'additional-copy', type: i128 };
  const v4i = vector(integer(32), 4), context = createOperationContext();
  function* additional() { yield [raw, { type: v4i, offset: 0, written: true }] as const; }
  const slices = registerTypeSlices(new Map([raw, copied].map((value) => [value.id, value])),
    new Map(), [{ source: raw, destination: copied }], [], context, additional());
  assert.deepEqual(registerTypes([{ register: register('v0', 128, 0, 'preserve_other_bits', 'arm64:v0'),
    value: copied }], 'arm64:v0', 0, slices, context, true), [v4i]);
});

test('prepared type transport still enumerates late FP seeds after an empty query', () => {
  const returned: Value = { id: 'prepared-call-f64', type: f64 };
  const raw: Value = { id: 'prepared-call-raw', type: i64 }, copied: Value = { id: 'prepared-call-copy', type: i64 };
  const values = new Map([raw, copied].map((value) => [value.id, value]));
  const expressions = new Map<string, Expression>([[raw.id, { kind: 'cast', op: 'bitcast', value: returned }]]);
  const copies: readonly StorageCopy[] = [{ source: raw, destination: copied }];
  const graph = createRegisterTypeGraph(values, expressions, copies);
  const emptyContext = createOperationContext({ budget: { work: 1 } });
  assert.equal(registerTypeSlices(values, expressions, copies, [], emptyContext, [], graph).size, 0);
  assert.equal(emptyContext.remainingWork!(), 1, 'An unseeded query does not build the storage graph');
  const context = createOperationContext();
  const slices = registerTypeSlices(values, expressions, copies, [[returned]], context, [], graph);
  assert.deepEqual(registerTypes([{ register: register('xmm0', 64, 0, 'replace_root', 'x86_64:xmm0'),
    value: copied }], 'x86_64:xmm0', 0, slices, context, true), [f64]);
  assert.throws(() => registerTypeSlices(new Map(values), expressions, copies, [[returned]], context, [], graph), TypeError);
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => registerTypeSlices(values, expressions, copies, [[returned]],
    createOperationContext({ signal: controller.signal }), [], graph), { code: 'cancelled' });
});

test('prepared type transport keeps changed scalar/vector interpretations fresh', () => {
  const raw: Value = { id: 'prepared-additional-raw', type: i128 }, copied: Value = { id: 'prepared-additional-copy', type: i128 };
  const values = new Map([raw, copied].map((value) => [value.id, value]));
  const expressions = new Map<string, Expression>(), copies: readonly StorageCopy[] = [{ source: raw, destination: copied }];
  const graph = createRegisterTypeGraph(values, expressions, copies), context = createOperationContext();
  const binding = { register: register('xmm0', 128, 0, 'replace_root', 'x86_64:xmm0', 128), value: copied };
  for (const type of [vector(integer(32), 4), f64, v4f]) {
    const slices = registerTypeSlices(values, expressions, copies, [], context,
      [[raw, { type, offset: 0, written: true }]], graph);
    assert.deepEqual(registerTypes([binding], binding.register.root, 0, slices, context, true), [type]);
  }
  assert.equal(registerTypeSlices(values, expressions, copies, [], context, [], graph).size, 0,
    'Earlier type observations are not retained by the structural graph');
});

test('prepared type transport retains original typed values without late call observations', () => {
  const original: Value = { id: 'prepared-original-f64', type: f64 };
  const copied: Value = { id: 'prepared-original-copy', type: i64 };
  const values = new Map([original, copied].map((value) => [value.id, value]));
  const expressions = new Map<string, Expression>(), copies: readonly StorageCopy[] = [{ source: original, destination: copied }];
  const graph = createRegisterTypeGraph(values, expressions, copies), context = createOperationContext();
  const binding = { register: register('xmm0', 64, 0, 'replace_root', 'x86_64:xmm0'), value: copied };
  const slices = registerTypeSlices(values, expressions, copies, [], context, [], graph);
  assert.deepEqual(registerTypes([binding], binding.register.root, 0, slices, context), [f64]);
  assert.deepEqual(registerTypes([binding], binding.register.root, 0, slices, context, true), [],
    'An original typed entry value is not an authored write');
});
