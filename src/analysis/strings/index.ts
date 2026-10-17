import {
  entityIdentity,
  fingerprint,
  type Diagnostic,
  type Evidence,
  type LoadedImage,
  type OperationContext,
  type StringRecord,
} from '../../core/index.js';
import { searchIndex, type IndexPage, type IndexSearch } from '../references/search.js';

export interface StringIndex {
  readonly image_id: string;
  readonly slice_id: string;
  readonly revision: number;
  readonly identity: string;
  readonly strings: readonly StringRecord[];
  readonly evidence: readonly Evidence[];
  readonly state: 'complete' | 'partial';
  readonly diagnostics: readonly Diagnostic[];
  readonly scanned_bytes: number;
}
export interface StringIndexInput {
  readonly image: LoadedImage;
  readonly revision: number;
  readonly max_bytes?: number;
  readonly max_strings?: number;
  readonly max_string_bytes?: number;
  readonly min_characters?: number;
}
const printable = /^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}\t\r\n]+$/u;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const utf16 = new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true });

/** Conservative NUL-delimited strings from file-backed noninstruction sections.
 * UTF-16 requires section metadata, a BOM, or two printable ASCII/zero pairs;
 * C-string sections never combine adjacent one-character records into UTF-16.
 * Invalid encodings reject the entire record, not a convenient printable suffix.
 * No synthetic bytes are read from zero-fill, gaps or another universal slice.
 * Complete describes these eligible sections, not arbitrary encoded/encrypted text.
 */
export function buildStringIndex(input: StringIndexInput, context: OperationContext): StringIndex {
  context.checkpoint(0);
  const { image, revision } = input;
  const maxBytes = input.max_bytes ?? 32 * 1024 * 1024;
  const maxStrings = input.max_strings ?? 50_000;
  const maxString = input.max_string_bytes ?? 16 * 1024;
  const min = input.min_characters ?? 4;
  for (const value of [revision, maxBytes, maxStrings, maxString, min])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError('Invalid string index bounds');
  if (maxString > 1_048_576 || min < 1) throw new RangeError('Invalid string length bounds');
  const strings: StringRecord[] = [];
  const evidence: Evidence[] = [];
  const reasons = new Set<string>();
  let scanned = 0;
  let covered = -1n;
  let stopped = false;
  const sections = image.sections
    .filter(
      (section) =>
        section.kind === 'section' &&
        section.file_range !== null &&
        (image.target.format === 'macho'
          ? (section.flags & 0x80000400n) === 0n
          : !section.permissions.includes('execute')),
    )
    .sort((a, b) =>
      a.virtual_range.start.value < b.virtual_range.start.value
        ? -1
        : a.virtual_range.start.value > b.virtual_range.start.value
          ? 1
          : a.id.localeCompare(b.id),
    );
  for (const section of sections) {
    context.checkpoint(1);
    if (stopped) break;
    const range = section.virtual_range;
    const translated = image.address_map.translate(range.start, 'va');
    if (translated.kind !== 'mapped') {
      reasons.add('Unavailable string section mapping');
      continue;
    }
    const start = translated.address.value;
    if (start < covered) {
      reasons.add('Overlapping section aliases omitted');
      continue;
    }
    covered = start + range.size;
    for (const span of image.address_map.spans(translated.address, range.size)) {
      context.checkpoint(1);
      if (span.kind !== 'mapped' || span.file_offset === null) continue;
      const size = Number(
        span.range.size < BigInt(maxBytes - scanned) ? span.range.size : BigInt(maxBytes - scanned),
      );
      const begin = Number(span.file_offset);
      const end = begin + size;
      const wideSection = /(?:ustring|utf16)/i.test(section.name);
      const cstring = image.target.format === 'macho' && (section.flags & 255n) === 2n;
      let cursor = begin;
      while (cursor < end && !stopped) {
        context.checkpoint(1);
        if (strings.length >= maxStrings) {
          reasons.add('String record budget exhausted');
          stopped = true;
          break;
        }
        if (
          image.bytes.at(cursor) === 0 &&
          (!wideSection || (cursor + 1 < end && image.bytes.at(cursor + 1) === 0))
        ) {
          const padding = wideSection ? 2 : 1;
          cursor += padding;
          scanned += padding;
          continue;
        }
        const va = span.range.start.value + BigInt(cursor - begin);
        const bom =
          cursor + 1 < end &&
          image.bytes.at(cursor) === 0xff &&
          image.bytes.at(cursor + 1) === 0xfe;
        let pairs = 0;
        for (let p = cursor; p + 1 < Math.min(cursor + 4, end); p += 2)
          if (image.bytes.at(p) >= 0x20 && image.bytes.at(p) <= 0x7e && image.bytes.at(p + 1) === 0)
            pairs++;
        const wide = va % 2n === 0n && (wideSection || bom || (!cstring && pairs === 2));
        const payload = cursor + (wide && bom ? 2 : 0);
        let finish = payload;
        const step = wide ? 2 : 1;
        while (
          finish + step <= end &&
          (image.bytes.at(finish) !== 0 || (wide && image.bytes.at(finish + 1) !== 0))
        ) {
          context.checkpoint(step);
          finish += step;
        }
        const terminated = finish + step <= end;
        if (terminated && finish - cursor <= maxString) {
          try {
            const text = (wide ? utf16 : utf8).decode(
              image.bytes.read(BigInt(payload), finish - payload),
            );
            let characters = 0;
            for (const _character of text) if (++characters >= min) break;
            if (printable.test(text) && text.trim() && characters >= min) {
              const encoding = wide ? 'utf16le' : /^[\x00-\x7f]*$/.test(text) ? 'ascii' : 'utf8';
              const address = { image_id: image.id, space: 'va' as const, value: va };
              const id = entityIdentity(image.selected_slice_id, 'string', [va, encoding]);
              const evidenceId = `evidence_${fingerprint([id, 'nul-delimited-string/1'])}`;
              strings.push({
                id,
                address,
                byte_length: BigInt(finish - cursor),
                encoding,
                text,
                status: 'candidate',
                terminated: true,
                evidence_ids: [evidenceId],
              });
              evidence.push({
                id: evidenceId,
                origin: {
                  kind: 'binary',
                  range: { start: address, size: BigInt(finish - cursor + step) },
                  description: 'Valid printable NUL-delimited string bytes',
                },
                claim: `${encoding} string candidate`,
                derived_from: section.evidence_ids,
                conflicts_with: [],
                revision,
              });
            }
          } catch {
            /* Invalid complete record is not a string. */
          }
        } else if (finish - cursor > maxString) reasons.add('Oversized string candidates omitted');
        const next = terminated ? finish + step : end;
        scanned += next - cursor;
        cursor = next;
      }
      if (BigInt(size) < span.range.size) {
        reasons.add('String byte budget exhausted');
        stopped = true;
      }
    }
  }
  const diagnostics: Diagnostic[] = [...reasons].map((message) => ({
    code: 'resource_limit',
    severity: 'warning',
    message,
    evidence_ids: [],
  }));
  return {
    image_id: image.id,
    slice_id: image.selected_slice_id,
    revision,
    identity: fingerprint([
      image.selected_slice_id,
      revision,
      'strings/1',
      maxBytes,
      maxStrings,
      maxString,
      min,
      strings.map((item) => item.id),
      [...reasons],
    ]),
    strings,
    evidence,
    diagnostics,
    state: reasons.size ? 'partial' : 'complete',
    scanned_bytes: scanned,
  };
}
export interface StringSearch extends IndexSearch {
  readonly text?: string;
  readonly encoding?: StringRecord['encoding'];
  readonly status?: StringRecord['status'];
  readonly address_min?: bigint;
  readonly address_max?: bigint;
}
export function searchStrings(
  index: StringIndex,
  options: StringSearch,
  context: OperationContext,
): IndexPage<StringRecord> {
  const query = [
    options.text ?? null,
    options.encoding ?? null,
    options.status ?? null,
    options.address_min ?? null,
    options.address_max ?? null,
  ];
  return searchIndex(
    {
      items: index.strings,
      identity: index.identity,
      revision: index.revision,
      state: index.state,
      query,
      matches: (item) =>
        (options.text === undefined || item.text.includes(options.text)) &&
        (options.encoding === undefined || item.encoding === options.encoding) &&
        (options.status === undefined || item.status === options.status) &&
        (options.address_min === undefined || item.address.value >= options.address_min) &&
        (options.address_max === undefined || item.address.value < options.address_max),
    },
    options,
    context,
  );
}
