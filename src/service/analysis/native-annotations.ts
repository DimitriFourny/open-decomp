import type { OperationContext } from '../../core/index.js';
import type { SSAForm } from '../../ir/index.js';
import type { TypeRecoveryResult } from '../../analysis/types/index.js';
import { AnnotationService, createTrustedSemanticCatalog } from '../../project/annotations/index.js';
import { semanticCatalog } from './catalog.js';
import { callDeclarations, type CallScope } from './calls.js';
import type { NativePreparationInput } from './native-prepare.js';

/** Same active/hypothesis/conflict/retraction rules as selected-body recovery.
 * The dependency collector sees both queried subjects and absent annotations. */
export function nativeAnnotations(input: NativePreparationInput, ir: SSAForm, baseline: TypeRecoveryResult,
  calls: CallScope, context: OperationContext) {
  const catalog = semanticCatalog(input.image, ir, baseline, context);
  const trusted = createTrustedSemanticCatalog(input.scope.store, input.revision, catalog, context);
  const selected = new Set([...catalog.subjects.map((subject) => subject.id), ...calls.subjects]);
  const service = new AnnotationService(input.scope.store), dependencies = input.scope.dependencies;
  const query = () => service.active(input.revision, context, { catalog: trusted, entity_ids: [...selected],
    ...(dependencies ? { on_dependencies: dependencies.recordAnnotationScope } : {}) });
  let active = dependencies ? dependencies.annotationView(query) : query();
  let expanded = false;
  for (const type of active.types) {
    context.checkpoint(1);
    if (!selected.has(type.id)) { selected.add(type.id); expanded = true; }
    if (type.definition.kind === 'structure')
      for (const field of type.definition.fields)
        if (!selected.has(field.id)) { selected.add(field.id); expanded = true; }
  }
  if (expanded) active = dependencies ? dependencies.annotationView(query) : query();
  const types = [...input.native_types, ...active.types];
  const declarations = callDeclarations(ir, input.image, input.revision, calls, input.debug,
    active.annotations, types, context, input.components.abi.layout);
  const external = new Set(calls.subjects.filter((id) => id !== ir.id));
  return { types, declarations, annotations: active.annotations.filter((annotation) =>
    selected.has(annotation.entity_id) && !external.has(annotation.entity_id)) };
}
