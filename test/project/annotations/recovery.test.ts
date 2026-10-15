import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash, createOperationContext, entityIdentity, newIdentity, type AbiProfile, type AnnotationEdit, type FunctionRecord, type LoadedImage } from '../../../src/core/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { WindowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../../src/analysis/types/index.js';
import { AnnotationService, createTrustedSemanticCatalog, type AnnotationSubject } from '../../../src/project/annotations/index.js';
import { SqliteProjectStore } from '../../../src/project/store/index.js';
import type { RegisterIR } from '../../../src/ir/index.js';
import { discover, lift, loadCorpus as loadDarwin } from '../../lifters/arm64/support.js';
import { loadCorpus as loadWindows } from '../../lifters/x86_64/helpers.js';

async function persistenceRecovery(t: TestContext, image: LoadedImage, fn: FunctionRecord, ir: RegisterIR, abi: AbiProfile): Promise<void> {
  const path = mkdtempSync(join(tmpdir(), 'open-decomp-annotation-recovery-'));
  const state = { store: SqliteProjectStore.open(path, 'create') };
  t.after(async () => { await state.store.close(); rmSync(path, { recursive: true, force: true }); });
  await state.store.importImage({ bytes: image.bytes, sha256: image.sha256, selected_slice_id: image.selected_slice_id });
  assert.equal(state.store.transaction(1, tx => {
    tx.putImage(image); tx.putRecord(image.id, 'function', fn);
    for (const proof of image.evidence) tx.putEvidence(proof);
  }).state, 'committed');
  const construction = constructSSA(ir); assert.equal(construction.state, 'complete');
  if (construction.value.form !== 'ssa') throw new Error('Expected actual lifted SSA');
  const program = construction.value, original = structuredClone(program);
  const options = { image_id: image.id, slice_id: image.selected_slice_id, revision: 2 };
  const baseline = recoverTypes(program, abi, createOperationContext(), options);
  assert.equal(baseline.state, 'complete');
  const subject = baseline.associations.find(association => association.machine_type?.kind === 'integer' && association.machine_type.bits === 64 && baseline.subjects.includes(association.subject_id))!.subject_id;
  const descriptors: AnnotationSubject[] = baseline.subjects.map(id => ({ id, kind: id === program.id ? 'function' : 'value', image_id: image.id, slice_id: image.selected_slice_id, abi: abi.id }));
  const catalog = createTrustedSemanticCatalog(state.store, 2, { subjects: descriptors, types: baseline.types, evidence: baseline.evidence }, createOperationContext());
  const signed = entityIdentity(image.selected_slice_id, 'annotation-type', 'signed64'), float = entityIdentity(image.selected_slice_id, 'annotation-type', 'float64');
  const signedId = newIdentity('annotation'), floatId = newIdentity('annotation'), signatureId = newIdentity('annotation'), nameId = newIdentity('annotation');
  const edits: AnnotationEdit[] = [
    { operation: 'set', id: signedId, entity_id: subject, value: { kind: 'type', type_id: signed, definition: { kind: 'integer', bits: 64, signed: true } }, status: 'asserted', evidence_ids: [] },
    { operation: 'set', id: floatId, entity_id: subject, value: { kind: 'type', type_id: float, definition: { kind: 'float', bits: 64 } }, status: 'asserted', evidence_ids: [] },
    { operation: 'set', id: signatureId, entity_id: program.id, value: { kind: 'signature', value: { abi: abi.id, return_type: signed, parameters: [], variadic: false, noreturn: false, evidence_ids: [] } }, status: 'hypothesis', evidence_ids: [] },
    { operation: 'set', id: nameId, entity_id: program.id, value: { kind: 'name', value: 'struct HugeObject *' }, status: 'asserted', evidence_ids: [] },
  ];
  const applied = new AnnotationService(state.store).apply({ expected_revision: 2, author: 'fixture-analyst', origin: 'llm', edits }, createOperationContext(), catalog);
  assert.equal(applied.state, 'committed'); if (applied.state !== 'committed') throw new Error('Expected annotation commit');
  assert.equal(applied.revision, 3); assert.equal(applied.invalidate_before_revision, 3); assert.equal(applied.annotations.length, 4);
  const persisted = state.store.queryAnnotations({ revision: 3, limit: 10 }).items;
  await state.store.close(); state.store = SqliteProjectStore.open(path, 'resume');
  assert.deepEqual(state.store.queryAnnotations({ revision: 3, limit: 10 }).items, persisted);
  const service = new AnnotationService(state.store), view = service.active(3, createOperationContext(), { entity_ids: baseline.subjects });
  const asserted = recoverTypes(program, abi, createOperationContext(), { ...options, revision: 3, annotations: view.annotations, types: view.types });
  assert.equal(asserted.state, 'complete');
  assert.ok(asserted.associations.some(association => association.subject_id === subject && association.type_id === signed && association.source === 'llm'));
  assert.ok(asserted.associations.some(association => association.subject_id === subject && association.type_id === float && association.source === 'llm'));
  const alternatives = asserted.associations.filter(association => association.subject_id === subject && (association.type_id === signed || association.type_id === float));
  assert.ok(asserted.conflicts.some(conflict => conflict.subject_id === subject && alternatives.every(association => conflict.alternatives.includes(association.id))));
  assert.equal(asserted.signatures.find(signature => signature.id === signatureId)!.status, 'hypothesis');
  assert.equal(state.store.readType(signed, 3), null); assert.equal(state.store.readType(float, 3), null); assert.equal(state.store.readSignature(program.id, 3), null);
  const changed = service.apply({ expected_revision: 3, author: 'reviewer', origin: 'user', edits: [{ operation: 'retract', id: signedId }, { operation: 'remove', id: floatId }, { operation: 'remove', id: signatureId }] }, createOperationContext());
  assert.equal(changed.state, 'committed'); if (changed.state !== 'committed') throw new Error('Expected retraction commit');
  assert.equal(changed.revision, 4); assert.equal(changed.invalidate_before_revision, 4);
  const current = service.active(4, createOperationContext());
  assert.deepEqual(current.types, []); assert.deepEqual(current.annotations.map(annotation => annotation.id), [nameId]);
  const after = recoverTypes(program, abi, createOperationContext(), { ...options, revision: 4, annotations: current.annotations, types: current.types });
  assert.equal(after.state, 'complete'); assert.equal(after.associations.some(association => association.source === 'llm' || association.source === 'user'), false);
  assert.equal(after.signatures.some(signature => signature.id === signatureId), false);
  assert.equal(after.types.some(type => type.id === signed || type.id === float), false);
  assert.equal(state.store.readType(signed, 4), null); assert.equal(state.store.readSignature(program.id, 4), null);
  assert.deepEqual(program, original);
  assert.equal(contentHash(state.store.readImage(image.id).read(0n, image.bytes.length)), image.sha256);
  const historical = service.active(3, createOperationContext());
  assert.equal(historical.types.filter(type => type.id === signed || type.id === float).length, 2);
  assert.deepEqual(state.store.queryAnnotationHistory({ id: signedId, revision: 4, limit: 10 }).items.map(entry => [entry.operation, entry.actor]), [['set', { author: 'fixture-analyst', origin: 'llm' }], ['retract', { author: 'reviewer', origin: 'user' }]]);
  await state.store.close(); state.store = SqliteProjectStore.open(path, 'resume');
  assert.deepEqual(new AnnotationService(state.store).active(4, createOperationContext()), current);
}

test('actual Mach-O import, annotation reopen, recoverTypes conflict and retraction lose no source identity', async t => {
  const image = loadDarwin(), graph = discover(image).find(graph => graph.function.original_name === '_fixture_memory')!;
  await persistenceRecovery(t, image, graph.function, lift(graph).ir, new DarwinArm64Abi());
});

test('actual PE import, annotation reopen, recoverTypes conflict and removal leave no asserted fact tables', async t => {
  const corpus = loadWindows(), graph = corpus.graphs.find(graph => graph.function.entry.value === 0x180001070n)!;
  await persistenceRecovery(t, corpus.image, graph.function, corpus.lifted.get(graph.function.entry.value)!.ir, new WindowsX64Abi());
});
