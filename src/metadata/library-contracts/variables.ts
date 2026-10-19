import type { AbiProfile } from '../../core/index.js';
import { ABI_TYPEDEFS, type AbiTypedef, type ScalarSpec, type TypeSpec } from './spec.js';

/** Storage shape of a library scalar type on one ABI. */
export type LibraryScalar =
  | { readonly kind: 'void'; readonly name: string }
  | {
      readonly kind: 'integer';
      readonly bits: number;
      readonly signed: boolean;
      readonly name: string;
    }
  | { readonly kind: 'float'; readonly bits: 32 | 64 | 80 | 128; readonly name: string };

export type PlainScalar = Exclude<ScalarSpec, 'fnptr' | 'va_list' | AbiTypedef>;

/** Width, signedness and C name of a plain library scalar on `abi`. ABI typedefs and
 * code/`va_list` pointers are resolved by the caller. */
export function libraryScalar(spec: PlainScalar, abi: AbiProfile): LibraryScalar {
  const { layout } = abi;
  const integer = (bits: number, signed: boolean, name: string = spec): LibraryScalar => ({
    kind: 'integer',
    bits,
    signed,
    name,
  });
  switch (spec) {
    case 'void':
      return { kind: 'void', name: spec };
    case 'char':
    case 'schar':
      return integer(layout.char_bits, true);
    case 'uchar':
    case 'bool':
      return integer(layout.char_bits, false);
    case 'short':
      return integer(layout.short_bits, true);
    case 'ushort':
      return integer(layout.short_bits, false);
    case 'int':
      return integer(layout.int_bits, true);
    case 'uint':
      return integer(layout.int_bits, false);
    case 'long':
      return integer(layout.long_bits, true);
    case 'ulong':
      return integer(layout.long_bits, false);
    case 'longlong':
      return integer(layout.long_long_bits, true);
    case 'ulonglong':
      return integer(layout.long_long_bits, false);
    case 'int64':
      return integer(64, true);
    case 'uint64':
      return integer(64, false);
    case 'size_t':
      return integer(layout.pointer_bits, false);
    case 'ssize_t':
      return integer(layout.pointer_bits, true);
    case 'wchar':
      return abi.id === 'windows-x64'
        ? integer(16, false, 'wchar_t')
        : integer(32, true, 'wchar_t');
    case 'float':
      return { kind: 'float', bits: layout.float_bits, name: spec };
    case 'double':
      return { kind: 'float', bits: layout.double_bits, name: spec };
    case 'longdouble':
      return { kind: 'float', bits: layout.long_double_bits, name: spec };
  }
}

/** Column of `ABI_TYPEDEFS` the ABI selects. */
export const abiTypedefColumn = (abi: AbiProfile): 0 | 1 | 2 =>
  abi.id === 'darwin-arm64' ? 0 : abi.id === 'sysv-amd64' ? 1 : 2;

export const isAbiTypedef = (spec: ScalarSpec): spec is AbiTypedef => Object.hasOwn(ABI_TYPEDEFS, spec);

/** The declared type of a library data object as the source view spells it. */
export interface VariableType {
  readonly kind: 'pointer' | 'integer' | 'float';
  readonly bits: number;
  readonly signed: boolean;
  /** C spelling: `FILE*`, `const char*`, `int32_t`, `CFStringRef`. */
  readonly c: string;
  /** Python-like element spelling: `pointer[FILE]`, `int32_t`. */
  readonly python: string;
  /** Opaque tags the C spelling needs `typedef struct <name> <name>;` for. */
  readonly opaque: readonly string[];
  /** Named pointer typedefs the C spelling needs: `typedef <target>* <name>;`. */
  readonly handles: readonly { readonly name: string; readonly target: string }[];
}

interface Spelled {
  readonly c: string;
  readonly python: string;
  readonly opaque: readonly string[];
  readonly handles: readonly { readonly name: string; readonly target: string }[];
}

const KEYWORD_TAG = /^(?:struct|union|enum) /;

/** Describe the type of an extern data object. Only whole scalars, pointers and
 * named pointer typedefs qualify; code pointers, `va_list`, aggregates, anonymous
 * opaque types and extended-precision floats have no spelling here, so the object
 * keeps the type its observed accesses give it. */
export function describeVariableType(spec: TypeSpec, abi: AbiProfile): VariableType | undefined {
  const column = abiTypedefColumn(abi);
  const scalar = (type: ScalarSpec): LibraryScalar | undefined => {
    if (isAbiTypedef(type)) return scalar(ABI_TYPEDEFS[type][column]);
    if (type === 'fnptr' || type === 'va_list') return undefined;
    return libraryScalar(type, abi);
  };
  const spell = (type: TypeSpec): Spelled | undefined => {
    if (typeof type === 'string') {
      const found = scalar(type);
      if (!found) return undefined;
      if (found.kind === 'void') return { c: 'void', python: 'void', opaque: [], handles: [] };
      if (found.kind === 'float') {
        if (found.bits !== 32 && found.bits !== 64) return undefined;
        const name = found.bits === 32 ? 'float' : 'double';
        return { c: name, python: name, opaque: [], handles: [] };
      }
      const name =
        found.name === 'char' || found.name === 'wchar_t'
          ? found.name
          : `${found.signed ? 'int' : 'uint'}${found.bits}_t`;
      return { c: name, python: name, opaque: [], handles: [] };
    }
    if (type.kind === 'pointer') {
      const inner = spell(type.to);
      if (!inner) return undefined;
      const innerPointer = inner.c.endsWith('*');
      return {
        c: `${type.const && !innerPointer ? 'const ' : ''}${inner.c}${type.const && innerPointer ? ' const' : ''}*`,
        python: `pointer[${inner.python}]`,
        opaque: inner.opaque,
        handles: inner.handles,
      };
    }
    if (type.kind === 'opaque') {
      if (type.spelled === false) return undefined;
      return {
        c: type.name,
        python: type.name,
        opaque: KEYWORD_TAG.test(type.name) ? [] : [type.name],
        handles: [],
      };
    }
    // A named pointer typedef: its pointee is the typedef's target.
    const target = spell(type.to);
    if (!target) return undefined;
    return {
      c: type.name,
      python: type.name,
      opaque: target.opaque,
      handles: [...target.handles, { name: type.name, target: target.c }],
    };
  };
  const spelled = spell(spec);
  if (!spelled) return undefined;
  if (typeof spec === 'object') {
    // An aggregate by value is not a scalar object.
    if (spec.kind === 'opaque') return undefined;
    return {
      kind: 'pointer',
      bits: abi.layout.pointer_bits,
      signed: false,
      ...spelled,
    };
  }
  const found = scalar(spec);
  if (!found || found.kind === 'void') return undefined;
  return {
    kind: found.kind,
    bits: found.bits,
    signed: found.kind === 'integer' ? found.signed : true,
    ...spelled,
  };
}
