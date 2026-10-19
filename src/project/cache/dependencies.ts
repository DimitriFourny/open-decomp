import { z } from 'zod';
import {
  OperationError,
  addressSchema,
  cacheIdentityKey,
  decodeAddress,
  encodeAddress,
  fingerprint,
  type Address,
  type Annotation,
  type AnnotationQuery,
  type CacheIdentity,
  type CanonicalValue,
  type Evidence,
  type FunctionRecord,
  type OperationContext,
  type ProjectStore,
  type RecordQuery,
  type RecoveredType,
  type Signature,
  type StoredRecordKinds,
} from '../../core/index.js';
import { typeReferences } from '../annotations/subjects.js';

const MAX_READS = 100000;
const MAX_ANNOTATIONS = 100000;
const recordKind = z.enum(['function', 'string', 'reference', 'symbol', 'import', 'export']);
const selectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('signature'), id: z.string() }),
  z.strictObject({ kind: z.literal('type'), id: z.string() }),
  z.strictObject({ kind: z.literal('proof'), id: z.string() }),
  z.strictObject({ kind: z.literal('annotations'), id: z.string() }),
  z.strictObject({ kind: z.literal('type_annotations'), id: z.string() }),
  z.strictObject({ kind: z.literal('all_annotations') }),
  z.strictObject({
    kind: z.literal('record_scope'),
    image_id: z.string(),
    record_kind: recordKind,
  }),
  z.strictObject({ kind: z.literal('function'), image_id: z.string(), id: z.string() }),
  z.strictObject({
    kind: z.literal('function_address'),
    image_id: z.string(),
    address: addressSchema,
  }),
]);
export const analysisReadsetSchema = z.strictObject({
  version: z.literal(1),
  complete: z.literal(true),
  reads: z
    .array(
      z.strictObject({ selector: selectorSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }),
    )
    .min(1)
    .max(MAX_READS),
});
export type AnalysisReadset = z.infer<typeof analysisReadsetSchema>;
type Selector = z.infer<typeof selectorSchema>;

/** This is a candidate index key, never a CacheIdentity or permission to serve a hit. */
export function analysisReuseScope(identity: CacheIdentity): string {
  return cacheIdentityKey({ ...identity, annotation_revision: 0, evidence_revision: 0 });
}
/** Retain core's bigint type tags rather than coercing machine values to text. */
function dependencyValue(value: unknown): CanonicalValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'number'
  )
    return value;
  if (Array.isArray(value)) return value.map(dependencyValue);
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const result: { [key: string]: CanonicalValue } = {};
    for (const [key, item] of Object.entries(value))
      if (item !== undefined) result[key] = dependencyValue(item);
    return result;
  }
  throw new TypeError('Analysis dependencies must be plain immutable domain values');
}
function digest(value: unknown): string {
  return fingerprint(dependencyValue(value));
}
function exhausted(message: string): never {
  throw new OperationError({
    code: 'resource_limit',
    severity: 'error',
    message,
    evidence_ids: [],
  });
}
interface AnnotationReadIndex {
  readonly rows: readonly Annotation[];
  readonly types: ReadonlyMap<string, readonly Annotation[]>;
}
function allAnnotations(
  store: ProjectStore,
  revision: number,
  context: OperationContext,
): AnnotationReadIndex {
  const result: Annotation[] = [];
  const types = new Map<string, Annotation[]>();
  let cursor: string | undefined;
  do {
    context.checkpoint(1);
    const page = store.queryAnnotations({
      revision,
      limit: 1000,
      ...(cursor === undefined ? {} : { cursor }),
    });
    context.checkpoint(page.items.length);
    result.push(...page.items);
    if (result.length > MAX_ANNOTATIONS) exhausted('Analysis annotation dependency bound exceeded');
    for (const annotation of page.items)
      if (annotation.value.kind === 'type') {
        const declarations = types.get(annotation.value.type_id) ?? [];
        declarations.push(annotation);
        types.set(annotation.value.type_id, declarations);
      }
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return { rows: result, types };
}
function readSelector(
  store: ProjectStore,
  revision: number,
  selector: Selector,
  context: OperationContext,
  annotations: () => AnnotationReadIndex,
): unknown {
  context.checkpoint(1);
  switch (selector.kind) {
    case 'signature':
      return store.readSignature(selector.id, revision);
    case 'type':
      return store.readType(selector.id, revision);
    case 'proof':
      return store.readEvidence([selector.id], revision)[0] ?? null;
    case 'annotations':
      return store.readAnnotations(selector.id, revision);
    case 'type_annotations':
      return annotations().types.get(selector.id) ?? [];
    case 'all_annotations':
      return annotations().rows;
    case 'record_scope':
      return store.readRecordScopeVersion(selector.image_id, selector.record_kind, revision);
    case 'function':
      return (
        store.queryRecords({
          revision,
          image_id: selector.image_id,
          kind: 'function',
          ids: [selector.id],
          limit: 1,
        }).items[0] ?? null
      );
    case 'function_address': {
      const page = store.queryRecords({
        revision,
        image_id: selector.image_id,
        kind: 'function',
        address: decodeAddress(selector.address),
        limit: 1000,
      });
      if (page.next_cursor !== null)
        exhausted('Analysis function frontier dependency bound exceeded');
      return page.items;
    }
  }
}

interface DurableTypeDependency {
  readonly definition: RecoveredType;
  readonly evidence_ids: readonly string[];
}

/** One read a traced computation captured (or found already captured), with the charges
 * a fresh capture of it makes. */
export interface TracedRead {
  readonly key: string;
  readonly read: AnalysisReadset['reads'][number];
  readonly charges: 1 | 2;
}
/** All negative reads are retained. Mutable store/maps are never used as cache keys. */
export class AnalysisDependencyCollector {
  readonly store: ProjectStore;
  readonly #reads = new Map<string, AnalysisReadset['reads'][number]>();
  #annotationDepth = 0;
  #trace: TracedRead[] | undefined;
  #annotations: AnnotationReadIndex | undefined;
  constructor(
    readonly source: ProjectStore,
    readonly revision: number,
    readonly context: OperationContext,
  ) {
    this.store = new Proxy(source, {
      get: (target, property) => {
        switch (property) {
          case 'readSignature':
            return (id: string, at: number) => {
              const result = target.readSignature(id, at);
              if (at === revision) {
                this.capture({ kind: 'signature', id }, result);
                this.recordSignatureClosure(result);
              }
              return result;
            };
          case 'readType':
            return (id: string, at: number) => {
              const result = target.readType(id, at);
              if (at === revision) this.recordType(id, result);
              return result;
            };
          case 'readEvidence':
            return (ids: readonly string[], at: number) => {
              const result = target.readEvidence(ids, at);
              if (at === revision) {
                const found = new Map<string, Evidence>();
                for (const proof of result) found.set(proof.id, proof);
                for (const id of ids) this.recordProof(id, found.get(id) ?? null);
              }
              return result;
            };
          case 'readAnnotations':
            return (id: string, at: number) => {
              const result = target.readAnnotations(id, at);
              if (at === revision) {
                this.capture({ kind: 'annotations', id }, result);
                this.recordAnnotationValues(result);
              }
              return result;
            };
          case 'queryAnnotations':
            return (query: AnnotationQuery) => {
              const result = target.queryAnnotations(query);
              if (query.revision === revision && this.#annotationDepth === 0)
                this.recordAnnotationScope(null, []);
              return result;
            };
          case 'queryRecords':
            return <K extends keyof StoredRecordKinds>(query: RecordQuery<K>) => {
              const result = target.queryRecords(query);
              if (query.revision === revision) {
                if (query.kind === 'function' && query.ids !== undefined)
                  for (const id of query.ids) this.recordFunction(query.image_id, id);
                else this.recordRecordScope(query.image_id, query.kind);
              }
              return result;
            };
          default: {
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        }
      },
    });
  }
  private annotations = () =>
    (this.#annotations ??= allAnnotations(this.source, this.revision, this.context));
  private capture(selector: Selector, value?: unknown): void {
    const key = digest(selector);
    const existing = this.#reads.get(key);
    // A fresh capture charges once, plus once more for the store read of a value-less one.
    const charges = value === undefined ? 2 : 1;
    if (existing) {
      this.#trace?.push({ key, read: existing, charges });
      return;
    }
    if (this.#reads.size >= MAX_READS) exhausted('Analysis dependency readset bound exceeded');
    this.context.checkpoint(1);
    const read = {
      selector,
      fingerprint: digest(
        value === undefined
          ? readSelector(this.source, this.revision, selector, this.context, this.annotations)
          : value,
      ),
    };
    this.#reads.set(key, read);
    this.#trace?.push({ key, read, charges });
  }

  recordFunction(image_id: string, id: string, record?: FunctionRecord | null): void {
    const value =
      record === undefined
        ? (this.source.queryRecords({
            revision: this.revision,
            image_id,
            kind: 'function',
            ids: [id],
            limit: 1,
          }).items[0] ?? null)
        : record;
    this.capture({ kind: 'function', image_id, id }, value);
    if (value) {
      for (const proof of value.evidence_ids) this.recordProof(proof);
      this.recordSignatureClosure(value.signature);
    }
  }

  recordFunctionQuery(
    image_id: string,
    address: Address,
    records: readonly FunctionRecord[],
  ): void {
    this.capture({ kind: 'function_address', image_id, address: encodeAddress(address) }, records);
    for (const record of records) this.recordFunction(image_id, record.id, record);
  }

  recordRecordScope(image_id: string, record_kind: keyof StoredRecordKinds): void {
    this.capture({ kind: 'record_scope', image_id, record_kind });
  }

  private recordSignatureClosure(signature: Signature | null): void {
    if (!signature) return;
    this.recordType(signature.return_type);
    for (const parameter of signature.parameters) this.recordType(parameter.type_id);
    for (const proof of signature.evidence_ids) this.recordProof(proof);
  }

  recordProof(id: string, initial?: Evidence | null): void {
    const pending = [id];
    // While tracing, already captured closures are walked too, so the trace holds every
    // read a computation needs regardless of what this collector captured before it.
    const visited = this.#trace && new Set<string>();
    while (pending.length) {
      const next = pending.pop()!;
      const selector = { kind: 'proof' as const, id: next };
      if (visited ? visited.has(next) : this.#reads.has(digest(selector))) continue;
      visited?.add(next);
      const proof =
        next === id && initial !== undefined
          ? initial
          : (this.source.readEvidence([next], this.revision)[0] ?? null);
      this.capture(selector, proof);
      if (proof) pending.push(...proof.derived_from, ...proof.conflicts_with);
    }
  }

  recordType(id: string, initial?: DurableTypeDependency | null): void {
    const pending = [id];
    const visited = this.#trace && new Set<string>();
    while (pending.length) {
      const next = pending.pop()!;
      const selector = { kind: 'type' as const, id: next };
      if (visited ? visited.has(next) : this.#reads.has(digest(selector))) continue;
      visited?.add(next);
      const type =
        next === id && initial !== undefined ? initial : this.source.readType(next, this.revision);
      this.capture(selector, type);
      if (type) {
        pending.push(...typeReferences(type.definition));
        for (const proof of type.evidence_ids) this.recordProof(proof);
      }
    }
  }

  private recordAnnotationValues(annotations: readonly Annotation[]): void {
    for (const annotation of annotations) {
      for (const proof of annotation.evidence_ids) this.recordProof(proof);
      if (annotation.value.kind === 'signature') {
        this.recordSignatureClosure(annotation.value.value);
      } else if (annotation.value.kind === 'type') {
        this.recordType(annotation.value.type_id);
        for (const id of typeReferences(annotation.value.definition)) this.recordType(id);
      }
    }
  }
  /** AnnotationService reports the actual selected subjects and traversed declaration keys. */
  recordAnnotationScope = (
    subjects: readonly string[] | null,
    type_ids: readonly string[],
  ): void => {
    if (subjects === null) {
      const annotations = this.annotations().rows;
      this.capture({ kind: 'all_annotations' }, annotations);
      this.recordAnnotationValues(annotations);
    } else
      for (const id of subjects) {
        const annotations = this.source.readAnnotations(id, this.revision);
        this.capture({ kind: 'annotations', id }, annotations);
        this.recordAnnotationValues(annotations);
      }
    for (const id of type_ids) {
      const annotations = this.annotations().types.get(id) ?? [];
      this.capture({ kind: 'type_annotations', id }, annotations);
      this.recordAnnotationValues(annotations);
    }
  };
  annotationView<T>(read: () => T): T {
    this.#annotationDepth++;
    try {
      return read();
    } finally {
      this.#annotationDepth--;
    }
  }

  /** Exact-snapshot native helper hits must replay every read, not just positive functions.
   * A read this collector already captured at its revision is not re-read: the store is
   * immutable per revision, so the re-read would equal the captured value. Work charges
   * stay identical to re-reading (one unit per replayed read). */
  replay(readset: AnalysisReadset): void {
    const own = finishedReadsets.get(readset);
    if (own === this) {
      // A snapshot of this collector is a prefix of its (append-only) reads.
      for (let index = 0; index < readset.reads.length; index++) this.context.checkpoint(1);
      return;
    }
    for (const read of (own ? readset : analysisReadsetSchema.parse(readset)).reads) {
      const captured = this.#reads.get(digest(read.selector));
      const value = captured
        ? undefined
        : readSelector(this.source, this.revision, read.selector, this.context, this.annotations);
      if (captured) this.context.checkpoint(1);
      if ((captured ? captured.fingerprint : digest(value)) !== read.fingerprint)
        throw new OperationError({
          code: 'invalid_input',
          severity: 'error',
          message: 'Native helper dependency snapshot no longer matches its readset',
          evidence_ids: [],
        });
      if (!captured) this.capture(read.selector, value);
    }
  }

  /** Run `compute`, recording every read it captures or would capture, in order. */
  traced<T>(compute: () => T): { readonly value: T; readonly trace: readonly TracedRead[] } {
    const outer = this.#trace,
      trace: TracedRead[] = [];
    this.#trace = trace;
    try {
      return { value: compute(), trace };
    } finally {
      this.#trace = outer;
      outer?.push(...trace);
    }
  }

  /** Work `replayTrace` will charge, or undefined when replay would first have to load the
   * annotation index (whose cost is only known by loading it). */
  traceCharges(trace: readonly TracedRead[]): number | undefined {
    let charges = 0;
    for (const entry of trace) {
      const kind = entry.read.selector.kind;
      if (!this.#annotations && (kind === 'all_annotations' || kind === 'type_annotations'))
        return undefined;
      if (!this.#reads.has(entry.key)) charges += entry.charges;
    }
    return charges;
  }

  /** Apply a traced computation's reads at the same revision as if it ran here: reads
   * new to this collector are captured in traced order with a fresh capture's charges;
   * already captured reads cost nothing, exactly as in `capture`. */
  replayTrace(trace: readonly TracedRead[]): void {
    for (const entry of trace) {
      const kind = entry.read.selector.kind;
      if (kind === 'all_annotations' || kind === 'type_annotations') this.annotations();
      this.#trace?.push(entry);
      if (this.#reads.has(entry.key)) continue;
      if (this.#reads.size >= MAX_READS) exhausted('Analysis dependency readset bound exceeded');
      for (let charge = 0; charge < entry.charges; charge++) this.context.checkpoint(1);
      this.#reads.set(entry.key, entry.read);
    }
  }

  /** Snapshots are taken after every prepared dependency, so they must not re-validate
   * the whole (growing) ledger: entries are built here from typed selectors and
   * digests in schema field order and never mutated. Only an empty ledger, which the
   * schema rejects, still goes through it. */
  finish(): AnalysisReadset {
    const readset: AnalysisReadset = this.#reads.size
      ? { version: 1, complete: true, reads: [...this.#reads.values()] }
      : analysisReadsetSchema.parse({ version: 1, complete: true, reads: [] });
    finishedReadsets.set(readset, this);
    return readset;
  }
}
/** Readsets produced by `finish()` (already validated) and the collector that produced them. */
const finishedReadsets = new WeakMap<AnalysisReadset, AnalysisDependencyCollector>();
export function createAnalysisReadset(
  store: ProjectStore,
  revision: number,
  context: OperationContext,
): AnalysisDependencyCollector {
  return new AnalysisDependencyCollector(store, revision, context);
}
export function validateAnalysisReadset(
  store: ProjectStore,
  revision: number,
  readset: AnalysisReadset,
  context: OperationContext,
): boolean {
  const ledger = analysisReadsetSchema.parse(readset);
  let annotations: AnnotationReadIndex | undefined;
  const readAnnotations = () => (annotations ??= allAnnotations(store, revision, context));
  context.progress('dependency-validation', 0, ledger.reads.length);
  for (let index = 0; index < ledger.reads.length; index++) {
    const read = ledger.reads[index]!;
    if (
      digest(readSelector(store, revision, read.selector, context, readAnnotations)) !==
      read.fingerprint
    )
      return false;
    context.progress('dependency-validation', index + 1, ledger.reads.length);
  }
  return true;
}
