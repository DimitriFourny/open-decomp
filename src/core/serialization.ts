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
import { encodeRange, decodeRange } from './addresses.js';
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
  if (value.value.kind === 'type')
    return {
      ...value,
      value: { ...value.value, definition: decodeTypeDefinition(value.value.definition) },
    };
  return { ...value, value: value.value };
}
export function encodeAnnotation(value: Annotation): z.output<typeof annotationSchema> {
  return annotationSchema.parse(
    value.value.kind === 'type'
      ? {
          ...value,
          value: { ...value.value, definition: encodeTypeDefinition(value.value.definition) },
        }
      : value,
  );
}
export function decodeAnnotationEdit(input: z.input<typeof annotationEditSchema>): AnnotationEdit {
  const edit = annotationEditSchema.parse(input);
  if (edit.operation !== 'set') return edit;
  const value = edit.value;
  if (value.kind === 'type')
    return { ...edit, value: { ...value, definition: decodeTypeDefinition(value.definition) } };
  return { ...edit, value };
}
export function encodeAnnotationEdit(edit: AnnotationEdit): z.output<typeof annotationEditSchema> {
  return annotationEditSchema.parse(
    edit.operation === 'set' && edit.value.kind === 'type'
      ? {
          ...edit,
          value: { ...edit.value, definition: encodeTypeDefinition(edit.value.definition) },
        }
      : edit,
  );
}
export function encodeArtifact(value: Artifact): WireArtifact {
  return artifactSchema.parse({ ...value, size: formatHexU64(value.size) });
}
export function decodeArtifact(value: WireArtifact): Artifact {
  const parsed = artifactSchema.parse(value);
  return { ...parsed, size: parseHexU64(parsed.size) };
}
export function encodeEmission(value: Emission): WireEmission {
  const { inferences, requirements, ...rest } = value;
  return emissionSchema.parse({
    ...rest,
    mappings: value.mappings.map((mapping) => ({
      ...mapping,
      ranges: mapping.ranges.map(encodeRange),
    })),
    ...(inferences && {
      inferences: inferences.map((record) => ({
        ...record,
        ranges: record.ranges.map(encodeRange),
      })),
    }),
    ...(requirements && {
      requirements: requirements.map((record) => ({
        ...record,
        ranges: record.ranges.map(encodeRange),
      })),
    }),
  });
}
export function decodeEmission(value: WireEmission): Emission {
  const { inferences, requirements, ...parsed } = emissionSchema.parse(value);
  return {
    ...parsed,
    mappings: parsed.mappings.map((mapping) => ({
      ...mapping,
      ranges: mapping.ranges.map(decodeRange),
    })),
    ...(inferences && {
      inferences: inferences.map((record) => ({
        ...record,
        ranges: record.ranges.map(decodeRange),
      })),
    }),
    ...(requirements && {
      requirements: requirements.map((record) => ({
        ...record,
        ranges: record.ranges.map(decodeRange),
      })),
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
