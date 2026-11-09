import type { DebugSignature, DebugSignatureType, DebugType } from '../dwarf/index.js';
import { PDB_LIMITS, PdbReader } from './msf.js';

/** CodeView type leaves this reader interprets (TPI). */
const LF = {
  MODIFIER: 0x1001,
  POINTER: 0x1002,
  PROCEDURE: 0x1008,
  MFUNCTION: 0x1009,
  ARGLIST: 0x1201,
  FIELDLIST: 0x1203,
  BITFIELD: 0x1205,
  BCLASS: 0x1400,
  VBCLASS: 0x1401,
  IVBCLASS: 0x1402,
  INDEX: 0x1404,
  VFUNCTAB: 0x1409,
  ENUMERATE: 0x1502,
  ARRAY: 0x1503,
  CLASS: 0x1504,
  STRUCTURE: 0x1505,
  UNION: 0x1506,
  ENUM: 0x1507,
  MEMBER: 0x150d,
  STMEMBER: 0x150e,
  METHOD: 0x150f,
  NESTTYPE: 0x1510,
  ONEMETHOD: 0x1511,
  INTERFACE: 0x1519,
  FUNC_ID: 0x1601,
  MFUNC_ID: 0x1602,
} as const;
const FORWARD_REFERENCE = 0x80,
  UNIQUE_NAME = 0x200;

/** Built-in (simple) types below 0x1000: [C name, byte size, DW_ATE encoding]. */
const SIMPLE: Record<number, readonly [string, number, number]> = {
  0x08: ['HRESULT', 4, 5],
  0x10: ['signed char', 1, 6],
  0x20: ['unsigned char', 1, 8],
  0x70: ['char', 1, 6],
  0x71: ['wchar_t', 2, 7],
  0x7a: ['char16_t', 2, 0x10],
  0x7b: ['char32_t', 4, 0x10],
  0x7c: ['char8_t', 1, 8],
  0x68: ['__int8', 1, 5],
  0x69: ['unsigned __int8', 1, 7],
  0x11: ['short', 2, 5],
  0x21: ['unsigned short', 2, 7],
  0x72: ['short', 2, 5],
  0x73: ['unsigned short', 2, 7],
  0x12: ['long', 4, 5],
  0x22: ['unsigned long', 4, 7],
  0x74: ['int', 4, 5],
  0x75: ['unsigned int', 4, 7],
  0x13: ['long long', 8, 5],
  0x23: ['unsigned long long', 8, 7],
  0x76: ['__int64', 8, 5],
  0x77: ['unsigned __int64', 8, 7],
  0x14: ['__int128', 16, 5],
  0x24: ['unsigned __int128', 16, 7],
  0x78: ['__int128', 16, 5],
  0x79: ['unsigned __int128', 16, 7],
  0x46: ['_Float16', 2, 4],
  0x40: ['float', 4, 4],
  0x41: ['double', 8, 4],
  0x42: ['long double', 10, 4],
  0x43: ['__float128', 16, 4],
  0x30: ['bool', 1, 2],
  0x31: ['__bool16', 2, 2],
  0x32: ['__bool32', 4, 2],
  0x33: ['__bool64', 8, 2],
};
/** Simple-type pointer modes: byte size of the pointer, when established. */
const SIMPLE_POINTER_SIZE: Record<number, number> = { 4: 4, 5: 4, 6: 8 };

interface Leaf {
  readonly kind: number;
  /** The record's bytes after its kind. */
  readonly body: Uint8Array;
}
interface Composite {
  readonly kind: number;
  readonly property: number;
  readonly fields: number;
  readonly size: bigint | null;
  readonly underlying: number;
  readonly name: string;
  readonly unique: string | null;
}
interface Member {
  readonly name: string;
  readonly type: number;
  readonly offset: bigint;
  readonly bits?: { readonly size: number; readonly position: number };
}

/** A TPI or IPI stream: header and the offset of each record by type index. */
export class TypeStream {
  readonly begin: number;
  readonly #leaves: Leaf[] = [];
  constructor(bytes: Uint8Array, spend: () => void) {
    const r = new PdbReader(bytes);
    r.u32(); // version
    const headerSize = r.u32();
    this.begin = r.u32();
    const end = r.u32(),
      recordBytes = r.u32();
    if (this.begin < 0x1000 || end < this.begin || end - this.begin > PDB_LIMITS.typeRecords)
      throw new Error('Invalid PDB type index range');
    r.position = headerSize;
    r.need(recordBytes);
    const limit = r.position + recordBytes;
    while (r.position < limit && this.#leaves.length < end - this.begin) {
      spend();
      const length = r.u16();
      if (length < 2 || r.position + length > limit) throw new Error('Truncated type record');
      const kind = r.u16();
      this.#leaves.push({ kind, body: r.block(length - 2) });
    }
    if (this.#leaves.length !== end - this.begin)
      throw new Error('PDB type stream holds fewer records than its index range');
  }

  get count(): number {
    return this.#leaves.length;
  }

  leaf(index: number): Leaf | undefined {
    return index >= this.begin ? this.#leaves[index - this.begin] : undefined;
  }
}

/** Skips LF_PAD bytes after a field-list member. */
function align(r: PdbReader): void {
  if (r.position < r.end) {
    const pad = r.bytes[r.position]!;
    if (pad > 0xf0) r.skip(Math.min(pad & 0x0f, r.end - r.position));
  }
}

/**
 * TPI types as debug types: forward references resolve to the definition with the same
 * unique name (else name); a const-volatile modifier is two qualifier records; a bitfield
 * member keeps its bit size and position (so its structure stays unrepresentable, as with
 * DWARF). Type IDs are `t<hex index>`. Only types reached from the TPI's own definitions
 * and the symbols' references are emitted. Names are display-only C declarators.
 */
export class PdbTypes {
  readonly #definitions = new Map<string, number>();
  readonly #emitted = new Map<string, DebugType>();
  readonly #pending: number[] = [];
  readonly #composites = new Map<number, Composite | null>();
  readonly diagnostics: string[] = [];

  constructor(
    readonly tpi: TypeStream | null,
    readonly spend: () => void,
  ) {
    if (!tpi) return;
    for (let index = tpi.begin; index < tpi.begin + tpi.count; index++) {
      spend();
      const record = this.#composite(index);
      if (record && !(record.property & FORWARD_REFERENCE)) {
        const key = this.#key(record);
        if (!this.#definitions.has(key)) this.#definitions.set(key, index);
      }
    }
  }

  #diagnose(message: string): void {
    if (this.diagnostics.length < 1000 && !this.diagnostics.includes(message))
      this.diagnostics.push(message);
  }

  #key(record: Composite): string {
    const group = record.kind === LF.UNION ? 'u' : record.kind === LF.ENUM ? 'e' : 's';
    return `${group}:${record.unique ?? record.name}`;
  }

  #composite(index: number): Composite | null {
    if (this.#composites.has(index)) return this.#composites.get(index)!;
    const record = this.#readComposite(index);
    this.#composites.set(index, record);
    return record;
  }

  #readComposite(index: number): Composite | null {
    const leaf = this.tpi?.leaf(index);
    if (
      !leaf ||
      ![LF.CLASS, LF.STRUCTURE, LF.INTERFACE, LF.UNION, LF.ENUM].includes(leaf.kind as never)
    )
      return null;
    try {
      const r = new PdbReader(leaf.body);
      r.u16(); // member count
      const property = r.u16();
      let fields: number,
        size: bigint | null = null,
        underlying = 0;
      if (leaf.kind === LF.ENUM) {
        underlying = r.u32();
        fields = r.u32();
      } else {
        fields = r.u32();
        if (leaf.kind !== LF.UNION) r.skip(8); // derivation list, vtable shape
        size = r.numeric();
      }
      const name = r.string();
      const unique = property & UNIQUE_NAME && r.position < r.end ? r.string() : null;
      return { kind: leaf.kind, property, fields, size, underlying, name, unique };
    } catch (error) {
      this.#diagnose(`Type 0x${index.toString(16)}: ${String(error)}`);
      return null;
    }
  }

  /** The definition a forward reference names, or the index itself. */
  resolve(index: number): number {
    const record = this.#composite(index);
    if (!record || !(record.property & FORWARD_REFERENCE)) return index;
    return this.#definitions.get(this.#key(record)) ?? index;
  }

  /** Debug type ID of `index`, scheduling its record; undefined for void/no type. */
  id(index: number): string | undefined {
    // A pointer to void (a simple type with a pointer mode) is a type; void itself is not.
    if (index < 0x1000 && !((index >> 8) & 0xf) && [0x00, 0x03].includes(index & 0xff))
      return undefined;
    const resolved = this.resolve(index);
    const id = `t${resolved.toString(16)}`;
    if (!this.#emitted.has(id)) {
      this.#emitted.set(id, { id, name: '', kind: 'unknown', detail: '' });
      this.#pending.push(resolved);
    }
    return id;
  }

  /** The types referenced so far (by symbols, typedefs and other types), described. */
  types(): DebugType[] {
    while (this.#pending.length) {
      this.spend();
      const index = this.#pending.pop()!;
      try {
        for (const type of this.#describe(index)) this.#emitted.set(type.id, type);
      } catch (error) {
        this.#diagnose(`Type 0x${index.toString(16)}: ${String(error)}`);
      }
    }
    return [...this.#emitted.values()];
  }

  /** A typedef (S_UDT) naming `index`. */
  typedef(name: string, index: number, ordinal: number): DebugType | null {
    const target = this.id(index);
    if (!target) return null;
    return {
      id: `udt${ordinal}`,
      name,
      kind: 'typedef',
      detail: `typedef ${this.declaration(index, name)}`,
      targetTypeId: target,
    };
  }

  #describe(index: number): DebugType[] {
    const id = `t${index.toString(16)}`;
    if (index < 0x1000) {
      const mode = (index >> 8) & 0xf;
      if (mode)
        return [
          {
            id,
            name: this.declaration(index),
            kind: 'pointer',
            byteSize: SIMPLE_POINTER_SIZE[mode],
            detail: this.declaration(index),
            targetTypeId: this.id(index & 0xff),
          },
        ];
      const simple = SIMPLE[index];
      const name = simple?.[0] ?? `<simple type 0x${index.toString(16)}>`;
      return [
        {
          id,
          name,
          kind: 'base',
          byteSize: simple?.[1],
          encoding: simple?.[2],
          detail: `${name}; encoding ${simple?.[2] ?? 'unspecified'}`,
        },
      ];
    }
    const leaf = this.tpi?.leaf(index);
    if (!leaf) throw new Error('type index outside the TPI stream');
    const r = new PdbReader(leaf.body);
    const name = this.declaration(index);
    switch (leaf.kind) {
      case LF.MODIFIER: {
        const target = r.u32(),
          modifiers = r.u16();
        const qualifiers = [
          ...(modifiers & 1 ? ['const'] : []),
          ...(modifiers & 2 ? ['volatile'] : []),
        ];
        if (!qualifiers.length)
          return [{ id, name, kind: 'typedef', detail: name, targetTypeId: this.id(target) }];
        // const volatile T: a const record qualifying a volatile one.
        return qualifiers.map((qualifier, n) => ({
          id: n ? `${id}:${qualifier}` : id,
          name: n ? `volatile ${this.declaration(target)}` : name,
          kind: qualifier,
          detail: name,
          targetTypeId: n || qualifiers.length === 1 ? this.id(target) : `${id}:volatile`,
        }));
      }
      case LF.POINTER: {
        const target = r.u32(),
          attributes = r.u32();
        const mode = (attributes >> 5) & 7;
        return [
          {
            id,
            name,
            kind:
              mode === 0
                ? 'pointer'
                : mode === 1
                  ? 'reference'
                  : mode === 4
                    ? 'rvalue-reference'
                    : 'pointer-to-member',
            byteSize: (attributes >> 13) & 0x3f || undefined,
            detail: name,
            targetTypeId: this.id(target),
          },
        ];
      }
      case LF.PROCEDURE:
      case LF.MFUNCTION:
        return [{ id, name, kind: 'subroutine', detail: name, targetTypeId: this.id(r.u32()) }];
      case LF.ARRAY: {
        const element = r.u32();
        r.u32(); // index type
        const size = r.numeric();
        const elementSize = this.size(element);
        const count = elementSize ? size / BigInt(elementSize) : null;
        return [
          {
            id,
            name,
            kind: 'array',
            byteSize: Number(size),
            detail: name,
            targetTypeId: this.id(element),
            dimensions: [count],
            elementCount: count === null ? undefined : Number(count),
          },
        ];
      }
      case LF.ENUM: {
        const record = this.#composite(index)!;
        const values = this.#fieldList(record.fields).enumerators;
        return [
          {
            id,
            name,
            kind: 'enum',
            byteSize: this.size(record.underlying),
            detail: `enum ${name} { ${values.map(([key, value]) => `${key} = ${value}`).join(', ')} }`,
            targetTypeId: this.id(record.underlying),
          },
        ];
      }
      default: {
        const record = this.#composite(index);
        if (!record) return [{ id, name, kind: 'unknown', detail: name }];
        const kind =
          record.kind === LF.UNION ? 'union' : record.kind === LF.STRUCTURE ? 'struct' : 'class';
        // An unresolved forward reference is a declaration without a layout.
        if (record.property & FORWARD_REFERENCE) return [{ id, name, kind, detail: name }];
        const list = this.#fieldList(record.fields);
        const members: NonNullable<DebugType['members']> = list.members.map((member) => ({
          name: member.name,
          typeId: this.id(member.type),
          byteOffset: Number(member.offset),
          bitSize: member.bits?.size,
          bitOffset: member.bits?.position,
        }));
        // An undecoded field list makes the structure unrepresentable, never smaller.
        if (list.undecoded) members.push({ name: '<undecoded fields>' });
        return [
          {
            id,
            name,
            kind,
            byteSize: record.size === null ? undefined : Number(record.size),
            detail: `${kind} ${name} { ${list.members
              .map(
                (member) =>
                  `${this.declaration(member.type, member.name)}${member.bits ? ` : ${member.bits.size}` : ''} @ +${member.offset}${member.bits ? ` bit ${member.bits.position}` : ''}`,
              )
              .join('; ')} }`,
            members,
          },
        ];
      }
    }
  }

  /** Data members and enumerators of a field list (following LF_INDEX continuations).
   * Base classes, methods, static members and nested types are not data members here. */
  #fieldList(index: number): {
    members: Member[];
    enumerators: [string, bigint][];
    undecoded: boolean;
  } {
    const members: Member[] = [],
      enumerators: [string, bigint][] = [];
    const seen = new Set<number>();
    let next: number | null = index;
    try {
      while (next !== null) {
        const leaf: Leaf | undefined = this.tpi?.leaf(next);
        if (!leaf || leaf.kind !== LF.FIELDLIST || seen.has(next) || seen.size > PDB_LIMITS.depth)
          throw new Error('invalid field list reference');
        seen.add(next);
        next = null;
        const r: PdbReader = new PdbReader(leaf.body);
        while (r.position < r.end) {
          this.spend();
          const kind = r.u16();
          switch (kind) {
            case LF.MEMBER: {
              r.u16();
              let type = r.u32();
              const offset = r.numeric(),
                name = r.string();
              const bitfield = this.tpi?.leaf(type);
              let bits: Member['bits'];
              if (bitfield?.kind === LF.BITFIELD) {
                const b = new PdbReader(bitfield.body);
                type = b.u32();
                bits = { size: b.u8(), position: b.u8() };
              }
              members.push({ name, type, offset, ...(bits ? { bits } : {}) });
              break;
            }
            case LF.ENUMERATE: {
              r.u16();
              const value = r.numeric();
              enumerators.push([r.string(), value]);
              break;
            }
            case LF.BCLASS:
              r.skip(6);
              r.numeric();
              break;
            case LF.VBCLASS:
            case LF.IVBCLASS:
              r.skip(10);
              r.numeric();
              r.numeric();
              break;
            case LF.STMEMBER:
              r.skip(6);
              r.string();
              break;
            case LF.METHOD:
              r.skip(6);
              r.string();
              break;
            case LF.NESTTYPE:
              r.skip(6);
              r.string();
              break;
            case LF.VFUNCTAB:
              r.skip(6);
              break;
            case LF.ONEMETHOD: {
              const attributes = r.u16();
              r.u32();
              // Introducing virtual methods carry their vtable offset.
              if ([4, 6].includes((attributes >> 2) & 7)) r.u32();
              r.string();
              break;
            }
            case LF.INDEX:
              r.u16();
              next = r.u32();
              break;
            default:
              throw new Error(`unsupported field list member 0x${kind.toString(16)}`);
          }
          align(r);
        }
      }
    } catch (error) {
      this.#diagnose(`Field list 0x${index.toString(16)}: ${String(error)}`);
      return { members, enumerators, undecoded: true };
    }
    return { members, enumerators, undecoded: false };
  }

  /** Byte size of `index` when established. */
  size(index: number, depth = 0): number | undefined {
    if (depth > PDB_LIMITS.depth) return undefined;
    if (index < 0x1000) {
      const mode = (index >> 8) & 0xf;
      return mode ? SIMPLE_POINTER_SIZE[mode] : SIMPLE[index]?.[1];
    }
    index = this.resolve(index);
    const leaf = this.tpi?.leaf(index);
    if (!leaf) return undefined;
    try {
      const r = new PdbReader(leaf.body);
      switch (leaf.kind) {
        case LF.MODIFIER:
          return this.size(r.u32(), depth + 1);
        case LF.POINTER:
          r.u32();
          return (r.u32() >> 13) & 0x3f || undefined;
        case LF.ARRAY:
          r.skip(8);
          return Number(r.numeric());
        case LF.ENUM:
          return this.size(this.#composite(index)!.underlying, depth + 1);
        default: {
          const record = this.#composite(index);
          return record?.size === null || !record ? undefined : Number(record.size);
        }
      }
    } catch {
      return undefined;
    }
  }

  /** Argument types of an LF_ARGLIST; a trailing "no type" marks a variadic list. */
  #arguments(index: number): { types: number[]; variadic: boolean } {
    const leaf = this.tpi?.leaf(index);
    if (leaf?.kind !== LF.ARGLIST) throw new Error('invalid argument list reference');
    const r = new PdbReader(leaf.body);
    const count = r.u32();
    r.need(count * 4);
    const types: number[] = [];
    for (let i = 0; i < count; i++) types.push(r.u32());
    const variadic = types.length > 0 && types[types.length - 1] === 0;
    if (variadic) types.pop();
    return { types, variadic };
  }

  /** The procedure type `index` as a source contract: its return type, its parameters
   * (`this` first for an instance method) and its calling convention. On x64 the near C,
   * fastcall, stdcall and thiscall conventions are all the one Microsoft x64 convention. */
  procedure(index: number): {
    readonly signature: DebugSignature;
    readonly parameters: readonly number[];
    readonly returns: number;
  } | null {
    const leaf = this.tpi?.leaf(index);
    if (!leaf || (leaf.kind !== LF.PROCEDURE && leaf.kind !== LF.MFUNCTION)) return null;
    const r = new PdbReader(leaf.body);
    const returns = r.u32();
    let self = 0;
    if (leaf.kind === LF.MFUNCTION) {
      r.u32(); // class
      self = r.u32();
    }
    const convention = r.u8();
    r.u8();
    r.u16();
    const list = this.#arguments(r.u32());
    const parameters = self ? [self, ...list.types] : list.types;
    return {
      returns,
      parameters,
      signature: {
        returnType: this.signatureType(returns, false),
        parameters: parameters.map((type) => ({ type: this.signatureType(type, true) })),
        variadic: list.variadic,
        callingConvention: [0x00, 0x04, 0x07, 0x0b].includes(convention)
          ? undefined
          : 0x100 + convention,
        prototyped: true,
        definition: true,
      },
    };
  }

  signatureType(index: number, parameter: boolean): DebugSignatureType {
    const typeId = this.id(index);
    if (!typeId)
      return { name: parameter ? '<missing type>' : 'void', kind: parameter ? 'unknown' : 'void' };
    let current = this.resolve(index);
    for (let depth = 0; depth < PDB_LIMITS.depth; depth++) {
      const leaf = current >= 0x1000 ? this.tpi?.leaf(current) : undefined;
      if (leaf?.kind !== LF.MODIFIER) break;
      current = this.resolve(new PdbReader(leaf.body).u32());
    }
    const leaf = current >= 0x1000 ? this.tpi?.leaf(current) : undefined;
    const kind =
      current < 0x1000
        ? (current >> 8) & 0xf
          ? 'pointer'
          : 'base'
        : leaf?.kind === LF.POINTER
          ? 'pointer'
          : leaf?.kind === LF.ARRAY
            ? 'array'
            : leaf?.kind === LF.ENUM
              ? 'enum'
              : leaf?.kind === LF.UNION
                ? 'union'
                : leaf?.kind === LF.STRUCTURE
                  ? 'struct'
                  : leaf?.kind === LF.CLASS || leaf?.kind === LF.INTERFACE
                    ? 'class'
                    : 'unknown';
    return {
      typeId,
      name: this.declaration(index),
      kind,
      byteSize: this.size(current),
      encoding: current < 0x1000 ? SIMPLE[current]?.[2] : undefined,
    };
  }

  /** A C declaration of `index` around `declarator` (display only). */
  declaration(
    index: number,
    declarator = '',
    qualifiers: readonly string[] = [],
    indirect = false,
    depth = 0,
  ): string {
    const finish = (base: string) =>
      `${qualifiers.length ? `${qualifiers.join(' ')} ` : ''}${base}${declarator ? `${declarator.startsWith('[') ? '' : ' '}${declarator}` : ''}`;
    if (depth > PDB_LIMITS.depth) return finish('<recursive type>');
    if (index < 0x1000) {
      const mode = (index >> 8) & 0xf;
      if (mode) {
        const qualified = qualifiers.length
          ? ` ${qualifiers.join(' ')}${declarator ? ' ' : ''}`
          : '';
        return this.declaration(index & 0xff, `*${qualified}${declarator}`, [], true, depth + 1);
      }
      if ((index & 0xff) === 0x03 || index === 0) return finish('void');
      return finish(SIMPLE[index]?.[0] ?? `<simple type 0x${index.toString(16)}>`);
    }
    index = this.resolve(index);
    const leaf = this.tpi?.leaf(index);
    if (!leaf) return finish(`<type 0x${index.toString(16)}>`);
    try {
      const r = new PdbReader(leaf.body);
      switch (leaf.kind) {
        case LF.MODIFIER: {
          const target = r.u32(),
            modifiers = r.u16();
          return this.declaration(
            target,
            declarator,
            [
              ...qualifiers,
              ...(modifiers & 1 ? ['const'] : []),
              ...(modifiers & 2 ? ['volatile'] : []),
            ],
            indirect,
            depth + 1,
          );
        }
        case LF.POINTER: {
          const target = r.u32(),
            attributes = r.u32(),
            mode = (attributes >> 5) & 7;
          const operator = mode === 1 ? '&' : mode === 4 ? '&&' : '*';
          const own = [
            ...qualifiers,
            ...(attributes & 0x400 ? ['const'] : []),
            ...(attributes & 0x200 ? ['volatile'] : []),
          ];
          const qualified = own.length ? ` ${own.join(' ')}${declarator ? ' ' : ''}` : '';
          return this.declaration(
            target,
            `${operator}${qualified}${declarator}`,
            [],
            true,
            depth + 1,
          );
        }
        case LF.ARRAY: {
          const element = r.u32();
          r.u32();
          const size = r.numeric(),
            elementSize = this.size(element);
          const count = elementSize ? `${size / BigInt(elementSize)}` : '?';
          return this.declaration(
            element,
            `${indirect ? `(${declarator})` : declarator}[${count}]`,
            qualifiers,
            false,
            depth + 1,
          );
        }
        case LF.PROCEDURE:
        case LF.MFUNCTION: {
          const procedure = this.procedure(index)!;
          const parameters = procedure.parameters.map((type) =>
            this.declaration(type, '', [], false, depth + 1),
          );
          if (procedure.signature.variadic) parameters.push('...');
          return this.declaration(
            procedure.returns,
            `${indirect ? `(${declarator})` : declarator}(${parameters.join(', ') || 'void'})`,
            [],
            false,
            depth + 1,
          );
        }
        default: {
          const record = this.#composite(index);
          return finish(record ? record.name : `<type 0x${index.toString(16)}>`);
        }
      }
    } catch (error) {
      this.#diagnose(`Type 0x${index.toString(16)}: ${String(error)}`);
      return finish(`<type 0x${index.toString(16)}>`);
    }
  }
}

/** IPI function ids (LF_FUNC_ID / LF_MFUNC_ID) to the TPI procedure type they name. */
export function functionIdType(ipi: TypeStream | null, id: number): number | null {
  const leaf = ipi?.leaf(id);
  if (!leaf || (leaf.kind !== LF.FUNC_ID && leaf.kind !== LF.MFUNC_ID)) return null;
  const r = new PdbReader(leaf.body);
  r.u32();
  return r.u32();
}
