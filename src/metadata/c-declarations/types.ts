/** Target ABI for C base-type sizes and layout; matches `signatureSchema.abi`. */
export interface CDeclarationTarget {
  readonly abi: 'darwin-arm64' | 'windows-x64' | 'sysv-amd64';
}

export interface CStructureField {
  /** The field name; the type library derives the durable field identity from it. */
  readonly id: string;
  readonly name: string;
  readonly offset: bigint;
  /** Parser key of the field's type. */
  readonly type_id: string;
}

/**
 * The internal (bigint) `RecoveredType` shape from `src/core/model.ts`, except that every type
 * reference (`pointer.to`, `array.element`, `vector.element`, structure `type_id`) is a parser
 * key and structure field `id` is the field name.
 */
export type CTypeDefinition =
  | { readonly kind: 'void' }
  | { readonly kind: 'unknown'; readonly size: bigint | null }
  | { readonly kind: 'integer'; readonly bits: number; readonly signed: boolean }
  | { readonly kind: 'float'; readonly bits: 16 | 32 | 64 | 80 | 128 }
  | { readonly kind: 'pointer'; readonly to: string; readonly bits: 64 }
  | { readonly kind: 'array'; readonly element: string; readonly count: bigint | null }
  | { readonly kind: 'vector'; readonly element: string; readonly lanes: number }
  | {
      readonly kind: 'structure';
      readonly size: bigint | null;
      readonly alignment: number | null;
      readonly fields: readonly CStructureField[];
    };

export interface CParsedType {
  readonly key: string;
  /** The C name (tag or typedef) when the type was declared by name; null for builtin and anonymous types. */
  readonly name: string | null;
  readonly definition: CTypeDefinition;
}

/** 1-based line and column (UTF-16 code units). */
export interface CDiagnostic {
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

export interface CParseResult {
  /** Dependencies first (cycles through pointers excepted), otherwise in declaration order. */
  readonly types: readonly CParsedType[];
  /** C name (struct/union/enum tag or typedef name) -> key into `types`. */
  readonly named: ReadonlyMap<string, string>;
  readonly diagnostics: readonly CDiagnostic[];
}
