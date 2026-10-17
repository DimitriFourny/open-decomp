import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../../src/core/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { evaluateIR, integer, verifyIR } from '../../../src/ir/index.js';
import { builder, register } from '../../ir/support.js';

function registerGraph(blocks: number, roots: number) {
  const build = builder(`bounded-register-graph-${blocks}-${roots}`);
  const entry = build.block('entry');
  for (let i = 0; i < roots; i++)
    entry.readRegister(register(`physical:${i}`, 64, 0, 'replace_root', `physical:${i}`));
  let previous = entry;
  for (let i = 1; i < blocks; i++) {
    const next = build.block(['next', i]);
    previous.jump(next);
    previous = next;
  }
  previous.return([previous.constant(integer(32), 42n)]);
  return build.finish(entry, [integer(32)]);
}

test('SSA parameters scale with merges, not blocks times registers', () => {
  const result = constructSSA(registerGraph(64, 64));
  assert.equal(result.state, 'complete');
  if (result.value.form !== 'ssa') throw new TypeError('Expected SSA');
  assert.deepEqual(verifyIR(result.value), []);
  const [entry, ...rest] = result.value.blocks;
  assert.equal(entry!.parameters.length, 64, 'The entry binds every physical input');
  assert.ok(
    rest.every((block) => block.parameters.length === 0),
    'A chain has no merges',
  );
  assert.ok(
    result.value.register_states
      .slice(1)
      .every((row) => row.entry.length === 0 && (row.exit.length === 0 || row.exit.length === 64)),
  );
});

test('SSA construction fails transactionally under a node budget', () => {
  const input = registerGraph(64, 64);
  // Minimal SSA needs 64 entry parameters, 64 reads and 64 block reservations.
  const context = createOperationContext({ budget: { ir_nodes: 256 } });
  const result = constructSSA(input, {
    max_ir_nodes: context.budget.ir_nodes,
    checkpoint: (work) => context.checkpoint(work),
  });
  assert.equal(result.state, 'partial');
  assert.strictEqual(
    result.value,
    input,
    'A failed construction retains the last valid representation',
  );
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'resource_limit' &&
        diagnostic.details?.kind === 'limit' &&
        diagnostic.details.resource === 'ir_nodes',
    ),
  );
  assert.deepEqual(verifyIR(input), []);
});

test('bounded SSA conversion preserves return values, physical roots, source origins and effects', () => {
  const input = registerGraph(4, 4),
    context = createOperationContext();
  const result = constructSSA(input, {
    max_ir_nodes: context.budget.ir_nodes,
    max_blocks: context.budget.blocks,
    checkpoint: (work) => context.checkpoint(work),
  });
  assert.equal(result.state, 'complete');
  assert.deepEqual(verifyIR(result.value), []);
  const registers = new Map(
    Array.from({ length: 4 }, (_, i) => [`physical:${i}`, BigInt(i + 1)] as const),
  );
  const original = evaluateIR(input, { registers }),
    converted = evaluateIR(result.value, { registers });
  assert.equal(converted.status, original.status);
  assert.deepEqual(converted.values, original.values);
  assert.deepEqual(converted.registers, original.registers);
  assert.deepEqual(converted.memory, original.memory);
  assert.deepEqual(converted.effect_trace, [], 'Only architectural register reads were eliminated');
  assert.deepEqual(result.value.provenance, input.provenance);
});

test('SSA conversion cannot reset already-consumed work or turn cancellation into complete output', () => {
  const input = registerGraph(4, 4),
    context = createOperationContext({ budget: { work: 10 } });
  context.checkpoint(10);
  const exhausted = constructSSA(input, { checkpoint: (work) => context.checkpoint(work) });
  assert.equal(exhausted.state, 'partial');
  assert.strictEqual(exhausted.value, input);
  assert.ok(exhausted.diagnostics.some((diagnostic) => diagnostic.code === 'resource_limit'));
  const controller = new AbortController();
  controller.abort();
  const cancelled = createOperationContext({ signal: controller.signal });
  const result = constructSSA(input, { checkpoint: (work) => cancelled.checkpoint(work) });
  assert.equal(result.state, 'partial');
  assert.strictEqual(result.value, input);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'cancelled'));
});

test('large valid switch fanout charges copied architectural state before expansion', () => {
  const build = builder('bounded-switch-register-state'),
    entry = build.block('entry'),
    exit = build.block('exit');
  for (let i = 0; i < 64; i++)
    entry.readRegister(register(`switch:${i}`, 64, 0, 'replace_root', `switch:${i}`));
  const selector = entry.constant(integer(32), 123n);
  entry.terminate({
    kind: 'switch',
    value: selector,
    cases: Array.from({ length: 2048 }, (_, i) => ({ bits: BigInt(i), edge: entry.edge(exit) })),
    otherwise: entry.edge(exit),
  });
  exit.return([exit.constant(integer(32), 42n)]);
  const input = build.finish(entry, [integer(32)]),
    context = createOperationContext({ budget: { work: 10_000 } });
  const limited = constructSSA(input, { checkpoint: (work) => context.checkpoint(work) });
  assert.equal(limited.state, 'partial');
  assert.strictEqual(limited.value, input);
  assert.ok(limited.diagnostics.some((diagnostic) => diagnostic.code === 'resource_limit'));
  const complete = constructSSA(input);
  assert.equal(complete.state, 'complete');
  assert.deepEqual(verifyIR(complete.value), []);
  const registers = new Map(
    Array.from({ length: 64 }, (_, i) => [`switch:${i}`, BigInt(i)] as const),
  );
  const original = evaluateIR(input, { registers }),
    transformed = evaluateIR(complete.value, { registers });
  assert.equal(transformed.status, original.status);
  assert.deepEqual(transformed.values, original.values);
  assert.deepEqual(transformed.registers, original.registers);
});
