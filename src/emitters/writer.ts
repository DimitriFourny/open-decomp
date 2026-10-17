import { OperationError, type Emission, type OperationContext } from '../core/index.js';
import type { Origin } from '../ir/index.js';

/** UTF-16 offsets and UTF-8 resource accounting deliberately use different units.
 * Temporary lists/strings are bounded before joining; no silent truncation. */
export class Writer {
  private readonly parts: string[] = [];
  readonly mappings: Emission['mappings'][number][] = [];
  readonly helpers: Emission['helpers'][number][] = [];
  private readonly helperNames = new Set<string>();
  private bytes = 0;
  private metadataBytes = 0;
  offset = 0;
  /** Non-comment lines, used to keep empty Python-like suites syntactically explicit. */
  codeLines = 0;
  readonly limit: number;
  constructor(
    readonly context: OperationContext,
    readonly indent: number,
    readonly evidence: boolean,
    readonly language: Emission['language'] = 'c-like',
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
  guard(bytes: number): void {
    if (bytes > this.limit) this.fail('Pseudocode emission exceeds the output byte budget');
  }
  metadata(bytes: number): void {
    this.metadataBytes += bytes;
    this.guard(this.metadataBytes + this.bytes);
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
    this.guard(this.bytes + this.metadataBytes + bytes);
    const line = `${' '.repeat(padding)}${text}\n`;
    this.parts.push(line);
    this.bytes += bytes;
    this.offset += line.length;
    if (code) this.codeLines++;
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
  map(
    origin: Origin,
    start: number,
    semanticIds: readonly string[] = [],
    extraEvidence: readonly string[] = [],
    end = this.offset,
  ): void {
    this.context.checkpoint(
      1 +
        semanticIds.length +
        origin.provenance.instruction_ids.length +
        origin.provenance.ranges.length +
        origin.provenance.evidence_ids.length +
        extraEvidence.length,
    );
    if (end === start) return;
    if (
      this.mappings.length >= 100000 ||
      semanticIds.length >= 10000 ||
      origin.provenance.instruction_ids.length > 10000 ||
      origin.provenance.ranges.length > 10000
    )
      this.fail('Pseudocode mapping cardinality limit exceeded');
    const evidence = this.evidence
      ? this.joinIds(origin.provenance.evidence_ids, extraEvidence)
      : [];
    const semantic = this.joinIds([origin.id], semanticIds);
    this.metadata(
      64 +
        this.join(semantic, '').length +
        this.join(origin.provenance.instruction_ids, '').length +
        this.join(evidence, '').length +
        origin.provenance.ranges.length * 160,
    );
    this.mappings.push({
      statement_id: origin.id,
      start,
      end,
      semantic_ids: semantic,
      instruction_ids: [...origin.provenance.instruction_ids],
      ranges: [...origin.provenance.ranges],
      evidence_ids: evidence,
    });
    if (evidence.length > 1000) this.fail('Pseudocode mapping evidence limit exceeded');
  }
  private joinIds(a: readonly string[], b: readonly string[]): string[] {
    if (a.length + b.length > 10000) this.fail('Pseudocode mapping reference limit exceeded');
    return [...new Set([...a, ...b])];
  }
  text(): string {
    return this.parts.join('');
  }
}
