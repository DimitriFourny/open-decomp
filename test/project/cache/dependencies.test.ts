import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LedgerHasher,
  createOperationContext,
  fingerprint,
  type CanonicalValue,
  type ProjectStore,
} from '../../../src/core/index.js';
import {
  createAnalysisReadset,
  type AnalysisDependencyCollector,
  type AnalysisReadset,
} from '../../../src/project/cache/dependencies.js';

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
