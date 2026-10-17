import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  fingerprint,
  type CanonicalValue,
  type FunctionRecord,
  type RegisterDescriptor,
} from '../../../src/core/index.js';
import {
  nativeDependencyWorklist,
  type NativeInterface,
  type NativeSummaryUnit,
} from '../../../src/service/analysis/native-worklist.js';
import {
  nativeContextKey,
  type NativeContext,
} from '../../../src/service/analysis/native-context.js';

const register: RegisterDescriptor = {
  id: 'x0',
  root: 'x0',
  bank: 'integer',
  role: 'general',
  offset_bits: 0,
  width_bits: 64,
  root_width_bits: 64,
  write_rule: 'replace_root',
};
const entry = { image_id: 'image', space: 'va' as const, value: 0x1000n };
const fn: FunctionRecord = {
  id: 'callee',
  original_name: 'callee',
  display_name: null,
  evidence_ids: [],
  entry,
  ranges: [{ start: entry, size: 8n }],
  boundary: 'established',
  signature: null,
  analysis: 'not_analyzed',
};
interface Unit extends NativeSummaryUnit {
  readonly assumptions?: NativeContext;
}
const baseline: Unit = {
  function: fn,
  instructions: 1,
  blocks: 1,
  nodes: 3,
  required_nodes: 3,
  dependencies: [],
  evidence: [],
  evidence_ids: [],
  reasons: [],
  budget_truncated: false,
};
const zero: NativeContext = {
  constants: [{ register, bits: 0n }],
  aliases: [],
  type_evidence_scope: 'scope',
};
const one: NativeContext = { ...zero, constants: [{ register, bits: 1n }] };
const observe = (unit: Unit): NativeInterface => ({
  parameters: unit.assumptions ? [register] : [],
  returns: [],
  ...(unit.assumptions ? { context_assumptions: unit.assumptions } : {}),
  parameter_state: 'observed',
  argument_list_complete: false,
});
const equal = (left: NativeInterface, right: NativeInterface) =>
  fingerprint(left as unknown as CanonicalValue) ===
  fingerprint(right as unknown as CanonicalValue);

test('one native worklist isolates contexts and reuses its immutable baseline once', () => {
  let loads = 0;
  const result = nativeDependencyWorklist({
    roots: [],
    root_dependencies: [
      { call_id: 'first', target: fn, assumptions: zero },
      { call_id: 'second', target: fn, assumptions: one },
    ],
    context: createOperationContext(),
    capacity: { instructions: 1, blocks: 8, nodes: 30 },
    max_functions: 1,
    max_refinements: 8,
    load() {
      loads++;
      return baseline;
    },
    specialize(unit, assumptions) {
      return { ...unit, assumptions };
    },
    initialize: observe,
    observe,
    equal,
  });
  assert.equal(loads, 1);
  assert.equal(result.units.size, 2);
  assert.deepEqual(
    result.summaries.get(nativeContextKey(fn.id, zero))?.observed.context_assumptions,
    zero,
  );
  assert.deepEqual(
    result.summaries.get(nativeContextKey(fn.id, one))?.observed.context_assumptions,
    one,
  );
  assert.equal(baseline.assumptions, undefined);
  assert.equal(result.remaining.instructions, 0);
  assert.equal(
    result.remaining.nodes,
    21,
    'Baseline and both context views share one cumulative node capacity',
  );
});

test('recursive context growth widens to an explicit generic summary, never the last context', () => {
  let loads = 0;
  const result = nativeDependencyWorklist({
    roots: [],
    root_dependencies: [{ call_id: 'root', target: fn, assumptions: zero }],
    max_contexts_per_function: 2,
    max_contexts: 2,
    context: createOperationContext(),
    capacity: { instructions: 1, blocks: 10, nodes: 30 },
    max_functions: 1,
    max_refinements: 8,
    load() {
      loads++;
      return baseline;
    },
    specialize(unit, assumptions) {
      const next = {
        ...assumptions,
        constants: [{ register, bits: assumptions.constants[0]!.bits + 1n }],
      };
      return {
        ...unit,
        assumptions,
        dependencies: [{ call_id: 'recursive', target: fn, assumptions: next }],
      };
    },
    initialize: observe,
    observe,
    equal,
  });
  assert.equal(loads, 1);
  assert.equal(result.units.size, 3);
  assert.equal(result.summaries.get(fn.id)?.observed.context_assumptions, undefined);
  assert.match(result.summaries.get(fn.id)!.reasons.join('; '), /context limit.*generic/);
  assert.equal(result.complete, false);
  const next = { ...zero, constants: [{ register, bits: 2n }] };
  assert.equal(result.context_keys.get(nativeContextKey(fn.id, next)), fn.id);
});
