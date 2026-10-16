// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createOperationContext, entityIdentity, contentHash, imageIdentity, ImmutableBytes, OperationError, type AbiType, type Annotation, type RecoveredType } from '../../../src/core/index.js';
import { sysvAMD64Abi as abi } from '../../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { analyzeCalls, type SuppliedCallContract } from '../../../src/analysis/calls/index.js';
import { recoverStack } from '../../../src/analysis/stack/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { AnalysisBudget } from '../../../src/analysis/ssa/budget.js';
import { recoverTypes, type SuppliedTypeRecord } from '../../../src/analysis/types/index.js';
import { SourceLayouts } from '../../../src/analysis/types/layout.js';
import { IRBuilder, integer, type RegisterIR, type SSAForm } from '../../../src/ir/index.js';
import { catalog, identifiesLibrary } from '../../../src/metadata/library-contracts/catalog.js';
import { recoverLibraryContracts } from '../../../src/metadata/library-contracts/index.js';
import { callDeclarations, type CallScope } from '../../../src/service/analysis/calls.js';
import { ELFLoader } from '../../../src/loaders/elf/index.js';
import { recoverDebugInfo } from '../../../src/metadata/debug/index.js';
import { builder, image, provenance, slice } from '../../ir/support.js';
import { emit } from '../../emitters/c/support.js';

const u64: AbiType = { kind: 'integer', bits: 64, signed: false }, f64: AbiType = { kind: 'float', bits: 64 }, i64 = integer(64);
const address = { image_id: image, space: 'va' as const, value: 0x2000n }, target = { kind: 'direct' as const, address };
const alEvidence = `evidence_${'a'.repeat(64)}`;
function ssa(program: RegisterIR): SSAForm {
  const result = constructSSA(program); assert.equal(result.state, 'complete');
  assert.equal(result.value.form, 'ssa'); if (result.value.form !== 'ssa') throw new Error('Expected SSA'); return result.value;
}
function contract(parameters: readonly AbiType[] | null, returns: AbiType = { kind: 'void' }, variadic = false): SuppliedCallContract {
  return { id: 'supplied-sysv', target: { kind: 'address', address }, signature: { parameters, returns, variadic, fixed_parameter_count: variadic ? Math.min(1, parameters?.length ?? 0) : parameters?.length ?? 0, argument_list_complete: parameters !== null }, evidence_ids: ['signature-evidence'] };
}

test('SysV stack call observation accounts for the real hardware push exactly once', () => {
  const supplied = contract(Array<AbiType>(7).fill(u64)), ir = builder('sysv-call-stack'), b = ir.block('entry');
  const caller = b.int('sub', b.readRegister(abi.stack_pointer), b.constant(i64, 24n));
  b.writeRegister(abi.stack_pointer, caller); b.store(caller, b.constant(i64, 77n));
  const callee = b.int('sub', caller, b.constant(i64, 8n)); b.writeRegister(abi.stack_pointer, callee);
  b.store(callee, b.address({ ...address, value: 0x1005n })); b.call(target, [], [], abi.unknown_call_clobbers);
  b.writeRegister(abi.stack_pointer, caller); b.return();
  const program = ssa(ir.finish(b)), original = structuredClone(program);
  const result = analyzeCalls(program, abi, createOperationContext(), { contracts: [supplied] });
  const observation = result.calls[0]!.contracts[0]!.parameters[6]!.locations[0]!;
  assert.deepEqual(observation.fact.value, { kind: 'constant', bits: 77n });
  assert.equal(observation.fact.initialization, 'initialized'); assert.equal(observation.stack_offset, -24n);
  assert.equal(result.calls[0]!.contracts[0]!.layout.shadow_space, 0n); assert.deepEqual(program, original);
});

test('return-address boundaries are distinct from incoming bytes and negative local candidates', () => {
  const ir = builder('sysv-stack-regions'), b = ir.block('entry'), sp = b.readRegister(abi.stack_pointer);
  b.load(i64, sp); b.load(i64, b.int('add', sp, b.constant(i64, 8n)));
  b.load(i64, b.int('add', sp, b.constant(i64, 4n)));
  b.store(b.int('sub', sp, b.constant(i64, 128n)), b.constant(i64, 4n)); b.return();
  const result = recoverStack(ssa(ir.finish(b)), abi, createOperationContext());
  assert.equal(result.state, 'complete');
  assert.deepEqual(result.accesses.map(access => [access.offset, access.region]), [[0n, 'return_address'], [8n, 'incoming_candidate'], [4n, 'mixed'], [-128n, 'local_candidate']]);
});

for (const [observed, conformance] of [[0n, 'violated'], [1n, 'satisfied'], [7n, 'satisfied'], [8n, 'satisfied'], [9n, 'violated'], [null, 'unknown']] as const) {
  test(`variadic AL observation ${observed} is ${conformance}, independent of source arity`, () => {
    const supplied = contract([u64, f64], { kind: 'void' }, true), requirement = abi.classifyCall(supplied.signature).implicit_register_inputs[0]!;
    const ir = new IRBuilder(slice, entityIdentity(slice, 'function', `sysv-al-${observed}`), { ...provenance, evidence_ids: [alEvidence] }), b = ir.block('entry');
    if (observed !== null) b.writeRegister(requirement.register, b.constant(integer(8), observed));
    b.call(target, [], [], abi.unknown_call_clobbers); b.return();
    const program = ssa(ir.finish(b)), original = structuredClone(program);
    const types = recoverTypes(program, abi, createOperationContext(), { image_id: image, slice_id: slice, revision: 0, contracts: [supplied] });
    assert.equal(types.state, 'complete');
    assert.ok(types.calls);
    const observation = types.calls.calls[0]!.contracts[0]!, input = observation.implicit_register_inputs[0]!;
    assert.equal(input.conformance, conformance); assert.equal(observation.parameters.length, 2);
    assert.equal(input.requirement.unsigned_minimum, 1n); assert.equal(input.requirement.unsigned_maximum, 8n);
    if (observed !== null) {
      assert.deepEqual(input.fact.value, { kind: 'constant', bits: observed }); assert.ok(input.fact.evidence_ids.includes(alEvidence));
    }
    assert.equal(observation.layout.argument_count, 2);
    assert.equal(types.signatures[0]!.signature.parameters.length, 1, 'anonymous actuals are not fixed formal parameters');
    const call = program.blocks[0]!.instructions.find(node => node.kind === 'call')!;
    assert.ok(call.kind === 'call');
    const actual = call.register_inputs.find(binding => binding.register.root === 'x86_64:zmm0')!;
    assert.ok(types.associations.some(item => item.subject_id === actual.value.id && item.width_bits === 64 &&
      types.types.some(type => type.id === item.type_id && type.definition.kind === 'float' && type.definition.bits === 64)));
    for (const language of ['c-like', 'python-like'] as const) {
      const emitted = emit(program, { types }, language).emission;
      assert.match(emitted.text, /unsigned_range=\[1, 8\]/);
      assert.match(emitted.text, new RegExp(`conformance=${conformance}`));
      assert.match(emitted.text, /not a source parameter/);
      if (observed !== null) assert.ok(emitted.mappings.some(mapping => mapping.evidence_ids.includes(alEvidence)));
    }
    assert.deepEqual(program, original);
  });
}

test('unknown actuals retain the observed AL but never establish vector use or an arity', () => {
  const supplied = contract(null, { kind: 'void' }, true), requirement = abi.classifyCall(supplied.signature).implicit_register_inputs[0]!;
  const ir = builder('sysv-unknown-varargs'), b = ir.block('entry');
  b.writeRegister(requirement.register, b.constant(integer(8), 3n)); b.call(target, [], [], abi.unknown_call_clobbers); b.return();
  const result = analyzeCalls(ssa(ir.finish(b)), abi, createOperationContext(), { contracts: [supplied] });
  const observation = result.calls[0]!.contracts[0]!;
  assert.equal(observation.layout.state, 'partial'); assert.deepEqual(observation.parameters, []);
  assert.equal(observation.implicit_register_inputs[0]!.conformance, 'unknown');
  assert.deepEqual(observation.implicit_register_inputs[0]!.fact.value, { kind: 'constant', bits: 3n });
});

for (const profile of [abi, windowsX64Abi]) for (const local of [false, true]) test(`${profile.id}: ${local ? 'call-local declaration' : 'target contract'} associates hidden-sret RAX with pointer-to-result, not result bytes`, () => {
  const resultType: AbiType = { kind: 'aggregate', size: 24n, alignment: 8, fields: [0n, 8n, 16n].map(offset => ({ offset, type: u64 })) };
  const ir = builder(`sret-pointer-${profile.id}-${local}`), b = ir.block('entry');
  b.call(target, [], [], profile.unknown_call_clobbers); b.return();
  const program = ssa(ir.finish(b)), call = program.blocks[0]!.instructions.find(node => node.kind === 'call')!;
  assert.ok(call.kind === 'call');
  const output = call.register_outputs.find(binding => binding.register.root === 'x86_64:rax' && binding.register.offset_bits === 0 && binding.register.width_bits === 64);
  assert.ok(output);
  const objectId = entityIdentity(slice, 'test-type', 'sret-object'), scalarId = entityIdentity(slice, 'test-type', 'sret-u64');
  const declarations: SuppliedTypeRecord[] = [
    { id: scalarId, definition: { kind: 'integer', bits: 64, signed: false }, source: 'user', status: 'asserted', evidence_ids: ['sret-proof'] },
    { id: objectId, definition: { kind: 'structure', size: 24n, alignment: 8, fields: [0n, 8n, 16n].map(offset => ({ id: entityIdentity(slice, 'field', offset), name: `field_${offset}`, offset, type_id: scalarId })) }, source: 'user', status: 'asserted', evidence_ids: ['sret-proof'] },
  ];
  const result = recoverTypes(program, profile, createOperationContext(), { image_id: image, slice_id: slice, revision: 0,
    ...(local ? { types: declarations, signatures: [{ id: 'call-local-sret', subject_id: call.id, source: 'user' as const, status: 'asserted' as const, evidence_ids: ['sret-proof'],
      signature: { abi: profile.id, return_type: objectId, parameters: [], variadic: false, noreturn: false, evidence_ids: ['sret-proof'] } }] } : { contracts: [contract([], resultType)] }),
  });
  assert.equal(result.state, 'complete');
  const returnType = result.signatures.find(signature => signature.subject_id === call.id)!.signature.return_type;
  const associations = result.associations.filter(item => item.subject_id === output.value.id && item.value_offset_bits === 0 && item.width_bits === 64);
  assert.ok(associations.some(item => result.types.some(type => type.id === item.type_id && type.definition.kind === 'pointer' && type.definition.to === returnType)));
  assert.equal(associations.some(item => item.type_id === returnType), false);
});

test('mixed return consumers associate both physical fragments with their exact source offsets', () => {
  const mixed: AbiType = { kind: 'aggregate', size: 16n, alignment: 8, fields: [{ offset: 0n, type: f64 }, { offset: 8n, type: u64 }] };
  const ir = builder('sysv-mixed-return-types'), b = ir.block('entry'); b.call(target, [], [], abi.unknown_call_clobbers); b.return();
  const program = ssa(ir.finish(b)), call = program.blocks[0]!.instructions.find(node => node.kind === 'call')!;
  assert.ok(call.kind === 'call');
  const types = recoverTypes(program, abi, createOperationContext(), { image_id: image, slice_id: slice, revision: 0, contracts: [contract([], mixed)] });
  const source = types.signatures[0]!.signature.return_type;
  for (const [root, offset] of [['x86_64:zmm0', 0], ['x86_64:rax', 64]] as const) {
    const physical = call.register_outputs.find(binding => binding.register.root === root)!;
    assert.ok(types.associations.some(item => item.subject_id === physical.value.id && item.type_id === source && item.value_offset_bits === offset && item.width_bits === 64));
  }
});

test('source layout sizes extended values as 16-byte objects, including arrays and field bounds', () => {
  const definitions: [string, RecoveredType][] = [['extended', { kind: 'float', bits: 80 }], ['array', { kind: 'array', element: 'extended', count: 3n }],
    ['object', { kind: 'structure', size: 16n, alignment: 16, fields: [{ id: 'member', name: 'value', offset: 0n, type_id: 'extended' }] }],
    ['truncated', { kind: 'structure', size: 10n, alignment: 2, fields: [{ id: 'short-member', name: 'value', offset: 0n, type_id: 'extended' }] }]];
  const records = new Map<string, SuppliedTypeRecord[]>(definitions.map(([id, definition]) => [id, [{ id, definition, source: 'user', status: 'asserted', evidence_ids: [] }]]));
  const layouts = new SourceLayouts(records, new AnalysisBudget({}), abi.layout);
  assert.equal(layouts.size('extended'), 16n); assert.equal(layouts.size('array'), 48n);
  assert.deepEqual(layouts.abi('extended'), { kind: 'float', bits: 80 });
  assert.equal(layouts.abi('object').kind, 'aggregate'); assert.equal(layouts.abi('truncated').kind, 'unknown');
  assert.equal(new SourceLayouts(records, new AnalysisBudget({}), windowsX64Abi.layout).size('extended'), null);
});

test('ELF library contracts require explicit ELF library attribution and cannot fall through Darwin', () => {
  assert.equal(identifiesLibrary('libc.so.6', catalog.printf!, 'elf'), true);
  assert.equal(identifiesLibrary('/lib/x86_64-linux-gnu/libc.so.6', catalog.read!, 'elf'), true);
  assert.equal(identifiesLibrary('/usr/lib/libSystem.B.dylib', catalog.printf!, 'elf'), false);
  assert.equal(identifiesLibrary('libc.so.6', catalog.__assert_rtn!, 'elf'), false);
  assert.equal(identifiesLibrary('libc.so.6', catalog.__cxa_throw!, 'elf'), false);
  assert.equal(identifiesLibrary('libstdc++.so.6', catalog.__cxa_throw!, 'elf'), true);
  assert.equal(identifiesLibrary('unknown.so', catalog.printf!, 'elf'), false);
});

test('ELF debug capability is explicitly unavailable, not silently absent or Mach-O/PDB decoding', () => {
  const bytes = readFileSync(new URL('./fixtures/abi.so', import.meta.url)), sha256 = contentHash(bytes);
  const loaded = new ELFLoader().load({ image_id: imageIdentity(sha256), sha256, bytes: new ImmutableBytes(bytes), slice_id: null }, createOperationContext());
  const result = recoverDebugInfo(loaded, createOperationContext());
  assert.equal(result.status, 'partial'); assert.equal(result.data, null);
  assert.deepEqual(result.types, []); assert.deepEqual(result.functions, []);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'unavailable_semantics' && diagnostic.message.includes('ELF DWARF')));
  assert.throws(() => recoverDebugInfo(loaded, createOperationContext(), { bytes, artifact_id: `artifact_${'1'.repeat(64)}` }),
    (error: unknown) => error instanceof OperationError && error.code === 'unsupported_target' && error.message.includes('ELF DWARF'));
});

test('call-local signatures retain AL slice observations without creating target-global contracts', () => {
  const ir = builder('sysv-call-local-al'), b = ir.block('entry');
  const rax = abi.unknown_call_clobbers.registers.find(register => register.id === 'x86_64:rax')!;
  b.writeRegister(rax, b.constant(i64, 0x107n));
  b.call(target, [], [], abi.unknown_call_clobbers); b.call(target, [], [], abi.unknown_call_clobbers); b.return();
  const program = ssa(ir.finish(b)), first = program.blocks[0]!.instructions.find(node => node.kind === 'call')!;
  const voidId = entityIdentity(slice, 'source-type', 'local-void'), fpId = entityIdentity(slice, 'source-type', 'local-double');
  const types = recoverTypes(program, abi, createOperationContext(), { image_id: image, slice_id: slice, revision: 0,
    types: [{ id: voidId, definition: { kind: 'void' }, source: 'user', status: 'asserted', evidence_ids: [] },
      { id: fpId, definition: { kind: 'float', bits: 64 }, source: 'user', status: 'asserted', evidence_ids: [] }],
    signatures: [{ id: 'local-variadic', subject_id: first.id, source: 'user', status: 'asserted', evidence_ids: ['local-declaration'],
      signature: { abi: abi.id, return_type: voidId, parameters: [{ id: entityIdentity(slice, 'parameter', 'fixed-fp'), name: null, type_id: fpId }],
        variadic: true, noreturn: false, evidence_ids: ['local-declaration'] } }],
  });
  assert.equal(types.signatures.length, 1); assert.equal(types.signatures[0]!.subject_id, first.id);
  const observed = types.signatures[0]!.implicit_register_inputs[0]!;
  assert.equal(observed.conformance, 'unknown'); assert.deepEqual(observed.fact.value, { kind: 'constant', bits: 7n });
  assert.equal(types.signatures[0]!.abi_state, 'partial');
  assert.equal(observed.requirement.unsigned_minimum, 1n);
  assert.ok(types.calls!.calls.every(call => call.contracts.length === 0));
  for (const language of ['c-like', 'python-like'] as const) {
    const text = emit(program, { types }, language).emission.text;
    assert.match(text, /observed=7, initialization=initialized, conformance=unknown/);
    assert.match(text, /not a source parameter/);
  }
});

test('variadic source declarations do not establish AL satisfaction for unknown anonymous actuals', () => {
  const ir = builder('sysv-declaration-only-al'), b = ir.block('entry');
  const rax = abi.unknown_call_clobbers.registers.find(register => register.id === 'x86_64:rax')!;
  const xmm0 = abi.classifyCall({ parameters: [f64], returns: { kind: 'void' }, variadic: false, fixed_parameter_count: 1 }).parameters[0]!.locations[0]!;
  assert.ok(xmm0.kind === 'register');
  b.writeRegister(rax, b.constant(i64, 0n));
  b.writeRegister(xmm0.register, b.constant(integer(128), 0x3ff0000000000000n));
  b.call(target, [], [], abi.unknown_call_clobbers); b.return();
  const program = ssa(ir.finish(b)), first = program.blocks[0]!.instructions.find(node => node.kind === 'call')!;
  const voidId = entityIdentity(slice, 'source-type', 'declaration-void'), pointerId = entityIdentity(slice, 'source-type', 'declaration-pointer');
  const result = recoverTypes(program, abi, createOperationContext(), { image_id: image, slice_id: slice, revision: 0,
    types: [{ id: voidId, definition: { kind: 'void' }, source: 'user', status: 'asserted', evidence_ids: [] },
      { id: pointerId, definition: { kind: 'pointer', bits: 64, to: voidId }, source: 'user', status: 'asserted', evidence_ids: [] }],
    signatures: [{ id: 'variadic-declaration', subject_id: first.id, source: 'user', status: 'asserted', evidence_ids: [],
      signature: { abi: abi.id, return_type: voidId, parameters: [{ id: entityIdentity(slice, 'parameter', 'format'), name: 'format', type_id: pointerId }],
        variadic: true, noreturn: false, evidence_ids: [] } }],
  });
  const signature = result.signatures[0]!, input = signature.implicit_register_inputs[0]!;
  assert.deepEqual(input.fact.value, { kind: 'constant', bits: 0n });
  assert.equal(input.conformance, 'unknown');
  assert.equal(signature.abi_state, 'partial');
  assert.equal(signature.signature.parameters.length, 1);
  assert.ok(result.calls!.calls.every(call => call.contracts.length === 0));
  for (const language of ['c-like', 'python-like'] as const) {
    const text = emit(program, { types: result }, language).emission.text;
    assert.match(text, /conformance=unknown/); assert.doesNotMatch(text, /conformance=satisfied/);
  }
});

test('service and library declarations retain fixed prefix locations without completing variadic arity', () => {
  const bytes = readFileSync(new URL('./fixtures/abi.so', import.meta.url)), sha256 = contentHash(bytes);
  const loaded = new ELFLoader().load({ image_id: imageIdentity(sha256), sha256, bytes: new ImmutableBytes(bytes), slice_id: null }, createOperationContext());
  const exported = loaded.exports.find(item => item.original_name === 'abi_variadic');
  assert.ok(exported?.address);
  const ir = new IRBuilder(loaded.selected_slice_id, entityIdentity(loaded.selected_slice_id, 'function', 'variadic-declaration-consumer'), provenance), b = ir.block('entry');
  const rax = abi.unknown_call_clobbers.registers.find(register => register.id === 'x86_64:rax')!;
  b.writeRegister(rax, b.constant(i64, 0n)); b.call({ kind: 'direct', address: exported.address }, [], [], abi.unknown_call_clobbers); b.return();
  const program = ssa(ir.finish(b)), call = program.blocks[0]!.instructions.find(node => node.kind === 'call')!;
  const voidId = entityIdentity(loaded.selected_slice_id, 'source-type', 'void'), integerId = entityIdentity(loaded.selected_slice_id, 'source-type', 'u64');
  const sourceTypes: SuppliedTypeRecord[] = [
    { id: voidId, definition: { kind: 'void' }, source: 'user', status: 'asserted', evidence_ids: [] },
    { id: integerId, definition: { kind: 'integer', bits: 64, signed: false }, source: 'user', status: 'asserted', evidence_ids: [] },
  ];
  const annotation: Annotation = { id: `annotation_${'b'.repeat(64)}`, entity_id: exported.id, author: 'test', origin: 'user', status: 'asserted', revision: 0, evidence_ids: [],
    value: { kind: 'signature', value: { abi: abi.id, return_type: voidId, parameters: [{ id: entityIdentity(loaded.selected_slice_id, 'parameter', 'fixed'), name: null, type_id: integerId }],
      variadic: true, noreturn: false, evidence_ids: [] } } };
  const scope: CallScope = { resolutions: [], subjects: [exported.id], calls_by_subject: new Map([[exported.id, [{ call_id: call.id, target: { kind: 'address', address: exported.address }, evidence_ids: [] }]]]) };
  const declarations = callDeclarations(program, loaded, 0, scope, recoverDebugInfo(loaded, createOperationContext()), [annotation], sourceTypes, createOperationContext(), abi.layout);
  assert.equal(declarations.contracts[0]!.signature.argument_list_complete, false);
  const observed = analyzeCalls(program, abi, createOperationContext(), { contracts: declarations.contracts }).calls[0]!.contracts[0]!;
  assert.equal(observed.layout.argument_count, null); assert.equal(observed.layout.state, 'partial');
  assert.equal(observed.parameters.length, 1); assert.equal(observed.implicit_register_inputs[0]!.conformance, 'unknown');

  const imported = { id: entityIdentity(loaded.selected_slice_id, 'import', 'explicit-libc-printf'), original_name: 'printf', display_name: 'printf', library: 'libc.so.6',
    ordinal: null, slot: null, callable_entry: null, delayed: false, weak: false, evidence_ids: [] };
  const library = recoverLibraryContracts({ image: { ...loaded, imports: [imported], relocations: [] }, abi, revision: 0 }, createOperationContext());
  assert.equal(library.contracts.length, 1); assert.equal(library.contracts[0]!.abi_signature.argument_list_complete, false);
  const layout = abi.classifyCall(library.contracts[0]!.abi_signature);
  assert.equal(layout.state, 'partial'); assert.equal(layout.argument_count, null); assert.equal(layout.parameters.length, 1);
  assert.ok(layout.parameters[0]!.locations[0]?.kind === 'register');
});

test('compatible fixed prefixes and complete actual lists remain independent nonconflicting observations', () => {
  const actuals = contract([u64, f64], { kind: 'void' }, true);
  const prefix = { ...actuals, id: 'fixed-prefix', signature: { ...actuals.signature, parameters: [u64], argument_list_complete: false } };
  const ir = builder('sysv-compatible-prefix'), b = ir.block('entry');
  const al = abi.classifyCall(actuals.signature).implicit_register_inputs[0]!.register;
  b.writeRegister(al, b.constant(integer(8), 0n)); b.call(target, [], [], abi.unknown_call_clobbers); b.return();
  const program = ssa(ir.finish(b));
  const result = analyzeCalls(program, abi, createOperationContext(), { contracts: [prefix, actuals] });
  assert.equal(result.calls[0]!.status, 'established');
  assert.deepEqual(result.calls[0]!.contracts.map(item => item.layout.argument_count), [null, 2]);
  assert.deepEqual(result.calls[0]!.contracts.map(item => item.implicit_register_inputs[0]!.conformance), ['unknown', 'violated']);
  const incompatible = { ...actuals, id: 'contradictory-actual-count', signature: { ...actuals.signature, parameters: [u64] } };
  assert.equal(analyzeCalls(program, abi, createOperationContext(), { contracts: [actuals, incompatible] }).calls[0]!.status, 'conflicting');
});
