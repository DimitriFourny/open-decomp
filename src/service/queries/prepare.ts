import {
  NATIVE_SYMBOL_TABLES_FEATURE,
  OperationError,
  type LoadedImage,
  type OperationContext,
} from '../../core/index.js';
import type { PreparedImport } from '../../workers/runtime.js';
import { Arm64Decoder } from '../../decoders/arm64/index.js';
import { X86Decoder } from '../../decoders/x86_64/index.js';
import { discoverFunctions } from '../../analysis/discovery/index.js';
import { buildStringIndex } from '../../analysis/strings/index.js';
import { buildReferenceIndex } from '../../analysis/references/index.js';
import { recoverRuntimeMetadata } from '../../metadata/runtime/index.js';
import { decorateImageNames } from '../../metadata/symbols/index.js';

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
    discovery = discoverFunctions({ image: decorated, decoder, revision }, context);
  } finally {
    decoder.dispose();
  }
  const strings = buildStringIndex({ image, revision }, context);
  const references = buildReferenceIndex(
    { image: decorated, discovery, strings, revision },
    context,
  );
  const evidence = new Map(
    [...decorated.evidence, ...references.evidence].map((item) => [item.id, item]),
  );
  const labels = new Map(
    [...names.symbols, ...names.exports].flatMap((item) =>
      item.address && item.display_name
        ? [[`${item.address.value}:${item.original_name}`, item.display_name] as const]
        : [],
    ),
  );
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
      for (const graph of discovery.graphs) {
        const label = labels.get(`${graph.function.entry.value}:${graph.function.original_name}`);
        tx.putRecord(
          image.id,
          'function',
          label ? { ...graph.function, display_name: label } : graph.function,
        );
      }
      for (const item of references.strings?.strings ?? strings.strings)
        tx.putRecord(image.id, 'string', item);
      for (const item of references.references) tx.putRecord(image.id, 'reference', item);
      for (const kind of ['symbol', 'export'] as const)
        tx.setIndexState(image.id, kind, nativeNamesPartial ? 'partial' : 'complete');
      tx.setIndexState(image.id, 'import', metadataPartial ? 'partial' : 'complete');
      tx.setIndexState(
        image.id,
        'function',
        discovery.coverage.state === 'complete' ? 'complete' : 'partial',
      );
      tx.setIndexState(image.id, 'string', references.strings?.state ?? strings.state);
      tx.setIndexState(image.id, 'reference', references.state);
    },
  };
}
