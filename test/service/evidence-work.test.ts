import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, entityIdentity, fingerprint } from '../../src/core/index.js';
import { integer } from '../../src/ir/index.js';
import type { Expression, Value } from '../../src/ir/index.js';
import { emissionEvidenceReferences, evidenceReferences } from '../../src/service/analysis/catalog.js';
import { sourceDataValues } from '../../src/reconstruction/source-data.js';
import { image, slice } from '../ir/support.js';

test('evidence closure visits each shared immutable subgraph once without losing proof IDs', () => {
  const first = `evidence_${fingerprint('first')}`, second = `evidence_${fingerprint('second')}`;
  const shared = { evidence_ids: [first], child: { contract_evidence: [second] } };
  const input = Array.from({ length: 1000 }, () => shared);
  const context = createOperationContext({ budget: { work: 20 } });
  assert.deepEqual([...evidenceReferences(input, context)].sort(), [first, second].sort());
  const roleShared = [first, second];
  assert.deepEqual([...evidenceReferences({
    instruction_ids: roleShared, evidence_ids: roleShared, contract_evidence: roleShared,
  }, createOperationContext())].sort(), roleShared.sort());
  // No cross-call cache: a later independent observation sees its own contents.
  shared.evidence_ids.push(second);
  assert.deepEqual([...evidenceReferences(shared, createOperationContext())].sort(), [first, second].sort());
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => evidenceReferences(input, createOperationContext({ signal: controller.signal })), { code: 'cancelled' });
});

test('source-data mapping memo retains exact and negative observations with cancellation on hits', () => {
  const controller = new AbortController();
  const context = createOperationContext({ signal: controller.signal, budget: { work: 8 } });
  const known: Value = { id: entityIdentity(slice, 'value', 'known-address'), type: integer(64) };
  const unknown: Value = { id: entityIdentity(slice, 'value', 'unknown-address'), type: integer(64) };
  const expressions = new Map<string, Expression>([[known.id, { kind: 'constant', bits: 4096n }]]);
  const address = { address: { image_id: image, space: 'va' as const, value: 4096n }, name: 'data' };
  const lookup = sourceDataValues(expressions, [address], context);
  for (let index = 0; index < 1000; index++) {
    assert.equal(lookup(known), address);
    assert.equal(lookup(unknown), undefined);
  }
  controller.abort();
  assert.throws(() => lookup(known), { code: 'cancelled' });
});

test('typed emission closure reads the cited evidence table without scanning semantic IDs', () => {
  const proofs = ['mapping', 'inference', 'requirement', 'site'].map((name) =>
    `evidence_${fingerprint(name)}`);
  const unrelated = Array<string>(20_000).fill(entityIdentity(slice, 'value', 'unrelated'));
  // Every record cites proofs by index; the table states each cited proof once.
  const emission = { ids: unrelated, evidence: proofs };
  assert.deepEqual([...emissionEvidenceReferences(emission,
    createOperationContext({ budget: { work: 8 } }))].sort(), [...proofs].sort());
  assert.deepEqual([...emissionEvidenceReferences(emission, createOperationContext())].sort(),
    [...evidenceReferences({ evidence_ids: proofs }, createOperationContext())].sort());
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => emissionEvidenceReferences(emission,
    createOperationContext({ signal: controller.signal })), { code: 'cancelled' });
  assert.throws(() => emissionEvidenceReferences(emission, createOperationContext(),
    new Set(Array.from({ length: 10_000 }, (_, index) => `evidence_${fingerprint(index)}`))),
    { code: 'resource_limit' });
});
