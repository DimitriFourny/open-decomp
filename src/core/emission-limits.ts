import type { z } from 'zod';
import type { Diagnostic, coverageSchema } from './primitives.js';
import type { WireEmission } from './tools.js';

export type EmissionOmission = NonNullable<WireEmission['omitted']>[number];
export type EmissionMetadataKind = EmissionOmission['kind'];

/** Metadata classes in the order a size bound sheds them: the largest, most
 * derivative records first. The pseudocode text itself is never shed. */
export const EMISSION_METADATA_SHED_ORDER: readonly (readonly EmissionMetadataKind[])[] = [
  ['inferences'],
  ['mappings'],
  ['requirements'],
];

const DESCRIPTION: Readonly<Record<EmissionMetadataKind, string>> = {
  mappings: 'source mappings',
  inferences: 'inference records',
  requirements: 'requirement proofs',
};

/** Merge omission records of one emission; a known count never hides an unknown one. */
export function mergeOmissions(
  ...lists: readonly (readonly EmissionOmission[] | undefined)[]
): EmissionOmission[] {
  const merged = new Map<EmissionMetadataKind, EmissionOmission>();
  for (const list of lists)
    for (const item of list ?? []) {
      const previous = merged.get(item.kind);
      merged.set(
        item.kind,
        previous === undefined
          ? item
          : {
              ...item,
              omitted:
                previous.omitted === null || item.omitted === null
                  ? null
                  : previous.omitted + item.omitted,
            },
      );
    }
  return [...merged.values()];
}

/** Coverage of the provenance layer: the code is whole, its named metadata is not. */
export function provenanceCoverage(
  omitted: readonly EmissionOmission[],
): z.output<typeof coverageSchema> {
  return {
    layer: 'provenance',
    state: omitted.length === 0 ? 'complete' : 'partial',
    completed_units: omitted.length === 0 ? 1 : 0,
    total_units: 1,
    reasons: omitted.map(
      (item) =>
        `output_limit: ${item.omitted === null ? 'some' : item.omitted} ${DESCRIPTION[item.kind]} omitted; the pseudocode text is complete`,
    ),
  };
}

/** Remove whole metadata classes from a wire emission, then compact its identity,
 * proof and range tables to the entries the remaining records still cite. The text,
 * spans of the remaining records and their reference semantics are unchanged. */
export function shedEmissionMetadata(
  emission: WireEmission,
  kinds: readonly EmissionMetadataKind[],
): WireEmission {
  const shed = new Set(kinds);
  const count = (kind: EmissionMetadataKind): number =>
    kind === 'mappings'
      ? emission.mappings.length
      : kind === 'inferences'
        ? (emission.inferences?.length ?? 0)
        : (emission.requirements?.length ?? 0);
  const dropped = [...shed].filter((kind) => count(kind) > 0);
  const mappings = shed.has('mappings') ? [] : emission.mappings;
  const inferences = shed.has('inferences') ? [] : (emission.inferences ?? []);
  const requirements = shed.has('requirements') ? [] : (emission.requirements ?? []);

  const tables = {
    ids: new Map<number, number>(),
    evidence: new Map<number, number>(),
    ranges: new Map<number, number>(),
  };
  const mark = (table: Map<number, number>, refs: readonly number[]): void => {
    for (const ref of refs) table.set(ref, 0);
  };
  const markRecord = (record: {
    readonly subject_refs?: readonly number[];
    readonly semantic_refs?: readonly number[];
    readonly instruction_refs: readonly number[];
    readonly evidence_refs: readonly number[];
    readonly range_refs?: readonly number[];
  }): void => {
    mark(tables.ids, record.subject_refs ?? record.semantic_refs ?? []);
    mark(tables.ids, record.instruction_refs);
    mark(tables.evidence, record.evidence_refs);
    mark(tables.ranges, record.range_refs ?? []);
  };
  for (const mapping of mappings) markRecord(mapping);
  for (const inference of inferences) markRecord(inference);
  for (const requirement of requirements) {
    markRecord(requirement);
    for (const site of requirement.sites) markRecord(site);
  }
  const renumber = <T>(table: Map<number, number>, items: readonly T[]): T[] => {
    const kept: T[] = [];
    for (const [index, item] of items.entries())
      if (table.has(index)) {
        table.set(index, kept.length);
        kept.push(item);
      }
    return kept;
  };
  const ids = renumber(tables.ids, emission.ids);
  const evidence = renumber(tables.evidence, emission.evidence);
  const ranges = renumber(tables.ranges, emission.ranges);
  const map = (table: Map<number, number>, refs: readonly number[]): number[] =>
    refs.map((ref) => table.get(ref)!);
  const remap = <R extends Record<string, unknown>>(record: R): R => {
    const result: Record<string, unknown> = { ...record };
    for (const key of ['subject_refs', 'semantic_refs', 'instruction_refs'] as const)
      if (key in record) result[key] = map(tables.ids, record[key] as number[]);
    if ('evidence_refs' in record)
      result['evidence_refs'] = map(tables.evidence, record['evidence_refs'] as number[]);
    if ('range_refs' in record)
      result['range_refs'] = map(tables.ranges, record['range_refs'] as number[]);
    return result as R;
  };
  const { inferences: _inferences, requirements: _requirements, omitted: _omitted, ...rest } =
    emission;
  return {
    ...rest,
    ids,
    evidence,
    ranges,
    mappings: mappings.map(remap),
    ...(emission.inferences === undefined && !shed.has('inferences')
      ? {}
      : { inferences: inferences.map(remap) }),
    ...(emission.requirements === undefined && !shed.has('requirements')
      ? {}
      : {
          requirements: requirements.map((requirement) => ({
            ...remap(requirement),
            sites: requirement.sites.map(remap),
          })),
        }),
    omitted: mergeOmissions(
      emission.omitted,
      dropped.map((kind) => ({ kind, reason: 'output_limit' as const, omitted: count(kind) })),
    ),
  };
}

/** Wire bound of a result's diagnostic list. */
export const MAX_RESULT_DIAGNOSTICS = 1000;

/** Diagnostics that did not fit the wire list. They are counted by code, never dropped
 * silently: one trailing record states the omission, as `unavailable_semantics` (so the
 * reconstruction layer stays partial) when any semantic limitation was among them. */
export function omittedDiagnosticsSummary(
  counts: ReadonlyMap<Diagnostic['code'], number>,
  truncatedCitations = 0,
): Diagnostic | undefined {
  let total = 0;
  for (const count of counts.values()) total += count;
  if (total === 0 && truncatedCitations === 0) return undefined;
  const parts = [...counts].map(([code, count]) => `${count} ${code}`);
  if (truncatedCitations) parts.push(`${truncatedCitations} evidence citations`);
  const semantic = counts.has('unavailable_semantics');
  return {
    code: semantic ? 'unavailable_semantics' : 'resource_limit',
    severity: semantic ? 'warning' : 'info',
    message: `output_limit: diagnostics beyond the ${MAX_RESULT_DIAGNOSTICS}-entry list bound were omitted (${parts.join(', ')}); the pseudocode text is complete`,
    evidence_ids: [],
  };
}

/** Keep the first diagnostics of a list that exceeds the wire bound, plus the summary. */
export function boundDiagnostics(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  if (diagnostics.length <= MAX_RESULT_DIAGNOSTICS) return diagnostics;
  const kept = diagnostics.slice(0, MAX_RESULT_DIAGNOSTICS - 1);
  const counts = new Map<Diagnostic['code'], number>();
  for (const item of diagnostics.slice(MAX_RESULT_DIAGNOSTICS - 1))
    counts.set(item.code, (counts.get(item.code) ?? 0) + 1);
  return [...kept, omittedDiagnosticsSummary(counts)!];
}
