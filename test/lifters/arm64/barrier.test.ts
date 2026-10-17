import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, DEFAULT_ANALYSIS_OPTIONS } from '../../../src/core/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { simplifySSA } from '../../../src/analysis/values/index.js';
import { summarizeEffect } from '../../../src/analysis/effects/index.js';
import { structureControlFlow } from '../../../src/presentation/index.js';
import { reconstruct } from '../../../src/reconstruction/index.js';
import { emitC } from '../../../src/emitters/c/index.js';
import { emitPythonLike } from '../../../src/emitters/python-like/index.js';
import { execute } from '../../emitters/c/support.js';
import { builder } from '../../ir/support.js';
import { integer } from '../../../src/ir/index.js';
import { fromWords, lift, evaluate, registerBits } from './support.js';

// SQLite 3.54.0 sqlite3.c:188657-188660: initialized fast path executes
// sqlite3MemoryBarrier() (__sync_synchronize, lines 31056-31060), then returns 0.
// Retained ARM64 disassembly at 0x100039288: dmb ish; mov w0,#0; ret.
test('SQLite initialized fast path retains DMB ISH ordering through source projection in both dialects', () => {
  const graph = fromWords([0xd5033bbf, 0x52800000, 0xd65f03c0]);
  const lifted = lift(graph);
  assert.equal(lifted.coverage.state, 'complete');
  const fence = lifted.ir.blocks.flatMap((block) => block.instructions).find((node) => node.kind === 'memory_fence');
  assert.ok(fence);
  assert.deepEqual(summarizeEffect(fence), {
    node: fence.id, reads_memory: false, writes_memory: false, barrier: true, may_stop: false,
  });
  const evaluated = evaluate(lifted.ir);
  assert.equal(registerBits(evaluated, 'arm64:x0', 32), 0n);
  const ssa = constructSSA(lifted.ir).value;
  assert.ok(ssa.form === 'ssa');
  assert.ok(evaluated.effect_trace.includes(fence.id));
  const simplified = simplifySSA(ssa).value;
  const structured = structureControlFlow(simplified, createOperationContext()).value;
  assert.ok(structured);
  for (const source of [undefined, { abi: new DarwinArm64Abi(), callees: [], addresses: [] }]) {
    const input = { function: structured, ...(source ? { source } : {}) };
    const projection = reconstruct(input, createOperationContext());
    assert.ok(projection.retained.has(fence.id));
    for (const emit of [emitC, emitPythonLike]) {
      const output = emit(input, DEFAULT_ANALYSIS_OPTIONS, createOperationContext());
      assert.match(output.emission.text, /memory_fence\("inner_shareable", "acquire_release", "reads_writes"\)/);
      const mapping = output.emission.mappings.find((item) => item.statement_id === fence.id);
      assert.ok(mapping);
      assert.ok(mapping.instruction_ids.includes(graph.instructions[0]!.id));
      assert.doesNotMatch(output.emission.text, /opaque_effect|Unsupported ARM64/);
      if (source) {
        const observed = execute(output.emission);
        assert.deepEqual(observed.values, [0n]);
        assert.deepEqual(observed.events, ['fence:inner_shareable:acquire_release:reads_writes']);
      }
    }
  }
});

test('unobserved barrier domains and barrier families remain unsupported', () => {
  for (const word of [0xd5033fbf, 0xd5033b9f, 0xd5033fdf]) {
    const result = lift(fromWords([word, 0xd65f03c0]));
    assert.equal(result.coverage.state, 'partial');
    assert.ok(result.ir.blocks.some((block) => block.instructions.some((node) => node.kind === 'unknown_effect')));
  }
});

// Independent source oracle: *p = 23; __sync_synchronize(); return *p.
// This checks consumer-visible event order, not just the IR token chain.
test('read/write ordering remains observable after simplification and both output renderers', () => {
  const ir = builder('observed-dmb-memory-order'), block = ir.block('entry');
  const address = block.constant(integer(64), 0x8000n);
  block.store(address, block.constant(integer(32), 23n));
  block.memoryFence();
  block.return([block.load(integer(32), address)]);
  const ssa = constructSSA(ir.finish(block, [integer(32)])).value;
  assert.ok(ssa.form === 'ssa');
  const simplified = simplifySSA(ssa).value;
  const structured = structureControlFlow(simplified, createOperationContext()).value;
  assert.ok(structured);
  for (const emit of [emitC, emitPythonLike]) {
    const output = emit({ function: structured }, DEFAULT_ANALYSIS_OPTIONS, createOperationContext());
    const observed = execute(output.emission, new Map(), new Map([
      [0x8000n, 0], [0x8001n, 0], [0x8002n, 0], [0x8003n, 0],
    ]));
    assert.deepEqual(observed.values, [23n]);
    assert.deepEqual(observed.events, ['store', 'fence:inner_shareable:acquire_release:reads_writes', 'load']);
    assert.equal(observed.memory.get(0x8000n), 23);
  }
});
