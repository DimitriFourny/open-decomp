import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { openBinary, type ToolResult } from '../../src/api/index.js';
import { DarwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import {
  createOperationContext,
  entityIdentity,
  fingerprint,
  type ImportRecord,
  type LoadedImage,
} from '../../src/core/index.js';
import {
  libraryConstantSet,
  libraryConstantText,
} from '../../src/metadata/library-contracts/constant-names.js';
import {
  CONSTANT_ARGUMENTS,
  CONSTANT_SETS,
} from '../../src/metadata/library-contracts/constants.js';
import {
  libraryConstant,
  libraryRecord,
  libraryRecordNames,
} from '../../src/metadata/library-contracts/generated/types/index.js';
import { recoverLibraryContracts } from '../../src/metadata/library-contracts/index.js';
import { loadBytes } from './fixture.js';

const FIXTURES = resolve('test/metadata/library-types/fixtures');
const field = (abi: Parameters<typeof libraryRecord>[0], record: string, name: string) =>
  libraryRecord(abi, record)?.fields.find((item) => item.name === name);

test('record layouts follow each target ABI and header set', () => {
  // glibc and Darwin lay out `struct stat` differently; LLP64 shrinks `long`.
  assert.equal(libraryRecord('sysv-amd64', 'struct stat')?.size, 144);
  assert.equal(field('sysv-amd64', 'struct stat', 'st_mode')?.offset, 24);
  assert.equal(field('darwin-arm64', 'struct stat', 'st_mode')?.offset, 4);
  assert.equal(field('sysv-amd64', 'struct stat', 'st_size')?.type, 'long');
  assert.deepEqual(field('sysv-amd64', 'struct dirent', 'd_name')?.type, {
    kind: 'array',
    of: 'char',
    count: 256,
  });
  // A typedef resolves through its alias; Darwin prototype spellings map to POSIX names.
  assert.equal(libraryRecord('sysv-amd64', 'FILE')?.name, 'struct _IO_FILE');
  assert.equal(field('sysv-amd64', 'FILE', '_fileno')?.offset, 112);
  assert.equal(libraryRecord('sysv-amd64', '__darwin_pthread_mutex_t')?.size, 40);
  assert.equal(libraryRecord('sysv-amd64', 'pthread_mutex_t')?.union, true);
  // Anonymous members are flattened: OVERLAPPED's union overlays Offset and Pointer.
  const overlapped = libraryRecord('windows-x64', 'OVERLAPPED')!;
  assert.deepEqual(
    overlapped.fields.map((item) => [item.name, item.offset]),
    [
      ['Internal', 0],
      ['InternalHigh', 8],
      ['Offset', 16],
      ['OffsetHigh', 20],
      ['Pointer', 16],
      ['hEvent', 24],
    ],
  );
  assert.equal(field('windows-x64', 'WIN32_FIND_DATAW', 'cFileName')?.offset, 44);
  assert.equal(libraryRecord('windows-x64', 'SECURITY_ATTRIBUTES')?.size, 24);
  // `struct _LIST_ENTRY *Flink` points back to its own record.
  assert.deepEqual(field('windows-x64', 'LIST_ENTRY', 'Flink')?.type, {
    kind: 'pointer',
    to: { kind: 'opaque', name: 'struct _LIST_ENTRY' },
  });
  assert.equal(libraryRecord('sysv-amd64', 'DIR'), undefined, 'glibc DIR stays opaque');
  assert.ok(libraryRecordNames('windows-x64').includes('GUID'));
});

test('constant values come from each platform header', () => {
  assert.equal(libraryConstant('sysv-amd64', 'O_CREAT'), 0x40n);
  assert.equal(libraryConstant('darwin-arm64', 'O_CREAT'), 0x200n);
  assert.equal(libraryConstant('windows-x64', 'O_CREAT'), 0x100n);
  assert.equal(libraryConstant('sysv-amd64', 'MAP_ANONYMOUS'), 0x20n);
  assert.equal(libraryConstant('darwin-arm64', 'MAP_ANONYMOUS'), 0x1000n);
  assert.equal(libraryConstant('windows-x64', 'MEM_COMMIT'), 0x1000n);
  assert.equal(libraryConstant('sysv-amd64', 'MEM_COMMIT'), undefined);
  // Every curated argument names a known set.
  for (const [name, args] of Object.entries(CONSTANT_ARGUMENTS))
    for (const set of Object.values(args)) assert.ok(set in CONSTANT_SETS, `${name}: ${set}`);
});

test('constant arguments spell flags, value fields, exact values and modes', () => {
  const text = (
    abi: Parameters<typeof libraryConstantText>[0],
    fn: string,
    index: number,
    value: bigint,
    bits = 32,
  ) => libraryConstantText(abi, libraryConstantSet(fn, index)!, value, bits);
  assert.equal(text('sysv-amd64', 'open', 1, 0x241n), 'O_WRONLY | O_CREAT | O_TRUNC');
  assert.equal(text('darwin-arm64', 'open', 1, 0x601n), 'O_WRONLY | O_CREAT | O_TRUNC');
  assert.equal(text('sysv-amd64', 'open', 1, 0n), 'O_RDONLY');
  assert.equal(text('sysv-amd64', 'open', 2, 0o644n), '0644');
  assert.equal(
    libraryConstantText('sysv-amd64', CONSTANT_SETS.file_mode, 0o755n, 32, '0o'),
    '0o755',
  );
  assert.equal(text('sysv-amd64', 'mmap', 2, 3n), 'PROT_READ | PROT_WRITE');
  assert.equal(text('sysv-amd64', 'mmap', 2, 0n), 'PROT_NONE');
  assert.equal(text('sysv-amd64', 'mmap', 3, 0x22n), 'MAP_PRIVATE | MAP_ANONYMOUS');
  assert.equal(text('darwin-arm64', 'mmap', 3, 0x1002n), 'MAP_PRIVATE | MAP_ANONYMOUS');
  assert.equal(text('sysv-amd64', 'socket', 1, 0x80001n), 'SOCK_STREAM | SOCK_CLOEXEC');
  assert.equal(text('sysv-amd64', 'socket', 2, 0n), undefined, 'protocol 0 has no name');
  assert.equal(text('sysv-amd64', 'signal', 0, 2n), 'SIGINT');
  assert.equal(text('sysv-amd64', 'signal', 1, 1n, 64), 'SIG_IGN');
  assert.equal(text('sysv-amd64', 'signal', 0, 99n), undefined);
  // Bits no name covers stay a number beside the names.
  assert.equal(text('sysv-amd64', 'mmap', 2, 0x13n), 'PROT_READ | PROT_WRITE | 0x10');
  assert.equal(text('windows-x64', 'CreateFileW', 1, 0xc0000000n), 'GENERIC_READ | GENERIC_WRITE');
  assert.equal(text('windows-x64', 'CreateFileW', 4, 3n), 'OPEN_EXISTING');
  assert.equal(text('windows-x64', 'VirtualAlloc', 2, 0x3000n), 'MEM_COMMIT | MEM_RESERVE');
  assert.equal(text('windows-x64', 'VirtualAlloc', 3, 4n), 'PAGE_READWRITE');
  assert.equal(text('windows-x64', 'WaitForSingleObject', 1, 0xffffffffn), 'INFINITE');
  assert.equal(text('windows-x64', 'MessageBoxW', 3, 0x10n), 'MB_OK | MB_ICONERROR');
  assert.equal(
    text('windows-x64', 'RegOpenKeyExW', 0, 0xffffffff80000002n, 64),
    'HKEY_LOCAL_MACHINE',
  );
  assert.equal(text('windows-x64', 'RegOpenKeyExW', 3, 0x20119n), 'KEY_READ | KEY_WOW64_64KEY');
});

test('a library prototype naming a header record supplies its declared members', () => {
  const image = loadBytes(
    readFileSync(new URL('../../fixtures/bin/macho-arm64-symbols', import.meta.url)),
  );
  const imported: ImportRecord = {
    id: entityIdentity(image.selected_slice_id, 'library-types-test', ['_stat']),
    original_name: '_stat',
    display_name: '_stat',
    library: '/usr/lib/libSystem.B.dylib',
    ordinal: null,
    slot: null,
    callable_entry: null,
    delayed: false,
    weak: false,
    evidence_ids: [`evidence_${fingerprint(['library-types-test'])}`],
  };
  const result = recoverLibraryContracts(
    {
      image: { ...image, imports: [imported], relocations: [] } as LoadedImage,
      abi: new DarwinArm64Abi(),
      revision: 1,
    },
    createOperationContext(),
  );
  const types = new Map(result.types.map((type) => [type.id, type]));
  const parameter = types.get(result.contracts[0]!.signature!.parameters[1]!.type_id)!;
  assert.equal(parameter.definition.kind, 'pointer');
  const record = types.get(
    (parameter.definition as Extract<typeof parameter.definition, { kind: 'pointer' }>).to,
  )!;
  assert.equal(record.spelling, 'struct stat');
  assert.equal(record.member_names, true);
  assert.ok(record.definition.kind === 'structure');
  assert.equal(record.definition.size, 144n);
  const mode = record.definition.fields.find((item) => item.name === 'st_mode')!;
  assert.equal(mode.offset, 4n);
  assert.deepEqual(types.get(mode.type_id)?.definition, {
    kind: 'integer',
    bits: 16,
    signed: false,
  });
  // `struct timespec st_atimespec` is a nested record by value.
  const time = record.definition.fields.find((item) => item.name === 'st_atimespec')!;
  assert.equal(types.get(time.type_id)?.spelling, 'struct timespec');
});

function text(result: ToolResult<'function_decompile'>): string {
  assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
  return result.data.emission.text;
}

test(
  'library calls through ELF PLT stubs and PE imports get typed records and constant names',
  { timeout: 300000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-library-types-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const elf = await openBinary(join(FIXTURES, 'libcalls-stripped'), { cachePath: root });
    try {
      const at = async (value: string, language: 'c-like' | 'python-like' = 'c-like') =>
        text(await elf.decompile({ address: { space: 'va', value } }, { emitter: language }));
      // Calls reach glibc only through lazy-binding PLT stubs of a stripped image.
      assert.match(await at('0x126b'), /open\(path, O_WRONLY \| O_CREAT \| O_TRUNC, 0644\)/);
      assert.match(await at('0x126b', 'python-like'), /O_WRONLY \| O_CREAT \| O_TRUNC, 0o644\)/);
      assert.match(
        await at('0x12b6'),
        /mmap\(.*, PROT_READ \| PROT_WRITE, MAP_PRIVATE \| MAP_ANONYMOUS, /,
      );
      assert.match(await at('0x12ef'), /socket\(AF_INET, SOCK_STREAM, 0\)/);
      const entries = await at('0x135e');
      assert.match(entries, /struct dirent\* entry;/);
      assert.match(entries, /entry->d_type == 8/);
      assert.match(entries, /entry->d_name\[0\]/);
      assert.doesNotMatch(entries, /struct dirent \{/, 'a header record prints no body');
      const hour = await at('0x13ac');
      assert.match(hour, /tm->tm_hour/);
      assert.match(hour, /tm->tm_min/);
    } finally {
      await elf.close();
    }
    const pe = await openBinary(join(FIXTURES, 'wincalls.exe'), { cachePath: root });
    try {
      const size = text(await pe.decompile({ name: 'file_size_low' }));
      assert.match(size, /struct _WIN32_FIND_DATAW\*/);
      const network = text(await pe.decompile({ name: 'start_network' }));
      assert.match(network, /socket\)\)\(AF_INET, SOCK_STREAM, IPPROTO_TCP\)/);
      const spawn = text(await pe.decompile({ name: 'spawn' }));
      assert.match(spawn, /INFINITE\)/);
    } finally {
      await pe.close();
    }
  },
);
