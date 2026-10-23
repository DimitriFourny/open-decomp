import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  entityIdentity,
  fingerprint,
  provenanceCoverage,
  type Evidence,
} from '../../src/core/index.js';
import { integer } from '../../src/ir/index.js';
import type { Expression, Value } from '../../src/ir/index.js';
import {
  boundedEvidence,
  emissionEvidenceReferences,
  evidenceReferences,
} from '../../src/service/analysis/catalog.js';
import { sourceDataValues } from '../../src/reconstruction/source-data.js';
import { image, slice } from '../ir/support.js';

test('evidence closure visits each shared immutable subgraph once without losing proof IDs', () => {
  const first = `evidence_${fingerprint('first')}`,
    second = `evidence_${fingerprint('second')}`;
  const shared = { evidence_ids: [first], child: { contract_evidence: [second] } };
  const input = Array.from({ length: 1000 }, () => shared);
  const context = createOperationContext({ budget: { work: 20 } });
  assert.deepEqual([...evidenceReferences(input, context)].sort(), [first, second].sort());
  const roleShared = [first, second];
  assert.deepEqual(
    [
      ...evidenceReferences(
        {
          instruction_ids: roleShared,
          evidence_ids: roleShared,
          contract_evidence: roleShared,
        },
        createOperationContext(),
      ),
    ].sort(),
    roleShared.sort(),
  );
  // No cross-call cache: a later independent observation sees its own contents.
  shared.evidence_ids.push(second);
  assert.deepEqual(
    [...evidenceReferences(shared, createOperationContext())].sort(),
    [first, second].sort(),
  );
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => evidenceReferences(input, createOperationContext({ signal: controller.signal })),
    { code: 'cancelled' },
  );
});

test('source-data mapping memo retains exact and negative observations with cancellation on hits', () => {
  const controller = new AbortController();
  const context = createOperationContext({ signal: controller.signal, budget: { work: 8 } });
  const known: Value = { id: entityIdentity(slice, 'value', 'known-address'), type: integer(64) };
  const unknown: Value = {
    id: entityIdentity(slice, 'value', 'unknown-address'),
    type: integer(64),
  };
  const expressions = new Map<string, Expression>([[known.id, { kind: 'constant', bits: 4096n }]]);
  const address = {
    address: { image_id: image, space: 'va' as const, value: 4096n },
    name: 'data',
  };
  const lookup = sourceDataValues(expressions, [address], context);
  for (let index = 0; index < 1000; index++) {
    assert.equal(lookup(known), address);
    assert.equal(lookup(unknown), undefined);
  }
  controller.abort();
  assert.throws(() => lookup(known), { code: 'cancelled' });
});

test('typed emission closure reads the cited evidence table without scanning semantic IDs', () => {
  const proofs = ['mapping', 'inference', 'requirement', 'site'].map(
    (name) => `evidence_${fingerprint(name)}`,
  );
  const unrelated = Array<string>(20_000).fill(entityIdentity(slice, 'value', 'unrelated'));
  // Every record cites proofs by index; the table states each cited proof once.
  const emission = { ids: unrelated, evidence: proofs };
  assert.deepEqual(
    [
      ...emissionEvidenceReferences(emission, createOperationContext({ budget: { work: 8 } })),
    ].sort(),
    [...proofs].sort(),
  );
  assert.deepEqual(
    [...emissionEvidenceReferences(emission, createOperationContext())].sort(),
    [...evidenceReferences({ evidence_ids: proofs }, createOperationContext())].sort(),
  );
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () =>
      emissionEvidenceReferences(emission, createOperationContext({ signal: controller.signal })),
    { code: 'cancelled' },
  );
  assert.throws(
    () =>
      emissionEvidenceReferences(
        emission,
        createOperationContext(),
        new Set(Array.from({ length: 10_000 }, (_, index) => `evidence_${fingerprint(index)}`)),
      ),
    { code: 'resource_limit' },
  );
});

test('more than 10,000 cited proofs publish a closed catalog within its bounds and count the omitted references', () => {
  const proof = (name: string, derived_from: string[] = []): Evidence => ({
    id: `evidence_${fingerprint(name)}`,
    origin: { kind: 'analysis', analyzer: 'open-decomp/test', version: '1', rule: 'catalog bound' },
    claim: name,
    derived_from,
    conflicts_with: [],
    revision: 1,
  });
  const base = proof('base');
  // Every type citation derives from the shared base proof: a closure, not a flat list.
  const cited = Array.from({ length: 12_000 }, (_, index) => proof(`cited-${index}`, [base.id]));
  const diagnostic = proof('diagnostic');
  const emissionProofs = Array.from({ length: 4 }, (_, index) => proof(`emission-${index}`));
  const available = [base, diagnostic, ...cited, ...emissionProofs];
  const types = Array.from({ length: 6 }, (_, index) => ({
    id: entityIdentity(slice, 'type', `bounded-${index}`),
    definition: { kind: 'integer' as const, bits: 32, signed: false },
    source: 'analysis' as const,
    status: 'established' as const,
    // The first type cites 2,000 proofs, past the 1,000 a stored catalog type holds.
    evidence_ids: cited.slice(index * 2000, (index + 1) * 2000).map((item) => item.id),
  }));
  const store = { readEvidence: (): Evidence[] => [] };
  const input = {
    store,
    revision: 1,
    available,
    context: createOperationContext(),
    types,
    optional: [],
    required: [{ evidence_ids: [diagnostic.id] }],
    emission: { evidence: emissionProofs.map((item) => item.id) },
  };
  // The unbounded path refuses the same references: the catalog bound is real.
  assert.throws(() => evidenceReferences([types, input.required], createOperationContext()), {
    code: 'resource_limit',
  });
  const bounded = boundedEvidence(input);
  const published = new Map(bounded.evidence.map((item) => [item.id, item]));
  assert.ok(published.size <= 10_000);
  assert.ok(published.has(diagnostic.id) && published.has(base.id));
  assert.equal(bounded.emission, true);
  for (const item of emissionProofs) assert.ok(published.has(item.id));
  // Closed: every published proof's dependencies are published.
  for (const item of bounded.evidence)
    for (const parent of [...item.derived_from, ...item.conflicts_with])
      assert.ok(published.has(parent));
  let kept = 0;
  for (const [index, record] of bounded.types.entries()) {
    assert.equal(record.id, types[index]!.id);
    assert.ok(record.evidence_ids.length <= 1000);
    // A kept citation is a prefix of the original citations and resolves.
    assert.deepEqual(
      record.evidence_ids,
      types[index]!.evidence_ids.slice(0, record.evidence_ids.length),
    );
    for (const id of record.evidence_ids) assert.ok(published.has(id));
    kept += record.evidence_ids.length;
  }
  assert.equal(bounded.omitted, 12_000 - kept);
  assert.ok(bounded.omitted > 2_000);
  // Deterministic: the same records give the same publication.
  assert.deepEqual(boundedEvidence({ ...input, context: createOperationContext() }), bounded);
  const coverage = provenanceCoverage([
    { kind: 'evidence', reason: 'output_limit', omitted: bounded.omitted },
  ]);
  assert.equal(coverage.state, 'partial');
  assert.deepEqual(coverage.reasons, [
    `output_limit: ${bounded.omitted} proof references omitted; the pseudocode text is complete`,
  ]);
  // Within the bounds nothing changes: the closure of every cited proof.
  const small = boundedEvidence({
    ...input,
    context: createOperationContext(),
    types: [{ ...types[1]!, evidence_ids: types[1]!.evidence_ids.slice(0, 10) }],
  });
  assert.equal(small.omitted, 0);
  assert.equal(small.evidence.length, 10 + 1 + 1 + emissionProofs.length);
});
