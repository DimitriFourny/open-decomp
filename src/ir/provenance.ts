import type { DecodedInstruction } from '../core/index.js';
import type { Origin, Provenance } from './model.js';

export function instructionProvenance(instruction: DecodedInstruction): Provenance {
  return { instruction_ids: [instruction.id], ranges: [instruction.bytes], evidence_ids: [...instruction.evidence_ids], synthetic: [] };
}
export function syntheticProvenance(reason: string): Provenance {
  if (reason.trim().length === 0) throw new TypeError('Synthetic origin needs a reason');
  return { instruction_ids: [], ranges: [], evidence_ids: [], synthetic: [reason] };
}
/** Ordered union: transformations keep every source, not merely the last contributing instruction. */
export function mergeProvenance(...sources: readonly Provenance[]): Provenance {
  const ranges = new Map<string, Provenance['ranges'][number]>();
  for (const source of sources) for (const range of source.ranges) {
    ranges.set(`${range.start.image_id}:${range.start.space}:${range.start.value}:${range.size}`, range);
  }
  return {
    instruction_ids: [...new Set(sources.flatMap(source => source.instruction_ids))],
    ranges: [...ranges.values()],
    evidence_ids: [...new Set(sources.flatMap(source => source.evidence_ids))],
    synthetic: [...new Set(sources.flatMap(source => source.synthetic))],
  };
}
/** Replacement identity belongs to the replacement; source identity remains in provenance. */
export function withOrigins<T extends Origin>(replacement: T, ...originals: readonly Origin[]): T {
  return { ...replacement, provenance: mergeProvenance(replacement.provenance, ...originals.map(node => node.provenance)) };
}
