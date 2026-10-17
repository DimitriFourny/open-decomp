import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  cacheIdentitySchema, evidenceSchema, fingerprint, functionDecompileResultSchema,
  type CanonicalValue, type WireEvidence,
} from '../../src/core/index.js';
import { analysisReadsetSchema } from '../../src/project/cache/dependencies.js';

const payloadSchema = z.strictObject({
  format_version: z.literal(1), identity: cacheIdentitySchema,
  result: functionDecompileResultSchema,
  catalog: z.strictObject({ subjects: z.array(z.json()), types: z.array(z.json()), evidence: z.array(evidenceSchema) }),
  dependencies: analysisReadsetSchema.optional(),
});
export type IncrementalWirePayload = z.infer<typeof payloadSchema>;
export function parseIncrementalWirePayload(value: unknown): IncrementalWirePayload {
  const payload = payloadSchema.parse(value);
  assert.ok('data' in payload.result && payload.result.data.delivery === 'inline');
  assert.equal(payload.result.data.cache, 'computed');
  assert.equal(payload.result.artifacts.length, 0);
  assert.equal(payload.result.revision, payload.identity.annotation_revision);
  assert.equal(payload.identity.annotation_revision, payload.identity.evidence_revision);
  assert.equal(payload.result.data.function_id, payload.identity.function_id);
  assert.ok(payload.dependencies?.complete, 'Every measured publication must contain a complete dependency ledger');
  return payload;
}
function plain(value: unknown): CanonicalValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(plain);
  assert.ok(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
  const result: { [key: string]: CanonicalValue } = {};
  for (const [key, item] of Object.entries(value)) if (item !== undefined) result[key] = plain(item);
  return result;
}

/** Compare ALL result/catalog fields, modulo proof IDs and their honest original
 * derivation revisions. Recomputed selected-local graph proofs include the new
 * revision in their IDs; validated reuse correctly retains the old proof revision.
 * Claims, origins/statuses, graph edges, diagnostics, unknowns, coverage, type/
 * subject IDs, emitted text, mappings and every structured inference stay checked.
 * Raw payloads and proof revisions remain retained separately, never rewritten. */
export function canonicalIncrementalComputation(payload: IncrementalWirePayload): CanonicalValue {
  const proofs = new Map<string, WireEvidence>();
  for (const proof of [...payload.catalog.evidence, ...payload.result.evidence]) {
    assert.ok(proof.revision <= payload.identity.annotation_revision);
    const previous = proofs.get(proof.id);
    if (previous) assert.deepEqual(previous, proof, 'Published proof identity is unambiguous');
    proofs.set(proof.id, proof);
  }
  const completed = new Map<string, CanonicalValue>(), pending = new Set<string>();
  function proofValue(id: string): CanonicalValue {
    const cached = completed.get(id);
    if (cached !== undefined) return cached;
    const proof = proofs.get(id);
    assert.ok(proof, `Full output references unavailable evidence ${id}`);
    assert.equal(pending.has(id), false, 'This declared oracle cannot establish alpha-equivalence for cyclic proof graphs; do not silently drop that case');
    pending.add(id);
    const value = { origin: plain(proof.origin), claim: proof.claim,
      derived_from: proof.derived_from.map((parent) => fingerprint(proofValue(parent))).sort(),
      conflicts_with: proof.conflicts_with.map((other) => fingerprint(proofValue(other))).sort() };
    pending.delete(id); completed.set(id, value);
    return value;
  }
  function normalize(value: unknown, field = ''): CanonicalValue {
    if (field === 'evidence_ids') {
      assert.ok(Array.isArray(value));
      return value.map((id) => { assert.equal(typeof id, 'string'); return fingerprint(proofValue(id)); }).sort();
    }
    if (Array.isArray(value)) return value.map((item) => normalize(item));
    if (value !== null && typeof value === 'object') {
      const result: { [key: string]: CanonicalValue } = {};
      for (const [key, item] of Object.entries(value)) if (item !== undefined) result[key] = normalize(item, key);
      return result;
    }
    return plain(value);
  }
  const orderedProofs = (records: readonly WireEvidence[]) => records.map((proof) => proofValue(proof.id))
    .sort((left, right) => fingerprint(left).localeCompare(fingerprint(right)));
  return normalize({
    identity: payload.identity,
    result: { ...payload.result, evidence: orderedProofs(payload.result.evidence) },
    catalog: { ...payload.catalog, evidence: orderedProofs(payload.catalog.evidence) },
    dependencies: payload.dependencies === undefined ? null : {
      ...payload.dependencies,
      reads: [...payload.dependencies.reads].sort((left, right) =>
        fingerprint(plain(left.selector)).localeCompare(fingerprint(plain(right.selector)))),
    },
  });
}
