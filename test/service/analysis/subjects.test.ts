import assert from 'node:assert/strict';
import test from 'node:test';
import { entityIdentity, newIdentity } from '../../../src/core/index.js';
import { project } from './support.js';

for (const fixture of ['macho-arm64-symbols', 'corpus-symbols.dll']) test(`${fixture}: real memory fields and source types retain distinct authorization kinds`, { timeout: 60000 }, async t => {
  const p = await project(t, fixture);
  const fn = p.functions.find(fn => fixture.startsWith('macho') ? fn.original_name === '_fixture_memory' : fn.entry.value === 0x180001070n); assert.ok(fn);
  const baseline = p.payload((await p.decompile(fn.id)).result);
  const field = baseline.catalog.subjects.find(subject => subject.kind === 'field'), type = baseline.catalog.subjects.find(subject => subject.kind === 'type');
  assert.ok(field); assert.ok(type);
  const invalid = await p.annotate([{ operation: 'set', id: newIdentity('annotation'), entity_id: field.id, value: { kind: 'signature', value: { abi: p.image.target.abi, return_type: type.id, parameters: [], variadic: false, noreturn: false, evidence_ids: [] } }, status: 'asserted', evidence_ids: [] }]);
  assert.equal(invalid.result.state, 'failed');
  if (invalid.result.state === 'failed') assert.equal(invalid.result.error.code, 'invalid_input');
  assert.equal(p.state.store.snapshot().revision, 2);
  const id = newIdentity('annotation'), declared = entityIdentity(p.image.selected_slice_id, 'field-test-type', field.id);
  const changed = await p.annotate([{ operation: 'set', id, entity_id: field.id, value: { kind: 'type', type_id: declared, definition: { kind: 'integer', bits: 64, signed: true } }, status: 'asserted', evidence_ids: [] }]);
  assert.equal(changed.result.state, 'complete');
  const current = p.payload((await p.decompile(fn.id)).result);
  assert.ok(current.catalog.types.some(type => type.id === declared && type.source === 'user'));
  assert.ok(current.result.data.emission.mappings.some(mapping => mapping.semantic_ids.includes(field.id) && mapping.evidence_ids.length));
  assert.equal(p.state.store.readType(declared, 3), null);
  assert.equal((await p.annotate([{ operation: 'remove', id }])).result.state, 'complete');
  const restored = p.payload((await p.decompile(fn.id)).result);
  assert.equal(restored.catalog.types.some(type => type.id === declared), false);
});

test('an exact published PE call accepts a local signature without turning the IAT slot into a call node', { timeout: 60000 }, async t => {
  const p = await project(t, 'pe-x86_64-symbols.exe'), fn = p.functions[0]!;
  const baseline = p.payload((await p.decompile(fn.id)).result), call = baseline.catalog.subjects.find(subject => subject.kind === 'call'); assert.ok(call);
  assert.equal(p.image.imports.some(imported => imported.id === call.id), false);
  assert.ok(baseline.catalog.subjects.some(subject => subject.kind === 'stack'), 'x86 return-address push exposes a real stack subject');
  const type = entityIdentity(p.image.selected_slice_id, 'call-test-return', call.id), id = newIdentity('annotation');
  const applied = await p.annotate([
    { operation: 'set', id: newIdentity('annotation'), entity_id: fn.id, value: { kind: 'type', type_id: type, definition: { kind: 'integer', bits: 32, signed: true } }, status: 'asserted', evidence_ids: [] },
    { operation: 'set', id, entity_id: call.id, value: { kind: 'signature', value: { abi: p.image.target.abi, return_type: type, parameters: [], variadic: false, noreturn: false, evidence_ids: [] } }, status: 'asserted', evidence_ids: [] },
  ]);
  assert.ok(applied.result.state === 'complete');
  const current = p.payload((await p.decompile(fn.id)).result);
  assert.equal(current.result.data.signature, null, 'a call-local signature is not the containing function signature');
  const proofs = new Map(current.result.evidence.map(proof => [proof.id, proof]));
  const pending = current.result.data.emission.mappings.filter(mapping => mapping.semantic_ids.includes(call.id)).flatMap(mapping => mapping.evidence_ids);
  const ancestry = new Set<string>();
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const proof = pending[cursor]!;
    if (ancestry.has(proof)) continue;
    ancestry.add(proof); pending.push(...(proofs.get(proof)?.derived_from ?? []));
  }
  assert.ok(applied.result.data.applied.find(annotation => annotation.id === id)!.evidence_ids.some(proof => ancestry.has(proof)));
  assert.equal(p.state.store.readSignature(call.id, 3), null);
});
