import type { AbiProfile, Annotation, OperationContext } from '../../core/index.js';
import { AnalysisBudget } from '../../analysis/ssa/budget.js';
import {
  imageAnchorKey,
  type ImageTypeClass,
  type ImageTypeField,
} from '../../analysis/types/image-types.js';
import type { SuppliedTypeRecord } from '../../analysis/types/index.js';
import { SourceLayouts } from '../../analysis/types/layout.js';
import { AnnotationService } from '../../project/annotations/index.js';
import { typeReferences } from '../../project/annotations/subjects.js';
import type { AnalysisScope } from './index.js';
import { parameterRegisters } from './native-abi.js';

/** One asserted signature role that declares a class's type. */
export interface ImageTypeBindingSource {
  readonly function_id: string;
  /** Source parameter index, or null for the result. */
  readonly parameter: number | null;
  readonly annotation: Annotation;
}

/** A recovered image-wide class bound to a user-declared named structure. */
export interface ImageTypeUserBinding {
  /** The named structure and the pointer type to it the signature declares. */
  readonly type_id: string;
  readonly pointer_id: string;
  /** Its C spelling: `struct <name>`, or `union <name>` when every member is at offset 0. */
  readonly spelling: string;
  /** Every asserted signature role of the class naming this type, by function then role. */
  readonly sources: readonly ImageTypeBindingSource[];
  /** Observed members of the class that are no member (nor element of a member) of
   * the declaration at the same offset and width: the declaration is applied anyway. */
  readonly outside: readonly ImageTypeField[];
}

export interface ImageTypeBindings {
  /** Class ID to its binding. */
  readonly bound: ReadonlyMap<string, ImageTypeUserBinding>;
  /** Classes whose roles declare different named structures: left unbound. Each
   * entry is one declared type with the roles naming it. */
  readonly conflicts: ReadonlyMap<
    string,
    readonly { readonly spelling: string; readonly sources: readonly ImageTypeBindingSource[] }[]
  >;
  /** Declaration records of the bound types and every type they reference. */
  readonly records: readonly SuppliedTypeRecord[];
}

const NO_IMAGE_TYPE_BINDINGS: ImageTypeBindings = {
  bound: new Map(),
  conflicts: new Map(),
  records: [],
};

/** User bindings of image-wide classes. The stable key is a class's anchors: an
 * asserted signature (the unique one, of this ABI) of a function owning an anchor
 * that declares the anchored role a pointer to a named structure binds the class to
 * that structure. A parameter's anchor is its integer argument register ordinal under
 * the ABI's placement of the declared parameter list (floating/vector parameters take
 * no integer register; a stack-passed parameter has no anchor); the result's is the
 * function's pointer result register. Only functions owning anchors are read
 * (`readAnnotations`, through the scope's dependency ledger) and the declared types
 * resolve through `AnnotationService.active` with their precedence, so the reads a
 * decompilation depends on are those functions' annotations and the declarations of
 * the types they use. */
export function imageTypeBindings(
  scope: AnalysisScope,
  revision: number,
  abi: AbiProfile,
  classes: readonly ImageTypeClass[],
  context: OperationContext,
): ImageTypeBindings {
  // Anchor keys are `argument:<function>:<ordinal>` or `return:<function>`.
  const owners = new Set<string>();
  for (const item of classes)
    for (const key of item.anchors) {
      context.checkpoint(1);
      owners.add(key.split(':')[1]!);
    }
  const signatures = new Map<string, Annotation & { value: { kind: 'signature' } }>();
  for (const function_id of [...owners].sort()) {
    const asserted = scope.store
      .readAnnotations(function_id, revision)
      .filter(
        (annotation): annotation is Annotation & { value: { kind: 'signature' } } =>
          annotation.status === 'asserted' &&
          annotation.value.kind === 'signature' &&
          annotation.value.value.abi === abi.id,
      );
    context.checkpoint(1 + asserted.length);
    // Competing assertions declare no role (as for the function's own contract).
    if (asserted.length === 1) signatures.set(function_id, asserted[0]!);
  }
  if (!signatures.size) return NO_IMAGE_TYPE_BINDINGS;
  const service = new AnnotationService(scope.store),
    dependencies = scope.dependencies;
  const query = () =>
    service.active(revision, context, {
      entity_ids: [...signatures.keys()],
      ...(dependencies ? { on_dependencies: dependencies.recordAnnotationScope } : {}),
    });
  const view = dependencies ? dependencies.annotationView(query) : query();
  const records = new Map<string, SuppliedTypeRecord[]>();
  for (const record of view.types) {
    context.checkpoint(1);
    (records.get(record.id) ?? records.set(record.id, []).get(record.id)!).push(record);
  }
  const layouts = new SourceLayouts(
    records,
    new AnalysisBudget({
      max_work: context.remainingWork?.() ?? context.budget.work,
      checkpoint: (work) => context.checkpoint(work),
    }),
    abi.layout,
  );
  /** The named structure an established/asserted pointer type points to. */
  const named = (pointer_id: string): { type_id: string; spelling: string } | undefined => {
    const pointer = layouts.definition(pointer_id, true);
    const target = pointer?.kind === 'pointer' ? layouts.definition(pointer.to, true) : null;
    if (pointer?.kind !== 'pointer' || target?.kind !== 'structure') return undefined;
    const spellings = new Set(
      (records.get(pointer.to) ?? []).flatMap((record) =>
        (record.status === 'asserted' || record.status === 'established') && record.spelling
          ? [record.spelling]
          : [],
      ),
    );
    if (spellings.size !== 1) return undefined;
    const union = target.fields.length > 1 && target.fields.every((field) => field.offset === 0n);
    return {
      type_id: pointer.to,
      spelling: `${union ? 'union' : 'struct'} ${spellings.values().next().value!}`,
    };
  };
  const integers = parameterRegisters(abi).filter((register) => register.bank === 'integer');
  const declared = new Map<
    string,
    { type_id: string; pointer_id: string; spelling: string; source: ImageTypeBindingSource }[]
  >();
  const declare = (key: string, pointer_id: string, source: ImageTypeBindingSource): void => {
    const target = named(pointer_id);
    if (target)
      (declared.get(key) ?? declared.set(key, []).get(key)!).push({
        ...target,
        pointer_id,
        source,
      });
  };
  for (const [function_id, annotation] of signatures) {
    const signature = annotation.value.value;
    const layout = abi.classifyCall({
      returns: layouts.abi(signature.return_type),
      parameters: signature.parameters.map((parameter) => layouts.abi(parameter.type_id)),
      variadic: signature.variadic,
      fixed_parameter_count: signature.parameters.length,
      argument_list_complete: !signature.variadic,
    });
    context.checkpoint(1 + layout.parameters.length);
    if (layout.state === 'unsupported') continue;
    for (const { index, locations } of layout.parameters) {
      const location = locations.length === 1 ? locations[0]! : undefined;
      const parameter = signature.parameters[index];
      if (
        !parameter ||
        location?.kind !== 'register' ||
        location.value_offset_bits !== 0 ||
        location.width_bits !== 64
      )
        continue;
      const ordinal = integers.findIndex((register) => register.root === location.register.root);
      if (ordinal >= 0)
        declare(
          imageAnchorKey({ kind: 'argument', function_id, index: ordinal }),
          parameter.type_id,
          { function_id, parameter: index, annotation },
        );
    }
    const result = layout.returns.length === 1 ? layout.returns[0]! : undefined;
    if (
      !layout.hidden_result &&
      result?.kind === 'register' &&
      result.value_offset_bits === 0 &&
      result.width_bits === 64
    )
      declare(imageAnchorKey({ kind: 'return', function_id }), signature.return_type, {
        function_id,
        parameter: null,
        annotation,
      });
  }
  const bound = new Map<string, ImageTypeUserBinding>();
  const conflicts = new Map<
    string,
    { readonly spelling: string; readonly sources: readonly ImageTypeBindingSource[] }[]
  >();
  const used = new Set<string>();
  for (const item of classes) {
    const byType = new Map<
      string,
      {
        type_id: string;
        pointer_id: string;
        spelling: string;
        sources: ImageTypeBindingSource[];
      }
    >();
    for (const key of item.anchors)
      for (const candidate of declared.get(key) ?? []) {
        context.checkpoint(1);
        const entry =
          byType.get(candidate.type_id) ??
          byType
            .set(candidate.type_id, {
              type_id: candidate.type_id,
              pointer_id: candidate.pointer_id,
              spelling: candidate.spelling,
              sources: [],
            })
            .get(candidate.type_id)!;
        entry.sources.push(candidate.source);
      }
    if (!byType.size) continue;
    const order = (a: ImageTypeBindingSource, b: ImageTypeBindingSource): number =>
      a.function_id.localeCompare(b.function_id) || (a.parameter ?? -1) - (b.parameter ?? -1);
    if (byType.size > 1) {
      conflicts.set(
        item.id,
        [...byType.values()]
          .map((entry) => ({ spelling: entry.spelling, sources: entry.sources.sort(order) }))
          .sort((a, b) => a.spelling.localeCompare(b.spelling)),
      );
      continue;
    }
    const entry = byType.values().next().value!;
    const outside = item.fields.filter((field) => {
      context.checkpoint(1);
      return !layouts.fields(entry.type_id, field.offset, field.width_bits).length;
    });
    bound.set(item.id, { ...entry, sources: entry.sources.sort(order), outside });
    used.add(entry.pointer_id);
  }
  // The bound declarations and everything they reference, as resolved above.
  const pending = [...used],
    reached = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const record of records.get(id) ?? []) {
      context.checkpoint(1);
      pending.push(...typeReferences(record.definition));
    }
  }
  return {
    bound,
    conflicts,
    records: view.types.filter((record) => reached.has(record.id)),
  };
}
