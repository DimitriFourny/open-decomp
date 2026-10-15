import { z } from 'zod';
import { addressSchema, rangeSchema, hexU64Schema, imageIdSchema, sliceIdSchema, entityIdSchema, evidenceRefsSchema, targetSchema, capabilitySchema, digestSchema, annotationIdSchema, revisionSchema, type Target, type Evidence, type Diagnostic, type Internal } from './primitives.js';
import type { Address, AddressRange, ImageMapping, ImmutableBytes, AddressMap } from './addresses.js';

export const sliceSchema = z.strictObject({ id: sliceIdSchema, image_id: imageIdSchema, offset: hexU64Schema, size: hexU64Schema, architecture: z.string().min(1), subtype: z.string().min(1), supported: z.boolean() });
export const mappingSchema = z.strictObject({ id: entityIdSchema, va: hexU64Schema, memory_size: hexU64Schema, file_offset: hexU64Schema, file_size: hexU64Schema, permissions: z.array(z.enum(['read', 'write', 'execute'])).max(3) });
export const metadataFieldSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('integer'), name: z.string().min(1), value: hexU64Schema }),
  z.strictObject({ kind: z.literal('text'), name: z.string().min(1), value: z.string().max(8192) }),
  z.strictObject({ kind: z.literal('address'), name: z.string().min(1), value: addressSchema }),
  z.strictObject({ kind: z.literal('bytes'), name: z.string().min(1), range: rangeSchema }),
]);
export const headerSchema = z.strictObject({
  kind: z.enum(['mach_header', 'load_command', 'dos_header', 'coff_header', 'optional_header', 'data_directory', 'debug_record', 'tls_record']),
  name: z.string().min(1), range: rangeSchema, fields: z.array(metadataFieldSchema).max(1000), evidence_ids: evidenceRefsSchema,
});
export const sectionSchema = z.strictObject({
  id: entityIdSchema, name: z.string(), segment_id: entityIdSchema.nullable(), kind: z.enum(['segment', 'section']),
  virtual_range: rangeSchema, file_range: rangeSchema.nullable(), permissions: z.array(z.enum(['read', 'write', 'execute'])).max(3),
  flags: hexU64Schema, evidence_ids: evidenceRefsSchema,
});
const namedFields = { id: entityIdSchema, original_name: z.string().nullable(), display_name: z.string().nullable(), evidence_ids: evidenceRefsSchema };
export const symbolSchema = z.strictObject({ ...namedFields, kind: z.enum(['function', 'object', 'section', 'absolute', 'unknown']), address: addressSchema.nullable(), size: hexU64Schema.nullable(), binding: z.enum(['local', 'global', 'weak', 'unknown']) });
export const importSchema = z.strictObject({ ...namedFields, library: z.string().nullable(), ordinal: z.number().int().min(0).max(0xffffffff).nullable(), slot: addressSchema.nullable(), callable_entry: addressSchema.nullable(), delayed: z.boolean(), weak: z.boolean() });
export const exportSchema = z.strictObject({ ...namedFields, address: addressSchema.nullable(), ordinal: z.number().int().min(0).max(0xffffffff).nullable(), forwarder: z.strictObject({ library: z.string(), symbol: z.string() }).nullable() });
export const relocationSchema = z.strictObject({
  id: entityIdSchema, address: addressSchema, kind: z.enum(['relocation', 'rebase', 'bind', 'chained_fixup']),
  encoding: z.string().min(1), width_bits: z.number().int().min(1).max(128), target: addressSchema.nullable(),
  symbol_id: entityIdSchema.nullable(), addend: z.strictObject({ negative: z.boolean(), magnitude: hexU64Schema }),
  authenticated: z.boolean(), evidence_ids: evidenceRefsSchema,
});
export const hintSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('function'), address: addressSchema, size: hexU64Schema.nullable(), evidence_ids: evidenceRefsSchema }),
  z.strictObject({ kind: z.literal('unwind'), range: rangeSchema, encoding: z.string().min(1), record: rangeSchema, handler: addressSchema.nullable(), evidence_ids: evidenceRefsSchema }),
  z.strictObject({ kind: z.literal('data'), range: rangeSchema, encoding: z.enum(['bytes', 'jump_table', 'literal_pool', 'unknown']), evidence_ids: evidenceRefsSchema }),
]);
export const imageSummarySchema = z.strictObject({
  id: imageIdSchema, sha256: digestSchema, byte_length: hexU64Schema, selected_slice_id: sliceIdSchema, image_base: hexU64Schema,
  target: targetSchema, slices: z.array(sliceSchema).max(1024), entry_points: z.array(addressSchema).max(1000), capabilities: z.array(capabilitySchema).max(1000),
});

export interface ImageSlice { readonly id: string; readonly image_id: string; readonly offset: bigint; readonly size: bigint; readonly architecture: string; readonly subtype: string; readonly supported: boolean }
export type MetadataField =
  | { readonly kind: 'integer'; readonly name: string; readonly value: bigint }
  | { readonly kind: 'text'; readonly name: string; readonly value: string }
  | { readonly kind: 'address'; readonly name: string; readonly value: Address }
  | { readonly kind: 'bytes'; readonly name: string; readonly range: AddressRange };
export interface HeaderRecord { readonly kind: z.infer<typeof headerSchema>['kind']; readonly name: string; readonly range: AddressRange; readonly fields: readonly MetadataField[]; readonly evidence_ids: readonly string[] }
export interface Section { readonly id: string; readonly name: string; readonly segment_id: string | null; readonly kind: 'segment' | 'section'; readonly virtual_range: AddressRange; readonly file_range: AddressRange | null; readonly permissions: ImageMapping['permissions']; readonly flags: bigint; readonly evidence_ids: readonly string[] }
export interface SymbolRecord extends Omit<z.infer<typeof symbolSchema>, 'address' | 'size'> { readonly address: Address | null; readonly size: bigint | null }
export interface ImportRecord extends Omit<z.infer<typeof importSchema>, 'slot' | 'callable_entry'> { readonly slot: Address | null; readonly callable_entry: Address | null }
export interface ExportRecord extends Omit<z.infer<typeof exportSchema>, 'address'> { readonly address: Address | null }
export interface Relocation extends Omit<z.infer<typeof relocationSchema>, 'address' | 'target' | 'addend'> { readonly address: Address; readonly target: Address | null; readonly addend: bigint }
export type LoaderHint =
  | { readonly kind: 'function'; readonly address: Address; readonly size: bigint | null; readonly evidence_ids: readonly string[] }
  | { readonly kind: 'unwind'; readonly range: AddressRange; readonly encoding: string; readonly record: AddressRange; readonly handler: Address | null; readonly evidence_ids: readonly string[] }
  | { readonly kind: 'data'; readonly range: AddressRange; readonly encoding: 'bytes' | 'jump_table' | 'literal_pool' | 'unknown'; readonly evidence_ids: readonly string[] };
export interface LoadedImage {
  readonly id: string; readonly sha256: string; readonly bytes: ImmutableBytes; readonly selected_slice_id: string;
  readonly slices: readonly ImageSlice[]; readonly target: Target; readonly image_base: bigint;
  readonly address_map: AddressMap; readonly mappings: readonly ImageMapping[]; readonly headers: readonly HeaderRecord[];
  readonly sections: readonly Section[]; readonly entry_points: readonly Address[]; readonly symbols: readonly SymbolRecord[];
  readonly imports: readonly ImportRecord[]; readonly exports: readonly ExportRecord[]; readonly relocations: readonly Relocation[];
  readonly hints: readonly LoaderHint[]; readonly evidence: readonly Evidence[]; readonly diagnostics: readonly Diagnostic[];
  readonly capabilities: readonly z.infer<typeof capabilitySchema>[];
}

/** Recovered source types reference stable type IDs; these are not semantic IR value types. */
export const typeDefinitionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('void') }),
  z.strictObject({ kind: z.literal('unknown'), size: hexU64Schema.nullable() }),
  z.strictObject({ kind: z.literal('integer'), bits: z.number().int().min(1).max(512), signed: z.boolean() }),
  z.strictObject({ kind: z.literal('float'), bits: z.literal([16, 32, 64, 80, 128]) }),
  z.strictObject({ kind: z.literal('pointer'), to: entityIdSchema, bits: z.literal(64) }),
  z.strictObject({ kind: z.literal('array'), element: entityIdSchema, count: hexU64Schema.nullable() }),
  z.strictObject({ kind: z.literal('vector'), element: entityIdSchema, lanes: z.number().int().min(1).max(256) }),
  z.strictObject({ kind: z.literal('structure'), size: hexU64Schema.nullable(), alignment: z.number().int().min(1).max(65536), fields: z.array(z.strictObject({ id: entityIdSchema, name: z.string().max(1024), offset: hexU64Schema, type_id: entityIdSchema })).max(10000) }),
]);
export const signatureSchema = z.strictObject({
  abi: z.enum(['darwin-arm64', 'windows-x64']), return_type: entityIdSchema,
  parameters: z.array(z.strictObject({ id: entityIdSchema, name: z.string().max(1024).nullable(), type_id: entityIdSchema })).max(1000),
  variadic: z.boolean(), noreturn: z.boolean(), evidence_ids: evidenceRefsSchema,
});
export const functionSchema = z.strictObject({
  ...namedFields, entry: addressSchema, ranges: z.array(rangeSchema).min(1).max(10000),
  boundary: z.enum(['candidate', 'established', 'conflicting']), signature: signatureSchema.nullable(),
  analysis: z.enum(['not_analyzed', 'partial', 'complete', 'unsupported']),
});
export const lineageSchema = z.strictObject({ revision: revisionSchema, reason: z.enum(['split', 'merge', 'replacement']), previous: z.array(entityIdSchema).min(1), next: z.array(entityIdSchema).min(1), evidence_ids: evidenceRefsSchema });
export const stringRecordSchema = z.strictObject({ id: entityIdSchema, address: addressSchema, byte_length: hexU64Schema, encoding: z.enum(['utf8', 'utf16le', 'ascii']), text: z.string().max(1_048_576), status: z.enum(['candidate', 'referenced']), terminated: z.boolean(), evidence_ids: evidenceRefsSchema });
export const referenceSchema = z.strictObject({
  id: entityIdSchema, from: addressSchema, from_function: entityIdSchema.nullable(), to: addressSchema.nullable(), to_entity: entityIdSchema.nullable(),
  kind: z.enum(['call', 'tail_call', 'branch', 'read', 'write', 'address', 'unknown']), status: z.enum(['candidate', 'established', 'unresolved']), evidence_ids: evidenceRefsSchema,
});
export type FunctionRecord = Internal<z.infer<typeof functionSchema>>;
export type StringRecord = Internal<z.infer<typeof stringRecordSchema>>;
export type ReferenceRecord = Internal<z.infer<typeof referenceSchema>>;
export const annotationValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('name'), value: z.string().min(1).max(1024) }),
  z.strictObject({ kind: z.literal('note'), value: z.string().min(1).max(65536) }),
  z.strictObject({ kind: z.literal('type'), type_id: entityIdSchema, definition: typeDefinitionSchema }),
  z.strictObject({ kind: z.literal('signature'), value: signatureSchema }),
]);
export const annotationSchema = z.strictObject({ id: annotationIdSchema, entity_id: entityIdSchema, value: annotationValueSchema, author: z.string().min(1).max(1024), origin: z.enum(['user', 'llm']), status: z.enum(['hypothesis', 'asserted', 'retracted']), evidence_ids: evidenceRefsSchema, revision: revisionSchema });
export const annotationEditSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('set'), id: annotationIdSchema, entity_id: entityIdSchema, value: annotationValueSchema, status: z.enum(['hypothesis', 'asserted']), evidence_ids: evidenceRefsSchema }),
  z.strictObject({ operation: z.literal('retract'), id: annotationIdSchema }),
  z.strictObject({ operation: z.literal('remove'), id: annotationIdSchema }),
]);
export type Annotation = Internal<z.infer<typeof annotationSchema>>;
export type AnnotationEdit = Internal<z.infer<typeof annotationEditSchema>>;
export type RecoveredType = Internal<z.infer<typeof typeDefinitionSchema>>;
export type Signature = Internal<z.infer<typeof signatureSchema>>;
