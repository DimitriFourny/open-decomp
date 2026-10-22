import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fingerprint, functionDecompileResultSchema } from '../../core/index.js';
import type { ToolResult } from '../../core/index.js';
import {
  ANALYSIS_ARTIFACT_MEDIA_TYPE,
  ANALYSIS_ARTIFACT_VERSION,
  MAX_ANALYSIS_ARTIFACT_BYTES,
} from '../../project/cache/model.js';
import { queryFailure } from './shared.js';
import type { QueryService } from './index.js';

function invalid(message: string): never {
  return queryFailure('invalid_input', message);
}

/** Replace an artifact-delivered decompilation by the inline result stored in that artifact.
 * Every page, the digest and the request identity (project, revision, function, versions,
 * options, budget) are verified; an inline result is returned unchanged. */
export async function materializeDecompilation(
  service: Pick<QueryService, 'readArtifact'>,
  scope: { readonly project_id: string; readonly revision: number },
  result: ToolResult<'function_decompile'>,
  signal?: AbortSignal,
): Promise<ToolResult<'function_decompile'>> {
  if (!('data' in result) || result.data.delivery !== 'artifact') return result;
  const artifactId = result.data.artifact_id;
  const artifact = result.artifacts.find((item) => item.id === artifactId);
  if (
    !artifact ||
    artifact.media_type !== ANALYSIS_ARTIFACT_MEDIA_TYPE ||
    BigInt(artifact.size) > BigInt(MAX_ANALYSIS_ARTIFACT_BYTES)
  ) {
    invalid('Invalid decompilation artifact handle.');
  }
  const size = Number(BigInt(artifact.size)),
    bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    signal?.throwIfAborted();
    const page = await service.readArtifact({
      project_id: scope.project_id,
      revision: scope.revision,
      artifact_id: artifact.id,
      offset: `0x${offset.toString(16)}`,
      length: Math.min(524_288, size - offset),
    });
    const chunk = Buffer.from(page.bytes_hex, 'hex');
    if (
      fingerprint(page.artifact) !== fingerprint(artifact) ||
      BigInt(page.offset) !== BigInt(offset) ||
      chunk.length === 0 ||
      chunk.length > Math.min(524_288, size - offset)
    )
      invalid('Inconsistent decompilation artifact page.');
    chunk.copy(bytes, offset);
    offset += chunk.length;
    if (page.next_offset !== (offset === size ? null : `0x${offset.toString(16)}`))
      invalid('Inconsistent decompilation artifact continuation.');
  }
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
    invalid('Decompilation artifact checksum mismatch.');
  signal?.throwIfAborted();
  const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const stored = z
    .object({
      format_version: z.literal(ANALYSIS_ARTIFACT_VERSION),
      result: functionDecompileResultSchema,
    })
    .parse(payload).result;
  if (
    !('data' in stored) ||
    stored.data.delivery !== 'inline' ||
    (stored.state !== 'complete' && stored.state !== 'partial') ||
    (stored.state === 'partial' &&
      stored.reason === 'output_limit' &&
      !stored.data.emission.omitted?.length) ||
    stored.project_id !== scope.project_id ||
    stored.revision !== scope.revision ||
    stored.data.function_id !== result.data.function_id ||
    fingerprint(stored.versions) !== fingerprint(result.versions) ||
    fingerprint(stored.options) !== fingerprint(result.options) ||
    fingerprint(stored.budget) !== fingerprint(result.budget)
  )
    invalid('Decompilation artifact does not match its request.');
  return functionDecompileResultSchema.parse({
    ...stored,
    artifacts: result.artifacts,
    data: {
      ...stored.data,
      cache: result.data.cache,
      ...(result.data.work === undefined ? {} : { work: result.data.work }),
    },
  });
}
