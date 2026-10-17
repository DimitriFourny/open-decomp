import assert from 'node:assert/strict';
import test from 'node:test';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { verifyIR } from '../../../src/ir/index.js';
import { fromWords, lift } from './support.js';

// ISA source: add v10.8b, v10.8b, v10.8b; bl callee; ret; callee: ret.
// The Q=0 vector view zeroes the root high half; the later unknown call clobbers
// the full Q register. Distinct physical views must never share descriptor IDs.
test('short vector views and full caller-clobbered roots retain distinct canonical identities', () => {
  const graph = fromWords([0x0e2a854a, 0x94000002, 0xd65f03c0, 0xd65f03c0]);
  const payload = graph.instructions[0]!.payload;
  assert.equal(payload?.architecture, 'arm64');
  if (payload?.architecture !== 'arm64') assert.fail('Expected an ARM64 instruction');
  const destination = payload.operands[0];
  assert.ok(destination?.kind === 'register');
  assert.equal(destination.register.id, 'arm64:v10:0:64');
  assert.equal(destination.register.root, 'arm64:v10');
  assert.equal(destination.register.width_bits, 64);
  assert.equal(destination.register.write_rule, 'zero_extend_root');
  const abi = new DarwinArm64Abi();
  const root = abi.unknown_call_clobbers.registers.find((register) => register.root === 'arm64:v10');
  assert.ok(root);
  assert.notEqual(root.id, destination.register.id);
  const vector = abi.classifyCall({ returns: { kind: 'vector', element: 'integer', element_bits: 8, lanes: 8 },
    parameters: [], variadic: false, fixed_parameter_count: 0 }).returns[0];
  assert.ok(vector?.kind === 'register');
  assert.equal(vector.register.id, 'arm64:v0:0:64');
  const lifted = lift(graph);
  assert.deepEqual(verifyIR(lifted.ir), []);
  const ssa = constructSSA(lifted.ir);
  assert.equal(ssa.state, 'complete');
  assert.deepEqual(verifyIR(ssa.value), []);
});
