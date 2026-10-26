import { createHash } from 'node:crypto';
import {
  OperationError,
  REVIEWED_SOURCE_NOTICE,
  encodeDiagnostic,
  reviewedSourceSchema,
  type Annotation,
  type Artifact,
  type OperationContext,
  type ProjectStore,
} from '../../core/index.js';
import type { ReviewedSourceBase } from '../../project/annotations/index.js';
import { readAnalysisArtifact, type ReviewedSourceLookup } from '../../project/cache/index.js';
import { acceptsAnalysisIdentity } from './versions.js';

type Language = 'c-like' | 'python-like';
type StoredSource = Annotation & { readonly value: { readonly kind: 'source' } };

function textDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
function isSource(annotation: Annotation): annotation is StoredSource {
  return annotation.value.kind === 'source';
}

/** The reviewed source `function_decompile` delivers for a function and emitter: the unique
 * asserted source annotation of that language. Hypotheses and several asserted sources deliver
 * nothing, with an info diagnostic saying why. `stale` compares the text the function now
 * decompiles to with the text the reviewer cleaned. Reads bypass the dependency ledger: reviewed
 * source is presentation, never an analysis input. */
export function reviewedSourceLookup(
  store: ProjectStore,
  revision: number,
  functionId: string,
  language: Language,
  emissionText: string,
): ReviewedSourceLookup {
  const candidates = store
    .readAnnotations(functionId, revision)
    .filter(isSource)
    .filter(
      (annotation) => annotation.value.language === language && annotation.status !== 'retracted',
    );
  const asserted = candidates.filter((annotation) => annotation.status === 'asserted');
  const notice = (message: string): ReviewedSourceLookup => ({
    reviewed_source: null,
    diagnostics: [
      encodeDiagnostic({
        code: 'conflicting_evidence',
        severity: 'info',
        message: `${REVIEWED_SOURCE_NOTICE}${message}`,
        entity_id: functionId,
        evidence_ids: [],
      }),
    ],
  });
  if (asserted.length > 1)
    return notice(
      `${asserted.length} asserted ${language} reviewed sources exist (${asserted.map((item) => item.id).join(', ')}); retract or remove all but one`,
    );
  const chosen = asserted[0];
  if (chosen === undefined)
    return candidates.length === 0
      ? { reviewed_source: null, diagnostics: [] }
      : notice(`the ${language} reviewed source is only a hypothesis; assert it to deliver it`);
  const value = chosen.value;
  if (value.kind !== 'source') throw new TypeError('Unreachable: filtered to source annotations');
  return {
    reviewed_source: reviewedSourceSchema.parse({
      annotation_id: chosen.id,
      language: value.language,
      text: value.text,
      author: chosen.author,
      origin: chosen.origin,
      status: 'asserted',
      revision: chosen.revision,
      base_artifact_id: value.base_artifact_id,
      stale: textDigest(emissionText) !== value.base_text_sha256,
    }),
    diagnostics: [],
  };
}

function reject(code: 'invalid_input' | 'not_found', message: string): never {
  throw new OperationError({ code, severity: 'error', message, evidence_ids: [] });
}

/** Resolves and checks the artifact a reviewed source was cleaned from: a published decompilation
 * of exactly this function at the current revision, for the source's emitter, produced by the
 * current pipeline. Returns its full ID and the digest of its pseudocode text. */
export function reviewedSourceBase(
  store: ProjectStore,
  revision: number,
  context: OperationContext,
): ReviewedSourceBase {
  return (subject, value) => {
    let found: Artifact | undefined;
    let cursor: string | undefined;
    let inspected = 0;
    do {
      context.checkpoint(1);
      const page = store.findAnalysisArtifacts({
        revision,
        ids: [subject.id],
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const candidate of page.items) {
        context.checkpoint(1);
        if (++inspected > 1000)
          reject('invalid_input', 'Function artifact selection exceeds 1000 handles');
        if (!candidate.id.startsWith(value.base_artifact_id)) continue;
        if (found !== undefined)
          reject(
            'invalid_input',
            'base_artifact_id prefix matches several artifacts of this function; give more hex digits',
          );
        found = candidate;
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);
    if (found === undefined)
      reject(
        'not_found',
        'base_artifact_id is not a published decompilation of this function at the current revision; run function_decompile at this revision and use its artifact',
      );
    const payload = readAnalysisArtifact(store, found, context);
    const { identity } = payload;
    if (
      identity.function_id !== subject.id ||
      identity.annotation_revision !== revision ||
      identity.evidence_revision !== revision ||
      !acceptsAnalysisIdentity(identity)
    )
      reject(
        'invalid_input',
        'base_artifact_id does not match this function and the current pipeline',
      );
    const emission = payload.result.data.emission;
    if (emission.language !== value.language)
      reject(
        'invalid_input',
        `base_artifact_id is a ${emission.language} decompilation, not ${value.language}`,
      );
    return { artifact_id: found.id, text_sha256: textDigest(emission.text) };
  };
}
