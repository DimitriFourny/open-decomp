import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalIdentity,
  contentHash,
  imageIdentity,
  sliceIdentity,
  entityIdentity,
  newIdentity,
  fingerprint,
  encodeCursor,
  decodeCursor,
  CursorError,
} from '../../src/core/identity.js';
import {
  evidenceSchema,
  projectIdSchema,
  targetSchema,
  coverageSchema,
  addressSchema,
} from '../../src/core/primitives.js';
import {
  encodeEvidence,
  decodeEvidence,
  assertRevision,
  nextRevision,
  RevisionConflict,
  cacheIdentityKey,
} from '../../src/core/validation.js';

const project = `project_${'1'.repeat(64)}`;
const image = imageIdentity(contentHash(new Uint8Array([1, 2, 3])));
const slice = sliceIdentity(image, 0x100n, 0x200n, 'arm64');
const entity = entityIdentity(slice, 'function', { entry: 0x20000000000001n, generation: 0 });
const evidenceId = `evidence_${'2'.repeat(64)}`;

test('content, slice and entity identities are deterministic and names are not identity', () => {
  assert.equal(image, imageIdentity(contentHash(new Uint8Array([1, 2, 3]))));
  assert.notEqual(image, imageIdentity(contentHash(new Uint8Array([1, 2, 4]))));
  assert.notEqual(slice, sliceIdentity(image, 0x200n, 0x200n, 'arm64'));
  assert.equal(
    entity,
    entityIdentity(slice, 'function', { generation: 0, entry: 0x20000000000001n }),
  );
  assert.notEqual(
    entity,
    entityIdentity(slice, 'function', { generation: 1, entry: 0x20000000000001n }),
  );
  assert.notEqual(fingerprint(1n), fingerprint('0x1'));
  assert.notEqual(fingerprint(1n), fingerprint(1));
  assert.throws(() => canonicalIdentity(Number.MAX_SAFE_INTEGER + 1));
  assert.equal(projectIdSchema.safeParse(newIdentity('project')).success, true);
  assert.throws(() => sliceIdentity(image, -1n, 1n, 'arm64'));
});

test('continuations bind revision, project, operation and normalized query', () => {
  const binding = {
    project_id: project,
    revision: 7,
    operation: 'symbols_find',
    query_hash: fingerprint({ text: 'main', match: 'contains' }),
  };
  const cursor = { ...binding, version: 1 as const, after: ['0x20000000000001', entity] };
  const token = encodeCursor(cursor);
  assert.deepEqual(decodeCursor(token, binding), cursor);
  for (const incompatible of [
    { ...binding, revision: 8 },
    { ...binding, project_id: `project_${'3'.repeat(64)}` },
    { ...binding, operation: 'functions_find' },
    { ...binding, query_hash: fingerprint({ text: 'other' }) },
  ])
    assert.throws(
      () => decodeCursor(token, incompatible),
      (error: unknown) => error instanceof CursorError && error.code === 'stale_cursor',
    );
  for (const malformed of [
    '!',
    '',
    `${token}=`,
    Buffer.from('{"version":2}').toString('base64url'),
    'a'.repeat(16385),
  ]) {
    assert.throws(
      () => decodeCursor(malformed, binding),
      (error: unknown) => error instanceof CursorError && error.code === 'invalid_cursor',
    );
  }
});

test('evidence preserves origin, conflicts and full-width binary locations', () => {
  const wire = evidenceSchema.parse({
    id: evidenceId,
    origin: {
      kind: 'binary',
      range: { start: { image_id: image, space: 'va', value: '0xfffffffffffffff0' }, size: '0x10' },
      description: 'export record',
    },
    claim: 'exported entry',
    derived_from: [],
    conflicts_with: [],
    revision: 0,
  });
  const internal = decodeEvidence(wire);
  assert.equal(internal.origin.kind, 'binary');
  if (internal.origin.kind === 'binary')
    assert.equal(internal.origin.range.start.value, 0xfffffffffffffff0n);
  assert.deepEqual(encodeEvidence(internal), wire);
  const assertion = {
    ...wire,
    origin: { kind: 'assertion', author: 'investigator', agent: 'llm', status: 'hypothesis' },
    conflicts_with: [`evidence_${'4'.repeat(64)}`],
  };
  assert.equal(evidenceSchema.safeParse(assertion).success, true);
  assert.equal(evidenceSchema.safeParse({ ...assertion, confidence: 0.99 }).success, false);
  assert.equal(evidenceSchema.safeParse({ ...wire, derived_from: [evidenceId] }).success, false);
  assert.equal(
    evidenceSchema.safeParse({ ...wire, origin: { kind: 'binary', author: 'LLM' } }).success,
    false,
  );
  assert.equal(addressSchema.safeParse({ image_id: image, space: 'va', value: 42 }).success, false);
});

test('revisions and per-layer coverage cannot imply unsupported semantics succeeded', () => {
  assert.doesNotThrow(() => assertRevision(7, 7));
  assert.throws(() => assertRevision(7, 8), RevisionConflict);
  assert.equal(nextRevision(7), 8);
  assert.throws(() => nextRevision(Number.MAX_SAFE_INTEGER));
  assert.equal(
    coverageSchema.parse({
      layer: 'decode',
      state: 'complete',
      completed_units: 10,
      total_units: 10,
      reasons: [],
    }).state,
    'complete',
  );
  assert.equal(
    coverageSchema.parse({
      layer: 'lift',
      state: 'unsupported',
      completed_units: 0,
      total_units: 10,
      reasons: ['unavailable instruction semantics'],
    }).state,
    'unsupported',
  );
  assert.equal(
    coverageSchema.safeParse({
      layer: 'lift',
      state: 'complete',
      completed_units: 11,
      total_units: 10,
      reasons: [],
    }).success,
    false,
  );
  assert.equal(
    targetSchema.safeParse({
      format: 'pe',
      architecture: 'arm64',
      abi: 'darwin-arm64',
      endian: 'little',
      address_bits: 64,
      features: [],
    }).success,
    false,
  );
  assert.equal(
    targetSchema.safeParse({
      format: 'elf',
      architecture: 'x86_64',
      abi: 'windows-x64',
      endian: 'little',
      address_bits: 64,
      features: [],
    }).success,
    false,
  );
});

test('cache keys include revisions, semantic policy, features and component versions', () => {
  const identity = {
    image_sha256: image.slice('image_'.length),
    slice_id: slice,
    function_id: entity,
    target: {
      format: 'macho' as const,
      architecture: 'arm64' as const,
      abi: 'darwin-arm64' as const,
      endian: 'little' as const,
      address_bits: 64 as const,
      features: [],
    },
    versions: {
      backend: '1',
      loader: '1',
      decoder: '1',
      lifter: '1',
      analysis: '1',
      abi: '1',
      emitter: '1',
    },
    evidence_revision: 0,
    annotation_revision: 0,
    options: {},
    budget: {},
  };
  const key = cacheIdentityKey(identity);
  assert.equal(key, cacheIdentityKey({ ...identity }));
  assert.notEqual(key, cacheIdentityKey({ ...identity, annotation_revision: 1 }));
  assert.notEqual(key, cacheIdentityKey({ ...identity, evidence_revision: 1 }));
  assert.notEqual(
    key,
    cacheIdentityKey({ ...identity, versions: { ...identity.versions, lifter: '2' } }),
  );
  assert.notEqual(key, cacheIdentityKey({ ...identity, options: { indirect_targets: 'off' } }));
  assert.notEqual(
    key,
    cacheIdentityKey({ ...identity, target: { ...identity.target, features: ['pauth'] } }),
  );
});
