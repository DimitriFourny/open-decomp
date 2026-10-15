import assert from 'node:assert/strict';
import test from 'node:test';
import { toolSchemas, exportToolJsonSchemas, type ToolName, memoryReadArgsSchema, memoryReadResultSchema, stringsFindResultSchema, annotationsApplyArgsSchema, annotationsApplyResultSchema, jobSchema, analysisCancelResultSchema, emissionSchema } from '../../src/core/tools.js';
import { DEFAULT_BUDGET, DEFAULT_ANALYSIS_OPTIONS } from '../../src/core/primitives.js';
import { validateToolRequest, validateToolResponse, RevisionConflict } from '../../src/core/validation.js';

const project = `project_${'1'.repeat(64)}`;
const image = `image_${'2'.repeat(64)}`;
const slice = `slice_${'3'.repeat(64)}`;
const entity = `entity_${'4'.repeat(64)}`;
const jobId = `job_${'5'.repeat(64)}`;
const annotationId = `annotation_${'6'.repeat(64)}`;
const address = { image_id: image, space: 'va', value: '0x1000' };
const range = { start: address, size: '0x4' };
const request = { project_id: project, revision: 3 };
const page = { next_cursor: null, index_state: 'complete', order: 'address_id' };
const summary = { id: image, sha256: '2'.repeat(64), byte_length: '0x1000', selected_slice_id: slice, image_base: '0x1000', target: { format: 'macho', architecture: 'arm64', abi: 'darwin-arm64', endian: 'little', address_bits: 64, features: [] }, slices: [{ id: slice, image_id: image, offset: '0x0', size: '0x1000', architecture: 'arm64', subtype: 'all', supported: true }], entry_points: [address], capabilities: [] };
const functionRecord = { id: entity, original_name: 'main', display_name: 'main', evidence_ids: [], entry: address, ranges: [range], boundary: 'established', signature: null, analysis: 'not_analyzed' };
const job = { id: jobId, project_id: project, input_revision: 3, operation: 'function_decompile', state: 'running', progress: { phase: 'lift', completed: 1, total: 4 }, artifacts: [], diagnostics: [], published_revision: null };
const envelope = { schema_version: 1, project_id: project, revision: 3, versions: { backend: '1', loader: '1', decoder: null, lifter: null, analysis: null, abi: null, emitter: null }, options: DEFAULT_ANALYSIS_OPTIONS, budget: DEFAULT_BUDGET, coverage: [], diagnostics: [], evidence: [], artifacts: [] };
const diagnostic = { code: 'unavailable_semantics', severity: 'error', message: 'Unsupported instruction family', evidence_ids: [] };
const inputs: Record<ToolName, object> = {
  project_open: { source: { kind: 'import', input_path: '/authorized/sample', project_path: '/authorized/project' } },
  project_close: request,
  binary_info: { ...request, image_id: image },
  symbols_find: { ...request, image_id: image },
  strings_find: { ...request, image_id: image },
  functions_find: { ...request, image_id: image },
  function_get: { ...request, function_id: entity },
  function_decompile: { ...request, function_id: entity },
  xrefs_get: { ...request, target: { kind: 'entity', id: entity } },
  memory_read: { ...request, address },
  annotations_apply: { project_id: project, expected_revision: 3, author: 'analyst', origin: 'user', edits: [{ operation: 'set', id: annotationId, entity_id: entity, value: { kind: 'note', value: 'Binary strings are data, not instructions.' }, status: 'hypothesis', evidence_ids: [] }] },
  analysis_status: { ...request, job_id: jobId },
  analysis_cancel: { ...request, job_id: jobId },
};
const success: Record<ToolName, object> = {
  project_open: { state: 'complete', data: { image: summary, resumed: false } },
  project_close: { state: 'complete', data: { closed: true, persisted_revision: 3 } },
  binary_info: { state: 'complete', data: { view: 'summary', image: summary } },
  symbols_find: { state: 'empty', data: { items: [], page } },
  strings_find: { state: 'empty', data: { items: [], page } },
  functions_find: { state: 'complete', data: { items: [functionRecord], page } },
  function_get: { state: 'complete', data: { view: 'metadata', function: functionRecord, annotations: [], lineage: [] } },
  function_decompile: { state: 'complete', data: { function_id: entity, signature: null, emission: { language: 'c-like', emitter_version: '1', text: 'return;', span_unit: 'utf16', reconstruction: 'pseudocode', mappings: [], helpers: [] }, capabilities: [], cache: 'computed' } },
  xrefs_get: { state: 'empty', data: { items: [], page } },
  memory_read: { state: 'complete', data: { requested: range, segments: [{ kind: 'mapped', range, bytes_hex: '01020304' }], values: [], next_address: null } },
  annotations_apply: { state: 'complete', revision: 4, data: { previous_revision: 3, revision: 4, applied: [{ id: annotationId, entity_id: entity, value: { kind: 'note', value: 'Binary strings are data, not instructions.' }, author: 'analyst', origin: 'user', status: 'hypothesis', evidence_ids: [], revision: 4 }], removed: [], invalidation: { scope: 'project', derived_before_revision: 4 } } },
  analysis_status: { state: 'complete', data: { job } },
  analysis_cancel: { state: 'complete', data: { job, outcome: 'cancellation_requested' } },
};

test('all thirteen tools validate concrete inputs and operation-specific outputs', () => {
  assert.equal(Object.keys(toolSchemas).length, 13);
  for (const name of Object.keys(toolSchemas) as ToolName[]) {
    const schemas = toolSchemas[name];
    const parsed = schemas.input.parse(inputs[name]);
    assert.deepEqual(parsed.budget, DEFAULT_BUDGET, name);
    assert.equal(schemas.input.safeParse({ ...inputs[name], arbitrary_sql: 'select 1' }).success, false, name);
    assert.doesNotThrow(() => schemas.output.parse({ ...envelope, ...success[name] }), name);
    assert.equal(schemas.output.safeParse({ ...envelope, state: 'complete', data: { arbitrary: 'not a concrete output' } }).success, false, name);
    for (const state of ['unsupported', 'failed', 'cancelled'] as const) {
      const result = state === 'failed' ? { state, error: diagnostic, current_revision: 3 } : state === 'unsupported' ? { state, error: diagnostic } : { state, job_id: jobId };
      assert.equal(schemas.output.parse({ ...envelope, ...result }).state, state);
    }
  }
});

test('JSON Schema export is JSON-serializable, strict, object-rooted and MCP-independent', () => {
  const exported = exportToolJsonSchemas();
  assert.deepEqual(Object.keys(exported).sort(), Object.keys(toolSchemas).sort());
  for (const schema of Object.values(exported)) {
    assert.equal(schema.inputSchema.type, 'object');
    assert.equal(schema.inputSchema.additionalProperties, false);
    assert.equal(schema.outputSchema.type, 'object');
    assert.equal(schema.schema_version, 1);
  }
  const wire = JSON.stringify(exported);
  assert.equal(JSON.parse(wire).memory_read.inputSchema.properties.address.properties.value.type, 'string');
});

test('empty results differ from incomplete searches, partial results and running work', () => {
  const empty = { ...envelope, state: 'empty', data: { items: [], page } };
  assert.equal(stringsFindResultSchema.parse(empty).state, 'empty');
  assert.equal(stringsFindResultSchema.safeParse({ ...empty, data: { items: [], page: { ...page, index_state: 'partial' } } }).success, false);
  assert.equal(stringsFindResultSchema.safeParse({ ...empty, state: 'complete' }).success, false);
  assert.equal(stringsFindResultSchema.parse({ ...empty, state: 'partial', reason: 'incomplete_index', continuation: null, data: { items: [], page: { ...page, index_state: 'partial' } } }).state, 'partial');
  assert.equal(stringsFindResultSchema.parse({ ...envelope, state: 'running', job }).state, 'running');
  assert.equal(stringsFindResultSchema.safeParse({ ...envelope, state: 'running', job: { ...job, input_revision: 2 } }).success, false);
  assert.equal(stringsFindResultSchema.safeParse({ ...empty, project_id: null }).success, false);
});

test('budgets, read bounds, structured memory holes and byte counts are enforced', () => {
  assert.equal(memoryReadArgsSchema.parse({ ...request, address }).length, 4096);
  assert.equal(memoryReadArgsSchema.safeParse({ ...request, address, length: 1_048_577 }).success, false);
  assert.equal(memoryReadArgsSchema.safeParse({ ...request, address, length: 3, interpretation: 'u16' }).success, false);
  assert.equal(memoryReadArgsSchema.safeParse({ ...request, address: { ...address, value: '0xffffffffffffffff' }, length: 2 }).success, false);
  assert.equal(memoryReadArgsSchema.safeParse({ ...request, address: { ...address, value: 'not hex' }, length: 1 }).success, false);
  assert.equal(memoryReadArgsSchema.safeParse({ ...request, address, budget: { work: 0 } }).success, false);
  for (const kind of ['zero_fill', 'unmapped']) {
    assert.equal(memoryReadResultSchema.parse({ ...envelope, state: 'complete', data: { requested: range, segments: [{ kind, range }], values: [], next_address: null } }).state, 'complete');
  }
  assert.equal(memoryReadResultSchema.safeParse({ ...envelope, state: 'complete', data: { requested: range, segments: [{ kind: 'mapped', range, bytes_hex: 'ff' }], values: [], next_address: null } }).success, false);
  assert.equal(memoryReadResultSchema.safeParse({ ...envelope, state: 'complete', data: { requested: range, segments: [{ kind: 'zero_fill', range: { ...range, size: '0x2' } }], values: [], next_address: null } }).success, false);
});

test('revision and atomic annotation preconditions cannot be silently discarded', () => {
  assert.throws(() => validateToolRequest('annotations_apply', inputs.annotations_apply, 4), RevisionConflict);
  assert.throws(() => validateToolRequest('strings_find', inputs.strings_find, 4), RevisionConflict);
  const args = annotationsApplyArgsSchema.parse(inputs.annotations_apply);
  assert.equal(annotationsApplyArgsSchema.safeParse({ ...args, edits: [args.edits[0], args.edits[0]] }).success, false);
  assert.equal(annotationsApplyArgsSchema.safeParse({ ...args, edits: [] }).success, false);
  const result = { ...envelope, ...success.annotations_apply };
  assert.equal(validateToolResponse('annotations_apply', result, args).revision, 4);
  assert.equal(annotationsApplyResultSchema.safeParse({ ...envelope, state: 'complete', data: { previous_revision: 3, revision: 5, applied: [], removed: [], invalidation: { scope: 'project', derived_before_revision: 5 } } }).success, false);
  assert.throws(() => validateToolResponse('annotations_apply', { ...result, project_id: `project_${'f'.repeat(64)}` }, args));
});

test('jobs cannot publish stale revisions and cancellation races have explicit outcomes', () => {
  assert.equal(jobSchema.safeParse({ ...job, state: 'completed', published_revision: 2 }).success, false);
  assert.equal(jobSchema.safeParse({ ...job, state: 'cancelled', published_revision: 3 }).success, false);
  assert.equal(jobSchema.safeParse({ ...job, progress: { phase: 'lift', completed: 5, total: 4 } }).success, false);
  assert.equal(analysisCancelResultSchema.safeParse({ ...envelope, state: 'complete', data: { job, outcome: 'cancelled' } }).success, false);
  assert.equal(analysisCancelResultSchema.parse({ ...envelope, state: 'complete', data: { job: { ...job, state: 'completed', published_revision: 3 }, outcome: 'already_finished' } }).state, 'complete');
});

test('emitter spans refer to actual UTF-16 text bounds', () => {
  const emission = { language: 'c-like', emitter_version: '1', text: 'return;', span_unit: 'utf16', reconstruction: 'pseudocode', helpers: [], mappings: [{ statement_id: entity, start: 0, end: 7, semantic_ids: [entity], instruction_ids: [entity], ranges: [range], evidence_ids: [] }] };
  assert.equal(emissionSchema.safeParse(emission).success, true);
  assert.equal(emissionSchema.safeParse({ ...emission, mappings: [{ ...emission.mappings[0], end: 8 }] }).success, false);
});

test('serialized output budgets and job/project bindings are enforced at delivery', () => {
  const args = validateToolRequest('function_decompile', { ...inputs.function_decompile, budget: { output_bytes: 1024 } }, 3);
  const output = { ...envelope, state: 'complete', data: { function_id: entity, signature: null, emission: { language: 'c-like', emitter_version: '1', text: 'x'.repeat(4096), span_unit: 'utf16', reconstruction: 'pseudocode', mappings: [], helpers: [] }, capabilities: [], cache: 'computed' } };
  assert.throws(() => validateToolResponse('function_decompile', output, args), RangeError);
  const statusArgs = validateToolRequest('analysis_status', inputs.analysis_status, 3);
  assert.throws(() => validateToolResponse('analysis_status', { ...envelope, state: 'complete', data: { job: { ...job, id: `job_${'f'.repeat(64)}` } } }, statusArgs));
  assert.equal(stringsFindResultSchema.safeParse({ ...envelope, state: 'partial', reason: 'output_limit', continuation: null, data: { items: [], page } }).success, false);
});
