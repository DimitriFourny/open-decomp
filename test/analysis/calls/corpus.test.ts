import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, type AbiProfile, type AbiSignature, type AbiType, type Address } from '../../../src/core/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { WindowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { analyzeCalls, type SuppliedCallContract } from '../../../src/analysis/calls/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { recoverStack } from '../../../src/analysis/stack/index.js';
import type { RegisterIR, SSAForm } from '../../../src/ir/index.js';
import { discover, lift, loadCorpus as loadDarwin } from '../../lifters/arm64/support.js';
import { loadCorpus as loadWindows } from '../../lifters/x86_64/helpers.js';

const u64: AbiType = { kind: 'integer', bits: 64, signed: false };
const stackSignature: AbiSignature = { parameters: Array<AbiType>(10).fill(u64), returns: u64, variadic: false, fixed_parameter_count: 10 };
function ssa(program: RegisterIR): SSAForm {
  const result = constructSSA(program); assert.equal(result.state, 'complete');
  if (result.value.form !== 'ssa') throw new Error('Expected SSA'); return result.value;
}
function checkCorpus(abi: AbiProfile, stack: RegisterIR, args: RegisterIR, caller: RegisterIR, argsAddress: Address): void {
  const frame = recoverStack(ssa(stack), abi, createOperationContext());
  assert.equal(frame.state, 'complete');
  assert.equal(frame.frame.minimum_offset, -16n);
  // Independent source/disassembly oracle: volatile local initialized to seven.
  assert.ok(frame.accesses.some(access => access.kind === 'read' && access.region === 'local_candidate' && access.value.value.kind === 'constant' && access.value.value.bits === 7n));
  const incoming = recoverStack(ssa(args), abi, createOperationContext());
  const offsets = incoming.accesses.filter(access => access.kind === 'read' && access.region === 'incoming_candidate').map(access => access.offset).sort((a, b) => a! < b! ? -1 : a! > b! ? 1 : 0);
  assert.deepEqual(offsets, abi.id === 'windows-x64' ? [40n, 48n, 56n, 64n, 72n, 80n] : [0n, 8n]);
  const known: SuppliedCallContract = { id: 'source-fixture-stack-args', target: { kind: 'address', address: argsAddress }, signature: stackSignature,
    evidence_ids: ['fixture-source-corpus-h-stack-args', 'fixture-source-check-c-1-through-10'] };
  const result = analyzeCalls(ssa(caller), abi, createOperationContext(), { contracts: [known] });
  assert.equal(result.state, 'complete', result.diagnostics.map(item => item.message).join('\n'));
  const call = result.calls.find(item => item.contracts.some(observation => observation.contract.id === known.id)); assert.ok(call);
  assert.equal(call.status, 'established');
  assert.deepEqual(call.contracts[0]!.parameters.map(parameter => parameter.locations[0]!.fact.value), Array.from({ length: 10 }, (_, index) => ({ kind: 'constant', bits: BigInt(index + 1) })));
  assert.ok(call.contracts[0]!.parameters.every(parameter => parameter.locations.every(location => location.fact.initialization === 'initialized')));
  assert.equal(call.contracts[0]!.layout.shadow_space, abi.id === 'windows-x64' ? 32n : 0n);
  // Calls without supplied declarations remain untyped despite initialized registers.
  assert.ok(result.calls.filter(item => item.node_id !== call.node_id).every(item => item.contracts.length === 0));
}

test('real Mach-O corpus recovers locals, entry-SP stack arguments and all ten outgoing values', () => {
  const graphs = discover(loadDarwin()), byName = new Map(graphs.map(graph => [graph.function.original_name, graph]));
  const stack = byName.get('_fixture_stack')!, args = byName.get('_fixture_stack_args')!, caller = byName.get('_fixture_check')!;
  checkCorpus(new DarwinArm64Abi(), lift(stack).ir, lift(args).ir, lift(caller).ir, args.function.entry);
});

test('real PE corpus recovers locals and pushed-return-address fifth-argument +40 without double adjustment', () => {
  const corpus = loadWindows();
  const stack = corpus.lifted.get(0x180001000n)!.ir, args = corpus.lifted.get(0x1800010f0n)!.ir, caller = corpus.lifted.get(0x180001210n)!.ir;
  checkCorpus(new WindowsX64Abi(), stack, args, caller, { image_id: corpus.image.id, space: 'va', value: 0x1800010f0n });
});
