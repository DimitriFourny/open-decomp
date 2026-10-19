#!/usr/bin/env node
// Regenerates src/metadata/library-contracts/generated/data/*.ts: function interfaces
// (names, parameter names, types, variadic, noreturn) extracted from real C headers with
// `clang -Xclang -ast-dump=json -fsyntax-only`:
//   - macOS SDK (`xcrun --show-sdk-path`) for ISO C, POSIX, Darwin libSystem and CoreFoundation;
//   - mingw-w64 headers (Homebrew `mingw-w64`) plus its import libraries (`llvm-nm`) for the
//     Windows CRT and kernel32/user32/advapi32/ws2_32/shell32;
//   - scripts/library-prototypes/*.h for glibc/Itanium-ABI symbols no installed header declares.
// Run: `bun run prototypes` (needs Xcode CLT, Homebrew llvm and mingw-w64).
// Only interface facts are stored; no memory footprints, so effects stay unknown.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LibraryKind } from '../src/metadata/library-contracts/catalog.js';
import {
  ABI_TYPEDEFS,
  SCALAR_CODES,
  type ScalarSpec,
  type TypeSpec,
} from '../src/metadata/library-contracts/spec.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/metadata/library-contracts/generated/data');
const HAND = join(ROOT, 'scripts/library-prototypes');

/* ------------------------------------------------------------------ types */

const sh = (command: string, args: string[]): string =>
  execFileSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 30 }).trim();

type Ast = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Decl {
  readonly name: string;
  readonly returns: string;
  readonly parameters: readonly { name: string | null; type: string }[];
  readonly variadic: boolean;
  readonly noreturn: boolean;
  readonly formatted: boolean;
  readonly isStatic: boolean;
  readonly file: string;
}
/** An `extern` data declaration: the type as spelled, and whether the object itself is
 * const-qualified (`const CFStringRef`, `char *const`). */
interface Variable {
  readonly name: string;
  readonly type: string;
  readonly constant: boolean;
  readonly file: string;
}
interface Unit {
  readonly id: string;
  readonly compiler: string;
  readonly args: readonly string[];
  readonly source: string;
  /** Include roots; a declaration belongs to the unit when its header lies below one. */
  readonly roots: readonly string[];
  readonly provenance: string;
  /** Library family of a declaration, or null to drop it. */
  readonly classify: (decl: Decl, header: string) => LibraryKind | null;
  readonly target: 'darwin' | 'windows' | 'hand';
}
interface Collected {
  readonly decls: Map<string, Decl>;
  readonly variables: Map<string, Variable>;
  readonly typedefs: Map<string, { qual: string; anonymous: boolean; enumId?: string }>;
  readonly tags: Map<string, { complete: boolean; unused: boolean }>;
  readonly enums: Map<string, boolean>; // 'enum X' or typedef name -> has negative enumerator
  readonly enumById: Map<string, boolean>;
}

/* -------------------------------------------------------------- AST intake */

/** Splits clang's pretty-printed JSON into its top-level declarations without ever
 * holding the whole tree (windows.h dumps are hundreds of MB). A top-level node starts
 * at `\n    {` and ends at `\n    }`; nested objects are indented deeper. */
function* topLevel(text: string): Generator<Ast> {
  let position = text.indexOf('"inner": [');
  for (;;) {
    const start = text.indexOf('\n    {', position);
    if (start < 0) return;
    const end = text.indexOf('\n    }', start + 1);
    yield JSON.parse(text.slice(start + 1, end + 6)) as Ast;
    position = end + 6;
  }
}

/** clang prints a location's `file` only when it changes, so the current file is the
 * last `file` seen in document order (never inside `includedFrom`). */
function trackFile(node: unknown, state: { file: string }): void {
  if (Array.isArray(node)) {
    for (const item of node) trackFile(item, state);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'includedFrom') continue;
    if (key === 'file' && typeof value === 'string') state.file = value;
    else if (key !== 'inner') trackFile(value, state);
  }
}

function collect(unit: Unit, text: string): Collected {
  const out: Collected = {
    decls: new Map(),
    variables: new Map(),
    typedefs: new Map(),
    tags: new Map(),
    enums: new Map(),
    enumById: new Map(),
  };
  const state = { file: '' };
  for (const node of topLevel(text)) {
    trackFile({ loc: node.loc, range: node.range }, state);
    const file = state.file;
    // Keep file tracking exact through nested locations (they are printed in order).
    for (const child of node.inner ?? []) trackFile(child, state);
    switch (node.kind) {
      case 'TypedefDecl': {
        const type = node.type as { qualType: string };
        const owned = node.inner?.[0]?.ownedTagDecl?.id as string | undefined;
        out.typedefs.set(node.name, {
          qual: type.qualType,
          anonymous: /\(unnamed|\(anonymous|^(?:struct|union|enum)\s*$/.test(type.qualType),
          ...(owned ? { enumId: owned } : {}),
        });
        break;
      }
      case 'RecordDecl': {
        if (!node.name) break;
        const key = `${node.tagUsed} ${node.name}`;
        const fields = (node.inner ?? []).filter((item: Ast) => item.kind === 'FieldDecl');
        const complete = node.completeDefinition === true;
        const unused = complete && fields.length === 1 && fields[0].name === 'unused';
        const prior = out.tags.get(key);
        out.tags.set(key, {
          complete: complete || (prior?.complete ?? false),
          unused: unused || (prior?.unused ?? false),
        });
        break;
      }
      case 'EnumDecl': {
        const negative = (node.inner ?? []).some(
          (item: Ast) =>
            item.kind === 'EnumConstantDecl' &&
            JSON.stringify(item.inner ?? []).includes('"value":"-'),
        );
        if (node.name) out.enums.set(`enum ${node.name}`, negative);
        out.enumById.set(node.id, negative);
        break;
      }
      case 'VarDecl': {
        if (node.isImplicit || !node.name || node.storageClass !== 'extern') break;
        if (!unit.roots.some((root) => file.startsWith(root))) break;
        const type = (node.type.qualType as string).replace(ATTRIBUTE, '').trim();
        // Top-level const: after the last `*`, or on a non-pointer (typedef'd) type.
        const star = type.lastIndexOf('*');
        const constant = star < 0 ? /\bconst\b/.test(type) : /\bconst\b/.test(type.slice(star));
        if (!out.variables.has(node.name))
          out.variables.set(node.name, { name: node.name, type, constant, file });
        break;
      }
      case 'FunctionDecl': {
        if (node.isImplicit || !node.name) break;
        if (!unit.roots.some((root) => file.startsWith(root))) break;
        const parameters = (node.inner ?? [])
          .filter((item: Ast) => item.kind === 'ParmVarDecl')
          .map((item: Ast) => ({
            name: (item.name as string | undefined) ?? null,
            type: item.type.qualType,
          }));
        const attributes = (node.inner ?? []).filter((item: Ast) => /Attr$/.test(item.kind));
        const type = node.type.qualType as string;
        const open = type.indexOf('(');
        const returnsFunction =
          /^\s*\(\s*[*^]\s*\(/.test(type.slice(type.indexOf(' (') + 1)) || type.includes('(*(');
        const decl: Decl = {
          name: node.name,
          returns: returnsFunction ? 'void (*)(void)' : type.slice(0, open).trim(),
          parameters,
          variadic: /\.\.\.\)/.test(type),
          // `noreturn` is part of the function type, so clang prints it only in the type string.
          noreturn:
            /\bnoreturn\b/.test(type) || attributes.some((item: Ast) => /NoReturn/.test(item.kind)),
          formatted: attributes.some((item: Ast) => item.kind === 'FormatAttr' && !item.implicit),
          isStatic: node.storageClass === 'static',
          file,
        };
        const prior = out.decls.get(node.name);
        if (!prior) out.decls.set(node.name, decl);
        else
          out.decls.set(node.name, {
            ...(prior.parameters.filter((p) => p.name).length >=
            decl.parameters.filter((p) => p.name).length
              ? prior
              : decl),
            noreturn: prior.noreturn || decl.noreturn,
            formatted: prior.formatted || decl.formatted,
            isStatic: prior.isStatic && decl.isStatic,
          });
        break;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------ type resolver */

const FIXED = /^(?:__)?(u?)int(8|16|32|64)_t$/;
const DARWIN_OPAQUE_SCALARS = new Set(['sigset_t', 'fpos_t', 'mach_port_name_t_unused']);
const QUALIFIER =
  /\b(?:const|volatile|restrict|__restrict|_Nonnull|_Nullable|_Null_unspecified|__strong|__weak|__unsafe_unretained|__kindof|__unaligned|_Atomic|__ptr64|__ptr32)\b/g;
const ATTRIBUTE = /__attribute__\(\([^()]*(?:\([^()]*\)[^()]*)*\)\)/g;

/** ISO C typedefs whose width the Windows column of `ABI_TYPEDEFS` states. */
const WINDOWS_STANDARD = new Set(['time_t', 'clock_t', 'wint_t', 'wctype_t']);

class Unsupported extends Error {}

class Resolver {
  readonly handles = new Map<string, string>();
  readonly stats = new Map<string, number>();
  constructor(
    private readonly data: Collected,
    private readonly windows: boolean,
  ) {}

  /** Source type -> TypeSpec; aggregates by value, vectors, complex and unnamed
   * layouts throw `Unsupported`. */
  value(qual: string): TypeSpec {
    const spec = this.parse(qual, 0);
    if (spec === 'FUNCTION' || spec === 'ARRAY') throw new Unsupported(`bare ${spec}: ${qual}`);
    if (typeof spec === 'object' && spec.kind === 'opaque')
      throw new Unsupported(`aggregate by value: ${qual}`);
    return spec;
  }

  private parse(qual: string, depth: number): TypeSpec | 'FUNCTION' | 'ARRAY' {
    if (depth > 24) throw new Unsupported(`typedef depth: ${qual}`);
    const text = qual.replace(ATTRIBUTE, '').trim();
    if (/\(\s*[*^]/.test(text)) {
      if (/\)\s*\[/.test(text)) throw new Unsupported(`pointer to array: ${qual}`);
      return 'fnptr';
    }
    if (text.includes('(')) return 'FUNCTION';
    if (/\[[^\]]*\]\s*$/.test(text)) return 'ARRAY';
    const parts = text.split('*');
    const baseText = parts[0]!.replace(QUALIFIER, ' ').replace(/\s+/g, ' ').trim();
    let baseConst = /\bconst\b/.test(parts[0]!);
    let spec = this.base(baseText, depth);
    if (typeof spec === 'object' && spec.kind === 'pointer' && parts.length === 1)
      baseConst = false;
    for (let level = 1; level < parts.length; level++) {
      const pointee = spec;
      if (pointee === 'FUNCTION') {
        spec = 'fnptr';
        continue;
      }
      if (pointee === 'ARRAY') throw new Unsupported(`pointer to array: ${qual}`);
      const isConst = level === 1 ? baseConst : /\bconst\b/.test(parts[level - 1]!);
      spec = isConst
        ? { kind: 'pointer', to: pointee, const: true }
        : { kind: 'pointer', to: pointee };
    }
    return spec;
  }

  private base(name: string, depth: number): TypeSpec | 'FUNCTION' | 'ARRAY' {
    const words = name.split(' ').filter(Boolean);
    if (!words.length) throw new Unsupported('empty type');
    if (
      /^(?:_Complex|__complex|_Float16|__fp16|__bf16|__int128|__uint128|__int128_t|__uint128_t)/.test(
        name,
      ) ||
      words.includes('_Complex')
    )
      throw new Unsupported(`unsupported builtin: ${name}`);
    if (/vector|__attribute__|ext_vector/.test(name)) throw new Unsupported(`vector: ${name}`);
    const builtin = this.builtin(words);
    if (builtin) return builtin;
    if (/^(?:struct|union) /.test(name)) return { kind: 'opaque', name };
    if (name.startsWith('enum ')) {
      const typedef = this.data.typedefs.get(name.slice(5));
      const negative =
        this.data.enums.get(name) ??
        (typedef?.enumId === undefined ? undefined : this.data.enumById.get(typedef.enumId));
      if (negative === undefined) throw new Unsupported(`unknown enum ${name}`);
      return negative ? 'int' : 'uint';
    }
    return this.named(name, depth);
  }

  private builtin(words: readonly string[]): ScalarSpec | null {
    const set = new Set(words);
    const longs = words.filter((word) => word === 'long').length;
    const unsigned = set.has('unsigned');
    if (set.has('void') && words.length === 1) return 'void';
    if (set.has('_Bool') || (words.length === 1 && words[0] === 'bool')) return 'bool';
    if (set.has('float')) return 'float';
    if (set.has('double')) return longs ? 'longdouble' : 'double';
    if (set.has('char')) return unsigned ? 'uchar' : set.has('signed') ? 'schar' : 'char';
    if (set.has('short')) return unsigned ? 'ushort' : 'short';
    if (longs >= 2) return unsigned ? 'ulonglong' : 'longlong';
    if (longs === 1) return unsigned ? 'ulong' : 'long';
    if (set.has('int') || set.has('signed') || unsigned) return unsigned ? 'uint' : 'int';
    if (set.has('wchar_t') && words.length === 1) return 'wchar';
    if (set.has('char16_t')) return 'ushort';
    if (set.has('char32_t')) return 'uint';
    return null;
  }

  private named(name: string, depth: number): TypeSpec | 'FUNCTION' | 'ARRAY' {
    this.stats.set(name, (this.stats.get(name) ?? 0) + 1);
    const plain = name.replace(/^__darwin_/, '');
    if (Object.hasOwn(ABI_TYPEDEFS, plain) && (!this.windows || WINDOWS_STANDARD.has(plain)))
      return plain as keyof typeof ABI_TYPEDEFS;
    if (name === 'pthread_t' || name === '__darwin_pthread_t') return 'ulong';
    const fixed = FIXED.exec(name);
    if (fixed) {
      const width = Number(fixed[2]);
      const unsigned = fixed[1] === 'u';
      return (
        unsigned
          ? { 8: 'uchar', 16: 'ushort', 32: 'uint', 64: 'uint64' }
          : { 8: 'schar', 16: 'short', 32: 'int', 64: 'int64' }
      )[width as 8 | 16 | 32 | 64] as ScalarSpec;
    }
    switch (name) {
      case 'size_t':
      case '__darwin_size_t':
      case 'rsize_t':
      case 'uintptr_t':
      case '__darwin_uintptr_t':
      case 'SIZE_T':
        return 'size_t';
      case 'ssize_t':
      case '__darwin_ssize_t':
      case 'intptr_t':
      case '__darwin_intptr_t':
      case 'ptrdiff_t':
      case '__darwin_ptrdiff_t':
        return 'ssize_t';
      case 'wchar_t':
      case '__darwin_wchar_t':
        return 'wchar';
      case 'intmax_t':
      case '__darwin_intmax_t':
        return 'int64';
      case 'uintmax_t':
      case '__darwin_uintmax_t':
        return 'uint64';
      case 'va_list':
      case '__builtin_va_list':
      case '__darwin_va_list':
      case '__gnuc_va_list':
      case '__isoc_va_list':
        return 'va_list';
      case 'bool':
      case '_Bool':
        return 'bool';
    }
    if (!this.windows && DARWIN_OPAQUE_SCALARS.has(name)) return { kind: 'opaque', name };
    const typedef = this.data.typedefs.get(name);
    if (!typedef) throw new Unsupported(`unknown type name ${name}`);
    const underlying = typedef.qual.replace(ATTRIBUTE, '').trim();
    if (typedef.anonymous || /^(?:struct|union) [^*]*$/.test(underlying)) {
      // `typedef struct tag { ... } name` keeps the typedef name as the spelling.
      if (typedef.enumId !== undefined && this.data.enumById.has(typedef.enumId))
        return this.data.enumById.get(typedef.enumId)! ? 'int' : 'uint';
      if (/^enum /.test(underlying) || (typedef.anonymous && typedef.enumId !== undefined))
        return 'uint';
      return { kind: 'opaque', name };
    }
    if (/^enum /.test(underlying)) return this.base(underlying, depth + 1);
    const spec = this.parse(underlying, depth + 1);
    if (typeof spec === 'object' && spec.kind === 'pointer') return this.pointerTypedef(name, spec);
    return spec;
  }

  /** Opaque-handle typedefs (`HWND`, `CFStringRef`, `os_unfair_lock_t`) keep their name. */
  private pointerTypedef(name: string, spec: Extract<TypeSpec, { kind: 'pointer' }>): TypeSpec {
    if (/^_|^(?:LP|P)[A-Z_]/.test(name)) return spec;
    const target = spec.to;
    const opaque = typeof target === 'object' && target.kind === 'opaque';
    const voidHandle = target === 'void' && (name === 'HANDLE' || /^CF[A-Za-z]*Ref$/.test(name));
    if (!(opaque && /^[A-Za-z][A-Za-z0-9_]*$/.test(name)) && !voidHandle) return spec;
    if (opaque && !/^(?:[A-Z][A-Za-z0-9]*|[a-z][a-z0-9_]*_t)$/.test(name)) return spec;
    const handle: TypeSpec = { kind: 'handle', name, to: target };
    const code = encode(target);
    const prior = this.handles.get(name);
    if (prior !== undefined && prior !== code) throw new Unsupported(`handle ${name} redefined`);
    this.handles.set(name, code);
    return handle;
  }
}

/* -------------------------------------------------------------- serializer */

const CODE_BY_SCALAR = new Map<string, string>(
  Object.entries(SCALAR_CODES).map(([code, name]) => [name, code]),
);

function encode(spec: TypeSpec): string {
  if (typeof spec === 'string') {
    if (Object.hasOwn(ABI_TYPEDEFS, spec)) return `$${spec};`;
    const code = CODE_BY_SCALAR.get(spec);
    if (!code) throw new Error(`No code for ${spec}`);
    return code;
  }
  switch (spec.kind) {
    case 'pointer':
      return `${spec.const ? '^' : '*'}${encode(spec.to)}`;
    case 'opaque':
      return `@${spec.spelled === false ? '!' : ''}${spec.name};`;
    case 'handle':
      return `&${spec.name};`;
  }
}

/* ---------------------------------------------------------------- driver */

const SDK = sh('xcrun', ['--show-sdk-path']);
const SDK_VERSION = sh('xcrun', ['--show-sdk-version']);
const SDK_INCLUDE = `${SDK}/usr/include/`;
const CF_INCLUDE = `${SDK}/System/Library/Frameworks/CoreFoundation.framework/`;
const BREW = sh('brew', ['--prefix']);
const LLVM = `${BREW}/opt/llvm`;
const MINGW = `${BREW}/opt/mingw-w64/toolchain-x86_64/x86_64-w64-mingw32`;
const MINGW_VERSION =
  /mingw-w64\/([^/]+)\//.exec(
    execFileSync('readlink', ['-f', `${BREW}/opt/mingw-w64`], { encoding: 'utf8' }),
  )?.[1] ?? 'unknown';
const MINGW_INCLUDE = `${MINGW}/include/`;

const include = (headers: readonly string[]): string =>
  headers.map((header) => `#include <${header}>`).join('\n');

const C_HEADERS = [
  'ctype.h',
  'errno.h',
  'fenv.h',
  'inttypes.h',
  'locale.h',
  'math.h',
  'setjmp.h',
  'signal.h',
  'stdio.h',
  'stdlib.h',
  'string.h',
  'time.h',
  'wchar.h',
  'wctype.h',
];
const POSIX_HEADERS = [
  'aio.h',
  'arpa/inet.h',
  'dirent.h',
  'dlfcn.h',
  'fcntl.h',
  'fnmatch.h',
  'ftw.h',
  'glob.h',
  'grp.h',
  'iconv.h',
  'langinfo.h',
  'libgen.h',
  'net/if.h',
  'netdb.h',
  'netinet/in.h',
  'poll.h',
  'pthread.h',
  'pwd.h',
  'regex.h',
  'sched.h',
  'semaphore.h',
  'spawn.h',
  'strings.h',
  'sys/ipc.h',
  'sys/mman.h',
  'sys/msg.h',
  'sys/resource.h',
  'sys/select.h',
  'sys/sem.h',
  'sys/shm.h',
  'sys/socket.h',
  'sys/stat.h',
  'sys/statvfs.h',
  'sys/time.h',
  'sys/times.h',
  'sys/types.h',
  'sys/uio.h',
  'sys/un.h',
  'sys/utsname.h',
  'sys/wait.h',
  'syslog.h',
  'termios.h',
  'unistd.h',
  'utime.h',
  'wordexp.h',
];
const DARWIN_HEADERS = [
  'CommonCrypto/CommonCrypto.h',
  'copyfile.h',
  'dispatch/dispatch.h',
  'execinfo.h',
  'fts.h',
  'getopt.h',
  'ifaddrs.h',
  'libkern/OSAtomic.h',
  'libproc.h',
  'mach-o/dyld.h',
  'mach/mach.h',
  'mach/mach_time.h',
  'mach/mach_vm.h',
  'malloc/malloc.h',
  'os/lock.h',
  'os/log.h',
  'sys/event.h',
  'sys/ioctl.h',
  'sys/mount.h',
  'sys/proc_info.h',
  'sys/ptrace.h',
  'sys/random.h',
  'sys/sysctl.h',
  'uuid/uuid.h',
  'xpc/xpc.h',
];
const DARWIN_ARGS = ['-isysroot', SDK, '-arch', 'arm64', '-fsyntax-only'];
const darwinProvenance = `macOS SDK ${SDK_VERSION} usr/include`;
const darwinRoots = [SDK_INCLUDE];
const isDarwinInternal = (name: string): boolean => name.startsWith('__');

const units: Unit[] = [
  {
    id: 'darwin-c',
    compiler: 'clang',
    args: [...DARWIN_ARGS, '-std=c11', '-D_ANSI_SOURCE'],
    source: include(C_HEADERS),
    roots: darwinRoots,
    provenance: darwinProvenance,
    classify: (decl, header) =>
      decl.isStatic && !/ctype\.h$|wctype\.h$/.test(header)
        ? null
        : isDarwinInternal(decl.name)
          ? 'darwin'
          : 'c',
    target: 'darwin',
  },
  {
    id: 'darwin-posix',
    compiler: 'clang',
    args: [...DARWIN_ARGS, '-std=gnu11', '-D_XOPEN_SOURCE=700'],
    source: include([...C_HEADERS, ...POSIX_HEADERS]),
    roots: darwinRoots,
    provenance: darwinProvenance,
    classify: (decl) => (decl.isStatic ? null : isDarwinInternal(decl.name) ? 'darwin' : 'posix'),
    target: 'darwin',
  },
  {
    id: 'darwin-full',
    compiler: 'clang',
    args: [...DARWIN_ARGS, '-std=gnu11'],
    source: include([...C_HEADERS, ...POSIX_HEADERS, ...DARWIN_HEADERS]),
    roots: darwinRoots,
    provenance: darwinProvenance,
    classify: (decl) => (decl.isStatic ? null : 'darwin'),
    target: 'darwin',
  },
  {
    id: 'darwin-extras',
    compiler: 'clang',
    args: [...DARWIN_ARGS, '-std=gnu11'],
    source: `${include(['stdio.h', 'stdlib.h', 'string.h', 'sys/types.h', 'sys/socket.h', 'wchar.h'])}\n#include "${HAND}/darwin-extras.h"`,
    roots: [HAND + '/'],
    provenance: 'scripts/library-prototypes (Darwin libSystem checked builtins)',
    classify: () => 'darwin',
    target: 'hand',
  },
  {
    id: 'corefoundation',
    compiler: 'clang',
    args: [...DARWIN_ARGS, '-std=gnu11'],
    source: include(['CoreFoundation/CoreFoundation.h']),
    roots: [CF_INCLUDE],
    provenance: `macOS SDK ${SDK_VERSION} CoreFoundation.framework`,
    classify: (decl) => (decl.isStatic ? null : 'corefoundation'),
    target: 'darwin',
  },
];

function windowsUnit(id: string, headers: readonly string[], extra: readonly string[] = []): Unit {
  return {
    id,
    compiler: `${LLVM}/bin/clang`,
    args: [
      '--target=x86_64-w64-mingw32',
      '-fsyntax-only',
      '-nostdinc',
      '-isystem',
      `${LLVM}/lib/clang/${sh(`${LLVM}/bin/clang`, ['--version']).match(/version (\d+)/)?.[1]}/include`,
      '-isystem',
      MINGW_INCLUDE,
      '-D_WIN32_WINNT=0x0A00',
      ...extra,
    ],
    source: include(headers),
    roots: [MINGW_INCLUDE],
    provenance: `mingw-w64 ${MINGW_VERSION} include`,
    classify: () => null, // assigned by import-library membership below
    target: 'windows',
  };
}
const WINDOWS_CRT_HEADERS = [
  'conio.h',
  'ctype.h',
  'direct.h',
  'errno.h',
  'fcntl.h',
  'io.h',
  'locale.h',
  'malloc.h',
  'math.h',
  'mbstring.h',
  'process.h',
  'search.h',
  'setjmp.h',
  'signal.h',
  'stdio.h',
  'stdlib.h',
  'string.h',
  'sys/stat.h',
  'sys/timeb.h',
  'time.h',
  'wchar.h',
  'wctype.h',
  // Named-parameter sources for POSIX functions the macOS headers leave unnamed.
  'dirent.h',
  'getopt.h',
  'libgen.h',
  'pthread.h',
  'sched.h',
  'semaphore.h',
  'strings.h',
  'sys/time.h',
  'sys/types.h',
  'unistd.h',
];
const windowsUnits = [
  windowsUnit('windows-crt', WINDOWS_CRT_HEADERS),
  windowsUnit(
    'windows-api',
    [
      'windows.h',
      'winsock2.h',
      'ws2tcpip.h',
      'shellapi.h',
      'shlobj.h',
      'tlhelp32.h',
      'psapi.h',
      'wincrypt.h',
    ],
    ['-DWIN32_LEAN_AND_MEAN'],
  ),
];

const HAND_UNITS: readonly {
  id: string;
  file: string;
  library: LibraryKind;
  target: Unit['target'];
  provenance: string;
}[] = [
  {
    id: 'glibc',
    file: 'glibc.h',
    library: 'glibc',
    target: 'hand',
    provenance: 'scripts/library-prototypes/glibc.h (glibc 2.39 ABI)',
  },
  {
    id: 'cxx',
    file: 'cxx-abi.h',
    library: 'cxx',
    target: 'hand',
    provenance: 'scripts/library-prototypes/cxx-abi.h (Itanium C++ ABI)',
  },
  {
    id: 'c-extras',
    file: 'c-extras.h',
    library: 'c',
    target: 'hand',
    provenance: 'scripts/library-prototypes/c-extras.h (libc runtime support)',
  },
];

function dump(unit: Unit): string {
  const source = join(OUT, '..', `.${unit.id}.c`);
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, unit.source);
  try {
    // Header errors that leave some declarations unusable still dump the rest.
    const result = spawnSync(unit.compiler, [...unit.args, '-Xclang', '-ast-dump=json', source], {
      encoding: 'utf8',
      maxBuffer: 1 << 30,
    });
    if (!result.stdout.includes('"inner"'))
      throw new Error(`${unit.id}: ${result.stderr.slice(0, 2000)}`);
    const errors = result.stderr.match(/error:/g)?.length ?? 0;
    if (/fatal error:/.test(result.stderr))
      throw new Error(`${unit.id}: ${result.stderr.slice(0, 1000)}`);
    if (errors)
      console.log(
        `  ${errors} header error(s); first: ${result.stderr.split('\n').find((line) => /error:/.test(line))}`,
      );
    return result.stdout;
  } finally {
    rmSync(source, { force: true });
  }
}

/* Windows import libraries: which DLL exports a name. */
function importNames(archive: string): Set<string> {
  if (!existsSync(`${MINGW}/lib/${archive}`)) return new Set();
  const text = sh(`${LLVM}/bin/llvm-nm`, ['--defined-only', `${MINGW}/lib/${archive}`]);
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const match = /^\S+ [TIt] (?!__imp_)(\S+)$/.exec(line);
    if (match) names.add(match[1]!);
  }
  return names;
}

interface Row {
  readonly name: string;
  readonly returns: string;
  readonly parameters: string;
  readonly flags: string;
  readonly header: string;
  readonly signature: string;
}
interface VariableRow {
  readonly name: string;
  readonly type: string;
  readonly constant: boolean;
  readonly header: string;
}
const modules = new Map<
  LibraryKind,
  { rows: Map<string, Row>; variables: Map<string, VariableRow>; provenance: string }
>();
const skipped = new Map<string, number>();

function moduleFor(library: LibraryKind, provenance: string) {
  let module = modules.get(library);
  if (!module) {
    module = { rows: new Map(), variables: new Map(), provenance };
    modules.set(library, module);
  }
  return module;
}

const cleanName = (name: string | null, index: number): string => {
  const stripped = (name ?? '').replace(/^_+/, '');
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(stripped) ? stripped : `a${index + 1}`;
};

/** Parameter names of functions the Darwin headers declare without names, taken from the
 * mingw-w64 declaration of the same function when the arity matches (`_MaxCount` ->
 * `max_count`). Filled from the Windows CRT translation unit. */
const supplement = new Map<string, readonly string[]>();
const handNames = new Map<string, readonly string[]>();
for (const line of readFileSync(join(HAND, 'parameter-names.txt'), 'utf8').split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue;
  const colon = line.indexOf(':');
  const names = line
    .slice(colon + 1)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const name of line.slice(0, colon).trim().split(/\s+/)) handNames.set(name, names);
}
/** Names for an unnamed declaration of `arity` parameters: the hand table (a trailing
 * `f`/`l` math variant inherits its base function), then the mingw-w64 declaration. */
function borrowedNames(name: string, arity: number): readonly string[] | undefined {
  for (const candidate of [name, name.replace(/[fl]$/, '')]) {
    const names = handNames.get(candidate);
    if (names?.length === arity) return names;
  }
  const names = supplement.get(name);
  return names?.length === arity ? names : undefined;
}
const snake = (name: string): string =>
  name
    .replace(/^_+/, '')
    .replace(/(?<=[a-z0-9])(?=[A-Z])/g, '_')
    .toLowerCase();

function formatRule(decl: Decl, resolver: Resolver): { kind: 'f' | 's'; index: number } | null {
  if (!decl.variadic) return null;
  const printf =
    /(?:^|_)(?:f|s|sn|d|as|v|w)?printf(?:_s)?$|^(?:err|warn|syslog|NSLog)x?$|^__.*printf_chk$|^__syslog_chk$/;
  const scanf = /scanf/;
  if (!decl.formatted && !printf.test(decl.name) && !scanf.test(decl.name)) return null;
  for (let index = decl.parameters.length - 1; index >= 0; index--) {
    let spec: TypeSpec;
    try {
      spec = resolver.value(decl.parameters[index]!.type);
    } catch {
      continue;
    }
    if (typeof spec === 'object' && spec.kind === 'pointer' && spec.to === 'char')
      return { kind: scanf.test(decl.name) ? 's' : 'f', index };
    if (typeof spec === 'object' && spec.kind === 'pointer') continue;
    return null;
  }
  return null;
}

const OPEN_FLAGS: Record<string, number> = { open: 1, openat: 2 };
const PARAMETER_OVERRIDES: Record<string, Record<number, TypeSpec>> = {
  setjmp: { 0: { kind: 'pointer', to: 'void' } },
  _setjmp: { 0: { kind: 'pointer', to: 'void' } },
  longjmp: { 0: { kind: 'pointer', to: 'void' } },
  _longjmp: { 0: { kind: 'pointer', to: 'void' } },
  sigsetjmp: { 0: { kind: 'pointer', to: 'void' } },
  siglongjmp: { 0: { kind: 'pointer', to: 'void' } },
};

function addUnit(
  unit: Unit,
  data: Collected,
  classify: (decl: Decl, header: string) => LibraryKind | null,
  resolver: Resolver,
): void {
  for (const decl of data.decls.values()) {
    const header = relative(unit.roots.find((root) => decl.file.startsWith(root)) ?? '', decl.file);
    const library = classify(decl, header);
    if (!library) continue;
    const module = moduleFor(library, unit.provenance);
    if (module.rows.has(decl.name)) continue;
    try {
      const returns = resolver.value(
        decl.returns === 'void (*)(void)' ? 'void (*)(void)' : decl.returns,
      );
      const borrowed = decl.parameters.some((item) => !item.name)
        ? borrowedNames(decl.name, decl.parameters.length)
        : undefined;
      const named = borrowed
        ? decl.parameters.map((item, index) => ({ ...item, name: item.name ?? borrowed[index]! }))
        : decl.parameters;
      const parameters = named.map((parameter, index) => {
        const override = PARAMETER_OVERRIDES[decl.name]?.[index];
        const spec = override ?? resolver.value(parameter.type);
        if (spec === 'void') throw new Unsupported('void parameter');
        return `${cleanName(parameter.name, index)}:${encode(spec)}`;
      });
      const names = new Set<string>();
      const unique = parameters.map((entry, index) => {
        let name = entry.slice(0, entry.indexOf(':'));
        while (names.has(name)) name = `${name}${index + 1}`;
        names.add(name);
        return `${name}${entry.slice(entry.indexOf(':'))}`;
      });
      const rule = formatRule(decl, resolver);
      const open = OPEN_FLAGS[decl.name];
      const flags = `${decl.noreturn ? 'n' : ''}${decl.variadic ? 'v' : ''}${rule ? `${rule.kind}${rule.index}` : ''}${open !== undefined && decl.variadic ? `o${open}` : ''}`;
      const row: Row = {
        name: decl.name,
        returns: encode(returns),
        parameters: unique.join(','),
        flags,
        header,
        signature: [
          encode(returns),
          unique.map((item) => item.slice(item.indexOf(':'))).join(','),
          flags,
        ].join('|'),
      };
      module.rows.set(decl.name, row);
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error;
      const key = error.message.replace(/:.*$/, '');
      skipped.set(key, (skipped.get(key) ?? 0) + 1);
      if (process.env.PROTOTYPES_VERBOSE) console.log(`skip ${decl.name}: ${error.message}`);
    }
  }
  for (const variable of data.variables.values()) {
    const header = relative(
      unit.roots.find((root) => variable.file.startsWith(root)) ?? '',
      variable.file,
    );
    const library = classify(
      {
        name: variable.name,
        returns: variable.type,
        parameters: [],
        variadic: false,
        noreturn: false,
        formatted: false,
        isStatic: false,
        file: variable.file,
      },
      header,
    );
    if (!library) continue;
    const module = moduleFor(library, unit.provenance);
    if (module.variables.has(variable.name)) continue;
    try {
      const spec = resolver.value(variable.type);
      if (spec === 'void') throw new Unsupported('void variable');
      module.variables.set(variable.name, {
        name: variable.name,
        type: encode(spec),
        constant: variable.constant,
        header,
      });
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error;
      const key = `variable ${error.message.replace(/:.*$/, '')}`;
      skipped.set(key, (skipped.get(key) ?? 0) + 1);
      if (process.env.PROTOTYPES_VERBOSE) console.log(`skip ${variable.name}: ${error.message}`);
    }
  }
}
const resolvers: Resolver[] = [];

/** Run one translation unit; a name an earlier unit of the same family already
 * produced (even one it could not represent) is not reintroduced. */
function runUnit(
  unit: Unit,
  windows: boolean,
  classify: (decl: Decl, header: string) => LibraryKind | null,
  seen?: Set<string>,
  precollected?: Collected,
): void {
  console.log(`clang ${unit.id}`);
  const data = precollected ?? collect(unit, dump(unit));
  const resolver = new Resolver(data, windows);
  resolvers.push(resolver);
  addUnit(
    unit,
    data,
    (decl, header) => (seen?.has(decl.name) ? null : classify(decl, header)),
    resolver,
  );
  if (seen) for (const name of [...data.decls.keys(), ...data.variables.keys()]) seen.add(name);
}

const crtNames = new Set([...importNames('libmsvcrt.a'), ...importNames('libucrt.a')]);
const crtUnit = windowsUnits.find((unit) => unit.id === 'windows-crt')!;
console.log('clang windows-crt (parameter names)');
const crtData = collect(crtUnit, dump(crtUnit));
for (const decl of crtData.decls.values())
  if (decl.parameters.length && decl.parameters.every((item) => item.name))
    supplement.set(
      decl.name,
      decl.parameters.map((item) => snake(item.name!)),
    );

const seenDarwin = new Set<string>();
// Hand-written checked builtins first: they carry parameter names the SDK omits.
for (const unit of [...units].sort((a) => (a.id === 'darwin-extras' ? -1 : 1)))
  runUnit(unit, false, unit.classify, unit.id === 'corefoundation' ? undefined : seenDarwin);

/* Windows: library by import-library membership. */
const WINDOWS_DLLS: readonly [LibraryKind, readonly string[]][] = [
  ['windows-kernel', ['libkernel32.a', 'libkernelbase.a']],
  ['windows-user', ['libuser32.a']],
  ['windows-advapi', ['libadvapi32.a']],
  ['windows-winsock', ['libws2_32.a']],
  ['windows-shell', ['libshell32.a']],
];
const dllNames = new Map<LibraryKind, Set<string>>(
  WINDOWS_DLLS.map(([library, archives]) => [
    library,
    new Set(archives.flatMap((archive) => [...importNames(archive)])),
  ]),
);
for (const unit of windowsUnits)
  runUnit(
    unit,
    true,
    (decl) => {
      if (unit.id === 'windows-crt') return crtNames.has(decl.name) ? 'windows-crt' : null;
      for (const [library] of WINDOWS_DLLS)
        if (dllNames.get(library)!.has(decl.name)) return library;
      return null;
    },
    undefined,
    unit === crtUnit ? crtData : undefined,
  );
// A Windows CRT interface identical to the ISO C entry is already covered by `c`.
{
  const crt = modules.get('windows-crt');
  const c = modules.get('c');
  if (crt && c)
    for (const [name, row] of crt.rows)
      if (c.rows.get(name)?.signature === row.signature) crt.rows.delete(name);
}

/* Hand-specified headers. */
for (const hand of HAND_UNITS) {
  const file = join(HAND, hand.file);
  runUnit(
    {
      id: hand.id,
      compiler: 'clang',
      args: ['--target=x86_64-unknown-linux-gnu', '-fsyntax-only', '-nostdinc', '-ffreestanding'],
      source: `#include "${file}"`,
      roots: [`${HAND}/`],
      provenance: hand.provenance,
      classify: () => hand.library,
      target: 'hand',
    },
    false,
    () => hand.library,
  );
}

/* ---------------------------------------------------------------- output */

const allHandles = new Map<string, string>();
for (const resolver of resolvers)
  for (const [name, code] of resolver.handles) {
    const prior = allHandles.get(name);
    if (prior !== undefined && prior !== code) throw new Error(`handle ${name} has two targets`);
    allHandles.set(name, code);
  }

function writeModule(library: LibraryKind): void {
  const module = modules.get(library)!;
  const headers: string[] = [];
  const lines: string[] = [];
  const used = new Set<string>();
  const rows = [...module.rows.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const variables = [...module.variables.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const row of rows) {
    let index = headers.indexOf(row.header);
    if (index < 0) index = headers.push(row.header) - 1;
    lines.push(`${row.name}|${row.returns}|${row.parameters}|${row.flags}|${index.toString(36)}`);
    for (const match of `${row.returns}${row.parameters}`.matchAll(/&([^;]+);/g))
      used.add(match[1]!);
  }
  // `=name|type|flags|header`: an extern data object (flag `c`: const-qualified).
  for (const variable of variables) {
    let index = headers.indexOf(variable.header);
    if (index < 0) index = headers.push(variable.header) - 1;
    lines.push(
      `=${variable.name}|${variable.type}|${variable.constant ? 'c' : ''}|${index.toString(36)}`,
    );
    for (const match of variable.type.matchAll(/&([^;]+);/g)) used.add(match[1]!);
  }
  const handleLines = [...used].sort().map((name) => `&${name}=${allHandles.get(name)!}`);
  const body = [...handleLines, ...lines].join('\n');
  if (/[`\\]|\$\{/.test(body)) throw new Error(`${library}: data needs escaping`);
  const file = join(OUT, `${library}.ts`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `// Generated by scripts/generate-library-prototypes.ts; do not edit.\n` +
      `export const provenance = ${JSON.stringify(module.provenance)};\n` +
      `export const headers: readonly string[] = ${JSON.stringify(headers)};\n` +
      `export const data = \`${body}\n\`;\n`,
  );
  console.log(
    `${library}: ${rows.length} functions, ${variables.length} variables, ${(body.length / 1024).toFixed(0)} KiB`,
  );
}
for (const library of modules.keys()) writeModule(library);
console.log('skipped:', Object.fromEntries(skipped));
if (process.env.PROTOTYPES_TYPEDEFS) {
  const counts = new Map<string, number>();
  for (const resolver of resolvers)
    for (const [name, count] of resolver.stats) counts.set(name, (counts.get(name) ?? 0) + count);
  console.log(
    [...counts]
      .sort()
      .map(([name, count]) => `${name} ${count}`)
      .join('\n'),
  );
}
