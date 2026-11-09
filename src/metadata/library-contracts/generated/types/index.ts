import type { AbiProfile } from '../../../../core/index.js';
import { SCALAR_CODES, type ScalarSpec, type TypeSpec } from '../../spec.js';
import * as darwinArm64 from './darwin-arm64.js';
import * as sysvAmd64 from './sysv-amd64.js';
import * as windowsX64 from './windows-x64.js';

/** Header-derived record layouts and constant values of one target ABI, written by
 * `scripts/generate-library-types.ts`. `records` holds one line per record,
 * `name|size|align|s or u|header|fields` (size 0: unknown, a member of unnamed record
 * type), fields `name:offset:type` separated by `,`, types in the prototype codes of
 * `../index.ts` plus `[N]T` (array of N, empty N: unknown count); `=alias|name` lines
 * map a typedef to the record it names (`FILE` -> `struct _IO_FILE`). Bit-fields and
 * members of unsupported types are absent: their bytes are gaps. A union is a record
 * whose members all start at offset 0; anonymous members are flattened into their
 * parent. `constants` holds `NAME=hex` lines (negative: `-hex`). */
export interface GeneratedTypesModule {
  readonly provenance: string;
  readonly headers: readonly string[];
  readonly records: string;
  readonly constants: string;
}

const MODULES: Record<AbiProfile['id'], GeneratedTypesModule> = {
  'sysv-amd64': sysvAmd64,
  'darwin-arm64': darwinArm64,
  'windows-x64': windowsX64,
};

/** A member type: a library TypeSpec or an array of one. */
export type FieldSpec =
  TypeSpec | { readonly kind: 'array'; readonly of: FieldSpec; readonly count: number | null };

export interface LibraryRecordField {
  readonly name: string;
  readonly offset: number;
  readonly type: FieldSpec;
}
export interface LibraryRecord {
  /** The record's own name (`struct stat`, `pthread_mutex_t`, `struct sigaction.__sigaction_handler`). */
  readonly name: string;
  /** Bytes; null when the generator could not size it (a member of unnamed record type). */
  readonly size: number | null;
  readonly alignment: number | null;
  readonly union: boolean;
  /** Declaring header relative to the include root (`bits/struct_stat.h`). */
  readonly header: string;
  readonly fields: readonly LibraryRecordField[];
  /** Header set and toolchain the layout was read from. */
  readonly source: string;
}

class Layouts {
  private readonly lines = new Map<string, string>();
  private readonly aliases = new Map<string, string>();
  private readonly decoded = new Map<string, LibraryRecord>();
  private constantValues: Map<string, bigint> | undefined;
  constructor(private readonly module: GeneratedTypesModule) {
    for (const line of module.records.split('\n')) {
      if (!line) continue;
      const bar = line.indexOf('|');
      if (line.startsWith('=')) this.aliases.set(line.slice(1, bar), line.slice(bar + 1));
      else this.lines.set(line.slice(0, bar), line.slice(bar + 1));
    }
  }

  /** The record a name denotes, through typedef aliases. */
  record(name: string): LibraryRecord | undefined {
    let key = name;
    for (let depth = 0; depth < 8 && !this.lines.has(key); depth++) {
      const next = this.aliases.get(key);
      if (next === undefined) return undefined;
      key = next;
    }
    const cached = this.decoded.get(key);
    if (cached) return cached;
    const line = this.lines.get(key);
    if (line === undefined) return undefined;
    const [size, align, kind, header, fields] = line.split('|') as [
      string,
      string,
      string,
      string,
      string,
    ];
    const record: LibraryRecord = {
      name: key,
      size: size === '0' ? null : Number(size),
      alignment: align === '0' ? null : Number(align),
      union: kind === 'u',
      header: this.module.headers[Number.parseInt(header, 36)] ?? '',
      fields: fields
        ? fields.split(',').map((field) => {
            const first = field.indexOf(':'),
              second = field.indexOf(':', first + 1);
            return {
              name: field.slice(0, first),
              offset: Number(field.slice(first + 1, second)),
              type: parseField(field.slice(second + 1)),
            };
          })
        : [],
      source: this.module.provenance,
    };
    this.decoded.set(key, record);
    return record;
  }

  /** Every record name and typedef alias, sorted: the type browser's listing. */
  names(): string[] {
    return [...this.lines.keys(), ...this.aliases.keys()]
      .filter((name) => !name.includes('.') && this.record(name) !== undefined)
      .sort();
  }

  constant(name: string): bigint | undefined {
    if (!this.constantValues) {
      this.constantValues = new Map();
      for (const line of this.module.constants.split('\n')) {
        const equals = line.indexOf('=');
        if (equals < 0) continue;
        const text = line.slice(equals + 1);
        const value = text.startsWith('-') ? -BigInt(`0x${text.slice(1)}`) : BigInt(`0x${text}`);
        this.constantValues.set(line.slice(0, equals), value);
      }
    }
    return this.constantValues.get(name);
  }
}

function parseField(code: string): FieldSpec {
  const cursor = { at: 0 };
  const spec = parse(code, cursor);
  if (cursor.at !== code.length) throw new TypeError(`Malformed library field type ${code}`);
  return spec;
}
function parse(code: string, cursor: { at: number }): FieldSpec {
  const letter = code[cursor.at++]!;
  switch (letter) {
    case '[': {
      const end = code.indexOf(']', cursor.at);
      const count = code.slice(cursor.at, end);
      cursor.at = end + 1;
      return { kind: 'array', of: parse(code, cursor), count: count ? Number(count) : null };
    }
    case '*':
    case '^': {
      const to = parse(code, cursor);
      // A pointer to an array is not a library TypeSpec: point to its element.
      const target = typeof to === 'object' && to.kind === 'array' ? arrayElement(to) : to;
      return letter === '^'
        ? { kind: 'pointer', to: target, const: true }
        : { kind: 'pointer', to: target };
    }
    case '@': {
      const end = code.indexOf(';', cursor.at);
      const name = code.slice(cursor.at, end);
      cursor.at = end + 1;
      return name.startsWith('!')
        ? { kind: 'opaque', name: name.slice(1), spelled: false }
        : { kind: 'opaque', name };
    }
    default: {
      const scalar = (SCALAR_CODES as Record<string, ScalarSpec | undefined>)[letter];
      if (scalar === undefined) throw new TypeError(`Unknown library field code ${letter}`);
      return scalar;
    }
  }
}
function arrayElement(spec: FieldSpec): TypeSpec {
  while (typeof spec === 'object' && spec.kind === 'array') spec = spec.of;
  return spec;
}

const layouts = new Map<AbiProfile['id'], Layouts>();
function layoutsOf(abi: AbiProfile['id']): Layouts {
  let found = layouts.get(abi);
  if (!found) {
    found = new Layouts(MODULES[abi]);
    layouts.set(abi, found);
  }
  return found;
}

/** The header layout of the library record (or typedef of one) `name` on `abi`. */
export function libraryRecord(abi: AbiProfile['id'], name: string): LibraryRecord | undefined {
  const found = layoutsOf(abi).record(name);
  // macOS SDK prototype spellings of POSIX types (`__darwin_pthread_mutex_t`).
  return found ?? (name.startsWith('__darwin_') ? layoutsOf(abi).record(name.slice(9)) : undefined);
}

/** Every named record and typedef of one ABI's type library. */
export function libraryRecordNames(abi: AbiProfile['id']): readonly string[] {
  return layoutsOf(abi).names();
}

/** The header value of a curated library constant on `abi`, if that platform defines it. */
export function libraryConstant(abi: AbiProfile['id'], name: string): bigint | undefined {
  return layoutsOf(abi).constant(name);
}

/** Provenance of one ABI's generated type library. */
export function libraryTypesSource(abi: AbiProfile['id']): string {
  return MODULES[abi].provenance;
}
