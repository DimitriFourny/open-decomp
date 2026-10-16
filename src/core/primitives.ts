import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;
export const hexU64Schema = z.string().regex(/^0x[0-9a-fA-F]{1,16}$/).brand<'HexU64'>();
export type HexU64 = z.infer<typeof hexU64Schema>;
/** Derive internal records from finite wire schemas without changing ordinary text fields. */
export type Internal<T> = T extends HexU64 ? bigint
  : T extends readonly (infer Item)[] ? readonly Internal<Item>[]
  : T extends object ? { readonly [Key in keyof T]: Internal<T[Key]> }
  : T;
export const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const id = <P extends string>(prefix: P) => z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{64}$`));
export const projectIdSchema = id('project');
export const imageIdSchema = id('image');
export const sliceIdSchema = id('slice');
export const entityIdSchema = id('entity');
export const evidenceIdSchema = id('evidence');
export const annotationIdSchema = id('annotation');
export const jobIdSchema = id('job');
export const artifactIdSchema = id('artifact');
export type ProjectId = z.infer<typeof projectIdSchema>;
export type ImageId = z.infer<typeof imageIdSchema>;
export type EntityId = z.infer<typeof entityIdSchema>;
export type Revision = z.infer<typeof revisionSchema>;
export const addressSchema = z.strictObject({ image_id: imageIdSchema, space: z.enum(['va', 'rva', 'file']), value: hexU64Schema });
export type WireAddress = z.infer<typeof addressSchema>;
export const rangeSchema = z.strictObject({ start: addressSchema, size: hexU64Schema }).superRefine((range, context) => {
  if (hexU64Schema.safeParse(range.start.value).success && hexU64Schema.safeParse(range.size).success &&
      BigInt(range.start.value) + BigInt(range.size) > (1n << 64n)) {
    context.addIssue({ code: 'custom', message: 'Range exceeds unsigned 64-bit address space' });
  }
});
export const targetSchema = z.strictObject({
  format: z.enum(['macho', 'pe', 'elf']), architecture: z.enum(['arm64', 'x86_64']),
  abi: z.enum(['darwin-arm64', 'windows-x64', 'sysv-amd64']), endian: z.literal('little'), address_bits: z.literal(64),
  features: z.array(z.string().min(1).max(128)).max(256),
}).superRefine((target, context) => {
  if ((target.format === 'macho' && (target.architecture !== 'arm64' || target.abi !== 'darwin-arm64')) ||
      (target.format === 'pe' && (target.architecture !== 'x86_64' || target.abi !== 'windows-x64')) ||
      (target.format === 'elf' && (target.architecture !== 'x86_64' || target.abi !== 'sysv-amd64'))) {
    context.addIssue({ code: 'custom', message: 'Unsupported format/ISA/ABI combination' });
  }
});
export type Target = z.infer<typeof targetSchema>;
export const diagnosticSchema = z.strictObject({
  code: z.enum(['unsupported_target', 'ambiguous_slice', 'invalid_address', 'invalid_input', 'stale_revision',
    'stale_cursor', 'invalid_cursor', 'resource_limit', 'unavailable_semantics', 'unmapped', 'malformed_image', 'conflicting_evidence',
    'cancelled', 'worker_failed', 'permission_denied', 'not_found', 'unsupported_version', 'internal_error']),
  severity: z.enum(['info', 'warning', 'error']), message: z.string().min(1).max(8192),
  address: addressSchema.optional(), entity_id: entityIdSchema.optional(), evidence_ids: z.array(evidenceIdSchema).max(1000),
  details: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('slice_selection'), slices: z.array(z.strictObject({ id: sliceIdSchema, architecture: z.string().min(1), subtype: z.string().min(1), supported: z.boolean() })).min(1).max(1024) }),
    z.strictObject({ kind: z.literal('revision'), expected: revisionSchema, current: revisionSchema }),
    z.strictObject({ kind: z.literal('limit'), resource: z.enum(['bytes', 'instructions', 'blocks', 'ir_nodes', 'work', 'deadline_ms', 'output_bytes', 'queued_jobs']), limit: revisionSchema, consumed: revisionSchema }),
  ]).optional(),
});
export type WireDiagnostic = z.infer<typeof diagnosticSchema>;
export type Diagnostic = Internal<WireDiagnostic>;
export const evidenceSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('binary'), range: rangeSchema, description: z.string().max(4096) }),
  z.strictObject({ kind: z.literal('analysis'), analyzer: z.string().min(1), version: z.string().min(1), rule: z.string().min(1) }),
  z.strictObject({ kind: z.literal('debug'), artifact_id: artifactIdSchema, record: z.string().min(1), identity_verified: z.boolean() }),
  z.strictObject({ kind: z.literal('library'), library: z.string().min(1), contract: z.string().min(1), version: z.string().min(1) }),
  z.strictObject({ kind: z.literal('assertion'), author: z.string().min(1).max(1024), agent: z.enum(['user', 'llm']), status: z.enum(['hypothesis', 'asserted', 'retracted']) }),
]);
export const evidenceSchema = z.strictObject({
  id: evidenceIdSchema, origin: evidenceSourceSchema, claim: z.string().min(1).max(8192),
  derived_from: z.array(evidenceIdSchema).max(1000), conflicts_with: z.array(evidenceIdSchema).max(1000),
  revision: revisionSchema,
}).superRefine((evidence, context) => {
  if (evidence.derived_from.includes(evidence.id) || evidence.conflicts_with.includes(evidence.id)) {
    context.addIssue({ code: 'custom', message: 'Evidence cannot derive from or conflict with itself' });
  }
});
export type WireEvidence = z.infer<typeof evidenceSchema>;
export type Evidence = Internal<WireEvidence>;
export const evidenceRefsSchema = z.array(evidenceIdSchema).max(1000);
export const layerSchema = z.enum(['format', 'decode', 'lift', 'abi', 'analysis', 'reconstruction']);
export const capabilitySchema = z.strictObject({
  layer: layerSchema, feature: z.string().min(1), status: z.enum(['supported', 'partial', 'unsupported']),
  limitations: z.array(z.string().min(1)).max(1000),
});
export const coverageSchema = z.strictObject({
  layer: layerSchema, state: z.enum(['complete', 'partial', 'unsupported', 'not_run']),
  completed_units: revisionSchema, total_units: revisionSchema.optional(), reasons: z.array(z.string().min(1)).max(1000),
}).superRefine((coverage, context) => {
  if (coverage.total_units !== undefined && coverage.completed_units > coverage.total_units) {
    context.addIssue({ code: 'custom', message: 'Completed units exceed total units' });
  }
});
export const versionsSchema = z.strictObject({
  backend: z.string().min(1), loader: z.string().min(1).nullable(), decoder: z.string().min(1).nullable(), lifter: z.string().min(1).nullable(),
  analysis: z.string().min(1).nullable(), abi: z.string().min(1).nullable(), emitter: z.string().min(1).nullable(),
});
export const DEFAULT_BUDGET = Object.freeze({ instructions: 10_000, blocks: 10_000, ir_nodes: 100_000, work: 1_000_000, deadline_ms: 30_000, output_bytes: 1_048_576 });
export const budgetSchema = z.strictObject({
  instructions: z.number().int().min(1).max(1_000_000).default(DEFAULT_BUDGET.instructions),
  blocks: z.number().int().min(1).max(100_000).default(DEFAULT_BUDGET.blocks),
  ir_nodes: z.number().int().min(1).max(10_000_000).default(DEFAULT_BUDGET.ir_nodes),
  work: z.number().int().min(1).max(100_000_000).default(DEFAULT_BUDGET.work),
  deadline_ms: z.number().int().min(1).max(300_000).default(DEFAULT_BUDGET.deadline_ms),
  output_bytes: z.number().int().min(1024).max(16_777_216).default(DEFAULT_BUDGET.output_bytes),
});
export type Budget = z.infer<typeof budgetSchema>;
export const analysisOptionsSchema = z.strictObject({
  unknown_calls: z.literal('conservative').default('conservative'),
  indirect_targets: z.enum(['off', 'bounded']).default('bounded'),
  emitter: z.enum(['c-like', 'python-like']).default('c-like'),
  include_evidence: z.boolean().default(true), indent: z.number().int().min(1).max(8).default(2),
});
export const DEFAULT_ANALYSIS_OPTIONS = Object.freeze(analysisOptionsSchema.parse({}));
export const pageRequestSchema = z.strictObject({ limit: z.number().int().min(1).max(1000).default(100), cursor: z.string().min(1).max(16_384).optional() });
export const artifactSchema = z.strictObject({
  id: artifactIdSchema, project_id: projectIdSchema, revision: revisionSchema, media_type: z.string().min(1),
  size: hexU64Schema, sha256: digestSchema, schema_version: z.literal(SCHEMA_VERSION),
});
export type WireArtifact = z.infer<typeof artifactSchema>;
export type Artifact = Internal<WireArtifact>;
export const artifactReadArgsSchema = z.strictObject({
  project_id: projectIdSchema, revision: revisionSchema, artifact_id: artifactIdSchema,
  offset: hexU64Schema, length: z.number().int().min(1).max(1_048_576).default(4096),
});
export const artifactReadResultSchema = z.strictObject({
  artifact: artifactSchema, offset: hexU64Schema, bytes_hex: z.string().regex(/^(?:[0-9a-f]{2})*$/).max(2_097_152),
  next_offset: hexU64Schema.nullable(),
});
