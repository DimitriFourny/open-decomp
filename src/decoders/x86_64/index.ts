import {
  Decoder as IcedDecoder,
  DecoderError,
  DecoderOptions,
  Formatter,
  FormatterSyntax,
  Instruction,
  InstructionInfoFactory,
} from 'iced-x86';
import {
  checkedEnd,
  checkedU64,
  entityIdentity,
  type Address,
  type AddressRange,
  type DecodeGap,
  type DecodeRequest,
  type DecodeResult,
  type DecodedInstruction,
  type Decoder,
  type Diagnostic,
  type LoadedImage,
  type OperationContext,
} from '../../core/index.js';
import { flow, payload } from './metadata.js';

interface Part {
  readonly range: AddressRange;
  readonly file: bigint | null;
  readonly reason: 'unmapped' | 'data' | null;
}
const WINDOW = 64 * 1024;

function diagnostic(code: Diagnostic['code'], message: string, address: Address): Diagnostic {
  return { code, severity: 'warning', message, address, evidence_ids: [] };
}
/** Canonicalize backed file coordinates through AddressMap; never treat a file offset as RIP. */
function virtualRegions(
  image: LoadedImage,
  regions: readonly AddressRange[],
  context: OperationContext,
): { ranges: AddressRange[]; holes: DecodeGap[] } {
  const ranges: AddressRange[] = [];
  const holes: DecodeGap[] = [];
  for (const region of regions) {
    context.checkpoint(1);
    if (region.start.image_id !== image.id)
      throw new RangeError('Decode region belongs to another image');
    const end = checkedEnd(region.start.value, region.size);
    if (region.start.space !== 'file') {
      const start =
        region.start.space === 'va'
          ? region.start.value
          : checkedU64(image.image_base + region.start.value);
      checkedEnd(start, region.size);
      ranges.push({ start: { ...region.start, space: 'va', value: start }, size: region.size });
      continue;
    }
    let cursor = region.start.value;
    while (cursor < end) {
      context.checkpoint(1);
      const source: Address = { ...region.start, value: cursor };
      const translated = image.address_map.translate(source, 'va');
      const mapping = image.mappings.find((m) => {
        context.checkpoint(1);
        return cursor >= m.file_offset && cursor < m.file_offset + m.file_size;
      });
      let boundary = end;
      if (mapping)
        boundary =
          mapping.file_offset + mapping.file_size < end
            ? mapping.file_offset + mapping.file_size
            : end;
      else
        for (const m of image.mappings) {
          context.checkpoint(1);
          if (m.file_offset > cursor && m.file_offset < boundary) boundary = m.file_offset;
        }
      const size = boundary - cursor;
      if (translated.kind === 'mapped' && translated.address.space === 'va')
        ranges.push({ start: translated.address, size });
      else
        holes.push({
          range: { start: source, size },
          reason: 'unmapped',
          diagnostics: [
            diagnostic('unmapped', 'File region has no static virtual address', source),
          ],
        });
      cursor = boundary;
    }
  }
  ranges.sort((a, b) => {
    context.checkpoint(1);
    return a.start.value < b.start.value ? -1 : a.start.value > b.start.value ? 1 : 0;
  });
  const merged: AddressRange[] = [];
  for (const range of ranges) {
    context.checkpoint(1);
    if (range.size === 0n) continue;
    const last = merged.at(-1);
    if (last && range.start.value <= last.start.value + last.size) {
      const end = range.start.value + range.size;
      if (end > last.start.value + last.size)
        merged[merged.length - 1] = { start: last.start, size: end - last.start.value };
    } else merged.push(range);
  }
  return { ranges: merged, holes };
}
/** Prepare image-wide data boundaries once, retaining even overlapping hint endpoints. */
function dataRanges(image: LoadedImage, context: OperationContext): readonly AddressRange[] {
  const events: { value: bigint; delta: number }[] = [];
  for (const hint of image.hints) {
    context.checkpoint(1);
    if (hint.kind !== 'data') continue;
    for (const range of virtualRegions(image, [hint.range], context).ranges) {
      context.checkpoint(1);
      events.push(
        { value: range.start.value, delta: 1 },
        { value: range.start.value + range.size, delta: -1 },
      );
    }
  }
  events.sort((a, b) => {
    context.checkpoint(1);
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  });
  const ranges: AddressRange[] = [];
  let previous: bigint | null = null;
  let active = 0;
  for (const event of events) {
    context.checkpoint(1);
    if (active > 0 && previous !== null && event.value > previous) {
      ranges.push({
        start: { image_id: image.id, space: 'va', value: previous },
        size: event.value - previous,
      });
    }
    active += event.delta;
    previous = event.value;
  }
  return ranges;
}
function parts(
  image: LoadedImage,
  range: AddressRange,
  data: readonly AddressRange[],
  context: OperationContext,
): Part[] {
  const result: Part[] = [];
  for (const span of image.address_map.spans(range.start, range.size)) {
    context.checkpoint(1);
    let cursor = span.range.start.value;
    const end = cursor + span.range.size;
    // Prepared intervals are ordered and disjoint; skip unrelated image data in O(log n).
    let low = 0;
    let high = data.length;
    while (low < high) {
      context.checkpoint(1);
      const middle = low + Math.floor((high - low) / 2);
      const item = data[middle]!;
      if (item.start.value + item.size <= cursor) low = middle + 1;
      else high = middle;
    }
    while (cursor < end) {
      context.checkpoint(1);
      let boundary = end;
      const item = data[low];
      const isData = item !== undefined && cursor >= item.start.value;
      if (item !== undefined) {
        const next = isData ? item.start.value + item.size : item.start.value;
        if (next < boundary) boundary = next;
        if (isData) low++;
      }
      result.push({
        range: { start: { ...range.start, value: cursor }, size: boundary - cursor },
        file: span.file_offset === null ? null : span.file_offset + cursor - span.range.start.value,
        reason: isData ? 'data' : span.kind !== 'mapped' ? 'unmapped' : null,
      });
      cursor = boundary;
    }
  }
  return result;
}
/** Copy at most a bounded window, gathering adjacent VA mappings even with disjoint backing. */
function windowBytes(
  image: LoadedImage,
  run: readonly Part[],
  offset: bigint,
  count: number,
  context: OperationContext,
): Uint8Array {
  const first = run.find((part) => {
    context.checkpoint(1);
    return offset >= part.range.start.value && offset < part.range.start.value + part.range.size;
  })!;
  const within = offset - first.range.start.value;
  if (within + BigInt(count) <= first.range.size)
    return image.bytes.read(first.file! + within, count);
  const result = new Uint8Array(count);
  let copied = 0;
  for (const part of run) {
    context.checkpoint(1);
    const start = offset > part.range.start.value ? offset : part.range.start.value;
    const end = part.range.start.value + part.range.size;
    if (start >= end) continue;
    const length = Number(
      end - start < BigInt(count - copied) ? end - start : BigInt(count - copied),
    );
    result.set(image.bytes.read(part.file! + start - part.range.start.value, length), copied);
    copied += length;
    if (copied === count) break;
  }
  return result;
}

export interface X86DecoderOptions {
  readonly formatting?: boolean;
}
/** Structured long-mode decoding. No assembly text participates in semantic adaptation. */
export class X86Decoder implements Decoder {
  readonly name = 'open-decomp/iced-x86';
  readonly version = '1.21.0';
  readonly architecture = 'x86_64' as const;
  readonly #formatter: Formatter | null;
  readonly #presentation = new WeakMap<
    DecodedInstruction,
    { mnemonic: string; operands: string }
  >();
  #disposed = false;
  // Metadata is immutable for a LoadedImage snapshot, not for a content identity.
  // Another snapshot of the same bytes may have different data boundaries.
  #dataRanges = new WeakMap<LoadedImage, readonly AddressRange[]>();
  constructor(options: X86DecoderOptions = {}) {
    this.#formatter = options.formatting === false ? null : new Formatter(FormatterSyntax.Intel);
  }
  decode(request: DecodeRequest, context: OperationContext): DecodeResult {
    if (this.#disposed) throw new Error('X86Decoder is disposed');
    if (request.mode !== 'long64' || request.image.target.architecture !== 'x86_64')
      throw new RangeError('X86Decoder requires an x86-64 long-mode image');
    context.checkpoint(0);
    const normalized = virtualRegions(request.image, request.regions, context);
    let data = this.#dataRanges.get(request.image);
    if (data === undefined) {
      const prepared = dataRanges(request.image, context);
      // Never publish partially normalized data after failure or cancellation.
      context.checkpoint(0);
      this.#dataRanges.set(request.image, prepared);
      data = prepared;
    }
    const instructions: DecodedInstruction[] = [];
    const gaps: DecodeGap[] = [...normalized.holes];
    const diagnostics: Diagnostic[] = [];
    const native = new Instruction();
    let factory: InstructionInfoFactory | null = null;
    let exhausted = false;
    try {
      factory = new InstructionInfoFactory();
      for (const region of normalized.ranges) {
        const partition = parts(request.image, region, data, context);
        for (let p = 0; p < partition.length; p++) {
          context.checkpoint(1);
          const part = partition[p]!;
          if (part.reason !== null) {
            gaps.push({
              range: part.range,
              reason: part.reason,
              diagnostics:
                part.reason === 'unmapped'
                  ? [
                      diagnostic(
                        'unmapped',
                        'No backed instruction bytes (hole or virtual zero-fill)',
                        part.range.start,
                      ),
                    ]
                  : [],
            });
            continue;
          }
          const run: Part[] = [part];
          while (p + 1 < partition.length && partition[p + 1]!.reason === null) {
            context.checkpoint(1);
            run.push(partition[++p]!);
          }
          const start = part.range.start;
          const end = run.at(-1)!.range.start.value + run.at(-1)!.range.size;
          let cursor = start.value;
          while (cursor < end) {
            if (exhausted || instructions.length >= context.budget.instructions) {
              exhausted = true;
              const range = { start: { ...start, value: cursor }, size: end - cursor };
              gaps.push({
                range,
                reason: 'budget',
                diagnostics: [
                  diagnostic('resource_limit', 'Instruction budget exhausted', range.start),
                ],
              });
              break;
            }
            context.checkpoint(1);
            const count = Number(
              end - cursor < BigInt(WINDOW + 14) ? end - cursor : BigInt(WINDOW + 14),
            );
            const bytes = windowBytes(request.image, run, cursor, count, context);
            const decoder = new IcedDecoder(64, bytes, DecoderOptions.None);
            try {
              decoder.ip = cursor;
              while (decoder.canDecode && decoder.position < WINDOW) {
                if (instructions.length >= context.budget.instructions) break;
                context.checkpoint(1);
                const position = decoder.position;
                const address: Address = { ...start, value: decoder.ip };
                decoder.decodeOut(native);
                cursor = address.value + BigInt(native.length);
                if (decoder.lastError === DecoderError.NoMoreBytes) {
                  gaps.push({
                    range: { start: address, size: end - address.value },
                    reason: 'truncated',
                    diagnostics: [
                      diagnostic(
                        'invalid_input',
                        'Incomplete instruction at backed-region boundary',
                        address,
                      ),
                    ],
                  });
                  cursor = end;
                  break;
                }
                const sourcePart = run.find((item) => {
                  context.checkpoint(1);
                  return (
                    address.value >= item.range.start.value &&
                    address.value < item.range.start.value + item.range.size
                  );
                })!;
                const fileStart = sourcePart.file! + address.value - sourcePart.range.start.value;
                let contiguous = true;
                if (cursor > sourcePart.range.start.value + sourcePart.range.size) {
                  for (const item of run) {
                    context.checkpoint(1);
                    if (
                      item.range.start.value > address.value &&
                      item.range.start.value < cursor &&
                      item.file !== fileStart + item.range.start.value - address.value
                    )
                      contiguous = false;
                  }
                }
                const byteStart: Address = contiguous
                  ? { ...address, space: 'file', value: fileStart }
                  : address;
                const invalid = decoder.lastError === DecoderError.InvalidInstruction;
                const localDiagnostics = invalid
                  ? [diagnostic('invalid_input', 'Invalid x86-64 encoding', address)]
                  : [];
                const identity = entityIdentity(request.image.selected_slice_id, 'instruction', {
                  address: address.value,
                  architecture: 'x86_64',
                });
                let decoded: DecodedInstruction;
                if (invalid)
                  decoded = {
                    id: identity,
                    address,
                    bytes: { start: byteStart, size: BigInt(native.length) },
                    size: native.length,
                    validity: 'invalid',
                    payload: null,
                    flow: { kind: 'unknown', reason: 'Invalid encoding', may_fallthrough: false },
                    diagnostics: localDiagnostics,
                    evidence_ids: [],
                  };
                else {
                  const info = factory.info(native);
                  try {
                    const constants = decoder.getConstantOffsets(native);
                    try {
                      const structured = payload(native, info, constants, bytes, position, address);
                      const disabled =
                        request.features.length > 0 &&
                        structured.required_features.some(
                          (feature) => !request.features.includes(feature),
                        );
                      decoded = {
                        id: identity,
                        address,
                        bytes: { start: byteStart, size: BigInt(native.length) },
                        size: native.length,
                        validity: disabled ? 'feature_disabled' : 'valid',
                        payload: structured,
                        flow: flow(native, address),
                        diagnostics: disabled
                          ? [
                              diagnostic(
                                'unsupported_target',
                                'Instruction requires an unavailable CPU feature',
                                address,
                              ),
                            ]
                          : [],
                        evidence_ids: [],
                      };
                    } finally {
                      constants.free();
                    }
                  } finally {
                    info.free();
                  }
                  if (this.#formatter)
                    this.#presentation.set(decoded, {
                      mnemonic: this.#formatter.formatMnemonic(native),
                      operands: this.#formatter.formatAllOperands(native),
                    });
                }
                instructions.push(decoded);
                diagnostics.push(...decoded.diagnostics);
              }
            } finally {
              decoder.free();
            }
          }
        }
      }
    } finally {
      factory?.free();
      native.free();
    }
    for (const gap of gaps) diagnostics.push(...gap.diagnostics);
    const reasons = [
      ...new Set([
        ...gaps.map((g) => g.reason),
        ...instructions.filter((i) => i.validity !== 'valid').map((i) => i.validity),
      ]),
    ];
    return {
      instructions,
      gaps,
      diagnostics,
      coverage: {
        layer: 'decode',
        state: reasons.length === 0 ? 'complete' : 'partial',
        completed_units: instructions.filter((i) => i.validity === 'valid').length,
        reasons,
      },
    };
  }
  format(instruction: DecodedInstruction): {
    readonly mnemonic: string;
    readonly operands: string;
  } {
    if (this.#disposed) throw new Error('X86Decoder is disposed');
    const result = this.#presentation.get(instruction);
    if (!result)
      throw new Error(
        'Formatting requires an instruction decoded by this formatting-enabled instance',
      );
    return { ...result };
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#dataRanges = new WeakMap();
    this.#formatter?.free();
  }
}
