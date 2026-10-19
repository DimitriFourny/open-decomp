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
    for (const target of [a, b])
      assert.equal(result.summaries.get(target.id)?.arity_complete, !reached);
  }
});

test('arity-relied callees load before effect-only callees and keep the load reserve', () => {
  // root forwards an unobserved argument only to r, so its arity relies on r
  // alone. gap's own graph is incomplete: no callee can close it, so behind is
  // never relied on although gap forwards to it.
  const root = fn('root', 0x2000n),
    r = fn('r', 0x2010n),
    gap = fn('gap', 0x2020n),
    behind = fn('behind', 0x2030n),
    effects = [1, 2, 3, 4, 5, 6].map((index) => fn(`e${index}`, 0x2100n + BigInt(index) * 0x10n));
  const body = (
    target: FunctionRecord,
    dependencies: Unit['dependencies'],
    complete = true,
  ): Unit => ({
    function: target,
    instructions: 1,
    blocks: 1,
    nodes: 1,
    required_nodes: 1,
    dependencies,
    local: [],
    evidence: [],
    evidence_ids: [],
    reasons: complete ? [] : ['unresolved control flow'],
    arity_complete: complete,
    budget_truncated: false,
  });
  const bodies = new Map<string, Unit>([
    [
      root.id,
      body(root, [
        ...effects.map((target) => ({ call_id: `root-${target.id}`, target })),
        { call_id: 'root-r', target: r },
      ]),
    ],
    [r.id, body(r, [])],
    [gap.id, body(gap, [{ call_id: 'gap-behind', target: behind }], false)],
    [behind.id, body(behind, [])],
    ...effects.map((target) => [target.id, body(target, [])] as const),
  ]);
  const relied = (unit: Unit): string[] =>
    unit.function.id === root.id ? ['root-r'] : unit.function.id === gap.id ? ['gap-behind'] : [];
  for (const demandDriven of [false, true]) {
    const loaded: string[] = [];
    const result = nativeDependencyWorklist({
      roots: [],
      root_dependencies: [
        { call_id: 'selected-root', target: root },
        { call_id: 'selected-gap', target: gap },
      ],
      context: createOperationContext({ budget: { work: 1_000 } }),
      capacity: { instructions: 100, blocks: 100, nodes: 100 },
      max_functions: 64,
      max_refinements: 64,
      load(target, bounded) {
        loaded.push(target.id);
        bounded.checkpoint(90);
        return bodies.get(target.id)!;
      },
      ...(demandDriven ? { argument_reaching: (unit: Unit) => new Set(relied(unit)) } : {}),
      initialize,
      observe: (unit, dependencies) => ({
        ...observe(unit, dependencies),
        argument_reaching_calls: relied(unit),
      }),
      equal,
    });
    const summary = result.summaries.get(root.id)!;
    // Breadth-first loading spends the reserve on effect-only callees first.
    assert.equal(loaded.includes(r.id), demandDriven);
    assert.equal(summary.arity_complete === true, demandDriven);
    assert.ok(!loaded.includes(behind.id));
    if (demandDriven) {
      assert.deepEqual(loaded.slice(0, 3), [root.id, gap.id, r.id]);
      // Effects past the reserve stay explicit reasons; they never close or open arity.
      assert.match(summary.reasons.join('; '), /e\d: native dependency load work reserve/);
    }
    assert.equal(result.summaries.get(gap.id)?.arity_complete, false);
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
      const inherited = [...dependencies.values()].flatMap(
        (callee) => callee.parameter_shapes ?? [],
      );
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
