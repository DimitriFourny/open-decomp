import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  fingerprint,
  OperationError,
  type CanonicalValue,
  type FunctionRecord,
  type RegisterDescriptor,
} from '../../../src/core/index.js';
import {
  nativeDependencyWorklist,
  type NativeInterface,
  type NativeSummaryUnit,
} from '../../../src/service/analysis/native-worklist.js';

const input: RegisterDescriptor = {
  id: 'x0',
  root: 'x0',
  bank: 'integer',
  role: 'general',
  offset_bits: 0,
  width_bits: 64,
  root_width_bits: 64,
  write_rule: 'replace_root',
};
function fn(id: string, value: bigint): FunctionRecord {
  const entry = { image_id: 'image', space: 'va' as const, value };
  return {
    id,
    original_name: id,
    display_name: null,
    evidence_ids: [],
    entry,
    ranges: [{ start: entry, size: 8n }],
    boundary: 'established',
    signature: null,
    analysis: 'not_analyzed',
  };
}
interface Unit extends NativeSummaryUnit {
  readonly local: readonly RegisterDescriptor[];
}
const a = fn('a', 0x1000n),
  b = fn('b', 0x1010n),
  c = fn('c', 0x1020n),
  unrelated = fn('unrelated', 0x1030n);
const units: ReadonlyMap<string, Unit> = new Map([
  [
    a.id,
    {
      function: a,
      instructions: 2,
      blocks: 1,
      nodes: 4,
      required_nodes: 6,
      dependencies: [{ call_id: 'a-b', target: b }],
      local: [],
      evidence: [],
      evidence_ids: [],
      reasons: [],
      budget_truncated: false,
    },
  ],
  [
    b.id,
    {
      function: b,
      instructions: 2,
      blocks: 1,
      nodes: 4,
      required_nodes: 6,
      dependencies: [
        { call_id: 'b-a', target: a },
        { call_id: 'b-c', target: c },
      ],
      local: [],
      evidence: [],
      evidence_ids: [],
      reasons: [],
      budget_truncated: false,
    },
  ],
  [
    c.id,
    {
      function: c,
      instructions: 2,
      blocks: 1,
      nodes: 4,
      required_nodes: 6,
      dependencies: [],
      local: [input],
      evidence: [],
      evidence_ids: [],
      reasons: [],
      budget_truncated: false,
    },
  ],
]);
const equal = (left: NativeInterface, right: NativeInterface): boolean =>
  fingerprint(left as unknown as CanonicalValue) ===
  fingerprint(right as unknown as CanonicalValue);
const initialize = (unit: Unit): NativeInterface => ({
  parameters: unit.local,
  returns: [],
  parameter_state: 'observed',
  argument_list_complete: false,
});
// Every dependency call forwards the caller's unobserved argument registers,
// so the closure relies on each callee (argument_reaching_calls).
function observe(unit: Unit, dependencies: ReadonlyMap<string, NativeInterface>): NativeInterface {
  const requirements = new Map(unit.local.map((register) => [register.root, register]));
  for (const dependency of dependencies.values())
    for (const register of dependency.parameters) requirements.set(register.root, register);
  return {
    ...initialize(unit),
    parameters: [...requirements.values()],
    ...(dependencies.size ? { argument_reaching_calls: [...dependencies.keys()] } : {}),
  };
}

test('native dependency worklist visits required closure once and refines a recursive SCC', () => {
  const loaded: string[] = [];
  const result = nativeDependencyWorklist({
    roots: [a, a],
    context: createOperationContext(),
    capacity: { instructions: 6, blocks: 3, nodes: 20 },
    max_functions: 64,
    max_refinements: 64,
    load(target) {
      loaded.push(target.id);
      return units.get(target.id)!;
    },
    initialize,
    observe,
    equal,
  });
  assert.deepEqual(loaded, ['a', 'b', 'c']);
  assert.ok(!result.units.has(unrelated.id));
  assert.deepEqual(result.summaries.get(a.id)?.observed.parameters, [input]);
  assert.deepEqual(result.summaries.get(b.id)?.observed.parameters, [input]);
  assert.equal(result.complete, true);
  assert.deepEqual(result.remaining, { instructions: 0, blocks: 0, nodes: 8 });
});

test('machine arity completeness propagates independently of optional metadata gaps', () => {
  for (const semanticComplete of [false, true]) {
    const result = nativeDependencyWorklist({
      roots: [a],
      context: createOperationContext(),
      capacity: { instructions: 6, blocks: 3, nodes: 20 },
      max_functions: 64,
      max_refinements: 64,
      load(target) {
        const unit = units.get(target.id)!;
        return target.id === c.id
          ? {
              ...unit,
              reasons: ['optional source metadata unavailable'],
              arity_complete: semanticComplete,
            }
          : unit;
      },
      initialize,
      observe,
      equal,
    });
    for (const target of [a, b, c]) {
      assert.equal(result.summaries.get(target.id)?.complete, false);
      assert.equal(result.summaries.get(target.id)?.arity_complete, semanticComplete);
      assert.ok(
        result.summaries
          .get(target.id)
          ?.reasons.some((reason) => reason.includes('optional source metadata unavailable')),
      );
    }
  }
});

test('arity completeness is inherited only through calls an unobserved argument reaches', () => {
  for (const reached of [false, true]) {
    const result = nativeDependencyWorklist({
      roots: [a],
      context: createOperationContext(),
      capacity: { instructions: 6, blocks: 3, nodes: 20 },
      max_functions: 64,
      max_refinements: 64,
      load(target) {
        const unit = units.get(target.id)!;
        return target.id === c.id ? { ...unit, arity_complete: false, reasons: ['gap'] } : unit;
      },
      initialize,
      observe: (unit, dependencies) => ({
        ...observe(unit, dependencies),
        // b's call to c passes only observed or computed values unless reached.
        argument_reaching_calls: [...dependencies.keys()].filter(
          (call) => reached || call !== 'b-c',
        ),
      }),
      equal,
    });
    assert.equal(result.summaries.get(c.id)?.arity_complete, false);
    for (const target of [a, b]) assert.equal(result.summaries.get(target.id)?.arity_complete, !reached);
  }
});

test('recursive groups converge although memory shapes would grow along recursive edges', () => {
  let observations = 0;
  const result = nativeDependencyWorklist({
    roots: [a],
    context: createOperationContext(),
    capacity: { instructions: 6, blocks: 3, nodes: 20 },
    max_functions: 64,
    max_refinements: 64,
    load: (target) => units.get(target.id)!,
    initialize,
    // Each body derives a fresh shape record from every callee shape it sees:
    // transferred along the a<->b cycle this would never reach a fixed point.
    observe: (unit, dependencies) => {
      observations++;
      const inherited = [...dependencies.values()].flatMap((callee) => callee.parameter_shapes ?? []);
      return {
        ...observe(unit, dependencies),
        parameter_shapes: [
          { parameter_index: 0, depth: 1 + inherited.length } as unknown as NonNullable<
            NativeInterface['parameter_shapes']
          >[number],
        ],
      };
    },
    equal,
  });
  assert.equal(result.complete, true);
  assert.ok(observations < 10, `${observations} observations`);
  assert.ok(![...result.summaries.values()].some((summary) => summary.reasons.length));
});

test('native dependency limits preserve observed prefix and name actual unresolved leaf capacity', () => {
  const result = nativeDependencyWorklist({
    roots: [a],
    context: createOperationContext(),
    capacity: { instructions: 4, blocks: 2, nodes: 20 },
    max_functions: 64,
    max_refinements: 64,
    load(target) {
      return { ...units.get(target.id)!, local: target.id === a.id ? [input] : [] };
    },
    initialize,
    observe,
    equal,
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.summaries.get(a.id)?.observed.parameters, [input]);
  assert.match(
    result.summaries.get(a.id)!.reasons.join('; '),
    /c: native dependency instructions\/blocks capacity exhausted/,
  );
  assert.equal(result.summaries.get(a.id)?.complete, false);
  assert.equal(result.summaries.get(a.id)?.arity_complete, false);
});

test('native recursion reuses an already analyzed selected body without spending its graph capacity again', () => {
  let loads = 0;
  const result = nativeDependencyWorklist({
    roots: [b],
    context: createOperationContext(),
    capacity: { instructions: 4, blocks: 2, nodes: 12 },
    max_functions: 64,
    max_refinements: 64,
    preloaded: new Map([[a.id, units.get(a.id)!]]),
    load(target) {
      loads++;
      return units.get(target.id)!;
    },
    initialize,
    observe,
    equal,
  });
  assert.equal(loads, 2);
  assert.equal(result.units.size, 3);
  assert.equal(result.complete, true);
});

test('native optional dependency handling never suppresses outer cancellation or deadlines', () => {
  const cancelled = new AbortController();
  cancelled.abort();
  assert.throws(
    () =>
      nativeDependencyWorklist({
        roots: [a],
        context: createOperationContext({ signal: cancelled.signal }),
        capacity: { instructions: 6, blocks: 3, nodes: 20 },
        max_functions: 64,
        max_refinements: 64,
        load(target) {
          return units.get(target.id)!;
        },
        initialize,
        observe,
        equal,
      }),
    (error: unknown) => error instanceof OperationError && error.code === 'cancelled',
  );
});
