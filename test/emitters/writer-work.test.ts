import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, entityIdentity, fingerprint } from '../../src/core/index.js';
import { Writer } from '../../src/emitters/writer.js';
import type { Origin } from '../../src/ir/index.js';
import { image, slice } from '../ir/support.js';

test('mapping metadata reuses immutable provenance without losing references or bounds', () => {
  const controller = new AbortController();
  const context = createOperationContext({ signal: controller.signal,
    budget: { work: 5000, output_bytes: 4 * 1024 * 1024 } });
  const instructions = Object.freeze(Array.from({ length: 64 }, (_, index) =>
    entityIdentity(slice, 'instruction', index)));
  const evidence = Object.freeze([`evidence_${fingerprint('mapping-proof')}`]);
  const ranges = Object.freeze([{ start: { image_id: image, space: 'va' as const, value: 4096n }, size: 4n }]);
  const origin: Origin = { id: entityIdentity(slice, 'statement', 'mapped'),
    provenance: { instruction_ids: instructions, evidence_ids: evidence, ranges, synthetic: [] } };
  const subject = entityIdentity(slice, 'value', 'subject');
  const writer = new Writer(context, 2, true);
  writer.line(0, 'return 42;');
  for (let index = 0; index < 500; index++) writer.map(origin, 0, [subject]);
  assert.equal(writer.mappings.length, 500);
  assert.deepEqual(writer.ids.items, [origin.id, subject, ...instructions], 'each identity is stated once');
  assert.deepEqual(writer.proofs.items, evidence);
  assert.deepEqual(writer.ranges.items, ranges);
  for (const mapping of writer.mappings) {
    assert.deepEqual(mapping.instruction_refs.map((ref) => writer.ids.items[ref]), instructions);
    assert.deepEqual(mapping.evidence_refs.map((ref) => writer.proofs.items[ref]), evidence);
    assert.deepEqual(mapping.semantic_refs.map((ref) => writer.ids.items[ref]), [origin.id, subject]);
    assert.deepEqual(mapping.range_refs.map((ref) => writer.ranges.items[ref]), ranges);
    assert.equal(mapping.start, 0);
    assert.equal(mapping.end, writer.offset);
  }
  controller.abort();
  assert.throws(() => writer.map(origin, 0, [subject]), { code: 'cancelled' });
});

test('prepared mapping references preserve ordered proof subjects and become immutable', () => {
  const context = createOperationContext({ budget: { work: 1000, output_bytes: 100_000 } });
  const writer = new Writer(context, 2, true);
  const origin: Origin = { id: entityIdentity(slice, 'statement', 'prepared'),
    provenance: { instruction_ids: [], evidence_ids: [], ranges: [], synthetic: [] } };
  const ids = [origin.id, entityIdentity(slice, 'value', 'first'),
    entityIdentity(slice, 'type', 'typed'), entityIdentity(slice, 'value', 'last')];
  const references = writer.references();
  for (const id of [ids[0]!, ids[1]!, ids[1]!, ids[2]!, ids[3]!, ids[0]!]) references.add(id);
  writer.line(0, 'return 42;');
  writer.map(origin, 0, references);
  assert.deepEqual(writer.mappings[0]!.semantic_refs.map((ref) => writer.ids.items[ref]), ids);
  assert.ok(Object.isFrozen(writer.mappings[0]!.semantic_refs));
  assert.throws(() => references.add(entityIdentity(slice, 'value', 'late')), TypeError);
  const wrongOwner = new Writer(context, 2, true);
  assert.throws(() => wrongOwner.map(origin, 0, references, [], 1), TypeError);
  const wrongOrigin = writer.references();
  wrongOrigin.add(ids[1]!);
  assert.throws(() => writer.map(origin, 0, wrongOrigin), TypeError);
});
