import type { CatalogEntry, LibraryKind } from '../catalog.js';
import {
  ABI_TYPEDEFS,
  SCALAR_CODES,
  type AbiTypedef,
  type ScalarSpec,
  type TypeSpec,
} from '../spec.js';
import * as c from './data/c.js';
import * as corefoundation from './data/corefoundation.js';
import * as cxx from './data/cxx.js';
import * as darwin from './data/darwin.js';
import * as glibc from './data/glibc.js';
import * as posix from './data/posix.js';
import * as windowsAdvapi from './data/windows-advapi.js';
import * as windowsCrt from './data/windows-crt.js';
import * as windowsKernel from './data/windows-kernel.js';
import * as windowsShell from './data/windows-shell.js';
import * as windowsUser from './data/windows-user.js';
import * as windowsWinsock from './data/windows-winsock.js';

/** Header-derived function interfaces written by `scripts/generate-library-prototypes.ts`.
 * A module holds one line per function, `name|return|parameters|flags|header`:
 * - types are prefix codes: one letter per scalar (`SCALAR_CODES`), `*T` pointer,
 *   `^T` pointer to const, `@Name;` opaque type, `@!Name;` anonymous opaque type,
 *   `$name;` ABI-dependent typedef, `&Name;` named pointer typedef (a `&Name=type`
 *   line defines it);
 * - parameters are `name:type` separated by `,`;
 * - flags are `n` noreturn, `v` variadic, `f<i>` / `s<i>` printf / scanf format
 *   parameter index, `o<i>` open-flags parameter index.
 * Only interface facts are stored. No entry has a memory footprint, so every
 * argument memory effect stays unknown unless a curated catalog entry says otherwise. */
export interface GeneratedModule {
  readonly provenance: string;
  readonly headers: readonly string[];
  readonly data: string;
}

const MODULES: Partial<Record<LibraryKind, GeneratedModule>> = {
  c,
  posix,
  darwin,
  glibc,
  cxx,
  corefoundation,
  'windows-crt': windowsCrt,
  'windows-kernel': windowsKernel,
  'windows-user': windowsUser,
  'windows-advapi': windowsAdvapi,
  'windows-winsock': windowsWinsock,
  'windows-shell': windowsShell,
};

class Table {
  private readonly lines = new Map<string, string>();
  private readonly handles = new Map<string, string>();
  private readonly decoded = new Map<string, CatalogEntry | undefined>();
  private readonly types = new Map<string, TypeSpec>();
  constructor(
    private readonly library: LibraryKind,
    private readonly module: GeneratedModule,
  ) {
    let start = 0;
    const { data } = module;
    while (start < data.length) {
      let end = data.indexOf('\n', start);
      if (end < 0) end = data.length;
      if (end > start) {
        if (data.charCodeAt(start) === 38 /* & */) {
          const equals = data.indexOf('=', start);
          this.handles.set(data.slice(start + 1, equals), data.slice(equals + 1, end));
        } else {
          const bar = data.indexOf('|', start);
          this.lines.set(data.slice(start, bar), data.slice(bar + 1, end));
        }
      }
      start = end + 1;
    }
  }

  names(): IterableIterator<string> {
    return this.lines.keys();
  }

  entry(name: string): CatalogEntry | undefined {
    if (this.decoded.has(name)) return this.decoded.get(name);
    const line = this.lines.get(name);
    const entry = line === undefined ? undefined : this.decode(line);
    this.decoded.set(name, entry);
    return entry;
  }

  private decode(line: string): CatalogEntry {
    const [returns, parameters, flags, header] = line.split('|') as [
      string,
      string,
      string,
      string,
    ];
    let variadic_rule: CatalogEntry['variadic_rule'];
    for (const match of flags.matchAll(/([fso])(\d+)/g))
      variadic_rule = {
        kind: match[1] === 'f' ? 'format' : match[1] === 's' ? 'scanf_format' : 'open_flags',
        argument: Number(match[2]),
      };
    return {
      library: this.library,
      returns: this.type(returns),
      parameters: parameters
        ? parameters.split(',').map((item) => {
            const colon = item.indexOf(':');
            return [item.slice(0, colon), this.type(item.slice(colon + 1))] as const;
          })
        : [],
      ...(flags.includes('n') ? { noreturn: true } : {}),
      ...(flags.includes('v') ? { variadic: true } : {}),
      ...(variadic_rule ? { variadic_rule } : {}),
      source: `${this.module.provenance} ${this.module.headers[Number.parseInt(header, 36)]}`,
    };
  }

  /** Decodes one complete type code; identical codes share one TypeSpec. */
  type(code: string): TypeSpec {
    const cached = this.types.get(code);
    if (cached !== undefined) return cached;
    const cursor = { at: 0 };
    const spec = this.parse(code, cursor);
    if (cursor.at !== code.length) throw new TypeError(`Malformed generated type code ${code}`);
    this.types.set(code, spec);
    return spec;
  }

  private parse(code: string, cursor: { at: number }): TypeSpec {
    const letter = code[cursor.at++]!;
    const name = (): string => {
      const end = code.indexOf(';', cursor.at);
      const text = code.slice(cursor.at, end);
      cursor.at = end + 1;
      return text;
    };
    switch (letter) {
      case '*':
        return { kind: 'pointer', to: this.parse(code, cursor) };
      case '^':
        return { kind: 'pointer', to: this.parse(code, cursor), const: true };
      case '@': {
        const text = name();
        return text.startsWith('!')
          ? { kind: 'opaque', name: text.slice(1), spelled: false }
          : { kind: 'opaque', name: text };
      }
      case '$': {
        const text = name();
        if (!Object.hasOwn(ABI_TYPEDEFS, text)) throw new TypeError(`Unknown ABI typedef ${text}`);
        return text as AbiTypedef;
      }
      case '&': {
        const text = name(),
          target = this.handles.get(text);
        if (target === undefined) throw new TypeError(`Unknown handle typedef ${text}`);
        return { kind: 'handle', name: text, to: this.type(target) };
      }
      default: {
        const scalar = (SCALAR_CODES as Record<string, ScalarSpec | undefined>)[letter];
        if (scalar === undefined) throw new TypeError(`Unknown generated type code ${letter}`);
        return scalar;
      }
    }
  }
}

const tables = new Map<LibraryKind, Table | null>();

/** The generated header interface of `name` in one library family, decoded on demand;
 * a family's module is indexed on first use. */
export function generatedDeclaration(library: LibraryKind, name: string): CatalogEntry | undefined {
  let table = tables.get(library);
  if (table === undefined) {
    const module = MODULES[library];
    table = module ? new Table(library, module) : null;
    tables.set(library, table);
  }
  return table?.entry(name);
}

/** Every generated function name of one library family, for tooling and tests. */
export function generatedNames(library: LibraryKind): readonly string[] {
  const module = MODULES[library];
  return module ? [...new Table(library, module).names()] : [];
}
