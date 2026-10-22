import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OperationError,
  createOperationContext,
  type FunctionRecord,
  type OperationContext,
  type ToolResult,
} from '../../../src/core/index.js';
import { createAnalysisReadset } from '../../../src/project/cache/dependencies.js';
import { recoverDebugInfo } from '../../../src/metadata/debug/index.js';
import { recoverLibraryContracts } from '../../../src/metadata/library-contracts/index.js';
import {
  prepareNativeUnit,
  type NativePreparationInput,
  type PreparedNativeUnit,
} from '../../../src/service/analysis/native-prepare.js';
import {
  nativeLibraryContracts,
  nativeUnitLoader,
  preparedUnitCache,
} from '../../../src/service/analysis/source-facts.js';
import { pipelineComponents } from '../../../src/service/analysis/versions.js';
import { loadFunctionGraph, loadFunctionIndex } from '../../../src/service/queries/scope.js';
import { project } from './support.js';

// Prepared native callee units are reused across requests in one process. Reuse must
// leave exactly what preparing them would, so every function's output in a shared
// project equals its output in a fresh project of its own.
test('callee units reused across decompilations never change any output', async (t) => {
  const shared = await project(t, 'libcorpus-arm64-symbols.dylib');
  const ids = shared.functions.map((fn) => fn.id);
  assert.ok(ids.length > 4);
  // Functions without text (for example import stubs) compare by state and reason.
  const text = (result: ToolResult<'function_decompile'>): string =>
    'data' in result && result.data.delivery === 'inline'
      ? result.data.emission.text
      : `${result.state}:${'reason' in result ? result.reason : ''}`;
  const together: string[] = [];
  for (const id of ids) together.push(text((await shared.decompile(id)).result));
  for (const [index, id] of ids.entries()) {
    const alone = await project(t, 'libcorpus-arm64-symbols.dylib');
    assert.equal(text((await alone.decompile(id)).result), together[index], id);
  }
});

// The native record index behind every function graph is built once per process. The
// request that finds it built must record the record scopes its build read, with the
// same charges, or a request's readset and work would depend on whether it came first.
test('a request that finds the native record index built reads what building it read', async (t) => {
  const p = await project(t, 'libcorpus-arm64-symbols.dylib');
  const store = p.state.store,
    fn = p.functions[0];
  assert.ok(fn);
  const graphRequest = () => {
    const context = createOperationContext();
    const dependencies = createAnalysisReadset(store, 2, context);
    loadFunctionGraph({ store: dependencies.store, context }, 2, { image: p.image, function: fn });
    return { work: context.consumedWork!(), reads: dependencies.finish().reads };
  };
  const built = graphRequest();
  assert.equal(
    built.reads.filter((read) => read.selector.kind === 'record_scope').length,
    4,
    'symbols, imports, exports and functions',
  );
  assert.deepEqual(graphRequest(), built);
});

/** One load of `fn` through `nativeUnitLoader` in a request of its own: the worklist hands
 * the loader a share of `allowance` work, as `nativeDependencyWorklist` does. Before its
 * worklist runs, a request has prepared its selected body, which pays (once per operation)
 * every per-process image index a preparation uses; that body is prepared here outside
 * the dependency ledger, so the ledger holds the load's reads alone. */
function loadOnce(
  base: Omit<NativePreparationInput, 'scope'>,
  store: NativePreparationInput['scope']['store'],
  fn: FunctionRecord,
  allowance: number,
  cached: boolean,
) {
  const root = createOperationContext({ budget: { work: 100_000_000 } });
  const contracts = nativeLibraryContracts(base);
  prepareNativeUnit(
    { ...base, scope: { store, context: root, job_id: 'native-unit-history' } },
    fn,
    root,
    contracts,
  );
  const dependencies = createAnalysisReadset(store, base.revision, root);
  const input: NativePreparationInput = {
    ...base,
    scope: {
      store: dependencies.store,
      context: root,
      job_id: 'native-unit-history',
      dependencies,
      ...(cached ? {} : { analysis_cache: false }),
    },
  };
  let used = 0;
  const share: OperationContext = {
    ...root,
    remainingWork: () => Math.max(0, Math.min(allowance - used, root.remainingWork!())),
    checkpoint(work) {
      if (used + work > allowance)
        throw new OperationError({
          code: 'resource_limit',
          severity: 'warning',
          message: 'test share exhausted',
          evidence_ids: [],
          details: { kind: 'limit', resource: 'work', limit: allowance, consumed: used + work },
        });
      root.checkpoint(work);
      used += work;
    },
  };
  const load = nativeUnitLoader(
    input,
    preparedUnitCache(input),
    contracts,
    (work, reads) =>
      work <= (share.remainingWork?.() ?? 0) && work + reads <= (root.remainingWork?.() ?? 0),
  );
  const unit = load(fn, share);
  // The request ends: its queued summaries become the project's persisted tier.
  store.flushNativeSummaries();
  return { unit, work: root.consumedWork!(), reads: dependencies.finish().reads };
}

/** What a caller of the loader can observe of a unit. */
const observable = (unit: PreparedNativeUnit) => ({
  ir: unit.ir,
  types: unit.types,
  analysis: unit.analysis,
  observed_calls: unit.observed_calls,
  dependencies: unit.dependencies.map(({ target, ...rest }) => ({ ...rest, target: target.id })),
  reasons: unit.reasons,
  limited: unit.limited,
  variadic: unit.variadic,
  arity_complete: unit.arity_complete,
  budget_truncated: unit.budget_truncated,
  instructions: unit.instructions,
  blocks: unit.blocks,
  nodes: unit.nodes,
  required_nodes: unit.required_nodes,
  evidence_ids: unit.evidence_ids,
});

// A load's unit, charged work and dependency reads are a function of its allowance alone,
// whatever earlier loads in this process (or persisted rows) prepared. The allowances
// straddle the variadic footprint's local limit: under `limited` the footprint stage is
// cut (no reason, no footprint), which once still counted as a reusable preparation and
// handed later loads a unit without the callee's `...` at the cut preparation's charge.
test('a native unit load is independent of load history', async (t) => {
  const p = await project(t, 'libcorpus-arm64-symbols.dylib');
  const store = p.state.store;
  const context = createOperationContext();
  const index = loadFunctionIndex({ store, context }, 2, p.image);
  const components = pipelineComponents(p.image.target);
  const base = {
    revision: 2,
    image: p.image,
    ...index,
    components,
    native_types: [],
    debug: recoverDebugInfo(p.image, context),
    library: recoverLibraryContracts({ image: p.image, abi: components.abi, revision: 2 }, context),
  };
  const fn = index.functions.find((item) => item.original_name === '_fixture_variadic');
  assert.ok(fn);
  // Below the SSA and type/stack limits' reach, but short of the footprint; above the
  // footprint, under 4W + 3 of the complete preparation; and far above it.
  const allowances = { limited: 40_000, low: 60_000, high: 200_000 };
  const reference = new Map(
    Object.values(allowances).map((allowance) => {
      const once = loadOnce(base, store, fn, allowance, false);
      return [allowance, { ...once, unit: observable(once.unit) }] as const;
    }),
  );
  const limited = reference.get(allowances.limited)!.unit;
  assert.equal(limited.limited, true);
  assert.deepEqual(limited.reasons, []);
  assert.equal(limited.variadic, undefined);
  for (const allowance of [allowances.low, allowances.high]) {
    const complete = reference.get(allowance)!;
    assert.equal(complete.unit.limited, false);
    assert.ok(complete.unit.variadic);
    assert.deepEqual(complete, reference.get(allowances.high));
  }
  const values = Object.values(allowances);
  const orders = values.flatMap((first) =>
    values
      .filter((second) => second !== first)
      .map((second) => [
        first,
        second,
        values.find((third) => third !== first && third !== second)!,
      ]),
  );
  assert.equal(orders.length, 6);
  for (const order of orders) {
    // A fresh process tier per order (a new function list is a new cache identity);
    // rows persisted by earlier orders stay and are served like retained units.
    const fresh = { ...base, functions: [...base.functions] };
    for (const allowance of [...order, ...order]) {
      const once = loadOnce(fresh, store, fn, allowance, true),
        expected = reference.get(allowance)!,
        label = `order ${order.join(' > ')}, allowance ${allowance}`;
      assert.equal(once.work, expected.work, `${label}: charged work`);
      assert.deepEqual(once.reads, expected.reads, `${label}: reads`);
      assert.deepEqual(observable(once.unit), expected.unit, `${label}: unit`);
    }
  }
});
