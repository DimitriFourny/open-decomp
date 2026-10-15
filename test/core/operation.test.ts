import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, OperationError } from '../../src/core/index.js';

test('work accounting survives phase changes and rejects work beyond the shared limit', () => {
  const context = createOperationContext({ budget: { work: 3 } });
  context.checkpoint(2);
  context.progress('next-pass', 0, 1);
  context.checkpoint(1);
  assert.throws(() => context.checkpoint(1), error => error instanceof OperationError && error.code === 'resource_limit' && error.diagnostic.details?.kind === 'limit' && error.diagnostic.details.consumed === 4);
  assert.throws(() => context.checkpoint(-1), RangeError);
});

test('aborting an operation stops zero-cost checkpoints and progress publication', () => {
  const controller = new AbortController();
  const phases: string[] = [];
  const context = createOperationContext({ signal: controller.signal, onProgress: phase => { phases.push(phase); } });
  context.progress('decode', 1, 2);
  controller.abort();
  assert.throws(() => context.checkpoint(0), { code: 'cancelled' });
  assert.throws(() => context.progress('finished', 2, 2), { code: 'cancelled' });
  assert.deepEqual(phases, ['decode']);
});
