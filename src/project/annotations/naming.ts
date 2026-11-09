import type { Address, Annotation } from '../../core/index.js';
import type { MatchedLibraryFunction } from '../../metadata/library-signatures/contracts.js';

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

/** Functions an asserted `library_match` annotation with a contract gives a library
 * declaration: the function entry and the declaration's nominal library and name. */
export function libraryMatches(
  annotations: readonly Annotation[],
  entries: ReadonlyMap<string, Address>,
): MatchedLibraryFunction[] {
  return annotations.flatMap((annotation) => {
    const value = annotation.value,
      entry = entries.get(annotation.entity_id);
    if (annotation.status !== 'asserted' || value.kind !== 'library_match' || !value.contract)
      return [];
    if (!entry) return [];
    return [
      {
        function_id: annotation.entity_id,
        entry,
        library: value.contract.library,
        name: value.contract.name,
        evidence_ids: annotation.evidence_ids,
      },
    ];
  });
}
