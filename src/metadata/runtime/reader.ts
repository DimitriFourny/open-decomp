import {
  entityIdentity,
  fingerprint,
  type Address,
  type Diagnostic,
  type Evidence,
  type LoadedImage,
  type OperationContext,
  type Section,
  type SymbolRecord,
} from '../../core/index.js';
import {
  runtimeLimits,
  type RuntimeKind,
  type RuntimeLimits,
  type RuntimeRecord,
} from './model.js';

export class RuntimeIssue extends Error {
  constructor(
    readonly code: 'malformed_image' | 'unavailable_semantics' | 'resource_limit',
    message: string,
    readonly address: bigint,
  ) {
    super(message);
  }
}
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Read-only static metadata. Reads stay in one declared, readable, file-backed
 * section and never consume encrypted bytes. Raw pointers are not reinterpreted
 * when chained encodings or loader diagnostics make their decoding uncertain.
 * Resolved authenticated relocations are logical pointers, not proof of hardware
 * authentication. External bindings and contradictory fixups remain unavailable.
 */
export class RuntimeReader {
  readonly records: RuntimeRecord[] = [];
  readonly symbols: SymbolRecord[] = [];
  readonly evidence: Evidence[] = [];
  readonly diagnostics: Diagnostic[] = [];
  readonly sections: readonly Section[];
  readonly limits: RuntimeLimits;
  readonly encrypted: { start: bigint; end: bigint }[] = [];
  readonly fixups = new Map<
    bigint,
    {
      target: bigint | null;
      external: boolean;
      conflicting: boolean;
      evidence_ids: readonly string[];
    }
  >();
  readonly externalClasses = new Map<bigint, string | null>();
  /** Bound import slots and loader-established import stub entries, by VA. */
  readonly importSlots = new Map<bigint, string | null>();
  readonly importEntries = new Map<bigint, string | null>();
  readonly requireFixup: boolean;
  readonly seen = new Set<string>();
  stringBytes = 0;
  partial = false;
  constructor(
    readonly image: LoadedImage,
    readonly revision: number,
    readonly context: OperationContext,
    limits: Partial<RuntimeLimits>,
  ) {
    this.limits = { ...runtimeLimits, ...limits };
    for (const key of Object.keys(runtimeLimits) as (keyof RuntimeLimits)[])
      if (
        !Number.isSafeInteger(this.limits[key]) ||
        this.limits[key] < 0 ||
        this.limits[key] > runtimeLimits[key]
      )
        throw new RangeError('Invalid runtime metadata bounds');
    this.sections = image.sections
      .filter((section) => section.kind === 'section' && section.virtual_range.size > 0n)
      .sort((a, b) => (a.virtual_range.start.value < b.virtual_range.start.value ? -1 : 1));
    const slice = image.slices.find((candidate) => candidate.id === image.selected_slice_id);
    if (!slice) throw new TypeError('Runtime image lacks its selected slice');
    for (const header of image.headers) {
      context.checkpoint(1);
      if (header.name !== 'LC_ENCRYPTION_INFO' && header.name !== 'LC_ENCRYPTION_INFO_64') continue;
      const at = header.range.start.value;
      if (header.range.start.space !== 'file' || header.range.size < 20n)
        throw new TypeError('Invalid encryption command record');
      const offset = image.bytes.u32(at + 8n),
        size = image.bytes.u32(at + 12n),
        active = image.bytes.u32(at + 16n);
      if (active && size)
        this.encrypted.push({
          start: slice.offset + BigInt(offset),
          end: slice.offset + BigInt(offset) + BigInt(size),
        });
    }
    for (const relocation of image.relocations) {
      context.checkpoint(1);
      if (relocation.width_bits !== 64 || relocation.kind === 'relocation') continue;
      const location = image.address_map.translate(relocation.address, 'va');
      if (location.kind !== 'mapped') continue;
      const target =
        relocation.target === null
          ? null
          : image.address_map.translate(relocation.target, 'va').address.value;
      const external = relocation.symbol_id !== null,
        prior = this.fixups.get(location.address.value);
      const evidence_ids = [
        ...new Set([...(prior?.evidence_ids ?? []), ...relocation.evidence_ids]),
      ];
      if (evidence_ids.length > 1000)
        throw new RuntimeIssue(
          'resource_limit',
          'Runtime fixup evidence bound reached',
          location.address.value,
        );
      this.fixups.set(location.address.value, {
        target,
        external,
        conflicting:
          prior?.conflicting === true ||
          (prior !== undefined && (prior.target !== target || prior.external !== external)),
        evidence_ids,
      });
    }
    const remember = (map: Map<bigint, string | null>, at: bigint, name: string): void => {
      const prior = map.get(at);
      map.set(at, prior === undefined || prior === name ? name : null);
    };
    for (const imported of image.imports) {
      context.checkpoint(1);
      if (!imported.original_name) continue;
      if (imported.callable_entry) {
        const entry = image.address_map.translate(imported.callable_entry, 'va');
        if (entry.kind === 'mapped')
          remember(this.importEntries, entry.address.value, imported.original_name);
      }
      if (!imported.slot) continue;
      const location = image.address_map.translate(imported.slot, 'va');
      if (location.kind !== 'mapped') continue;
      remember(this.importSlots, location.address.value, imported.original_name);
      const prefix = ['_OBJC_CLASS_$_', '_OBJC_METACLASS_$_'].find((value) =>
        imported.original_name!.startsWith(value),
      );
      if (prefix)
        remember(
          this.externalClasses,
          location.address.value,
          imported.original_name.slice(prefix.length),
        );
    }
    this.requireFixup =
      image.headers.some((header) => header.name === 'LC_DYLD_CHAINED_FIXUPS') ||
      image.diagnostics.length !== 0;
  }

  address(value: bigint): Address {
    return { image_id: this.image.id, space: 'va', value };
  }

  plus(address: bigint, offset: bigint): bigint {
    const value = address + offset;
    if (value < 0n || value >= 1n << 64n)
      throw new RuntimeIssue('malformed_image', 'Runtime metadata address overflows', address);
    return value;
  }

  section(address: bigint, size = 1n): Section {
    this.context.checkpoint(1);
    const end = address + size;
    if (address < 0n || size <= 0n || end > 1n << 64n)
      throw new RuntimeIssue('malformed_image', 'Runtime metadata range overflows', address);
    let low = 0,
      high = this.sections.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.sections[middle]!.virtual_range.start.value <= address) low = middle + 1;
      else high = middle;
    }
    const section = this.sections[low - 1];
    if (
      !section ||
      size <= 0n ||
      end > section.virtual_range.start.value + section.virtual_range.size ||
      !section.permissions.includes('read')
    )
      throw new RuntimeIssue(
        'malformed_image',
        'Runtime metadata exceeds a readable declared section',
        address,
      );
    return section;
  }

  file(address: bigint, size: bigint): bigint {
    this.section(address, size);
    const spans = this.image.address_map.spans(this.address(address), size),
      span = spans[0];
    if (
      spans.length !== 1 ||
      span?.kind !== 'mapped' ||
      span.file_offset === null ||
      span.range.size !== size
    )
      throw new RuntimeIssue(
        'malformed_image',
        'Runtime metadata lacks contiguous file backing',
        address,
      );
    if (
      this.encrypted.some(
        (range) => span.file_offset! < range.end && range.start < span.file_offset! + size,
      )
    )
      throw new RuntimeIssue(
        'unavailable_semantics',
        'Encrypted runtime metadata is unavailable',
        address,
      );
    return span.file_offset;
  }

  u32(address: bigint): number {
    return this.image.bytes.u32(this.file(address, 4n));
  }

  u16(address: bigint): number {
    const offset = this.file(address, 2n);
    return this.image.bytes.at(Number(offset)) | (this.image.bytes.at(Number(offset + 1n)) << 8);
  }

  u64(address: bigint): bigint {
    return this.image.bytes.u64(this.file(address, 8n));
  }

  pointer(address: bigint): bigint | null {
    const offset = this.file(address, 8n);
    const fixup = this.fixups.get(address);
    if (fixup?.conflicting)
      throw new RuntimeIssue(
        'unavailable_semantics',
        'Conflicting runtime pointer fixups',
        address,
      );
    if (fixup?.external)
      throw new RuntimeIssue(
        'unavailable_semantics',
        'External runtime pointer binding has no local object bytes',
        address,
      );
    if (fixup) {
      if (fixup.target === null)
        throw new RuntimeIssue(
          'unavailable_semantics',
          'Runtime pointer fixup has no decoded target',
          address,
        );
      return fixup.target === 0n ? null : fixup.target;
    }
    const raw = this.image.bytes.u64(offset);
    if (raw === 0n) return null;
    if (this.requireFixup)
      throw new RuntimeIssue(
        'unavailable_semantics',
        'Runtime pointer has no established decoding',
        address,
      );
    return raw;
  }

  relative(address: bigint, indirectable = false): bigint | null {
    const raw = this.u32(address) | 0;
    if (raw === 0) return null;
    const indirect = indirectable && (raw & 1) !== 0;
    const target = this.plus(address, BigInt(indirectable ? raw & ~1 : raw));
    return indirect ? this.pointer(target) : target;
  }

  text(address: bigint, symbolic = false, allowEmpty = false): string {
    const section = this.section(address),
      remaining = section.virtual_range.start.value + section.virtual_range.size - address;
    const wanted =
      remaining < BigInt(this.limits.max_string_bytes + 1)
        ? remaining
        : BigInt(this.limits.max_string_bytes + 1);
    const span = this.image.address_map.spans(this.address(address), wanted)[0];
    if (span?.kind !== 'mapped' || span.file_offset === null)
      throw new RuntimeIssue('malformed_image', 'Runtime string lacks file backing', address);
    let available = Number(span.range.size);
    for (const range of this.encrypted) {
      if (span.file_offset >= range.start && span.file_offset < range.end)
        throw new RuntimeIssue(
          'unavailable_semantics',
          'Encrypted runtime string is unavailable',
          address,
        );
      if (range.start > span.file_offset && range.start - span.file_offset < BigInt(available))
        available = Number(range.start - span.file_offset);
    }
    const start = Number(span.file_offset),
      pieces: string[] = [];
    let cursor = 0,
      segment = 0;
    const decode = (begin: number, end: number): string => {
      try {
        return utf8.decode(this.image.bytes.read(span.file_offset! + BigInt(begin), end - begin));
      } catch {
        throw new RuntimeIssue('malformed_image', 'Runtime string is not valid UTF-8', address);
      }
    };
    while (cursor < available && cursor <= this.limits.max_string_bytes) {
      this.context.checkpoint(1);
      const byte = this.image.bytes.at(start + cursor);
      if (byte === 0) {
        this.stringBytes += cursor + 1;
        if (this.stringBytes > this.limits.max_total_string_bytes)
          throw new RuntimeIssue('resource_limit', 'Runtime string byte budget reached', address);
        pieces.push(decode(segment, cursor));
        const result = pieces.join('');
        if (!allowEmpty && result.length === 0)
          throw new RuntimeIssue('malformed_image', 'Empty runtime metadata name', address);
        if (result.length > 8192)
          throw new RuntimeIssue(
            'resource_limit',
            'Runtime symbolic string output bound reached',
            address,
          );
        return result;
      }
      if (symbolic && byte >= 1 && byte <= 0x1f) {
        const size = byte <= 0x17 ? 4 : 8;
        if (cursor + 1 + size > available || cursor + 1 + size > this.limits.max_string_bytes)
          throw new RuntimeIssue(
            'malformed_image',
            'Truncated Swift symbolic-reference payload',
            address,
          );
        pieces.push(decode(segment, cursor));
        let payload = '';
        for (let index = 1; index <= size; index++)
          payload += this.image.bytes
            .at(start + cursor + index)
            .toString(16)
            .padStart(2, '0');
        pieces.push(`\\x${byte.toString(16).padStart(2, '0')}{${payload}}`);
        cursor += size + 1;
        segment = cursor;
      } else {
        if (byte < 0x20 || byte === 0x7f)
          throw new RuntimeIssue(
            'malformed_image',
            'Control byte in runtime metadata name',
            address,
          );
        cursor++;
      }
    }
    throw new RuntimeIssue(
      cursor > this.limits.max_string_bytes ? 'resource_limit' : 'malformed_image',
      'Runtime string is unterminated within its bounded backing',
      address,
    );
  }

  executable(address: bigint): boolean {
    if (address % 4n !== 0n) return false;
    try {
      const section = this.section(address, 4n);
      if (
        !section.permissions.includes('execute') ||
        ((section.flags & 0x80000400n) === 0n && (section.flags & 0xffn) !== 8n)
      )
        return false;
      this.file(address, 4n);
      return !this.image.hints.some((hint) => {
        if (hint.kind !== 'data') return false;
        const start = this.image.address_map.translate(hint.range.start, 'va').address.value;
        return address < start + hint.range.size && start < address + 4n;
      });
    } catch (error) {
      if (!(error instanceof RuntimeIssue)) throw error;
      return false;
    }
  }

  count(count: bigint, address: bigint): number {
    if (count > BigInt(this.limits.max_entries))
      throw new RuntimeIssue(
        'resource_limit',
        'Runtime metadata list entry bound reached',
        address,
      );
    return Number(count);
  }

  depth(depth: number, address: bigint): void {
    if (depth > this.limits.max_depth)
      throw new RuntimeIssue('resource_limit', 'Runtime metadata traversal depth reached', address);
  }

  attempt(action: () => void): void {
    try {
      action();
    } catch (error) {
      if (!(error instanceof RuntimeIssue) || error.code === 'resource_limit') throw error;
      this.report(error);
    }
  }

  report(error: RuntimeIssue): void {
    this.partial = true;
    if (this.diagnostics.length < 256)
      this.diagnostics.push({
        code: error.code,
        severity: 'warning',
        message: error.message,
        address: this.address(error.address),
        evidence_ids: [],
      });
  }

  add(
    kind: RuntimeKind,
    name: string,
    address: bigint,
    size: bigint,
    options: {
      owner?: string;
      target?: bigint | null;
      target_role?: RuntimeRecord['target_role'];
      method_kind?: RuntimeRecord['method_kind'];
      type?: string | null;
      encoding?: RuntimeRecord['type_encoding'];
      flags?: bigint;
      ivar?: RuntimeRecord['ivar'];
      /** Linker-style symbol name for an established code target; `false`
       * publishes the record without any symbol. */
      symbol?: string | false;
    } = {},
  ): void {
    this.context.checkpoint(1);
    if (name.length > 4096 || (options.owner?.length ?? 0) > 4096)
      throw new RuntimeIssue('resource_limit', 'Qualified runtime name bound reached', address);
    const id = entityIdentity(this.image.selected_slice_id, 'runtime-record', [
      kind,
      address,
      options.owner ?? null,
      name,
    ]);
    if (this.seen.has(id)) return;
    if (this.records.length >= this.limits.max_records)
      throw new RuntimeIssue('resource_limit', 'Runtime metadata record bound reached', address);
    const section = this.section(address, size),
      binary = `evidence_${fingerprint([id, 'record-bytes'])}`,
      proof = `evidence_${fingerprint([id, this.revision, 'runtime-parser-v1'])}`;
    this.file(address, size);
    let target =
      options.target === undefined || options.target === null ? null : this.address(options.target);
    let target_role = options.target_role ?? (target ? 'metadata' : 'unresolved');
    if (target_role === 'code' && (target === null || !this.executable(target.value))) {
      this.report(
        new RuntimeIssue(
          'unavailable_semantics',
          'Runtime method implementation is not established readable ARM64 code',
          target?.value ?? address,
        ),
      );
      target = null;
      target_role = 'unresolved';
    }
    const sources = new Set([binary]);
    for (let offset = 0n; offset < size; offset += 8n) {
      this.context.checkpoint(1);
      for (const source of this.fixups.get(address + offset)?.evidence_ids ?? [])
        sources.add(source);
    }
    if (sources.size > 1000)
      throw new RuntimeIssue('resource_limit', 'Runtime record evidence bound reached', address);
    this.seen.add(id);
    this.records.push({
      id,
      kind,
      name,
      address: this.address(address),
      byte_length: size,
      owner: options.owner ?? null,
      target,
      target_role,
      method_kind: options.method_kind ?? null,
      type_name: options.type ?? null,
      type_encoding: options.encoding ?? null,
      flags: options.flags ?? null,
      ...(options.ivar ? { ivar: options.ivar } : {}),
      evidence_ids: [proof],
    });
    this.evidence.push(
      {
        id: binary,
        origin: {
          kind: 'binary',
          range: { start: this.address(address), size },
          description: 'Static runtime metadata record bytes',
        },
        claim: 'Bounded runtime metadata record in the selected image',
        derived_from: [...section.evidence_ids],
        conflicts_with: [],
        revision: this.revision,
      },
      {
        id: proof,
        origin: { kind: 'analysis', analyzer: 'macho-runtime-metadata', version: '1', rule: kind },
        claim: 'Static metadata name/reference; no instance layout or source signature inferred',
        derived_from: [...sources],
        conflicts_with: [],
        revision: this.revision,
      },
    );
    if (options.symbol === false) return;
    const code = target_role === 'code' && target !== null;
    const named = code && options.symbol !== undefined ? options.symbol : undefined;
    this.symbols.push({
      id: entityIdentity(this.image.selected_slice_id, 'runtime-symbol', id),
      original_name: named ?? name,
      display_name: named ?? (options.owner ? `${options.owner}.${name}` : name),
      kind: code ? 'function' : 'object',
      address: code ? target : this.address(address),
      size: code ? null : size,
      binding: 'local',
      evidence_ids: [proof],
    });
  }
}
