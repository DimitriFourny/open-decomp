import type { DataLayout, OperationContext, RecoveredType } from '../core/index.js';
import type {
  TypeAssociation,
  TypeRecoveryResult,
  SuppliedTypeRecord,
} from '../analysis/types/index.js';
import { SourceLayouts, typeKey } from '../analysis/types/layout.js';
import { AnalysisBudget } from '../analysis/ssa/budget.js';
import { bitWidth, type Expression, type Value } from '../ir/index.js';
import type { BoundaryProjection, MemoryView } from './model.js';
import type { SourcePresentation, SourceTypeView } from './source-model.js';

/** Project complete source constraints without changing machine storage or
 * promoting an operation's signed interpretation into a source declaration. */
export function projectSourceTypes(
  types: TypeRecoveryResult | undefined,
  source: SourcePresentation,
  values: ReadonlyMap<string, Value>,
  expressions: ReadonlyMap<string, Expression>,
  returns: ReadonlyMap<string, BoundaryProjection>,
  memory: ReadonlyMap<string, MemoryView>,
  layout: DataLayout,
  context: OperationContext,
): Pick<SourcePresentation, 'value_types' | 'return_source_type' | 'field_subjects'> {
  const projected = new Map<string, SourceTypeView>();
  const established = new Set<string>();
  const fieldSubjects = new Map<string, readonly string[]>();
  if (types?.state !== 'complete') return { value_types: projected, field_subjects: fieldSubjects };
  const conflicts = new Set(types.conflicts.map((conflict) => conflict.subject_id));
  const records = new Map<string, SuppliedTypeRecord[]>();
  for (const record of types.types) {
    context.checkpoint(1);
    if (record.status === 'conflicting') conflicts.add(record.id);
    if (
      record.status !== 'established' &&
      record.status !== 'asserted' &&
      !(record.source === 'analysis' && record.status === 'candidate')
    )
      continue;
    const group = records.get(record.id) ?? [];
    group.push(record);
    records.set(record.id, group);
  }
  const dependents = new Map<string, Set<string>>();
  for (const shape of types.shapes) {
    if (shape.base.kind === 'value')
      for (const subject of [shape.id, shape.type_id]) {
        const group = dependents.get(subject) ?? new Set<string>();
        group.add(shape.base.value_id);
        dependents.set(subject, group);
      }
    for (const field of shape.fields) {
      const sources = [
        shape.id,
        shape.type_id,
        field.id,
        ...(field.origin_ids ?? []),
        ...field.node_ids,
        ...(shape.base.kind === 'value' ? [shape.base.value_id] : []),
      ];
      for (const subject of sources) {
        context.checkpoint(1);
        const group = dependents.get(subject) ?? new Set<string>();
        group.add(field.id);
        for (const value of field.value_ids) group.add(value);
        dependents.set(subject, group);
      }
    }
  }
  // A subject conflicted only through a layout it depends on keeps the
  // layout-free evidence that it holds an address (`void *`, below).
  const direct = new Set(conflicts);
  const pendingConflicts = [...conflicts];
  for (let index = 0; index < pendingConflicts.length; index++)
    for (const subject of dependents.get(pendingConflicts[index]!) ?? []) {
      context.checkpoint(1);
      if (conflicts.has(subject)) continue;
      conflicts.add(subject);
      pendingConflicts.push(subject);
    }
  const layouts = new SourceLayouts(
    records,
    new AnalysisBudget({
      max_work: context.budget.work,
      checkpoint: (work) => context.checkpoint(work),
    }),
    // Source layout sizes are target facts; observed extents never enter here.
    layout,
  );
  const definitions = new Map<string, RecoveredType | null>();
  const keys = new Map<string, string>();
  const definition = (id: string): RecoveredType | null => {
    if (conflicts.has(id)) return null;
    if (definitions.has(id)) return definitions.get(id)!;
    const result = layouts.definition(id);
    definitions.set(id, result);
    if (result) keys.set(id, typeKey(result));
    return result;
  };
  /** A pointer to `void`: an address of no particular object type. */
  const untyped = (id: string): boolean => {
    const type = definition(id);
    if (type?.kind !== 'pointer') return false;
    // An opaque declared pointee (`unknown`) is a specific named type, not `void`.
    return definition(type.to)?.kind === 'void';
  };
  /** An analysis pointer whose pointee does not depend on a recovered layout. */
  const addressEvidence = (association: TypeAssociation): boolean =>
    association.source === 'analysis' &&
    association.status === 'candidate' &&
    untyped(association.type_id);
  /** Members of a pointee: a scalar pointee is one member at offset zero. */
  const pointeeMembers = (
    pointee: string,
  ): { offset: bigint; key: string | undefined }[] | null => {
    const type = definition(pointee);
    if (type?.kind === 'integer' || type?.kind === 'float')
      return [{ offset: 0n, key: keys.get(pointee) }];
    if (type?.kind !== 'structure') return null;
    return type.fields.map((field) => {
      context.checkpoint(1);
      return {
        offset: field.offset,
        key: definition(field.type_id) ? keys.get(field.type_id) : undefined,
      };
    });
  };
  /** Pointer `outer` declares every member of `inner`'s pointee at the same
   * offset with the same type (identical layouts contain each other). */
  const containsLayout = (outer: string, inner: string): boolean => {
    if (keys.get(outer) === keys.get(inner)) return true;
    const a = definition(outer),
      b = definition(inner);
    if (a?.kind !== 'pointer' || b?.kind !== 'pointer') return false;
    const wide = pointeeMembers(a.to),
      narrow = pointeeMembers(b.to);
    return (
      !!wide &&
      !!narrow &&
      narrow.every(
        (field) =>
          field.key !== undefined &&
          wide.some((member) => member.offset === field.offset && member.key === field.key),
      )
    );
  };
  const associations = new Map<string, TypeAssociation[]>();
  for (const association of types.associations) {
    context.checkpoint(1);
    if (
      (conflicts.has(association.subject_id) &&
        (direct.has(association.subject_id) || !addressEvidence(association))) ||
      conflicts.has(association.type_id) ||
      association.status === 'conflicting' ||
      association.status === 'hypothesis' ||
      (association.status === 'candidate' && association.source !== 'analysis') ||
      association.machine_offset_bits !== 0 ||
      association.width_bits === null
    )
      continue;
    const group = associations.get(association.subject_id) ?? [];
    group.push(association);
    associations.set(association.subject_id, group);
  }
  for (const value of values.values()) {
    context.checkpoint(1);
    if (direct.has(value.id)) continue;
    const expression = expressions.get(value.id);
    const transport =
      !expression ||
      expression.kind === 'concat' ||
      (expression.kind === 'extract' && expression.offset === 0) ||
      (expression.kind === 'cast' && (expression.op === 'bitcast' || expression.op === 'truncate'));
    const subjects = transport
      ? [value.id, ...(source.value_origins?.get(value.id) ?? [])]
      : [value.id];
    if (subjects.some((id) => direct.has(id))) continue;
    let candidates = subjects.flatMap((id) => associations.get(id) ?? []);
    // A layout conflict leaves only the evidence that the value is an address.
    if (subjects.some((id) => conflicts.has(id)))
      candidates = candidates.filter((item) => addressEvidence(item));
    if (!candidates.length) continue;
    const declared = candidates.filter(
      (item) =>
        item.source !== 'analysis' && (item.status === 'established' || item.status === 'asserted'),
    );
    // A declaration wins over analysis, except that a declared `void *` is
    // refined by an observed object pointer (C converts it implicitly).
    if (declared.length)
      candidates = declared.every((item) => untyped(item.type_id))
        ? [
            ...declared,
            ...candidates.filter(
              (item) =>
                item.source === 'analysis' &&
                definition(item.type_id)?.kind === 'pointer' &&
                !untyped(item.type_id),
            ),
          ]
        : declared;
    const groups = new Map<string, TypeAssociation[]>();
    for (const candidate of candidates) {
      const type = definition(candidate.type_id);
      if (!type) continue;
      // A signed consumer constrains that operation, not the author's scalar
      // declaration. Its signed cast remains on the machine expression itself.
      if (
        candidate.source === 'analysis' &&
        candidate.status === 'candidate' &&
        type.kind === 'integer' &&
        type.signed
      )
        continue;
      const width =
        type.kind === 'integer' || type.kind === 'pointer' || type.kind === 'float'
          ? type.bits
          : type.kind === 'vector'
            ? layouts.size(candidate.type_id)
            : null;
      const bits = typeof width === 'bigint' ? Number(width * 8n) : width;
      if (
        bits !== bitWidth(value.type) ||
        ((type.kind === 'integer' || type.kind === 'pointer') && value.type.kind !== 'integer') ||
        (type.kind === 'float' && value.type.kind !== 'float') ||
        (type.kind === 'vector' && value.type.kind !== 'vector')
      )
        continue;
      if (type.kind === 'vector' && value.type.kind === 'vector') {
        const element = definition(type.element);
        if (
          (element?.kind !== 'integer' && element?.kind !== 'float') ||
          type.lanes !== value.type.lanes ||
          element.kind !== value.type.element.kind ||
          element.bits !== value.type.element.bits
        )
          continue;
      }
      const key = keys.get(candidate.type_id)!,
        group = groups.get(key) ?? [];
      group.push(candidate);
      groups.set(key, group);
    }
    let pointer = false;
    for (const group of groups.values())
      pointer ||= definition(group[0]!.type_id)?.kind === 'pointer';
    if (pointer)
      for (const [key, group] of groups)
        if (
          group.every((item) => {
            const type = definition(item.type_id);
            return (
              item.source === 'analysis' &&
              item.status === 'candidate' &&
              type?.kind === 'integer' &&
              !type.signed
            );
          })
        )
          groups.delete(key);
    // Pointer alternatives: an object pointer beats a bare address; equal or
    // nested observed layouts merge into the widest; unrelated object views
    // fall back to the bare address their dereferences prove.
    if (pointer) {
      const pointers = [...groups].filter(([, group]) => {
        const type = definition(group[0]!.type_id);
        return type?.kind === 'pointer';
      });
      const objects = pointers.filter(([, group]) => !untyped(group[0]!.type_id));
      const merged = objects.find(([, group]) =>
        objects.every(([, other]) => containsLayout(group[0]!.type_id, other[0]!.type_id)),
      );
      if (pointers.length === groups.size && objects.length)
        for (const [key] of pointers)
          if (merged ? key !== merged[0] : !untyped(groups.get(key)![0]!.type_id))
            groups.delete(key);
    }
    // Alternatives remain alternatives even when their machine widths coincide.
    if (groups.size !== 1) continue;
    const group = [...groups.values()][0]!;
    const ranges = group
      .map((item) => ({
        start: item.value_offset_bits,
        end: item.value_offset_bits + item.width_bits!,
      }))
      .sort((a, b) => a.start - b.start);
    let covered = 0,
      valid = true;
    for (const range of ranges) {
      context.checkpoint(1);
      if (range.start > covered || range.start < 0 || range.end > bitWidth(value.type)) {
        valid = false;
        break;
      }
      covered = Math.max(covered, range.end);
    }
    if (!valid || covered !== bitWidth(value.type)) continue;
    if (group.some((item) => item.status === 'established' || item.status === 'asserted'))
      established.add(value.id);
    projected.set(value.id, {
      type_id: group.map((item) => item.type_id).sort()[0]!,
      association_ids: [...new Set(group.map((item) => item.id))],
      subject_ids: [...new Set(group.map((item) => item.subject_id))],
      evidence_ids: [...new Set(group.flatMap((item) => item.evidence_ids))],
    });
  }
  const memberSubjects = (
    id: string,
    offset: bigint,
    width: number,
    active = new Set<string>(),
  ): string[] => {
    context.checkpoint(1);
    if (offset < 0n || active.has(id) || active.size >= 64 || conflicts.has(id)) return [];
    const type = definition(id);
    if (!type) return [];
    active.add(id);
    const result: string[] = [];
    if (type.kind === 'structure')
      for (const field of type.fields) {
        context.checkpoint(1);
        if (conflicts.has(field.id) || offset < field.offset) continue;
        const local = offset - field.offset;
        if (!layouts.fields(field.type_id, local, width).length) continue;
        result.push(field.id, ...memberSubjects(field.type_id, local, width, active));
      }
    else if (type.kind === 'array' || type.kind === 'vector') {
      const size = layouts.size(type.element);
      const count = type.kind === 'array' ? type.count : BigInt(type.lanes);
      if (size !== null && size > 0n && (count === null || offset / size < count))
        result.push(...memberSubjects(type.element, offset % size, width, active));
    }
    active.delete(id);
    return result;
  };
  for (const [node, view] of memory) {
    context.checkpoint(1);
    if (view.shape.base.kind !== 'value') continue;
    if (view.field.dynamic) continue;
    const base = projected.get(view.shape.base.value_id);
    const pointer = base && definition(base.type_id);
    if (pointer?.kind !== 'pointer') continue;
    const members = (view.field.origin_ids ?? []).filter((id) => !conflicts.has(id));
    // Dynamic indexing cannot be presumed to stay within a particular member.
    if (view.field.stride === null || definition(pointer.to)?.kind === 'array')
      members.push(...memberSubjects(pointer.to, view.field.offset, view.field.width_bits));
    if (members.length) fieldSubjects.set(node, [...new Set(members)]);
  }
  const returnedValues = [...returns.values()].map((boundary) =>
    boundary.results.length === 1 ? boundary.results[0] : undefined,
  );
  const returned = returnedValues.map((value) => value && projected.get(value.id));
  const first = returned[0];
  // An unsigned storage-use constraint is weaker than exact literal/data pointer
  // evidence. Only an independent scalar declaration can override that role.
  const weakScalarPointer =
    source.return_pointer &&
    first &&
    definition(first.type_id)?.kind === 'integer' &&
    returnedValues.some((value) => !value || !established.has(value.id));
  const returnType =
    !weakScalarPointer &&
    first &&
    returned.every((item) => item && keys.get(item.type_id) === keys.get(first.type_id))
      ? first.type_id
      : undefined;
  return {
    value_types: projected,
    field_subjects: fieldSubjects,
    ...(returnType === undefined ? {} : { return_source_type: returnType }),
  };
}
