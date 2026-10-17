import {
  entityIdentity,
  fingerprint,
  type Address,
  type AddressRange,
  type Diagnostic,
  type Evidence,
  type ExportRecord,
  type HeaderRecord,
  type ImageMapping,
  type ImageSlice,
  type ImportRecord,
  type LoaderHint,
  type MetadataField,
  type Relocation,
  type Section,
  type SymbolRecord,
} from '../../core/index.js';
import { MachOError, Reader, type Segment, type RawSection } from './reader.js';

/** Per-load metadata, never shared with a later parse. */
export class State {
  readonly headers: HeaderRecord[] = [];
  readonly sections: Section[] = [];
  readonly segments: Segment[] = [];
  readonly rawSections: RawSection[] = [];
  readonly mappings: ImageMapping[] = [];
  readonly entries: Address[] = [];
  readonly symbols: SymbolRecord[] = [];
  readonly imports: ImportRecord[] = [];
  readonly exports: ExportRecord[] = [];
  readonly relocations: Relocation[] = [];
  readonly hints: LoaderHint[] = [];
  readonly evidence: Evidence[] = [];
  readonly diagnostics: Diagnostic[] = [];
  readonly libraries: string[] = [];
  readonly encrypted: { offset: number; size: number }[] = [];
  readonly relocationTables: { offset: number; count: number }[] = [];
  readonly evidenceIds = new Set<string>();
  imageBase = 0n;
  constructor(
    readonly r: Reader,
    readonly slice: ImageSlice,
  ) {}

  id(kind: string, birth: number | string | bigint): string {
    return entityIdentity(this.slice.id, kind, birth);
  }

  va(value: bigint): Address {
    if (value < 0n || value >= 1n << 64n)
      throw new MachOError('malformed_image', 'Address exceeds unsigned 64-bit space');
    return { image_id: this.slice.image_id, space: 'va', value };
  }

  file(offset: number, size: number): AddressRange {
    this.r.range(offset, size);
    return {
      start: {
        image_id: this.slice.image_id,
        space: 'file',
        value: this.slice.offset + BigInt(offset),
      },
      size: BigInt(size),
    };
  }

  proof(offset: number, size: number, claim: string): string[] {
    this.r.range(offset, size);
    const id = `evidence_${fingerprint([this.slice.id, offset, size, claim])}`;
    if (!this.evidenceIds.has(id)) {
      this.evidenceIds.add(id);
      this.evidence.push({
        id,
        origin: { kind: 'binary', range: this.file(offset, size), description: claim },
        claim,
        derived_from: [],
        conflicts_with: [],
        revision: 0,
      });
    }
    return [id];
  }

  header(
    kind: HeaderRecord['kind'],
    name: string,
    p: number,
    size: number,
    fields: MetadataField[],
  ): string[] {
    const evidence = this.proof(p, size, name);
    this.headers.push({ kind, name, range: this.file(p, size), fields, evidence_ids: evidence });
    return evidence;
  }

  warn(
    message: string,
    code: Diagnostic['code'] = 'unsupported_target',
    evidence_ids: readonly string[] = [],
  ): void {
    if (this.diagnostics.length < 1000)
      this.diagnostics.push({ code, severity: 'warning', message, evidence_ids });
  }

  optional(label: string, parse: () => void): void {
    try {
      parse();
    } catch (error) {
      // Cancellation/resource errors from the host must never become optional metadata warnings.
      if (
        !(error instanceof MachOError) ||
        error.diagnostic.code === 'resource_limit' ||
        error.diagnostic.code === 'cancelled'
      )
        throw error;
      this.warn(`${label}: ${error.message}`, error.diagnostic.code);
    }
  }

  readable(p: number, n: number): void {
    this.r.range(p, n);
    if (this.encrypted.some((range) => range.offset < p + n && p < range.offset + range.size))
      throw new MachOError('unsupported_target', 'Metadata overlaps encrypted bytes');
  }

  library(ordinal: number): string | null {
    if (ordinal <= 0)
      return (
        (
          {
            0: 'Self',
            '-1': 'Main executable',
            '-2': 'Flat lookup',
            '-3': 'Weak lookup',
          } as Record<number, string>
        )[ordinal] ?? null
      );
    const name = this.libraries[ordinal - 1];
    if (name === undefined) this.warn(`Unresolved dylib ordinal ${ordinal}`, 'malformed_image');
    return name ?? null;
  }
}
