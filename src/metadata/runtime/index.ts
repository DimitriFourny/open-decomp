import type { LoadedImage, OperationContext } from '../../core/index.js';
import { ObjCRecovery } from './objc.js';
import { SwiftRecovery } from './swift.js';
import { RuntimeIssue, RuntimeReader } from './reader.js';
import type { RuntimeLimits, RuntimeMetadata } from './model.js';
export type { RuntimeKind, RuntimeRecord, RuntimeMetadata, RuntimeLimits } from './model.js';

/** Static Mach-O ARM64 metadata only: Objective-C class/metaclass/category,
 * protocol/adoption, absolute/relative methods, ivars and selector/class refs;
 * Swift module/extension/protocol/nominal contexts and field/enum descriptors.
 * Runtime method targets must independently be readable executable ARM64 code.
 * Declarations, pointer slots and metadata objects never become callable entries.
 * Swift symbolic-reference payloads are escaped without treating embedded NULs as
 * terminators. Manglings/type encodings remain raw evidence, not source types.
 * No target execution, metadata accessor calls, dynamic class_rw interpretation,
 * PDB lookup, full Swift layout reconstruction or inferred C signatures occurs.
 * Limits: 100k records/list entries, depth 64, 4096 bytes/name and 8 MiB strings,
 * plus the caller's work/deadline budget. Local caps return valid partial facts;
 * cancellation/deadline errors propagate without publishing a result.
 */
export function recoverRuntimeMetadata(
  input: {
    readonly image: LoadedImage;
    readonly revision: number;
    readonly limits?: Partial<RuntimeLimits>;
  },
  context: OperationContext,
): RuntimeMetadata {
  const { image, revision } = input;
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new RangeError('Invalid runtime metadata revision');
  context.checkpoint(0);
  let present = false;
  if (image.target.format === 'macho')
    for (const section of image.sections) {
      context.checkpoint(1);
      if (
        section.kind === 'section' &&
        section.virtual_range.size > 0n &&
        (ObjCRecovery.sections.has(section.name) || SwiftRecovery.sections.has(section.name))
      )
        present = true;
    }
  if (!present) return { state: 'absent', records: [], symbols: [], evidence: [], diagnostics: [] };
  let reader: RuntimeReader | null = null;
  try {
    reader = new RuntimeReader(image, revision, context, input.limits ?? {});
    new ObjCRecovery(reader).run();
    new SwiftRecovery(reader).run();
  } catch (error) {
    if (!(error instanceof RuntimeIssue)) throw error;
    if (reader === null)
      return {
        state: 'partial',
        records: [],
        symbols: [],
        evidence: [],
        diagnostics: [
          {
            code: error.code,
            severity: 'warning',
            message: error.message,
            address: { image_id: image.id, space: 'va', value: error.address },
            evidence_ids: [],
          },
        ],
      };
    reader.report(error);
  }
  return {
    state: reader.partial ? 'partial' : 'complete',
    records: reader.records,
    symbols: reader.symbols,
    evidence: reader.evidence,
    diagnostics: reader.diagnostics,
  };
}
