import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, type AbiProfile, type AbiSignature, type AbiType, type RegisterDescriptor } from '../../../src/core/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { WindowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { analyzeCalls, type SuppliedCallContract } from '../../../src/analysis/calls/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { integer, type RegisterIR, type SSAForm } from '../../../src/ir/index.js';
import { builder, image } from '../../ir/support.js';

const darwin = new DarwinArm64Abi(), windows = new WindowsX64Abi(), i8 = integer(8), i32 = integer(32), i64 = integer(64);
const u64: AbiType = { kind: 'integer', bits: 64, signed: false }, u8: AbiType = { kind: 'integer', bits: 8, signed: false };
const address = { image_id: image, space: 'va' as const, value: 0x2000n }, target = { kind: 'direct' as const, address };
function signature(parameters: readonly AbiType[] | null, returns: AbiType = u64): AbiSignature {
  return { parameters, returns, variadic: false, fixed_parameter_count: parameters?.length ?? 0 };
}
function contract(sig: AbiSignature, id = 'known-contract'): SuppliedCallContract { return { id, target: { kind: 'address', address }, signature: sig, evidence_ids: [`evidence-${id}`] }; }
function ssa(program: RegisterIR): SSAForm {
  const result = constructSSA(program); assert.equal(result.state, 'complete');
  assert.equal(result.value.form, 'ssa'); if (result.value.form !== 'ssa') throw new Error('Expected SSA'); return result.value;
}
function firstRegister(abi: AbiProfile, sig: AbiSignature = signature([u64])): RegisterDescriptor {
  const location = abi.classifyCall(sig).parameters[0]!.locations[0]!; assert.equal(location.kind, 'register');
  if (location.kind !== 'register') throw new Error('Expected register'); return location.register;
}

test('Windows fifth argument uses callee-entry +40 exactly once and ignores home space initialization', () => {
  const sig = signature(Array<AbiType>(5).fill(u64)), ir = builder('calls-windows-stack'), b = ir.block('entry');
  const entry = b.readRegister(windows.stack_pointer), caller = b.int('sub', entry, b.constant(i64, 64n));
  b.writeRegister(windows.stack_pointer, caller);
  b.store(b.int('add', caller, b.constant(i64, 32n)), b.constant(i64, 55n));
  // This is the real x86 lifter boundary: push hardware return address, then call.
  const callee = b.int('sub', caller, b.constant(i64, 8n)); b.writeRegister(windows.stack_pointer, callee);
  b.store(callee, b.address({ ...address, value: 0x1005n }));
  b.call(target, [], [], windows.unknown_call_clobbers);
  b.writeRegister(windows.stack_pointer, caller); b.return();
  const result = analyzeCalls(ssa(ir.finish(b)), windows, createOperationContext(), { contracts: [contract(sig)] });
  assert.equal(result.state, 'complete');
  const observation = result.calls[0]!.contracts[0]!;
  assert.deepEqual(observation.parameters[4]!.locations[0]!.fact.value, { kind: 'constant', bits: 55n });
  assert.equal(observation.parameters[4]!.locations[0]!.stack_offset, -32n);
  assert.equal(observation.parameters[4]!.locations[0]!.fact.initialization, 'initialized');
  assert.ok(observation.parameters.slice(0, 4).every(parameter => parameter.locations[0]!.fact.initialization === 'unknown'));
  assert.equal(observation.layout.shadow_space, 32n);
});

test('Darwin packed fixed bytes are not Windows home slots or eight-byte fixed slots', () => {
  const sig = signature([...Array<AbiType>(8).fill(u64), u8, u8]), ir = builder('calls-darwin-packed'), b = ir.block('entry');
  const sp = b.int('sub', b.readRegister(darwin.stack_pointer), b.constant(i64, 16n)); b.writeRegister(darwin.stack_pointer, sp);
  b.store(sp, b.constant(i8, 9n)); b.store(b.int('add', sp, b.constant(i64, 1n)), b.constant(i8, 10n));
  b.call(target, [], [], darwin.unknown_call_clobbers); b.return();
  const result = analyzeCalls(ssa(ir.finish(b)), darwin, createOperationContext(), { contracts: [contract(sig)] });
  const parameters = result.calls[0]!.contracts[0]!.parameters;
  assert.deepEqual(parameters.slice(8).map(parameter => parameter.locations[0]!.stack_offset), [-16n, -15n]);
  assert.deepEqual(parameters.slice(8).map(parameter => parameter.locations[0]!.fact.value), [{ kind: 'constant', bits: 9n }, { kind: 'constant', bits: 10n }]);
});

for (const abi of [darwin, windows]) test(`${abi.id}: call-time register state precedes clobbers and subsequent writes`, () => {
  const sig = signature([u64]), argument = firstRegister(abi), ir = builder(`calls-time-${abi.id}`), b = ir.block('entry');
  b.writeRegister(argument, b.constant(i64, 7n)); b.call(target, [], [], abi.unknown_call_clobbers);
  b.writeRegister(argument, b.constant(i64, 9n)); b.call(target, [], [], abi.unknown_call_clobbers); b.return();
  const result = analyzeCalls(ssa(ir.finish(b)), abi, createOperationContext(), { contracts: [contract(sig)] });
  assert.deepEqual(result.calls.map(call => call.contracts[0]!.parameters[0]!.locations[0]!.fact.value), [{ kind: 'constant', bits: 7n }, { kind: 'constant', bits: 9n }]);
  assert.ok(result.calls.every(call => call.contracts[0]!.returns.every(location => location.fact.initialization === 'unknown')));
});

test('partial physical register writes do not initialize a wider known argument', () => {
  const argument = firstRegister(windows), ir = builder('calls-partial-register'), b = ir.block('entry');
  b.writeRegister({ ...argument, id: 'argument-low-byte', width_bits: 8, write_rule: 'preserve_other_bits' }, b.constant(i8, 7n));
  b.call(target, [], [], windows.unknown_call_clobbers); b.return();
  const result = analyzeCalls(ssa(ir.finish(b)), windows, createOperationContext(), { contracts: [contract(signature([u64]))] });
  assert.equal(result.calls[0]!.status, 'established');
  assert.notEqual(result.calls[0]!.contracts[0]!.parameters[0]!.locations[0]!.fact.initialization, 'initialized');
});

test('unknown signatures and read-before-write candidates never invent count or initialized arguments', () => {
  const ir = builder('calls-unknown-arity'), b = ir.block('entry'), argument = firstRegister(darwin);
  b.int('add', b.readRegister(argument), b.constant(i64, 1n)); b.call(target, [], [], darwin.unknown_call_clobbers); b.return();
  const program = ssa(ir.finish(b));
  const absent = analyzeCalls(program, darwin, createOperationContext());
  assert.deepEqual(absent.calls[0]!.contracts, []); assert.deepEqual(absent.calls[0]!.explicit_arguments, []);
  assert.ok(absent.parameter_candidates.some(candidate => candidate.register.root === argument.root));
  for (const parameters of [null, []] as const) {
    const result = analyzeCalls(program, darwin, createOperationContext(), { contracts: [contract(signature(parameters))] });
    const observation = result.calls[0]!.contracts[0]!;
    assert.equal(observation.contract.signature.parameters, parameters); assert.deepEqual(observation.parameters, []);
    assert.equal(observation.layout.state, parameters === null ? 'partial' : 'complete');
  }
});

test('known Darwin anonymous arguments use promoted eight-byte stack slots independently of fixed registers', () => {
  const sig: AbiSignature = { returns: { kind: 'void' }, parameters: [u64, u8, { kind: 'float', bits: 32 }], variadic: true, fixed_parameter_count: 1 };
  const ir = builder('calls-darwin-varargs'), b = ir.block('entry'), sp = b.int('sub', b.readRegister(darwin.stack_pointer), b.constant(i64, 32n));
  b.writeRegister(darwin.stack_pointer, sp); b.store(sp, b.constant(i32, 123n));
  b.store(b.int('add', sp, b.constant(i64, 8n)), b.constant(i64, 0x3ff0000000000000n));
  b.call(target, [], [], darwin.unknown_call_clobbers); b.return();
  const result = analyzeCalls(ssa(ir.finish(b)), darwin, createOperationContext(), { contracts: [contract(sig)] });
  const parameters = result.calls[0]!.contracts[0]!.parameters;
  assert.equal(parameters[0]!.locations[0]!.fact.initialization, 'unknown');
  assert.deepEqual(parameters.slice(1).map(parameter => parameter.locations[0]!.fact.value), [{ kind: 'constant', bits: 123n }, { kind: 'constant', bits: 0x3ff0000000000000n }]);
  assert.deepEqual(parameters.slice(1).map(parameter => parameter.locations[0]!.stack_offset), [-32n, -24n]);
});

test('Windows variadic FP duplication does not claim an unwritten integer copy is initialized', () => {
  const sig: AbiSignature = { returns: { kind: 'void' }, parameters: [u64, { kind: 'float', bits: 64 }], variadic: true, fixed_parameter_count: 1 };
  const layout = windows.classifyCall(sig), locations = layout.parameters[1]!.locations;
  assert.equal(locations.length, 2);
  const fp = locations.find(location => location.kind === 'register' && location.register.bank === 'vector')!;
  assert.equal(fp.kind, 'register'); if (fp.kind !== 'register') throw new Error('Expected register');
  const ir = builder('calls-windows-varargs'), b = ir.block('entry');
  b.writeRegister(fp.register, b.constant(integer(fp.register.width_bits), 0x3ff0000000000000n)); b.call(target, [], [], windows.unknown_call_clobbers); b.return();
  const result = analyzeCalls(ssa(ir.finish(b)), windows, createOperationContext(), { contracts: [contract(sig)] });
  assert.deepEqual(result.calls[0]!.contracts[0]!.parameters[1]!.locations.map(location => location.fact.initialization).sort(), ['initialized', 'unknown']);
});

test('indirect aggregates retain pointer initialization separately from object bytes and hidden result storage', () => {
  const aggregate: AbiType = { kind: 'aggregate', size: 24n, alignment: 8, fields: [0n, 8n, 16n].map(offset => ({ offset, type: u64 })) };
  for (const abi of [darwin, windows]) {
    const sig = signature([aggregate], aggregate), layout = abi.classifyCall(sig);
    const parameter = layout.parameters[0]!.locations[0]!, hidden = layout.hidden_result!;
    assert.equal(parameter.kind, 'indirect'); assert.equal(hidden.kind, 'indirect');
    if (parameter.kind !== 'indirect' || hidden.kind !== 'indirect' || 'stack_offset' in parameter.pointer || 'stack_offset' in hidden.pointer) throw new Error('Expected register indirects');
    const ir = builder(`calls-aggregate-${abi.id}`), b = ir.block('entry'), sp = b.readRegister(abi.stack_pointer);
    const object = b.int('sub', sp, b.constant(i64, 64n)), resultPointer = b.int('sub', sp, b.constant(i64, 96n));
    b.store(object, b.constant(i64, 1n)); b.writeRegister(parameter.pointer, object); b.writeRegister(hidden.pointer, resultPointer);
    b.call(target, [], [], abi.unknown_call_clobbers); b.return();
    const result = analyzeCalls(ssa(ir.finish(b)), abi, createOperationContext(), { contracts: [contract(sig)] });
    const observation = result.calls[0]!.contracts[0]!;
    assert.equal(observation.parameters[0]!.locations[0]!.fact.initialization, 'initialized');
    assert.equal(observation.parameters[0]!.locations[0]!.pointee!.initialization, 'maybe_initialized');
    assert.equal(observation.hidden_result!.fact.initialization, 'initialized');
    assert.equal(observation.hidden_result!.pointee!.initialization, 'uninitialized');
    assert.equal(result.stack.frame.escaped, true);
  }
});

test('proven indirect entry matches an address contract but pointer-storage address never does', () => {
  const ir = builder('calls-indirect-address'), b = ir.block('entry');
  b.call({ kind: 'indirect', value: b.address(address) }, [], [], darwin.unknown_call_clobbers); b.return();
  const program = ssa(ir.finish(b)), call = program.blocks[0]!.instructions.find(node => node.kind === 'call')!;
  const known = contract(signature([]));
  assert.equal(analyzeCalls(program, darwin, createOperationContext(), { contracts: [known] }).calls[0]!.status, 'established');
  const slot = { ...address, value: 0x5000n };
  const imported: SuppliedCallContract = { ...known, id: 'import-contract', target: { kind: 'import', image_id: image, import_id: 'import-1' } };
  const result = analyzeCalls(program, darwin, createOperationContext(), { contracts: [imported, { ...known, id: 'slot-not-code', target: { kind: 'address', address: slot } }],
    resolutions: [{ call_id: call.id, target: imported.target, status: 'candidate', evidence_ids: ['import-evidence'], pointer_storage: slot }] });
  assert.deepEqual(result.calls[0]!.contracts.map(item => item.contract.id), ['import-contract']);
  assert.equal(result.calls[0]!.contracts[0]!.status, 'candidate'); assert.equal(result.calls[0]!.noreturn, 'unknown');
});

test('contradictory established targets and contracts survive without a selected signature or noreturn guess', () => {
  const ir = builder('calls-contradictory'), b = ir.block('entry'); b.call(target, [], [], darwin.unknown_call_clobbers); b.return();
  const program = ssa(ir.finish(b)), originalTerminator = program.blocks[0]!.terminator;
  const a = { ...contract(signature([]), 'a'), noreturn: true }, c = { ...contract(signature([u64]), 'b'), noreturn: false };
  const result = analyzeCalls(program, darwin, createOperationContext(), { contracts: [a, c], function_contracts: [a, c] });
  assert.equal(result.calls[0]!.status, 'conflicting'); assert.equal(result.calls[0]!.noreturn, 'conflicting');
  assert.deepEqual(result.calls[0]!.contracts.map(item => item.contract.id), ['a', 'b']);
  assert.equal(result.function_contract_status, 'conflicting'); assert.equal(program.blocks[0]!.terminator, originalTerminator);
  const only = analyzeCalls(program, darwin, createOperationContext(), { contracts: [a] });
  assert.equal(only.calls[0]!.noreturn, 'yes'); assert.ok(only.diagnostics.length > 0); assert.equal(program.blocks[0]!.terminator.kind, 'return');
});

test('candidate import resolution and unknown calling convention stay explicit', () => {
  const ir = builder('calls-candidate-import'), b = ir.block('entry');
  b.call({ kind: 'indirect', value: b.readRegister(firstRegister(darwin)) }, [], [], darwin.unknown_call_clobbers); b.return();
  const program = ssa(ir.finish(b)), call = program.blocks[0]!.instructions.find(node => node.kind === 'call')!;
  const known: SuppliedCallContract = { ...contract({ ...signature([u64]), calling_convention: 'unknown' }), noreturn: true, target: { kind: 'import', image_id: image, import_id: 'qualified-import' } };
  for (const status of ['candidate', 'established'] as const) {
    const result = analyzeCalls(program, darwin, createOperationContext(), { contracts: [known], resolutions: [{ call_id: call.id, target: known.target, status, evidence_ids: ['binding-proof'] }] });
    assert.equal(result.calls[0]!.status, status); assert.equal(result.calls[0]!.contracts[0]!.layout.state, 'unsupported');
    assert.deepEqual(result.calls[0]!.contracts[0]!.parameters[0]!.locations, []);
    assert.equal(result.calls[0]!.noreturn, status === 'candidate' ? 'unknown' : 'yes');
  }
});

test('function contract returns observe each actual exit rather than entry register state', () => {
  const sig = signature([], u64), location = darwin.classifyCall(sig).returns[0]!;
  assert.equal(location.kind, 'register'); if (location.kind !== 'register') throw new Error('Expected return register');
  const ir = builder('calls-function-returns'), entry = ir.block('entry', [integer(1)]), a = ir.block('a'), b = ir.block('b');
  entry.branch(entry.parameters[0]!, entry.edge(a), entry.edge(b));
  a.writeRegister(location.register, a.constant(i64, 1n)); a.return(); b.writeRegister(location.register, b.constant(i64, 2n)); b.return();
  const result = analyzeCalls(ssa(ir.finish(entry)), darwin, createOperationContext(), { function_contracts: [contract(sig)] });
  assert.deepEqual(result.function_contracts.map(item => item.returns[0]!.fact.value), [{ kind: 'constant', bits: 1n }, { kind: 'constant', bits: 2n }]);
  assert.equal(new Set(result.function_contracts.map(item => item.boundary_id)).size, 2);
  assert.equal(result.return_candidates.length, 2);
});

test('established import aliases a direct stub while contradictory callable addresses remain conflicts', () => {
  const ir = builder('calls-import-alias'), b = ir.block('entry'); b.call(target, [], [], darwin.unknown_call_clobbers); b.return();
  const program = ssa(ir.finish(b)), call = program.blocks[0]!.instructions.find(node => node.kind === 'call')!;
  const known: SuppliedCallContract = { ...contract(signature([])), target: { kind: 'import', image_id: image, import_id: 'qualified-import' } };
  const resolved = { call_id: call.id, target: known.target, status: 'established' as const, evidence_ids: ['bound-stub'], pointer_storage: { ...address, value: 0x5000n } };
  const alias = analyzeCalls(program, darwin, createOperationContext(), { contracts: [known], resolutions: [resolved] });
  assert.equal(alias.calls[0]!.status, 'established'); assert.equal(alias.calls[0]!.contracts[0]!.status, 'established');
  const conflicting = analyzeCalls(program, darwin, createOperationContext(), { contracts: [known], resolutions: [resolved,
    { call_id: call.id, target: { kind: 'address', address: { ...address, value: 0x3000n } }, status: 'established', evidence_ids: ['contradictory-proof'] }] });
  assert.equal(conflicting.calls[0]!.status, 'conflicting'); assert.equal(conflicting.calls[0]!.targets.length, 3);
});

test('known outgoing stack argument on one join arm remains maybe initialized at the call', () => {
  const sig = signature(Array<AbiType>(9).fill(u64));
  const ir = builder('calls-join-stack'), entry = ir.block('entry', [integer(1)]), yes = ir.block('yes'), no = ir.block('no'), end = ir.block('end');
  entry.writeRegister(darwin.stack_pointer, entry.int('sub', entry.readRegister(darwin.stack_pointer), entry.constant(i64, 16n)));
  entry.branch(entry.parameters[0]!, entry.edge(yes), entry.edge(no));
  yes.store(yes.readRegister(darwin.stack_pointer), yes.constant(i64, 99n)); yes.jump(end); no.jump(end);
  end.call(target, [], [], darwin.unknown_call_clobbers); end.return();
  const result = analyzeCalls(ssa(ir.finish(entry)), darwin, createOperationContext(), { contracts: [contract(sig)] });
  assert.equal(result.calls[0]!.contracts[0]!.parameters[8]!.locations[0]!.fact.initialization, 'maybe_initialized');
});

test('bounded call analysis publishes no contract claims after exhaustion', () => {
  const ir = builder('calls-budget'), b = ir.block('entry'); b.call(target, [], [], darwin.unknown_call_clobbers); b.return();
  const program = ssa(ir.finish(b));
  const complete = analyzeCalls(program, darwin, createOperationContext());
  const result = analyzeCalls(program, darwin, createOperationContext(), { contracts: [contract(signature([u64]))], max_work: complete.stack.work });
  assert.equal(result.state, 'partial'); assert.deepEqual(result.calls, []); assert.deepEqual(result.function_contracts, []);
  assert.equal(result.stack.state, 'complete');
});
