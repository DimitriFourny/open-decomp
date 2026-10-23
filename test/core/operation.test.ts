import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildOnce,
  createOperationContext,
  OperationError,
  recordBuilds,
  replayBuilds,
  unpaidBuildCost,
  useBuilt,
  type OperationContext,
} from '../../src/core/index.js';

test('work accounting survives phase changes and rejects work beyond the shared limit', () => {
  const context = createOperationContext({ budget: { work: 3 } });
  context.checkpoint(2);
  context.progress('next-pass', 0, 1);
  context.checkpoint(1);
  assert.throws(
    () => context.checkpoint(1),
    (error) =>
      error instanceof OperationError &&
      error.code === 'resource_limit' &&
      error.diagnostic.details?.kind === 'limit' &&
      error.diagnostic.details.consumed === 4,
  );
  assert.throws(() => context.checkpoint(-1), RangeError);
});

test('aborting an operation stops zero-cost checkpoints and progress publication', () => {
  const controller = new AbortController();
  const phases: string[] = [];
  const context = createOperationContext({
    signal: controller.signal,
    onProgress: (phase) => {
      phases.push(phase);
    },
  });
  context.progress('decode', 1, 2);
  controller.abort();
  assert.throws(() => context.checkpoint(0), { code: 'cancelled' });
  assert.throws(() => context.progress('finished', 2, 2), { code: 'cancelled' });
  assert.deepEqual(phases, ['decode']);
});

test('remaining work observes the cumulative counter through context wrappers', () => {
  const original = createOperationContext({ budget: { work: 9 } });
  const wrapped = { ...original, budget: { ...original.budget, work: 99 } };
  assert.equal(wrapped.remainingWork?.(), 9);
  original.checkpoint(3);
  assert.equal(wrapped.remainingWork?.(), 6);
  wrapped.checkpoint(5);
  assert.equal(original.remainingWork?.(), 1);
  assert.equal(original.consumedWork?.(), 8);
  assert.equal(wrapped.consumedWork?.(), 8);
});

test('a per-process build costs every operation that uses it the same, once, within its limit', () => {
  let builds = 0;
  const build = (context: OperationContext): { readonly value: number } => {
    builds++;
    for (let index = 0; index < 10; index++) context.checkpoint(3);
    return { value: 1 };
  };
  const first = createOperationContext({ budget: { work: 100 } });
  const built = buildOnce(first, 'test-index', build);
  assert.equal(first.remainingWork?.(), 70);
  // Further uses by the same operation, through derived contexts, are free.
  assert.equal(useBuilt({ ...first, budget: { ...first.budget, work: 5 } }, built), built);
  assert.equal(first.remainingWork?.(), 70);
  // Another operation finding it built pays the same, even through a wrapper.
  const second = createOperationContext({ budget: { work: 100 } });
  useBuilt({ ...second, checkpoint: () => assert.fail('wrapper charged') }, built);
  assert.equal(second.remainingWork?.(), 70);
  assert.equal(builds, 1);
  // The recorded cost still counts against the shared limit.
  assert.throws(() => useBuilt(createOperationContext({ budget: { work: 29 } }), built), {
    code: 'resource_limit',
  });
});

test('a recorded structure use replays its payment once per operation, as using it would', () => {
  const first = createOperationContext({ budget: { work: 100 } });
  const { value: built, builds } = recordBuilds(first, () =>
    buildOnce(first, 'test-index', (quiet) => {
      quiet.checkpoint(30);
      return {};
    }),
  );
  assert.deepEqual(builds, [{ name: 'test-index', cost: 30 }]);
  // Replayed where the operation has not paid it: charged once, then claimed by the structure.
  const second = createOperationContext({ budget: { work: 100 } });
  assert.equal(unpaidBuildCost(second, builds), 30);
  replayBuilds(second, builds);
  replayBuilds({ ...second }, builds);
  useBuilt(second, built);
  assert.equal(second.remainingWork?.(), 70);
  assert.equal(unpaidBuildCost(second, builds), 0);
  // Where the operation has paid it: free, and recorded again by an enclosing recording.
  const third = createOperationContext({ budget: { work: 100 } });
  useBuilt(third, built);
  const replayed = recordBuilds(third, () => replayBuilds(third, builds));
  assert.equal(third.remainingWork?.(), 70);
  assert.deepEqual(replayed.builds, builds);
});

test('a build is cancellable without being charged during the build', () => {
  const controller = new AbortController();
  const context = createOperationContext({ signal: controller.signal, budget: { work: 5 } });
  assert.throws(
    () =>
      buildOnce(context, 'test-index', (quiet) => {
        quiet.checkpoint(1_000_000);
        controller.abort();
        quiet.checkpoint(1);
        return {};
      }),
    { code: 'cancelled' },
  );
  assert.equal(context.remainingWork?.(), 5);
});
