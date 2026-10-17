import assert from 'node:assert/strict';
import { emissionSchema, expandEmission } from '../../src/core/index.js';

interface ProofNode {
  readonly id: string;
  readonly derived_from: readonly string[];
  readonly conflicts_with: readonly string[];
}
/** Any analysis result envelope: `evidence`/`diagnostics` plus an optional inline emission. */
export interface EvidenceClosable {
  readonly evidence: readonly ProofNode[];
  readonly diagnostics: readonly { readonly evidence_ids: readonly string[] }[];
  readonly data?: unknown;
}

/**
 * Every proof ID cited by the result (diagnostics, the emission's evidence table, mappings,
 * inferences, requirements and their sites) is published in `result.evidence`, and every
 * published proof's `derived_from` / `conflicts_with` parents are published too.
 */
export function assertEvidenceClosed(result: EvidenceClosable): void {
  const published = new Set(result.evidence.map((proof) => proof.id));
  assert.equal(published.size, result.evidence.length, 'published proofs are duplicate-free');
  const cited = (owner: string, ids: readonly string[]): void => {
    for (const id of ids) assert.ok(published.has(id), `${owner} cites unpublished proof ${id}`);
  };
  for (const proof of result.evidence)
    cited(`proof ${proof.id} dependencies`, [...proof.derived_from, ...proof.conflicts_with]);
  result.diagnostics.forEach((diagnostic, index) =>
    cited(`diagnostic ${index}`, diagnostic.evidence_ids),
  );
  const data = result.data;
  if (typeof data !== 'object' || data === null || !('emission' in data)) return;
  const emission = emissionSchema.parse(data.emission);
  cited('emission evidence table', emission.evidence);
  const expanded = expandEmission(emission);
  expanded.mappings.forEach((mapping, index) => cited(`mapping ${index}`, mapping.evidence_ids));
  expanded.inferences?.forEach((record, index) => cited(`inference ${index}`, record.evidence_ids));
  expanded.requirements?.forEach((record, index) => {
    cited(`requirement ${index}`, record.evidence_ids);
    record.sites.forEach((site, siteIndex) =>
      cited(`requirement ${index} site ${siteIndex}`, site.evidence_ids),
    );
  });
}
