#!/usr/bin/env node
// Regenerates src/metadata/library-contracts/generated/types/*.ts: per-ABI layouts of the
// structures and unions library prototypes name (`struct stat`, `FILE`, `OVERLAPPED`) and
// the values of the curated library constants (`O_CREAT`, `MEM_COMMIT`), read from real C
// headers by clang itself:
//   - record layouts: `-Xclang -fdump-record-layouts-complete` of one wrapper structure per
//     type (`struct w { T v; }` has T's size and alignment), field types as declared;
//   - typedefs and record headers: the text AST dump of the same translation unit;
//   - constants: `enum { k = (NAME) }` folded by clang (text AST `value: Int`).
// Toolchain: the `ziglang` PyPI wheel (clang plus the glibc, Darwin libc and mingw-w64
// headers for x86_64-linux-gnu, aarch64-macos and x86_64-windows-gnu), so no SDK is needed:
//   python3 -m pip download ziglang && unzip it, then
//   ZIG=/path/to/ziglang/zig bun run library-types
// The generated modules record the zig/clang versions and header roots as provenance.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LibraryKind } from '../src/metadata/library-contracts/catalog.js';
import { CONSTANT_SETS, type ConstantSet } from '../src/metadata/library-contracts/constants.js';
import * as c from '../src/metadata/library-contracts/generated/data/c.js';
import * as corefoundation from '../src/metadata/library-contracts/generated/data/corefoundation.js';
import * as darwin from '../src/metadata/library-contracts/generated/data/darwin.js';
import * as glibc from '../src/metadata/library-contracts/generated/data/glibc.js';
import * as posix from '../src/metadata/library-contracts/generated/data/posix.js';
import * as windowsAdvapi from '../src/metadata/library-contracts/generated/data/windows-advapi.js';
import * as windowsCrt from '../src/metadata/library-contracts/generated/data/windows-crt.js';
import * as windowsKernel from '../src/metadata/library-contracts/generated/data/windows-kernel.js';
import * as windowsShell from '../src/metadata/library-contracts/generated/data/windows-shell.js';
import * as windowsUser from '../src/metadata/library-contracts/generated/data/windows-user.js';
import * as windowsWinsock from '../src/metadata/library-contracts/generated/data/windows-winsock.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/metadata/library-contracts/generated/types');
const ZIG = process.env.ZIG ?? 'zig';
// `zig env` prints ZON (0.14+) or JSON (older): read the one field either way.
const ZIG_LIB = /"?\.?lib_dir"?\s*[:=]\s*"([^"]+)"/.exec(run(ZIG, ['env']).stdout)![1]!;
const ZIG_VERSION = run(ZIG, ['version']).stdout.trim();
const CLANG_VERSION = /clang version (\S+)/.exec(run(ZIG, ['clang', '--version']).stdout)?.[1];
const INCLUDE = join(ZIG_LIB, 'libc/include');

function run(command: string, args: readonly string[], input?: string) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    ...(input === undefined ? {} : { input }),
  });
}

/* ------------------------------------------------------------------ targets */

const C_HEADERS = [
  'ctype.h',
  'errno.h',
  'fenv.h',
  'inttypes.h',
  'locale.h',
  'math.h',
  'setjmp.h',
  'signal.h',
  'stdarg.h',
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
  'netinet/tcp.h',
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
  'sys/ioctl.h',
];
const LINUX_HEADERS = [
  'sys/epoll.h',
  'sys/eventfd.h',
  'sys/inotify.h',
  'sys/prctl.h',
  'sys/ptrace.h',
  'sys/sendfile.h',
  'sys/signalfd.h',
  'sys/sysinfo.h',
  'sys/timerfd.h',
  'sys/vfs.h',
  'sys/xattr.h',
  'sys/random.h',
  'sys/file.h',
  'sys/mount.h',
  'sys/personality.h',
  'linux/futex.h',
  'ifaddrs.h',
  'getopt.h',
  'execinfo.h',
  'link.h',
  'elf.h',
];
const DARWIN_HEADERS = [
  'copyfile.h',
  'execinfo.h',
  'fts.h',
  'getopt.h',
  'ifaddrs.h',
  'libproc.h',
  'mach-o/dyld.h',
  'mach/mach.h',
  'mach/mach_time.h',
  'malloc/malloc.h',
  'os/lock.h',
  'sys/event.h',
  'sys/mount.h',
  'sys/proc_info.h',
  'sys/random.h',
  'sys/sysctl.h',
  'uuid/uuid.h',
];
const WINDOWS_HEADERS = [
  'windows.h',
  'winsock2.h',
  'ws2tcpip.h',
  'shellapi.h',
  'shlobj.h',
  'tlhelp32.h',
  'psapi.h',
  'wincrypt.h',
  'winternl.h',
  'conio.h',
  'ctype.h',
  'direct.h',
  'errno.h',
  'fcntl.h',
  'io.h',
  'locale.h',
  'malloc.h',
  'math.h',
  'process.h',
  'signal.h',
  'stdarg.h',
  'stdio.h',
  'stdlib.h',
  'string.h',
  'sys/stat.h',
  'sys/types.h',
  'sys/timeb.h',
  'time.h',
  'wchar.h',
];

interface Target {
  readonly abi: 'sysv-amd64' | 'darwin-arm64' | 'windows-x64';
  readonly args: readonly string[];
  readonly roots: readonly string[];
  readonly headers: readonly string[];
  /** Prototype families whose named types are roots. */
  readonly families: readonly { readonly name: LibraryKind; readonly data: string }[];
  /** Types no prototype names that a call site still builds (`sockaddr_in` for `connect`). */
  readonly extra: readonly string[];
  readonly provenance: string;
}
const isystem = (dirs: readonly string[]): string[] =>
  dirs.flatMap((dir) => ['-isystem', join(INCLUDE, dir)]);
const POSIX_EXTRA = [
  'struct sockaddr_in',
  'struct sockaddr_in6',
  'struct sockaddr_un',
  'struct sockaddr_storage',
  'struct in_addr',
  'struct in6_addr',
  'struct ip_mreq',
  'struct linger',
  'struct winsize',
  'struct flock',
  'struct dirent',
  'struct stat',
  'struct tm',
  'struct timeval',
  'struct timespec',
  'struct timezone',
  'struct sigaction',
  'struct addrinfo',
  'struct hostent',
  'struct pollfd',
  'struct iovec',
  'struct msghdr',
  'struct cmsghdr',
  'struct rlimit',
  'struct rusage',
  'struct utsname',
  'struct passwd',
  'struct group',
  'pthread_t',
  'pthread_attr_t',
  'pthread_mutex_t',
  'pthread_mutexattr_t',
  'pthread_cond_t',
  'pthread_condattr_t',
  'pthread_rwlock_t',
  'pthread_once_t',
  'sigset_t',
  'fd_set',
  'va_list',
  'jmp_buf',
  'siginfo_t',
  'stack_t',
  'regex_t',
  'regmatch_t',
  'glob_t',
];
const targets: readonly Target[] = [
  {
    abi: 'sysv-amd64',
    args: [
      '--target=x86_64-linux-gnu',
      '-D_GNU_SOURCE',
      ...isystem(['x86-linux-gnu', 'generic-glibc', 'x86-linux-any', 'any-linux-any']),
    ],
    roots: ['x86-linux-gnu', 'generic-glibc', 'x86-linux-any', 'any-linux-any'],
    headers: [...C_HEADERS, ...POSIX_HEADERS, ...LINUX_HEADERS],
    families: [
      { name: 'c', data: c.data },
      { name: 'posix', data: posix.data },
      { name: 'glibc', data: glibc.data },
    ],
    extra: [
      ...POSIX_EXTRA,
      'struct epoll_event',
      'struct inotify_event',
      'struct sysinfo',
      'struct statfs',
      'struct ifaddrs',
      'struct option',
      'struct dl_phdr_info',
      'Elf64_Ehdr',
      'Elf64_Phdr',
      'Elf64_Shdr',
      'Elf64_Sym',
      'Elf64_Dyn',
      'Elf64_Rela',
    ],
    provenance: `zig ${ZIG_VERSION} (clang ${CLANG_VERSION}) glibc headers, x86_64-linux-gnu`,
  },
  {
    abi: 'darwin-arm64',
    args: ['--target=arm64-apple-macos13', ...isystem(['any-darwin-any'])],
    roots: ['any-darwin-any'],
    headers: [...C_HEADERS, ...POSIX_HEADERS, ...DARWIN_HEADERS],
    families: [
      { name: 'c', data: c.data },
      { name: 'posix', data: posix.data },
      { name: 'darwin', data: darwin.data },
      { name: 'corefoundation', data: corefoundation.data },
    ],
    extra: [
      ...POSIX_EXTRA,
      'struct kevent',
      'struct statfs',
      'struct ifaddrs',
      'struct option',
      'struct mach_header_64',
      'struct load_command',
      'struct segment_command_64',
      'struct section_64',
      'struct proc_bsdinfo',
    ],
    provenance: `zig ${ZIG_VERSION} (clang ${CLANG_VERSION}) Darwin libc headers, arm64-apple-macos13`,
  },
  {
    abi: 'windows-x64',
    args: [
      '--target=x86_64-w64-mingw32',
      '-D_WIN32_WINNT=0x0A00',
      '-DWIN32_LEAN_AND_MEAN',
      ...isystem(['any-windows-any']),
    ],
    roots: ['any-windows-any'],
    headers: WINDOWS_HEADERS,
    families: [
      { name: 'c', data: c.data },
      { name: 'windows-crt', data: windowsCrt.data },
      { name: 'windows-kernel', data: windowsKernel.data },
      { name: 'windows-user', data: windowsUser.data },
      { name: 'windows-advapi', data: windowsAdvapi.data },
      { name: 'windows-winsock', data: windowsWinsock.data },
      { name: 'windows-shell', data: windowsShell.data },
    ],
    extra: [
      'SECURITY_ATTRIBUTES',
      'OVERLAPPED',
      'WSADATA',
      'PROCESS_INFORMATION',
      'STARTUPINFOW',
      'STARTUPINFOA',
      'SYSTEMTIME',
      'FILETIME',
      'CRITICAL_SECTION',
      'LIST_ENTRY',
      'UNICODE_STRING',
      'GUID',
      'RECT',
      'POINT',
      'MSG',
      'WNDCLASSEXW',
      'WNDCLASSW',
      'WIN32_FIND_DATAW',
      'WIN32_FIND_DATAA',
      'LARGE_INTEGER',
      'ULARGE_INTEGER',
      'SYSTEM_INFO',
      'MEMORY_BASIC_INFORMATION',
      'PROCESSENTRY32W',
      'MODULEENTRY32W',
      'THREADENTRY32',
      'IMAGE_DOS_HEADER',
      'IMAGE_NT_HEADERS64',
      'IMAGE_SECTION_HEADER',
      'IMAGE_EXPORT_DIRECTORY',
      'IMAGE_IMPORT_DESCRIPTOR',
      'OSVERSIONINFOEXW',
      'BY_HANDLE_FILE_INFORMATION',
      'SOCKADDR_IN',
      'SOCKADDR_IN6',
      'ADDRINFOW',
      'struct addrinfo',
      'struct sockaddr_in',
      'struct sockaddr_in6',
      'struct sockaddr_storage',
      'PEB',
      'TEB',
      'CONTEXT',
      'EXCEPTION_RECORD',
      'EXCEPTION_POINTERS',
      'TOKEN_PRIVILEGES',
      'LUID',
      'SHELLEXECUTEINFOW',
      'NOTIFYICONDATAW',
      'struct stat',
      'struct _stat64',
      'struct tm',
      'va_list',
      'jmp_buf',
    ],
    provenance: `zig ${ZIG_VERSION} (clang ${CLANG_VERSION}) mingw-w64 headers, x86_64-w64-mingw32`,
  },
];

/* ------------------------------------------------------------------- clang */

function clang(target: Target, source: string, extra: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'library-types-'));
  try {
    const file = join(dir, 'unit.c');
    writeFileSync(file, source);
    const result = run(ZIG, [
      'clang',
      '-fsyntax-only',
      '-nostdinc',
      '-fno-color-diagnostics',
      '-Wno-everything',
      '-ferror-limit=0',
      '-isystem',
      join(ZIG_LIB, 'include'),
      ...target.args,
      ...extra,
      file,
    ]);
    if (/fatal error:/.test(result.stderr))
      throw new Error(`${target.abi}: ${result.stderr.slice(0, 2000)}`);
    return result.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Headers of the target that exist (zig's Darwin set lacks a few SDK-only headers). */
function presentHeaders(target: Target): string[] {
  const present: string[] = [];
  for (const header of target.headers) {
    // Each header after the ones kept so far (`psapi.h` needs `windows.h` first).
    const source = [...present, header].map((item) => `#include <${item}>`).join('\n');
    const out = run(
      ZIG,
      [
        'clang',
        '-fsyntax-only',
        '-nostdinc',
        '-isystem',
        join(ZIG_LIB, 'include'),
        ...target.args,
        '-x',
        'c',
        '-',
      ],
      `${source}\n`,
    );
    if (out.status === 0) present.push(header);
    else console.log(`  ${target.abi}: skip ${header}`);
  }
  return present;
}

/* ---------------------------------------------------------------- AST intake */

interface Typedef {
  readonly qual: string;
  readonly desugared: string;
}
interface Declarations {
  readonly typedefs: Map<string, Typedef>;
  /** Header (relative to an include root) declaring each typedef or `struct X`/`union X`. */
  readonly headers: Map<string, string>;
}

/** Top-level typedefs and record definitions from the text AST dump. The dump names a
 * file only when it changes, so the current file is the last one seen. */
function declarations(target: Target, text: string): Declarations {
  const typedefs = new Map<string, Typedef>(),
    headers = new Map<string, string>();
  let file = '';
  const header = (path: string): string => {
    for (const root of target.roots) {
      const prefix = `${join(INCLUDE, root)}/`;
      if (path.startsWith(prefix)) return path.slice(prefix.length);
    }
    return path.slice(path.lastIndexOf('/') + 1);
  };
  for (const line of text.split('\n')) {
    if (!line.startsWith('|-') && !line.startsWith('`-')) continue;
    const located = /<([^<>:]+\.h):\d+:\d+/.exec(line);
    if (located) file = located[1]!;
    let match =
      /^[|`]-TypedefDecl 0x[0-9a-f]+ .*? (?:referenced )?(\w+) '([^']*)'(?::'([^']*)')?$/.exec(
        line,
      );
    if (match) {
      const [, name, qual, desugared] = match as unknown as [string, string, string, string?];
      typedefs.set(name, { qual, desugared: desugared ?? qual });
      if (file && !headers.has(name)) headers.set(name, header(file));
      continue;
    }
    match = /^[|`]-RecordDecl 0x[0-9a-f]+ .* (struct|union) (\w+) definition$/.exec(line);
    if (match && file) headers.set(`${match[1]} ${match[2]}`, header(file));
  }
  return { typedefs, headers };
}

/* ------------------------------------------------------------------ layouts */

interface Line {
  readonly offset: number;
  readonly bitfield: boolean;
  readonly depth: number;
  readonly type: string;
  readonly name: string;
}
interface Layout {
  readonly size: number;
  readonly align: number;
  /** Lines of the wrapped type's members (depth 0 = a direct member). */
  readonly members: readonly Line[];
}

/** `*** Dumping AST Record Layout` blocks of the wrapper structures `__lt_<index>`. */
function wrapperLayouts(text: string): Map<number, Layout> {
  const layouts = new Map<number, Layout>();
  for (const block of text.split('*** Dumping AST Record Layout')) {
    const lines = block.split('\n').filter((line) => line.includes('|'));
    const head = /\|\s*struct __lt_(\d+)$/.exec(lines[0] ?? '');
    if (!head) continue;
    const sized = /\[sizeof=(\d+),.*?align=(\d+)/.exec(block);
    if (!sized) continue;
    const members: Line[] = [];
    for (const raw of lines.slice(2)) {
      const match = /^\s*(\d+)(:\d+-\d+)? \|( +)(.*?)\s*$/.exec(raw);
      if (!match) continue;
      const depth = (match[3]!.length - 1) / 2 - 2;
      if (depth < 0) continue;
      const body = match[4]!;
      // An anonymous member has no name: its type ends the line (`union X::(anonymous at f:1:2)`).
      const anonymous =
        /\)$/.test(body) && !/\(\*\)|\(\^\)/.test(body.slice(body.lastIndexOf('(')));
      const space = body.lastIndexOf(' ');
      members.push({
        offset: Number(match[1]),
        bitfield: match[2] !== undefined,
        depth,
        type: anonymous ? body : body.slice(0, space),
        name: anonymous ? '' : body.slice(space + 1),
      });
    }
    layouts.set(Number(head[1]), {
      size: Number(sized[1]),
      align: Number(sized[2]),
      members,
    });
  }
  return layouts;
}

/* -------------------------------------------------------------- type codes */

const QUALIFIERS =
  /\b(?:const|volatile|restrict|__restrict|_Nonnull|_Nullable|_Null_unspecified|__unaligned|_Atomic)\b/g;
const BUILTINS: Record<string, string> = {
  void: 'v',
  char: 'c',
  'signed char': 'a',
  'unsigned char': 'h',
  short: 's',
  'short int': 's',
  'unsigned short': 't',
  'unsigned short int': 't',
  int: 'i',
  signed: 'i',
  'signed int': 'i',
  unsigned: 'u',
  'unsigned int': 'u',
  long: 'l',
  'long int': 'l',
  'unsigned long': 'm',
  'unsigned long int': 'm',
  'long long': 'q',
  'long long int': 'q',
  'unsigned long long': 'r',
  'unsigned long long int': 'r',
  float: 'f',
  double: 'd',
  'long double': 'e',
  _Bool: 'o',
  bool: 'o',
};
/** Typedef names that keep a ScalarSpec of their own (`size_t` is pointer-width). */
const NAMED_SCALARS: Record<string, string> = {
  size_t: 'z',
  ssize_t: 'y',
  __darwin_size_t: 'z',
  __darwin_ssize_t: 'y',
  uintptr_t: 'z',
  intptr_t: 'y',
  ptrdiff_t: 'y',
  wchar_t: 'w',
  int64_t: 'j',
  uint64_t: 'k',
  __int64_t: 'j',
  __uint64_t: 'k',
};

class Unsupported extends Error {}

interface Pending {
  /** Record key printed and looked up (`struct stat`, `FILE`, `struct sigaction.handler`). */
  readonly key: string;
  readonly layout: Layout;
  readonly union: boolean;
}

class Types {
  /** Every record key that needs a wrapper layout. */
  readonly wanted = new Set<string>();
  readonly records = new Map<
    string,
    { size: number; align: number; union: boolean; fields: string[] }
  >();
  /** Typedef name -> record key it names (`FILE` -> `struct _IO_FILE`). */
  readonly aliases = new Map<string, string>();
  readonly missing = new Set<string>();
  constructor(
    private readonly decls: Declarations,
    private readonly abi: Target['abi'],
  ) {}

  /** The record a type spelling denotes, or null for a scalar/pointer/array. */
  recordKey(spelling: string, depth = 0): string | null {
    if (depth > 32) return null;
    const text = spelling.replace(QUALIFIERS, ' ').replace(/\s+/g, ' ').trim();
    if (/[*[(]/.test(text)) return null;
    if (/^(?:struct|union) \w+$/.test(text)) return text;
    if (Object.hasOwn(BUILTINS, text) || Object.hasOwn(NAMED_SCALARS, text)) return null;
    const typedef = this.decls.typedefs.get(text);
    if (!typedef) return null;
    const qual = typedef.qual.replace(QUALIFIERS, ' ').replace(/\s+/g, ' ').trim();
    // `typedef struct { ... } fd_set` dumps as `struct fd_set`; no such tag exists.
    if (/^(?:struct|union) \w+$/.test(qual)) return qual.endsWith(` ${text}`) ? text : qual;
    if (/[*[(]/.test(qual)) return null;
    if (/^(?:struct|union) /.test(qual)) return text;
    return this.recordKey(qual, depth + 1);
  }

  /** Encoded TypeSpec of one declared field type. */
  code(spelling: string, depth = 0): string {
    if (depth > 32) throw new Unsupported(`typedef depth ${spelling}`);
    const text = spelling.replace(/\s+/g, ' ').trim();
    if (/\(\s*[*^]\s*\)/.test(text)) return 'p';
    const array = /^(.*?)\s*((?:\[\d*\])+)$/.exec(text);
    if (array) {
      const counts = [...array[2]!.matchAll(/\[(\d*)\]/g)].map((match) => match[1]!);
      let code = this.code(array[1]!, depth + 1);
      for (const count of counts.reverse()) code = `[${count}]${code}`;
      return code;
    }
    if (text.endsWith('*')) {
      const inner = text.slice(0, -1).trim();
      const pointee = inner.replace(/\bconst\s*$/, '').trim();
      const constant = /^const\b|\bconst\b(?!.*\*)/.test(pointee);
      let to: string;
      try {
        to = this.code(pointee, depth + 1);
      } catch (error) {
        if (!(error instanceof Unsupported)) throw error;
        to = 'v';
      }
      if (to === 'p' && /\)$/.test(pointee)) return 'p';
      return `${constant ? '^' : '*'}${to}`;
    }
    const plain = text.replace(QUALIFIERS, ' ').replace(/\s+/g, ' ').trim();
    if (Object.hasOwn(BUILTINS, plain)) return BUILTINS[plain]!;
    if (Object.hasOwn(NAMED_SCALARS, plain)) return NAMED_SCALARS[plain]!;
    const fixed = /^(?:__)?(u?)int(8|16|32|64)_t$/.exec(plain);
    if (fixed)
      return (
        fixed[1] ? { 8: 'h', 16: 't', 32: 'u', 64: 'k' } : { 8: 'a', 16: 's', 32: 'i', 64: 'j' }
      )[Number(fixed[2]) as 8 | 16 | 32 | 64];
    if (plain.startsWith('enum ')) return 'i';
    if (
      /^(?:_Complex|__int128|unsigned __int128|_Float16|__fp16|__bf16)/.test(plain) ||
      /vector|ext_vector/.test(plain)
    )
      throw new Unsupported(`builtin ${plain}`);
    if (/^(?:struct|union) /.test(plain)) {
      if (!/^(?:struct|union) \w+$/.test(plain)) throw new Unsupported(`anonymous ${plain}`);
      this.want(plain);
      return `@${plain};`;
    }
    const typedef = this.decls.typedefs.get(plain);
    if (!typedef) throw new Unsupported(`unknown type ${plain}`);
    if (typedef.desugared.startsWith('enum ') || typedef.qual.startsWith('enum ')) return 'i';
    const record = this.recordKey(plain);
    if (record !== null) {
      this.want(record);
      if (record !== plain) this.aliases.set(plain, record);
      return `@${record};`;
    }
    return this.code(typedef.qual, depth + 1);
  }

  want(key: string): void {
    if (!this.records.has(key) && !this.missing.has(key)) this.wanted.add(key);
  }

  add(item: Pending): void {
    this.record(
      item.key,
      item.union,
      item.layout.size,
      item.layout.align,
      item.layout.members,
      0,
      0,
    );
  }

  /** Fields of one record whose members are the `depth` lines of `members` (absolute
   * offsets, made relative to `base`). Anonymous members are flattened into their parent
   * (C11 6.7.2.1p13); a member of unnamed record type becomes the record `<key>.<member>`
   * (size 0: unknown). Bit-fields and members of unsupported types are left out. */
  private record(
    key: string,
    union: boolean,
    size: number,
    align: number,
    members: readonly Line[],
    base: number,
    depth: number,
  ): void {
    const fields: string[] = [];
    const names = new Set<string>();
    const walk = (from: number, to: number, level: number): void => {
      for (let index = from; index < to; index++) {
        const line = members[index]!;
        if (line.depth !== level) continue;
        let end = index + 1;
        while (end < to && members[end]!.depth > level) end++;
        if (line.bitfield) continue;
        if (!line.name) {
          walk(index + 1, end, level + 1);
          continue;
        }
        if (names.has(line.name)) continue;
        let code: string;
        if (/\((?:unnamed|anonymous)[^)]*\)$/.test(line.type)) {
          const nested = `${key}.${line.name}`;
          this.record(
            nested,
            line.type.startsWith('union '),
            0,
            0,
            members.slice(index + 1, end),
            line.offset,
            level + 1,
          );
          code = `@${nested};`;
        } else {
          try {
            code = this.code(line.type);
          } catch (error) {
            if (!(error instanceof Unsupported)) throw error;
            continue;
          }
        }
        names.add(line.name);
        fields.push(`${line.name}:${line.offset - base}:${code}`);
      }
    };
    walk(0, members.length, depth);
    this.records.set(key, { size, align, union, fields });
    this.wanted.delete(key);
  }
}

/** Opaque type names a prototype family references (`@struct stat;`, `@FILE;`). */
function prototypeRoots(target: Target): Set<string> {
  const names = new Set<string>();
  for (const family of target.families)
    for (const match of family.data.matchAll(/@!?([^;]+);/g)) names.add(match[1]!);
  for (const name of target.extra) names.add(name);
  return names;
}

/** Prototype spellings from the macOS SDK name glibc/mingw types by their Darwin names. */
function nativeName(name: string, target: Target): string {
  return target.abi === 'darwin-arm64'
    ? name
    : name.replace(/^__darwin_/, '').replace(/^struct _xlocale$/, 'locale_t');
}

/* --------------------------------------------------------------- constants */

function constants(target: Target, includes: string): string[] {
  const names = [
    ...new Set(
      Object.values(CONSTANT_SETS as Record<string, ConstantSet>).flatMap((set) => [
        ...set.names,
        ...(set.fields ?? []).flatMap((field) => [field.mask, ...field.names]),
      ]),
    ),
  ].filter((name) => /^[A-Za-z_]\w*$/.test(name));
  const source = `${includes}\n${names.map((name, index) => `enum { __k_${index} = (long long)(${name}) };`).join('\n')}\n`;
  const text = clang(target, source, ['-Xclang', '-ast-dump']);
  const values = new Map<string, bigint>();
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const match = /EnumConstantDecl 0x[0-9a-f]+ .* __k_(\d+) '/.exec(lines[index]!);
    if (!match) continue;
    for (let next = index + 1; next < Math.min(lines.length, index + 4); next++) {
      const value = /value: Int (-?\d+)/.exec(lines[next]!);
      if (value) {
        values.set(names[Number(match[1])]!, BigInt(value[1]!));
        break;
      }
    }
  }
  return names
    .filter((name) => values.has(name))
    .map((name) => {
      const value = values.get(name)!;
      return `${name}=${value < 0n ? `-${(-value).toString(16)}` : value.toString(16)}`;
    });
}

/* ------------------------------------------------------------------ driver */

function generate(target: Target): void {
  console.log(`clang ${target.abi}`);
  const headers = presentHeaders(target);
  const includes = headers.map((header) => `#include <${header}>`).join('\n');
  const decls = declarations(target, clang(target, `${includes}\n`, ['-Xclang', '-ast-dump']));
  const types = new Types(decls, target.abi);
  const roots = new Map<string, string>();
  for (const name of prototypeRoots(target)) {
    const native = nativeName(name, target);
    const key = types.recordKey(native) ?? (/^(?:struct|union) \w+$/.test(native) ? native : null);
    if (key === null) continue;
    roots.set(name, key);
    types.want(key);
    if (native !== key) types.aliases.set(native, key);
    if (name !== native) types.aliases.set(name, native === key ? key : native);
  }
  for (let round = 0; types.wanted.size && round < 8; round++) {
    const batch = [...types.wanted];
    const wrappers = batch.map((key, index) => `struct __lt_${index} { ${key} v; };`).join('\n');
    const layouts = wrapperLayouts(
      clang(target, `${includes}\n${wrappers}\n`, ['-Xclang', '-fdump-record-layouts-complete']),
    );
    batch.forEach((key, index) => {
      const layout = layouts.get(index);
      if (!layout || !layout.members.length) {
        types.missing.add(key);
        types.wanted.delete(key);
        return;
      }
      const head = /^(struct|union) /.exec(key);
      const typedef = decls.typedefs.get(key);
      const union = head ? head[1] === 'union' : /^union /.test(typedef?.desugared ?? '');
      types.add({ key, layout, union });
    });
    console.log(`  round ${round}: ${batch.length} wanted, ${types.records.size} records`);
  }
  const values = constants(target, includes);
  // Aliases of records that exist only.
  const aliasLines = [...types.aliases]
    .filter(([name, key]) => name !== key && (types.records.has(key) || types.aliases.has(key)))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, key]) => `=${name}|${key}`);
  const headerList: string[] = [];
  const headerIndex = (key: string): string => {
    const header = decls.headers.get(key) ?? '';
    let index = headerList.indexOf(header);
    if (index < 0) index = headerList.push(header) - 1;
    return index.toString(36);
  };
  const recordLines = [...types.records]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(
      ([key, record]) =>
        `${key}|${record.size}|${record.align}|${record.union ? 'u' : 's'}|${headerIndex(key.split('.')[0]!)}|${record.fields.join(',')}`,
    );
  const body = [...aliasLines, ...recordLines].join('\n');
  if (/[`\\]|\$\{/.test(body)) throw new Error(`${target.abi}: data needs escaping`);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, `${target.abi}.ts`),
    `// Generated by scripts/generate-library-types.ts; do not edit.\n` +
      `export const provenance = ${JSON.stringify(target.provenance)};\n` +
      `export const headers: readonly string[] = ${JSON.stringify(headerList)};\n` +
      `export const records = \`${body}\n\`;\n` +
      `export const constants = \`${values.join('\n')}\n\`;\n`,
  );
  console.log(
    `${target.abi}: ${types.records.size} records, ${aliasLines.length} aliases, ${values.length} constants, ${((body.length + values.join('\n').length) / 1024).toFixed(0)} KiB; missing ${types.missing.size}`,
  );
  if (process.env.LIBRARY_TYPES_VERBOSE) console.log([...types.missing].sort().join('\n'));
}

for (const target of targets)
  if (!process.env.LIBRARY_TYPES_ABI || process.env.LIBRARY_TYPES_ABI === target.abi)
    generate(target);
