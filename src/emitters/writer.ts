import {
  OperationError,
  type AddressRange,
  type Emission,
  type EmissionRequirement,
  type OperationContext,
  type Requirement,
} from '../core/index.js';
import type { Origin } from '../ir/index.js';

const NO_REFS: readonly number[] = Object.freeze([]);

/** A bound on provenance metadata (tables, mappings, refs, metadata bytes), never on the
 * pseudocode text. The renderer answers it by shedding metadata, not by failing. */
export class MetadataLimitError extends OperationError {}
/** Upper bound of one serialized table index plus separator ("999999,"). */
const REF_BYTES = 7;

/** One-pass normalized subject references, owned by one writer. Identities are
 * interned into the writer's table as they are added; duplicates are dropped. */
class MappingReferences {
  private readonly seen = new Set<number>();
  private readonly items: string[] = [];
  private readonly indexes: number[] = [];
  private sealed = false;
  constructor(readonly owner: Writer) {}

  get ids(): readonly string[] {
    return this.items;
  }

  add(id: string): void {
    this.owner.context.checkpoint(1);
    if (this.sealed) throw new TypeError('Published mapping references are immutable');
    const ref = this.owner.id(id);
    if (this.seen.has(ref)) return;
    this.seen.add(ref);
    this.items.push(id);
    this.indexes.push(ref);
  }

  seal(): readonly number[] {
    this.sealed = true;
    Object.freeze(this.items);
    return Object.freeze(this.indexes);
  }
}

/** First-use interning of one emission's identity, proof and range tables. */
class InternTable<T> {
  readonly items: T[] = [];
  private readonly indexes = new Map<string, number>();
  constructor(
    private readonly writer: Writer,
    private readonly limit: number,
    private readonly bytes: (item: T) => number,
  ) {}

  find(key: string): number | undefined {
    return this.indexes.get(key);
  }

  add(key: string, item: T): number {
    const known = this.indexes.get(key);
    if (known !== undefined) return known;
    if (this.items.length >= this.limit)
      this.writer.limitMetadata('Pseudocode reference table limit exceeded');
    this.writer.metadata(this.bytes(item));
    this.indexes.set(key, this.items.length);
    this.items.push(item);
    return this.items.length - 1;
  }
}
const rangeKey = (range: AddressRange): string =>
  `${range.start.image_id}:${range.start.space}:${range.start.value}:${range.size}`;

/** Set-valued inference references, canonicalized within one immutable render.
 * Sparse words avoid repeatedly visiting a large common proof set. Published
 * arrays are shared only after an exact word-key match, never a lossy hash. */
export class ReferenceUnions {
  private readonly inputs = new WeakMap<readonly number[], ReadonlyMap<number, number>>();
  private readonly outputs = new Map<string, readonly number[]>();
  constructor(private readonly context: OperationContext) {}

  begin() {
    const words = new Map<number, number>(),
      seen = new Set<readonly number[]>();
    return {
      add: (refs: readonly number[]): void => {
        this.context.checkpoint(0);
        if (seen.has(refs)) return;
        seen.add(refs);
        let input = this.inputs.get(refs);
        if (!input) {
          const encoded = new Map<number, number>();
          for (const ref of refs) {
            this.context.checkpoint(1);
            const word = Math.floor(ref / 32);
            encoded.set(word, (encoded.get(word) ?? 0) | (1 << (ref % 32)));
          }
          input = encoded;
          this.inputs.set(refs, input);
        }
        for (const [word, bits] of input) {
          this.context.checkpoint(1);
          words.set(word, (words.get(word) ?? 0) | bits);
        }
      },
      finish: (): readonly number[] => {
        const ordered = [...words].sort(([a], [b]) => {
          this.context.checkpoint(1);
          return a - b;
        });
        this.context.checkpoint(ordered.length);
        const key = ordered.map(([word, bits]) => `${word}:${bits}`).join(',');
        const cached = this.outputs.get(key);
        if (cached) return cached;
        const result: number[] = [];
        for (const [word, mask] of ordered) {
          let bits = mask;
          while (bits !== 0) {
            this.context.checkpoint(1);
            const lowest = bits & -bits;
            result.push(word * 32 + 31 - Math.clz32(lowest));
            bits ^= lowest;
          }
        }
        Object.freeze(result);
        this.outputs.set(key, result);
        return result;
      },
    };
  }
}

/** UTF-16 offsets and UTF-8 resource accounting deliberately use different units.
 * Temporary lists/strings are bounded before joining; no silent truncation of text.
 * Text and provenance metadata are bounded separately: metadata overflow throws
 * `MetadataLimitError`; with `metadata: 'omitted'` no metadata is produced at all and
 * only the number of mappings that would have been recorded is counted. */
export class Writer {
  private readonly parts: string[] = [];
  readonly mappings: Emission['mappings'][number][] = [];
  readonly helpers: Emission['helpers'][number][] = [];
  /** Emission `ids`, `evidence` and `ranges` tables in first-use order. */
  readonly ids = new InternTable<string>(this, 1_000_000, (id) => Buffer.byteLength(id) + 3);
  readonly proofs = new InternTable<string>(this, 10000, (id) => Buffer.byteLength(id) + 3);
  readonly ranges = new InternTable<AddressRange>(this, 1_000_000, () => 160);
  private readonly helperNames = new Set<string>();
  private readonly idUnions = new WeakMap<readonly string[], readonly number[]>();
  private readonly proofUnions = new WeakMap<readonly string[], readonly number[]>();
  private readonly idLists = new WeakMap<readonly string[], readonly number[]>();
  private readonly proofLists = new WeakMap<readonly string[], readonly number[]>();
  private readonly rangeLists = new WeakMap<readonly AddressRange[], readonly number[]>();
  private bytes = 0;
  private metadataBytes = 0;
  offset = 0;
  /** Non-comment lines, used to keep empty Python-like suites syntactically explicit. */
  codeLines = 0;
  /** Set to null to capture the next code line written; undefined captures nothing. */
  watched: string | null | undefined = undefined;
  readonly limit: number;
  /** Mappings not recorded because metadata is omitted. */
  omittedMappings = 0;
  constructor(
    readonly context: OperationContext,
    readonly indent: number,
    readonly evidence: boolean,
    readonly language: Emission['language'] = 'c-like',
    readonly metadataMode: 'full' | 'omitted' = 'full',
  ) {
    this.limit = Math.min(context.budget.output_bytes, 16_777_216);
    if (!Number.isInteger(indent) || indent < 1 || indent > 8)
      throw new RangeError('Indent must be 1..8');
    context.checkpoint(0);
  }

  fail(message: string): never {
    throw new OperationError({
      code: 'resource_limit',
      severity: 'error',
      message,
      evidence_ids: [],
    });
  }

  limitMetadata(message: string): never {
    throw new MetadataLimitError({
      code: 'resource_limit',
      severity: 'error',
      message,
      evidence_ids: [],
    });
  }

  guard(bytes: number): void {
    if (bytes > this.limit) this.fail('Pseudocode emission exceeds the output byte budget');
  }

  /** Charge provenance metadata against its own bound; text bytes never count here. */
  metadata(bytes: number): void {
    if (this.metadataMode === 'omitted') return;
    this.metadataBytes += bytes;
    if (this.metadataBytes > this.limit)
      this.limitMetadata('Pseudocode metadata exceeds the output byte budget');
  }

  /** Bound variadic helper operands while formatting, rather than allocating a
   * potentially unbounded mapped array before join can check its size. */
  list<T>(items: readonly T[], format: (item: T) => string): string[] {
    const parts: string[] = [];
    let bytes = 0;
    for (const item of items) {
      this.context.checkpoint(1);
      const part = format(item);
      bytes += Buffer.byteLength(part) + 2;
      this.guard(bytes);
      parts.push(part);
    }
    return parts;
  }

  join(parts: Iterable<string>, separator = ', '): string {
    const collected: string[] = [];
    let bytes = 0;
    const separatorBytes = Buffer.byteLength(separator);
    for (const part of parts) {
      this.context.checkpoint(1);
      bytes += Buffer.byteLength(part) + (collected.length ? separatorBytes : 0);
      this.guard(bytes);
      collected.push(part);
    }
    return collected.join(separator);
  }

  /** JSON-style data literals; slash and format controls are escaped even inside
   * comments, so target text cannot terminate comments or reorder displayed code. */
  quote(text: string): string {
    this.guard(text.length);
    const parts: string[] = ['"'];
    let bytes = 2;
    for (const character of text) {
      this.context.checkpoint(1);
      const code = character.codePointAt(0)!;
      const escaped =
        character === '/'
          ? '\\u002f'
          : code < 32 ||
              code === 0x7f ||
              (code >= 0x2028 && code <= 0x202e) ||
              (code >= 0x2066 && code <= 0x2069) ||
              (code >= 0xd800 && code <= 0xdfff)
            ? `\\u${code.toString(16).padStart(4, '0')}`
            : character === '"' || character === '\\'
              ? `\\${character}`
              : character;
      bytes += Buffer.byteLength(escaped);
      this.guard(bytes);
      parts.push(escaped);
    }
    parts.push('"');
    return parts.join('');
  }

  /** Syntax is selected before text is written, so spans cover the final dialect. */
  statement(depth: number, expression: string): void {
    this.line(depth, `${expression}${this.language === 'c-like' ? ';' : ''}`);
  }

  declaration(type: string, name: string, initializer = ''): string {
    return this.language === 'c-like'
      ? `${type} ${name}${initializer}`
      : `${name}: ${type}${initializer}`;
  }

  comment(depth: number, text: string): void {
    this.line(depth, this.language === 'c-like' ? `/* ${text} */` : `# ${text}`, false);
  }

  sequence(parts: readonly string[]): string {
    return this.language === 'c-like' ? `{${this.join(parts)}}` : `[${this.join(parts)}]`;
  }

  line(depth: number, text: string, code = true): void {
    this.context.checkpoint(1);
    if (depth > 256) this.fail('Pseudocode emission nesting exceeds 256');
    const padding = depth * this.indent;
    const bytes = padding + Buffer.byteLength(text) + 1;
    this.guard(this.bytes + bytes);
    const line = `${' '.repeat(padding)}${text}\n`;
    this.parts.push(line);
    this.bytes += bytes;
    this.offset += line.length;
    if (code) {
      this.codeLines++;
      if (this.watched === null) this.watched = line;
    }
  }

  /** Insert whole depth-0 lines at an existing line boundary of the emitted text.
   * A prelude can then depend on the final body; recorded mappings at or after
   * the boundary move with it, and the displacement is returned for callers that
   * keep offsets of their own. */
  insertLines(offset: number, lines: readonly string[]): number {
    this.context.checkpoint(lines.length);
    if (!lines.length) return 0;
    let index = 0,
      at = 0;
    while (at < offset && index < this.parts.length) at += this.parts[index++]!.length;
    if (at !== offset) throw new RangeError('Insertion offset is not a line boundary');
    const inserted = lines.map((text) => `${text}\n`);
    let delta = 0,
      bytes = 0;
    for (const line of inserted) {
      bytes += Buffer.byteLength(line);
      delta += line.length;
      this.guard(this.bytes + bytes);
    }
    for (let item = 0; item < this.mappings.length; item++) {
      this.context.checkpoint(0);
      const mapping = this.mappings[item]!;
      if (mapping.start >= offset)
        this.mappings[item] = {
          ...mapping,
          start: mapping.start + delta,
          end: mapping.end + delta,
        };
      else if (mapping.end > offset) throw new RangeError('Insertion offset splits a mapping');
    }
    this.parts.splice(index, 0, ...inserted);
    this.bytes += bytes;
    this.offset += delta;
    this.codeLines += lines.length;
    return delta;
  }

  helper(name: string, explanation: string): string {
    if (!this.helperNames.has(name)) {
      if (this.helpers.length >= 1000) this.fail('Pseudocode helper limit exceeded');
      this.metadata(Buffer.byteLength(name) + Buffer.byteLength(explanation));
      this.helpers.push({ name, explanation });
      this.helperNames.add(name);
    }
    return name;
  }

  references(): MappingReferences {
    return new MappingReferences(this);
  }

  /** Table index of one entity identity, interned on first use. */
  id(value: string): number {
    return this.metadataMode === 'omitted' ? 0 : this.ids.add(value, value);
  }

  /** Table index of one proof identity, interned on first use. */
  proof(value: string): number {
    return this.metadataMode === 'omitted' ? 0 : this.proofs.add(value, value);
  }

  /** Table index of one binary range, interned on first use. */
  range(value: AddressRange): number {
    return this.metadataMode === 'omitted' ? 0 : this.ranges.add(rangeKey(value), value);
  }

  /** Existing table index of an identity; lookups never grow the published table. */
  findId(value: string): number | undefined {
    return this.ids.find(value);
  }

  /** Charge a structured metadata value once without serializing or copying it. */
  charge(value: unknown): void {
    this.context.checkpoint(1);
    if (typeof value === 'string') this.metadata(Buffer.byteLength(value) + 8);
    else if (typeof value === 'bigint' || typeof value === 'number') this.metadata(32);
    else if (Array.isArray(value)) {
      this.metadata(2 + value.length);
      for (const item of value) this.charge(item);
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        this.metadata(key.length + 4);
        this.charge(item);
      }
    } else this.metadata(5);
  }

  /** Serialized index lists have a known bound; no per-element walk is needed. */
  chargeRefs(...lists: readonly (readonly number[])[]): void {
    this.context.checkpoint(1);
    let refs = 0;
    for (const list of lists) refs += list.length;
    this.metadata(lists.length * 24 + refs * REF_BYTES);
  }

  /** Intern an identity list in order, without changing its multiplicity. */
  idRefs(ids: readonly string[]): readonly number[] {
    return this.refs(this.ids, this.idLists, ids, (id) => id);
  }

  /** Intern a proof list in order, without changing its multiplicity. */
  proofRefs(ids: readonly string[]): readonly number[] {
    return this.refs(this.proofs, this.proofLists, ids, (id) => id);
  }

  /** Intern a range list in order, without changing its multiplicity. */
  rangeRefs(ranges: readonly AddressRange[]): readonly number[] {
    return this.refs(this.ranges, this.rangeLists, ranges, rangeKey);
  }

  /** Cite one source requirement and its sites through this emission's tables. */
  requirement(record: Requirement): EmissionRequirement {
    const { subject_ids, evidence_ids, instruction_ids, ranges, sites, ...facts } = record;
    this.charge(facts);
    const compact: EmissionRequirement = {
      id: facts.id,
      status: facts.status,
      explanation: facts.explanation,
      subject_refs: this.idRefs(subject_ids),
      evidence_refs: this.proofRefs(evidence_ids),
      instruction_refs: this.idRefs(instruction_ids),
      range_refs: this.rangeRefs(ranges),
      output_spans: facts.output_spans,
      kind: facts.kind,
      sites: sites.map(
        ({
          subject_ids: subjects,
          evidence_ids: proofs,
          instruction_ids: instructions,
          ...site
        }) => {
          this.charge(site);
          const refs = {
            subject_refs: this.idRefs(subjects),
            evidence_refs: this.proofRefs(proofs),
            instruction_refs: this.idRefs(instructions),
          };
          this.chargeRefs(refs.subject_refs, refs.evidence_refs, refs.instruction_refs);
          return {
            id: site.id,
            ...refs,
            state_epoch: site.state_epoch,
            ...(site.predicate_value_id === undefined
              ? {}
              : { predicate_value_id: site.predicate_value_id }),
            ...(site.supported_predicate_value === undefined
              ? {}
              : { supported_predicate_value: site.supported_predicate_value }),
          };
        },
      ),
    };
    this.chargeRefs(
      compact.subject_refs,
      compact.evidence_refs,
      compact.instruction_refs,
      compact.range_refs,
    );
    return compact;
  }

  map(
    origin: Origin,
    start: number,
    semanticIds: readonly string[] | MappingReferences = [],
    extraEvidence: readonly string[] = [],
    end = this.offset,
  ): void {
    this.context.checkpoint(1);
    if (end === start) return;
    if (this.metadataMode === 'omitted') {
      this.omittedMappings++;
      return;
    }
    const prepared = semanticIds instanceof MappingReferences ? semanticIds : undefined;
    const semanticInput = semanticIds instanceof MappingReferences ? semanticIds.ids : semanticIds;
    if (prepared && (prepared.owner !== this || prepared.ids[0] !== origin.id))
      throw new TypeError(
        'Prepared mapping references must belong to this writer and begin with the mapped origin',
      );
    if (
      this.mappings.length >= 100000 ||
      semanticInput.length >= 10000 ||
      origin.provenance.instruction_ids.length > 10000 ||
      origin.provenance.ranges.length > 10000
    )
      this.limitMetadata('Pseudocode mapping cardinality limit exceeded');
    const evidence = this.evidence
      ? this.union(this.proofs, this.proofUnions, origin.provenance.evidence_ids, extraEvidence)
      : NO_REFS;
    if (evidence.length > 1000) this.limitMetadata('Pseudocode mapping evidence limit exceeded');
    const semantic = prepared
      ? prepared.seal()
      : this.union(this.ids, this.idUnions, [origin.id], semanticInput);
    const instructions = this.idRefs(origin.provenance.instruction_ids);
    const ranges = this.rangeRefs(origin.provenance.ranges);
    this.metadata(
      32 + REF_BYTES * (semantic.length + instructions.length + ranges.length + evidence.length),
    );
    this.mappings.push({
      start,
      end,
      semantic_refs: semantic,
      instruction_refs: instructions,
      range_refs: ranges,
      evidence_refs: evidence,
    });
  }

  /** IDs/provenance are immutable during one render. Reuse empty-right unions
   * instead of re-interning the same provenance list for every mapping. */
  private union(
    table: InternTable<string>,
    cache: WeakMap<readonly string[], readonly number[]>,
    a: readonly string[],
    b: readonly string[],
  ): readonly number[] {
    if (a.length + b.length > 10000)
      this.limitMetadata('Pseudocode mapping reference limit exceeded');
    if (b.length === 0) {
      const cached = cache.get(a);
      if (cached) {
        this.context.checkpoint(0);
        return cached;
      }
    }
    const refs = new Set<number>();
    for (let index = 0; index < a.length + b.length; index++) {
      this.context.checkpoint(1);
      const id = index < a.length ? a[index]! : b[index - a.length]!;
      refs.add(table.add(id, id));
    }
    const result = Object.freeze([...refs]);
    if (b.length === 0) cache.set(a, result);
    return result;
  }

  private refs<T>(
    table: InternTable<T>,
    cache: WeakMap<readonly T[], readonly number[]> | undefined,
    items: readonly T[],
    key: (item: T) => string,
  ): readonly number[] {
    const cached = cache?.get(items);
    if (cached) {
      this.context.checkpoint(0);
      return cached;
    }
    const result: number[] = [];
    for (const item of items) {
      this.context.checkpoint(1);
      result.push(table.add(key(item), item));
    }
    Object.freeze(result);
    cache?.set(items, result);
    return result;
  }

  text(): string {
    return this.parts.join('');
  }
}
