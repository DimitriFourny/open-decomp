import type { CDeclarationTarget, CTypeDefinition } from './types.js';

const INTEGERS: ReadonlyMap<string, CTypeDefinition> = new Map<string, CTypeDefinition>([
  ['int8_t', { kind: 'integer', bits: 8, signed: true }],
  ['uint8_t', { kind: 'integer', bits: 8, signed: false }],
  ['int16_t', { kind: 'integer', bits: 16, signed: true }],
  ['uint16_t', { kind: 'integer', bits: 16, signed: false }],
  ['int32_t', { kind: 'integer', bits: 32, signed: true }],
  ['uint32_t', { kind: 'integer', bits: 32, signed: false }],
  ['int64_t', { kind: 'integer', bits: 64, signed: true }],
  ['uint64_t', { kind: 'integer', bits: 64, signed: false }],
  ['int128_t', { kind: 'integer', bits: 128, signed: true }],
  ['uint128_t', { kind: 'integer', bits: 128, signed: false }],
  ['bool', { kind: 'integer', bits: 8, signed: false }],
  ['float', { kind: 'float', bits: 32 }],
  ['double', { kind: 'float', bits: 64 }],
  ['long double', { kind: 'float', bits: 80 }],
  ['void', { kind: 'void' }],
]);

/** Definition of a canonical builtin key (`int32_t`, `double`, `void`, ...), or null. */
export function builtinDefinition(key: string): CTypeDefinition | null {
  return INTEGERS.get(key) ?? null;
}

/** Storage size and alignment in bytes of a scalar builtin definition. */
export function scalarBytes(definition: CTypeDefinition): number | null {
  if (definition.kind === 'integer') return definition.bits / 8;
  // x87 long double occupies a 16-byte slot (16-byte aligned) on SysV.
  if (definition.kind === 'float') return definition.bits === 80 ? 16 : definition.bits / 8;
  if (definition.kind === 'pointer') return 8;
  return null;
}

/** Typedef names the parser predefines (stdint.h, stddef.h, stdbool.h, uchar.h), mapped to builtin keys. */
export function builtinTypedefs(target: CDeclarationTarget): ReadonlyMap<string, string> {
  const entries: [string, string][] = [
    ['int8_t', 'int8_t'],
    ['uint8_t', 'uint8_t'],
    ['int16_t', 'int16_t'],
    ['uint16_t', 'uint16_t'],
    ['int32_t', 'int32_t'],
    ['uint32_t', 'uint32_t'],
    ['int64_t', 'int64_t'],
    ['uint64_t', 'uint64_t'],
    ['intptr_t', 'int64_t'],
    ['uintptr_t', 'uint64_t'],
    ['intmax_t', 'int64_t'],
    ['uintmax_t', 'uint64_t'],
    ['ptrdiff_t', 'int64_t'],
    ['ssize_t', 'int64_t'],
    ['size_t', 'uint64_t'],
    ['bool', 'bool'],
    ['_Bool', 'bool'],
    ['char16_t', 'uint16_t'],
    ['char32_t', 'uint32_t'],
    ['wchar_t', target.abi === 'windows-x64' ? 'uint16_t' : 'int32_t'],
    ['__int128_t', 'int128_t'],
    ['__uint128_t', 'uint128_t'],
  ];
  return new Map(entries);
}

export interface TypeWords {
  signed: boolean;
  unsigned: boolean;
  short: boolean;
  long: number;
  char: boolean;
  int: boolean;
  float: boolean;
  double: boolean;
  void: boolean;
  int128: boolean;
  /** MSVC `__int8`/`__int16`/`__int32`/`__int64`. */
  sized: number | null;
}

export function emptyWords(): TypeWords {
  return {
    signed: false,
    unsigned: false,
    short: false,
    long: 0,
    char: false,
    int: false,
    float: false,
    double: false,
    void: false,
    int128: false,
    sized: null,
  };
}

/** Maps a combination of C base-type keywords to a builtin key; null when the combination is invalid. */
export function resolveBaseWords(words: TypeWords, target: CDeclarationTarget): string | null {
  if (words.signed && words.unsigned) return null;
  const sign = words.unsigned ? 'u' : '';
  const integer = (bits: number): string => `${sign}int${bits}_t`;
  const only = (...flags: boolean[]): boolean => flags.every((flag) => !flag);
  if (words.void)
    return only(
      words.signed,
      words.unsigned,
      words.short,
      words.long > 0,
      words.char,
      words.int,
      words.float,
      words.double,
      words.int128,
      words.sized !== null,
    )
      ? 'void'
      : null;
  if (words.float)
    return only(
      words.signed,
      words.unsigned,
      words.short,
      words.long > 0,
      words.char,
      words.int,
      words.double,
      words.int128,
      words.sized !== null,
    )
      ? 'float'
      : null;
  if (words.double) {
    if (
      !only(
        words.signed,
        words.unsigned,
        words.short,
        words.char,
        words.int,
        words.int128,
        words.sized !== null,
      ) ||
      words.long > 1
    )
      return null;
    if (words.long === 0) return 'double';
    // `long double` is binary64 on Windows and Apple arm64; x87 extended on SysV.
    return target.abi === 'sysv-amd64' ? 'long double' : 'double';
  }
  if (words.int128) {
    return only(words.short, words.long > 0, words.char, words.int, words.sized !== null)
      ? integer(128)
      : null;
  }
  if (words.sized !== null)
    return only(words.short, words.long > 0, words.char, words.int) ? integer(words.sized) : null;
  if (words.char) return only(words.short, words.long > 0, words.int) ? integer(8) : null;
  if (words.short) return words.long === 0 ? integer(16) : null;
  if (words.long === 1) return integer(target.abi === 'windows-x64' ? 32 : 64);
  if (words.long === 2) return integer(64);
  if (words.long > 2) return null;
  return integer(32);
}
