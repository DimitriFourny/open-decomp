import type { ImageTypeBinding, MemoryShape, SuppliedTypeRecord } from '../analysis/types/index.js';
import { fingerprint, type OperationContext } from '../core/index.js';
import type { LocalValidationSession } from '../reconstruction/local-validation.js';

export interface ObservedMember {
  readonly offset: bigint;
  readonly typeId: string;
  readonly bits: number;
  readonly size: bigint;
  readonly count?: bigint | null;
  /** Declared source member name (Objective-C ivar), when the record has one. */
  readonly name?: string;
}

/** Names and layouts are presentation views, never allocation/sizeof evidence. */
export class SourceStructs {
  private readonly names = new Map<string, string>();
  private readonly canonical = new Map<string, string>();
  private readonly scalars = new Map<string, string | null>();
  private readonly layouts = new Map<string, readonly ObservedMember[] | null>();
  readonly strides = new Map<string, bigint | null>();
  constructor(
    private readonly records: ReadonlyMap<string, SuppliedTypeRecord | null>,
    private readonly validation: LocalValidationSession,
    private readonly subject: string,
    private readonly context: OperationContext,
    shapes: readonly MemoryShape[] = [],
    private readonly images: ReadonlyMap<string, ImageTypeBinding> = new Map(),
  ) {
    for (const shape of shapes) {
      context.checkpoint(1 + shape.fields.length);
      const stride = shape.fields[0]?.stride;
      const valid =
        shape.base_offset === 0n &&
        stride !== null &&
        stride !== undefined &&
        stride > 0n &&
        stride <= 0x10000n &&
        shape.fields.every(
          (field) =>
            !field.dynamic &&
            field.stride === stride &&
            field.offset >= 0n &&
            field.offset + BigInt(Math.ceil(field.width_bits / 8)) <= stride,
        );
      const previous = this.strides.get(shape.type_id);
      this.strides.set(
        shape.type_id,
        valid && (previous === undefined || previous === stride) ? stride : null,
      );
    }
  }

  scalar(id: string): string | null {
    if (this.scalars.has(id)) return this.scalars.get(id)!;
    this.scalars.set(id, null);
    const record = this.records.get(id),
      type = record?.definition;
    if (record?.source !== 'analysis' || type?.kind !== 'structure' || type.fields.length === 0)
      return null;
    if (type.fields.length !== 1) {
      const element = this.scalarArray(id, type.fields, type.size);
      if (element) this.scalars.set(id, element);
      return element;
    }
    const field = type.fields[0]!;
    let target = field.type_id;
    let scalar = this.records.get(target)?.definition;
    // A proven element stride gives a scalar pointer, not a guessed array bound.
    if (scalar?.kind === 'array' && scalar.count === null) {
      target = scalar.element;
      scalar = this.records.get(target)?.definition;
    }
    if (field.offset !== 0n || !scalar || !['integer', 'float', 'pointer'].includes(scalar.kind))
      return null;
    const size = this.storage(target);
    if (!size || (type.size !== null && type.size !== size.size)) return null;
    const stride = this.strides.get(id);
    if (stride && stride !== size.size) return null;
    if (scalar.kind === 'pointer') {
      const pending = [scalar.to],
        seen = new Set<string>();
      for (let cursor = 0; cursor < pending.length; cursor++) {
        this.context.checkpoint(1);
        const next = pending[cursor]!;
        if (next === id || seen.size >= 64) return null;
        if (seen.has(next)) continue;
        seen.add(next);
        const definition = this.records.get(next)?.definition;
        if (definition?.kind === 'pointer') pending.push(definition.to);
        else if (definition?.kind === 'structure')
          for (const member of definition.fields) pending.push(member.type_id);
        else if (definition?.kind === 'array') pending.push(definition.element);
      }
    }
    if (
      !this.validation.presentation(
        'natural_scalar_pointee',
        this.subject,
        'analysis-only single scalar or proven-stride scalar array at offset zero; no object extent inferred',
        [id],
      )
    )
      return null;
    this.scalars.set(id, target);
    return target;
  }

  /** A pointee whose observed members are all one integer/float type at
   * contiguous, element-aligned offsets and that has no size or period evidence
   * is a plain scalar array (`p[k]`, `p[k + 1]`, ...); anything else (different
   * widths or kinds, gaps, a proven record stride or size) stays a structure. */
  private scalarArray(
    id: string,
    fields: Extract<SuppliedTypeRecord['definition'], { kind: 'structure' }>['fields'],
    size: bigint | null,
  ): string | null {
    if (size !== null || this.strides.get(id) || fields.length > 64) return null;
    let element: { id: string; key: string; size: bigint } | undefined;
    const offsets = new Set<bigint>();
    for (const field of fields) {
      this.context.checkpoint(1);
      let target = field.type_id;
      let scalar = this.records.get(target)?.definition;
      if (scalar?.kind === 'array') {
        if (scalar.count !== null) return null;
        target = scalar.element;
        scalar = this.records.get(target)?.definition;
      }
      if (
        (scalar?.kind !== 'integer' && scalar?.kind !== 'float') ||
        scalar.bits > 64 ||
        this.records.get(target)?.source !== 'analysis'
      )
        return null;
      const storage = this.storage(target);
      if (!storage || field.offset < 0n || field.offset % storage.size !== 0n) return null;
      const key = this.key(target);
      element ??= { id: target, key, size: storage.size };
      if (key !== element.key) return null;
      offsets.add(field.offset);
    }
    if (!element || offsets.size < 2) return null;
    const sorted = [...offsets].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let index = 1; index < sorted.length; index++)
      if (sorted[index]! - sorted[index - 1]! !== element.size) return null;
    return this.validation.presentation(
      'scalar_array_pointee',
      this.subject,
      'analysis-only members of one scalar type at contiguous element-aligned offsets with no size or record-stride evidence; subscripts address the same bytes, no object extent inferred',
      [id],
    )
      ? element.id
      : null;
  }

  private key(id: string, active = new Map<string, number>()): string {
    this.context.checkpoint(1);
    if (active.has(id)) return `recursive:${active.get(id)}`;
    if (active.size >= 32) return `opaque:${id}`;
    const type = this.records.get(id)?.definition;
    if (!type) return `opaque:${id}`;
    active.set(id, active.size);
    let result: string;
    switch (type.kind) {
      case 'integer':
        result = `i${type.bits}:${type.signed}`;
        break;
      case 'float':
        result = `f${type.bits}`;
        break;
      case 'pointer':
        result = `p${type.bits}:${this.key(type.to, active)}`;
        break;
      case 'array':
        result = `a${type.count}:${this.key(type.element, active)}`;
        break;
      case 'structure':
        result = `s${type.size}:${type.alignment}:${this.strides.get(id) ?? ''}:${type.fields
          .map((field) => `${field.offset}:${this.key(field.type_id, active)}`)
          .sort()
          .join(';')}`;
        break;
      default:
        result = `opaque:${id}`;
    }
    active.delete(id);
    return result;
  }

  /** Image-wide identity of a merged structure type, if recovered. */
  image(id: string): ImageTypeBinding | undefined {
    return this.images.get(id);
  }

  /** A declared tag (an Objective-C class) names its structure; image-wide names
   * come from merged image types; any other structure is named by a digest of
   * its layout, never by a per-function ordinal, so one name never denotes two
   * different layouts. */
  name(id: string): string {
    const previous = this.names.get(id);
    if (previous) return previous;
    const record = this.records.get(id);
    const tag =
      record?.definition.kind === 'structure' && record.spelling && /^[A-Za-z_$][\w$]*$/.test(record.spelling)
        ? record.spelling
        : undefined;
    const image = this.images.get(id)?.name;
    const key = record?.source === 'analysis' ? this.key(id) : `declared:${id}`;
    let name = tag ?? image ?? this.canonical.get(key);
    if (!name) {
      name = `struct_${fingerprint(key).slice(0, 6)}`;
      this.canonical.set(key, name);
    }
    this.names.set(id, name);
    return name;
  }

  private storage(id: string): { size: bigint; bits: number } | null {
    const record = this.records.get(id),
      type = record?.definition;
    if (
      !record ||
      !type ||
      (record.status !== 'established' &&
        record.status !== 'asserted' &&
        !(record.source === 'analysis' && record.status === 'candidate'))
    )
      return null;
    if (
      (type.kind === 'integer' && [8, 16, 32, 64, 128].includes(type.bits)) ||
      (type.kind === 'float' && [32, 64].includes(type.bits)) ||
      (type.kind === 'pointer' && type.bits === 64)
    )
      return { size: BigInt(type.bits / 8), bits: type.bits };
    return null;
  }

  layout(id: string): readonly ObservedMember[] | null {
    if (this.layouts.has(id)) return this.layouts.get(id)!;
    this.layouts.set(id, null);
    const record = this.records.get(id),
      type = record?.definition;
    if (
      !record ||
      (record.status !== 'established' &&
        record.status !== 'asserted' &&
        !(record.source === 'analysis' && record.status === 'candidate')) ||
      type?.kind !== 'structure' ||
      type.fields.length === 0 ||
      type.fields.length > 64 ||
      this.scalar(id)
    )
      return null;
    const members: ObservedMember[] = [];
    let end = 0n;
    const fields = [...type.fields].sort((a, b) =>
      a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0,
    );
    for (const [index, field] of fields.entries()) {
      this.context.checkpoint(1);
      const definition = this.records.get(field.type_id)?.definition;
      const array = definition?.kind === 'array' ? definition : undefined;
      const typeId = array?.element ?? field.type_id;
      const storage = this.storage(typeId);
      if (!storage || field.offset < 0n || field.offset > 0x10000n) return null;
      const count = array?.count;
      if (count === null && (index !== fields.length - 1 || field.offset === 0n)) return null;
      const size = storage.size * (count ?? 1n);
      const previous = members.at(-1);
      if (
        previous?.offset === field.offset &&
        previous.typeId === typeId &&
        previous.count === count
      )
        continue;
      if (field.offset < end || size <= 0n || field.offset + size > 0x10000n) return null;
      members.push({
        offset: field.offset,
        typeId,
        bits: storage.bits,
        size,
        ...(array ? { count: array.count } : {}),
        ...(record.member_names && /^[A-Za-z_$][\w$]*$/.test(field.name) ? { name: field.name } : {}),
      });
      end = field.offset + size;
    }
    const stride = this.strides.get(id);
    if (stride && (end > stride || members.some((member) => member.count !== undefined)))
      return null;
    if (
      !this.validation.presentation(
        'observed_struct_layout',
        this.subject,
        'nonoverlapping observed typed members with explicit byte gaps; no object size or array bound inferred',
        [id],
      )
    )
      return null;
    this.validation.requireAbi(
      'observed_struct_layout',
      [this.subject, id],
      'Observed member declarations use target scalar widths and packed byte offsets; their C sizeof is not evidence of an allocation extent.',
    );
    this.layouts.set(id, members);
    return members;
  }
}
