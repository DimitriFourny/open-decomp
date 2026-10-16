import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_BUDGET, contentHash, createOperationContext, entityIdentity, newIdentity, toolSchemas,
  type AnnotationEdit, type CacheIdentity,
} from '../../../src/core/index.js';
import { Arm64Lifter } from '../../../src/lifters/arm64/index.js';
import { X86Lifter } from '../../../src/lifters/x86_64/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { WindowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { simplifySSA } from '../../../src/analysis/values/index.js';
import { loadFunctionGraph, loadFunctionScope } from '../../../src/service/queries/scope.js';
import { readAnnotationCatalog } from '../../../src/project/cache/index.js';
import { executeDecompilation } from '../../../src/service/analysis/index.js';
import { acceptsAnalysisIdentity, pipelineVersions } from '../../../src/service/analysis/versions.js';
import { execute } from '../../emitters/c/support.js';
import { loadImage, project } from './support.js';

for (const fixture of [
  { name: 'macho-arm64-symbols', address: 0x100000574n, arm: true },
  { name: 'macho-arm64-stripped', address: 0x100000574n, arm: true },
  { name: 'corpus-symbols.dll', address: 0x180001030n, arm: false },
  { name: 'corpus-stripped.dll', address: 0x180001030n, arm: false },
]) test(`${fixture.name}: complete pipeline preserves arithmetic, proof closure, current catalogs and annotation/retraction semantics`, { timeout: 60000 }, async t => {
  const p = await project(t, fixture.name), fn = p.functions.find(fn => fn.entry.value === fixture.address);
  assert.ok(fn);
  const before = await p.decompile(fn.id);
  const payload = p.payload(before.result), full = payload.result;
  assert.equal(full.state, 'complete');
  assert.equal(full.data.signature, null, 'machine register liveness never invents a source signature');
  assert.equal(p.state.store.readJob(before.job_id)?.state, 'completed');
  const proofIds = new Set(full.evidence.map(proof => proof.id));
  for (const proof of full.evidence) for (const parent of [...proof.derived_from, ...proof.conflicts_with]) assert.ok(proofIds.has(parent));
  for (const mapping of full.data.emission.mappings) for (const proof of mapping.evidence_ids) assert.ok(proofIds.has(proof));
  const scope = { store: p.state.store, context: createOperationContext() };
  const graph = loadFunctionGraph(scope, 2, loadFunctionScope(scope, 2, fn.id));
  const lifted = fixture.arm ? new Arm64Lifter().lift(graph, new DarwinArm64Abi(), scope.context) : new X86Lifter().lift(graph, new WindowsX64Abi(), scope.context);
  const constructed = constructSSA(lifted.ir); assert.equal(constructed.state, 'complete');
  assert.equal(constructed.value.form, 'ssa'); if (constructed.value.form !== 'ssa') assert.fail('Missing SSA');
  const ir = simplifySSA(constructed.value).value;
  const evaluate = (emission: Parameters<typeof execute>[0]): void => {
    for (const [a, b] of [[0n, 1n], [0xffffffffn, 3n], [123456789n, 987654321n]] as const) {
      const roots = new Map<string, bigint>(fixture.arm ? [['arm64:x0', a], ['arm64:x1', b], ['arm64:sp', 0x9000n]] : [['x86_64:rcx', a], ['x86_64:rdx', b], ['x86_64:rsp', 0x9000n]]);
      const inputs = new Map(ir.blocks.find(block => block.id === ir.entry)!.parameters.map(value => [value.id, 0n]));
      for (const binding of ir.register_states.find(state => state.block === ir.entry)!.entry) inputs.set(binding.value.id, BigInt.asUintN(binding.register.width_bits, (roots.get(binding.register.root) ?? 0n) >> BigInt(binding.register.offset_bits)));
      const memory = new Map<bigint, number>(); for (let i = 0; i < 8; i++) memory.set(0x9000n + BigInt(i), 0);
      const observed = execute(emission, inputs, memory, 0n, new Map([...roots].map(([root, bits]) => [root, { bits, known: 0xffffffffffffffffn }]))), result = observed.registers.get(fixture.arm ? 'arm64:x0' : 'x86_64:rax');
      assert.equal(observed.exit, 'machine_return');
      if (result) assert.equal(BigInt.asUintN(32, result.known), 0xffffffffn);
      assert.equal(BigInt.asUintN(32, result?.bits ?? observed.values[0]!), BigInt.asUintN(32, a + 3n * b) ^ 0x55n);
      if (!fixture.arm && result) assert.equal(observed.registers.get('x86_64:rflags')!.known & 0x10n, 0n, 'architecturally undefined AF remains indeterminate without unsupported coverage');
    }
  };
  evaluate(full.data.emission);
  for (const instruction of graph.instructions) assert.ok(full.data.emission.mappings.some(mapping => mapping.instruction_ids.includes(instruction.id)));
  const python = await p.decompile(fn.id, { options: { emitter: 'python-like' } });
  const pythonFull = p.payload(python.result).result;
  assert.ok('data' in python.result); assert.equal(python.result.data.cache, 'computed');
  assert.equal(pythonFull.data.emission.language, 'python-like');
  assert.equal(pythonFull.data.emission.reconstruction, 'pseudocode');
  assert.notEqual(pythonFull.versions.emitter, full.versions.emitter);
  assert.notEqual(python.result.artifacts[0]!.id, before.result.artifacts[0]!.id);
  evaluate(pythonFull.data.emission);
  for (const instruction of graph.instructions) assert.ok(pythonFull.data.emission.mappings.some(mapping => mapping.instruction_ids.includes(instruction.id)));
  for (const mapping of pythonFull.data.emission.mappings) {
    assert.ok(mapping.start >= 0 && mapping.end > mapping.start && mapping.end <= pythonFull.data.emission.text.length);
    assert.equal(pythonFull.data.emission.text[mapping.end - 1], '\n');
  }
  const restyled = await p.decompile(fn.id, { options: { emitter: 'python-like', include_evidence: false, indent: 8 } });
  const restyledFull = p.payload(restyled.result).result;
  assert.ok('data' in restyled.result); assert.equal(restyled.result.data.cache, 'computed');
  assert.notEqual(restyled.result.artifacts[0]!.id, python.result.artifacts[0]!.id);
  assert.ok(restyledFull.data.emission.mappings.every(mapping => mapping.evidence_ids.length === 0));
  evaluate(restyledFull.data.emission);
  const repeated = await p.decompile(fn.id, {}, 29000);
  assert.ok('data' in repeated.result); assert.equal(repeated.result.data.cache, 'hit');
  assert.deepEqual(repeated.result.artifacts, before.result.artifacts);
  assert.deepEqual(repeated.result.budget, before.args.budget, 'queue time must not change identity or echoed request budget');
  await p.reopen();
  const pythonHit = await p.decompile(fn.id, { options: { emitter: 'python-like' } });
  assert.ok('data' in pythonHit.result); assert.equal(pythonHit.result.data.cache, 'hit');
  assert.deepEqual(pythonHit.result.artifacts, python.result.artifacts);
  const identity: CacheIdentity = {
    image_sha256: p.image.sha256, slice_id: p.image.selected_slice_id, target: p.image.target,
    function_id: fn.id, evidence_revision: 2, annotation_revision: 2, budget: python.args.budget,
    options: python.args.options, versions: pythonFull.versions,
  };
  assert.equal(acceptsAnalysisIdentity(identity), true);
  assert.equal(acceptsAnalysisIdentity({ ...identity, versions: full.versions }), false);
  assert.equal(acceptsAnalysisIdentity({ ...identity, options: before.args.options }), false);
  assert.strictEqual(pipelineVersions(p.image.target, 'python-like'), pipelineVersions({ ...p.image.target }, 'python-like'));
  assert.ok(Object.isFrozen(pipelineVersions(p.image.target, 'python-like')));
  for (const component of Object.keys(identity.versions) as (keyof CacheIdentity['versions'])[]) {
    assert.equal(acceptsAnalysisIdentity({ ...identity, versions: { ...identity.versions, [component]: 'stale-component' } }), false);
  }
  for (const target of [
    { ...p.image.target, abi: fixture.arm ? 'windows-x64' as const : 'darwin-arm64' as const },
    { ...p.image.target, format: fixture.arm ? 'pe' as const : 'macho' as const },
    { ...p.image.target, architecture: fixture.arm ? 'x86_64' as const : 'arm64' as const },
  ]) {
    assert.equal(acceptsAnalysisIdentity({ ...identity, target }), false);
    assert.throws(() => pipelineVersions(target, 'python-like'), { code: 'unsupported_target' });
  }
  const subject = payload.catalog.subjects.find(subject => subject.kind === 'value'); assert.ok(subject);
  const catalog = await readAnnotationCatalog(p.state.store, 2, [subject.id], createOperationContext(), acceptsAnalysisIdentity);
  assert.equal(catalog?.subject(subject.id)?.kind, 'value');
  const typeId = entityIdentity(p.image.selected_slice_id, 'pipeline-test-type', fn.id);
  const ids = { type: newIdentity('annotation'), signature: newIdentity('annotation'), name: newIdentity('annotation'), note: newIdentity('annotation') };
  const edits: AnnotationEdit[] = [
    { operation: 'set', id: ids.type, entity_id: subject.id, value: { kind: 'type', type_id: typeId, definition: { kind: 'integer', bits: 32, signed: false } }, status: 'asserted', evidence_ids: [] },
    { operation: 'set', id: ids.signature, entity_id: fn.id, value: { kind: 'signature', value: { abi: p.image.target.abi, return_type: typeId, parameters: ['a', 'b'].map(name => ({ id: entityIdentity(p.image.selected_slice_id, 'pipeline-test-parameter', [fn.id, name]), name, type_id: typeId })), variadic: false, noreturn: false, evidence_ids: [] } }, status: 'asserted', evidence_ids: [] },
    { operation: 'set', id: ids.name, entity_id: fn.id, value: { kind: 'name', value: 'reviewed_arithmetic' }, status: 'asserted', evidence_ids: [] },
    { operation: 'set', id: ids.note, entity_id: fn.id, value: { kind: 'note', value: 'Independent formula: (a + 3*b) xor 0x55' }, status: 'asserted', evidence_ids: [] },
  ];
  const annotated = await p.annotate(edits);
  assert.equal(annotated.result.state, 'complete'); assert.equal(annotated.result.revision, 3);
  assert.equal(p.state.store.readJob(annotated.job_id)?.state, 'completed');
  assert.equal(p.state.store.readJob(annotated.job_id)?.published_revision, null);
  assert.ok(annotated.result.evidence.length >= edits.length);
  assert.equal(p.state.store.readType(typeId, 3), null); assert.equal(p.state.store.readSignature(fn.id, 3), null);
  const staleDerived = await p.annotate([{ operation: 'set', id: newIdentity('annotation'), entity_id: subject.id, value: { kind: 'note', value: 'Requires current analysis' }, status: 'asserted', evidence_ids: [] }]);
  assert.equal(staleDerived.result.state, 'failed'); assert.equal(p.state.store.snapshot().revision, 3);
  const changed = await p.decompile(fn.id), changedPayload = p.payload(changed.result);
  assert.notEqual(changed.result.artifacts[0]!.id, before.result.artifacts[0]!.id);
  assert.equal(changedPayload.result.data.signature?.return_type, typeId);
  assert.equal(changedPayload.result.data.signature?.parameters.length, 2);
  assert.ok(changedPayload.catalog.types.some(type => type.id === typeId && type.source === 'user'));
  assert.ok(changedPayload.result.data.emission.mappings.some(mapping => mapping.semantic_ids.includes(fn.id) && mapping.evidence_ids.some(id => annotated.result.evidence.some(proof => proof.id === id))));
  evaluate(changedPayload.result.data.emission);
  const pythonChanged = await p.decompile(fn.id, { options: { emitter: 'python-like' } });
  const pythonChangedFull = p.payload(pythonChanged.result).result;
  assert.ok('data' in pythonChanged.result); assert.equal(pythonChanged.result.data.cache, 'computed');
  assert.notEqual(pythonChanged.result.artifacts[0]!.id, python.result.artifacts[0]!.id);
  assert.equal(pythonChangedFull.data.signature?.return_type, typeId);
  assert.ok(pythonChangedFull.data.emission.mappings.some(mapping => mapping.semantic_ids.includes(fn.id) && mapping.evidence_ids.some(id => annotated.result.evidence.some(proof => proof.id === id))));
  evaluate(pythonChangedFull.data.emission);
  const retracted = await p.annotate(Object.values(ids).map(id => ({ operation: 'retract' as const, id })));
  assert.equal(retracted.result.state, 'complete');
  const after = p.payload((await p.decompile(fn.id)).result);
  assert.equal(after.result.data.signature, null);
  assert.equal(after.catalog.types.some(type => type.id === typeId), false);
  assert.equal(after.result.data.emission.text, full.data.emission.text, 'retraction removes names, notes and source assertions, not machine semantics');
  evaluate(after.result.data.emission);
  const pythonAfter = await p.decompile(fn.id, { options: { emitter: 'python-like' } });
  assert.ok('data' in pythonAfter.result); assert.equal(pythonAfter.result.data.cache, 'computed');
  const pythonAfterFull = p.payload(pythonAfter.result).result;
  assert.equal(pythonAfterFull.data.signature, null);
  evaluate(pythonAfterFull.data.emission);
  assert.equal(contentHash(p.state.store.readImage(p.image.id).read(0n, p.image.bytes.length)), p.image.sha256);
  const history = p.state.store.queryAnnotationHistory({ id: ids.type, revision: 4, limit: 10 }).items;
  assert.deepEqual(history.map(entry => entry.operation), ['set', 'retract']);
  assert.ok(history.every(entry => entry.actor?.author === 'pipeline-regression'));
});

for (const fixture of [
  { name: 'macho-arm64-symbols', address: 0x100000574n, bytes: [0xbf, 0x3b, 0x03, 0xd5] },
  { name: 'corpus-symbols.dll', address: 0x180001030n, bytes: [0x0f, 0xa2] },
]) test(`${fixture.name}: unimplemented real instruction keeps an explicit mapped boundary and never publishes complete semantics`, { timeout: 60000 }, async t => {
  const raw = readFileSync(`fixtures/bin/${fixture.name}`), original = loadImage(raw);
  const translated = original.address_map.translate({ image_id: original.id, space: 'va', value: fixture.address }, 'file');
  assert.equal(translated.kind, 'mapped'); if (translated.kind !== 'mapped') assert.fail('Missing fixture instruction');
  raw.set(fixture.bytes, Number(translated.address.value));
  const p = await project(t, raw), fn = p.functions.find(fn => fn.entry.value === fixture.address); assert.ok(fn);
  for (const emitter of ['c-like', 'python-like'] as const) {
  const first = await p.decompile(fn.id, { options: { emitter } }), full = p.payload(first.result).result;
  assert.equal(full.state, 'partial');
  assert.equal(full.coverage.find(item => item.layer === 'decode')?.state, 'complete');
  assert.equal(full.coverage.find(item => item.layer === 'lift')?.state, 'partial');
  assert.ok(full.diagnostics.some(item => item.code === 'unavailable_semantics'));
  assert.ok(full.data.emission.mappings.some(mapping => mapping.ranges.some(range => {
    const address = p.image.address_map.translate({ ...range.start, value: BigInt(range.start.value) }, 'va');
    return address.kind === 'mapped' && address.address.value === fixture.address;
  })));
  const inputs = new Map(full.data.emission.mappings.flatMap(mapping => mapping.semantic_ids.map(id => [id, 0n] as const)));
  const observed = execute(full.data.emission, inputs);
  assert.equal(observed.exit, 'unknown');
  assert.deepEqual(observed.events, ['unknown']);
  const hit = await p.decompile(fn.id, { options: { emitter } }); assert.equal(hit.result.state, 'partial');
  assert.ok('data' in hit.result); assert.equal(hit.result.data.cache, 'hit');
  }
});

test('real pipeline budgets: artifact delivery, cumulative cancellation, and annotation response rollback', { timeout: 60000 }, async t => {
  const p = await project(t, 'corpus-symbols.dll'), fn = p.functions.find(fn => fn.entry.value === 0x180001030n)!;
  const limited = await p.decompile(fn.id, { budget: { output_bytes: 4096 } });
  assert.equal(limited.result.state, 'partial'); assert.ok('data' in limited.result);
  assert.equal(limited.result.data.delivery, 'artifact');
  assert.ok(Buffer.byteLength(JSON.stringify(limited.result)) <= 4096);
  const full = p.payload(limited.result).result;
  assert.equal(full.state, 'complete');
  const job_id = p.job('function_decompile'), controller = new AbortController();
  const args = toolSchemas.function_decompile.input.parse({ project_id: p.state.store.project_id, revision: 2, function_id: fn.id, options: { indent: 4 } });
  const context = createOperationContext({ signal: controller.signal, onProgress: phase => { if (phase === 'ssa') controller.abort(); } });
  await assert.rejects(executeDecompilation(args, { store: p.state.store, job_id, context }), { code: 'cancelled' });
  assert.deepEqual(p.state.store.readJob(job_id)?.artifacts, []);
  const id = newIdentity('annotation');
  const responseLimited = await p.annotate([{ operation: 'set', id, entity_id: fn.id, value: { kind: 'note', value: 'x'.repeat(1300) }, status: 'asserted', evidence_ids: [] }], { ...DEFAULT_BUDGET, output_bytes: 2048 });
  assert.equal(responseLimited.result.state, 'failed');
  if (responseLimited.result.state === 'failed') assert.equal(responseLimited.result.error.code, 'resource_limit');
  assert.equal(p.state.store.snapshot().revision, 2); assert.deepEqual(p.state.store.readAnnotations(fn.id, 2), []);
  const invalidNested = await p.annotate([{ operation: 'set', id: newIdentity('annotation'), entity_id: fn.id, value: { kind: 'signature', value: { abi: p.image.target.abi, return_type: entityIdentity(p.image.selected_slice_id, 'missing-type', 0), parameters: [], variadic: false, noreturn: false, evidence_ids: [newIdentity('evidence')] } }, status: 'asserted', evidence_ids: [] }]);
  assert.equal(invalidNested.result.state, 'failed'); assert.equal(p.state.store.snapshot().revision, 2);
});

test('suppressing wire evidence preserves the trusted catalog needed to annotate a derived field', async t => {
  const p = await project(t, 'corpus-symbols.dll'), fn = p.functions.find(fn => fn.entry.value === 0x180001070n)!;
  const hidden = await p.decompile(fn.id, { options: { include_evidence: false } });
  assert.deepEqual(hidden.result.evidence, []);
  const full = p.payload(hidden.result);
  assert.ok(full.result.data.emission.mappings.every(mapping => mapping.evidence_ids.length === 0));
  const field = full.catalog.subjects.find(subject => subject.kind === 'field')!;
  const catalog = await readAnnotationCatalog(p.state.store, 2, [field.id], createOperationContext(), acceptsAnalysisIdentity);
  assert.equal(catalog?.subject(field.id)?.kind, 'field');
  const derived = full.catalog.types.flatMap(type => catalog!.types(type.id).flatMap(record => record.evidence_ids))
    .find(id => p.state.store.readEvidence([id], 2).length === 0)!;
  assert.equal(catalog?.evidence(derived)?.origin.kind, 'analysis');
  const applied = await p.annotate([{ operation: 'set', id: newIdentity('annotation'), entity_id: field.id, value: { kind: 'note', value: 'Retain the field derivation even without inline proof bodies' }, status: 'asserted', evidence_ids: [derived] }]);
  assert.equal(applied.result.state, 'complete');
  assert.equal(p.state.store.readEvidence([derived], 3)[0]?.origin.kind, 'analysis');
});
