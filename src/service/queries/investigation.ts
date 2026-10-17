import { fingerprint, type Artifact, type OperationContext, type ProjectStore, type ToolArgs,
  type ToolResult, type WireInference, type WireRequirement } from '../../core/index.js';
import { readAnalysisArtifact, type AnalysisArtifactPayload } from '../../project/cache/index.js';
import { acceptsAnalysisIdentity } from '../analysis/versions.js';
import { resolveDurableSubject } from '../../project/annotations/subjects.js';
import { queryFailure } from './shared.js';
import type { LoadedFunctionScope } from './scope.js';

type Scope = { readonly store: ProjectStore; readonly context: OperationContext };
type Args = ToolArgs<'function_get'>;
export interface SelectedInvestigationArtifact {
  readonly artifact: Artifact;
  readonly payload: AnalysisArtifactPayload;
}
type InvestigationData = Extract<Extract<ToolResult<'function_get'>, { data: unknown }>['data'], { view: 'investigation' }>;
export type InvestigationInstructionLocations = ReadonlyMap<string, WireInference['ranges'][number] | null>;
type InvestigationItem = InvestigationData['items'][number];
type PreparedInvestigationItem =
  | { kind: 'source'; span: { start: number; end: number }; text: string; mapping_indexes: number[]; instruction_ids: string[] }
  | Extract<InvestigationItem, { kind: 'signature' }>
  | Extract<InvestigationItem, { kind: 'helper' }>
  | { kind: 'inference'; record: Omit<Extract<InvestigationItem, { kind: 'inference' }>['record'], 'instruction_refs'> & { instruction_ids: string[] } }
  | { kind: 'requirement'; record: Omit<Extract<InvestigationItem, { kind: 'requirement' }>['record'], 'instruction_refs'> & { instruction_ids: string[] } };

/** Omit graph identities only; every scalar validator is shared with inference. */
function compactDetails(details: WireInference['details']): Extract<InvestigationItem, { kind: 'inference' }>['record']['details'] {
  switch (details.kind) {
    case 'parameter': {
      const { value_ids: _values, source_type_id, ...facts } = details;
      return { ...facts, source_type_known: source_type_id !== null };
    }
    case 'type': {
      const { association_ids: _subjects, type_id: _type, pointee_id, ...facts } = details;
      return { ...facts, pointee_known: pointee_id !== null };
    }
    case 'interpretation': {
      const { operand_value_ids: _values, ...facts } = details;
      return facts;
    }
    case 'field': {
      const { shape_id: _shape, field_ids: _fields, type_id: _type, ...facts } = details;
      return facts;
    }
    case 'identity': {
      const { value_ids: _values, ...facts } = details;
      return facts;
    }
    case 'call': {
      const { call_id: _call, signature_id, ordered_arguments, target, ...facts } = details;
      return { ...facts, signature_known: signature_id !== null,
        ordered_arguments: ordered_arguments.map(({ value_ids: _values, ...argument }) => argument),
        target: target.kind === 'direct' ? target : { kind: 'indirect' } };
    }
    case 'conflict': {
      const { alternatives, ...facts } = details;
      return { ...facts, alternative_count: alternatives.length };
    }
    case 'rewrite': case 'annotation': return details;
  }
}

/** Select only a published handle indexed under this original function. The cache
 * reader verifies the complete file hash, catalog, identity and proof closure.
 * No graph reconstruction, emitter dispatch or generated-text inference occurs. */
export function investigationArtifact(scope: Scope, args: Args, loaded: LoadedFunctionScope): SelectedInvestigationArtifact {
  if (!args.artifact_id) queryFailure('invalid_input', 'An explicit analysis artifact is required');
  if (scope.store.snapshot().revision !== args.revision)
    queryFailure('stale_revision', 'Investigation requires the current exact project revision');
  let cursor: string | undefined;
  let inspected = 0;
  do {
    scope.context.checkpoint(1);
    const page = scope.store.findAnalysisArtifacts({ revision: args.revision,
      ids: [args.function_id], limit: 100, ...(cursor ? { cursor } : {}) });
    for (const artifact of page.items) {
      scope.context.checkpoint(1);
      if (++inspected > 1000) queryFailure('resource_limit', 'Function artifact selection exceeds 1000 handles');
      if (artifact.id !== args.artifact_id) continue;
      const payload = readAnalysisArtifact(scope.store, artifact, scope.context);
      const identity = payload.identity;
      if (identity.function_id !== args.function_id || identity.annotation_revision !== args.revision ||
        identity.evidence_revision !== args.revision || identity.image_sha256 !== loaded.image.sha256 ||
        identity.slice_id !== loaded.image.selected_slice_id ||
        fingerprint(identity.target) !== fingerprint(loaded.image.target) || !acceptsAnalysisIdentity(identity))
        queryFailure('invalid_input', 'Analysis artifact function, image, target, revision or component scope does not match');
      return { artifact, payload };
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return queryFailure('not_found', 'Published artifact is absent from this exact function snapshot');
}

/** Review the requested original identity, never a rewritten display successor.
 * Referenced IR subjects can be reviewed without granting annotation authority. */
export function reviewedSubject(scope: Scope, args: Args, loaded: LoadedFunctionScope,
  selected?: SelectedInvestigationArtifact): { id: string; annotation_eligible: boolean } {
  const id = args.subject_id ?? args.function_id;
  if (id === args.function_id) return { id, annotation_eligible: true };
  if (selected) {
    if (selected.payload.catalog.subjects.some((subject) => subject.id === id))
      return { id, annotation_eligible: true };
    const emission = selected.payload.result.data.emission;
    if (!emission.inferences || !emission.requirements)
      queryFailure('invalid_input', 'Artifact lacks required structured investigation metadata');
    for (const record of emission.inferences) {
      scope.context.checkpoint(1);
      if (record.subject_ids.includes(id)) return { id, annotation_eligible: false };
    }
    for (const record of emission.requirements) {
      scope.context.checkpoint(1);
      if (record.subject_ids.includes(id)) return { id, annotation_eligible: false };
    }
    queryFailure('invalid_input', 'Subject is absent from the trusted function artifact scope');
  }
  const durable = resolveDurableSubject(scope.store, id, args.revision, scope.context);
  if (durable && durable.image_id === loaded.image.id && durable.slice_id === loaded.image.selected_slice_id &&
    durable.abi === loaded.image.target.abi) return { id, annotation_eligible: true };
  return queryFailure('invalid_input', 'Derived subject review requires an exact trusted function artifact');
}

/** Select exact mapped intervals, never parse generated text or invent facts. */
export function investigationItems(scope: Scope, args: Args, payload: AnalysisArtifactPayload) {
  const { emission, signature } = payload.result.data;
  if (!emission.inferences || !emission.requirements)
    queryFailure('invalid_input', 'Artifact lacks required structured investigation metadata');
  const inferences = emission.inferences, requirements = emission.requirements;
  const kinds = args.kinds ? new Set(args.kinds) : null;
  const includes = (kind: NonNullable<Args['kinds']>[number], subjects: readonly string[]) =>
    (!kinds || kinds.has(kind)) && (!args.subject_id || subjects.includes(args.subject_id));
  const items: PreparedInvestigationItem[] = [];
  const instructionLocations = new Map<string, WireInference['ranges'][number] | null>();
  for (const mapping of emission.mappings) {
    scope.context.checkpoint(1);
    if (mapping.instruction_ids.length !== 1 || mapping.ranges.length !== 1) continue;
    const id = mapping.instruction_ids[0]!, range = mapping.ranges[0]!;
    const prior = instructionLocations.get(id);
    if (prior === undefined) instructionLocations.set(id, range);
    else if (prior && (prior.start.image_id !== range.start.image_id || prior.start.space !== range.start.space ||
      prior.start.value !== range.start.value || prior.size !== range.size)) instructionLocations.set(id, null);
  }
  const quoteSource = args.include_quotes !== false && (!kinds || kinds.has('source'));
  const declaration = emission.declaration_span;
  if (quoteSource && !declaration)
    queryFailure('invalid_input', 'Artifact lacks exact declaration metadata required for body quotations');
  const selectedMappingIds = new Set<number>();
  const selectedMappings = quoteSource
    ? emission.mappings.flatMap((mapping, index) => {
      scope.context.checkpoint(1);
      if (mapping.end <= mapping.start || !mapping.instruction_ids.length ||
        (args.subject_id && mapping.statement_id !== args.subject_id && !mapping.semantic_ids.includes(args.subject_id)))
        return [];
      // Subtract the producer's exact declaration interval only. Root-ID note
      // mappings, body effects, and portions outside that interval are retained.
      const fragments: { mapping: typeof mapping; index: number; start: number; end: number }[] = [];
      if (mapping.start < declaration!.start)
        fragments.push({ mapping, index, start: mapping.start, end: Math.min(mapping.end, declaration!.start) });
      if (mapping.end > declaration!.end)
        fragments.push({ mapping, index, start: Math.max(mapping.start, declaration!.end), end: mapping.end });
      if (fragments.length) selectedMappingIds.add(index);
      return fragments;
    }).sort((a, b) => a.start - b.start || b.end - a.end) : [];
  const spans: { start: number; end: number }[] = [];
  for (const selected of selectedMappings) {
    scope.context.checkpoint(1);
    const prior = spans[spans.length - 1];
    if (prior && selected.start <= prior.end) prior.end = Math.max(prior.end, selected.end);
    else spans.push({ start: selected.start, end: selected.end });
  }
  let nextMapping = 0;
  const active: typeof selectedMappings = [];
  for (const span of spans) for (let start = span.start; start < span.end; start += 512) {
    scope.context.checkpoint(1);
    const end = Math.min(span.end, start + 512);
    while (nextMapping < selectedMappings.length && selectedMappings[nextMapping]!.start < end)
      active.push(selectedMappings[nextMapping++]!);
    const mapping_indexes: number[] = [], instructions = new Set<string>();
    let retained = 0;
    for (const selected of active) {
      scope.context.checkpoint(1 + selected.mapping.instruction_ids.length + selected.mapping.evidence_ids.length);
      if (selected.end <= start) continue;
      active[retained++] = selected;
      mapping_indexes.push(selected.index);
      for (const id of selected.mapping.instruction_ids) instructions.add(id);
    }
    active.length = retained;
    items.push({ kind: 'source', span: { start, end }, text: emission.text.slice(start, end),
      mapping_indexes, instruction_ids: [...instructions] });
  }
  if (includes('signature', [args.function_id])) {
    const compactSignature = signature ? { abi: signature.abi, variadic: signature.variadic,
      noreturn: signature.noreturn, parameter_count: signature.parameters.length } : null;
    items.push({ kind: 'signature', status: 'inferred', signature: compactSignature,
      locator: 'result.data.signature',
      parameters: inferences.flatMap((record) => {
        if (record.details.kind !== 'parameter') return [];
        const { value_ids: _values, source_type_id, ...facts } = record.details;
        return [{ ...facts, source_type_known: source_type_id !== null }];
      }).sort((a, b) => a.ordinal - b.ordinal) });
  }
  let selectedInferences = 0, selectedRequirements = 0, selectedSites = 0, totalSites = 0;
  const omittedStatuses: Partial<Record<WireInference['status'], number>> = {};
  const omittedKinds: Partial<Record<WireRequirement['kind'], number>> = {};
  for (const record of inferences) {
    scope.context.checkpoint(1);
    if (includes(record.details.kind, record.subject_ids)) {
      items.push({ kind: 'inference', record: { id: record.id, status: record.status,
        details: compactDetails(record.details), instruction_ids: record.instruction_ids } });
      selectedInferences++;
    } else omittedStatuses[record.status] = (omittedStatuses[record.status] ?? 0) + 1;
  }
  for (const record of requirements) {
    scope.context.checkpoint(1);
    if (record.kind === 'unresolved') totalSites += record.sites.length;
    if (includes(record.kind, record.subject_ids)) {
      items.push({ kind: 'requirement', record: { id: record.id, status: record.status,
        kind: record.kind, explanation: record.explanation, instruction_ids: record.instruction_ids,
        sites: record.sites.map(({ subject_ids: _subjects, evidence_ids: _proofs,
          instruction_ids: _instructions, predicate_value_id: _predicate, ...site }) => site) } });
      selectedRequirements++;
      if (record.kind === 'unresolved') selectedSites += record.sites.length;
    } else omittedKinds[record.kind] = (omittedKinds[record.kind] ?? 0) + 1;
  }
  // Every actual helper of the immutable artifact, in artifact order; the
  // semantic_domain label keeps the renderer-contract status explicit.
  let selectedHelpers = 0;
  if (includes('helper', [args.function_id]))
    for (const [artifact_helper_index, helper] of emission.helpers.entries()) {
      scope.context.checkpoint(1);
      items.push({ kind: 'helper', artifact_helper_index, name: helper.name, explanation: helper.explanation,
        semantic_domain: 'renderer pseudocode semantic contract; not original source or an executable helper definition',
        locator: 'result.data.emission.helpers[artifact_helper_index] in the selected artifact' });
      selectedHelpers++;
    }
  const selection: InvestigationData['selection'] = {
    kinds: args.kinds ?? null, subject_id: args.subject_id ?? null, quotes: args.include_quotes !== false,
    counts: { inferences: { total: inferences.length, selected: selectedInferences },
      requirements: { total: requirements.length, selected: selectedRequirements },
      unresolved_sites: { total: totalSites, selected: selectedSites },
      source_mappings: { total: emission.mappings.length, selected: selectedMappingIds.size },
      helpers: { total: emission.helpers.length, selected: selectedHelpers } },
    omitted_inference_statuses: omittedStatuses, omitted_requirement_kinds: omittedKinds,
  };
  return { items, selection, helpers: emission.helpers.map((helper, index) =>
    ({ name: helper.name, artifact_helper_index: index })), instructionLocations };
}

/** Page-local aliases pack repeated provenance once. Semantic details are the
 * unchanged strict inference/requirement records; aliases grant no new facts. */
export function investigationPage(items: readonly PreparedInvestigationItem[], locations: InvestigationInstructionLocations) {
  const references: string[] = [], indexes = new Map<string, number>();
  const intern = (ids: readonly string[]) => ids.map((id) => {
    const range = locations.get(id);
    const reference = range ? `${range.start.space}:${range.start.value}+${range.size}` : id;
    let index = indexes.get(reference);
    if (index === undefined) {
      if (references.length >= 10000) queryFailure('resource_limit', 'Investigation page reference bound exceeded');
      index = references.length;
      indexes.set(reference, index);
      references.push(reference);
    }
    return index;
  });
  return {
    items: items.map((item) => {
      if (item.kind === 'signature' || item.kind === 'helper') return item;
      if (item.kind === 'source') {
        const { instruction_ids, ...quotation } = item;
        return { ...quotation, instruction_refs: intern(instruction_ids) };
      }
      const { instruction_ids, ...facts } = item.record;
      return { ...item, record: { ...facts, instruction_refs: intern(instruction_ids) } };
    }),
    references,
  };
}
