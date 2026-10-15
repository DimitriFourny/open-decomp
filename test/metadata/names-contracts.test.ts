import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createOperationContext, entityIdentity, fingerprint, OperationError, type ImportRecord, type LoadedImage } from '../../src/core/index.js';
import { DarwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { WindowsX64Abi } from '../../src/abi/windows-x64/index.js';
import { decorateImageNames, demangleName } from '../../src/metadata/symbols/index.js';
import { recoverLibraryContracts } from '../../src/metadata/library-contracts/index.js';
import { fixtureImage, loadBytes } from './fixture.js';

for (const [file, fragment] of [['objc-cxx.dylib', 'fixture::bar'], ['metadata.dll', 'fixture::bar'], ['swift.dylib', 'FixtureMetadata.metadataSum']] as const) test(`compiler-native names remain addressable after demangling: ${file}`, async () => {
  const image = fixtureImage(file), native = [...image.symbols, ...image.exports].find(item => item.original_name?.includes(file === 'swift.dylib' ? 'metadataSum' : 'bar'));
  assert.ok(native?.original_name);
  const names = await decorateImageNames(image, createOperationContext()), shown = [...names.symbols, ...names.exports].find(item => item.id === native.id);
  assert.ok(shown); assert.ok(shown.display_name?.includes(fragment));
  assert.equal(shown.original_name, native.original_name); assert.deepEqual(shown.address, native.address); assert.deepEqual(shown.evidence_ids, native.evidence_ids);
  assert.equal([...image.symbols, ...image.exports].find(item => item.id === native.id)!.display_name, native.display_name);
  const renamed = await decorateImageNames({ ...image, symbols: image.symbols.map(item => ({ ...item, display_name: 'reviewed_name' })), exports: image.exports.map(item => ({ ...item, display_name: 'reviewed_name' })) }, createOperationContext());
  assert.equal([...renamed.symbols, ...renamed.exports].find(item => item.id === native.id)!.display_name, 'reviewed_name');
});

test('mangling decoration is format-aware; malformed, ordinary and bounded names retain exact linkage', async () => {
  const valid = await demangleName('__ZN7fixture3barEi', 'macho', createOperationContext());
  assert.equal(valid.status, 'demangled'); assert.ok(valid.display_name?.includes('fixture::bar'));
  for (const [name, format, status] of [['_puts', 'macho', 'plain'], ['__ZN7fixture3barEi', 'pe', 'plain'], ['__Zinvalid', 'macho', 'unrecognized'], ['?bar@fixture@@YAHH@Z\0suffix', 'pe', 'unrecognized'], [`_Z${'1'.repeat(4096)}`, 'pe', 'limited']] as const) {
    const result = await demangleName(name, format, createOperationContext());
    assert.equal(result.original_name, name); assert.equal(result.display_name, null); assert.equal(result.status, status);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(demangleName('__ZN7fixture3barEi', 'macho', createOperationContext({ signal: controller.signal })), (error: unknown) => error instanceof OperationError && error.code === 'cancelled');
});

const darwin = loadBytes(readFileSync(new URL('../../fixtures/bin/macho-arm64-symbols', import.meta.url)));
const windows = loadBytes(readFileSync(new URL('../../fixtures/bin/pe-x86_64-symbols.exe', import.meta.url)));
function binding(image: LoadedImage, name: string, library: string, options: Partial<Pick<ImportRecord, 'slot' | 'callable_entry' | 'weak'>> = {}): ImportRecord {
  const original_name = image.target.format === 'macho' ? `_${name}` : name;
  return { id: entityIdentity(image.selected_slice_id, 'contract-test-import', [name, library]), original_name, display_name: original_name, library, ordinal: null, slot: null, callable_entry: null, delayed: false, weak: false, evidence_ids: [`evidence_${fingerprint(['contract-test', name, library])}`], ...options };
}
function contracts(image: LoadedImage, imports: readonly ImportRecord[]) {
  return recoverLibraryContracts({ image: { ...image, imports, relocations: [] }, abi: image.target.format === 'macho' ? new DarwinArm64Abi() : new WindowsX64Abi(), revision: 1 }, createOperationContext());
}

test('real imports provide puts and ExitProcess declarations without treating slots as entries', () => {
  for (const [image, abi, name, noreturn] of [[darwin, new DarwinArm64Abi(), '_puts', false], [windows, new WindowsX64Abi(), 'ExitProcess', true]] as const) {
    const result = recoverLibraryContracts({ image, abi, revision: 1 }, createOperationContext());
    const pointer = result.contracts.find(item => item.linkage_name === name && item.slot !== null);
    assert.ok(pointer); assert.equal(pointer.callable_entry, null); assert.equal(pointer.noreturn, noreturn);
    assert.equal(pointer.abi_signature.parameters?.length, 1); assert.equal(pointer.effects.memory, 'unknown_read_write');
    assert.equal(result.evidence.find(item => item.id === pointer.evidence_ids[0])!.origin.kind, 'library');
  }
});

test('library long follows LP64/LLP64 while pointers and size_t remain 64-bit', () => {
  for (const [image, library, longBits] of [[darwin, '/usr/lib/libSystem.B.dylib', 64], [windows, 'UCRTBASE.DLL', 32]] as const) {
    const result = contracts(image, [binding(image, 'strtol', library), binding(image, 'malloc', library)]);
    const strtol = result.contracts.find(item => item.linkage_name.endsWith('strtol'))!, malloc = result.contracts.find(item => item.linkage_name.endsWith('malloc'))!;
    assert.deepEqual(strtol.abi_signature.returns, { kind: 'integer', bits: longBits, signed: true });
    assert.deepEqual(malloc.abi_signature.parameters, [{ kind: 'integer', bits: 64, signed: false }]);
    assert.deepEqual(malloc.abi_signature.returns, { kind: 'pointer' });
    const end = result.types.find(type => type.id === strtol.signature!.parameters[1]!.type_id)!;
    assert.equal(end.definition.kind, 'pointer');
    if (end.definition.kind === 'pointer') { const target = end.definition.to; assert.equal(result.types.find(type => type.id === target)!.definition.kind, 'pointer'); }
  }
});

test('POSIX read and Windows _read have different count and result widths', () => {
  const posix = contracts(darwin, [binding(darwin, 'read', '/usr/lib/libSystem.B.dylib')]).contracts[0]!;
  const crt = contracts(windows, [binding(windows, '_read', 'ucrtbase.dll')]).contracts[0]!;
  assert.deepEqual(posix.abi_signature.returns, { kind: 'integer', bits: 64, signed: true });
  assert.deepEqual(posix.abi_signature.parameters?.[2], { kind: 'integer', bits: 64, signed: false });
  assert.deepEqual(crt.abi_signature.returns, { kind: 'integer', bits: 32, signed: true });
  assert.deepEqual(crt.abi_signature.parameters?.[2], { kind: 'integer', bits: 32, signed: false });
});

test('names, unqualified libraries, weak bindings and adjusted pointer/stub aliases do not establish signatures', () => {
  assert.deepEqual(contracts(darwin, []).contracts, []);
  assert.deepEqual(contracts(windows, [binding(windows, 'exit', 'custom.dll'), binding(windows, 'exit', 'ucrtbase.dll', { weak: true })]).contracts, []);
  const pointer = binding(darwin, 'exit', '/usr/lib/libSystem.B.dylib', { slot: darwin.imports.find(item => item.slot !== null)!.slot }), stub = { ...pointer, id: entityIdentity(darwin.selected_slice_id, 'test-stub', 'exit'), slot: null, callable_entry: darwin.entry_points[0]! };
  const result = recoverLibraryContracts({ image: { ...darwin, imports: [pointer, stub], relocations: [{ id: entityIdentity(darwin.selected_slice_id, 'test-bind', 'exit'), address: pointer.slot!, kind: 'bind', encoding: 'test', width_bits: 64, target: null, symbol_id: pointer.id, addend: 4n, authenticated: false, evidence_ids: pointer.evidence_ids }] }, abi: new DarwinArm64Abi(), revision: 1 }, createOperationContext());
  assert.deepEqual(result.contracts, []); assert.equal(result.state, 'partial');
});

test('incompatible contracts at one import slot retain symmetric conflicts', () => {
  const slot = windows.imports.find(item => item.slot !== null)!.slot;
  const result = contracts(windows, [binding(windows, 'exit', 'ucrtbase.dll', { slot }), binding(windows, 'puts', 'ucrtbase.dll', { slot })]);
  const [left, right] = result.contracts;
  assert.ok(left && right); assert.equal(result.state, 'partial');
  assert.deepEqual(left.conflicts_with, [right.id]); assert.deepEqual(right.conflicts_with, [left.id]);
  assert.deepEqual(result.evidence[0]!.conflicts_with, [result.evidence[1]!.id]);
  assert.notEqual(left.noreturn, right.noreturn);
});

test('known zero arity, variadic fixed prefixes and unsupported Swift conventions remain distinct', () => {
  const result = contracts(darwin, [binding(darwin, 'abort', '/usr/lib/libSystem.B.dylib'), binding(darwin, 'printf', '/usr/lib/libSystem.B.dylib'), binding(darwin, 'swift_task_alloc', '/usr/lib/swift/libswift_Concurrency.dylib')]);
  const abort = result.contracts.find(item => item.linkage_name === '_abort')!, printf = result.contracts.find(item => item.linkage_name === '_printf')!, swift = result.contracts.find(item => item.linkage_name === '_swift_task_alloc')!;
  assert.deepEqual(abort.abi_signature.parameters, []); assert.equal(abort.noreturn, true);
  assert.equal(printf.abi_signature.variadic, true); assert.equal(printf.abi_signature.fixed_parameter_count, 1); assert.equal(printf.abi_signature.parameters?.length, 1);
  assert.equal(swift.abi_state, 'unsupported'); assert.equal(swift.signature, null); assert.equal(new DarwinArm64Abi().classifyCall(swift.abi_signature).state, 'unsupported');
});
