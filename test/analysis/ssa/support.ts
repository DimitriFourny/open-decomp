import assert from 'node:assert/strict';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { simplifySSA } from '../../../src/analysis/values/index.js';
import { evaluateIR, verifyIR } from '../../../src/ir/index.js';
import type { EvaluationOptions, EvaluationResult, RegisterIR, SSAForm } from '../../../src/ir/index.js';

export function forms(program: RegisterIR): { ssa: SSAForm; optimized: SSAForm } {
  const construction = constructSSA(program);
  assert.equal(construction.state, 'complete');
  assert.equal(construction.value.form, 'ssa');
  if (construction.value.form !== 'ssa') throw new TypeError('Expected SSA');
  assert.deepEqual(verifyIR(construction.value), []);
  const result = simplifySSA(construction.value);
  assert.equal(result.state, 'complete');
  assert.deepEqual(verifyIR(result.value), []);
  return { ssa: construction.value, optimized: result.value };
}

/** Compare machine observations, not internal assignment count or register-access tokens. */
export function equivalent(program: RegisterIR, options: EvaluationOptions = {}): { original: EvaluationResult; ssa: SSAForm; optimized: SSAForm } {
  const { ssa, optimized } = forms(program);
  const original = evaluateIR(program, options);
  const retainedEffects = new Set(program.blocks.flatMap(block => block.instructions.filter(node => node.kind !== 'assign' && node.kind !== 'read_register' && node.kind !== 'write_register').map(node => node.id)));
  for (const transformed of [ssa, optimized]) {
    const result = evaluateIR(transformed, options);
    assert.equal(result.status, original.status);
    assert.deepEqual(result.values.map(value => value.kind === 'bits' ? value : { kind: value.kind }), original.values.map(value => value.kind === 'bits' ? value : { kind: value.kind }));
    assert.deepEqual(result.memory, original.memory);
    assert.deepEqual(result.effect_trace, original.effect_trace.filter(id => retainedEffects.has(id)));
    const roots = new Set([...original.registers.keys(), ...result.registers.keys()]);
    for (const root of roots) {
      const before = original.registers.get(root), after = result.registers.get(root);
      assert.equal(after?.known ?? 0n, before?.known ?? 0n, `Known mask ${root}`);
      assert.equal(after?.undefined ?? 0n, before?.undefined ?? 0n, `Undefined mask ${root}`);
      assert.equal((after?.bits ?? 0n) & (after?.known ?? 0n), (before?.bits ?? 0n) & (before?.known ?? 0n), `Known bits ${root}`);
    }
  }
  return { original, ssa, optimized };
}
