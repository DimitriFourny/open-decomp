import {
  fingerprint,
  type AbiType,
  type CanonicalValue,
  type DataLayout,
  type RecoveredType,
} from '../../core/index.js';
import type { AnalysisBudget } from '../ssa/budget.js';
import type { SuppliedTypeRecord } from './model.js';

/** Definitions contain only canonical core fields, never arbitrary metadata. */
export function typeKey(type: RecoveredType): string {
  return fingerprint(type as unknown as CanonicalValue);
}

/** Resolves source graphs without following pointer targets. Recursive pointers are
 * ordinary; cyclic by-value graphs, missing layouts and conflicting definitions
 * remain unknown. No alignment is inferred for structures or opaque objects. */
export class SourceLayouts {
  constructor(
    readonly records: Map<string, SuppliedTypeRecord[]>,
    readonly budget: AnalysisBudget,
    readonly layout: DataLayout,
  ) {}

  definition(id: string, established = false): RecoveredType | null {
    const all = this.records.get(id) ?? [];
    this.budget.charge(all.length + 1);
    let definition: RecoveredType | null = null,
      key: string | null = null;
    for (const record of all) {
      if (established && record.status !== 'established' && record.status !== 'asserted') continue;
      this.budget.charge(
        record.definition.kind === 'structure' ? record.definition.fields.length + 1 : 1,
      );
      const candidate = typeKey(record.definition);
      if (key !== null && candidate !== key) return null;
      key = candidate;
      definition = record.definition;
    }
    return definition;
  }

  size(id: string, active = new Set<string>()): bigint | null {
    this.budget.charge();
    if (active.has(id) || active.size >= 64) return null;
    const type = this.definition(id);
    if (!type) return null;
    if (type.kind === 'void') return 0n;
    if (type.kind === 'float' && type.bits === 80)
      return this.layout.long_double_bits === 80
        ? BigInt(this.layout.long_double_storage_bits / 8)
        : null;
    if (type.kind === 'integer' || type.kind === 'float' || type.kind === 'pointer')
      return type.bits % 8 === 0 ? BigInt(type.bits / 8) : null;
    if (type.kind === 'unknown' || type.kind === 'structure') return type.size;
    active.add(id);
    const element = this.size(type.element, active);
    active.delete(id);
    const count = type.kind === 'array' ? type.count : BigInt(type.lanes);
    if (element === null || count === null || element * count > 0xffff_ffff_ffff_ffffn) return null;
    return element * count;
  }

  /** Exact-width field views, including nested structures/arrays. Multiple
   * matching members remain alternatives; a cycle cannot recurse indefinitely. */
  fields(id: string, offset: bigint, width: number, active = new Set<string>()): string[] {
    this.budget.charge();
    if (offset < 0n || active.has(id) || active.size >= 64) return [];
    const type = this.definition(id);
    if (!type) return [];
    const size = this.size(id);
    if (offset === 0n && size !== null && size * 8n === BigInt(width) && type.kind !== 'unknown')
      return [id];
    active.add(id);
    const result: string[] = [];
    if (type.kind === 'structure')
      for (const field of type.fields) {
        this.budget.charge();
        if (offset >= field.offset)
          result.push(...this.fields(field.type_id, offset - field.offset, width, active));
      }
    else if (type.kind === 'array' || type.kind === 'vector') {
      const elementSize = this.size(type.element);
      const count = type.kind === 'array' ? type.count : BigInt(type.lanes);
      if (
        elementSize !== null &&
        elementSize > 0n &&
        (count === null || offset / elementSize < count)
      )
        result.push(...this.fields(type.element, offset % elementSize, width, active));
    }
    active.delete(id);
    return result;
  }

  abi(id: string, active = new Set<string>()): AbiType {
    this.budget.charge();
    if (active.has(id) || active.size >= 64) return { kind: 'unknown', size: null };
    const type = this.definition(id, true);
    if (!type) return { kind: 'unknown', size: null };
    switch (type.kind) {
      case 'void':
      case 'integer':
        return type;
      case 'float':
        return { kind: 'float', bits: type.bits };
      case 'pointer':
        return { kind: 'pointer' };
      case 'unknown':
        return type;
      case 'vector': {
        const element = this.definition(type.element, true);
        return element?.kind === 'integer' || element?.kind === 'float'
          ? { kind: 'vector', element: element.kind, element_bits: element.bits, lanes: type.lanes }
          : { kind: 'unknown', size: this.size(id) };
      }
      case 'array':
        // An array declaration is preserved, but parameter adjustment and ABI
        // aggregate alignment require an explicit source-language declaration.
        return { kind: 'unknown', size: this.size(id) };
      case 'structure': {
        if (type.size === null || type.alignment === null)
          return { kind: 'unknown', size: type.size };
        active.add(id);
        const fields: { offset: bigint; type: AbiType }[] = [];
        for (const field of type.fields) {
          this.budget.charge();
          const size = this.size(field.type_id);
          const resolved = this.abi(field.type_id, active);
          if (resolved.kind === 'unknown' || size === null || field.offset + size > type.size) {
            active.delete(id);
            return { kind: 'unknown', size: type.size };
          }
          fields.push({ offset: field.offset, type: resolved });
        }
        active.delete(id);
        return { kind: 'aggregate', size: type.size, alignment: type.alignment, fields };
      }
    }
  }
}
