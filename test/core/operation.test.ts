import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildOnce,
  createOperationContext,
  OperationError,
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
});

test('a per-process build costs every operation that uses it the same, once, within its limit', () => {
  let builds = 0;
  const build = (context: OperationContext): { readonly value: number } => {
    builds++;
    for (let index = 0; index < 10; index++) context.checkpoint(3);
    return { value: 1 };
  };
  const first = createOperationContext({ budget: { work: 100 } });
  const built = buildOnce(first, build);
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

test('a build is cancellable without being charged during the build', () => {
  const controller = new AbortController();
  const context = createOperationContext({ signal: controller.signal, budget: { work: 5 } });
  assert.throws(
    () =>
      buildOnce(context, (quiet) => {
        quiet.checkpoint(1_000_000);
        controller.abort();
        quiet.checkpoint(1);
        return {};
      }),
    { code: 'cancelled' },
  );
  assert.equal(context.remainingWork?.(), 5);
});
