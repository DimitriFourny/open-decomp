export type TypeSpec = 'void' | 'char' | 'wchar' | 'int' | 'uint' | 'long' | 'ulong' | 'size_t' | 'ssize_t'
  | { readonly kind: 'pointer'; readonly to: TypeSpec }
  | { readonly kind: 'opaque'; readonly name: string };
export interface ArgumentMemory {
  readonly argument: number; readonly access: 'read' | 'write' | 'read_write';
  /** Footprint bound, not a claim that every byte was accessed or initialized. */
  readonly extent: { readonly kind: 'unknown' } | { readonly kind: 'constant'; readonly bytes: bigint } | { readonly kind: 'argument'; readonly index: number };
}
export interface CatalogEntry {
  readonly library: 'c' | 'posix' | 'darwin' | 'cxx' | 'objc' | 'swift-core' | 'swift-concurrency' | 'windows-crt' | 'windows-kernel';
  readonly returns: TypeSpec; readonly parameters: readonly (readonly [string, TypeSpec])[];
  readonly noreturn?: boolean; readonly variadic?: boolean;
  readonly variadic_rule?: { readonly kind: 'format' | 'open_flags' | 'fcntl_command' | 'ioctl_command'; readonly argument: number };
  readonly memory?: readonly ArgumentMemory[]; readonly captures?: readonly number[]; readonly returns_argument?: number;
  readonly source: string;
}
const ptr = (to: TypeSpec): TypeSpec => ({ kind: 'pointer', to });
const V = ptr('void'), C = ptr('char'), W = ptr('wchar'), CC = ptr(C), I = ptr('int'), U = ptr('uint');
const FILE = ptr({ kind: 'opaque', name: 'FILE' }), FN = ptr({ kind: 'opaque', name: 'function' }), OVERLAPPED = ptr({ kind: 'opaque', name: 'OVERLAPPED' });
const footprint = (argument: number, access: ArgumentMemory['access'], extent: ArgumentMemory['extent'] = { kind: 'unknown' }): ArgumentMemory => ({ argument, access, extent });
const count = (index: number): ArgumentMemory['extent'] => ({ kind: 'argument', index });
const bytes = (size: bigint): ArgumentMemory['extent'] => ({ kind: 'constant', bytes: size });
const C_STANDARD = 'https://www.open-std.org/jtc1/sc22/wg14/www/docs/n1570.pdf';
const POSIX = 'https://pubs.opengroup.org/onlinepubs/9799919799/idx/functions.html';
const APPLE = 'https://github.com/apple-oss-distributions/Libc';
const CRT = 'https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/crt-alphabetical-function-reference';
const KERNEL = 'https://learn.microsoft.com/en-us/windows/win32/api/';
function entry(library: CatalogEntry['library'], returns: TypeSpec, parameters: CatalogEntry['parameters'], extra: Omit<Partial<CatalogEntry>, 'library' | 'returns' | 'parameters'> = {}): CatalogEntry {
  const source = library === 'c' ? C_STANDARD : library === 'posix' ? POSIX : library === 'windows-crt' ? CRT : library === 'windows-kernel' ? KERNEL : APPLE;
  return { library, returns, parameters, source, ...extra };
}

/** Structured declarations only. These are conditional library contracts, not
 * proof of the loaded implementation or a promise of purity. Pointer qualifiers
 * and full function-pointer source types are not represented by the core model.
 * Footprints describe selected pointed arguments, not all possible effects.
 */
export const catalog: Readonly<Record<string, CatalogEntry>> = {
  exit: entry('c', 'void', [['status', 'int']], { noreturn: true }),
  _Exit: entry('c', 'void', [['status', 'int']], { noreturn: true }),
  quick_exit: entry('c', 'void', [['status', 'int']], { noreturn: true }),
  abort: entry('c', 'void', [], { noreturn: true }),
  _exit: entry('posix', 'void', [['status', 'int']], { noreturn: true }),
  __assert_rtn: entry('darwin', 'void', [['function', C], ['file', C], ['line', 'int'], ['expression', C]], { noreturn: true, memory: [footprint(0, 'read'), footprint(1, 'read'), footprint(3, 'read')] }),
  __stack_chk_fail: entry('darwin', 'void', [], { noreturn: true }),
  __cxa_throw: entry('cxx', 'void', [['exception', V], ['type_info', V], ['destructor', FN]], { noreturn: true, source: 'https://itanium-cxx-abi.github.io/cxx-abi/abi-eh.html' }),
  __cxa_rethrow: entry('cxx', 'void', [], { noreturn: true, source: 'https://itanium-cxx-abi.github.io/cxx-abi/abi-eh.html' }),
  _ZSt9terminatev: entry('cxx', 'void', [], { noreturn: true, source: 'https://github.com/llvm/llvm-project/tree/main/libcxxabi' }),
  objc_exception_throw: entry('objc', 'void', [['exception', V]], { noreturn: true, source: 'https://github.com/apple-oss-distributions/objc4' }),
  malloc: entry('c', V, [['size', 'size_t']]),
  calloc: entry('c', V, [['count', 'size_t'], ['size', 'size_t']]),
  realloc: entry('c', V, [['pointer', V], ['size', 'size_t']], { memory: [footprint(0, 'read_write')] }),
  free: entry('c', 'void', [['pointer', V]], { memory: [footprint(0, 'read_write')] }),
  memcpy: entry('c', V, [['destination', V], ['source', V], ['size', 'size_t']], { memory: [footprint(0, 'write', count(2)), footprint(1, 'read', count(2))], captures: [], returns_argument: 0 }),
  memmove: entry('c', V, [['destination', V], ['source', V], ['size', 'size_t']], { memory: [footprint(0, 'write', count(2)), footprint(1, 'read', count(2))], captures: [], returns_argument: 0 }),
  memset: entry('c', V, [['destination', V], ['value', 'int'], ['size', 'size_t']], { memory: [footprint(0, 'write', count(2))], captures: [], returns_argument: 0 }),
  memcmp: entry('c', 'int', [['left', V], ['right', V], ['size', 'size_t']], { memory: [footprint(0, 'read', count(2)), footprint(1, 'read', count(2))], captures: [] }),
  strlen: entry('c', 'size_t', [['string', C]], { memory: [footprint(0, 'read')], captures: [] }),
  strcmp: entry('c', 'int', [['left', C], ['right', C]], { memory: [footprint(0, 'read'), footprint(1, 'read')], captures: [] }),
  strncmp: entry('c', 'int', [['left', C], ['right', C], ['size', 'size_t']], { memory: [footprint(0, 'read', count(2)), footprint(1, 'read', count(2))], captures: [] }),
  puts: entry('c', 'int', [['string', C]], { memory: [footprint(0, 'read')] }),
  printf: entry('c', 'int', [['format', C]], { memory: [footprint(0, 'read')], variadic: true, variadic_rule: { kind: 'format', argument: 0 } }),
  fprintf: entry('c', 'int', [['stream', FILE], ['format', C]], { memory: [footprint(0, 'read_write'), footprint(1, 'read')], variadic: true, variadic_rule: { kind: 'format', argument: 1 } }),
  snprintf: entry('c', 'int', [['buffer', C], ['size', 'size_t'], ['format', C]], { memory: [footprint(0, 'write', count(1)), footprint(2, 'read')], variadic: true, variadic_rule: { kind: 'format', argument: 2 } }),
  read: entry('posix', 'ssize_t', [['descriptor', 'int'], ['buffer', V], ['size', 'size_t']], { memory: [footprint(1, 'write', count(2))] }),
  write: entry('posix', 'ssize_t', [['descriptor', 'int'], ['buffer', V], ['size', 'size_t']], { memory: [footprint(1, 'read', count(2))] }),
  open: entry('posix', 'int', [['path', C], ['flags', 'int']], { memory: [footprint(0, 'read')], variadic: true, variadic_rule: { kind: 'open_flags', argument: 1 } }),
  close: entry('posix', 'int', [['descriptor', 'int']]),
  fcntl: entry('posix', 'int', [['descriptor', 'int'], ['command', 'int']], { variadic: true, variadic_rule: { kind: 'fcntl_command', argument: 1 } }),
  ioctl: entry('posix', 'int', [['descriptor', 'int'], ['request', 'ulong']], { variadic: true, variadic_rule: { kind: 'ioctl_command', argument: 1 } }),
  getopt: entry('posix', 'int', [['argc', 'int'], ['argv', CC], ['options', C]], { memory: [footprint(1, 'read'), footprint(2, 'read')] }),
  atoi: entry('c', 'int', [['string', C]], { memory: [footprint(0, 'read')], captures: [] }),
  strtol: entry('c', 'long', [['string', C], ['end', CC], ['base', 'int']], { memory: [footprint(0, 'read'), footprint(1, 'write', bytes(8n))] }),
  strtoul: entry('c', 'ulong', [['string', C], ['end', CC], ['base', 'int']], { memory: [footprint(0, 'read'), footprint(1, 'write', bytes(8n))] }),
  labs: entry('c', 'long', [['value', 'long']]),
  getenv: entry('c', C, [['name', C]], { memory: [footprint(0, 'read')] }),
  strdup: entry('posix', C, [['string', C]], { memory: [footprint(0, 'read')] }),
  perror: entry('c', 'void', [['message', C]], { memory: [footprint(0, 'read')] }),
  fork: entry('posix', 'int', []),
  setsid: entry('posix', 'int', []),
  waitpid: entry('posix', 'int', [['pid', 'int'], ['status', I], ['options', 'int']], { memory: [footprint(1, 'write', bytes(4n))] }),
  pselect: entry('darwin', 'int', [['nfds', 'int'], ['readfds', V], ['writefds', V], ['exceptfds', V], ['timeout', V], ['sigmask', V]], { memory: [footprint(1, 'read_write', bytes(128n)), footprint(2, 'read_write', bytes(128n)), footprint(3, 'read_write', bytes(128n)), footprint(4, 'read', bytes(16n)), footprint(5, 'read', bytes(4n))] }),
  grantpt: entry('posix', 'int', [['descriptor', 'int']]),
  unlockpt: entry('posix', 'int', [['descriptor', 'int']]),
  ptsname: entry('posix', C, [['descriptor', 'int']]),
  execvp: entry('posix', 'int', [['file', C], ['argv', CC]], { memory: [footprint(0, 'read'), footprint(1, 'read')] }),
  signal: entry('c', FN, [['number', 'int'], ['handler', FN]], { captures: [1] }),
  sigprocmask: entry('darwin', 'int', [['how', 'int'], ['set', V], ['oldset', V]], { memory: [footprint(1, 'read', bytes(4n)), footprint(2, 'write', bytes(4n))] }),
  sigemptyset: entry('darwin', 'int', [['set', V]], { memory: [footprint(0, 'write', bytes(4n))] }),
  sigaddset: entry('darwin', 'int', [['set', V], ['number', 'int']], { memory: [footprint(0, 'read_write', bytes(4n))] }),
  __darwin_check_fd_set_overflow: entry('darwin', 'int', [['descriptor', 'int'], ['set', V], ['unlimited', 'int']]),
  objc_retain: entry('objc', V, [['object', V]], { source: 'https://github.com/apple-oss-distributions/objc4' }),
  objc_release: entry('objc', 'void', [['object', V]], { source: 'https://github.com/apple-oss-distributions/objc4' }),
  // Declarations are retained, but no C-call layout is asserted for Swift CC.
  swift_task_alloc: entry('swift-concurrency', V, [['size', 'size_t']], { source: 'https://github.com/swiftlang/swift/tree/main/include/swift/Runtime' }),
  swift_task_dealloc: entry('swift-concurrency', 'void', [['pointer', V]], { source: 'https://github.com/swiftlang/swift/tree/main/include/swift/Runtime' }),
  swift_errorRetain: entry('swift-core', V, [['error', V]], { returns_argument: 0, source: 'https://github.com/swiftlang/swift/tree/main/include/swift/Runtime' }),
  swift_errorRelease: entry('swift-core', 'void', [['error', V]], { source: 'https://github.com/swiftlang/swift/tree/main/include/swift/Runtime' }),
  _read: entry('windows-crt', 'int', [['descriptor', 'int'], ['buffer', V], ['count', 'uint']], { memory: [footprint(1, 'write', count(2))] }),
  _write: entry('windows-crt', 'int', [['descriptor', 'int'], ['buffer', V], ['count', 'uint']], { memory: [footprint(1, 'read', count(2))] }),
  _open: entry('windows-crt', 'int', [['path', C], ['flags', 'int']], { memory: [footprint(0, 'read')], variadic: true, variadic_rule: { kind: 'open_flags', argument: 1 } }),
  _close: entry('windows-crt', 'int', [['descriptor', 'int']]),
  _strdup: entry('windows-crt', C, [['string', C]], { memory: [footprint(0, 'read')] }),
  ExitProcess: entry('windows-kernel', 'void', [['exit_code', 'uint']], { noreturn: true }),
  GetModuleHandleW: entry('windows-kernel', V, [['name', W]], { memory: [footprint(0, 'read')] }),
  LoadLibraryW: entry('windows-kernel', V, [['name', W]], { memory: [footprint(0, 'read')] }),
  GetProcAddress: entry('windows-kernel', FN, [['module', V], ['name', C]], { memory: [footprint(1, 'read')] }),
  ReadFile: entry('windows-kernel', 'int', [['file', V], ['buffer', V], ['count', 'uint'], ['read', U], ['overlapped', OVERLAPPED]], { memory: [footprint(1, 'write', count(2)), footprint(3, 'write', bytes(4n)), footprint(4, 'read_write')] }),
  WriteFile: entry('windows-kernel', 'int', [['file', V], ['buffer', V], ['count', 'uint'], ['written', U], ['overlapped', OVERLAPPED]], { memory: [footprint(1, 'read', count(2)), footprint(3, 'write', bytes(4n)), footprint(4, 'read_write')] }),
};

export function identifiesLibrary(path: string, entry: CatalogEntry, format: 'macho' | 'pe' | 'elf'): boolean {
  if (format === 'pe') {
    const module = path.toLowerCase();
    if (entry.library === 'windows-kernel') return module === 'kernel32.dll' || module === 'kernelbase.dll';
    return (entry.library === 'c' || entry.library === 'windows-crt') && (module === 'ucrtbase.dll' || module === 'msvcrt.dll');
  }
  if (format === 'elf') {
    // Only explicit import attribution qualifies. A DT_NEEDED list is not a
    // symbol-to-library binding, and a Darwin library path is not ELF evidence.
    const module = path.slice(path.lastIndexOf('/') + 1);
    if (entry.library === 'c' || entry.library === 'posix') return module === 'libc.so.6';
    if (entry.library === 'cxx') return module === 'libstdc++.so.6' || module === 'libc++abi.so.1';
    return false;
  }
  if (entry.library === 'c' || entry.library === 'posix' || entry.library === 'darwin') return path === '/usr/lib/libSystem.B.dylib' || path === '/usr/lib/libSystem.dylib' || /^\/usr\/lib\/system\/libsystem_[a-z0-9_]+\.dylib$/.test(path);
  if (entry.library === 'cxx') return /^\/usr\/lib\/libc\+\+(abi)?(?:\.\d+)*\.dylib$/.test(path);
  if (entry.library === 'objc') return /^\/usr\/lib\/libobjc(?:\.A|\.\d+)*\.dylib$/.test(path);
  if (entry.library === 'swift-core') return path === '/usr/lib/swift/libswiftCore.dylib';
  if (entry.library === 'swift-concurrency') return path === '/usr/lib/swift/libswift_Concurrency.dylib';
  return false;
}
