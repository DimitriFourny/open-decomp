import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createOperationContext,
  entityIdentity,
  fingerprint,
  type ImportRecord,
  type LoadedImage,
} from '../../src/core/index.js';
import { DarwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { WindowsX64Abi } from '../../src/abi/windows-x64/index.js';
import { findDeclaration, type LibraryKind } from '../../src/metadata/library-contracts/catalog.js';
import {
  generatedDeclaration,
  generatedNames,
} from '../../src/metadata/library-contracts/generated/index.js';
import { recoverLibraryContracts } from '../../src/metadata/library-contracts/index.js';
import { libraryLookupName } from '../../src/metadata/symbols/c-names.js';
import { loadBytes } from './fixture.js';

const darwin = loadBytes(
  readFileSync(new URL('../../fixtures/bin/macho-arm64-symbols', import.meta.url)),
);
const windows = loadBytes(
  readFileSync(new URL('../../fixtures/bin/pe-x86_64-symbols.exe', import.meta.url)),
);
const SYSTEM = '/usr/lib/libSystem.B.dylib';

function binding(image: LoadedImage, native: string, library: string): ImportRecord {
  return {
    id: entityIdentity(image.selected_slice_id, 'prototype-test-import', [native, library]),
    original_name: native,
    display_name: native,
    library,
    ordinal: null,
    slot: null,
    callable_entry: null,
    delayed: false,
    weak: false,
    evidence_ids: [`evidence_${fingerprint(['prototype-test', native, library])}`],
  };
}
function contracts(image: LoadedImage, imports: readonly ImportRecord[]) {
  return recoverLibraryContracts(
    {
      image: { ...image, imports, relocations: [] },
      abi: image.target.format === 'macho' ? new DarwinArm64Abi() : new WindowsX64Abi(),
      revision: 1,
    },
    createOperationContext(),
  );
}
const named = (result: ReturnType<typeof contracts>, linkage: string) =>
  result.contracts.find((item) => item.linkage_name === linkage)!;

test('loader decoration is stripped for lookup while A/W spellings stay distinct', () => {
  assert.equal(libraryLookupName('macho', '_fopen$DARWIN_EXTSN'), 'fopen');
  assert.equal(libraryLookupName('macho', '_stat$INODE64'), 'stat');
  assert.equal(libraryLookupName('macho', '_read$NOCANCEL'), 'read');
  assert.equal(libraryLookupName('elf', 'memcpy@GLIBC_2.14'), 'memcpy');
  assert.equal(libraryLookupName('elf', 'printf@@GLIBC_2.2.5'), 'printf');
  assert.equal(libraryLookupName('pe', '__imp_CreateFileW'), 'CreateFileW');
  assert.notEqual(
    findDeclaration('CreateFileA', 'kernel32.dll', 'pe')?.parameters[0]?.[1],
    findDeclaration('CreateFileW', 'kernel32.dll', 'pe')?.parameters[0]?.[1],
  );
});

test('generated header prototypes replace unknown call interfaces', () => {
  const result = contracts(darwin, [
    binding(darwin, '_strrchr', SYSTEM),
    binding(darwin, '_ferror', SYSTEM),
    binding(darwin, '_fopen$DARWIN_EXTSN', SYSTEM),
  ]);
  const strrchr = named(result, '_strrchr');
  assert.deepEqual(strrchr.abi_signature.parameters, [
    { kind: 'pointer' },
    { kind: 'integer', bits: 32, signed: true },
  ]);
  assert.deepEqual(strrchr.abi_signature.returns, { kind: 'pointer' });
  assert.equal(strrchr.abi_signature.argument_list_complete, true);
  assert.deepEqual(
    strrchr.signature!.parameters.map((parameter) => parameter.name),
    ['s', 'c'],
  );
  const fopen = named(result, '_fopen$DARWIN_EXTSN');
  assert.equal(fopen.abi_signature.parameters?.length, 2);
  const file = result.types.find(
    (type) => type.id === named(result, '_ferror').signature!.parameters[0]!.type_id,
  )!;
  assert.equal(file.definition.kind, 'pointer');
  const pointee = result.types.find(
    (type) => file.definition.kind === 'pointer' && type.id === file.definition.to,
  )!;
  assert.equal(pointee.spelling, 'FILE');
});

test('every declared import of a large image gets its contract (no count cap)', () => {
  const names = [...generatedNames('posix')].slice(0, 400);
  assert.equal(names.length, 400);
  const result = contracts(
    darwin,
    names.map((name) => binding(darwin, `_${name}`, SYSTEM)),
  );
  assert.equal(result.contracts.length, 400);
  assert.ok(!result.diagnostics.some((item) => item.code === 'resource_limit'));
});

test('generated entries keep every pointed-to memory effect unknown', () => {
  const result = contracts(darwin, [
    binding(darwin, '_strlen', SYSTEM),
    binding(darwin, '_strcspn', SYSTEM),
  ]);
  const curated = named(result, '_strlen'),
    generated = named(result, '_strcspn');
  assert.ok(curated.effects.arguments?.length, 'curated footprint stays authoritative');
  assert.equal(generated.effects.arguments, null);
  assert.equal(generated.effects.memory, 'unknown_read_write');
  assert.equal(generated.effects.captures, null);
  assert.equal(generated.effects.returns_argument, null);
  for (const kind of ['c', 'posix', 'darwin', 'windows-kernel'] as const)
    for (const name of generatedNames(kind).slice(0, 200))
      assert.equal(generatedDeclaration(kind, name)!.memory, undefined, name);
});

test('floating-point parameters use the FP register bank and ABI-dependent widths follow the target', () => {
  for (const [image, abi, library, bank] of [
    [darwin, new DarwinArm64Abi(), SYSTEM, 'arm64:v'],
    [windows, new WindowsX64Abi(), 'ucrtbase.dll', 'x86_64:zmm'],
  ] as const) {
    const native = image.target.format === 'macho' ? '_pow' : 'pow';
    const pow = named(contracts(image, [binding(image, native, library)]), native);
    assert.deepEqual(pow.abi_signature.parameters, [
      { kind: 'float', bits: 64 },
      { kind: 'float', bits: 64 },
    ]);
    const layout = abi.classifyCall(pow.abi_signature);
    assert.equal(layout.state, 'complete');
    for (const parameter of layout.parameters) {
      const location = parameter.locations[0]!;
      assert.equal(location.kind, 'register');
      if (location.kind === 'register') assert.ok(location.register.root.includes(bank));
    }
  }
  const clock = (image: LoadedImage, native: string, library: string) =>
    named(contracts(image, [binding(image, native, library)]), native).abi_signature.returns;
  assert.deepEqual(clock(darwin, '_clock', SYSTEM), { kind: 'integer', bits: 64, signed: false });
  assert.deepEqual(clock(windows, 'clock', 'ucrtbase.dll'), {
    kind: 'integer',
    bits: 32,
    signed: true,
  });
});

test('noreturn and variadic format rules come from the headers', () => {
  const darwinResult = contracts(darwin, [
    binding(darwin, '_pthread_exit', SYSTEM),
    binding(darwin, '_dprintf', SYSTEM),
    binding(darwin, '_sscanf', SYSTEM),
    binding(darwin, '_openat', SYSTEM),
    binding(darwin, '___snprintf_chk', SYSTEM),
  ]);
  assert.equal(named(darwinResult, '_pthread_exit').noreturn, true);
  assert.deepEqual(named(darwinResult, '_dprintf').variadic_rule, { kind: 'format', argument: 1 });
  assert.deepEqual(named(darwinResult, '_sscanf').variadic_rule, {
    kind: 'scanf_format',
    argument: 1,
  });
  assert.deepEqual(named(darwinResult, '_openat').variadic_rule, {
    kind: 'open_flags',
    argument: 2,
  });
  assert.deepEqual(named(darwinResult, '___snprintf_chk').variadic_rule, {
    kind: 'format',
    argument: 4,
  });
  const exitThread = named(
    contracts(windows, [binding(windows, 'ExitThread', 'KERNEL32.DLL')]),
    'ExitThread',
  );
  assert.equal(exitThread.noreturn, true);
});

test('declaration families bind only to their nominal library', () => {
  const lookup = (name: string, library: string, format: 'macho' | 'pe' | 'elf') =>
    findDeclaration(name, library, format) !== undefined;
  const cf = '/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation';
  assert.ok(lookup('CFStringCreateWithCString', cf, 'macho'));
  assert.ok(!lookup('CFStringCreateWithCString', SYSTEM, 'macho'));
  assert.ok(lookup('dispatch_async', '/usr/lib/system/libdispatch.dylib', 'macho'));
  assert.ok(lookup('MessageBoxW', 'USER32.dll', 'pe'));
  assert.ok(!lookup('MessageBoxW', 'kernel32.dll', 'pe'));
  assert.ok(lookup('send', 'WS2_32.dll', 'pe'));
  assert.ok(lookup('__errno_location', 'libc.so.6', 'elf'));
  assert.ok(!lookup('__errno_location', SYSTEM, 'macho'));
  assert.ok(lookup('pow', 'libm.so.6', 'elf'));
  assert.ok(lookup('strlen', 'api-ms-win-crt-string-l1-1-0.dll', 'pe'));
  assert.ok(!lookup('strrchr', 'custom.dll', 'pe'));
});

test('named pointer typedefs keep their name over an opaque pointee', () => {
  const result = contracts(windows, [binding(windows, 'CreateFileW', 'KERNEL32.DLL')]);
  const create = named(result, 'CreateFileW');
  const type = (id: string) => result.types.find((item) => item.id === id)!;
  assert.equal(type(create.signature!.return_type).spelling, 'HANDLE');
  assert.equal(type(create.signature!.return_type).definition.kind, 'pointer');
  assert.deepEqual(create.signature!.parameters.map((parameter) => parameter.name).slice(0, 2), [
    'lpFileName',
    'dwDesiredAccess',
  ]);
});

test('every generated declaration decodes with parameter names and header provenance', () => {
  const kinds: LibraryKind[] = [
    'c',
    'posix',
    'darwin',
    'glibc',
    'cxx',
    'corefoundation',
    'windows-crt',
    'windows-kernel',
    'windows-user',
    'windows-advapi',
    'windows-winsock',
    'windows-shell',
  ];
  let total = 0;
  for (const kind of kinds) {
    const names = generatedNames(kind);
    assert.ok(names.length > 20, kind);
    for (const name of names) {
      const entry = generatedDeclaration(kind, name)!;
      total++;
      assert.equal(entry.library, kind);
      assert.match(entry.source, /\S+ \S+/);
      for (const [parameter] of entry.parameters) assert.match(parameter, /^[A-Za-z]\w*$/, name);
    }
  }
  assert.ok(total > 5000, `${total} generated declarations`);
});
