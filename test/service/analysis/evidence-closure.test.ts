import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createOperationContext,
  newIdentity,
  OperationError,
  type Evidence,
  type ProjectStore,
} from '../../../src/core/index.js';
import { closeEvidence } from '../../../src/service/analysis/catalog.js';
import { assertEvidenceClosed } from '../../support/evidence.js';

const image = `image_${'7'.repeat(64)}`;
function proof(
  id: string,
  parents: { derived_from?: string[]; conflicts_with?: string[]; revision?: number } = {},
): Evidence {
  return {
    id,
    origin: {
      kind: 'binary',
      range: { start: { image_id: image, space: 'va', value: 0x1000n }, size: 4n },
      description: 'closure test',
    },
    claim: `claim ${id}`,
    derived_from: parents.derived_from ?? [],
    conflicts_with: parents.conflicts_with ?? [],
    revision: parents.revision ?? 1,
  } as Evidence;
}
/** Durable store stand-in: only the revision-bounded proof read that closeEvidence uses. */
function durable(...proofs: Evidence[]): Pick<ProjectStore, 'readEvidence'> & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readEvidence: (ids: readonly string[]) => {
      reads.push(...ids);
      return proofs.filter((candidate) => ids.includes(candidate.id));
    },
  };
}
const [a, b, c, d] = [1, 2, 3, 4].map(() => newIdentity('evidence'));
const unavailable = (error: unknown) =>
  error instanceof OperationError &&
  error.diagnostic.code === 'internal_error' &&
  error.diagnostic.message.includes('dependency is unavailable');

test('closeEvidence returns the id-sorted dependency and conflict closure, reading only missing proofs from the store', () => {
  const root = proof(a!, { derived_from: [b!], conflicts_with: [c!] });
  const store = durable(proof(c!, { derived_from: [d!] }), proof(d!));
  const closed = closeEvidence(store, 5, [a!, a!], [root, proof(b!)], createOperationContext());
  assert.deepEqual(
    closed.map((item) => item.id),
    [a!, b!, c!, d!].sort((x, y) => x.localeCompare(y)),
  );
  assert.deepEqual(store.reads, [c!, d!]);
});

test('closeEvidence rejects a missing dependency instead of omitting it', () => {
  const root = proof(a!, { derived_from: [b!] });
  assert.throws(
    () => closeEvidence(durable(), 5, [a!], [root], createOperationContext()),
    unavailable,
  );
  assert.throws(() => closeEvidence(durable(), 5, [d!], [], createOperationContext()), unavailable);
});

test('closeEvidence rejects proofs from a future revision', () => {
  const future = proof(b!, { revision: 6 });
  assert.throws(
    () =>
      closeEvidence(
        durable(),
        5,
        [a!],
        [proof(a!, { derived_from: [b!] }), future],
        createOperationContext(),
      ),
    unavailable,
  );
  assert.throws(
    () => closeEvidence(durable(future), 5, [b!], [], createOperationContext()),
    unavailable,
  );
  // The same proof is admitted once the requested revision covers it.
  assert.equal(closeEvidence(durable(future), 6, [b!], [], createOperationContext()).length, 1);
});

test('closeEvidence bounds the closure at 10,000 proofs', () => {
  const linear = (length: number): Evidence[] => {
    const ids = Array.from({ length }, () => newIdentity('evidence'));
    return ids.map((id, index) =>
      proof(id, index + 1 < length ? { derived_from: [ids[index + 1]!] } : {}),
    );
  };
  const close = (proofs: Evidence[]): Evidence[] =>
    closeEvidence(
      durable(),
      5,
      [proofs[0]!.id],
      proofs,
      createOperationContext({ budget: { work: 100_000_000 } }),
    );
  assert.equal(close(linear(10_000)).length, 10_000);
  assert.throws(
    () => close(linear(10_001)),
    (error: unknown) =>
      error instanceof OperationError &&
      error.diagnostic.code === 'resource_limit' &&
      error.diagnostic.message.includes('closure exceeds the catalog bound'),
  );
});

test('assertEvidenceClosed accepts closed results and reports each unpublished citation', () => {
  const root = proof(a!, { derived_from: [b!] });
  const closed = { evidence: [root, proof(b!)], diagnostics: [{ evidence_ids: [a!] }] };
  assertEvidenceClosed(closed);
  assert.throws(() => assertEvidenceClosed({ ...closed, evidence: [root] }), /unpublished proof/);
  assert.throws(
    () => assertEvidenceClosed({ ...closed, diagnostics: [{ evidence_ids: [c!] }] }),
    /diagnostic 0 cites unpublished proof/,
  );
});
