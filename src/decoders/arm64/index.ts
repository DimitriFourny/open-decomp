import {
  checkedEnd, checkedU64, entityIdentity,
  type Address, type AddressRange, type Arm64Payload, type DecodeGap, type DecodeRequest,
  type DecodeResult, type Decoder, type DecodedInstruction, type Diagnostic, type LoadedImage,
  type OperationContext,
} from '../../core/index.js';
import { createDecoder, decode as decodeWord } from '../../../vendor/a64js/src/decode.js';
import { format as formatNative } from '../../../vendor/a64js/src/format.js';
import type { DecodedInstruction as NativeInstruction } from '../../../vendor/a64js/src/types.js';
import { completeLogical } from './completion.js';
import { instructionFlow } from './flow.js';
import { structuredOperands } from './operands.js';

interface Segment { readonly range: AddressRange; readonly file: bigint | null; readonly reason: DecodeGap['reason'] | null }
const VERSION = 'aa0e547ca5313779c87e1e52d75687b12e985615+adapter.1';
function diagnostic(code: Diagnostic['code'], message: string, address: Address): Diagnostic {
  return { code, severity: 'warning', message, address, evidence_ids: [] };
}
function vaRegions(image: LoadedImage, regions: readonly AddressRange[], context: OperationContext): { ranges: AddressRange[]; gaps: DecodeGap[] } {
  const ranges: AddressRange[] = [];
  const gaps: DecodeGap[] = [];
  for (const range of regions) {
    context.checkpoint(1);
    if (range.start.image_id !== image.id) throw new RangeError('Decode region belongs to another image');
    const end = checkedEnd(range.start.value, range.size);
    if (range.size === 0n) continue;
    if (range.start.space !== 'file') {
      const value = range.start.space === 'rva' ? checkedU64(image.image_base + range.start.value) : range.start.value;
      checkedEnd(value, range.size);
      ranges.push({ start: { image_id: image.id, space: 'va', value }, size: range.size });
      continue;
    }
    let cursor = range.start.value;
    const mappings = [...image.mappings].filter(mapping => mapping.file_size !== 0n).sort((a, b) => a.file_offset < b.file_offset ? -1 : 1);
    for (const mapping of mappings) {
      const start = cursor > mapping.file_offset ? cursor : mapping.file_offset;
      const stop = end < mapping.file_offset + mapping.file_size ? end : mapping.file_offset + mapping.file_size;
      if (stop <= start) continue;
      if (start > cursor) gaps.push({ range: { start: { ...range.start, value: cursor }, size: start - cursor }, reason: 'unmapped', diagnostics: [] });
      ranges.push({ start: { image_id: image.id, space: 'va', value: mapping.va + start - mapping.file_offset }, size: stop - start });
      cursor = stop;
    }
    if (cursor < end) gaps.push({ range: { start: { ...range.start, value: cursor }, size: end - cursor }, reason: 'unmapped', diagnostics: [] });
  }
  ranges.sort((a, b) => a.start.value < b.start.value ? -1 : a.start.value > b.start.value ? 1 : 0);
  const merged: AddressRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start.value <= previous.start.value + previous.size) {
      const end = range.start.value + range.size;
      if (end > previous.start.value + previous.size) merged[merged.length - 1] = { start: previous.start, size: end - previous.start.value };
    } else merged.push(range);
  }
  return { ranges: merged, gaps };
}
function segments(image: LoadedImage, ranges: readonly AddressRange[], data: readonly AddressRange[], context: OperationContext): Segment[] {
  const result: Segment[] = [];
  for (const range of ranges) {
    for (const span of image.address_map.spans(range.start, range.size)) {
      context.checkpoint(1);
      const begin = span.range.start.value;
      const end = begin + span.range.size;
      const points = [begin, end];
      for (const hint of data) {
        context.checkpoint(1);
        const start = hint.start.value;
        const stop = start + hint.size;
        if (start > begin && start < end) points.push(start);
        if (stop > begin && stop < end) points.push(stop);
      }
      points.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      for (let index = 0; index + 1 < points.length; index++) {
        const start = points[index]!;
        const stop = points[index + 1]!;
        if (stop === start) continue;
        const isData = data.some(hint => start >= hint.start.value && start < hint.start.value + hint.size);
        const reason = isData ? 'data' : span.kind !== 'mapped' ? 'unmapped' : null;
        const file = reason === null && span.file_offset !== null ? span.file_offset + start - begin : null;
        const previous = result.at(-1);
        if (previous && previous.reason === reason && previous.range.start.value + previous.range.size === start && (file === null || (previous.file !== null && previous.file + previous.range.size === file))) {
          result[result.length - 1] = { range: { start: previous.range.start, size: stop - previous.range.start.value }, reason, file: previous.file };
        } else result.push({ range: { start: { ...span.range.start, value: start }, size: stop - start }, reason, file });
      }
    }
  }
  return result;
}
function featureNames(native: NativeInstruction): string[] {
  const encoding = native.encoding;
  if (!encoding) return [];
  return [...new Set([
    ...encoding.features,
    ...encoding.featureGuards.map(guard => guard.feature),
    ...encoding.guards.flatMap(guard => guard.all.flatMap(check => check.kind === 'feature' ? [check.feature] : [])),
  ])];
}
function enableExpressions(features: readonly string[]): string[] {
  return [...new Set(features.flatMap(feature => feature.match(/FEAT_[A-Za-z0-9_]+/g) ?? [feature]))];
}
function instruction(image: LoadedImage, address: Address, bytes: AddressRange, decoded: NativeInstruction): DecodedInstruction {
  const native = completeLogical(decoded);
  // Feature gating must not erase a recognized instruction's operand structure. This retry is
  // only for operand extraction; original availability, diagnostics and behavior remain authoritative.
  const required = featureNames(native);
  const operandsNative = native.availability === 'unavailable' && native.encoding
    ? completeLogical(decodeWord(native.word, { features: enableExpressions(required) })) : native;
  const validity: DecodedInstruction['validity'] = native.availability === 'unavailable' ? 'feature_disabled'
    : native.status === 'undefined' ? 'undefined' : native.status === 'unknown' ? 'invalid' : 'valid';
  const diagnostics: Diagnostic[] = (native.errors ?? []).map(message => diagnostic(validity === 'invalid' || validity === 'undefined' ? 'invalid_input' : 'unsupported_target', message, address));
  const encoding = native.encoding;
  const operands = structuredOperands(operandsNative, address);
  if (operands.some(operand => operand.kind === 'opaque')) diagnostics.push(diagnostic('unavailable_semantics', 'Upstream supplies one or more opaque operands; canonical fields are preserved. Text operands are presentation only and must not be lifted.', address));
  if (validity === 'invalid' && diagnostics.length === 0) diagnostics.push(diagnostic('invalid_input', 'No recognized ARM64 encoding in the pinned decoder snapshot', address));
  if (validity === 'feature_disabled' && diagnostics.length === 0) diagnostics.push(diagnostic('unsupported_target', 'Recognized ARM64 encoding is unavailable for the selected features', address));
  const payload: Arm64Payload | null = encoding ? {
    architecture: 'arm64', encoding: encoding.encodingId, canonical_encoding: encoding.canonicalEncodingId ?? encoding.encodingId,
    alias: encoding.canonicalEncodingId && encoding.canonicalEncodingId !== encoding.encodingId ? encoding.instructionId : null,
    word: BigInt(native.word), fields: Object.fromEntries(Object.entries(native.fields ?? {}).map(([name, value]) => [name, BigInt(value)])),
    operands, availability: native.availability === 'unavailable' ? 'feature_disabled' : native.status === 'undefined' ? 'undefined' : 'available',
    required_features: required, registers: [], behavior: native.behavior ?? (native.status === 'undefined' ? 'undefined' : 'unknown'),
  } : null;
  return {
    id: entityIdentity(image.selected_slice_id, 'instruction', [address.value, 4]), address,
    bytes, size: 4,
    validity, payload, flow: instructionFlow(native, payload, validity, address), diagnostics, evidence_ids: [],
  };
}

/** Structured A64 decoding. No assembly text is used as semantic input. */
export class Arm64Decoder implements Decoder {
  readonly name = 'a64js';
  readonly version = VERSION;
  readonly architecture = 'arm64' as const;
  #disposed = false;
  // LoadedImage metadata is readonly. Key by the snapshot object, not the image
  // ID: another snapshot of the same bytes can carry different data boundaries.
  #dataRanges = new WeakMap<LoadedImage, readonly AddressRange[]>();

  decode(request: DecodeRequest, context: OperationContext): DecodeResult {
    if (this.#disposed) throw new Error('ARM64 decoder is disposed');
    if (request.mode !== 'a64' || request.image.target.architecture !== 'arm64') throw new TypeError('ARM64 decoder requires the a64 mode and an ARM64 image');
    context.checkpoint(0);
    const prepared = createDecoder({ features: request.features });
    const normalized = vaRegions(request.image, request.regions, context);
    const instructions: DecodedInstruction[] = [];
    const gaps = normalized.gaps;
    let data = this.#dataRanges.get(request.image);
    if (data === undefined) {
      const normalizedData: AddressRange[] = [];
      for (const hint of request.image.hints) {
        context.checkpoint(1);
        if (hint.kind === 'data') normalizedData.push(...vaRegions(request.image, [hint.range], context).ranges);
      }
      // Failed/cancelled normalization never installs a partially prepared entry.
      context.checkpoint(0);
      this.#dataRanges.set(request.image, normalizedData);
      data = normalizedData;
    }
    const parts = segments(request.image, normalized.ranges, data, context);
    let carriedUntil = 0n;
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex]!;
      context.checkpoint(1);
      if (part.reason !== null) {
        gaps.push({ range: part.range, reason: part.reason, diagnostics: [] });
        continue;
      }
      let offset = carriedUntil > part.range.start.value ? carriedUntil - part.range.start.value : 0n;
      if (offset >= part.range.size) continue;
      const misalignment = (part.range.start.value + offset) & 3n;
      if (misalignment !== 0n) {
        const fragment = 4n - misalignment < part.range.size - offset ? 4n - misalignment : part.range.size - offset;
        gaps.push({ range: { start: { ...part.range.start, value: part.range.start.value + offset }, size: fragment }, reason: 'truncated', diagnostics: [] });
        offset += fragment;
      }
      while (offset + 4n <= part.range.size) {
        if (instructions.length >= context.budget.instructions) break;
        context.checkpoint(1);
        const address = { ...part.range.start, value: part.range.start.value + offset };
        const file = part.file! + offset;
        instructions.push(instruction(request.image, address, { start: { image_id: request.image.id, space: 'file', value: file }, size: 4n }, prepared(request.image.bytes.u32(file))));
        offset += 4n;
      }
      if (offset < part.range.size && instructions.length < context.budget.instructions && ((part.range.start.value + offset) & 3n) === 0n) {
        // Adjacent VA mappings can back one word with nonadjacent container bytes. Keep a VA
        // byte reference for that rare case rather than inventing contiguous file backing.
        const address = { ...part.range.start, value: part.range.start.value + offset };
        let word = 0;
        let count = 0;
        for (let scanIndex = partIndex; scanIndex < parts.length && count < 4; scanIndex++) {
          const scan = parts[scanIndex]!;
          const scanOffset = scanIndex === partIndex ? offset : 0n;
          if (scan.reason !== null || scan.range.start.value + scanOffset !== address.value + BigInt(count)) break;
          for (let byte = scanOffset; byte < scan.range.size && count < 4; byte++, count++) {
            context.checkpoint(1);
            word |= request.image.bytes.at(Number(scan.file! + byte)) << (count * 8);
          }
        }
        if (count === 4) {
          instructions.push(instruction(request.image, address, { start: address, size: 4n }, prepared(word >>> 0)));
          carriedUntil = address.value + 4n;
          offset += 4n;
        }
      }
      if (offset < part.range.size) gaps.push({ range: { start: { ...part.range.start, value: part.range.start.value + offset }, size: part.range.size - offset }, reason: instructions.length >= context.budget.instructions ? 'budget' : 'truncated', diagnostics: [] });
    }
    const reasons = [...new Set([
      ...gaps.map(gap => gap.reason),
      ...instructions.filter(item => item.validity !== 'valid').map(item => item.validity),
      ...(instructions.some(item => item.payload?.architecture === 'arm64' && item.payload.operands.some(operand => operand.kind === 'opaque')) ? ['opaque_operands'] : []),
    ])];
    return {
      instructions, gaps, coverage: { layer: 'decode', state: reasons.length === 0 ? 'complete' : 'partial', completed_units: instructions.length, reasons },
      diagnostics: gaps.flatMap(gap => gap.diagnostics),
    };
  }

  format(instruction: DecodedInstruction): { mnemonic: string; operands: string } {
    if (this.#disposed) throw new Error('ARM64 decoder is disposed');
    const payload = instruction.payload;
    if (payload === null) return { mnemonic: '.inst', operands: 'unknown' };
    if (payload.architecture !== 'arm64') throw new TypeError('ARM64 formatting requires an ARM64 payload');
    if (instruction.validity === 'invalid' || instruction.validity === 'undefined' || instruction.validity === 'reserved') return { mnemonic: '.inst', operands: `0x${payload.word.toString(16).padStart(8, '0')}` };
    if (payload.behavior === 'nop' && payload.availability === 'feature_disabled') return { mnemonic: 'nop', operands: '' };
    const native = completeLogical(decodeWord(Number(payload.word), { features: enableExpressions(payload.required_features) }));
    const text = formatNative({ ...native, ...(payload.behavior === 'nop' ? { behavior: 'nop' as const } : {}) }, { pc: instruction.address.value });
    const split = text.indexOf(' ');
    return split === -1 ? { mnemonic: text, operands: '' } : { mnemonic: text.slice(0, split), operands: text.slice(split + 1) };
  }

  dispose(): void { this.#disposed = true; this.#dataRanges = new WeakMap(); }
}
