import type {
  FunctionGraph,
  FunctionRecord,
  LoadedImage,
  OperationContext,
} from '../../core/index.js';
import { Arm64Decoder } from '../../decoders/arm64/index.js';
import { X86Decoder } from '../../decoders/x86_64/index.js';
import { discoverFunctions } from '../../analysis/discovery/index.js';
import { buildCFG } from '../../analysis/cfg/index.js';
import { queryFailure } from './shared.js';

const cache = new Map<string, readonly FunctionGraph[]>();
/** Reconstruct from the exact durable loader/runtime seed records, retaining discovery's
 * data, truncated, unresolved and unsupported boundaries. Never decode a claimed envelope.
 * Only instructions inside published observed function ranges are exposed: a more generous
 * query budget cannot silently extend a historically partial discovery index. The cache is
 * revision/traversal-bound, at most two artifacts of 1024 graph-owned units and
 * 1 Mi UTF-16 units of function labels/diagnostics each. Decoder payloads are bounded. */
export function reconstructFunctionGraph(
  input: {
    readonly project_id: string;
    readonly revision: number;
    readonly image: LoadedImage;
    readonly function: FunctionRecord;
    readonly functions: readonly FunctionRecord[];
  },
  context: OperationContext,
): FunctionGraph {
  const { image, revision } = input,
    fn = input.function;
  const key = `${input.project_id}:${revision}:${image.selected_slice_id}:${context.budget.instructions}:${context.budget.blocks}`;
  let graphs = cache.get(key);
  if (!graphs) {
    const decoder =
      image.target.architecture === 'arm64'
        ? new Arm64Decoder()
        : new X86Decoder({ formatting: false });
    try {
      graphs = discoverFunctions({ image, decoder, revision }, context).graphs;
    } finally {
      decoder.dispose();
    }
    const count = graphs.reduce(
      (sum, graph) => sum + graph.instructions.length + graph.gaps.length + graph.blocks.length,
      0,
    );
    const characters = graphs.reduce(
      (sum, graph) =>
        sum +
        (graph.function.original_name?.length ?? 0) +
        (graph.function.display_name?.length ?? 0) +
        graph.diagnostics.reduce((total, item) => total + item.message.length, 0),
      0,
    );
    if (count <= 1024 && characters <= 1_048_576) {
      if (cache.size >= 2) cache.delete(cache.keys().next().value!);
      cache.set(key, graphs);
    }
  }
  const source = graphs.find((graph) => graph.function.id === fn.id);
  if (!source)
    return {
      function: fn,
      slice_id: image.selected_slice_id,
      instructions: [],
      blocks: [],
      gaps: fn.ranges
        .filter((range) => range.size > 0n)
        .map((range) => ({ range, reason: 'budget', diagnostics: [] })),
      diagnostics: [],
      coverage: {
        layer: 'decode',
        state: 'partial',
        completed_units: 0,
        reasons: ['Query traversal budget did not reach this published function'],
      },
    };
  const ranges = [...fn.ranges].sort((a, b) =>
    a.start.value < b.start.value ? -1 : a.start.value > b.start.value ? 1 : 0,
  );
  const instructions = [];
  let index = 0;
  for (const instruction of source.instructions) {
    context.checkpoint(1);
    while (
      index < ranges.length &&
      ranges[index]!.start.value + ranges[index]!.size <= instruction.address.value
    ) {
      context.checkpoint(1);
      index++;
    }
    const range = ranges[index];
    if (
      range &&
      instruction.address.value >= range.start.value &&
      instruction.address.value + BigInt(instruction.size) <= range.start.value + range.size
    )
      instructions.push(instruction);
  }
  const end = ranges.reduce(
    (maximum, range) =>
      range.start.value + range.size > maximum ? range.start.value + range.size : maximum,
    fn.entry.value,
  );
  const gaps = source.gaps.filter((gap) => gap.range.start.value <= end);
  const blocks =
    instructions.length === source.instructions.length
      ? source.blocks
      : buildCFG(
          {
            slice_id: image.selected_slice_id,
            function_id: fn.id,
            entry: fn.entry,
            instructions,
            function_entries: new Set(input.functions.map((item) => item.entry.value)),
            evidence: new Map(
              source.blocks.map((block) => [
                block.instructions.at(-1)!,
                block.edges[0]?.evidence_ids ?? [],
              ]),
            ),
          },
          context,
        );
  if (blocks.length > context.budget.blocks)
    queryFailure('resource_limit', 'CFG exceeds the block budget');
  const partial =
    source.coverage.state !== 'complete' ||
    fn.analysis !== 'complete' ||
    instructions.length !== source.instructions.length;
  return {
    ...source,
    function: fn,
    instructions,
    blocks,
    gaps,
    coverage: {
      ...source.coverage,
      state: partial ? 'partial' : 'complete',
      completed_units: instructions.length,
      reasons: [
        ...source.coverage.reasons,
        ...(fn.analysis !== 'complete' ? ['Published discovery is partial'] : []),
        ...(instructions.length !== source.instructions.length
          ? ['Unpublished reachable instructions were not exposed']
          : []),
      ],
    },
  };
}
