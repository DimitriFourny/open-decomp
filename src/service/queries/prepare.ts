import {
  NATIVE_SYMBOL_TABLES_FEATURE,
  OperationError,
  type DiscoveryFrontier,
  type Evidence,
  type FunctionGraph,
  type FunctionRecord,
  type LoadedImage,
  type OperationContext,
  type StoreTransaction,
} from '../../core/index.js';
import type { PreparedImport } from '../../workers/runtime.js';
import { Arm64Decoder } from '../../decoders/arm64/index.js';
import { X86Decoder } from '../../decoders/x86_64/index.js';
import { discoverFunctions } from '../../analysis/discovery/index.js';
import { buildStringIndex } from '../../analysis/strings/index.js';
import { buildReferenceIndex } from '../../analysis/references/index.js';
import { classifyImportStubs, type ImportStub } from '../../analysis/discovery/stubs.js';
import { recoverRuntimeMetadata } from '../../metadata/runtime/index.js';
import { libraryNoreturnCalls } from '../../metadata/library-contracts/index.js';
import { decorateImageNames } from '../../metadata/symbols/index.js';
import { targetAbi } from '../analysis/versions.js';

/** Prepare outside SQLite; publish native facts, the import report and navigation
 * atomically. Decorated/runtime names remain separate derived records.
 * A completed index describes its documented seeded/eligible subset, not all code/data. */
export async function prepareQueryImport(
  image: LoadedImage,
  scope: { readonly revision: number; readonly context: OperationContext },
): Promise<PreparedImport> {
  const { revision, context } = scope;
  const runtime = recoverRuntimeMetadata({ image, revision }, context);
  const names = await decorateImageNames(
    { ...image, symbols: [...image.symbols, ...runtime.symbols] },
    context,
  );
  const decorated = {
    ...image,
    symbols: names.symbols,
    imports: names.imports,
    exports: names.exports,
    evidence: [...image.evidence, ...runtime.evidence],
    diagnostics: [...image.diagnostics, ...runtime.diagnostics, ...names.diagnostics],
  };
  if (decorated.diagnostics.length > 1000)
    throw new OperationError({
      code: 'resource_limit',
      severity: 'error',
      message: 'Combined import diagnostics exceed the 1,000-record wire bound',
      evidence_ids: [],
    });
  if (image.capabilities.length >= 1000)
    throw new OperationError({
      code: 'resource_limit',
      severity: 'error',
      message: 'Combined import capabilities exceed the 1,000-record wire bound',
      evidence_ids: [],
    });
  const formatPartial = image.capabilities.some(
    (capability) => capability.layer === 'format' && capability.status === 'partial',
  );
  // A loader that reports its native symbol/export tables separately keeps unrelated partial
  // metadata (unwind, CFI, relocations) from degrading name authority.
  const nameTables = image.capabilities.find(
    (capability) =>
      capability.layer === 'format' && capability.feature === NATIVE_SYMBOL_TABLES_FEATURE,
  );
  const derivedNamesPartial = names.state === 'partial' || runtime.state === 'partial';
  const metadataPartial = formatPartial || derivedNamesPartial;
  const nativeNamesPartial =
    (nameTables ? nameTables.status === 'partial' : formatPartial) || derivedNamesPartial;
  const decoder =
    image.target.architecture === 'arm64'
      ? new Arm64Decoder()
      : new X86Decoder({ formatting: false });
  let discovery;
  try {
    discovery = discoverFunctions(
      {
        image: decorated,
        decoder,
        revision,
        noreturn_calls: libraryNoreturnCalls(decorated, context),
        preserved_registers: targetAbi(image.target)?.preserved ?? [],
      },
      context,
    );
  } finally {
    decoder.dispose();
  }
  const strings = buildStringIndex({ image, revision }, context);
  const references = buildReferenceIndex(
    { image: decorated, discovery, strings, revision },
    context,
  );
  const stubs = classifyImportStubs(decorated, discovery.graphs, references.references, context);
  const evidence = new Map(
    [...decorated.evidence, ...references.evidence].map((item) => [item.id, item]),
  );
  const labels = nameLabels(names);
  context.checkpoint(0);
  return {
    image: {
      ...image,
      evidence: decorated.evidence,
      diagnostics: decorated.diagnostics,
      capabilities: [
        ...image.capabilities,
        {
          layer: 'analysis',
          feature: 'Imported native/runtime names and metadata',
          status: metadataPartial ? 'partial' : 'supported',
          limitations: metadataPartial
            ? [
                'Some imported metadata is unavailable; native-name indexes are explicitly incomplete.',
              ]
            : [],
        },
      ],
    },
    publish(tx) {
      for (const item of evidence.values()) tx.putEvidence(item);
      for (const item of names.symbols) tx.putRecord(image.id, 'symbol', item);
      for (const item of names.imports) tx.putRecord(image.id, 'import', item);
      for (const item of names.exports) tx.putRecord(image.id, 'export', item);
      publishFunctions(tx, image.id, discovery.graphs, labels, stubs);
      for (const item of references.strings?.strings ?? strings.strings)
        tx.putRecord(image.id, 'string', item);
      for (const item of references.references) tx.putRecord(image.id, 'reference', item);
      for (const kind of ['symbol', 'export'] as const)
        tx.setIndexState(image.id, kind, nativeNamesPartial ? 'partial' : 'complete');
      tx.setIndexState(image.id, 'import', metadataPartial ? 'partial' : 'complete');
      // Complete function enumeration, not complete per-function analysis: unresolved flow
      // inside a function leaves its graph partial but cannot hide another function.
      tx.setIndexState(image.id, 'function', discovery.enumeration);
      tx.setDiscoveryFrontier(image.id, discovery.frontier);
      tx.setIndexState(image.id, 'string', references.strings?.state ?? strings.state);
      tx.setIndexState(image.id, 'reference', references.state);
    },
  };
}

function nameLabels(image: Pick<LoadedImage, 'symbols' | 'exports'>): Map<string, string> {
  return new Map(
    [...image.symbols, ...image.exports].flatMap((item) =>
      item.address && item.display_name
        ? [[`${item.address.value}:${item.original_name}`, item.display_name] as const]
        : [],
    ),
  );
}

function publishFunctions(
  tx: StoreTransaction,
  imageId: string,
  graphs: readonly FunctionGraph[],
  labels: ReadonlyMap<string, string>,
  stubs: ReadonlyMap<string, ImportStub>,
): void {
  for (const graph of graphs) {
    const label = labels.get(`${graph.function.entry.value}:${graph.function.original_name}`);
    const stub = stubs.get(graph.function.id);
    const named = label ? { ...graph.function, display_name: label } : graph.function;
    tx.putRecord(
      imageId,
      'function',
      stub
        ? {
            ...named,
            // A stub is the import it forwards to; an existing native name stays.
            ...(named.original_name === null
              ? {
                  original_name: stub.import.original_name,
                  display_name: stub.import.display_name,
                }
              : {}),
            kind: 'import_stub' as const,
            boundary: named.boundary === 'conflicting' ? named.boundary : ('established' as const),
            analysis: 'complete' as const,
            evidence_ids: [...new Set([...named.evidence_ids, ...stub.evidence_ids])].sort(),
          }
        : named,
    );
  }
}

export interface PreparedDiscoveryStep {
  /** False when the step cannot change the published state (stalled on the same frontier). */
  readonly progressed: boolean;
  readonly published: number;
  readonly enumeration: 'complete' | 'partial';
  publish(tx: StoreTransaction): void;
}

/** One continuation step of a budget-limited whole-image discovery, from the persisted frontier
 * and the published records (`image` carries the published, decorated symbols, imports and
 * exports). Deterministic in its inputs and budget; it publishes only the roots it traversed,
 * their references and the evidence they cite, never touching final functions. */
export function prepareDiscoveryStep(
  image: LoadedImage,
  input: {
    readonly revision: number;
    readonly functions: readonly FunctionRecord[];
    readonly frontier: DiscoveryFrontier;
    readonly reference_state: 'complete' | 'partial' | 'not_started';
  },
  context: OperationContext,
): PreparedDiscoveryStep {
  const { revision } = input;
  const decoder =
    image.target.architecture === 'arm64'
      ? new Arm64Decoder()
      : new X86Decoder({ formatting: false });
  let discovery;
  try {
    discovery = discoverFunctions(
      {
        image,
        decoder,
        revision,
        functions: input.functions,
        resume: input.frontier,
        noreturn_calls: libraryNoreturnCalls(image, context),
        preserved_registers: targetAbi(image.target)?.preserved ?? [],
      },
      context,
    );
  } finally {
    decoder.dispose();
  }
  const same = (a: DiscoveryFrontier | null, b: DiscoveryFrontier): boolean =>
    a !== null &&
    a.sweep === b.sweep &&
    a.pending.length === b.pending.length &&
    a.pending.every(
      (root, index) =>
        root.entry === b.pending[index]!.entry &&
        root.established === b.pending[index]!.established &&
        root.evidence_ids.join() === b.pending[index]!.evidence_ids.join(),
    );
  const progressed = !same(discovery.frontier, input.frontier);
  const references = buildReferenceIndex({ image, discovery, revision }, context);
  const stubs = classifyImportStubs(image, discovery.graphs, references.references, context);
  // Publish the evidence the new records and the frontier cite, not the loader facts the import
  // already stored.
  const known = new Set(image.evidence.map((item) => item.id));
  const pool = new Map<string, Evidence>(
    [...discovery.evidence, ...references.evidence].map((item) => [item.id, item]),
  );
  const cited = [
    ...discovery.graphs.flatMap((graph) => [
      ...graph.function.evidence_ids,
      ...graph.diagnostics.flatMap((diagnostic) => diagnostic.evidence_ids),
      ...graph.instructions.flatMap((instruction) => [
        ...instruction.evidence_ids,
        ...instruction.diagnostics.flatMap((diagnostic) => diagnostic.evidence_ids),
      ]),
      ...(graph.jump_tables ?? []).flatMap((table) => table.evidence_ids),
    ]),
    ...references.references.flatMap((reference) => reference.evidence_ids),
    ...[...stubs.values()].flatMap((stub) => stub.evidence_ids),
    ...(discovery.frontier?.pending.flatMap((root) => root.evidence_ids) ?? []),
  ];
  const evidence = new Map<string, Evidence>();
  for (let cursor = 0; cursor < cited.length; cursor++) {
    context.checkpoint(1);
    const id = cited[cursor]!;
    if (known.has(id) || evidence.has(id)) continue;
    const proof = pool.get(id);
    if (!proof) continue;
    evidence.set(id, proof);
    cited.push(...proof.derived_from, ...proof.conflicts_with);
  }
  const labels = nameLabels(image);
  context.checkpoint(0);
  return {
    progressed,
    published: discovery.graphs.length,
    enumeration: discovery.enumeration,
    publish(tx) {
      for (const item of evidence.values()) tx.putEvidence(item);
      publishFunctions(tx, image.id, discovery.graphs, labels, stubs);
      for (const item of references.references) tx.putRecord(image.id, 'reference', item);
      tx.setIndexState(image.id, 'function', discovery.enumeration);
      tx.setDiscoveryFrontier(image.id, discovery.frontier);
      // Earlier steps' references stay published; the union is complete only if every step's is.
      tx.setIndexState(
        image.id,
        'reference',
        input.reference_state === 'complete' && references.state === 'complete'
          ? 'complete'
          : 'partial',
      );
    },
  };
}
