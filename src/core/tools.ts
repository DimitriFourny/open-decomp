import { z } from 'zod';
import {
  inferenceSchema,
  requirementSchema,
  guessDetailsSchemas,
  inferenceDetailsByKind,
  requirementSiteSchema,
  outputSpanSchema,
  emissionRefsSchema,
  evidenceRefIndexesSchema,
  presentationRuleSchema,
} from './inference.js';
import {
  SCHEMA_VERSION,
  projectIdSchema,
  imageIdSchema,
  sliceIdSchema,
  entityIdSchema,
  jobIdSchema,
  revisionSchema,
  addressSchema,
  rangeSchema,
  hexU64Schema,
  targetSchema,
  diagnosticSchema,
  evidenceSchema,
  evidenceIdSchema,
  capabilitySchema,
  coverageSchema,
  versionsSchema,
  budgetSchema,
  DEFAULT_BUDGET,
  analysisOptionsSchema,
  DEFAULT_ANALYSIS_OPTIONS,
  pageRequestSchema,
  artifactSchema,
} from './primitives.js';
import {
  imageSummarySchema,
  headerSchema,
  sectionSchema,
  mappingSchema,
  relocationSchema,
  hintSchema,
  symbolSchema,
  importSchema,
  exportSchema,
  functionSchema,
  stringRecordSchema,
  referenceSchema,
  signatureSchema,
  annotationEditSchema,
  annotationSchema,
  lineageSchema,
} from './model.js';
import { instructionSchema, cfgBlockSchema } from './decoder.js';
import type { Internal } from './primitives.js';

export const toolNameSchema = z.enum([
  'project_open',
  'project_close',
  'binary_info',
  'symbols_find',
  'strings_find',
  'functions_find',
  'function_get',
  'function_decompile',
  'xrefs_get',
  'evidence_get',
  'memory_read',
  'annotations_apply',
  'functions_discover',
  'analysis_status',
  'analysis_cancel',
]);
export const jobSchema = z
  .strictObject({
    id: jobIdSchema,
    project_id: projectIdSchema,
    input_revision: revisionSchema,
    operation: toolNameSchema,
    state: z.enum(['queued', 'running', 'completed', 'cancelled', 'failed', 'stale']),
    progress: z.strictObject({
      phase: z.string().min(1).max(128),
      completed: revisionSchema,
      total: revisionSchema.nullable(),
    }),
    artifacts: z.array(artifactSchema).max(1000),
    diagnostics: z.array(diagnosticSchema).max(1000),
    published_revision: revisionSchema.nullable(),
  })
  .superRefine((job, context) => {
    if (job.progress.total !== null && job.progress.completed > job.progress.total)
      context.addIssue({ code: 'custom', message: 'Job progress exceeds total' });
    if (
      job.published_revision !== null &&
      (job.state !== 'completed' || job.published_revision !== job.input_revision)
    )
      context.addIssue({
        code: 'custom',
        message: 'Only completed jobs may publish at their input revision',
      });
    if (
      job.artifacts.some(
        (artifact) =>
          artifact.project_id !== job.project_id || artifact.revision !== job.input_revision,
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'Job artifacts must belong to its input snapshot',
      });
    if (job.artifacts.length > 0 && job.published_revision === null)
      context.addIssue({
        code: 'custom',
        message: 'Unpublished jobs cannot expose published artifact handles',
      });
  });
export type WireJob = z.infer<typeof jobSchema>;
export type Job = Internal<WireJob>;
/** One emitted span. `semantic_refs[0]` is the mapped statement; every
 * `*_refs` entry indexes the emission's `ids`, `evidence` or `ranges` table. */
export const sourceMappingSchema = z
  .strictObject({
    start: revisionSchema,
    end: revisionSchema,
    semantic_refs: emissionRefsSchema.min(1),
    instruction_refs: emissionRefsSchema,
    range_refs: emissionRefsSchema,
    evidence_refs: evidenceRefIndexesSchema,
  })
  .superRefine((mapping, context) => {
    if (mapping.end < mapping.start)
      context.addIssue({ code: 'custom', message: 'Invalid output span' });
  });
export const localValidationSchema = z.strictObject({
  kind: z.enum(['bitvector', 'parallel-copy', 'stack-promotion', 'control', 'presentation']),
  rule: presentationRuleSchema.optional(),
  subject: z.string().min(1).max(1024),
  subject_ids: z.array(z.string().min(1).max(1024)).max(64).optional(),
  status: z.enum(['verified', 'unverified', 'rejected']),
  scope: z.string().min(1).max(8192),
  reason: z.string().min(1).max(8192).optional(),
  counterexample: z.record(z.string().max(1024), z.string().max(8192)).optional(),
});
/** Provenance metadata that was bounded out of this emission. The pseudocode text is
 * always complete; a record here means the named metadata is absent (`omitted` counts
 * the records known to be dropped, `null` when the bound hit before they were counted).
 * `output_limit`: a size bound of the emission or its stored artifact; `budget`: the
 * request's work went to the text render first. `evidence` counts proof references
 * (type and emission citations) left out of the published proof catalog. */
export const emissionOmissionSchema = z.strictObject({
  kind: z.enum(['mappings', 'inferences', 'requirements', 'evidence']),
  reason: z.enum(['output_limit', 'budget']),
  omitted: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
});
/** Canonical compact emission. Each distinct entity identity, proof identity and
 * binary range is stated once in `ids`, `evidence` and `ranges`; mappings,
 * inferences and requirements cite them by index. Every inference subject is
 * reviewable through `review` with `subject_id` = `ids[subject_refs[0]]`. */
export const emissionSchema = z
  .strictObject({
    language: z.enum(['c-like', 'python-like']),
    emitter_version: z.string().min(1),
    text: z.string().max(16_777_216),
    span_unit: z.literal('utf16'),
    reconstruction: z.literal('pseudocode'),
    ids: z.array(entityIdSchema).max(1_000_000),
    evidence: z.array(evidenceIdSchema).max(10000),
    ranges: z.array(rangeSchema).max(1_000_000),
    mappings: z.array(sourceMappingSchema).max(100000),
    declaration_span: outputSpanSchema.optional(),
    local_validation: z.array(localValidationSchema).max(1000).optional(),
    inferences: z.array(inferenceSchema).max(10000).optional(),
    requirements: z.array(requirementSchema).max(1000).optional(),
    omitted: z.array(emissionOmissionSchema).max(4).optional(),
    /** `options.structures: "external"`: the C declarations the text refers to by name (a
     * `typedef struct N N;` or the partial body of `struct N`), for the caller to keep
     * once per image. Absent when the text carries them (the default) or none are used. */
    structures: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(512),
          declaration: z.string().min(1).max(65_536),
        }),
      )
      .max(10_000)
      .optional(),
    helpers: z
      .array(z.strictObject({ name: z.string().min(1), explanation: z.string().min(1).max(8192) }))
      .max(1000),
    review: z.strictObject({
      operation: z.literal('function_get'),
      view: z.literal('metadata'),
      function_id: entityIdSchema,
    }),
  })
  .superRefine((emission, context) => {
    const unique = (path: 'ids' | 'evidence' | 'ranges', keys: readonly string[]): void => {
      if (new Set(keys).size !== keys.length)
        context.addIssue({
          code: 'custom',
          path: [path],
          message: 'Emission reference tables are duplicate-free',
        });
    };
    unique('ids', emission.ids);
    unique('evidence', emission.evidence);
    unique(
      'ranges',
      emission.ranges.map(
        (range) =>
          `${range.start.image_id}:${range.start.space}:${BigInt(range.start.value)}:${BigInt(range.size)}`,
      ),
    );
    const bounded = (refs: readonly number[], table: readonly unknown[]) =>
      refs.every((ref) => ref < table.length);
    const references = (record: {
      subject_refs?: readonly number[];
      semantic_refs?: readonly number[];
      instruction_refs: readonly number[];
      evidence_refs: readonly number[];
      range_refs?: readonly number[];
    }) =>
      bounded(record.subject_refs ?? record.semantic_refs ?? [], emission.ids) &&
      bounded(record.instruction_refs, emission.ids) &&
      bounded(record.evidence_refs, emission.evidence) &&
      bounded(record.range_refs ?? [], emission.ranges);
    for (const mapping of emission.mappings) {
      if (mapping.end > emission.text.length)
        context.addIssue({ code: 'custom', message: 'Source mapping exceeds emitted text' });
      if (!references(mapping))
        context.addIssue({
          code: 'custom',
          message: 'Source mapping reference is outside its emission table',
        });
    }
    if (emission.declaration_span && emission.declaration_span.end > emission.text.length)
      context.addIssue({ code: 'custom', message: 'Declaration span exceeds emitted text' });
    for (const records of [emission.inferences, emission.requirements])
      for (const record of records ?? []) {
        if (record.output_spans.some((span) => span.end > emission.text.length))
          context.addIssue({ code: 'custom', message: 'Inference span exceeds emitted text' });
        if (!references(record) || ('sites' in record && !record.sites.every(references)))
          context.addIssue({
            code: 'custom',
            message: 'Inference reference is outside its emission table',
          });
      }
  });
export type WireEmission = z.infer<typeof emissionSchema>;
export type Emission = Internal<WireEmission>;

const requestContext = {
  project_id: projectIdSchema,
  revision: revisionSchema,
  budget: budgetSchema.default(DEFAULT_BUDGET),
};
const paging = { page: pageRequestSchema.default({ limit: 100 }) };
const querySchema = z.strictObject({
  text: z.string().max(4096).default(''),
  match: z.enum(['exact', 'prefix', 'contains']).default('contains'),
  case_sensitive: z.boolean().default(false),
});
const defaultQuery = { text: '', match: 'contains' as const, case_sensitive: false };
const pageInfoSchema = z.strictObject({
  next_cursor: z.string().min(1).max(16384).nullable(),
  index_state: z.enum(['complete', 'partial', 'not_started']),
  order: z.enum(['address_id', 'name_id', 'id']),
  /** inline: result.evidence holds the records; by_reference: ids resolve through evidence_get;
   * artifact: ids resolve inside the selected analysis artifact. */
  evidence_delivery: z.enum(['inline', 'by_reference', 'artifact']),
});

export const projectOpenArgsSchema = z.strictObject({
  source: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('import'),
      input_path: z.string().min(1).max(32768),
      project_path: z.string().min(1).max(32768),
      slice_id: sliceIdSchema.optional(),
      mode: z.enum(['create', 'resume']).default('create'),
    }),
    z.strictObject({ kind: z.literal('resume'), project_path: z.string().min(1).max(32768) }),
  ]),
  wait: z.boolean().default(false),
  budget: budgetSchema.default(DEFAULT_BUDGET),
});
export const projectCloseArgsSchema = z.strictObject({
  ...requestContext,
  running_jobs: z.enum(['wait', 'cancel', 'reject']).default('reject'),
});
export const binaryInfoArgsSchema = z.strictObject({
  ...requestContext,
  image_id: imageIdSchema.optional(),
  view: z
    .enum([
      'summary',
      'headers',
      'sections',
      'mappings',
      'entry_points',
      'relocations',
      'hints',
      'capabilities',
      'types',
    ])
    .default('summary'),
  ...paging,
});
export const symbolsFindArgsSchema = z.strictObject({
  ...requestContext,
  image_id: imageIdSchema,
  kinds: z
    .array(z.enum(['symbol', 'import', 'export']))
    .min(1)
    .max(3)
    .default(['symbol', 'import', 'export']),
  query: querySchema.default(defaultQuery),
  address: addressSchema.optional(),
  ...paging,
});
export const stringsFindArgsSchema = z.strictObject({
  ...requestContext,
  image_id: imageIdSchema,
  query: querySchema.default(defaultQuery),
  encodings: z
    .array(z.enum(['ascii', 'utf8', 'utf16le']))
    .min(1)
    .max(3)
    .default(['ascii', 'utf8', 'utf16le']),
  status: z.enum(['all', 'candidate', 'referenced']).default('all'),
  range: rangeSchema.optional(),
  ...paging,
});
export const functionsFindArgsSchema = z.strictObject({
  ...requestContext,
  image_id: imageIdSchema,
  id: entityIdSchema.optional(),
  /** Unique-prefix lookup (at least 12 hex digits); an ambiguous prefix returns every match. */
  id_prefix: z
    .string()
    .regex(/^entity_[0-9a-f]{12,63}$/)
    .optional(),
  query: querySchema.default(defaultQuery),
  address: addressSchema.optional(),
  boundary: z.enum(['candidate', 'established', 'conflicting']).optional(),
  analysis: z.enum(['not_analyzed', 'partial', 'complete', 'unsupported']).optional(),
  ...paging,
});
export const functionGetArgsSchema = z
  .strictObject({
    ...requestContext,
    function_id: entityIdSchema,
    view: z.enum(['metadata', 'disassembly', 'cfg', 'investigation']).default('metadata'),
    // The published ID, or a unique `artifact_<12+ hex>` prefix of it (what MCP headers print).
    artifact_id: z
      .string()
      .regex(/^artifact_[0-9a-f]{12,64}$/)
      .optional(),
    subject_id: entityIdSchema.optional(),
    kinds: z
      .array(
        z.enum([
          'signature',
          'parameter',
          'type',
          'interpretation',
          'field',
          'identity',
          'call',
          'guess',
          'rewrite',
          'conflict',
          'annotation',
          'fp_environment',
          'abi_conformance',
          'unresolved',
          'source',
          'helper',
        ]),
      )
      .min(1)
      .max(16)
      .optional(),
    include_quotes: z.boolean().optional(),
    detail: z.enum(['full', 'compact']).optional().describe('Disassembly only; omitted means full'),
    ...paging,
  })
  .superRefine((args, context) => {
    if (args.view === 'investigation' && args.artifact_id === undefined)
      context.addIssue({
        code: 'custom',
        path: ['artifact_id'],
        message: 'Investigation requires an explicit published artifact',
      });
    if (args.view !== 'investigation' && args.kinds !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['kinds'],
        message: 'Kind filters require investigation view',
      });
    if (args.view !== 'investigation' && args.include_quotes)
      context.addIssue({
        code: 'custom',
        path: ['include_quotes'],
        message: 'Output quotations require investigation view',
      });
    if (args.detail !== undefined && args.view !== 'disassembly')
      context.addIssue({
        code: 'custom',
        path: ['detail'],
        message: 'Instruction detail requires disassembly view',
      });
    if (
      args.view !== 'metadata' &&
      args.view !== 'investigation' &&
      (args.subject_id !== undefined || args.artifact_id !== undefined)
    )
      context.addIssue({
        code: 'custom',
        message: 'Subject and artifact scope require metadata or investigation view',
      });
  });
export const functionDecompileArgsSchema = z.strictObject({
  ...requestContext,
  function_id: entityIdSchema,
  /** true awaits the terminal result; false returns the durable job at admission; 'auto' awaits a
   * short bounded time and otherwise returns the job. */
  wait: z.union([z.boolean(), z.literal('auto')]).default(false),
  delivery: z.enum(['auto', 'artifact']).default('auto'),
  options: analysisOptionsSchema.default(DEFAULT_ANALYSIS_OPTIONS),
});
export const xrefsGetArgsSchema = z.strictObject({
  ...requestContext,
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('entity'), id: entityIdSchema }),
    z.strictObject({ kind: z.literal('address'), address: addressSchema }),
  ]),
  direction: z.enum(['incoming', 'outgoing', 'both']).default('both'),
  kinds: z
    .array(z.enum(['call', 'tail_call', 'branch', 'read', 'write', 'address', 'unknown']))
    .min(1)
    .max(7)
    .default(['call', 'tail_call', 'branch', 'read', 'write', 'address', 'unknown']),
  include_unresolved: z.boolean().default(true),
  ...paging,
});
/** Navigation results carry evidence IDs; the records themselves are fetched here. `closure`
 * also returns every record reachable through derived_from/conflicts_with. */
export const evidenceGetArgsSchema = z.strictObject({
  ...requestContext,
  evidence_ids: z.array(evidenceIdSchema).min(1).max(1000),
  derivation: z.enum(['direct', 'closure']).default('direct'),
  ...paging,
});
export const memoryReadArgsSchema = z
  .strictObject({
    ...requestContext,
    address: addressSchema,
    length: z.number().int().min(1).max(1_048_576).default(4096),
    interpretation: z
      .enum([
        'bytes',
        'u8',
        'u16',
        'u32',
        'u64',
        'i8',
        'i16',
        'i32',
        'i64',
        'f32',
        'f64',
        'pointer',
      ])
      .default('bytes'),
    endian: z.enum(['little', 'big']).default('little'),
  })
  .superRefine((args, context) => {
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
    if (args.length % widths[args.interpretation] !== 0)
      context.addIssue({
        code: 'custom',
        message: 'Read length must contain whole typed elements',
      });
    if (
      hexU64Schema.safeParse(args.address.value).success &&
      Number.isSafeInteger(args.length) &&
      BigInt(args.address.value) + BigInt(args.length) > 1n << 64n
    )
      context.addIssue({ code: 'custom', message: 'Read range overflows address space' });
  });
export const annotationsApplyArgsSchema = z
  .strictObject({
    project_id: projectIdSchema,
    expected_revision: revisionSchema,
    author: z.string().min(1).max(1024),
    origin: z.enum(['user', 'llm']),
    edits: z.array(annotationEditSchema).min(1).max(1000),
    budget: budgetSchema.default(DEFAULT_BUDGET),
  })
  .superRefine((args, context) => {
    const seen = new Set<string>();
    for (const edit of args.edits) {
      if (seen.has(edit.id))
        context.addIssue({ code: 'custom', message: 'A batch may edit each annotation only once' });
      seen.add(edit.id);
    }
  });
export const analysisStatusArgsSchema = z.strictObject({ ...requestContext, job_id: jobIdSchema });
export const analysisCancelArgsSchema = z.strictObject({ ...requestContext, job_id: jobIdSchema });
/** Continue a budget-limited whole-image function discovery by one step at the current revision. */
export const functionsDiscoverArgsSchema = z.strictObject({
  ...requestContext,
  image_id: imageIdSchema,
});

const resultContext = {
  schema_version: z.literal(SCHEMA_VERSION),
  project_id: projectIdSchema.nullable(),
  revision: revisionSchema.nullable(),
  versions: versionsSchema,
  options: analysisOptionsSchema,
  budget: budgetSchema,
  coverage: z.array(coverageSchema).max(1000),
  diagnostics: z.array(diagnosticSchema).max(1000),
  evidence: z.array(evidenceSchema).max(10000),
  artifacts: z.array(artifactSchema).max(1000),
};
export type ResultMetadata = z.output<z.ZodObject<typeof resultContext>>;
export type ResultEnvelope<Data> = ResultMetadata &
  (
    | { state: 'complete' | 'empty'; data: Data }
    | {
        state: 'partial';
        data: Data;
        reason: 'budget' | 'incomplete_index' | 'unsupported_subset' | 'output_limit';
        continuation: string | null;
      }
    | { state: 'queued' | 'running'; job: WireJob }
    | { state: 'unsupported'; error: z.output<typeof diagnosticSchema> }
    | { state: 'failed'; error: z.output<typeof diagnosticSchema>; current_revision: number | null }
    | { state: 'cancelled'; job_id: string | null }
  );
/** All tools share explicit lifecycle states, but retain a concrete operation-specific data schema. */
export function resultSchema<S extends z.ZodType>(data: S): z.ZodType<ResultEnvelope<z.output<S>>> {
  return z
    .discriminatedUnion('state', [
      z.strictObject({ ...resultContext, state: z.literal('complete'), data }),
      z.strictObject({ ...resultContext, state: z.literal('empty'), data }),
      z.strictObject({
        ...resultContext,
        state: z.literal('partial'),
        data,
        reason: z.enum(['budget', 'incomplete_index', 'unsupported_subset', 'output_limit']),
        continuation: z.string().min(1).max(16384).nullable(),
      }),
      z.strictObject({ ...resultContext, state: z.literal('queued'), job: jobSchema }),
      z.strictObject({ ...resultContext, state: z.literal('running'), job: jobSchema }),
      z.strictObject({
        ...resultContext,
        state: z.literal('unsupported'),
        error: diagnosticSchema,
      }),
      z.strictObject({
        ...resultContext,
        state: z.literal('failed'),
        error: diagnosticSchema,
        current_revision: revisionSchema.nullable(),
      }),
      z.strictObject({
        ...resultContext,
        state: z.literal('cancelled'),
        job_id: jobIdSchema.nullable(),
      }),
    ])
    .superRefine((result, context) => {
      if ((result.project_id === null) !== (result.revision === null))
        context.addIssue({ code: 'custom', message: 'Project and revision must appear together' });
      if (
        ['complete', 'empty', 'partial', 'queued', 'running'].includes(result.state) &&
        result.project_id === null
      )
        context.addIssue({
          code: 'custom',
          message: 'Successful results require project identity and revision',
        });
      if ('data' in result && result.data !== null && typeof result.data === 'object') {
        const record = result.data as Record<string, unknown>;
        const items = record['items'];
        const page = record['page'] as
          { index_state?: string; next_cursor?: string | null } | undefined;
        if (typeof record['revision'] === 'number' && record['revision'] !== result.revision)
          context.addIssue({ code: 'custom', message: 'Data revision does not match envelope' });
        if (
          typeof record['persisted_revision'] === 'number' &&
          record['persisted_revision'] !== result.revision
        )
          context.addIssue({
            code: 'custom',
            message: 'Persisted revision does not match envelope',
          });
        if (
          record['next_address'] !== undefined &&
          record['next_address'] !== null &&
          result.state !== 'partial'
        )
          context.addIssue({
            code: 'custom',
            message: 'A shortened memory read is partial, not complete',
          });
        if (
          result.state === 'partial' &&
          'reason' in result &&
          result.reason === 'output_limit' &&
          'continuation' in result &&
          result.continuation === null &&
          result.artifacts.length === 0 &&
          // An inline decompilation delivers its text; its output limit bounded metadata
          // (named by `emission.omitted`), so there is nothing further to continue.
          record['delivery'] !== 'inline' &&
          page?.next_cursor == null &&
          record['next_address'] == null
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Output-limited results need a continuation or artifact',
          });
        }
        if (
          result.state === 'empty' &&
          (!Array.isArray(items) ||
            items.length !== 0 ||
            page?.index_state !== 'complete' ||
            page.next_cursor !== null)
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Empty means an exhausted, completely indexed query with zero items',
          });
        }
        if (result.state === 'complete' && Array.isArray(items) && items.length === 0)
          context.addIssue({
            code: 'custom',
            message: 'Use empty or partial for a query with no items',
          });
        if (
          (result.state === 'complete' || result.state === 'empty') &&
          page &&
          page.index_state !== 'complete'
        )
          context.addIssue({
            code: 'custom',
            message: 'Incomplete indexes require partial results',
          });
      }
      for (const artifact of result.artifacts) {
        if (artifact.project_id !== result.project_id || artifact.revision !== result.revision)
          context.addIssue({
            code: 'custom',
            message: 'Result artifact belongs to another snapshot',
          });
      }
      if (
        'job' in result &&
        (result.job.project_id !== result.project_id ||
          result.job.input_revision !== result.revision ||
          result.job.state !== result.state)
      )
        context.addIssue({ code: 'custom', message: 'Job does not match result snapshot/state' });
    }) as z.ZodType<ResultEnvelope<z.output<S>>>;
}
const binaryInfoDataSchema = z.discriminatedUnion('view', [
  z.strictObject({ view: z.literal('summary'), image: imageSummarySchema }),
  z.strictObject({
    view: z.literal('headers'),
    items: z.array(headerSchema).max(1000),
    page: pageInfoSchema,
  }),
  z.strictObject({
    view: z.literal('sections'),
    items: z.array(sectionSchema).max(1000),
    page: pageInfoSchema,
  }),
  z.strictObject({
    view: z.literal('mappings'),
    items: z.array(mappingSchema).max(1000),
    page: pageInfoSchema,
  }),
  z.strictObject({
    view: z.literal('entry_points'),
    items: z.array(addressSchema).max(1000),
    page: pageInfoSchema,
  }),
  z.strictObject({
    view: z.literal('relocations'),
    items: z.array(relocationSchema).max(1000),
    page: pageInfoSchema,
  }),
  z.strictObject({
    view: z.literal('hints'),
    items: z.array(hintSchema).max(1000),
    page: pageInfoSchema,
  }),
  z.strictObject({
    view: z.literal('capabilities'),
    items: z.array(capabilitySchema).max(1000),
    page: pageInfoSchema,
  }),
  z.strictObject({
    view: z.literal('types'),
    /** C declarations of merged image structure types (observed members only). */
    text: z.string().max(16 * 1024 * 1024),
    functions: z.strictObject({
      analyzed: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
    types: z.number().int().nonnegative(),
  }),
]);
const symbolItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('symbol'), symbol: symbolSchema }),
  z.strictObject({ kind: z.literal('import'), import: importSchema }),
  z.strictObject({ kind: z.literal('export'), export: exportSchema }),
]);
const instructionRefsSchema = z.array(z.int().min(0)).max(10000);
const compactParameterSchema = inferenceDetailsByKind.parameter
  .omit({ value_ids: true, source_type_id: true })
  .extend({ source_type_known: z.boolean() });
const compactCallSchema = inferenceDetailsByKind.call
  .omit({ call_id: true, signature_id: true })
  .extend({
    signature_known: z.boolean(),
    target: z.discriminatedUnion('kind', [
      inferenceDetailsByKind.call.shape.target.options[0],
      inferenceDetailsByKind.call.shape.target.options[1].omit({ value_ids: true }),
    ]),
    ordered_arguments: z
      .array(inferenceDetailsByKind.call.shape.ordered_arguments.element.omit({ value_ids: true }))
      .max(10000),
  });
const compactGuessSchema = z.discriminatedUnion('subject', [
  guessDetailsSchemas.argument_list.omit({ call_id: true }).extend({
    target: z.discriminatedUnion('kind', [
      guessDetailsSchemas.argument_list.shape.target.options[0],
      guessDetailsSchemas.argument_list.shape.target.options[1].omit({ value_ids: true }),
    ]),
  }),
  guessDetailsSchemas.type.omit({ value_ids: true }),
]);
const investigationDetailsSchema = z.discriminatedUnion('kind', [
  compactParameterSchema,
  inferenceDetailsByKind.type
    .omit({ association_ids: true, type_id: true, pointee_id: true })
    .extend({ pointee_known: z.boolean() }),
  inferenceDetailsByKind.interpretation.omit({ operand_value_ids: true }),
  inferenceDetailsByKind.field.omit({ shape_id: true, field_ids: true, type_id: true }),
  inferenceDetailsByKind.identity.omit({ value_ids: true }),
  compactCallSchema,
  compactGuessSchema,
  inferenceDetailsByKind.rewrite,
  inferenceDetailsByKind.conflict
    .omit({ alternatives: true })
    .extend({ alternative_count: z.int().min(0) }),
  inferenceDetailsByKind.annotation,
]);
/** Field validators come from the emission itself (emissionSchema is refined, so only its shape is shared). */
const emissionHelperSchema = emissionSchema.shape.helpers.element;
const investigationItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('source'),
    span: z.strictObject({ start: z.int().min(0), end: z.int().min(1) }),
    text: z.string().max(512),
    mapping_indexes: z.array(z.int().min(0)).max(100000),
    instruction_refs: instructionRefsSchema,
  }),
  z.strictObject({
    kind: z.literal('signature'),
    status: z.literal('inferred'),
    signature: signatureSchema
      .omit({ return_type: true, parameters: true, evidence_ids: true })
      .extend({ parameter_count: z.int().min(0).max(10000) })
      .nullable(),
    parameters: z.array(compactParameterSchema).max(10000),
    locator: z.literal('result.data.signature'),
  }),
  z.strictObject({
    kind: z.literal('helper'),
    artifact_helper_index: z.int().min(0).max(999),
    name: emissionHelperSchema.shape.name,
    explanation: emissionHelperSchema.shape.explanation,
    semantic_domain: z.literal(
      'renderer pseudocode semantic contract; not original source or an executable helper definition',
    ),
    locator: z.literal(
      'result.data.emission.helpers[artifact_helper_index] in the selected artifact',
    ),
  }),
  z.strictObject({
    kind: z.literal('inference'),
    record: inferenceSchema.pick({ id: true, status: true }).extend({
      details: investigationDetailsSchema,
      instruction_refs: instructionRefsSchema,
    }),
  }),
  z.strictObject({
    kind: z.literal('requirement'),
    record: requirementSchema
      .pick({ id: true, status: true, kind: true, explanation: true })
      .extend({
        sites: z
          .array(
            requirementSiteSchema.omit({
              subject_refs: true,
              evidence_refs: true,
              instruction_refs: true,
              predicate_value_id: true,
            }),
          )
          .max(1000),
        instruction_refs: instructionRefsSchema,
      }),
  }),
]);
const compactInstructionSchema = z
  .strictObject({
    id: instructionSchema.shape.id,
    address: instructionSchema.shape.address,
    size: instructionSchema.shape.size,
    validity: instructionSchema.shape.validity,
    flow: instructionSchema.shape.flow,
    diagnostics: instructionSchema.shape.diagnostics,
    evidence_ids: instructionSchema.shape.evidence_ids,
    architecture: targetSchema.shape.architecture,
    presentation: z.strictObject({ mnemonic: z.string().min(1), operands: z.string() }).nullable(),
  })
  .superRefine((instruction, context) => {
    if (instruction.validity === 'valid' && instruction.presentation === null)
      context.addIssue({
        code: 'custom',
        message: 'Valid compact instructions require decoder presentation',
      });
    if (instruction.architecture === 'arm64' && instruction.size !== 4)
      context.addIssue({ code: 'custom', message: 'ARM64 instructions have four bytes' });
  });
const disassemblyDataFields = {
  view: z.literal('disassembly'),
  function_id: entityIdSchema,
  gaps: z
    .array(
      z.strictObject({
        range: rangeSchema,
        reason: z.enum(['truncated', 'unmapped', 'data', 'budget']),
      }),
    )
    .max(1000),
  page: pageInfoSchema,
};
const disassemblyDataSchema = z.discriminatedUnion('detail', [
  z.strictObject({
    ...disassemblyDataFields,
    detail: z.literal('full').optional(),
    items: z.array(instructionSchema).max(1000),
  }),
  z.strictObject({
    ...disassemblyDataFields,
    detail: z.literal('compact'),
    items: z.array(compactInstructionSchema).max(1000),
  }),
]);
const investigationDiagnosticSchema = diagnosticSchema
  .omit({
    message: true,
    entity_id: true,
    evidence_ids: true,
  })
  .extend({
    artifact_index: z.int().min(0).max(999),
    entity_known: z.boolean(),
    evidence_count: z.int().min(0).max(1000),
  });
const functionGetDataSchema = z
  .discriminatedUnion('view', [
    z.strictObject({
      view: z.literal('metadata'),
      evidence_delivery: z.literal('by_reference'),
      function: functionSchema,
      reviewed_subject_id: entityIdSchema,
      annotation_eligible: z.boolean(),
      annotations: z.array(annotationSchema).max(1000),
      lineage: z.array(lineageSchema).max(1000),
    }),
    disassemblyDataSchema,
    z.strictObject({
      view: z.literal('cfg'),
      function_id: entityIdSchema,
      items: z.array(cfgBlockSchema).max(1000),
      page: pageInfoSchema,
    }),
    z.strictObject({
      view: z.literal('investigation'),
      function_id: entityIdSchema,
      artifact_id: artifactSchema.shape.id,
      record_lookup: z.literal(
        'original emission inference/requirement IDs and mapping indexes in the selected artifact',
      ),
      items: z.array(investigationItemSchema).max(1000),
      analysis_state: z.enum(['complete', 'partial']),
      proof_delivery: z.literal('artifact_references'),
      diagnostic_lookup: z.literal('result.diagnostics[artifact_index] in the selected artifact'),
      analysis_diagnostics: z.array(investigationDiagnosticSchema).max(1000),
      references: z
        .array(
          z.union([
            entityIdSchema,
            z.string().regex(/^(va|rva|file):0x[0-9a-f]{1,16}\+0x[0-9a-f]{1,16}$/),
          ]),
        )
        .max(10000),
      selection: z.strictObject({
        kinds: z.array(z.string()).max(16).nullable(),
        subject_id: entityIdSchema.nullable(),
        quotes: z.boolean(),
        counts: z.record(
          z.enum(['inferences', 'requirements', 'unresolved_sites', 'source_mappings', 'helpers']),
          z.strictObject({ total: z.int().min(0), selected: z.int().min(0) }),
        ),
        omitted_inference_statuses: z.partialRecord(inferenceSchema.shape.status, z.int().min(0)),
        omitted_requirement_kinds: z.partialRecord(requirementSchema.shape.kind, z.int().min(0)),
      }),
      helpers: z
        .array(z.strictObject({ name: z.string().min(1), artifact_helper_index: z.int().min(0) }))
        .max(1000),
      page: pageInfoSchema,
    }),
  ])
  .superRefine((data, context) => {
    if (data.view !== 'investigation') return;
    if (new Set(data.references).size !== data.references.length)
      context.addIssue({
        code: 'custom',
        path: ['references'],
        message: 'Page provenance references must be unique',
      });
    for (const [index, item] of data.items.entries()) {
      if (item.kind === 'signature' || item.kind === 'helper') continue;
      const record = item.kind === 'source' ? item : item.record;
      for (const ref of record.instruction_refs)
        if (data.references[ref] === undefined)
          context.addIssue({
            code: 'custom',
            path: ['items', index, 'instruction_refs'],
            message: 'Invalid instruction proof reference',
          });
    }
  });
export const memorySegmentSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('mapped'),
    range: rangeSchema,
    bytes_hex: z
      .string()
      .regex(/^(?:[0-9a-f]{2})*$/)
      .max(2_097_152),
  }),
  z.strictObject({ kind: z.literal('zero_fill'), range: rangeSchema }),
  z.strictObject({ kind: z.literal('unmapped'), range: rangeSchema }),
]);
const memoryDataSchema = z
  .strictObject({
    requested: rangeSchema,
    segments: z.array(memorySegmentSchema).min(1).max(10000),
    values: z
      .array(
        z.strictObject({
          address: addressSchema,
          type: z.enum([
            'u8',
            'u16',
            'u32',
            'u64',
            'i8',
            'i16',
            'i32',
            'i64',
            'f32',
            'f64',
            'pointer',
          ]),
          bits: hexU64Schema,
        }),
      )
      .max(1_048_576),
    next_address: addressSchema.nullable(),
  })
  .superRefine((data, context) => {
    for (const segment of data.segments) {
      if (
        segment.kind === 'mapped' &&
        hexU64Schema.safeParse(segment.range.size).success &&
        (segment.bytes_hex.length % 2 !== 0 ||
          BigInt(segment.bytes_hex.length / 2) !== BigInt(segment.range.size))
      )
        context.addIssue({ code: 'custom', message: 'Mapped byte count does not match range' });
    }
    if (
      !rangeSchema.safeParse(data.requested).success ||
      data.segments.some((segment) => !rangeSchema.safeParse(segment.range).success)
    )
      return;
    let cursor = BigInt(data.requested.start.value);
    const end = cursor + BigInt(data.requested.size);
    for (const segment of data.segments) {
      const start = segment.range.start;
      if (
        start.image_id !== data.requested.start.image_id ||
        start.space !== data.requested.start.space ||
        BigInt(start.value) !== cursor ||
        BigInt(segment.range.size) === 0n
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Memory segments must partition the request in order without gaps',
        });
      }
      cursor += BigInt(segment.range.size);
    }
    if (
      cursor > end ||
      (cursor < end && data.next_address === null) ||
      (cursor === end && data.next_address !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Partial reads require an explicit continuation; complete reads cannot have one',
      });
    }
    if (
      data.next_address !== null &&
      addressSchema.safeParse(data.next_address).success &&
      (data.next_address.image_id !== data.requested.start.image_id ||
        data.next_address.space !== data.requested.start.space ||
        BigInt(data.next_address.value) !== cursor)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Memory continuation must begin immediately after the returned segments',
      });
    }
  });
export const projectOpenResultSchema = resultSchema(
  z.strictObject({ image: imageSummarySchema.nullable(), resumed: z.boolean() }),
).superRefine((result, context) => {
  if (
    'data' in result &&
    result.data.image === null &&
    (result.state !== 'partial' || result.reason !== 'incomplete_index' || !result.data.resumed)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'An unfinished project is an explicitly resumed, incomplete snapshot',
    });
  }
});
export const projectCloseResultSchema = resultSchema(
  z.strictObject({ closed: z.literal(true), persisted_revision: revisionSchema }),
);
export const binaryInfoResultSchema = resultSchema(binaryInfoDataSchema);
export const symbolsFindResultSchema = resultSchema(
  z.strictObject({ items: z.array(symbolItemSchema).max(1000), page: pageInfoSchema }),
);
export const stringsFindResultSchema = resultSchema(
  z.strictObject({ items: z.array(stringRecordSchema).max(1000), page: pageInfoSchema }),
);
export const functionsFindResultSchema = resultSchema(
  z.strictObject({ items: z.array(functionSchema).max(1000), page: pageInfoSchema }),
);
export const functionGetResultSchema = resultSchema(functionGetDataSchema);
export const functionDecompileResultSchema = resultSchema(
  z.discriminatedUnion('delivery', [
    z.strictObject({
      delivery: z.literal('inline'),
      function_id: entityIdSchema,
      signature: signatureSchema.nullable(),
      emission: emissionSchema,
      capabilities: z.array(capabilitySchema).max(1000),
      cache: z.enum(['hit', 'computed']),
      /** Work this request charged (what `budget.work` bounds), reported per delivery: a
       * `hit` reports the cost of serving the stored result, not of the run that computed it.
       * Absent from stored analyses; never part of cache identity or the emission. */
      work: z.number().int().nonnegative().optional(),
    }),
    z.strictObject({
      delivery: z.literal('artifact'),
      function_id: entityIdSchema,
      artifact_id: artifactSchema.shape.id,
      delivery_reason: z.enum(['requested', 'output_limit']),
      cache: z.enum(['hit', 'computed']),
      /** Work this request charged (what `budget.work` bounds), reported per delivery: a
       * `hit` reports the cost of serving the stored result, not of the run that computed it.
       * Absent from stored analyses; never part of cache identity or the emission. */
      work: z.number().int().nonnegative().optional(),
    }),
  ]),
).superRefine((result, context) => {
  if (!('data' in result)) return;
  const data = result.data;
  if (data.delivery !== 'artifact') return;
  if (
    !result.artifacts.some((artifact) => artifact.id === data.artifact_id) ||
    (data.delivery_reason === 'output_limit' &&
      (result.state !== 'partial' || result.reason !== 'output_limit')) ||
    (data.delivery_reason === 'requested' &&
      result.state !== 'complete' &&
      result.state !== 'partial')
  )
    context.addIssue({
      code: 'custom',
      message:
        'Artifact delivery requires its published handle and truthful requested/overflow state',
    });
});

/** A transport may deliver the published analysis rather than repeat its large
 * body. Original analysis budgets, options and semantic partialness live unchanged
 * in that artifact; this envelope reports only the separate delivery limitation. */
export function projectDecompilationArtifactResult(
  result: ToolResult<'function_decompile'>,
  reason: 'output_limit' | 'requested' = 'output_limit',
): ToolResult<'function_decompile'> {
  if (!('data' in result) || result.data.delivery === 'artifact') return result;
  const artifact = result.artifacts.find(
    (item) =>
      item.media_type === 'application/vnd.open-decomp.function+json' &&
      item.project_id === result.project_id &&
      item.revision === result.revision,
  );
  if (!artifact)
    throw new RangeError('Artifact delivery requires a published analysis for the same snapshot');
  if (reason === 'requested')
    return functionDecompileResultSchema.parse({
      ...result,
      evidence: [],
      artifacts: [artifact],
      data: {
        delivery: 'artifact',
        delivery_reason: 'requested',
        function_id: result.data.function_id,
        artifact_id: artifact.id,
        cache: result.data.cache,
        ...(result.data.work === undefined ? {} : { work: result.data.work }),
      },
    });
  return functionDecompileResultSchema.parse({
    schema_version: result.schema_version,
    project_id: result.project_id,
    revision: result.revision,
    versions: result.versions,
    options: result.options,
    budget: result.budget,
    coverage: [],
    evidence: [],
    artifacts: [artifact],
    state: 'partial',
    reason: 'output_limit',
    continuation: null,
    diagnostics: [
      {
        code: 'resource_limit',
        severity: 'info',
        message:
          'Full decompilation, coverage and diagnostics are available in the analysis artifact.',
        evidence_ids: [],
      },
    ],
    data: {
      delivery: 'artifact',
      delivery_reason: 'output_limit',
      function_id: result.data.function_id,
      artifact_id: artifact.id,
      cache: result.data.cache,
      ...(result.data.work === undefined ? {} : { work: result.data.work }),
    },
  });
}
export const xrefsGetResultSchema = resultSchema(
  z.strictObject({ items: z.array(referenceSchema).max(1000), page: pageInfoSchema }),
);
export const evidenceGetResultSchema = resultSchema(
  z.strictObject({ items: z.array(evidenceSchema).max(1000), page: pageInfoSchema }),
);
export const memoryReadResultSchema = resultSchema(memoryDataSchema);
export const annotationsApplyResultSchema = resultSchema(
  z
    .strictObject({
      previous_revision: revisionSchema,
      revision: revisionSchema,
      applied: z.array(annotationSchema).max(1000),
      removed: z.array(z.string().regex(/^annotation_[0-9a-f]{64}$/)).max(1000),
      invalidation: z.strictObject({
        scope: z.literal('project'),
        derived_before_revision: revisionSchema,
      }),
    })
    .superRefine((data, context) => {
      if (
        data.revision !== data.previous_revision + 1 ||
        data.invalidation.derived_before_revision !== data.revision
      )
        context.addIssue({
          code: 'custom',
          message: 'An atomic annotation batch advances revision exactly once',
        });
    }),
);
export const functionsDiscoverResultSchema = resultSchema(
  z
    .strictObject({
      previous_revision: revisionSchema,
      /** The committed revision, or previous_revision when the step changed nothing. */
      revision: revisionSchema,
      /** Function records this step published (finished, newly found or still cut). */
      published: z.number().int().min(0),
      index_state: z.enum(['complete', 'partial']),
      /** False when the enumeration is complete already or the step cannot finish any root
       * within the instruction limit; another step at the same budget changes nothing. */
      progressed: z.boolean(),
    })
    .superRefine((data, context) => {
      if (data.revision !== data.previous_revision + (data.progressed ? 1 : 0))
        context.addIssue({
          code: 'custom',
          message: 'A discovery step commits exactly when it progresses',
        });
    }),
);
export const analysisStatusResultSchema = resultSchema(
  z.strictObject({ job: jobSchema, known_revision: revisionSchema }),
);
export const analysisCancelResultSchema = resultSchema(
  z
    .strictObject({
      job: jobSchema,
      known_revision: revisionSchema,
      outcome: z.enum(['cancelled', 'already_finished', 'cancellation_requested']),
    })
    .superRefine((data, context) => {
      if (
        (data.outcome === 'cancelled' && data.job.state !== 'cancelled') ||
        (data.outcome === 'already_finished' &&
          !['completed', 'failed', 'stale'].includes(data.job.state)) ||
        (data.outcome === 'cancellation_requested' &&
          !['queued', 'running'].includes(data.job.state))
      ) {
        context.addIssue({ code: 'custom', message: 'Cancellation outcome contradicts job state' });
      }
    }),
);

export interface ToolSchemaRegistry {
  project_open: { input: typeof projectOpenArgsSchema; output: typeof projectOpenResultSchema };
  project_close: { input: typeof projectCloseArgsSchema; output: typeof projectCloseResultSchema };
  binary_info: { input: typeof binaryInfoArgsSchema; output: typeof binaryInfoResultSchema };
  symbols_find: { input: typeof symbolsFindArgsSchema; output: typeof symbolsFindResultSchema };
  strings_find: { input: typeof stringsFindArgsSchema; output: typeof stringsFindResultSchema };
  functions_find: {
    input: typeof functionsFindArgsSchema;
    output: typeof functionsFindResultSchema;
  };
  function_get: { input: typeof functionGetArgsSchema; output: typeof functionGetResultSchema };
  function_decompile: {
    input: typeof functionDecompileArgsSchema;
    output: typeof functionDecompileResultSchema;
  };
  xrefs_get: { input: typeof xrefsGetArgsSchema; output: typeof xrefsGetResultSchema };
  evidence_get: {
    input: typeof evidenceGetArgsSchema;
    output: typeof evidenceGetResultSchema;
  };
  memory_read: { input: typeof memoryReadArgsSchema; output: typeof memoryReadResultSchema };
  annotations_apply: {
    input: typeof annotationsApplyArgsSchema;
    output: typeof annotationsApplyResultSchema;
  };
  functions_discover: {
    input: typeof functionsDiscoverArgsSchema;
    output: typeof functionsDiscoverResultSchema;
  };
  analysis_status: {
    input: typeof analysisStatusArgsSchema;
    output: typeof analysisStatusResultSchema;
  };
  analysis_cancel: {
    input: typeof analysisCancelArgsSchema;
    output: typeof analysisCancelResultSchema;
  };
}
export const toolSchemas: ToolSchemaRegistry = {
  project_open: { input: projectOpenArgsSchema, output: projectOpenResultSchema },
  project_close: { input: projectCloseArgsSchema, output: projectCloseResultSchema },
  binary_info: { input: binaryInfoArgsSchema, output: binaryInfoResultSchema },
  symbols_find: { input: symbolsFindArgsSchema, output: symbolsFindResultSchema },
  strings_find: { input: stringsFindArgsSchema, output: stringsFindResultSchema },
  functions_find: { input: functionsFindArgsSchema, output: functionsFindResultSchema },
  function_get: { input: functionGetArgsSchema, output: functionGetResultSchema },
  function_decompile: { input: functionDecompileArgsSchema, output: functionDecompileResultSchema },
  xrefs_get: { input: xrefsGetArgsSchema, output: xrefsGetResultSchema },
  evidence_get: { input: evidenceGetArgsSchema, output: evidenceGetResultSchema },
  memory_read: { input: memoryReadArgsSchema, output: memoryReadResultSchema },
  annotations_apply: { input: annotationsApplyArgsSchema, output: annotationsApplyResultSchema },
  functions_discover: { input: functionsDiscoverArgsSchema, output: functionsDiscoverResultSchema },
  analysis_status: { input: analysisStatusArgsSchema, output: analysisStatusResultSchema },
  analysis_cancel: { input: analysisCancelArgsSchema, output: analysisCancelResultSchema },
} as const;
export type ToolName = keyof typeof toolSchemas;
export type ToolArgs<K extends ToolName> = z.output<(typeof toolSchemas)[K]['input']>;
export type ToolInput<K extends ToolName> = z.input<(typeof toolSchemas)[K]['input']>;
export type ToolResult<K extends ToolName> = z.output<(typeof toolSchemas)[K]['output']>;

/** JSON Schema describes structural constraints. Zod remains authoritative for cross-field invariants. */
export function exportToolJsonSchemas() {
  return Object.fromEntries(
    Object.entries(toolSchemas).map(([name, schemas]) => [
      name,
      {
        schema_version: SCHEMA_VERSION,
        inputSchema: z.toJSONSchema(schemas.input, {
          target: 'draft-2020-12',
          io: 'input',
          reused: 'ref',
        }),
        outputSchema: {
          ...z.toJSONSchema(schemas.output, {
            target: 'draft-2020-12',
            io: 'output',
            reused: 'ref',
          }),
          type: 'object' as const,
        },
      },
    ]),
  );
}
