import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ImmutableBytes,
  LedgerHasher,
  contentHash,
  createOperationContext,
  fingerprint,
  globalDataIdentity,
  imageIdentity,
  sliceIdentity,
  type CanonicalValue,
  type ProjectStore,
} from '../../../src/core/index.js';
import {
  analysisReadsetSchema,
  createAnalysisReadset,
  decodeStoredReadset,
  encodeStoredReadset,
  validateAnalysisReadset,
  type AnalysisDependencyCollector,
  type AnalysisReadset,
} from '../../../src/project/cache/dependencies.js';
import { SqliteProjectStore } from '../../../src/project/store/index.js';

// Every read below carries its value, so the collector never touches the store.
const collector = (): AnalysisDependencyCollector =>
  createAnalysisReadset({} as ProjectStore, 1, createOperationContext());
const direct = (readset: AnalysisReadset): string =>
  fingerprint(readset as unknown as CanonicalValue);
const read = (collected: AnalysisDependencyCollector, index: number): void => {
  switch (index % 3) {
    case 0:
      collected.recordProof(`proof_${index}`, null);
      break;
    case 1:
      collected.recordType(`type_${index}`, null);
      break;
    default:
      collected.recordFunction('image_a', `function_${index}`, null);
  }
};

test('LedgerHasher equals the fingerprint of the ledger envelope at every length', () => {
  const hasher = new LedgerHasher();
  const reads: CanonicalValue[] = [];
  const envelope = () => ({ version: 1, complete: true, reads }) as CanonicalValue;
  assert.equal(hasher.fingerprint(), fingerprint(envelope()));
  for (let index = 0; index < 40; index++) {
    // Strings needing escapes, nested objects, bigints and nulls all go through canonicalIdentity.
    const element: CanonicalValue = {
      selector: { kind: 'proof', id: `a"b\\c\u2028${index}é` },
      fingerprint: index.toString(16).padStart(64, '0'),
      extra: [null, true, BigInt(index) << 70n, index],
    };
    hasher.append(element);
    reads.push(element);
    assert.equal(hasher.length, reads.length);
    assert.equal(hasher.fingerprint(), fingerprint(envelope()));
    // Reading a fingerprint does not disturb the running state.
    assert.equal(hasher.fingerprint(), fingerprint(envelope()));
  }
});

test('the incremental readset fingerprint equals fingerprint(readset) for a ledger grown in steps', () => {
  const collected = collector();
  let index = 0;
  for (const step of [1, 1, 2, 5, 3, 40, 1]) {
    for (let count = 0; count < step; count++) read(collected, index++);
    const readset = collected.finish();
    assert.equal(readset.reads.length, index);
    assert.equal(collected.readsetFingerprint(readset), direct(readset));
    // Asking again for the same snapshot, or re-reading known reads, changes nothing.
    assert.equal(collected.readsetFingerprint(readset), direct(readset));
    read(collected, 0);
    assert.equal(collected.finish().reads.length, index);
  }
});

test('an older snapshot of the same collector is still fingerprinted exactly', () => {
  const collected = collector();
  for (let index = 0; index < 4; index++) read(collected, index);
  const older = collected.finish();
  for (let index = 4; index < 9; index++) read(collected, index);
  const newer = collected.finish();
  assert.equal(collected.readsetFingerprint(newer), direct(newer));
  assert.equal(collected.readsetFingerprint(older), direct(older));
  assert.equal(collected.readsetFingerprint(newer), direct(newer));
  for (let index = 9; index < 12; index++) read(collected, index);
  const latest = collected.finish();
  assert.equal(collected.readsetFingerprint(latest), direct(latest));
});

test('the incremental readset fingerprint stays exact after replay and replayTrace', () => {
  const source = collector();
  const { trace } = source.traced(() => {
    for (let index = 0; index < 12; index++) read(source, index);
  });
  const sourceReadset = source.finish();

  // replayTrace applies a traced computation's reads, some already captured.
  const target = collector();
  for (let index = 6; index < 9; index++) read(target, index);
  assert.equal(target.readsetFingerprint(target.finish()), direct(target.finish()));
  target.replayTrace(trace);
  const afterTrace = target.finish();
  assert.equal(afterTrace.reads.length, 12);
  assert.equal(target.readsetFingerprint(afterTrace), direct(afterTrace));

  // replay of the collector's own snapshot and of a foreign readset it already captured.
  target.replay(afterTrace);
  target.replay(sourceReadset);
  for (let index = 12; index < 15; index++) read(target, index);
  const afterReplay = target.finish();
  assert.equal(afterReplay.reads.length, 15);
  assert.equal(target.readsetFingerprint(afterReplay), direct(afterReplay));

  // A trace replayed into a fresh collector builds the same ledger from nothing.
  const fresh = collector();
  fresh.replayTrace(trace);
  const freshReadset = fresh.finish();
  assert.deepEqual(freshReadset, sourceReadset);
  assert.equal(fresh.readsetFingerprint(freshReadset), source.readsetFingerprint(sourceReadset));
  assert.equal(fresh.readsetFingerprint(freshReadset), direct(sourceReadset));
});

test('foreign and empty readsets are hashed in full', () => {
  const owner = collector(),
    other = collector();
  for (let index = 0; index < 5; index++) read(owner, index);
  const readset = owner.finish();
  // Another collector's snapshot, and a structurally equal copy of this collector's own.
  assert.equal(other.readsetFingerprint(readset), direct(readset));
  assert.equal(owner.readsetFingerprint({ ...readset }), direct(readset));
  assert.equal(owner.readsetFingerprint(readset), direct(readset));
  // The empty ledger (the schema rejects it for finish(), so it can only be foreign).
  const empty = { version: 1, complete: true, reads: [] } as unknown as AnalysisReadset;
  assert.equal(owner.readsetFingerprint(empty), direct(empty));
  assert.equal(owner.readsetFingerprint(readset), direct(readset));
  assert.equal(collector().readsetFingerprint(empty), direct(empty));
});

test('a data entity window read is invalidated only by a registration inside the window', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'open-decomp-dependencies-'));
  const store = SqliteProjectStore.open(path, 'create');
  t.after(async () => {
    await store.close();
    rmSync(path, { recursive: true, force: true });
  });
  const raw = Uint8Array.of(0x90, 0xc3),
    sha256 = contentHash(raw),
    image_id = imageIdentity(sha256),
    slice_id = sliceIdentity(image_id, 0n, 2n, 'x86_64');
  await store.importImage({ bytes: new ImmutableBytes(raw), sha256, selected_slice_id: slice_id });
  const register = (value: bigint): void => {
    const address = { image_id, space: 'va' as const, value };
    const revision = store.snapshot().revision;
    assert.equal(
      store.transaction(revision, (tx) =>
        tx.registerDataEntity({
          id: globalDataIdentity(slice_id, address),
          image_id,
          slice_id,
          address,
        }),
      ).state,
      'committed',
    );
  };
  register(0x1000n);
  const context = createOperationContext(),
    revision = store.snapshot().revision;
  const collected = createAnalysisReadset(store, revision, context);
  assert.equal(
    collected.store.readDataEntities({ image_id, revision, start: 0x800n, end: 0x2000n }).length,
    1,
  );
  const readset = collected.finish();
  assert.ok(readset.reads.some((item) => item.selector.kind === 'data_entities'));
  register(0x2000n);
  assert.equal(validateAnalysisReadset(store, store.snapshot().revision, readset, context), true);
  register(0x1fffn);
  assert.equal(validateAnalysisReadset(store, store.snapshot().revision, readset, context), false);
});

test('a stored readset decodes to the same reads, in order, for every selector kind', () => {
  const image = imageIdentity('1'.repeat(64));
  const digest = (n: number): string => n.toString(16).padStart(64, '0');
  const readset = analysisReadsetSchema.parse({
    version: 1,
    complete: true,
    reads: [
      { selector: { kind: 'signature', id: 'entity_a' }, fingerprint: digest(1) },
      { selector: { kind: 'type', id: 'entity_b' }, fingerprint: digest(2) },
      { selector: { kind: 'proof', id: 'evidence_c' }, fingerprint: digest(1) },
      { selector: { kind: 'annotations', id: 'entity_d' }, fingerprint: digest(3) },
      { selector: { kind: 'annotations', id: 'entity_e' }, fingerprint: digest(3) },
      { selector: { kind: 'type_annotations', id: 'entity_f' }, fingerprint: digest(3) },
      { selector: { kind: 'all_annotations' }, fingerprint: digest(4) },
      {
        selector: { kind: 'record_scope', image_id: image, record_kind: 'reference' },
        fingerprint: digest(5),
      },
      { selector: { kind: 'function', image_id: image, id: 'entity_g' }, fingerprint: digest(6) },
      {
        selector: {
          kind: 'function_address',
          image_id: image,
          address: { image_id: image, space: 'va', value: '0x1000' },
        },
        fingerprint: digest(7),
      },
      {
        selector: { kind: 'data_entities', image_id: image, start: '0x10', end: null },
        fingerprint: digest(8),
      },
      {
        selector: { kind: 'data_entities', image_id: image, start: '0x10', end: '0x20' },
        fingerprint: digest(8),
      },
    ],
  });
  const stored = encodeStoredReadset(readset);
  // Each distinct fingerprint is kept once.
  assert.equal(stored.fingerprints.length, 8);
  assert.equal(stored.reads.length, readset.reads.length);
  const decoded = analysisReadsetSchema.parse(
    decodeStoredReadset(JSON.parse(JSON.stringify(stored))),
  );
  assert.deepEqual(decoded, readset);
  assert.equal(JSON.stringify(decoded), JSON.stringify(readset));
  assert.equal(direct(decoded), direct(readset));
});

test('a malformed stored readset is refused, never read as other selectors', () => {
  const stored = encodeStoredReadset(
    analysisReadsetSchema.parse({
      version: 1,
      complete: true,
      reads: [{ selector: { kind: 'proof', id: 'evidence_a' }, fingerprint: 'a'.repeat(64) }],
    }),
  );
  const decode = (value: unknown): unknown =>
    analysisReadsetSchema.parse(decodeStoredReadset(value));
  for (const reads of [
    [[2, 'evidence_a', 1]], // fingerprint index out of range
    [[2, 'evidence_a', -1]],
    [[2, 'evidence_a', 0.5]],
    [[10, 'evidence_a', 0]], // unknown kind code
    [[2, 'evidence_a']], // missing field
    [[2, 'evidence_a', 'x', 0]], // extra field
    [{ selector: { kind: 'proof', id: 'evidence_a' }, fingerprint: 'a'.repeat(64) }], // format 2
  ])
    assert.throws(() => decode({ ...stored, reads }));
  assert.throws(() => decode({ ...stored, extra: true }));
  assert.throws(() => decode({ ...stored, fingerprints: ['not a digest'] }));
  assert.throws(() =>
    encodeStoredReadset({
      version: 1,
      complete: true,
      reads: [
        {
          selector: { kind: 'proof', id: 'evidence_a', extra: 1 } as never,
          fingerprint: 'a'.repeat(64),
        },
      ],
    }),
  );
});

test('consecutive single-ID reads of one fingerprint are stored as one run and decode in order', () => {
  const digest = (n: number): string => n.toString(16).padStart(64, '0');
  const entity = (n: number): string => `entity_${(n * 7919).toString(16).padStart(64, 'a')}`;
  const reads = [
    ...Array.from({ length: 5 }, (_, n) => ({
      selector: { kind: 'annotations', id: entity(n) },
      fingerprint: digest(1),
    })),
    { selector: { kind: 'proof', id: `evidence_${'b'.repeat(64)}` }, fingerprint: digest(1) },
    { selector: { kind: 'proof', id: `evidence_${'c'.repeat(64)}` }, fingerprint: digest(1) },
    // Another fingerprint, a non-hex ID and another kind each break the run.
    { selector: { kind: 'annotations', id: entity(9) }, fingerprint: digest(2) },
    { selector: { kind: 'annotations', id: 'entity_short' }, fingerprint: digest(2) },
    { selector: { kind: 'annotations', id: entity(10) }, fingerprint: digest(2) },
    { selector: { kind: 'type', id: entity(10) }, fingerprint: digest(2) },
    { selector: { kind: 'annotations', id: entity(11) }, fingerprint: digest(2) },
  ];
  const readset = analysisReadsetSchema.parse({ version: 1, complete: true, reads });
  const stored = encodeStoredReadset(readset);
  assert.deepEqual(
    stored.reads.map((row) => row[0]),
    [-4, -3, -4, 3, -4, -2, -4],
  );
  const decoded = analysisReadsetSchema.parse(
    decodeStoredReadset(JSON.parse(JSON.stringify(stored))),
  );
  assert.deepEqual(decoded, readset);
  assert.equal(direct(decoded), direct(readset));
  const run = stored.reads[0]!;
  const decode = (rows: unknown[]): unknown =>
    analysisReadsetSchema.parse(decodeStoredReadset({ ...stored, reads: rows }));
  const ids = run[3] as string;
  for (const row of [
    [-4, 0, 'entity_', `${ids} `], // not the canonical encoding
    [-4, 0, 'entity_', ids.slice(0, 40)], // not whole digests
    [-4, 0, 'entity_', ''],
    [-4, 0, 'image_', ids], // not a packed prefix
    [-8, 0, 'entity_', ids], // a kind with more than an ID
    [-11, 0, 'entity_', ids],
    [-4, 9, 'entity_', ids],
    [-4, 0, 'entity_', ids, 0],
  ])
    assert.throws(() => decode([row]));
});
