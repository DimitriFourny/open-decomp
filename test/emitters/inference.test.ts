import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  entityIdentity,
  expandEmission,
  type Annotation,
  type Inference,
  type OperationContext,
} from '../../src/core/index.js';
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
import { LocalValidationSession } from '../../src/reconstruction/local-validation.js';
import {
  abiConformanceRequirements,
  sourceRequirementProofs,
} from '../../src/reconstruction/source-requirements.js';
import { image, provenance, slice } from '../ir/support.js';

function fixture() {
  const id = (name: string) => entityIdentity(slice, 'inference-regression', name);
  const proof = `evidence_${'c'.repeat(64)}`;
  const instruction = id('instruction');
  const origin = {
    instruction_ids: [instruction],
    ranges: [{ start: { image_id: image, space: 'va' as const, value: 4096n }, size: 4n }],
    evidence_ids: [proof],
    synthetic: [],
  };
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
  const load = [...baseline.blocks.values()]
    .flatMap((block) => block.statements)
    .find((node) => node.kind === 'load' && node.result.id === value.id);
  assert.ok(load);
  const display: Value = { id: id('display'), type: integer(64) };
  const dead = id('dead');
  const word = id('word');
  const fieldId = id('field');
  const statuses: readonly TypeStatus[] = ['established', 'asserted', 'hypothesis', 'conflicting'];
  const types: TypeRecoveryResult = {
    state: 'complete',
    work: 0,
    subjects: [value.id, dead, fieldId],
    types: [
      {
        id: word,
        definition: { kind: 'integer', bits: 64, signed: true },
        source: 'analysis',
        status: 'established',
        evidence_ids: [proof],
      },
    ],
    associations: [
      ...statuses.map((status) => ({
        id: id(status),
        subject_id: value.id,
        type_id: word,
        status,
        source: 'user' as const,
        machine_type: value.type,
        value_offset_bits: 0,
        machine_offset_bits: 0,
        width_bits: 64,
        evidence_ids: [proof],
      })),
      {
        id: id('dead-association'),
        subject_id: dead,
        type_id: word,
        status: 'hypothesis',
        source: 'user',
        machine_type: value.type,
        value_offset_bits: 0,
        machine_offset_bits: 0,
        width_bits: 64,
        evidence_ids: [proof],
      },
    ],
    signatures: [],
    shapes: [],
    conflicts: [
      {
        subject_id: value.id,
        alternatives: [word, id('alternative')],
        reason: 'incompatible_types',
        evidence_ids: [proof],
      },
    ],
    evidence: [],
    diagnostics: [],
    calls: null,
  };
  const source: SourcePresentation = {
    inferred: true,
    parameter_names: new Map(),
    return_type: integer(64),
    locals: new Map(),
    stack: null,
    stack_addresses: new Map(),
    addresses: [],
    value_origins: new Map([[display.id, [value.id]]]),
    value_types: new Map([
      [
        display.id,
        {
          type_id: word,
          association_ids: [id('established')],
          subject_ids: [value.id],
          evidence_ids: [proof],
        },
      ],
    ]),
  };
  const field = {
    id: fieldId,
    offset: 0n,
    width_bits: 64,
    node_ids: [load.id],
    value_ids: [value.id],
    evidence_ids: [proof],
    access: ['read' as const],
    stack_region: null,
    stride: null,
  };
  const program: Reconstruction = {
    ...baseline,
    source,
    parameters: [display],
    live: new Set([display.id]),
    values: new Map([...baseline.values, [display.id, display]]),
    memory: new Map([
      [
        load.id,
        {
          scalar: false,
          field,
          shape: {
            id: id('shape'),
            type_id: id('shape-type'),
            base: { kind: 'value', value_id: entry.parameters[0]!.id },
            base_offset: 0n,
            observed_extent: null,
            fields: [field],
            alias: 'possible',
            escape: 'unknown',
            dynamic: false,
            evidence_ids: [proof],
          },
        },
      ],
    ]),
  };
  const mappings = [
    { statement: value.id, semantic: [], start: 0, end: 20 },
    { statement: value.id, semantic: [], start: 20, end: 30 },
    { statement: load.id, semantic: [value.id, fieldId], start: 40, end: 60 },
  ];
  const sites = new Map([
    [display.id, { start: 20, end: 30 }],
    [load.id, { start: 40, end: 60 }],
  ]);
  const annotation: Annotation = {
    id: `annotation_${'d'.repeat(64)}`,
    entity_id: value.id,
    value: { kind: 'note', value: 'withdrawn claim' },
    author: 'regression',
    origin: 'user',
    status: 'retracted',
    evidence_ids: [proof],
    revision: 1,
  };
  const input = { function: inputFunction, types, annotations: [annotation] };
  const validations = [
    {
      kind: 'bitvector' as const,
      subject: display.id,
      status: 'rejected' as const,
      scope: 'local arithmetic only',
      reason: 'different result',
      counterexample: { [value.id]: '0xffffffffffffffff' },
    },
  ];
  /** Finalized mappings are owned by the writer whose tables they cite. */
  const writer = (ctx: OperationContext, evidence: boolean) => {
    const result = new Writer(ctx, 2, evidence);
    for (const mapping of mappings)
      result.mappings.push({
        start: mapping.start,
        end: mapping.end,
        semantic_refs: [mapping.statement, ...mapping.semantic].map((subject) =>
          result.id(subject),
        ),
        instruction_refs: result.idRefs([instruction]),
        range_refs: result.rangeRefs(origin.ranges),
        evidence_refs: [result.proof(proof)],
      });
    return result;
  };
  /** Expanded string-identity view of records citing one writer's tables. */
  const expand = (owner: Writer, records: readonly Inference[]) =>
    expandEmission({
      language: 'c-like',
      emitter_version: 'test',
      text: '',
      span_unit: 'utf16',
      reconstruction: 'pseudocode',
      ids: owner.ids.items,
      evidence: owner.proofs.items,
      ranges: owner.ranges.items,
      mappings: [],
      helpers: [],
      inferences: records,
      review: { operation: 'function_get', view: 'metadata', function_id: inputFunction.id },
    }).inferences!;
  const collect = (selected = program, evidence = true) => {
    const ctx = createOperationContext();
    const owner = writer(ctx, evidence);
    const records = collectInferences(input, selected, validations, owner, ctx, sites).records;
    return { records, expanded: expand(owner, records) };
  };
  return {
    input,
    program,
    source,
    writer,
    validations,
    sites,
    collect,
    value,
    display,
    statuses,
    instruction,
    fieldId,
    dead,
  };
}

test('inference alternatives and local counterexamples never become established source facts', () => {
  const f = fixture(),
    records = f.collect().expanded;
  for (const status of f.statuses) {
    const record = records.find(
      (item) => item.details.kind === 'type' && item.details.type_status === status,
    );
    assert.ok(record);
    assert.equal(record.status, status);
    if (record.details.kind === 'type' && status === 'hypothesis')
      assert.equal(record.details.displayed, false);
  }
  const rewrite = records.find((item) => item.details.kind === 'rewrite');
  assert.ok(rewrite && rewrite.details.kind === 'rewrite');
  assert.equal(rewrite.status, 'conflicting');
  assert.equal(rewrite.details.validation_status, 'rejected');
  assert.equal(rewrite.details.counterexample?.[f.value.id], '0xffffffffffffffff');
  const retracted = records.find((item) => item.details.kind === 'annotation');
  assert.equal(retracted?.status, 'unresolved');
  assert.equal(
    records.some((item) => item.subject_ids.includes(f.dead)),
    false,
  );
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
    assert.equal(
      records.some((item) => item.subject_ids.includes(f.display.id)),
      false,
    );
    for (const record of compact) inferenceSchema.parse(record);
    for (const record of records) {
      assert.equal(
        record.output_spans.some((span) => span.start === 0),
        false,
      );
      if (!includeEvidence) assert.deepEqual(record.evidence_ids, []);
    }
  }
});

test('entry storage role is structural and never counted as an authored parameter', () => {
  const f = fixture();
  const entryStorage: Reconstruction = {
    ...f.program,
    source: {
      ...f.source,
      stack: {
        kind: 'entry',
        base: f.display,
        dynamic: false,
        minimum_offset: 0n,
        size: 8n,
        alignment: 8,
      },
    },
  };
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
  const dynamicStack: Reconstruction = {
    ...f.program,
    parameter_registers: new Map([[f.display.id, sysvAMD64Abi.stack_pointer]]),
  };
  assert.equal(dynamicStack.source?.stack, null);
  const record = f.collect(dynamicStack).records.find((item) => item.details.kind === 'parameter');
  assert.ok(record && record.details.kind === 'parameter');
  assert.equal(record.details.role, 'entry_storage');
  const namedOnly: Reconstruction = {
    ...f.program,
    source: { ...f.source, parameter_names: new Map([[f.display.id, 'entry_sp']]) },
  };
  const namedRecord = f
    .collect(namedOnly)
    .records.find((item) => item.details.kind === 'parameter');
  assert.ok(namedRecord && namedRecord.details.kind === 'parameter');
  assert.equal(namedRecord.details.role, 'observed_input');
});

test('inference metadata bounds shed and count records instead of failing or truncating them', () => {
  const f = fixture();
  const full = collectInferences(
    f.input,
    f.program,
    f.validations,
    f.writer(createOperationContext(), true),
    createOperationContext(),
    f.sites,
  );
  assert.ok(full.records.length > 1);
  assert.equal(full.omitted, 0);
  // A metadata budget that cannot hold every record ends collection with a prefix of
  // intact records; the omission is reported, never raised and never silent.
  const bounded = createOperationContext({ budget: { output_bytes: 1024 } });
  const shed = collectInferences(
    f.input,
    f.program,
    f.validations,
    f.writer(bounded, true),
    bounded,
    f.sites,
  );
  assert.ok(shed.records.length < full.records.length);
  assert.equal(shed.omitted, null);
  assert.deepEqual(shed.records, full.records.slice(0, shed.records.length));
  const abort = new AbortController();
  const cancelled = createOperationContext({ signal: abort.signal });
  abort.abort();
  assert.throws(
    () =>
      collectInferences(
        f.input,
        f.program,
        f.validations,
        f.writer(cancelled, true),
        cancelled,
        f.sites,
      ),
    { code: 'cancelled' },
  );
});

test('aggregated presentation subjects all remain traceable through inference references', () => {
  const f = fixture(),
    context = createOperationContext();
  const session = new LocalValidationSession(context),
    owner = f.writer(context, true);
  session.presentation('observed_view', f.value.id, 'same view', [f.fieldId]);
  session.presentation('observed_view', f.display.id, 'same view', [f.input.function.id]);
  assert.equal(session.records.length, 1);
  const records = collectInferences(
    f.input,
    f.program,
    session.records,
    owner,
    context,
    f.sites,
  ).records;
  const rewrite = records.find(
    (record) => record.details.kind === 'rewrite' && record.details.rule === 'observed_view',
  );
  assert.ok(rewrite);
  const subjects = new Set(rewrite.subject_refs.map((ref) => owner.ids.items[ref]));
  for (const id of [f.value.id, f.fieldId, f.input.function.id]) assert.ok(subjects.has(id));
  assert.equal(inferenceSchema.safeParse(rewrite).success, true);
});

test('aggregated ABI sites map later anchors even when their first anchor is not emitted', () => {
  const f = fixture(),
    context = createOperationContext();
  const session = new LocalValidationSession(context),
    owner = f.writer(context, true);
  const load = [...f.program.blocks.values()]
    .flatMap((block) => block.statements)
    .find((node) => node.kind === 'load')!;
  session.requireAbi('observed_view', [f.input.function.id], 'target view');
  session.requireAbi('observed_view', [load.id], 'target view');
  const requirements = abiConformanceRequirements(
    f.input.function.id,
    session.abiConformance,
    (id) => (id === load.id ? load : id === f.input.function.id ? f.input.function : undefined),
    context,
  );
  const projected = sourceRequirementProofs(
    f.program,
    owner.mappings,
    { ids: owner.ids.items, ranges: owner.ranges.items },
    context,
    requirements,
  );
  assert.equal(projected.length, 1);
  assert.deepEqual(projected[0]!.output_spans, [{ start: 40, end: 60 }]);
  assert.ok(projected[0]!.subject_ids.includes(load.id));
});

test('identical type assertions share one record without losing any member fact', () => {
  const f = fixture();
  const types = f.input.types;
  const asserted = types.associations.find((item) => item.status === 'asserted')!;
  const sibling = {
    ...asserted,
    id: entityIdentity(slice, 'inference-regression', 'field-asserted'),
    subject_id: f.fieldId,
    evidence_ids: [`evidence_${'e'.repeat(64)}`],
  };
  const run = (associations: TypeRecoveryResult['associations']) => {
    const context = createOperationContext(),
      owner = f.writer(context, true);
    const input = { ...f.input, types: { ...types, associations } };
    return collectInferences(input, f.program, [], owner, context, f.sites)
      .records.filter(
        (record) => record.details.kind === 'type' && record.details.type_status === 'asserted',
      )
      .map((record) => ({
        associations: record.details.kind === 'type' ? record.details.association_ids : [],
        subjects: new Set(record.subject_refs.map((ref) => owner.ids.items[ref])),
        proofs: new Set(record.evidence_refs.map((ref) => owner.proofs.items[ref])),
        instructions: new Set(record.instruction_refs.map((ref) => owner.ids.items[ref])),
        spans: new Set(record.output_spans.map((span) => `${span.start}:${span.end}`)),
        record,
      }));
  };
  const grouped = run([...types.associations, sibling]);
  assert.equal(grouped.length, 1);
  const [record] = grouped;
  assert.deepEqual(record!.associations, [asserted.id, sibling.id]);
  assert.equal(inferenceSchema.safeParse(record!.record).success, true);
  // The grouped record is exactly the union of the separate per-association records.
  const separate = [run([asserted]), run([sibling])].map((records) => {
    assert.equal(records.length, 1);
    return records[0]!;
  });
  for (const key of ['subjects', 'proofs', 'instructions', 'spans'] as const)
    assert.deepEqual(
      [...record![key]].sort(),
      [...new Set(separate.flatMap((item) => [...item[key]]))].sort(),
      key,
    );
  // A differing displayed/status/source field never joins the cohort.
  const distinct = run([...types.associations, { ...sibling, source: 'debug' as const }]);
  assert.equal(distinct.length, 2);
});
