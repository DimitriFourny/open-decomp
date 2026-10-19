import {
  CursorError,
  OperationError,
  decodeAddress,
  decodeCursor,
  decodeRange,
  encodeCursor,
  encodeArtifact,
  encodeDiagnostic,
  encodeSigned,
  fingerprint,
  formatHexU64,
  toolSchemas,
} from '../../core/index.js';
import type {
  Address,
  CanonicalValue,
  CursorBinding,
  Evidence,
  FunctionRecord,
  LoadedImage,
  OperationContext,
  ProjectStore,
  ResultMetadata,
  StoredRecordKinds,
  Target,
  ToolArgs,
  ToolName,
  ToolResult,
} from '../../core/index.js';
import { cSourceName } from '../../metadata/symbols/c-names.js';
import type { WorkerHandler } from '../../workers/runtime.js';
import { wireValue } from '../../project/store/encoding.js';
import { MAX_FRAME_BYTES } from '../../workers/protocol.js';
import { prepareQueryImport } from './prepare.js';
import { queryEnvelope, queryFailure } from './shared.js';
import {
  loadImage,
  records,
  loadFunctionScope,
  loadFunctionGraph,
  type IndexState,
} from './scope.js';
import { executeDecompilation, executeAnnotations } from '../analysis/index.js';
import {
  investigationArtifact,
  investigationItems,
  investigationPage,
  reviewedSubject,
} from './investigation.js';

type PageArgs = {
  project_id: string;
  revision: number;
  budget: OperationContext['budget'];
  page: { limit: number; cursor?: string | undefined };
};
type Paging = { readonly binding: CursorBinding; readonly after: string };
type Scope = {
  readonly store: ProjectStore;
  readonly context: OperationContext;
  readonly job_id: string;
  readonly paging?: Paging;
  readonly max_result_bytes?: number;
};
type Query = {
  readonly text: string;
  readonly match: 'exact' | 'prefix' | 'contains';
  readonly case_sensitive: boolean;
};
/** Symbol names match natively or by their C source spelling (one Mach-O underscore removed);
 * a null format compares literal text only. */
function matches(
  query: Query,
  format: Target['format'] | null,
  ...values: readonly (string | null)[]
): boolean {
  if (query.text === '' && query.match !== 'exact') return true;
  const text = query.case_sensitive ? query.text : query.text.toLowerCase();
  return values.some((value) => {
    if (value === null) return false;
    return (format === null ? [value] : [value, cSourceName(format, value)]).some((name) => {
      const candidate = query.case_sensitive ? name : name.toLowerCase();
      return query.match === 'exact'
        ? candidate === text
        : query.match === 'prefix'
          ? candidate.startsWith(text)
          : candidate.includes(text);
    });
  });
}
function addressKey(address: Address | null, id: string): string {
  return `${address ? address.value.toString(16).padStart(16, '0') : '~~~~~~~~~~~~~~~~'}:${id}`;
}
function virtual(image: LoadedImage, address: Address): Address {
  if (address.image_id !== image.id)
    queryFailure('invalid_address', 'Address belongs to another image');
  if (address.space === 'va') return address;
  if (address.space === 'rva') {
    const value = image.image_base + address.value;
    if (value >= 1n << 64n) queryFailure('invalid_address', 'RVA exceeds the address space');
    return { ...address, space: 'va', value };
  }
  const translated = image.address_map.translate(address, 'va');
  if (translated.kind !== 'mapped')
    queryFailure('invalid_address', 'File offset has no virtual mapping');
  return translated.address;
}
/** Only a unique active assertion changes presentation. Native names stay searchable. */
function presentName<T extends { readonly id: string; readonly display_name: string | null }>(
  scope: Scope,
  revision: number,
  record: T,
): T {
  const names = new Set(
    scope.store
      .readAnnotations(record.id, revision)
      .filter((item) => item.status === 'asserted' && item.value.kind === 'name')
      .map((item) => (item.value.kind === 'name' ? item.value.value : '')),
  );
  return names.size === 1 ? { ...record, display_name: [...names][0]! } : record;
}
/** Batch form of presentName: one bounded annotation query per 1000 entities, never one
 * store round trip per image function. Presentation is identical to presentName. */
function presentNames<T extends { readonly id: string; readonly display_name: string | null }>(
  scope: Scope,
  revision: number,
  records: readonly T[],
): T[] {
  const named = new Map<string, Set<string>>();
  for (let start = 0; start < records.length; start += 1000) {
    const entity_ids = records.slice(start, start + 1000).map((record) => record.id);
    let cursor: string | undefined;
    do {
      scope.context.checkpoint(1);
      const page = scope.store.queryAnnotations({
        revision,
        entity_ids,
        limit: 1000,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const item of page.items) {
        if (item.status !== 'asserted' || item.value.kind !== 'name') continue;
        const names = named.get(item.entity_id) ?? new Set<string>();
        names.add(item.value.value);
        named.set(item.entity_id, names);
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);
  }
  return records.map((record) => {
    const names = named.get(record.id);
    return names?.size === 1 ? { ...record, display_name: [...names][0]! } : record;
  });
}
function resultEvidence(
  scope: Scope,
  revision: number,
  data: unknown,
  local: readonly Evidence[] = [],
): unknown {
  const ids = new Set<string>();
  const collect = (value: unknown): void => {
    scope.context.checkpoint(1);
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
    } else if (value !== null && typeof value === 'object')
      for (const [field, item] of Object.entries(value)) {
        if (field === 'evidence_ids' && Array.isArray(item))
          for (const id of item) {
            if (typeof id === 'string') ids.add(id);
          }
        else collect(item);
      }
  };
  collect(data);
  const evidence = [];
  const localById = new Map(local.map((item) => [item.id, item]));
  const pending = [...ids];
  let offset = 0;
  while (offset < pending.length) {
    scope.context.checkpoint(1);
    if (pending.length > 10000)
      queryFailure('resource_limit', 'Query evidence exceeds the result bound');
    const requested = pending.slice(offset, offset + 1000);
    offset += requested.length;
    const durable = requested.filter((id) => !localById.has(id));
    const batch = [
      ...requested.flatMap((id) => {
        const proof = localById.get(id);
        return proof ? [proof] : [];
      }),
      ...(durable.length ? scope.store.readEvidence(durable, revision) : []),
    ];
    for (const item of batch) {
      scope.context.checkpoint(1);
      evidence.push(item);
      for (const dependency of [...item.derived_from, ...item.conflicts_with])
        if (!ids.has(dependency)) {
          ids.add(dependency);
          pending.push(dependency);
        }
    }
  }
  return wireValue(evidence);
}
/** Validate before reading snapshot data, including pre-publication historical images. */
function pageState(operation: ToolName, args: PageArgs): Paging {
  const { budget: _budget, page: _page, ...query } = args;
  const binding = {
    project_id: args.project_id,
    revision: args.revision,
    operation,
    query_hash: fingerprint({
      query: wireValue(query) as CanonicalValue,
      traversal:
        operation === 'function_get' ? [args.budget.instructions, args.budget.blocks] : null,
    }),
  };
  let after = '';
  if (args.page.cursor) {
    try {
      const cursor = decodeCursor(args.page.cursor, binding);
      if (cursor.after.length !== 1) queryFailure('invalid_cursor', 'Invalid page sort key');
      after = cursor.after[0]!;
    } catch (error) {
      if (error instanceof CursorError)
        throw new OperationError({
          code: error.code,
          severity: 'error',
          message: error.message,
          evidence_ids: [],
        });
      throw error;
    }
  }
  return { binding, after };
}
function paginate<T>(
  scope: Scope,
  operation: ToolName,
  args: PageArgs,
  source: readonly T[],
  state: IndexState,
  key: (item: T, index: number) => string,
  extra: Record<string, unknown> = {},
  order: 'address_id' | 'id' = 'address_id',
  partialReason: 'budget' | 'incomplete_index' = 'incomplete_index',
  details?: Pick<ResultMetadata, 'coverage' | 'diagnostics'> &
    Partial<Pick<ResultMetadata, 'artifacts'>>,
  localEvidence: readonly Evidence[] = [],
  evidenceDelivery: 'inline' | 'by_reference' | 'artifact' = 'by_reference',
  projectPage?: (items: readonly T[]) => object,
): unknown {
  const { binding, after } = scope.paging ?? pageState(operation, args);
  const candidates: { item: T; key: string }[] = [];
  for (let index = 0; index < source.length; index++) {
    const item = source[index]!;
    scope.context.checkpoint(1);
    const sortKey = key(item, index);
    if (sortKey > after) candidates.push({ item, key: sortKey });
  }
  candidates.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let count = Math.min(args.page.limit, candidates.length);
  const envelope = queryEnvelope(args.project_id, args.revision, args.budget);
  for (;;) {
    scope.context.checkpoint(1);
    const more = count < candidates.length;
    const next_cursor = more
      ? encodeCursor({
          ...binding,
          version: 1,
          after: [count ? candidates[count - 1]!.key : after],
        })
      : null;
    const selected = candidates.slice(0, count).map((entry) => entry.item);
    const data = {
      ...extra,
      ...(wireValue(projectPage ? projectPage(selected) : { items: selected }) as object),
      page: { next_cursor, index_state: state, order, evidence_delivery: evidenceDelivery },
    };
    const metadata = {
      ...envelope,
      ...details,
      evidence:
        evidenceDelivery === 'inline'
          ? resultEvidence(scope, args.revision, [data, details?.diagnostics], localEvidence)
          : [],
    };
    const result =
      state !== 'complete'
        ? { ...metadata, state: 'partial', reason: partialReason, continuation: next_cursor, data }
        : more && count < args.page.limit
          ? {
              ...metadata,
              state: 'partial',
              reason: 'output_limit',
              continuation: next_cursor,
              data,
            }
          : { ...metadata, state: count ? 'complete' : 'empty', data };
    if (
      Buffer.byteLength(JSON.stringify(result)) <=
      Math.min(
        args.budget.output_bytes,
        scope.max_result_bytes ?? Infinity,
        MAX_FRAME_BYTES - 16384,
      )
    )
      return result;
    if (count <= 1)
      queryFailure(
        'resource_limit',
        'One query item exceeds the output budget; increase output_bytes',
      );
    count = Math.floor(count / 2);
  }
}
function encodeInstruction(instruction: unknown): unknown {
  // Signed operand scalars have a different wire shape from addresses/bit patterns.
  function visit(value: unknown, field = '', arm = false): unknown {
    if (typeof value === 'bigint')
      return field === 'displacement' || (arm && field === 'value')
        ? encodeSigned(value)
        : formatHexU64(value);
    if (Array.isArray(value)) return value.map((item) => visit(item, '', arm));
    if (value !== null && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      const signedImmediate = arm && object['kind'] === 'immediate';
      const inArm = object['architecture'] === 'arm64' || arm;
      return Object.fromEntries(
        Object.entries(object).map(([name, item]) => [
          name,
          visit(item, name, name === 'value' ? signedImmediate : inArm),
        ]),
      );
    }
    return value;
  }
  return visit(instruction);
}

/** Statically composed child service; CPU work and durable mutations stay with
 * the owning project process, never the protocol host. */
export const queryWorkerHandler: WorkerHandler = {
  prepareImport: prepareQueryImport,
  async execute<K extends ToolName>(
    operation: K,
    input: ToolArgs<K>,
    scope: Scope,
  ): Promise<ToolResult<K>> {
    const result = await dispatch(operation, input, scope);
    const parsed = toolSchemas[operation].output.parse(result) as ToolResult<K>;
    if (
      Buffer.byteLength(JSON.stringify(parsed)) >
      Math.min(
        scope.context.budget.output_bytes,
        scope.max_result_bytes ?? Infinity,
        MAX_FRAME_BYTES - 16384,
      )
    )
      queryFailure(
        'resource_limit',
        'Query result exceeds the operation or transport delivery limit',
      );
    return parsed;
  },
};
async function dispatch(
  operation: ToolName,
  input: unknown,
  suppliedScope: Scope,
): Promise<unknown> {
  const parsed = toolSchemas[operation].input.parse(input);
  const common = parsed as {
    project_id: string;
    revision: number;
    budget: OperationContext['budget'];
  };
  if (common.project_id !== suppliedScope.store.project_id)
    queryFailure('permission_denied', 'Query belongs to another project');
  if (operation === 'function_decompile')
    return executeDecompilation(parsed as ToolArgs<'function_decompile'>, suppliedScope);
  if (operation === 'annotations_apply')
    return executeAnnotations(parsed as ToolArgs<'annotations_apply'>, suppliedScope);
  const scope: Scope =
    'page' in parsed ? { ...suppliedScope, paging: pageState(operation, parsed) } : suppliedScope;
  scope.store.snapshot(common.revision);
  scope.context.checkpoint(0);
  const envelope = queryEnvelope(common.project_id, common.revision, common.budget);
  switch (operation) {
    case 'binary_info': {
      const args = toolSchemas.binary_info.input.parse(input);
      let imageId = args.image_id;
      if (imageId === undefined) {
        const images = scope.store.snapshot(args.revision).images;
        if (images.length === 0) queryFailure('not_found', 'Requested snapshot contains no image');
        if (images.length !== 1)
          queryFailure(
            'ambiguous_slice',
            'An explicit image ID is required for a multi-image snapshot',
          );
        imageId = images[0]!.image_id;
      }
      const image = loadImage(scope.store, args.revision, imageId);
      if (args.view === 'summary') {
        const partial = image.capabilities.some(
          (capability) =>
            (capability.layer === 'format' || capability.layer === 'analysis') &&
            capability.status === 'partial',
        );
        return {
          ...envelope,
          diagnostics: image.diagnostics.map(encodeDiagnostic),
          ...(partial
            ? { state: 'partial', reason: 'incomplete_index', continuation: null }
            : { state: 'complete' }),
          data: {
            view: 'summary',
            image: wireValue({
              id: image.id,
              sha256: image.sha256,
              byte_length: BigInt(image.bytes.length),
              selected_slice_id: image.selected_slice_id,
              image_base: image.image_base,
              target: image.target,
              slices: image.slices,
              entry_points: image.entry_points,
              capabilities: image.capabilities,
            }),
          },
        };
      }
      const values: readonly unknown[] = image[args.view];
      return paginate(
        scope,
        operation,
        args,
        values,
        'complete',
        (item, index) => {
          const record = item as {
            id?: string;
            name?: string;
            feature?: string;
            value?: bigint;
            range?: { start: Address };
          };
          return `${record.id ?? record.name ?? record.feature ?? record.value?.toString(16).padStart(16, '0') ?? ''}:${index}`;
        },
        { view: args.view },
        'id',
        'incomplete_index',
        { coverage: [], diagnostics: image.diagnostics.map(encodeDiagnostic) },
      );
    }
    case 'symbols_find': {
      const args = toolSchemas.symbols_find.input.parse(input),
        image = loadImage(scope.store, args.revision, args.image_id);
      const address = args.address ? virtual(image, decodeAddress(args.address)).value : null;
      const output: {
        kind: 'symbol' | 'import' | 'export';
        symbol?: StoredRecordKinds['symbol'];
        import?: StoredRecordKinds['import'];
        export?: StoredRecordKinds['export'];
        id: string;
        location: Address | null;
      }[] = [];
      let state: IndexState = 'complete';
      for (const kind of new Set(args.kinds)) {
        const page = records(scope, args.revision, image.id, kind);
        if (page.state !== 'complete') state = page.state;
        const candidates = page.items.filter((item) => {
          const location = 'slot' in item ? (item.callable_entry ?? item.slot) : item.address;
          return (
            address === null ||
            location?.value === address ||
            ('slot' in item && item.slot?.value === address)
          );
        });
        const presentedItems = presentNames(scope, args.revision, candidates);
        for (const [index, item] of candidates.entries()) {
          const location = 'slot' in item ? (item.callable_entry ?? item.slot) : item.address;
          const presented = presentedItems[index]!;
          if (
            matches(
              args.query,
              image.target.format,
              item.original_name,
              item.display_name,
              presented.display_name,
            )
          )
            output.push({ kind, [kind]: presented, id: item.id, location });
        }
      }
      const result = paginate(scope, operation, args, output, state, (item) =>
        addressKey(item.location, `${item.kind}:${item.id}`),
      ) as { data: { items: Record<string, unknown>[] } };
      result.data.items = result.data.items.map(
        ({ id: _id, location: _location, ...item }) => item,
      );
      return result;
    }
    case 'strings_find': {
      const args = toolSchemas.strings_find.input.parse(input),
        image = loadImage(scope.store, args.revision, args.image_id),
        page = records(scope, args.revision, image.id, 'string');
      const range = args.range ? decodeRange(args.range) : null;
      if (range && range.start.image_id !== image.id)
        queryFailure('invalid_address', 'String range belongs to another image');
      return paginate(
        scope,
        operation,
        args,
        page.items.filter((item) => {
          if (
            !matches(args.query, null, item.text) ||
            !args.encodings.includes(item.encoding) ||
            (args.status !== 'all' && item.status !== args.status)
          )
            return false;
          if (!range) return true;
          const translated = image.address_map.translate(item.address, range.start.space);
          return (
            translated.kind !== 'unmapped' &&
            translated.address.value >= range.start.value &&
            translated.address.value < range.start.value + range.size
          );
        }),
        page.state,
        (item) => addressKey(item.address, item.id),
      );
    }
    case 'functions_find': {
      const args = toolSchemas.functions_find.input.parse(input),
        image = loadImage(scope.store, args.revision, args.image_id),
        page = records(scope, args.revision, image.id, 'function');
      const address = args.address ? virtual(image, decodeAddress(args.address)).value : null;
      const selected: FunctionRecord[] = [];
      const candidates = page.items.filter(
        (item) =>
          (!args.id || item.id === args.id) &&
          (!args.id_prefix || item.id.startsWith(args.id_prefix)) &&
          (!args.boundary || item.boundary === args.boundary) &&
          (!args.analysis || item.analysis === args.analysis) &&
          (address === null ||
            item.entry.value === address ||
            item.ranges.some(
              (range) => address >= range.start.value && address < range.start.value + range.size,
            )),
      );
      const presentedItems = presentNames(scope, args.revision, candidates);
      for (const [index, item] of candidates.entries()) {
        const presented = presentedItems[index]!;
        if (
          matches(
            args.query,
            image.target.format,
            item.original_name,
            item.display_name,
            presented.display_name,
          )
        )
          selected.push(presented);
      }
      return paginate(scope, operation, args, selected, page.state, (item) =>
        addressKey(item.entry, item.id),
      );
    }
    case 'function_get': {
      const args = toolSchemas.function_get.input.parse(input);
      const loaded = loadFunctionScope(scope, args.revision, args.function_id),
        fn = loaded.function;
      const selected = args.artifact_id ? investigationArtifact(scope, args, loaded) : undefined;
      if (args.view === 'investigation') {
        if (!selected) queryFailure('invalid_input', 'An explicit analysis artifact is required');
        if (args.subject_id) reviewedSubject(scope, args, loaded, selected);
        const result = selected.payload.result;
        const projection = investigationItems(scope, args, selected.payload);
        return paginate(
          scope,
          operation,
          args,
          projection.items,
          'complete',
          (_item, index) => index.toString().padStart(10, '0'),
          {
            view: 'investigation',
            function_id: fn.id,
            artifact_id: selected.artifact.id,
            record_lookup:
              'original emission inference/requirement IDs and mapping indexes in the selected artifact',
            analysis_state: result.state,
            proof_delivery: 'artifact_references',
            selection: projection.selection,
            helpers: projection.helpers,
            diagnostic_lookup: 'result.diagnostics[artifact_index] in the selected artifact',
            analysis_diagnostics: result.diagnostics.map(
              ({ message: _message, entity_id, evidence_ids, ...diagnostic }, artifact_index) => ({
                ...diagnostic,
                artifact_index,
                entity_known: entity_id !== undefined,
                evidence_count: evidence_ids.length,
              }),
            ),
          },
          'id',
          'incomplete_index',
          {
            coverage: result.coverage,
            diagnostics: [],
            artifacts: [encodeArtifact(selected.artifact)],
          },
          [],
          'artifact',
          (items) => investigationPage(items, projection.instructionLocations),
        );
      }
      if (args.view === 'metadata') {
        const subject = reviewedSubject(scope, args, loaded, selected);
        const annotations = scope.store.readAnnotations(subject.id, args.revision);
        const assertedNames = new Set(
          annotations.flatMap((item) =>
            item.status === 'asserted' && item.value.kind === 'name' ? [item.value.value] : [],
          ),
        );
        const data = {
          view: 'metadata',
          evidence_delivery: 'by_reference',
          reviewed_subject_id: subject.id,
          annotation_eligible: subject.annotation_eligible,
          function: wireValue({
            ...presentName(scope, args.revision, fn),
            signature: scope.store.readSignature(fn.id, args.revision) ?? fn.signature,
          }),
          annotations: wireValue(annotations),
          lineage: scope.store.readLineage(subject.id, args.revision),
        };
        return {
          ...envelope,
          artifacts: selected ? [encodeArtifact(selected.artifact)] : [],
          evidence: [],
          diagnostics:
            assertedNames.size > 1
              ? [
                  {
                    code: 'conflicting_evidence',
                    severity: 'warning',
                    message: 'Incompatible active asserted names remain separate annotations',
                    entity_id: subject.id,
                    evidence_ids: [],
                  },
                ]
              : [],
          state: 'complete',
          data,
        };
      }
      const graph = loadFunctionGraph(
        scope,
        args.revision,
        loaded,
        args.view === 'disassembly' && args.detail === 'compact',
      );
      const state = graph.coverage.state === 'complete' ? 'complete' : 'partial';
      const partialReason = graph.gaps.some((gap) => gap.reason === 'budget')
        ? 'budget'
        : 'incomplete_index';
      const details = {
        coverage: [graph.coverage],
        diagnostics: graph.diagnostics.map(encodeDiagnostic),
      };
      if (args.view === 'disassembly')
        return paginate(
          scope,
          operation,
          args,
          graph.instructions.map(
            (item) =>
              encodeInstruction(
                args.detail === 'compact'
                  ? {
                      id: item.id,
                      address: item.address,
                      size: item.size,
                      validity: item.validity,
                      architecture: item.payload?.architecture ?? loaded.image.target.architecture,
                      flow: item.flow,
                      diagnostics: item.diagnostics,
                      evidence_ids: item.evidence_ids,
                      presentation: graph.presentations?.get(item.id) ?? null,
                    }
                  : item,
              ) as { id: string; address: { value: string } },
          ),
          state,
          (item) => `${BigInt(item.address.value).toString(16).padStart(16, '0')}:${item.id}`,
          {
            view: args.view,
            function_id: fn.id,
            ...(args.detail === 'compact' ? { detail: 'compact' } : {}),
            gaps: wireValue(graph.gaps.map(({ range, reason }) => ({ range, reason }))),
          },
          'address_id',
          partialReason,
          details,
          graph.evidence,
          'inline',
        );
      return paginate(
        scope,
        operation,
        args,
        graph.blocks,
        state,
        (item) => addressKey(item.ranges[0]!.start, item.id),
        { view: args.view, function_id: fn.id },
        'address_id',
        partialReason,
        details,
        graph.evidence,
        'inline',
      );
    }
    case 'xrefs_get': {
      const args = toolSchemas.xrefs_get.input.parse(input);
      const output: StoredRecordKinds['reference'][] = [];
      let state: IndexState = 'complete';
      let found = false;
      for (const stored of scope.store.snapshot(args.revision).images) {
        if (args.target.kind === 'address' && stored.image_id !== args.target.address.image_id)
          continue;
        const image = loadImage(scope.store, args.revision, stored.image_id),
          page = records(scope, args.revision, image.id, 'reference');
        if (page.state !== 'complete') state = page.state;
        const target = args.target;
        const address =
          target.kind === 'address' ? virtual(image, decodeAddress(target.address)).value : null;
        if (target.kind === 'address') found = true;
        else {
          found ||= page.items.some(
            (item) =>
              item.from_instruction === target.id ||
              item.to_entity === target.id ||
              item.from_function === target.id,
          );
          for (const kind of ['function', 'string', 'symbol', 'import', 'export'] as const)
            if (
              records(scope, args.revision, image.id, kind).items.some(
                (item) => item.id === target.id,
              )
            )
              found = true;
        }
        for (const item of page.items) {
          const incoming =
            target.kind === 'entity' ? item.to_entity === target.id : item.to?.value === address;
          const outgoing =
            target.kind === 'entity'
              ? item.from_function === target.id || item.from_instruction === target.id
              : item.from.value === address;
          if (
            ((args.direction !== 'outgoing' && incoming) ||
              (args.direction !== 'incoming' && outgoing)) &&
            args.kinds.includes(item.kind) &&
            (args.include_unresolved || item.status !== 'unresolved')
          )
            output.push(item);
        }
      }
      if (!found)
        queryFailure('not_found', 'Reference target is absent from the requested snapshot');
      return paginate(scope, operation, args, output, state, (item) =>
        addressKey(item.from, item.id),
      );
    }
    case 'evidence_get': {
      const args = toolSchemas.evidence_get.input.parse(input);
      const requested = new Set(args.evidence_ids);
      const found = new Map<string, Evidence>();
      const seen = new Set(requested);
      const absent = new Set<string>();
      let pending = [...requested];
      while (pending.length) {
        scope.context.checkpoint(1);
        const batch = pending.slice(0, 1000);
        pending = pending.slice(1000);
        const records = scope.store.readEvidence(batch, args.revision);
        for (const record of records) {
          scope.context.checkpoint(1);
          found.set(record.id, record);
          if (args.derivation === 'closure')
            for (const dependency of [...record.derived_from, ...record.conflicts_with])
              if (!seen.has(dependency)) {
                seen.add(dependency);
                pending.push(dependency);
              }
        }
        for (const id of batch) if (!found.has(id)) absent.add(id);
        if (seen.size > 10000)
          queryFailure('resource_limit', 'Evidence closure exceeds the traversal bound');
      }
      if ([...requested].some((id) => absent.has(id)))
        queryFailure('not_found', 'Requested evidence is absent from the requested snapshot');
      return paginate(
        scope,
        operation,
        args,
        [...found.values()],
        'complete',
        (item) => item.id,
        {},
        'id',
        'incomplete_index',
        {
          coverage: [],
          diagnostics: absent.size
            ? [
                {
                  code: 'not_found',
                  severity: 'warning',
                  message:
                    'Derived or conflicting evidence referenced by returned records is absent from the requested snapshot',
                  evidence_ids: [...absent].slice(0, 1000),
                },
              ]
            : [],
        },
      );
    }
    case 'memory_read':
      return readMemory(toolSchemas.memory_read.input.parse(input), scope);
    default:
      return queryFailure(
        'unavailable_semantics',
        `No query implementation is registered for ${operation}`,
      );
  }
}

function readMemory(args: ToolArgs<'memory_read'>, scope: Scope): unknown {
  const image = loadImage(scope.store, args.revision, args.address.image_id),
    address = decodeAddress(args.address);
  if (address.space === 'rva' && image.image_base + address.value + BigInt(args.length) > 1n << 64n)
    queryFailure('invalid_address', 'RVA read exceeds the address space');
  const widths = {
    bytes: 1,
    u8: 1,
    i8: 1,
    u16: 2,
    i16: 2,
    u32: 4,
    i32: 4,
    f32: 4,
    u64: 8,
    i64: 8,
    f64: 8,
    pointer: 8,
  } as const;
  const width = widths[args.interpretation],
    envelope = queryEnvelope(args.project_id, args.revision, args.budget);
  // Hex plus typed address records are bounded before allocating or serializing IPC.
  let length = Math.min(
    args.length,
    Math.max(
      width,
      Math.floor(
        (Math.min(
          args.budget.output_bytes,
          scope.max_result_bytes ?? Infinity,
          MAX_FRAME_BYTES - 16384,
        ) -
          900) /
          (args.interpretation === 'bytes' ? 2 : 240),
      ) * width,
    ),
  );
  length -= length % width;
  for (;;) {
    scope.context.checkpoint(length);
    const spans = image.address_map.spans(address, BigInt(length));
    const segments = spans.map((span) => {
      if (span.kind !== 'mapped') return { kind: span.kind, range: wireValue(span.range) };
      const bytes = image.bytes.read(span.file_offset!, Number(span.range.size));
      return {
        kind: span.kind,
        range: wireValue(span.range),
        bytes_hex: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex'),
      };
    });
    const values: { address: unknown; type: string; bits: string }[] = [];
    let spanIndex = 0;
    if (args.interpretation !== 'bytes')
      for (let offset = 0; offset < length; offset += width) {
        const at = { ...address, value: address.value + BigInt(offset) };
        let bits = 0n,
          unmapped = false;
        for (let index = 0; index < width; index++) {
          const value = at.value + BigInt(index);
          while (value >= spans[spanIndex]!.range.start.value + spans[spanIndex]!.range.size)
            spanIndex++;
          const span = spans[spanIndex]!;
          if (span.kind === 'unmapped') {
            unmapped = true;
            continue;
          }
          const byte =
            span.kind === 'zero_fill'
              ? 0
              : image.bytes.at(Number(span.file_offset! + value - span.range.start.value));
          const shift = args.endian === 'little' ? index : width - index - 1;
          bits |= BigInt(byte) << BigInt(shift * 8);
        }
        if (!unmapped)
          values.push({
            address: wireValue(at),
            type: args.interpretation,
            bits: formatHexU64(bits),
          });
      }
    const next_address =
      length < args.length
        ? wireValue({ ...address, value: address.value + BigInt(length) })
        : null;
    const data = {
      requested: wireValue({ start: address, size: BigInt(args.length) }),
      segments,
      values,
      next_address,
    };
    const result = next_address
      ? { ...envelope, state: 'partial', reason: 'output_limit', continuation: null, data }
      : { ...envelope, state: 'complete', data };
    if (
      Buffer.byteLength(JSON.stringify(result)) <=
      Math.min(
        args.budget.output_bytes,
        scope.max_result_bytes ?? Infinity,
        MAX_FRAME_BYTES - 16384,
      )
    )
      return result;
    if (length <= width)
      queryFailure('resource_limit', 'Memory result metadata exceeds output budget');
    length = Math.max(width, Math.floor(length / width / 2) * width);
  }
}
