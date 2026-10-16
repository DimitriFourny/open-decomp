import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { createOperationContext, DEFAULT_ANALYSIS_OPTIONS, OperationError, decodeEmission, encodeEmission, entityIdentity, type Annotation } from '../../../src/core/index.js';
import { simplifySSA } from '../../../src/analysis/values/index.js';
import type { TypeRecoveryResult } from '../../../src/analysis/types/index.js';
import { IRBuilder, integer } from '../../../src/ir/index.js';
import { structureControlFlow, type Region } from '../../../src/presentation/index.js';
import { CEmitter, emitC } from '../../../src/emitters/c/index.js';
import { PythonLikeEmitter, emitPythonLike } from '../../../src/emitters/python-like/index.js';
import { image, provenance, slice } from '../../ir/support.js';
import { emit as render, execute } from './support.js';

const i32 = integer(32);
function program(name: string): IRBuilder<'ssa'> { return new IRBuilder(slice, entityIdentity(slice, 'function', name), provenance, 'ssa'); }
function origin(index: number) {
  return { instruction_ids: [entityIdentity(slice, 'instruction', BigInt(0x1000 + index * 4))], ranges: [{ start: { image_id: image, space: 'va' as const, value: BigInt(0x1000 + index * 4) }, size: 4n }], evidence_ids: [`evidence_${String(index).repeat(64)}`], synthetic: [] };
}

for (const language of ['c-like', 'python-like'] as const) describe(language, () => {
const emit: typeof render = (input, extra) => render(input, extra, language);
const emitSelected = language === 'c-like' ? emitC : emitPythonLike;
test('post-simplification source mappings retain original instructions and exact UTF-16 statement boundaries', () => {
  const b = program('emitted-simplified-origins'), entry = b.block('entry');
  entry.source(origin(1)); const a = entry.constant(i32, 20n);
  entry.source(origin(2)); const c = entry.constant(i32, 22n);
  entry.source(origin(3)); const sum = entry.int('add', a, c); entry.return([sum]);
  const optimized = simplifySSA(b.finish(entry, [i32])); assert.equal(optimized.state, 'complete');
  const output = emit(optimized.value, { names: [{ entity_id: b.function_id, name: 'astral 🧪 label' }] });
  assert.deepEqual(execute(output.emission).values, [42n]);
  const final = optimized.value.blocks[0]!.instructions.find(node => node.kind === 'assign' && node.result.id === sum.id)!;
  const mapping = output.emission.mappings.find(item => item.statement_id === final.id)!;
  assert.ok(mapping);
  assert.deepEqual(new Set(mapping.instruction_ids), new Set([origin(1).instruction_ids[0], origin(2).instruction_ids[0], origin(3).instruction_ids[0]]));
  assert.deepEqual(new Set(mapping.ranges.map(range => range.start.value)), new Set([0x1004n, 0x1008n, 0x100cn]));
  const prefix = output.emission.text.slice(0, mapping.start);
  assert.ok(prefix.length < Buffer.byteLength(prefix), 'astral display data must precede a UTF-16 rather than UTF-8 mapping');
  assert.equal(output.emission.text[mapping.start - 1], '\n'); assert.equal(output.emission.text[mapping.end - 1], '\n');
  assert.deepEqual(decodeEmission(encodeEmission(output.emission)), output.emission);
  assert.equal(output.coverage.statements, output.coverage.mapped_statements); assert.equal(output.coverage.controls, output.coverage.mapped_controls);
  for (const span of output.emission.mappings) {
    assert.ok(span.start >= 0 && span.end > span.start && span.end <= output.emission.text.length);
    assert.ok(span.start === 0 || output.emission.text[span.start - 1] === '\n');
    assert.equal(output.emission.text[span.end - 1], '\n');
  }
});

test('untrusted labels and notes are inert data with collision-safe identifiers and preserved subjects', () => {
  const b = program('emitted-hostile-labels'), entry = b.block('entry', [i32, i32]);
  entry.return([entry.int('sub', entry.parameters[0]!, entry.parameters[1]!)]);
  const hostile = '*/\nreturn trap_exit(); /* " \\ \u202e 🧪';
  const notes: Annotation[] = [{ id: `annotation_${'a'.repeat(64)}`, entity_id: entry.parameters[0]!.id, value: { kind: 'note', value: hostile }, author: '*/ actor', origin: 'llm', status: 'hypothesis', evidence_ids: [`evidence_${'a'.repeat(64)}`], revision: 1 }, { id: `annotation_${'b'.repeat(64)}`, entity_id: entry.parameters[1]!.id, value: { kind: 'note', value: 'retracted data' }, author: 'user', origin: 'user', status: 'retracted', evidence_ids: [`evidence_${'b'.repeat(64)}`], revision: 2 }];
  const output = emit(b.finish(entry, [i32]), { names: [{ entity_id: b.function_id, name: hostile }, ...entry.parameters.map(value => ({ entity_id: value.id, name: 'return' }))], annotations: notes });
  const result = execute(output.emission, new Map([[entry.parameters[0]!.id, 9n], [entry.parameters[1]!.id, 4n]]));
  assert.deepEqual(result.values, [5n]); assert.equal(result.exit, 'machine_return');
  const ids = entry.parameters.map(value => output.identifiers.find(identifier => identifier.entity_id === value.id)!);
  assert.notEqual(ids[0]!.identifier, ids[1]!.identifier); assert.deepEqual(ids.map(id => id.original_name), ['return', 'return']);
  const note = output.emission.mappings.find(mapping => mapping.evidence_ids.includes(notes[0]!.evidence_ids[0]!))!; assert.ok(note);
  assert.ok(note.semantic_ids.includes(entry.parameters[0]!.id));
  const literals = output.emission.text.slice(note.start, note.end).match(/"(?:\\.|[^"\\])*"/g)!.map(text => JSON.parse(text) as string);
  assert.ok(literals.includes(hostile), 'the complete note must survive data escaping');
  assert.equal(output.emission.mappings.some(mapping => mapping.evidence_ids.includes(notes[1]!.evidence_ids[0]!)), false);
  const conflicting = emit(b.finish(entry, [i32]), { names: [{ entity_id: entry.parameters[0]!.id, name: 'alpha' }, { entity_id: entry.parameters[0]!.id, name: 'beta' }] });
  assert.equal(conflicting.identifiers.find(identifier => identifier.entity_id === entry.parameters[0]!.id)!.original_name, null);
  assert.ok(conflicting.diagnostics.some(diagnostic => diagnostic.entity_id === entry.parameters[0]!.id && diagnostic.code === 'conflicting_evidence'));
  assert.deepEqual(execute(conflicting.emission, new Map([[entry.parameters[0]!.id, 9n], [entry.parameters[1]!.id, 4n]])).values, [5n]);
});

test('source assertions, conflicts, field offsets and notes never rewrite machine storage semantics', () => {
  const b = program('emitted-source-facts'), entry = b.block('entry', [i32]); entry.return([entry.int('add', entry.parameters[0]!, entry.constant(i32, 1n))]);
  const word = entityIdentity(slice, 'source-type', 'word'), pointer = entityIdentity(slice, 'source-type', 'pointer'), structure = entityIdentity(slice, 'source-type', 'layout'), field = entityIdentity(slice, 'field', 'offset');
  const evidence = `evidence_${'c'.repeat(64)}`;
  const types: TypeRecoveryResult = { state: 'complete', work: 0, subjects: [b.function_id, entry.parameters[0]!.id, field],
    types: [{ id: word, definition: { kind: 'integer', bits: 32, signed: true }, source: 'debug', status: 'established', evidence_ids: [] }, { id: pointer, definition: { kind: 'pointer', to: word, bits: 64 }, source: 'user', status: 'asserted', evidence_ids: [] }, { id: structure, definition: { kind: 'structure', size: null, alignment: null, fields: [{ id: field, name: '*/ malicious field', offset: 12n, type_id: word }] }, source: 'analysis', status: 'candidate', evidence_ids: [evidence] }],
    associations: [{ id: entityIdentity(slice, 'association', 'fragment'), subject_id: entry.parameters[0]!.id, type_id: pointer, source: 'llm', status: 'hypothesis', evidence_ids: [evidence], machine_type: i32, machine_offset_bits: 4, value_offset_bits: 8, width_bits: 16 }],
    signatures: [{ id: 'supplied-prototype', subject_id: b.function_id, source: 'user', status: 'asserted', evidence_ids: [evidence], abi_state: 'complete', implicit_register_inputs: [], signature: { abi: 'windows-x64', return_type: word, parameters: [], variadic: false, noreturn: false, evidence_ids: [evidence] } }],
    shapes: [], conflicts: [{ subject_id: entry.parameters[0]!.id, alternatives: [word, pointer], reason: 'incompatible_types', evidence_ids: [evidence] }], evidence: [], diagnostics: [], calls: null };
  const output = emit(b.finish(entry, [i32]), { types, annotations: [{ id: `annotation_${'c'.repeat(64)}`, entity_id: field, value: { kind: 'note', value: 'Observed extent is not object size' }, author: 'analyst', origin: 'user', status: 'asserted', evidence_ids: [evidence], revision: 1 }] });
  assert.deepEqual(execute(output.emission, new Map([[entry.parameters[0]!.id, 0xffffffffn]])).values, [0n]);
  assert.deepEqual(decodeEmission(encodeEmission(output.emission)), output.emission);
});

test('output bytes, work, cancellation and nesting fail explicitly without partial emission', () => {
  const b = program('emitted-bounds'), entry = b.block('entry'); entry.return([entry.constant(i32, 42n)]);
  const structured = structureControlFlow(b.finish(entry, [i32]), createOperationContext()); assert.ok(structured.value);
  const input = { function: structured.value };
  const bounded = (fn: () => unknown, code: string): void => { assert.throws(fn, (error: unknown) => error instanceof OperationError && error.code === code); };
  bounded(() => emitSelected(input, DEFAULT_ANALYSIS_OPTIONS, createOperationContext({ budget: { output_bytes: 1024 } })), 'resource_limit');
  bounded(() => emitSelected(input, DEFAULT_ANALYSIS_OPTIONS, createOperationContext({ budget: { work: 1 } })), 'resource_limit');
  const abort = new AbortController(); abort.abort();
  bounded(() => emitSelected(input, DEFAULT_ANALYSIS_OPTIONS, createOperationContext({ signal: abort.signal })), 'cancelled');
  const note: Annotation = { id: `annotation_${'d'.repeat(64)}`, entity_id: b.function_id, value: { kind: 'note', value: '🧪'.repeat(1500) }, author: 'user', origin: 'user', status: 'asserted', evidence_ids: [], revision: 1 };
  bounded(() => emitSelected({ ...input, annotations: [note] }, DEFAULT_ANALYSIS_OPTIONS, createOperationContext({ budget: { output_bytes: 5000 } })), 'resource_limit');
  let body: Region = structured.value.body;
  for (let depth = 0; depth < 130; depth++) body = { kind: 'sequence', regions: [body] };
  bounded(() => emitSelected({ function: { ...structured.value!, body } }, DEFAULT_ANALYSIS_OPTIONS, createOperationContext()), 'resource_limit');
  const emitter = language === 'c-like' ? new CEmitter() : new PythonLikeEmitter();
  const withoutEvidence = emitter.emit(input, { ...DEFAULT_ANALYSIS_OPTIONS, emitter: language, include_evidence: false, indent: 8 }, createOperationContext());
  assert.deepEqual(execute(withoutEvidence).values, [42n]); assert.ok(withoutEvidence.mappings.every(mapping => mapping.evidence_ids.length === 0));
});
});
