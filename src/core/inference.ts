import { z } from 'zod';
import { annotationIdSchema, entityIdSchema, evidenceRefsSchema, imageIdSchema, rangeSchema, type Internal } from './primitives.js';

/** Presentation confidence is not semantic coverage or a translation proof. */
export const inferenceStatusSchema = z.enum([
  'established', 'inferred', 'asserted', 'hypothesis', 'conflicting', 'assumption', 'unresolved',
]);
export const outputSpanSchema = z.strictObject({
  start: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  end: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).refine((span) => span.end > span.start, 'Output spans must be nonempty UTF-16 intervals');
const ids = z.array(entityIdSchema).max(10000);
const common = {
  id: z.string().min(1).max(1024),
  status: inferenceStatusSchema,
  explanation: z.string().min(1).max(8192),
  subject_ids: ids,
  evidence_ids: evidenceRefsSchema,
  instruction_ids: ids,
  ranges: z.array(rangeSchema).max(10000),
  output_spans: z.array(outputSpanSchema).min(1).max(1000),
};
const width = z.number().int().min(1).max(65536);
const decimal = z.string().regex(/^-?[0-9]+$/).max(1024);
const identity = z.strictObject({
  image_id: imageIdSchema,
  space: z.enum(['va', 'rva', 'file']),
  address: decimal,
});
const argument = z.strictObject({
  ordinal: z.number().int().min(0).max(9999), value_ids: ids, width_bits: width,
  constant_bits: z.string().regex(/^[0-9]+$/).max(20000).nullable(),
});
export const inferenceDetailsSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('parameter'), ordinal: z.number().int().min(0).max(9999),
    role: z.enum(['entry_storage', 'observed_input', 'physical_register']),
    value_ids: ids, machine_width_bits: width,
    location: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('register'), root: z.string().min(1).max(1024), offset_bits: z.number().int().min(0), width_bits: width }),
      z.strictObject({ kind: z.literal('stack'), offset: decimal }),
      z.strictObject({ kind: z.literal('unknown') }),
    ]),
    source_type_id: entityIdSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('type'), association_ids: ids, type_id: entityIdSchema,
    type_status: z.enum(['candidate', 'established', 'asserted', 'hypothesis', 'conflicting']),
    source: z.enum(['analysis', 'debug', 'library', 'user', 'llm']),
    type_kind: z.enum(['void', 'unknown', 'integer', 'float', 'pointer', 'array', 'vector', 'structure']).nullable(),
    signed: z.boolean().nullable(), pointee_id: entityIdSchema.nullable(),
    value_offset_bits: z.number().int().min(0), machine_offset_bits: z.number().int().min(0), width_bits: width.nullable(),
    displayed: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('interpretation'),
    width_domain: z.literal('reconstructed_ir'),
    operation: z.enum(['sdiv', 'srem', 'ashr', 'slt', 'sle', 'sgt', 'sge', 'sign_extend', 'signed_to_float', 'float_to_signed']),
    signed: z.literal(true), operand_value_ids: z.array(ids).max(2),
    operand_width_bits: z.array(width).max(2), result_width_bits: width,
  }),
  z.strictObject({
    kind: z.literal('field'), shape_id: entityIdSchema, field_ids: ids, type_id: entityIdSchema,
    offset: decimal, width_bits: width, stride: decimal.nullable(), dynamic: z.boolean(),
    bounds: z.literal('unknown'), call_target_ids: ids,
  }),
  z.strictObject({
    kind: z.literal('identity'), value_ids: ids, identity: identity,
    name: z.string().max(1024).nullable(), literal: z.string().max(1048576).nullable(),
    encoding: z.enum(['ascii', 'utf8']).nullable(), byte_length: decimal.nullable(),
    mutable: z.boolean().nullable(), object_address: decimal.nullable(), object_offset: decimal.nullable(),
    object_byte_length: decimal.nullable(),
  }),
  z.strictObject({
    kind: z.literal('call'), call_id: entityIdSchema,
    target: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('direct'), identity }),
      z.strictObject({ kind: z.literal('indirect'), value_ids: ids }),
    ]),
    ordered_arguments: z.array(argument).max(10000),
    result_width_bits: z.array(width).max(10000), arity_complete: z.boolean(),
    signature_id: entityIdSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('rewrite'), validation_kind: z.enum(['bitvector', 'parallel-copy', 'stack-promotion', 'control']),
    validation_subject: z.string().min(1).max(1024), validation_status: z.enum(['verified', 'unverified', 'rejected']),
    scope: z.string().min(1).max(4096), reason: z.string().max(8192).nullable(),
    counterexample: z.record(z.string(), z.string()).optional(),
  }),
  z.strictObject({ kind: z.literal('conflict'), alternatives: ids, reason: z.string().min(1).max(8192) }),
  z.strictObject({
    kind: z.literal('annotation'), annotation_id: annotationIdSchema,
    annotation_status: z.enum(['hypothesis', 'asserted', 'retracted']),
    annotation_kind: z.enum(['name', 'note', 'type', 'signature']),
  }),
]);
export const inferenceSchema = z.strictObject({
  ...common, details: inferenceDetailsSchema,
  review: z.strictObject({
    operation: z.literal('function_get'), view: z.literal('metadata'), function_id: entityIdSchema,
  }),
});
export const requirementSiteSchema = z.strictObject({
  id: z.string().min(1).max(1024), subject_ids: ids, evidence_ids: evidenceRefsSchema,
  instruction_ids: ids, state_epoch: z.string().min(1).max(1024), predicate_value_id: entityIdSchema.optional(),
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
export type Requirement = Internal<WireRequirement>;
export type RequirementSite = Internal<z.infer<typeof requirementSiteSchema>>;
