import { z } from 'zod';
import { formatHexU64, parseHexU64 } from './integers.js';
import { artifactSchema, type Artifact, type WireArtifact } from './primitives.js';
import {
  annotationSchema,
  annotationEditSchema,
  typeDefinitionSchema,
  type RecoveredType,
  type Annotation,
  type AnnotationEdit,
} from './model.js';
import {
  emissionSchema,
  jobSchema,
  type Emission,
  type WireEmission,
  type Job,
  type WireJob,
} from './tools.js';
import { encodeRange, decodeRange, type AddressRange } from './addresses.js';
import type { ExpandedInference, ExpandedRequirement } from './inference.js';
import { encodeDiagnostic, decodeDiagnostic } from './validation.js';

export function decodeTypeDefinition(input: z.input<typeof typeDefinitionSchema>): RecoveredType {
  const value = typeDefinitionSchema.parse(input);
  switch (value.kind) {
    case 'unknown':
      return { ...value, size: value.size === null ? null : parseHexU64(value.size) };
    case 'array':
      return { ...value, count: value.count === null ? null : parseHexU64(value.count) };
    case 'structure':
      return {
        ...value,
        size: value.size === null ? null : parseHexU64(value.size),
        fields: value.fields.map((field) => ({ ...field, offset: parseHexU64(field.offset) })),
      };
    default:
      return value;
  }
}
export function encodeTypeDefinition(value: RecoveredType): z.output<typeof typeDefinitionSchema> {
  switch (value.kind) {
    case 'unknown':
      return typeDefinitionSchema.parse({
        ...value,
        size: value.size === null ? null : formatHexU64(value.size),
      });
    case 'array':
      return typeDefinitionSchema.parse({
        ...value,
        count: value.count === null ? null : formatHexU64(value.count),
      });
    case 'structure':
      return typeDefinitionSchema.parse({
        ...value,
        size: value.size === null ? null : formatHexU64(value.size),
        fields: value.fields.map((field) => ({ ...field, offset: formatHexU64(field.offset) })),
      });
    default:
      return typeDefinitionSchema.parse(value);
  }
}
export function decodeAnnotation(input: z.input<typeof annotationSchema>): Annotation {
  const value = annotationSchema.parse(input);
  if (value.value.kind !== 'type') return { ...value, value: value.value };
  const { definition, ...binding } = value.value;
  return {
    ...value,
    value:
      definition === undefined
        ? binding
        : { ...binding, definition: decodeTypeDefinition(definition) },
  };
}
export function encodeAnnotation(value: Annotation): z.output<typeof annotationSchema> {
  return annotationSchema.parse(
    value.value.kind === 'type' && value.value.definition !== undefined
      ? {
          ...value,
          value: { ...value.value, definition: encodeTypeDefinition(value.value.definition) },
        }
      : value,
  );
}
export function decodeAnnotationEdit(input: z.input<typeof annotationEditSchema>): AnnotationEdit {
  const parsed = annotationEditSchema.parse(input);
  if (parsed.operation !== 'set') return parsed;
  const { address, value, ...edit } = parsed;
  const subject = {
    ...edit,
    ...(address === undefined
      ? {}
      : { address: { ...address, value: parseHexU64(address.value) } }),
  };
  if (value.kind !== 'type') return { ...subject, value };
  const { definition, ...binding } = value;
  return {
    ...subject,
    value:
      definition === undefined
        ? binding
        : { ...binding, definition: decodeTypeDefinition(definition) },
  };
}
export function encodeAnnotationEdit(edit: AnnotationEdit): z.output<typeof annotationEditSchema> {
  if (edit.operation !== 'set') return annotationEditSchema.parse(edit);
  const { address, value, ...rest } = edit;
  return annotationEditSchema.parse({
    ...rest,
    ...(address === undefined
      ? {}
      : { address: { ...address, value: formatHexU64(address.value) } }),
    value:
      value.kind === 'type' && value.definition !== undefined
        ? { ...value, definition: encodeTypeDefinition(value.definition) }
        : value,
  });
}
export function encodeArtifact(value: Artifact): WireArtifact {
  return artifactSchema.parse({ ...value, size: formatHexU64(value.size) });
}
export function decodeArtifact(value: WireArtifact): Artifact {
  const parsed = artifactSchema.parse(value);
  return { ...parsed, size: parseHexU64(parsed.size) };
}
/** Only the interned range table carries hex integers; every record cites it by index. */
export function encodeEmission(value: Emission): WireEmission {
  return emissionSchema.parse({ ...value, ranges: value.ranges.map(encodeRange) });
}
export function decodeEmission(value: WireEmission): Emission {
  const parsed = emissionSchema.parse(value);
  return { ...parsed, ranges: parsed.ranges.map(decodeRange) };
}
type WireRange = WireEmission['ranges'][number];
export interface ExpandedSourceMapping<Range = WireRange> {
  readonly statement_id: string;
  readonly start: number;
  readonly end: number;
  readonly semantic_ids: readonly string[];
  readonly instruction_ids: readonly string[];
  readonly ranges: readonly Range[];
  readonly evidence_ids: readonly string[];
}
/** Consumer view with every table reference replaced by its identity/range. */
export type ExpandedEmission<Range = WireRange> = Omit<
  Emission,
  'ids' | 'evidence' | 'ranges' | 'mappings' | 'inferences' | 'requirements'
> & {
  readonly mappings: readonly ExpandedSourceMapping<Range>[];
  readonly inferences?: readonly ExpandedInference<Range>[];
  readonly requirements?: readonly ExpandedRequirement<Range>[];
};
type CompactEmission<Range> = Omit<Emission, 'ranges'> & { readonly ranges: readonly Range[] };
/** Expand the canonical compact emission (wire or internal ranges) into string
 * identities. A view only: nothing is added, dropped or reordered. */
export function expandEmission(value: WireEmission): ExpandedEmission;
export function expandEmission(value: Emission): ExpandedEmission<AddressRange>;
export function expandEmission<Range>(value: CompactEmission<Range>): ExpandedEmission<Range> {
  const { ids, evidence, ranges, mappings, inferences, requirements, ...rest } = value;
  const lookup = <T>(table: readonly T[], refs: readonly number[]): T[] =>
    refs.map((ref) => {
      if (!Number.isInteger(ref) || ref < 0 || ref >= table.length)
        throw new RangeError('Emission reference is outside its table');
      return table[ref]!;
    });
  const references = (record: {
    readonly subject_refs: readonly number[];
    readonly evidence_refs: readonly number[];
    readonly instruction_refs: readonly number[];
  }) => ({
    subject_ids: lookup(ids, record.subject_refs),
    evidence_ids: lookup(evidence, record.evidence_refs),
    instruction_ids: lookup(ids, record.instruction_refs),
  });
  return {
    ...rest,
    mappings: mappings.map(
      ({ semantic_refs, instruction_refs, range_refs, evidence_refs, ...span }) => {
        const semantic_ids = lookup(ids, semantic_refs);
        return {
          statement_id: semantic_ids[0]!,
          ...span,
          semantic_ids,
          instruction_ids: lookup(ids, instruction_refs),
          ranges: lookup(ranges, range_refs),
          evidence_ids: lookup(evidence, evidence_refs),
        };
      },
    ),
    ...(inferences && {
      inferences: inferences.map(
        ({ subject_refs, evidence_refs, instruction_refs, range_refs, ...record }) => ({
          ...record,
          ...references({ subject_refs, evidence_refs, instruction_refs }),
          ranges: lookup(ranges, range_refs),
        }),
      ),
    }),
    ...(requirements && {
      requirements: requirements.map(
        ({ subject_refs, evidence_refs, instruction_refs, range_refs, sites, ...record }) => ({
          ...record,
          ...references({ subject_refs, evidence_refs, instruction_refs }),
          ranges: lookup(ranges, range_refs),
          sites: sites.map(({ subject_refs, evidence_refs, instruction_refs, ...site }) => ({
            ...site,
            ...references({ subject_refs, evidence_refs, instruction_refs }),
          })),
        }),
      ),
    }),
  };
}
export function encodeJob(value: Job): WireJob {
  return jobSchema.parse({
    ...value,
    artifacts: value.artifacts.map(encodeArtifact),
    diagnostics: value.diagnostics.map(encodeDiagnostic),
  });
}
export function decodeJob(value: WireJob): Job {
  const parsed = jobSchema.parse(value);
  return {
    ...parsed,
    artifacts: parsed.artifacts.map(decodeArtifact),
    diagnostics: parsed.diagnostics.map(decodeDiagnostic),
  };
}
