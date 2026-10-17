import assert from 'node:assert/strict';
import test from 'node:test';
import { functionGetArgsSchema, functionGetResultSchema, functionDecompileArgsSchema } from '../../src/core/tools.js';
import { DEFAULT_ANALYSIS_OPTIONS, DEFAULT_BUDGET } from '../../src/core/primitives.js';
import { investigationItems, investigationPage } from '../../src/service/queries/investigation.js';

const scope = {
  project_id: `project_${'1'.repeat(64)}`,
  revision: 2,
  function_id: `entity_${'2'.repeat(64)}`,
};
const artifact_id = `artifact_${'3'.repeat(64)}`;
const subject_id = `entity_${'4'.repeat(64)}`;

test('investigation requires an explicit artifact, bounds pages, and retains exact subject and kind filters', () => {
  assert.equal(functionGetArgsSchema.safeParse({ ...scope, view: 'investigation' }).success, false);
  const args = functionGetArgsSchema.parse({ ...scope, view: 'investigation', artifact_id,
    subject_id, kinds: ['call', 'unresolved'], page: { limit: 1 } });
  assert.equal(args.artifact_id, artifact_id);
  assert.equal(args.subject_id, subject_id);
  assert.deepEqual(args.kinds, ['call', 'unresolved']);
  assert.equal(args.page.limit, 1);
  assert.equal(args.include_quotes, undefined);
  assert.equal(functionGetArgsSchema.safeParse({ ...args, kinds: ['source'], include_quotes: true }).success, true);
  assert.equal(functionGetArgsSchema.safeParse({ ...args, page: { limit: 0 } }).success, false);
  assert.equal(functionGetArgsSchema.safeParse({ ...args, page: { limit: 1001 } }).success, false);
  assert.equal(functionGetArgsSchema.safeParse({ ...args, kinds: [] }).success, false);
  assert.equal(functionGetArgsSchema.safeParse({ ...args, kinds: ['invented_fact'] }).success, false);
  assert.equal(functionGetArgsSchema.safeParse({ ...args, artifact_id: 'latest' }).success, false);
  assert.equal(functionGetArgsSchema.safeParse({ ...args, subject_id: 'display_name' }).success, false);
});

test('metadata keeps its default and accepts explicit original subject plus optional trusted artifact scope', () => {
  assert.equal(functionGetArgsSchema.parse(scope).view, 'metadata');
  const args = functionGetArgsSchema.parse({ ...scope, subject_id, artifact_id });
  assert.equal(args.view, 'metadata');
  assert.equal(args.subject_id, subject_id);
  assert.equal(args.artifact_id, artifact_id);
  assert.equal(functionGetArgsSchema.safeParse({ ...scope, kinds: ['call'] }).success, false);
  assert.equal(functionGetArgsSchema.safeParse({ ...scope, include_quotes: true }).success, false);
  for (const view of ['cfg', 'disassembly']) {
    assert.equal(functionGetArgsSchema.safeParse({ ...scope, view, subject_id }).success, false);
    assert.equal(functionGetArgsSchema.safeParse({ ...scope, view, artifact_id }).success, false);
  }
});

test('artifact delivery preference is top-level and never changes analysis options or budget', () => {
  const automatic = functionDecompileArgsSchema.parse(scope);
  const artifact = functionDecompileArgsSchema.parse({ ...scope, delivery: 'artifact' });
  assert.equal(automatic.delivery, 'auto');
  assert.equal(artifact.delivery, 'artifact');
  assert.deepEqual(artifact.options, automatic.options);
  assert.deepEqual(artifact.budget, automatic.budget);
  assert.equal(functionDecompileArgsSchema.safeParse({ ...scope, delivery: 'inline' }).success, false);
  assert.equal(functionDecompileArgsSchema.safeParse({ ...scope, options: { delivery: 'artifact' } }).success, false);
});

test('compact native detail is explicit and restricted to public disassembly', () => {
  assert.equal(functionGetArgsSchema.parse({ ...scope, view: 'disassembly' }).detail, undefined);
  for (const detail of ['full', 'compact'])
    assert.equal(functionGetArgsSchema.parse({ ...scope, view: 'disassembly', detail }).detail, detail);
  for (const view of ['metadata', 'cfg', 'investigation'])
    assert.equal(functionGetArgsSchema.safeParse({ ...scope, view, artifact_id, detail: 'compact' }).success, false);
});

const allKinds = ['signature', 'parameter', 'type', 'interpretation', 'field', 'identity', 'call', 'rewrite',
  'conflict', 'annotation', 'fp_environment', 'unresolved', 'source', 'helper'] as const;
const helperDomain = 'renderer pseudocode semantic contract; not original source or an executable helper definition';
const helperLocator = 'result.data.emission.helpers[artifact_helper_index] in the selected artifact';

test('helper is the fourteenth bounded investigation kind and default selection covers it', () => {
  const investigation = { ...scope, view: 'investigation', artifact_id };
  assert.equal(allKinds.length, 14);
  assert.deepEqual(functionGetArgsSchema.parse({ ...investigation, kinds: [...allKinds] }).kinds, [...allKinds]);
  assert.deepEqual(functionGetArgsSchema.parse({ ...investigation, kinds: ['helper'] }).kinds, ['helper']);
  assert.equal(functionGetArgsSchema.parse(investigation).kinds, undefined);
  assert.equal(functionGetArgsSchema.safeParse({ ...investigation, kinds: [...allKinds, 'helper'] }).success, false);
  assert.equal(functionGetArgsSchema.safeParse({ ...investigation, kinds: ['helpers'] }).success, false);
  assert.equal(functionGetArgsSchema.safeParse({ ...scope, kinds: ['helper'] }).success, false);
  assert.equal(functionGetArgsSchema.safeParse({ ...investigation, kinds: ['helper'], page: { limit: 1000 } }).success, true);
  assert.equal(functionGetArgsSchema.safeParse({ ...investigation, kinds: ['helper'], page: { limit: 1001 } }).success, false);
});

const image = `image_${'5'.repeat(64)}`;
const counts = (helpers: { total: number; selected: number }) => ({
  inferences: { total: 0, selected: 0 }, requirements: { total: 0, selected: 0 },
  unresolved_sites: { total: 0, selected: 0 }, source_mappings: { total: 0, selected: 0 }, helpers,
});
const helperItem = (index: number, overrides: object = {}) => ({
  kind: 'helper', artifact_helper_index: index, name: `helper_${index}`, explanation: `contract ${index}`,
  semantic_domain: helperDomain, locator: helperLocator, ...overrides,
});
function investigationResult(items: unknown[], helpers = items.length, kinds: string[] | null = ['helper']) {
  return {
    schema_version: 1, project_id: scope.project_id, revision: scope.revision,
    versions: { backend: '1', loader: '1', decoder: null, lifter: null, analysis: null, abi: null, emitter: null },
    options: DEFAULT_ANALYSIS_OPTIONS, budget: DEFAULT_BUDGET, coverage: [], diagnostics: [], evidence: [], artifacts: [],
    state: items.length ? 'complete' : 'empty',
    data: {
      view: 'investigation', function_id: scope.function_id, artifact_id,
      record_lookup: 'original emission inference/requirement IDs and mapping indexes in the selected artifact',
      items, analysis_state: 'complete', proof_delivery: 'artifact_references',
      diagnostic_lookup: 'result.diagnostics[artifact_index] in the selected artifact',
      analysis_diagnostics: [], references: [],
      selection: { kinds, subject_id: null, quotes: false, counts: counts({ total: helpers, selected: items.length }),
        omitted_inference_statuses: {}, omitted_requirement_kinds: {} },
      helpers: [], page: { next_cursor: null, index_state: 'complete', order: 'id' },
    },
  };
}

test('helper items carry original index, exact untruncated name/explanation and an explicit renderer-contract label', () => {
  const parsed = functionGetResultSchema.parse(investigationResult([helperItem(0), helperItem(999, {
    name: 'n'.repeat(4096), explanation: 'e'.repeat(8192) })]));
  assert.ok('data' in parsed && parsed.data.view === 'investigation');
  const long = parsed.data.items[1];
  assert.ok(long?.kind === 'helper');
  assert.equal(long.explanation.length, 8192);
  assert.equal(long.semantic_domain, helperDomain);
  const invalid = (item: object) => functionGetResultSchema.safeParse(investigationResult([item])).success;
  assert.equal(invalid(helperItem(0, { explanation: 'e'.repeat(8193) })), false);
  assert.equal(invalid(helperItem(0, { explanation: '' })), false);
  assert.equal(invalid(helperItem(0, { name: '' })), false);
  assert.equal(invalid(helperItem(1000)), false);
  assert.equal(invalid(helperItem(-1)), false);
  assert.equal(invalid(helperItem(0, { semantic_domain: 'original source helper definition' })), false);
  assert.equal(invalid(helperItem(0, { locator: 'result.data.signature' })), false);
  assert.equal(invalid(helperItem(0, { instruction_refs: [] })), false);
  assert.equal(invalid(helperItem(0, { record: { id: 'x' } })), false);
});

test('helper pages keep the shared 1000-item bound and selection counts must report helper extent', () => {
  const items = Array.from({ length: 1000 }, (_, index) => helperItem(index % 1000));
  assert.equal(functionGetResultSchema.safeParse(investigationResult(items)).success, true);
  assert.equal(functionGetResultSchema.safeParse(investigationResult([...items, helperItem(0)])).success, false);
  assert.equal(functionGetResultSchema.safeParse(investigationResult([], 3, [...allKinds])).success, true);
  const missing = investigationResult([helperItem(0)]);
  const { helpers: _helpers, ...withoutHelpers } = missing.data.selection.counts;
  missing.data.selection.counts = withoutHelpers as typeof missing.data.selection.counts;
  assert.equal(functionGetResultSchema.safeParse(missing).success, false);
  assert.equal(functionGetResultSchema.safeParse(investigationResult([], 0, [...allKinds, 'helper'])).success, false);
});

const emission = {
  text: 'return;\n', declaration_span: { start: 0, end: 1 }, mappings: [], inferences: [], requirements: [],
  helpers: [{ name: 'field_view', explanation: 'First contract' }, { name: 'trunc_div', explanation: 'Second contract' }],
};
const payload = { result: { data: { emission, signature: null } } } as unknown as Parameters<typeof investigationItems>[2];
function itemScope(budget = { checkpoints: 0 }) {
  return { context: { checkpoint: () => { budget.checkpoints++; } } } as unknown as Parameters<typeof investigationItems>[0];
}
const queryArgs = (extra: object) => functionGetArgsSchema.parse({ ...scope, view: 'investigation', artifact_id, ...extra });

test('helper projection pages every original helper, honours kind/subject filters and checkpoints', () => {
  const only = investigationItems(itemScope(), queryArgs({ kinds: ['helper'] }), payload);
  assert.deepEqual(only.items.map((item) => item.kind), ['helper', 'helper']);
  assert.deepEqual(only.items.map((item) => item.kind === 'helper' && [item.artifact_helper_index, item.name, item.explanation]),
    [[0, 'field_view', 'First contract'], [1, 'trunc_div', 'Second contract']]);
  assert.deepEqual(only.selection.counts.helpers, { total: 2, selected: 2 });
  assert.deepEqual(only.helpers, [{ name: 'field_view', artifact_helper_index: 0 }, { name: 'trunc_div', artifact_helper_index: 1 }]);
  const page = investigationPage(only.items, only.instructionLocations);
  assert.deepEqual(page.items, only.items);
  assert.deepEqual(page.references, []);
  const everything = investigationItems(itemScope(), queryArgs({ include_quotes: false }), payload);
  assert.equal(everything.items.filter((item) => item.kind === 'helper').length, 2);
  assert.equal(everything.items.filter((item) => item.kind === 'signature').length, 1);
  const signatureOnly = investigationItems(itemScope(), queryArgs({ kinds: ['signature'] }), payload);
  assert.equal(signatureOnly.items.some((item) => item.kind === 'helper'), false);
  assert.deepEqual(signatureOnly.selection.counts.helpers, { total: 2, selected: 0 });
  const foreignSubject = investigationItems(itemScope(), queryArgs({ kinds: ['helper'], subject_id }), payload);
  assert.deepEqual(foreignSubject.items, []);
  assert.deepEqual(foreignSubject.selection.counts.helpers, { total: 2, selected: 0 });
  const budget = { checkpoints: 0 };
  investigationItems(itemScope(budget), queryArgs({ kinds: ['helper'] }), payload);
  assert.ok(budget.checkpoints >= 2, 'every helper is a cancellation/work checkpoint');
  const cancelled = { context: { checkpoint: () => { throw new Error('cancelled'); } } } as unknown as Parameters<typeof investigationItems>[0];
  assert.throws(() => investigationItems(cancelled, queryArgs({ kinds: ['helper'] }), payload), /cancelled/);
});
