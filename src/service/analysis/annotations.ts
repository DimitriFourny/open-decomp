import {
  DEFAULT_ANALYSIS_OPTIONS,
  OperationError,
  SCHEMA_VERSION,
  decodeAnnotationEdit,
  encodeAnnotation,
  encodeDiagnostic,
  encodeEvidence,
  toolSchemas,
  type Evidence,
  type ToolArgs,
  type ToolResult,
} from '../../core/index.js';
import { AnnotationService } from '../../project/annotations/index.js';
import { typeReferences } from '../../project/annotations/subjects.js';
import { readAnnotationCatalog } from '../../project/cache/index.js';
import { MAX_FRAME_BYTES } from '../../workers/protocol.js';
import { closeEvidence, evidenceReferences } from './catalog.js';
import type { AnalysisScope } from './index.js';
import { acceptsAnalysisIdentity } from './versions.js';

/** Wire validation and terminal job save are part of the same rollback boundary
 * as the domain mutation. In particular no serialization happens after commit. */
export async function executeAnnotations(
  args: ToolArgs<'annotations_apply'>,
  scope: AnalysisScope,
): Promise<ToolResult<'annotations_apply'>> {
  const { store, context, job_id } = scope;
  if (args.project_id !== store.project_id)
    throw new OperationError({
      code: 'permission_denied',
      severity: 'error',
      message: 'Annotation request belongs to another project',
      evidence_ids: [],
    });
  const job = store.readJob(job_id);
  if (
    !job ||
    job.operation !== 'annotations_apply' ||
    job.input_revision !== args.expected_revision ||
    job.state !== 'running'
  )
    throw new OperationError({
      code: job?.state === 'cancelled' ? 'cancelled' : 'invalid_input',
      severity: 'error',
      message: 'Annotation job is not running at the requested revision',
      evidence_ids: [],
    });
  context.progress('annotations', 0, 1);
  const edits = args.edits.map(decodeAnnotationEdit),
    ids = new Set<string>();
  for (const edit of edits) {
    context.checkpoint(1);
    if (edit.operation !== 'set') continue;
    ids.add(edit.entity_id);
    for (const id of edit.evidence_ids) ids.add(id);
    if (edit.value.kind === 'type') {
      ids.add(edit.value.type_id);
      for (const id of typeReferences(edit.value.definition)) ids.add(id);
    } else if (edit.value.kind === 'signature') {
      ids.add(edit.value.value.return_type);
      for (const parameter of edit.value.value.parameters) ids.add(parameter.type_id);
      for (const id of edit.value.value.evidence_ids) ids.add(id);
    }
  }
  const catalog =
    store.snapshot().revision === args.expected_revision
      ? await readAnnotationCatalog(
          store,
          args.expected_revision,
          [...ids],
          context,
          acceptsAnalysisIdentity,
        )
      : undefined;
  const envelope = {
    schema_version: SCHEMA_VERSION,
    project_id: store.project_id,
    revision: args.expected_revision,
    versions: {
      backend: 'open-decomp/1',
      loader: null,
      decoder: null,
      lifter: null,
      analysis: 'annotations/1',
      abi: null,
      emitter: null,
    },
    options: DEFAULT_ANALYSIS_OPTIONS,
    budget: args.budget,
    coverage: [],
    diagnostics: [],
    evidence: [],
    artifacts: [],
  };
  const validate = (result: ToolResult<'annotations_apply'>): ToolResult<'annotations_apply'> => {
    const parsed = toolSchemas.annotations_apply.output.parse(result);
    if (
      Buffer.byteLength(JSON.stringify(parsed)) >
      Math.min(
        args.budget.output_bytes,
        scope.max_result_bytes ?? Infinity,
        MAX_FRAME_BYTES - 16384,
      )
    )
      throw new OperationError({
        code: 'resource_limit',
        severity: 'error',
        message:
          'Annotation response exceeds the operation or transport delivery limit; no edits were committed',
        evidence_ids: [],
      });
    return parsed;
  };
  let committed: ToolResult<'annotations_apply'> | undefined;
  const mutation = new AnnotationService(store).apply(
    { expected_revision: args.expected_revision, author: args.author, origin: args.origin, edits },
    context,
    catalog,
    (_transaction, result, preparedEvidence: readonly Evidence[]) => {
      context.checkpoint(0);
      const currentJob = store.readJob(job_id);
      if (currentJob?.state !== 'running')
        throw new OperationError({
          code: currentJob?.state === 'cancelled' ? 'cancelled' : 'invalid_input',
          severity: 'error',
          message: 'Annotation job stopped before commit',
          evidence_ids: [],
        });
      const proofIds = evidenceReferences(result.annotations, context);
      // New evidence is available from the domain's prepared transaction, not from
      // a fabricated assertion or an uncommitted future-snapshot store read.
      const evidence = closeEvidence(
        store,
        result.revision,
        proofIds,
        preparedEvidence,
        context,
        args.expected_revision,
      );
      committed = validate({
        ...envelope,
        revision: result.revision,
        evidence: evidence.map(encodeEvidence),
        state: 'complete',
        data: {
          previous_revision: result.previous_revision,
          revision: result.revision,
          applied: result.annotations.map(encodeAnnotation),
          removed: [...result.removed],
          invalidation: {
            scope: 'project',
            derived_before_revision: result.invalidate_before_revision,
          },
        },
      });
      context.checkpoint(0);
      store.saveJob({
        ...currentJob,
        state: 'completed',
        progress: { phase: 'complete', completed: 1, total: 1 },
        artifacts: [],
        diagnostics: [],
        published_revision: null,
      });
    },
  );
  if (mutation.state === 'committed') {
    if (!committed)
      throw new OperationError({
        code: 'internal_error',
        severity: 'error',
        message: 'Annotation transaction omitted its validated response',
        evidence_ids: [],
      });
    return committed;
  }
  const diagnostic =
    mutation.state === 'conflict'
      ? {
          code: 'stale_revision' as const,
          severity: 'error' as const,
          message: 'Annotation revision precondition failed; no edits were committed',
          evidence_ids: [],
        }
      : (mutation.diagnostics[0] ?? {
          code: 'invalid_input' as const,
          severity: 'error' as const,
          message: 'Annotation batch was rejected',
          evidence_ids: [],
        });
  const result = validate(
    diagnostic.code === 'cancelled'
      ? { ...envelope, state: 'cancelled', job_id }
      : {
          ...envelope,
          state: 'failed',
          error: encodeDiagnostic(diagnostic),
          diagnostics: (mutation.state === 'rejected' ? mutation.diagnostics : [diagnostic]).map(
            encodeDiagnostic,
          ),
          current_revision: store.snapshot().revision,
        },
  );
  const currentJob = store.readJob(job_id);
  if (currentJob?.state === 'running')
    store.saveJob({
      ...currentJob,
      state:
        diagnostic.code === 'cancelled'
          ? 'cancelled'
          : mutation.state === 'conflict'
            ? 'stale'
            : 'failed',
      diagnostics: [diagnostic],
      published_revision: null,
    });
  return result;
}
