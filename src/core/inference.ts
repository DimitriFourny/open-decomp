import { z } from 'zod';
import type { AddressRange } from './addresses.js';
import {
  annotationIdSchema,
  entityIdSchema,
  imageIdSchema,
  rangeSchema,
  type Internal,
} from './primitives.js';

/** Presentation confidence is not semantic coverage or a translation proof. */
export const inferenceStatusSchema = z.enum([
  'established',
  'inferred',
  'asserted',
  'hypothesis',
  'conflicting',
  'assumption',
  'unresolved',
]);
export const outputSpanSchema = z
  .strictObject({
    start: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    end: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .refine((span) => span.end > span.start, 'Output spans must be nonempty UTF-16 intervals');
const ids = z.array(entityIdSchema).max(10000);
/** Index into one emission's interned `ids`, `evidence` or `ranges` table. */
export const emissionRefSchema = z.int().min(0).max(999_999);
export const emissionRefsSchema = z.array(emissionRefSchema).max(10000);
export const evidenceRefIndexesSchema = z.array(emissionRefSchema).max(1000);
const common = {
  id: z.string().min(1).max(1024),
  status: inferenceStatusSchema,
  explanation: z.string().min(1).max(8192),
  subject_refs: emissionRefsSchema,
  evidence_refs: evidenceRefIndexesSchema,
  instruction_refs: emissionRefsSchema,
  range_refs: emissionRefsSchema,
  output_spans: z.array(outputSpanSchema).min(1).max(1000),
};
const width = z.number().int().min(1).max(65536);
const decimal = z
  .string()
  .regex(/^-?[0-9]+$/)
  .max(1024);
const identity = z.strictObject({
  image_id: imageIdSchema,
  space: z.enum(['va', 'rva', 'file']),
  address: decimal,
});
const argument = z.strictObject({
  ordinal: z.number().int().min(0).max(9999),
  value_ids: ids,
  width_bits: width,
  constant_bits: z
    .string()
    .regex(/^[0-9]+$/)
    .max(20000)
    .nullable(),
});
const contextRegister = z.strictObject({
  root: z.string().min(1).max(1024),
  offset_bits: z.number().int().min(0),
  width_bits: width,
});
const callContext = z.strictObject({
  constants: z
    .array(
      z
        .strictObject({
          register: contextRegister,
          bits: z
            .string()
            .regex(/^[0-9]+$/)
            .max(20000),
        })
        .refine(
          (value) =>
            /^[0-9]+$/.test(value.bits) &&
            Number.isInteger(value.register.width_bits) &&
            value.register.width_bits >= 1 &&
            value.register.width_bits <= 65536 &&
            BigInt(value.bits) < 1n << BigInt(value.register.width_bits),
          'Context constants must cover a whole ABI carrier without out-of-width bits',
        ),
    )
    .max(64),
  aliases: z.array(z.array(contextRegister).min(2).max(64)).max(64),
  type_evidence_scope: z.string().regex(/^[a-f0-9]{64}$/),
});
export const inferenceDetailsByKind = {
  parameter: z.strictObject({
    kind: z.literal('parameter'),
    ordinal: z.number().int().min(0).max(9999),
    role: z.enum(['entry_storage', 'observed_input', 'physical_register']),
    value_ids: ids,
    machine_width_bits: width,
    location: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('register'),
        root: z.string().min(1).max(1024),
        offset_bits: z.number().int().min(0),
        width_bits: width,
      }),
      z.strictObject({ kind: z.literal('stack'), offset: decimal }),
      z.strictObject({ kind: z.literal('unknown') }),
    ]),
    source_type_id: entityIdSchema.nullable(),
  }),
  type: z.strictObject({
    kind: z.literal('type'),
    association_ids: ids,
    type_id: entityIdSchema,
    type_status: z.enum(['candidate', 'established', 'asserted', 'hypothesis', 'conflicting']),
    source: z.enum(['analysis', 'debug', 'library', 'user', 'llm']),
    type_kind: z
      .enum(['void', 'unknown', 'integer', 'float', 'pointer', 'array', 'vector', 'structure'])
      .nullable(),
    signed: z.boolean().nullable(),
    pointee_id: entityIdSchema.nullable(),
    value_offset_bits: z.number().int().min(0),
    machine_offset_bits: z.number().int().min(0),
    width_bits: width.nullable(),
    displayed: z.boolean(),
  }),
  interpretation: z.strictObject({
    kind: z.literal('interpretation'),
    width_domain: z.literal('reconstructed_ir'),
    operation: z.enum([
      'sdiv',
      'srem',
      'ashr',
      'slt',
      'sle',
      'sgt',
      'sge',
      'sign_extend',
      'signed_to_float',
      'float_to_signed',
    ]),
    signed: z.literal(true),
    operand_value_ids: z.array(ids).max(2),
    operand_width_bits: z.array(width).max(2),
    result_width_bits: width,
  }),
  field: z.strictObject({
    kind: z.literal('field'),
    shape_id: entityIdSchema,
    field_ids: ids,
    type_id: entityIdSchema,
    offset: decimal,
    width_bits: width,
    stride: decimal.nullable(),
    dynamic: z.boolean(),
    bounds: z.literal('unknown'),
    call_target_ids: ids,
  }),
  identity: z.strictObject({
    kind: z.literal('identity'),
    value_ids: ids,
    identity: identity,
    name: z.string().max(1024).nullable(),
    literal: z.string().max(1048576).nullable(),
    encoding: z.enum(['ascii', 'utf8']).nullable(),
    byte_length: decimal.nullable(),
    mutable: z.boolean().nullable(),
    object_address: decimal.nullable(),
    object_offset: decimal.nullable(),
    object_byte_length: decimal.nullable(),
  }),
  call: z.strictObject({
    kind: z.literal('call'),
    call_id: entityIdSchema,
    target: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('direct'), identity }),
      z.strictObject({ kind: z.literal('indirect'), value_ids: ids }),
    ]),
    ordered_arguments: z.array(argument).max(10000),
    result_width_bits: z.array(width).max(10000),
    arity_complete: z.boolean(),
    // Analysis/debug/library declarations are entities; a user/agent-asserted
    // signature is identified by its authoring annotation, never a derived alias.
    signature_id: z.union([entityIdSchema, annotationIdSchema]).nullable(),
    context_assumptions: callContext.optional(),
  }),
  rewrite: z.strictObject({
    kind: z.literal('rewrite'),
    validation_kind: z.enum(['bitvector', 'parallel-copy', 'stack-promotion', 'control']),
    validation_subject: z.string().min(1).max(1024),
    validation_status: z.enum(['verified', 'unverified', 'rejected']),
    scope: z.string().min(1).max(4096),
    reason: z.string().max(8192).nullable(),
    counterexample: z.record(z.string(), z.string()).optional(),
  }),
  conflict: z.strictObject({
    kind: z.literal('conflict'),
    alternatives: ids,
    reason: z.string().min(1).max(8192),
  }),
  annotation: z.strictObject({
    kind: z.literal('annotation'),
    annotation_id: annotationIdSchema,
    annotation_status: z.enum(['hypothesis', 'asserted', 'retracted']),
    annotation_kind: z.enum(['name', 'note', 'type', 'signature']),
  }),
} as const;
export const inferenceDetailsSchema = z.discriminatedUnion('kind', [
  inferenceDetailsByKind.parameter,
  inferenceDetailsByKind.type,
  inferenceDetailsByKind.interpretation,
  inferenceDetailsByKind.field,
  inferenceDetailsByKind.identity,
  inferenceDetailsByKind.call,
  inferenceDetailsByKind.rewrite,
  inferenceDetailsByKind.conflict,
  inferenceDetailsByKind.annotation,
]);
/** `subject_refs`/`instruction_refs` index `emission.ids`, `evidence_refs`
 * index `emission.evidence`, `range_refs` index `emission.ranges`. */
export const inferenceSchema = z.strictObject({ ...common, details: inferenceDetailsSchema });
export const requirementSiteSchema = z.strictObject({
  id: z.string().min(1).max(1024),
  subject_refs: emissionRefsSchema.min(1),
  evidence_refs: evidenceRefIndexesSchema,
  instruction_refs: emissionRefsSchema,
  state_epoch: z.string().min(1).max(1024),
  predicate_value_id: entityIdSchema.optional(),
  supported_predicate_value: z.boolean().optional(),
});
export const requirementSchema = z.strictObject({
  ...common,
  kind: z.enum(['fp_environment', 'unresolved']),
  sites: z.array(requirementSiteSchema).max(1000),
});
export type InferenceStatus = z.infer<typeof inferenceStatusSchema>;
export type WireInference = z.infer<typeof inferenceSchema>;
export type Inference = Internal<WireInference>;
export type WireRequirement = z.infer<typeof requirementSchema>;
export type EmissionRequirement = Internal<WireRequirement>;
type WireRange = z.infer<typeof rangeSchema>;
type ReferenceKeys = 'subject_refs' | 'evidence_refs' | 'instruction_refs' | 'range_refs';
/** String-identity view of one record's table references (see `expandEmission`). */
export interface ExpandedReferences<Range> {
  readonly subject_ids: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly instruction_ids: readonly string[];
  readonly ranges: readonly Range[];
}
export type ExpandedInference<Range = WireRange> = Omit<Inference, ReferenceKeys> &
  ExpandedReferences<Range>;
export type ExpandedRequirementSite = Omit<
  Internal<z.infer<typeof requirementSiteSchema>>,
  Exclude<ReferenceKeys, 'range_refs'>
> &
  Omit<ExpandedReferences<never>, 'ranges'>;
export type ExpandedRequirement<Range = WireRange> = Omit<
  EmissionRequirement,
  ReferenceKeys | 'sites'
> &
  ExpandedReferences<Range> & { readonly sites: readonly ExpandedRequirementSite[] };
/** Producer-side source requirement model: original identities and internal ranges. */
export type Requirement = ExpandedRequirement<AddressRange>;
export type RequirementSite = ExpandedRequirementSite;
