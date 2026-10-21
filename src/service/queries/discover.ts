import { OperationError } from '../../core/index.js';
import type { OperationContext, ProjectStore, ToolArgs, ToolResult } from '../../core/index.js';
import { prepareDiscoveryStep } from './prepare.js';
import { loadImage, records } from './scope.js';
import { queryEnvelope } from './shared.js';

/** One step of a budget-limited whole-image function discovery at the current revision: it
 * continues the persisted frontier under this request's budget and commits the next revision
 * only when it progresses. A complete enumeration, a project without a frontier, or a step that
 * cannot finish any root within the instruction limit commits nothing. */
export function executeDiscoveryStep(
  args: ToolArgs<'functions_discover'>,
  scope: { readonly store: ProjectStore; readonly context: OperationContext },
): ToolResult<'functions_discover'> {
  const { store, context } = scope;
  const revision = args.revision;
  const image = loadImage(store, revision, args.image_id);
  const functions = records(scope, revision, image.id, 'function');
  const frontier = store.readDiscoveryFrontier(image.id, revision);
  const unchanged = (index_state: 'complete' | 'partial'): ToolResult<'functions_discover'> => ({
    ...queryEnvelope(args.project_id, revision, args.budget),
    state: 'complete',
    data: { previous_revision: revision, revision, published: 0, index_state, progressed: false },
  });
  if (!frontier) return unchanged(functions.state === 'complete' ? 'complete' : 'partial');
  // The import's decorated names (runtime methods, display names, import slots) are published
  // records; the stored image keeps only the loader's.
  const decorated = {
    ...image,
    symbols: records(scope, revision, image.id, 'symbol').items,
    imports: records(scope, revision, image.id, 'import').items,
    exports: records(scope, revision, image.id, 'export').items,
  };
  const step = prepareDiscoveryStep(
    decorated,
    {
      revision: revision + 1,
      functions: functions.items,
      frontier,
      reference_state: records(scope, revision, image.id, 'reference').state,
    },
    context,
  );
  if (!step.progressed) return unchanged('partial');
  const mutation = store.transaction(revision, (tx) => step.publish(tx));
  if (mutation.state === 'conflict')
    throw new OperationError({
      code: 'stale_revision',
      severity: 'error',
      message: 'Discovery step revision changed before publication',
      evidence_ids: [],
    });
  if (mutation.state === 'rejected')
    throw new OperationError(
      mutation.diagnostics[0] ?? {
        code: 'internal_error',
        severity: 'error',
        message: 'Discovery step publication was rejected without a diagnostic',
        evidence_ids: [],
      },
    );
  return {
    ...queryEnvelope(args.project_id, revision + 1, args.budget),
    state: 'complete',
    data: {
      previous_revision: revision,
      revision: revision + 1,
      published: step.published,
      index_state: step.enumeration,
      progressed: true,
    },
  };
}
