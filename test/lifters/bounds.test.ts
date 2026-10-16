import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, OperationError, type Budget } from '../../src/core/index.js';
import { Arm64Lifter } from '../../src/lifters/arm64/index.js';
import { X86Lifter } from '../../src/lifters/x86_64/index.js';
import { DarwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { WindowsX64Abi } from '../../src/abi/windows-x64/index.js';
import { fromWords, evaluate, registerBits } from './arm64/support.js';
import { liftBytes, run, register } from './x86_64/helpers.js';

for (const architecture of ['arm64', 'x86_64'] as const) test(`${architecture}: real-byte semantic expansion respects tiny budgets and retains wraparound/provenance normally`, () => {
  const graph = architecture === 'arm64'
    ? fromWords([...Array<number>(100).fill(0x91000400), 0xd65f03c0])
    : liftBytes('4883c001'.repeat(100) + 'c3').graph;
  const lifter = architecture === 'arm64' ? new Arm64Lifter() : new X86Lifter();
  const abi = architecture === 'arm64' ? new DarwinArm64Abi() : new WindowsX64Abi();
  for (const budget of [{ ir_nodes: 1 }, { ir_nodes: 32 }, { instructions: 1 }, { work: 1 }] satisfies Partial<Budget>[]) {
    assert.throws(() => lifter.lift(graph, abi, createOperationContext({ budget })), (error: unknown) => error instanceof OperationError && error.code === 'resource_limit');
  }
  const controller = new AbortController(); controller.abort();
  assert.throws(() => lifter.lift(graph, abi, createOperationContext({ signal: controller.signal })), (error: unknown) => error instanceof OperationError && error.code === 'cancelled');
  const result = lifter.lift(graph, abi, createOperationContext());
  assert.equal(result.coverage.state, 'complete');
  const output = architecture === 'arm64'
    ? registerBits(evaluate(result.ir, new Map([['arm64:x0', 0xffffffffffffffffn]])))
    : register(run(result.ir, { rax: 0xffffffffffffffffn }), 'rax');
  assert.equal(output, 99n);
  assert.deepEqual(new Set(result.ir.provenance.instruction_ids), new Set(graph.instructions.map(instruction => instruction.id)));
  for (const block of result.ir.blocks) for (const instruction of block.instructions) assert.ok(instruction.provenance.instruction_ids.every(id => graph.instructions.some(source => source.id === id)));
});
