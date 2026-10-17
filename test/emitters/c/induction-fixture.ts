import assert from 'node:assert/strict';
import { createOperationContext } from '../../../src/core/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { simplifySSA } from '../../../src/analysis/values/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { structureControlFlow } from '../../../src/presentation/index.js';
import { reconstruct } from '../../../src/reconstruction/index.js';
import { discover, lift, loadCorpus } from '../../lifters/arm64/support.js';
import { emit, execute } from './support.js';

/** Source-backed countdown recovery counterexample. Both emitted dialects must
 * retain source-valid memory bounds while eliminating redundant register cells.
 * fixtures/source/corpus.c:8-12 defines a uint32_t sum over n input elements.
 * Native corpus ARM64 code at 0x45c zero-checks w1, initializes w9 from w1,
 * then decrements x9 and branches while nonzero. Therefore the loop-header
 * countdown is in [1, UINT32_MAX]; its high 32-bit cell is always zero. The
 * regression forbids retaining that cell as a second loop-carried local or
 * reconstructing its register concat on every iteration.
 */
export function checkLoopInduction(): { observations: number } {
  const graph = discover(loadCorpus()).find((candidate) => candidate.function.original_name === '_fixture_loop');
  assert.ok(graph);
  const converted = constructSSA(lift(graph).ir);
  assert.equal(converted.state, 'complete');
  assert.equal(converted.value.form, 'ssa');
  if (converted.value.form !== 'ssa') assert.fail('Expected SSA');
  const simplified = simplifySSA(converted.value);
  assert.equal(simplified.state, 'complete');
  const ir = simplified.value;
  const source = { abi: new DarwinArm64Abi(), callees: [], addresses: [] };
  const entry = ir.blocks.find((block) => block.id === ir.entry)!;
  const bindings = ir.register_states.find((state) => state.block === ir.entry)!.entry;
  const words = [0xffffffffn, 1n, 0x80000000n, 0x80000000n, 0xffffffffn, 2n];
  let observations = 0;
  for (const language of ['c-like', 'python-like'] as const) {
    const output = emit(ir, { source }, language);
    for (const count of [0, 1, 2, 5, 6]) {
      const pointer = count === 0 ? 0xdead0000n : 0x2000n;
      const roots = new Map([['arm64:x0', pointer], ['arm64:x1', BigInt(count)]]);
      const inputs = new Map(entry.parameters.map((value) => [value.id, 0n]));
      for (const binding of bindings)
        inputs.set(binding.value.id, BigInt.asUintN(binding.register.width_bits,
          (roots.get(binding.register.root) ?? 0n) >> BigInt(binding.register.offset_bits)));
      // Only the source-valid extent is mapped. An extra iteration or zero-trip
      // load is an observable fault, not hidden by spare fixture allocation.
      const memory = new Map<bigint, number>();
      for (let index = 0; index < count; index++) for (let byte = 0; byte < 4; byte++)
        memory.set(0x2000n + BigInt(index * 4 + byte), Number((words[index]! >> BigInt(byte * 8)) & 255n));
      const before = new Map(memory), observed = execute(output.emission, inputs, memory);
      assert.equal(observed.exit, 'machine_return', `${language}/${count}`);
      assert.deepEqual(observed.values, [BigInt.asUintN(32, words.slice(0, count).reduce((sum, value) => sum + value, 0n))]);
      assert.deepEqual(observed.events, Array.from({ length: count }, () => 'load'));
      assert.deepEqual(observed.memory, before);
      observations++;
    }
  }
  const structured = structureControlFlow(ir, createOperationContext());
  assert.ok(structured.value);
  const program = reconstruct({ function: structured.value, source }, createOperationContext());
  const livePacking = [...program.live].filter((id) => program.expressions.get(id)?.kind === 'concat');
  assert.deepEqual(livePacking, [],
    'A proven zero high-half countdown must not remain a live loop-carried cell or per-iteration register concat');
  return { observations };
}
