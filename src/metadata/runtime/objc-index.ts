import type { Evidence, LoadedImage, OperationContext } from '../../core/index.js';
import { recoverRuntimeMetadata } from './index.js';
import type { RuntimeRecord } from './model.js';

export interface ObjCFact {
  readonly name: string;
  /** The runtime record's proof and the bytes it derives from. */
  readonly evidence: readonly Evidence[];
}
export interface ObjCMethodFact extends ObjCFact {
  readonly owner: string;
  readonly kind: 'instance' | 'class';
  readonly type: string | null;
}
/** Address-keyed static Objective-C facts of one image (VA values). */
export interface ObjCImageIndex {
  /** `__objc_selrefs` slot -> selector name. */
  readonly selector_refs: ReadonlyMap<bigint, ObjCFact>;
  /** `__objc_classrefs`/`__objc_superrefs` slot -> class name. */
  readonly class_refs: ReadonlyMap<bigint, ObjCFact>;
  /** `__objc_stubs` entry -> selector name. */
  readonly stubs: ReadonlyMap<bigint, ObjCFact>;
  /** `__cfstring` object -> decoded contents. */
  readonly strings: ReadonlyMap<bigint, ObjCFact>;
  /** Method implementation entry -> every method record naming it. */
  readonly methods: ReadonlyMap<bigint, readonly ObjCMethodFact[]>;
  /** Selector -> its single type encoding among this image's method records
   * and protocol declarations, or null when they disagree. */
  readonly selector_types: ReadonlyMap<string, string | null>;
}

const indexes = new WeakMap<LoadedImage, { revision: number; index: ObjCImageIndex | null }>();

/** Static facts only, recovered once per immutable image/revision. Null when
 * the image carries no Objective-C runtime metadata. */
export function objcImageIndex(
  image: LoadedImage,
  revision: number,
  context: OperationContext,
): ObjCImageIndex | null {
  const cached = indexes.get(image);
  if (cached?.revision === revision) return cached.index;
  const metadata = recoverRuntimeMetadata({ image, revision }, context);
  const evidence = new Map(metadata.evidence.map((item) => [item.id, item]));
  const proof = (record: RuntimeRecord): Evidence[] =>
    record.evidence_ids.flatMap((id) => {
      const item = evidence.get(id);
      if (!item) return [];
      return [
        item,
        ...item.derived_from.flatMap((parent) => {
          const source = evidence.get(parent);
          return source ? [source] : [];
        }),
      ];
    });
  const selector_refs = new Map<bigint, ObjCFact>(),
    class_refs = new Map<bigint, ObjCFact>(),
    stubs = new Map<bigint, ObjCFact>(),
    strings = new Map<bigint, ObjCFact>(),
    methods = new Map<bigint, ObjCMethodFact[]>(),
    selector_types = new Map<string, string | null>();
  for (const record of metadata.records) {
    context.checkpoint(1);
    const at = record.address.value,
      fact = { name: record.name, evidence: proof(record) };
    if (record.kind === 'objc_selector') selector_refs.set(at, fact);
    else if (record.kind === 'objc_class_reference' || record.kind === 'objc_superclass_reference') {
      // A class's own superclass field is not a code-visible reference slot.
      if (record.owner === null) class_refs.set(at, fact);
    } else if (record.kind === 'objc_selector_stub') stubs.set(at, fact);
    else if (record.kind === 'objc_string') strings.set(at, fact);
    if (
      (record.kind === 'objc_method' || record.kind === 'objc_method_declaration') &&
      record.type_name
    ) {
      const prior = selector_types.get(record.name);
      selector_types.set(
        record.name,
        prior === undefined || prior === record.type_name ? record.type_name : null,
      );
    }
    if (
      record.kind === 'objc_method' &&
      record.target_role === 'code' &&
      record.target &&
      record.owner &&
      record.method_kind
    ) {
      const list = methods.get(record.target.value) ?? [];
      list.push({ ...fact, owner: record.owner, kind: record.method_kind, type: record.type_name });
      methods.set(record.target.value, list);
    }
  }
  const index =
    metadata.state === 'absent'
      ? null
      : { selector_refs, class_refs, stubs, strings, methods, selector_types };
  indexes.set(image, { revision, index });
  return index;
}
