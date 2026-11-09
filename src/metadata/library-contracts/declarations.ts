import type { AbiProfile } from '../../core/index.js';
import {
  libraryRecord,
  libraryRecordNames,
  type FieldSpec,
  type LibraryRecord,
} from './generated/types/index.js';

type AbiId = AbiProfile['id'];

/** One bundled library type of an ABI: a header record or a typedef naming one. */
export interface LibraryTypeEntry {
  readonly name: string;
  /** The record it denotes (`struct _IO_FILE` for `FILE`). */
  readonly record: string;
  readonly kind: 'struct' | 'union';
  readonly size: number | null;
  /** Declaring header relative to its include root (`bits/struct_stat.h`). */
  readonly header: string;
  readonly source: string;
}

/** Every bundled header record and typedef of `abi`, sorted by name. */
export function libraryTypeCatalog(abi: AbiId): readonly LibraryTypeEntry[] {
  return libraryRecordNames(abi).flatMap((name) => {
    const record = libraryRecord(abi, name);
    return record
      ? [
          {
            name,
            record: record.name,
            kind: record.union ? ('union' as const) : ('struct' as const),
            size: record.size,
            header: record.header,
            source: record.source,
          },
        ]
      : [];
  });
}

/** Width/signedness of the plain scalars a layout uses; `long` follows LP64/LLP64. */
function scalar(abi: AbiId, spec: string): { c: string; bytes: number } | null {
  const long = abi === 'windows-x64' ? 4 : 8;
  const integer = (bytes: number, signed: boolean) => ({
    c: `${signed ? '' : 'u'}int${bytes * 8}_t`,
    bytes,
  });
  switch (spec) {
    case 'char':
      return { c: 'char', bytes: 1 };
    case 'schar':
      return integer(1, true);
    case 'uchar':
      return integer(1, false);
    case 'bool':
      return { c: 'bool', bytes: 1 };
    case 'short':
      return integer(2, true);
    case 'ushort':
      return integer(2, false);
    case 'int':
      return integer(4, true);
    case 'uint':
      return integer(4, false);
    case 'long':
      return integer(long, true);
    case 'ulong':
      return integer(long, false);
    case 'longlong':
    case 'int64':
    case 'ssize_t':
      return integer(8, true);
    case 'ulonglong':
    case 'uint64':
    case 'size_t':
      return integer(8, false);
    case 'wchar':
      return abi === 'windows-x64' ? integer(2, false) : integer(4, true);
    case 'float':
      return { c: 'float', bytes: 4 };
    case 'double':
      return { c: 'double', bytes: 8 };
    case 'longdouble':
      return abi === 'sysv-amd64' ? { c: 'long double', bytes: 16 } : { c: 'double', bytes: 8 };
    case 'fnptr':
    case 'va_list':
      return { c: 'void *', bytes: 8 };
    default:
      return null;
  }
}

/** C declarations of one bundled type and every type it holds by value (dependencies
 * first), in the subset OpenDecomp's C declaration parser reads: `<stdint.h>` widths for
 * the target ABI, pointers to records as `struct tag *`, code pointers as `void *`.
 * Overlapping members of a structure (a flattened anonymous union) keep the first view.
 * Where natural alignment would not reproduce the header offsets (packed headers), the
 * structure is `__attribute__((packed))` with explicit `uint8_t _pad_<offset>[n]` gaps. */
export function libraryTypeDeclaration(abi: AbiId, name: string): string | undefined {
  const root = libraryRecord(abi, name);
  if (!root) return undefined;
  const out: string[] = [];
  const done = new Set<string>();
  const opaque = new Set<string>();

  /** The C name of the record `key` refers to; declares what by-value use needs. */
  const recordName = (key: string, byValue: boolean): string => {
    const record = libraryRecord(abi, key);
    if (!record) {
      if (/^(?:struct|union) \w+$/.test(key)) return key;
      if (!opaque.has(key) && /^\w+$/.test(key)) {
        opaque.add(key);
        out.push(`typedef struct ${key} ${key};`);
      }
      return /^\w+$/.test(key) ? key : 'void';
    }
    if (/^(?:struct|union) \w+$/.test(record.name)) {
      if (byValue) define(record);
      return record.name;
    }
    // A typedef of an unnamed record: its typedef declares it, by value or not.
    define(record);
    return record.name;
  };
  const sizeOf = (spec: FieldSpec): { bytes: number; align: number } | null => {
    if (typeof spec === 'string') {
      const found = scalar(abi, spec);
      return found && { bytes: found.bytes, align: found.bytes };
    }
    if (spec.kind === 'pointer' || spec.kind === 'handle') return { bytes: 8, align: 8 };
    if (spec.kind === 'array') {
      const element = sizeOf(spec.of);
      return element && spec.count !== null
        ? { bytes: element.bytes * spec.count, align: element.align }
        : null;
    }
    const record = libraryRecord(abi, spec.name);
    if (!record) return null;
    if (record.size && record.alignment) return { bytes: record.size, align: record.alignment };
    // A member's unnamed record is unsized: its members give its extent and alignment.
    let bytes = 0,
      align = 1;
    for (const field of record.fields) {
      const size = sizeOf(field.type);
      if (!size) return null;
      bytes = Math.max(bytes, field.offset + size.bytes);
      align = Math.max(align, size.align);
    }
    return bytes ? { bytes: Math.ceil(bytes / align) * align, align } : null;
  };
  /** `type declarator` for one member, or null for a type that has no C spelling here. */
  const declare = (spec: FieldSpec, declarator: string): string | null => {
    if (typeof spec === 'string') {
      const found = spec === 'void' ? { c: 'void' } : scalar(abi, spec);
      return found && `${found.c}${found.c.endsWith('*') ? '' : ' '}${declarator}`;
    }
    if (spec.kind === 'array')
      return declare(spec.of, `${declarator}[${spec.count === null ? '' : spec.count}]`);
    if (spec.kind === 'pointer') {
      const to = spec.to;
      const constant = spec.const ? 'const ' : '';
      if (typeof to === 'object' && to.kind === 'opaque')
        return `${constant}${recordName(to.name, false)} *${declarator}`;
      if (typeof to === 'object' && to.kind === 'handle') return `void **${declarator}`;
      const inner = declare(to, `*${declarator}`);
      return inner === null ? `void *${declarator}` : `${constant}${inner}`;
    }
    if (spec.kind === 'handle') return `void *${declarator}`;
    const record = libraryRecord(abi, spec.name);
    if (record?.name.includes('.')) {
      const body = members(record);
      return body && `${record.union ? 'union' : 'struct'} { ${body.text} } ${declarator}`;
    }
    if (!record) return null;
    return `${recordName(spec.name, true)} ${declarator}`;
  };
  /** Member list of a record; `packed` when natural alignment misses a header offset. */
  const members = (record: LibraryRecord): { text: string; packed: boolean } | null => {
    const kept: { text: string; offset: number; bytes: number; align: number }[] = [];
    let end = 0;
    for (const field of record.fields) {
      if (!record.union && field.offset < end) continue;
      const size = sizeOf(field.type);
      const text = size && declare(field.type, field.name);
      if (!size || !text) continue;
      kept.push({ text, offset: field.offset, bytes: size.bytes, align: size.align });
      end = Math.max(end, field.offset + size.bytes);
    }
    if (!kept.length) return null;
    if (record.union) {
      // Members after offset 0 belong to a flattened anonymous structure: regroup them.
      const groups: (typeof kept)[] = [];
      for (const item of kept)
        if (item.offset === 0 || !groups.length) groups.push([item]);
        else groups.at(-1)!.push(item);
      const text = groups
        .map((group) =>
          group.length === 1
            ? `${group[0]!.text};`
            : `struct { ${group.map((item) => `${item.text};`).join(' ')} };`,
        )
        .join(' ');
      return { text, packed: false };
    }
    let offset = 0,
      align = 1,
      natural = true;
    for (const item of kept) {
      offset = Math.ceil(offset / item.align) * item.align;
      if (offset !== item.offset) natural = false;
      offset = item.offset + item.bytes;
      align = Math.max(align, item.align);
    }
    if (record.size !== null && Math.ceil(offset / align) * align !== record.size) natural = false;
    if (natural) return { text: kept.map((item) => `${item.text};`).join(' '), packed: false };
    const parts: string[] = [];
    let at = 0;
    for (const item of kept) {
      if (item.offset > at) parts.push(`uint8_t _pad_${at.toString(16)}[${item.offset - at}];`);
      parts.push(`${item.text};`);
      at = item.offset + item.bytes;
    }
    if (record.size !== null && record.size > at)
      parts.push(`uint8_t _pad_${at.toString(16)}[${record.size - at}];`);
    return { text: parts.join(' '), packed: true };
  };
  function define(record: LibraryRecord): void {
    if (done.has(record.name)) return;
    done.add(record.name);
    const body = members(record);
    const keyword = record.union ? 'union' : 'struct';
    const tail = body?.packed ? ' __attribute__((packed))' : '';
    // Only bit-fields (or no member at all): one opaque word array of the record's size.
    const unit = record.alignment && record.size ? Math.min(record.alignment, 8) : 1;
    const text = body
      ? `{ ${body.text} }`
      : `{ uint${unit * 8}_t _bits[${Math.max(1, Math.floor((record.size ?? 1) / unit))}]; }`;
    out.push(
      /^(?:struct|union) \w+$/.test(record.name)
        ? `${record.name} ${text}${tail};`
        : `typedef ${keyword} ${text}${tail} ${record.name};`,
    );
  }
  define(root);
  if (name !== root.name && /^\w+$/.test(name)) out.push(`typedef ${root.name} ${name};`);
  return out.join('\n');
}
