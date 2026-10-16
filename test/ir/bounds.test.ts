import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, entityIdentity, OperationError } from '../../src/core/index.js';
import { IRBuilder, evaluateIR, integer, mergeProvenanceSources, syntheticProvenance, verifyIR } from '../../src/ir/index.js';
import { provenance, slice } from './support.js';

function limited(error: unknown): boolean {
  return error instanceof OperationError && error.code === 'resource_limit';
}

test('IR construction refuses an over-budget effect before mutating the usable block', () => {
  const context = createOperationContext({ budget: { ir_nodes: 6 } });
  const build = new IRBuilder(slice, entityIdentity(slice, 'function', 'bounded-store'), provenance, 'register', context);
  const block = build.block('entry');
  const address = block.constant(integer(64), 0x1000n), value = block.constant(integer(8), 0x7fn);
  block.store(address, value);
  assert.throws(() => block.store(address, value), limited);
  block.return();
  const ir = build.finish(block);
  assert.deepEqual(verifyIR(ir), []);
  const result = evaluateIR(ir, { memory: [{ base: 0x1000n, bytes: new Uint8Array(1), writable: true }] });
  assert.equal(result.status, 'returned');
  assert.equal(result.memory[0]!.bytes[0], 0x7f);
});

test('IR construction observes cumulative work and cancellation between semantic nodes', () => {
  const controller = new AbortController();
  const context = createOperationContext({ signal: controller.signal, budget: { work: 20 } });
  const build = new IRBuilder(slice, entityIdentity(slice, 'function', 'cancelled-builder'), provenance, 'register', context);
  const block = build.block('entry');
  block.constant(integer(32), 1n);
  controller.abort();
  assert.throws(() => block.constant(integer(32), 2n), (error: unknown) => error instanceof OperationError && error.code === 'cancelled');
  const exhausted = createOperationContext({ budget: { work: 10 } });
  exhausted.checkpoint(9);
  const next = new IRBuilder(slice, entityIdentity(slice, 'function', 'cumulative-builder'), provenance, 'register', exhausted);
  assert.throws(() => next.block('entry'), limited);
});

test('large provenance fan-in preserves ordered source union without an argument-stack limit', () => {
  const first = syntheticProvenance('first'), last = syntheticProvenance('last');
  function* sources() { yield first; for (let i = 0; i < 150_000; i++) yield first; yield last; }
  assert.deepEqual(mergeProvenanceSources(sources()).synthetic, ['first', 'last']);
  const context = createOperationContext({ budget: { work: 10 } });
  assert.throws(() => mergeProvenanceSources(sources(), work => context.checkpoint(work)), limited);
});
