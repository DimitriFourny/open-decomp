import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, entityIdentity, expandEmission, type Annotation, type Inference,
  type OperationContext } from '../../src/core/index.js';
import { inferenceSchema } from '../../src/core/inference.js';
import type { TypeRecoveryResult, TypeStatus } from '../../src/analysis/types/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { collectInferences } from '../../src/emitters/inference.js';
import { Writer } from '../../src/emitters/writer.js';
import { IRBuilder, integer, type Value } from '../../src/ir/index.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import { reconstruct } from '../../src/reconstruction/index.js';
import type { Reconstruction } from '../../src/reconstruction/model.js';
import type { SourcePresentation } from '../../src/reconstruction/source-model.js';
import { image, provenance, slice } from '../ir/support.js';

function fixture() {
  const id = (name: string) => entityIdentity(slice, 'inference-regression', name);
  const proof = `evidence_${'c'.repeat(64)}`;
  const instruction = id('instruction');
  const origin = { instruction_ids: [instruction],
    ranges: [{ start: { image_id: image, space: 'va' as const, value: 4096n }, size: 4n }],
    evidence_ids: [proof], synthetic: [] };
  const b = new IRBuilder(slice, id('function'), provenance, 'ssa');
  const entry = b.block('entry', [integer(64)]);
  entry.source(origin);
  const value = entry.load(integer(64), entry.parameters[0]!);
  entry.return([value]);
  const context = createOperationContext();
  const structured = structureControlFlow(b.finish(entry, [integer(64)]), context);
  assert.ok(structured.value);
  const inputFunction = structured.value;
  const baseline = reconstruct({ function: inputFunction }, context);
  const load = [...baseline.blocks.values()].flatMap((block) => block.statements)
    .find((node) => node.kind === 'load' && node.result.id === value.id);
  assert.ok(load);
  const display: Value = { id: id('display'), type: integer(64) };
  const dead = id('dead');
  const word = id('word');
  const fieldId = id('field');
  const statuses: readonly TypeStatus[] = ['established', 'asserted', 'hypothesis', 'conflicting'];
  const types: TypeRecoveryResult = {
    state: 'complete', work: 0, subjects: [value.id, dead, fieldId],
    types: [{ id: word, definition: { kind: 'integer', bits: 64, signed: true },
      source: 'analysis', status: 'established', evidence_ids: [proof] }],
    associations: [...statuses.map((status) => ({ id: id(status), subject_id: value.id,
      type_id: word, status, source: 'user' as const, machine_type: value.type,
      value_offset_bits: 0, machine_offset_bits: 0, width_bits: 64, evidence_ids: [proof] })),
      { id: id('dead-association'), subject_id: dead, type_id: word, status: 'hypothesis',
        source: 'user', machine_type: value.type, value_offset_bits: 0,
        machine_offset_bits: 0, width_bits: 64, evidence_ids: [proof] }],
    signatures: [], shapes: [], conflicts: [{ subject_id: value.id, alternatives: [word, id('alternative')],
      reason: 'incompatible_types', evidence_ids: [proof] }], evidence: [], diagnostics: [], calls: null,
  };
  const source: SourcePresentation = {
    inferred: true, parameter_names: new Map(), return_type: integer(64), locals: new Map(),
    stack: null, stack_addresses: new Map(), addresses: [],
    value_origins: new Map([[display.id, [value.id]]]),
    value_types: new Map([[display.id, { type_id: word, association_ids: [id('established')],
      subject_ids: [value.id], evidence_ids: [proof] }]]),
  };
  const field = { id: fieldId, offset: 0n, width_bits: 64, node_ids: [load.id],
    value_ids: [value.id], evidence_ids: [proof], access: ['read' as const],
    stack_region: null, stride: null };
  const program: Reconstruction = {
    ...baseline, source, parameters: [display], live: new Set([display.id]),
    values: new Map([...baseline.values, [display.id, display]]),
    memory: new Map([[load.id, { scalar: false, field, shape: { id: id('shape'), type_id: id('shape-type'),
      base: { kind: 'value', value_id: entry.parameters[0]!.id }, base_offset: 0n,
      observed_extent: null, fields: [field], alias: 'possible', escape: 'unknown',
      dynamic: false, evidence_ids: [proof] } }]]),
  };
  const mappings = [
    { statement: value.id, semantic: [], start: 0, end: 20 },
    { statement: value.id, semantic: [], start: 20, end: 30 },
    { statement: load.id, semantic: [value.id, fieldId], start: 40, end: 60 },
  ];
  const sites = new Map([[display.id, { start: 20, end: 30 }], [load.id, { start: 40, end: 60 }]]);
  const annotation: Annotation = { id: `annotation_${'d'.repeat(64)}`, entity_id: value.id,
    value: { kind: 'note', value: 'withdrawn claim' }, author: 'regression', origin: 'user',
    status: 'retracted', evidence_ids: [proof], revision: 1 };
  const input = { function: inputFunction, types, annotations: [annotation] };
  const validations = [{ kind: 'bitvector' as const, subject: display.id,
    status: 'rejected' as const, scope: 'local arithmetic only', reason: 'different result',
    counterexample: { [value.id]: '0xffffffffffffffff' } }];
  /** Finalized mappings are owned by the writer whose tables they cite. */
  const writer = (ctx: OperationContext, evidence: boolean) => {
    const result = new Writer(ctx, 2, evidence);
    for (const mapping of mappings)
      result.mappings.push({ start: mapping.start, end: mapping.end,
        semantic_refs: [mapping.statement, ...mapping.semantic].map((subject) => result.id(subject)),
        instruction_refs: result.idRefs([instruction]), range_refs: result.rangeRefs(origin.ranges),
        evidence_refs: [result.proof(proof)] });
    return result;
  };
  /** Expanded string-identity view of records citing one writer's tables. */
  const expand = (owner: Writer, records: readonly Inference[]) => expandEmission({
    language: 'c-like', emitter_version: 'test', text: '', span_unit: 'utf16', reconstruction: 'pseudocode',
    ids: owner.ids.items, evidence: owner.proofs.items, ranges: owner.ranges.items, mappings: [], helpers: [],
    inferences: records, review: { operation: 'function_get', view: 'metadata', function_id: inputFunction.id },
  }).inferences!;
  const collect = (selected = program, evidence = true) => {
    const ctx = createOperationContext();
    const owner = writer(ctx, evidence);
    const records = collectInferences(input, selected, validations, owner, ctx, sites);
    return { records, expanded: expand(owner, records) };
  };
  return { input, program, source, writer, validations, sites, collect, value, display,
    statuses, instruction, fieldId, dead };
}

test('inference alternatives and local counterexamples never become established source facts', () => {
  const f = fixture(), records = f.collect().expanded;
  for (const status of f.statuses) {
    const record = records.find((item) => item.details.kind === 'type' && item.details.type_status === status);
    assert.ok(record);
    assert.equal(record.status, status);
    if (record.details.kind === 'type' && status === 'hypothesis') assert.equal(record.details.displayed, false);
  }
  const rewrite = records.find((item) => item.details.kind === 'rewrite');
  assert.ok(rewrite && rewrite.details.kind === 'rewrite');
  assert.equal(rewrite.status, 'conflicting');
  assert.equal(rewrite.details.validation_status, 'rejected');
  assert.equal(rewrite.details.counterexample?.[f.value.id], '0xffffffffffffffff');
  const retracted = records.find((item) => item.details.kind === 'annotation');
  assert.equal(retracted?.status, 'unresolved');
  assert.equal(records.some((item) => item.subject_ids.includes(f.dead)), false);
});

test('field explanations use the actual access span and preserve original proof subjects', () => {
  const f = fixture();
  for (const includeEvidence of [true, false]) {
    const { records: compact, expanded: records } = f.collect(f.program, includeEvidence);
    const field = records.find((item) => item.details.kind === 'field');
    assert.ok(field);
    assert.deepEqual(field.output_spans, [{ start: 40, end: 60 }]);
    assert.ok(field.subject_ids.includes(f.fieldId));
    assert.ok(field.subject_ids.includes(f.value.id));
    assert.ok(field.instruction_ids.includes(f.instruction));
    assert.equal(records.some((item) => item.subject_ids.includes(f.display.id)), false);
    for (const record of compact) inferenceSchema.parse(record);
    for (const record of records) {
      assert.equal(record.output_spans.some((span) => span.start === 0), false);
      if (!includeEvidence) assert.deepEqual(record.evidence_ids, []);
    }
  }
});

test('entry storage role is structural and never counted as an authored parameter', () => {
  const f = fixture();
  const entryStorage: Reconstruction = { ...f.program, source: { ...f.source,
    stack: { kind: 'entry', base: f.display, dynamic: false,
      minimum_offset: 0n, size: 8n, alignment: 8 } } };
  const record = f.collect(entryStorage).records.find((item) => item.details.kind === 'parameter');
  assert.ok(record && record.details.kind === 'parameter');
  assert.equal(record.details.role, 'entry_storage');
  assert.match(record.explanation, /not an authored source argument/);
  const normal = f.collect().records.find((item) => item.details.kind === 'parameter');
  assert.ok(normal && normal.details.kind === 'parameter');
  assert.equal(normal.details.role, 'observed_input');
});

test('a proven stack-pointer input remains entry storage without a fixed stack view', () => {
  const f = fixture();
  const dynamicStack: Reconstruction = { ...f.program,
    parameter_registers: new Map([[f.display.id, sysvAMD64Abi.stack_pointer]]) };
  assert.equal(dynamicStack.source?.stack, null);
  const record = f.collect(dynamicStack).records.find((item) => item.details.kind === 'parameter');
  assert.ok(record && record.details.kind === 'parameter');
  assert.equal(record.details.role, 'entry_storage');
  const namedOnly: Reconstruction = { ...f.program, source: { ...f.source,
    parameter_names: new Map([[f.display.id, 'entry_sp']]) } };
  const namedRecord = f.collect(namedOnly).records.find((item) => item.details.kind === 'parameter');
  assert.ok(namedRecord && namedRecord.details.kind === 'parameter');
  assert.equal(namedRecord.details.role, 'observed_input');
});

test('inference metadata bounds and cancellation fail explicitly instead of dropping claims', () => {
  const f = fixture();
  const bounded = createOperationContext({ budget: { output_bytes: 1024 } });
  assert.throws(() => collectInferences(f.input, f.program, f.validations,
    f.writer(bounded, true), bounded, f.sites), { code: 'resource_limit' });
  const abort = new AbortController();
  const cancelled = createOperationContext({ signal: abort.signal });
  abort.abort();
  assert.throws(() => collectInferences(f.input, f.program, f.validations,
    f.writer(cancelled, true), cancelled, f.sites), { code: 'cancelled' });
});
