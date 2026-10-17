import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../src/core/index.js';
import { floating, integer, vector, type Expression, type Value } from '../../src/ir/index.js';
import { registerTypeSlices, registerTypes } from '../../src/reconstruction/source-register-types.js';
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
