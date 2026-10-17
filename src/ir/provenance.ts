import type { DecodedInstruction } from '../core/index.js';
import type { Origin, Provenance } from './model.js';

export function instructionProvenance(instruction: DecodedInstruction): Provenance {
  return {
    instruction_ids: [instruction.id],
    ranges: [instruction.bytes],
    evidence_ids: [...instruction.evidence_ids],
    synthetic: [],
  };
}
export function syntheticProvenance(reason: string): Provenance {
  if (reason.trim().length === 0) throw new TypeError('Synthetic origin needs a reason');
  return { instruction_ids: [], ranges: [], evidence_ids: [], synthetic: [reason] };
}
/** Ordered union: transformations keep every source, not merely the last contributing instruction. */
export function mergeProvenance(...sources: readonly Provenance[]): Provenance {
  return mergeProvenanceSources(sources);
}
/** Iterable fan-in avoids the engine argument limit on large valid functions. */
export function mergeProvenanceSources(
  sources: Iterable<Provenance>,
  checkpoint?: (work: number) => void,
): Provenance {
  const ranges = new Map<string, Provenance['ranges'][number]>();
  const instructions = new Set<string>(),
    evidence = new Set<string>(),
    synthetic = new Set<string>();
  for (const source of sources) {
    checkpoint?.(
      1 +
        source.instruction_ids.length +
        source.evidence_ids.length +
        source.synthetic.length +
        source.ranges.length,
    );
    for (const id of source.instruction_ids) instructions.add(id);
    for (const id of source.evidence_ids) evidence.add(id);
    for (const reason of source.synthetic) synthetic.add(reason);
    for (const range of source.ranges)
      ranges.set(
        `${range.start.image_id}:${range.start.space}:${range.start.value}:${range.size}`,
        range,
      );
  }
  return {
    instruction_ids: [...instructions],
    ranges: [...ranges.values()],
    evidence_ids: [...evidence],
    synthetic: [...synthetic],
  };
}
/** Replacement identity belongs to the replacement; source identity remains in provenance. */
export function withOrigins<T extends Origin>(replacement: T, ...originals: readonly Origin[]): T {
  return {
    ...replacement,
    provenance: mergeProvenanceSources([
      replacement.provenance,
      ...originals.map((node) => node.provenance),
    ]),
  };
}
