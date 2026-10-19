import type { SuppliedTypeRecord, TypeRecoveryResult } from '../analysis/types/index.js';

/** Identifier stems a library call contributes to the values it touches.
 * Everything here names a value by what a *declared library interface* says it
 * is: a header parameter name for a value passed in that position, or the
 * documented role of the callee's result. No source intent is invented, and
 * nothing is derived from register spelling or a guessed author name. */
export interface LibraryCallNames {
  /** C name the library declaration was found under (loader decoration removed). */
  readonly callee: string;
  /** Per declared parameter: a usable header name, undefined when it says nothing. */
  readonly parameters: readonly (string | undefined)[];
  /** Name of the call's result, by decreasing specificity of its evidence. */
  readonly result: LibraryResultName | undefined;
}
export interface LibraryResultName {
  /** `role`: the callee's documented result role (curated table).
   * `type`: the declared result type names what it is (`FILE*` is a stream).
   * `callee`: only the callee's own name identifies the result. */
  readonly basis: 'role' | 'type' | 'callee';
  readonly name: string;
}

/** Documented result roles of common C library functions. A role is listed
 * only when every successful return of the function is that thing (an error
 * return is a sentinel of the same kind: `fd == -1`, `stream == NULL`). */
const RESULT_ROLES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries({
    stream:
      'fopen fopen64 fdopen freopen freopen64 tmpfile tmpfile64 popen fmemopen open_memstream',
    fd: 'open open64 openat creat creat64 socket accept accept4 dup dup2 dup3 eventfd epoll_create epoll_create1 timerfd_create inotify_init inotify_init1 memfd_create',
    buffer: 'malloc calloc realloc reallocf aligned_alloc valloc memalign',
    length: 'strlen strnlen wcslen wcsnlen',
    message: 'strerror strsignal gai_strerror',
    errno_ptr: '__error __errno_location __errno _errno',
    match: 'strchr strrchr strstr strcasestr memchr memrchr strpbrk wcschr wcsrchr wcsstr',
    env_value: 'getenv secure_getenv',
    count: 'read write pread pwrite recv send recvfrom sendto readv writev fread fwrite',
    comparison: 'strcmp strncmp strcasecmp strncasecmp memcmp wcscmp wcsncmp',
    pid: 'getpid getppid fork vfork',
    token: 'strtok strtok_r strsep',
    directory: 'opendir fdopendir',
    entry: 'readdir',
    handle: 'dlopen',
    symbol: 'dlsym',
  }).flatMap(([stem, names]) => names.split(' ').map((name): [string, string] => [name, stem])),
);

/** Header parameter names that identify nothing about the value. */
const UNINFORMATIVE =
  /^(?:a|arg|args|argument|param|parameter|p|ptr|pointer|unused|reserved|dummy|unnamed|undefined)\d*$/i;

/** A declared parameter name as an identifier stem: leading underscores
 * (reserved-namespace header spelling) are removed, and a name that says
 * nothing or is not a plain identifier yields undefined. */
export function libraryParameterStem(raw: string): string | undefined {
  const name = raw.replace(/^_+/, '');
  if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) || UNINFORMATIVE.test(name)) return undefined;
  return name;
}

const snake = (text: string): string =>
  text
    .replace(/^(?:struct|union|enum)\s+/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

/** What the declared result type alone calls the value, if it is specific. */
function typeStem(
  id: string,
  records: ReadonlyMap<string, SuppliedTypeRecord>,
): string | undefined {
  const record = records.get(id);
  if (!record || record.definition.kind !== 'pointer') return undefined;
  const target = records.get(record.definition.to);
  // A named pointer typedef (`HANDLE`, `CFStringRef`) or a named opaque pointee.
  const spelling = record.spelling ?? target?.spelling;
  if (spelling !== undefined) {
    if (spelling === 'FILE') return 'stream';
    const stem = snake(spelling);
    return /^[a-z][a-z0-9_]{0,31}$/.test(stem) ? stem : undefined;
  }
  return target?.definition.kind === 'integer' && target.definition.bits === 8 ? 'str' : undefined;
}

/** The callee-specific fallback: `<callee>_result`, bounded and sanitized. */
function calleeStem(callee: string): string | undefined {
  const base = callee.replace(/^_+/, '').replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z]/.test(base) ? `${base.slice(0, 40)}_result` : undefined;
}

/** Names a library call gives its arguments and result, by call node id.
 * A call is covered only when exactly one established library signature binds
 * it, and every library declaration behind that signature has the same C name;
 * conflicting contracts name nothing. */
export function libraryCallNames(
  types: TypeRecoveryResult | undefined,
): ReadonlyMap<string, LibraryCallNames> {
  const found = new Map<string, LibraryCallNames>();
  if (!types?.signatures.length) return found;
  const contracts = new Map<string, string>();
  for (const proof of types.evidence)
    if (proof.origin.kind === 'library') contracts.set(proof.id, proof.origin.contract);
  const records = new Map<string, SuppliedTypeRecord>();
  const ambiguous = new Set<string>();
  for (const record of types.types) {
    if (records.has(record.id)) ambiguous.add(record.id);
    records.set(record.id, record);
  }
  for (const id of ambiguous) records.delete(id);
  const covered = new Map<string, (typeof types.signatures)[number] | null>();
  for (const signature of types.signatures) {
    if (signature.source !== 'library' || signature.status !== 'established') continue;
    covered.set(signature.subject_id, covered.has(signature.subject_id) ? null : signature);
  }
  for (const [call, signature] of covered) {
    if (!signature) continue;
    const callees = new Set(
      signature.evidence_ids.flatMap((id) => {
        const contract = contracts.get(id);
        return contract === undefined ? [] : [contract];
      }),
    );
    if (callees.size !== 1) continue;
    const callee = [...callees][0]!;
    const role = Object.hasOwn(RESULT_ROLES, callee) ? RESULT_ROLES[callee] : undefined;
    const typed = typeStem(signature.signature.return_type, records);
    const named = calleeStem(callee);
    found.set(call, {
      callee,
      parameters: signature.signature.parameters.map((parameter) =>
        parameter.name === null ? undefined : libraryParameterStem(parameter.name),
      ),
      result: role
        ? { basis: 'role', name: role }
        : typed
          ? { basis: 'type', name: typed }
          : named
            ? { basis: 'callee', name: named }
            : undefined,
    });
  }
  return found;
}
