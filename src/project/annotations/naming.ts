import type { Annotation } from '../../core/index.js';

/** The annotations that name their subjects: every `name` annotation, and for a subject that
 * has no unretracted `name` annotation, each `library_match` read as a name with the same
 * identity, status and evidence. A library match never overrides a user's or LLM's name, and
 * competing matches stay competing (several asserted names present none). */
export function namingAnnotations(annotations: readonly Annotation[]): Annotation[] {
  if (!annotations.some((annotation) => annotation.value.kind === 'library_match'))
    return annotations.filter((annotation) => annotation.value.kind === 'name');
  const named = new Set(
    annotations
      .filter((annotation) => annotation.value.kind === 'name' && annotation.status !== 'retracted')
      .map((annotation) => annotation.entity_id),
  );
  return annotations.flatMap((annotation): Annotation[] => {
    if (annotation.value.kind === 'name') return [annotation];
    if (annotation.value.kind !== 'library_match' || named.has(annotation.entity_id)) return [];
    return [{ ...annotation, value: { kind: 'name', value: annotation.value.name } }];
  });
}
