import { buildOnce, fingerprint, useBuilt } from '../../core/index.js';
import type {
  FunctionGraph,
  FunctionRecord,
  LoadedImage,
  OperationContext,
} from '../../core/index.js';
import { Arm64Decoder } from '../../decoders/arm64/index.js';
import { X86Decoder } from '../../decoders/x86_64/index.js';
import { discoverFunctions, prepareDiscoveryIndex } from '../../analysis/discovery/index.js';
import type { DiscoveryIndex } from '../../analysis/discovery/index.js';
import { libraryNoreturnCalls } from '../../metadata/library-contracts/index.js';
import { targetAbi } from '../analysis/versions.js';
import { queryFailure } from './shared.js';

const indexes = new WeakMap<
  LoadedImage,
  {
    readonly revision: number;
    readonly functions: readonly FunctionRecord[];
    readonly index: DiscoveryIndex;
    readonly noreturn_calls: ReadonlyMap<bigint, readonly string[]>;
  }
>();
export interface QueryFunctionGraph extends FunctionGraph {
  readonly presentations?: ReadonlyMap<
    string,
    { readonly mnemonic: string; readonly operands: string }
  >;
}
const cache = new Map<
  string,
  {
    readonly graph: QueryFunctionGraph;
    readonly units: number;
    readonly characters: number;
    /** Work reconstructing it charged: a reuse charges the same. */
    readonly work: number;
  }
>();
let cachedUnits = 0;
let cachedCharacters = 0;

/** Selected-local analysis is grounded in immutable native/published roots and
 * executable/data indexes, not an image-wide traversal or a claimed envelope.
 * Its observed ranges are returned explicitly, with local proofs; historical
 * FunctionRecords are never mutated. Normal decompilation artifacts publish the
 * refinement at their exact evidence revision. Graphs retain bounded cache
 * identity by project/revision/slice/function and instruction/block ceilings. */
export function reconstructFunctionGraph(
  input: {
    readonly project_id: string;
    readonly revision: number;
    readonly image: LoadedImage;
    readonly function: FunctionRecord;
    readonly functions: readonly FunctionRecord[];
    readonly formatting?: boolean;
  },
  context: OperationContext,
): QueryFunctionGraph {
  context.checkpoint(0);
  const { image, revision } = input,
    fn = input.function;
  const key = `${input.project_id}:${revision}:${image.selected_slice_id}:${fn.id}:${context.budget.instructions}:${context.budget.blocks}:${input.formatting ? 'formatted' : 'structured'}`;
  // The discovery index is per image: every operation pays its recorded build cost once,
  // before and apart from the graph's own work, whether or not the graph is cached.
  let prepared = indexes.get(image);
  if (prepared && prepared.revision === revision && prepared.functions === input.functions)
    useBuilt(context, prepared);
  else {
    prepared = buildOnce(context, (quiet) => ({
      revision,
      functions: input.functions,
      index: prepareDiscoveryIndex({ image, revision, functions: input.functions }, quiet),
      noreturn_calls: libraryNoreturnCalls(image, quiet),
    }));
    indexes.set(image, prepared);
  }
  const cached = cache.get(key);
  if (cached) {
    context.checkpoint(cached.work);
    // Refresh the bounded graph LRU without retaining its image bytes.
    cache.delete(key);
    cache.set(key, cached);
    return cached.graph;
  }
  let work = 0;
  const measured: OperationContext = {
    ...context,
    checkpoint(amount) {
      context.checkpoint(amount);
      work += amount;
    },
  };
  const decoder =
    image.target.architecture === 'arm64'
      ? new Arm64Decoder()
      : new X86Decoder({ formatting: input.formatting === true });
  let discovery;
  const presentations = input.formatting
    ? new Map<string, { mnemonic: string; operands: string }>()
    : undefined;
  let presentationCharacters = 0;
  try {
    discovery = discoverFunctions(
      {
        image,
        decoder,
        revision,
        index: prepared.index,
        selected_entry: fn.entry,
        noreturn_calls: prepared.noreturn_calls,
        preserved_registers: targetAbi(image.target)?.preserved ?? [],
      },
      measured,
    );
    if (presentations) {
      for (const instruction of discovery.graphs[0]?.instructions ?? []) {
        measured.checkpoint(1);
        if (instruction.payload === null) continue;
        const presentation = decoder.format(instruction);
        presentationCharacters += presentation.mnemonic.length + presentation.operands.length;
        measured.checkpoint(presentation.mnemonic.length + presentation.operands.length);
        presentations.set(instruction.id, presentation);
      }
    }
  } finally {
    decoder.dispose();
  }
  const source = discovery.graphs[0];
  if (!source) queryFailure('not_found', 'Selected root produced no function graph');
  const refined =
    fn.analysis !== 'complete' ||
    fn.ranges.length !== source.function.ranges.length ||
    fn.ranges.some((range, index) => {
      const observed = source.function.ranges[index];
      return (
        !observed || range.start.value !== observed.start.value || range.size !== observed.size
      );
    });
  const proof = {
    id: `evidence_${fingerprint([
      image.selected_slice_id,
      'selected-local-graph/1',
      revision,
      fn.id,
      source.instructions.map((instruction) => instruction.id),
      source.gaps.map((gap) => [gap.range.start.value, gap.range.size, gap.reason]),
    ])}`,
    origin: {
      kind: 'analysis' as const,
      analyzer: 'open-decomp/discovery',
      version: '2',
      rule: 'selected-local graph reconstruction',
    },
    claim: `Selected-local traversal observed ${source.instructions.length} instructions at 0x${fn.entry.value.toString(16)}; historical image-wide function metadata is unchanged`,
    derived_from: [...new Set([...fn.evidence_ids, ...source.function.evidence_ids])].sort(),
    conflicts_with: [],
    revision,
  };
  const graph: QueryFunctionGraph = {
    ...source,
    ...(presentations ? { presentations } : {}),
    function: {
      ...source.function,
      id: fn.id,
      original_name: fn.original_name,
      display_name: fn.display_name,
      signature: fn.signature,
      evidence_ids: [
        ...new Set([...fn.evidence_ids, ...source.function.evidence_ids, proof.id]),
      ].sort(),
    },
    evidence: [...discovery.evidence, proof],
    diagnostics: [
      ...source.diagnostics,
      ...(refined
        ? [
            {
              code: 'unavailable_semantics' as const,
              severity: 'info' as const,
              message: `Selected-local graph refinement observed ${source.instructions.length} instructions; historical image-wide discovery remains ${fn.analysis} and its published ranges are unchanged`,
              entity_id: fn.id,
              evidence_ids: [proof.id],
            },
          ]
        : []),
    ],
  };
  const units =
    graph.instructions.length +
    graph.gaps.length +
    graph.blocks.length +
    graph.evidence!.length +
    (presentations?.size ?? 0);
  const characters =
    (fn.original_name?.length ?? 0) +
    (fn.display_name?.length ?? 0) +
    graph.diagnostics.reduce((n, item) => n + item.message.length, 0) +
    graph.evidence!.reduce(
      (n, item) => n + item.claim.length + item.derived_from.reduce((m, id) => m + id.length, 0),
      0,
    ) +
    presentationCharacters;
  // One operation can still analyze a larger graph without retaining it globally.
  if (units <= 8192 && characters <= 1_048_576) {
    while (
      cache.size >= 32 ||
      cachedUnits + units > 8192 ||
      cachedCharacters + characters > 1_048_576
    ) {
      const oldest = cache.keys().next().value!;
      const removed = cache.get(oldest)!;
      cache.delete(oldest);
      cachedUnits -= removed.units;
      cachedCharacters -= removed.characters;
    }
    cache.set(key, { graph, units, characters, work });
    cachedUnits += units;
    cachedCharacters += characters;
  }
  return graph;
}
