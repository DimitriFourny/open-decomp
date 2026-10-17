import { entityIdSchema, evidenceIdSchema, imageIdSchema, type ToolResult } from '../core/index.js';

type InvestigationResult = ToolResult<'function_get'>;

/** A model-facing layout of already validated records, not another semantic
 * model. structuredContent stays complete; this text interns repeated IDs once
 * and omits transport/version/budget boilerplate and full instruction payloads. */
export function investigationText(result: InvestigationResult): string | undefined {
  if (!('data' in result) || result.data.view !== 'investigation') return undefined;
  const data = result.data;
  const references: string[] = [];
  const indexes = new Map<string, number>();
  const intern = (id: string) => {
    let index = indexes.get(id);
    if (index === undefined) {
      index = references.length;
      indexes.set(id, index);
      references.push(id);
    }
    return index;
  };
  const literalFields: Readonly<Record<string, true>> = {
    text: true, literal: true, name: true, explanation: true, reason: true, scope: true, state_epoch: true,
  };
  const graphFields: Readonly<Record<string, true>> = {
    subject_refs: true, subject_ids: true, value_ids: true, operand_value_ids: true,
    association_ids: true, type_id: true, source_type_id: true, pointee_id: true,
    return_type: true, shape_id: true, field_ids: true, call_id: true,
    signature_id: true, alternatives: true, image_id: true, entity_id: true,
  };
  const compact = (value: unknown, field = ''): unknown => {
    if (typeof value === 'string') {
      if (literalFields[field]) return value;
      if (entityIdSchema.safeParse(value).success || evidenceIdSchema.safeParse(value).success || imageIdSchema.safeParse(value).success)
        return { ref: intern(value) };
      return value;
    }
    if (Array.isArray(value)) {
      if (field === 'subject_refs' || field === 'instruction_refs' || field === 'evidence_refs')
        return value.map((index: number) => intern(data.references[index]!));
      return value.map((item) => compact(item, field));
    }
    if (value !== null && typeof value === 'object') {
      const projected: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        // Null type/signature references are visible absence, not graph noise.
        if (graphFields[key] && item !== null) continue;
        if (key === 'id' && typeof item === 'string' && entityIdSchema.safeParse(item).success) continue;
        projected[key] = compact(item, key);
      }
      return projected;
    }
    return value;
  };
  const items = compact(data.items);
  const diagnostics = compact(result.diagnostics);
  const count = data.selection.counts;
  return JSON.stringify({ artifact_id: data.artifact_id, query_state: result.state,
    analysis_state: data.analysis_state,
    scope: { kinds: data.selection.kinds, subject_id: data.selection.subject_id, counts_format: '[selected,total]',
      inferences: [count.inferences.selected, count.inferences.total],
      requirements: [count.requirements.selected, count.requirements.total],
      unresolved_sites: [count.unresolved_sites.selected, count.unresolved_sites.total],
      omitted_statuses: data.selection.omitted_inference_statuses,
      omitted_requirements: data.selection.omitted_requirement_kinds },
    coverage_incomplete: result.coverage.filter((coverage) => coverage.state !== 'complete'),
    diagnostics, items, references,
    ...(data.page.next_cursor === null ? {} : { next_cursor: data.page.next_cursor }),
  });
}
