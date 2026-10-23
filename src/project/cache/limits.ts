import {
  mergeOmissions,
  provenanceCoverage,
  shedEmissionMetadata,
  type EmissionMetadataKind,
} from '../../core/index.js';
import type { StoredDecompilation } from './model.js';

const FEATURE = 'source mappings, inference and requirement metadata';

/** Make a stored decompilation state the metadata its emission omitted. Text and every
 * other semantic coverage layer are untouched. A result that was complete becomes
 * partial with reason `budget` when the request's work went to the text render first
 * (an omission with reason `budget`), else `output_limit`; an already partial result
 * keeps its semantic reason. Idempotent: the provenance coverage always reflects the
 * emission's current `omitted`. */
export function withMetadataOmissions(result: StoredDecompilation): StoredDecompilation {
  const emission = result.data.emission;
  const omitted = mergeOmissions(emission.omitted);
  const coverage = result.coverage.filter((item) => item.layer !== 'provenance');
  const capabilities = result.data.capabilities.filter((item) => item.layer !== 'provenance');
  if (omitted.length === 0) return { ...result, coverage, data: { ...result.data, capabilities } };
  const entry = provenanceCoverage(omitted);
  const data = {
    ...result.data,
    capabilities: [
      ...capabilities,
      {
        layer: 'provenance' as const,
        feature: FEATURE,
        status: 'partial' as const,
        limitations: entry.reasons,
      },
    ],
  };
  const withCoverage = { ...result, coverage: [...coverage, entry], data };
  return result.state === 'partial'
    ? withCoverage
    : {
        ...withCoverage,
        state: 'partial',
        reason: omitted.some((item) => item.reason === 'budget') ? 'budget' : 'output_limit',
        continuation: null,
      };
}

/** Shed whole metadata classes of the stored emission (see `shedEmissionMetadata`)
 * and report the omission in the result's coverage. */
export function shedStoredMetadata(
  result: StoredDecompilation,
  kinds: readonly EmissionMetadataKind[],
): StoredDecompilation {
  return withMetadataOmissions({
    ...result,
    data: { ...result.data, emission: shedEmissionMetadata(result.data.emission, kinds) },
  });
}
