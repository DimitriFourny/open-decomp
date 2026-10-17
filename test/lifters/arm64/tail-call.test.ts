import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, DEFAULT_ANALYSIS_OPTIONS } from '../../../src/core/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { simplifySSA } from '../../../src/analysis/values/index.js';
import { structureControlFlow } from '../../../src/presentation/index.js';
import { reconstruct } from '../../../src/reconstruction/index.js';
import { emitC } from '../../../src/emitters/c/index.js';
import { emitPythonLike } from '../../../src/emitters/python-like/index.js';
import { execute } from '../../emitters/c/support.js';
import { fromWords, lift } from './support.js';

// Source behavior: return callee(7), where no callee prototype is supplied.
// Real MOV X0,#7; B target bytes establish the machine argument, not the arity.
test('discovery-established ARM64 tail calls retain target and changed physical inputs without guessing an interface', () => {
  const discovered = fromWords([0xd28000e0, 0x14000400]);
  const graph = {
    ...discovered,
    blocks: discovered.blocks.map((block) => ({
      ...block,
      edges: block.edges.map((edge) => ({ ...edge, kind: 'tail_call' as const })),
    })),
  };
  const lifted = lift(graph);
  assert.ok(lifted.ir.blocks.some((block) => block.terminator.kind === 'indirect' && block.terminator.tail_call));
  const ssa = constructSSA(lifted.ir).value;
  assert.ok(ssa.form === 'ssa');
  const simplified = simplifySSA(ssa).value;
  const structured = structureControlFlow(simplified, createOperationContext()).value;
  assert.ok(structured);
  for (const source of [undefined, { abi: new DarwinArm64Abi(), callees: [], addresses: [] }]) {
    const input = { function: structured, ...(source ? { source } : {}) };
    if (source) {
      const projection = reconstruct(input, createOperationContext());
      assert.ok(projection.diagnostics.some((diagnostic) =>
        diagnostic.message.includes('tail-call target is preserved') &&
        diagnostic.message.includes('calling convention')));
      for (const copies of projection.transfers.values())
        assert.ok(copies.every((copy) => !projection.inline.has(copy.destination.id)),
          'Proven expression aliases are not mutable transfer destinations requiring undeclared locals');
    }
    for (const emit of [emitC, emitPythonLike]) {
      const emission = emit(input, DEFAULT_ANALYSIS_OPTIONS, createOperationContext()).emission;
      const output = emission.text;
      const observed = execute(emission);
      assert.equal(observed.exit, 'tail_call');
      assert.equal(observed.tail_target, 0x2004n);
      assert.deepEqual(observed.registers.get('arm64:x0'), {
        bits: 7n,
        known: 0xffffffffffffffffn,
      });
      assert.match(output, /return tail_call\(/);
      assert.match(output, /unknown_arguments\(\)/);
      assert.match(output, /unknown_calling_convention\(\)/);
      assert.match(output, /unknown_results\(\)/);
      assert.match(output, /arm64:x0:/);
      assert.doesNotMatch(output, /return indirect_exit/);
      if (source) assert.match(output, /^unknown_result | -> unknown_result:/m);
    }
  }
});
