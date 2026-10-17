import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../src/core/index.js';
import { recoverCodeViewReferences } from '../../src/metadata/codeview/index.js';
import { fixtureBytes, fixtureImage, loadBytes } from './fixture.js';

type RecordInput =
  | { kind: 'rsds'; guid: string; age: number; path: string }
  | { kind: 'nb10'; timestamp: number; age: number; offset: number; path: string }
  | { kind: 'vendor' };
/** Repoint real PE debug-directory entries into existing section padding, leaving
 * exports intact. Every identity case still traverses the production PE loader. */
function withRecords(records: readonly RecordInput[]) {
  assert.ok(records.length <= 2);
  const bytes = fixtureBytes('metadata.dll'),
    nt = bytes.readUInt32LE(0x3c),
    optional = nt + 24;
  const table = optional + bytes.readUInt16LE(nt + 20),
    count = bytes.readUInt16LE(nt + 6);
  let section = -1;
  for (let index = 0; index < count; index++) {
    const at = table + index * 40;
    if (bytes.toString('ascii', at, at + 8).replace(/\0.*$/, '') === '.rdata') section = at;
  }
  assert.ok(section >= 0);
  const raw = bytes.readUInt32LE(section + 20),
    rva = bytes.readUInt32LE(section + 12),
    rawSize = bytes.readUInt32LE(section + 16);
  const directoryRva = bytes.readUInt32LE(optional + 112 + 6 * 8),
    directory = raw + directoryRva - rva;
  bytes.writeUInt32LE(records.length * 28, optional + 112 + 6 * 8 + 4);
  let next = (bytes.readUInt32LE(section + 8) + 3) & ~3;
  records.forEach((record, index) => {
    const path =
      record.kind === 'vendor' ? Buffer.alloc(0) : Buffer.from(`${record.path}\0`, 'utf8');
    const payload = Buffer.alloc(
      (record.kind === 'rsds' ? 24 : record.kind === 'nb10' ? 16 : 4) + path.length,
    );
    if (record.kind === 'rsds') {
      payload.write('RSDS');
      payload.set(Buffer.from(record.guid, 'hex'), 4);
      payload.writeUInt32LE(record.age, 20);
      payload.set(path, 24);
    } else if (record.kind === 'nb10') {
      payload.write('NB10');
      payload.writeUInt32LE(record.offset, 4);
      payload.writeUInt32LE(record.timestamp, 8);
      payload.writeUInt32LE(record.age, 12);
      payload.set(path, 16);
    } else payload.write('TEST');
    assert.ok(next + payload.length <= rawSize);
    const entry = directory + index * 28;
    bytes.writeUInt32LE(2, entry + 12);
    bytes.writeUInt32LE(payload.length, entry + 16);
    bytes.writeUInt32LE(rva + next, entry + 20);
    bytes.writeUInt32LE(raw + next, entry + 24);
    bytes.set(payload, raw + next);
    next = (next + payload.length + 3) & ~3;
  });
  bytes.writeUInt32LE(next, section + 8);
  return loadBytes(bytes);
}

const guid = '00112233445566778899aabbccddeeff';
test('real linker RSDS GUID uses mixed endianness and retains its inert path and binary evidence', () => {
  const image = fixtureImage('metadata.dll'),
    result = recoverCodeViewReferences({ image, revision: 1 }, createOperationContext());
  assert.equal(result.state, 'complete');
  assert.equal(result.references.length, 1);
  const reference = result.references[0]!;
  assert.deepEqual(reference.identity, {
    kind: 'rsds',
    guid: '7ccf6585-078d-5e8f-4c4c-44205044422e',
    age: 1n,
  });
  assert.equal(reference.path, 'metadata.pdb');
  assert.equal(reference.raw_data?.start.value, 0x638n);
  assert.equal(reference.raw_data?.start.space, 'file');
  assert.equal(result.evidence[0]!.origin.kind, 'binary');
  assert.equal(reference.status, 'identity');
});

test('distinct RSDS identities are conflicting alternatives, not last-writer-wins', () => {
  const image = withRecords([
    { kind: 'rsds', guid, age: 1, path: 'a.pdb' },
    { kind: 'rsds', guid, age: 2, path: 'b.pdb' },
  ]);
  const result = recoverCodeViewReferences({ image, revision: 1 }, createOperationContext());
  assert.equal(result.state, 'partial');
  assert.deepEqual(
    result.references.map((reference) => reference.status),
    ['conflicting', 'conflicting'],
  );
  assert.deepEqual(
    result.references.map((reference) => reference.identity),
    [
      { kind: 'rsds', guid: '33221100-5544-7766-8899-aabbccddeeff', age: 1n },
      { kind: 'rsds', guid: '33221100-5544-7766-8899-aabbccddeeff', age: 2n },
    ],
  );
  assert.deepEqual(
    result.evidence.map((evidence) => evidence.conflicts_with),
    [[result.evidence[1]!.id], [result.evidence[0]!.id]],
  );
});

test('equivalent RSDS identities ignore path spelling while preserving UNC and URL text', () => {
  const paths = ['\\\\missing.invalid\\share\\private.pdb', 'https://missing.invalid/private.pdb'];
  const image = withRecords(paths.map((path) => ({ kind: 'rsds', guid, age: 0xffffffff, path })));
  const result = recoverCodeViewReferences({ image, revision: 1 }, createOperationContext());
  assert.equal(result.state, 'complete');
  assert.deepEqual(
    result.references.map((reference) => reference.path),
    paths,
  );
  assert.deepEqual(result.references[0]!.identity, result.references[1]!.identity);
  assert.deepEqual(
    result.evidence.map((evidence) => evidence.conflicts_with),
    [[], []],
  );
});

test('NB10 timestamp and age establish identity; legacy location offsets do not', () => {
  const image = withRecords([
    { kind: 'nb10', timestamp: 0x89abcdef, age: 42, offset: 16, path: 'first.pdb' },
    { kind: 'nb10', timestamp: 0x89abcdef, age: 42, offset: 32, path: 'second.pdb' },
  ]);
  const result = recoverCodeViewReferences({ image, revision: 1 }, createOperationContext());
  assert.equal(result.state, 'complete');
  assert.deepEqual(
    result.references.map((reference) => reference.identity),
    [
      { kind: 'nb10', timestamp: 0x89abcdefn, age: 42n },
      { kind: 'nb10', timestamp: 0x89abcdefn, age: 42n },
    ],
  );
  assert.deepEqual(
    result.references.map((reference) => reference.path),
    ['first.pdb', 'second.pdb'],
  );
});

test('unsupported signatures remain visible and bounded recovery never claims all identities', () => {
  const image = withRecords([
    { kind: 'vendor' },
    { kind: 'rsds', guid, age: 1, path: 'known.pdb' },
  ]);
  const result = recoverCodeViewReferences({ image, revision: 1 }, createOperationContext());
  assert.equal(result.state, 'partial');
  assert.equal(result.references[0]!.identity, null);
  assert.equal(result.references[0]!.status, 'unsupported');
  assert.equal(result.references[1]!.status, 'identity');
  const bounded = recoverCodeViewReferences(
    { image, revision: 1, max_records: 1 },
    createOperationContext(),
  );
  assert.equal(bounded.state, 'partial');
  assert.equal(bounded.references.length, 1);
  assert.ok(bounded.diagnostics.some((diagnostic) => diagnostic.code === 'resource_limit'));
  assert.equal(
    recoverCodeViewReferences(
      { image: fixtureImage('objc-cxx.dylib'), revision: 1 },
      createOperationContext(),
    ).state,
    'absent',
  );
});
