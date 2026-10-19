/** Source-level C types of library declarations, shared by the catalog, the generated
 * header interfaces and the generator script. */

/** Typedefs whose width or signedness differ between the supported C ABIs. Values
 * are the scalar behind the name on [darwin-arm64, sysv-amd64, windows-x64]; headers
 * name them so one generated prototype serves every ABI that identifies the library. */
export const ABI_TYPEDEFS = {
  mode_t: ['ushort', 'uint', 'ushort'],
  dev_t: ['int', 'ulong', 'uint'],
  ino_t: ['uint64', 'ulong', 'ushort'],
  nlink_t: ['ushort', 'ulong', 'ushort'],
  clock_t: ['ulong', 'long', 'long'],
  time_t: ['long', 'long', 'int64'],
  suseconds_t: ['int', 'long', 'long'],
  useconds_t: ['uint', 'uint', 'uint'],
  off_t: ['int64', 'long', 'long'],
  blksize_t: ['int', 'long', 'int'],
  blkcnt_t: ['int64', 'long', 'int64'],
  wint_t: ['int', 'uint', 'ushort'],
  wctype_t: ['uint', 'ulong', 'ushort'],
  nfds_t: ['uint', 'ulong', 'ulong'],
  speed_t: ['ulong', 'uint', 'ulong'],
  tcflag_t: ['ulong', 'uint', 'ulong'],
  pthread_key_t: ['ulong', 'uint', 'uint'],
  rlim_t: ['uint64', 'ulong', 'uint64'],
  fsblkcnt_t: ['uint', 'ulong', 'uint'],
  fsfilcnt_t: ['uint', 'ulong', 'uint'],
  sa_family_t: ['uchar', 'ushort', 'ushort'],
} as const;
export type AbiTypedef = keyof typeof ABI_TYPEDEFS;

/** Source-level C types. Integers keep the ABI-dependent C name so one entry serves
 * LP64 and LLP64; `int64`/`uint64` are exactly 64 bits everywhere. */
export type ScalarSpec =
  | 'void'
  | 'char'
  | 'schar'
  | 'uchar'
  | 'short'
  | 'ushort'
  | 'int'
  | 'uint'
  | 'long'
  | 'ulong'
  | 'longlong'
  | 'ulonglong'
  | 'int64'
  | 'uint64'
  | 'float'
  | 'double'
  | 'longdouble'
  | 'bool'
  | 'wchar'
  | 'size_t'
  | 'ssize_t'
  /** Pointer to code or a block: opaque, never callable evidence. */
  | 'fnptr'
  /** `va_list` as a parameter: one pointer-sized value on the supported ABIs. */
  | 'va_list'
  | AbiTypedef;
export type TypeSpec =
  | ScalarSpec
  | {
      readonly kind: 'pointer';
      readonly to: TypeSpec;
      /** The pointee is `const`-qualified in the declaration; not an effect claim. */
      readonly const?: true;
    }
  /** A type of unknown layout. `spelled: false` keeps it anonymous in source text. */
  | { readonly kind: 'opaque'; readonly name: string; readonly spelled?: false }
  /** Named pointer typedef (`HANDLE`, `CFStringRef`) printed under its own name. */
  | { readonly kind: 'handle'; readonly name: string; readonly to: TypeSpec };

/** One-letter codes of `ScalarSpec` values in the generated data modules. */
export const SCALAR_CODES = {
  v: 'void',
  c: 'char',
  a: 'schar',
  h: 'uchar',
  s: 'short',
  t: 'ushort',
  i: 'int',
  u: 'uint',
  l: 'long',
  m: 'ulong',
  q: 'longlong',
  r: 'ulonglong',
  j: 'int64',
  k: 'uint64',
  f: 'float',
  d: 'double',
  e: 'longdouble',
  o: 'bool',
  w: 'wchar',
  z: 'size_t',
  y: 'ssize_t',
  p: 'fnptr',
  x: 'va_list',
} as const satisfies Record<string, ScalarSpec>;

