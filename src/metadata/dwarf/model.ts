/** Bounded DWARF records. Names/declarations are display-only; offsets and DIE links carry structure.
 * Symbolic DWARF register numbers are not decoder register identifiers. */
/** Structural type evidence; names alone never establish an ABI classification. */
export interface DebugSignatureType {
  typeId?: string | undefined;
  name: string;
  kind: string;
  byteSize?: number | undefined;
  encoding?: number | undefined;
  pointeeConst?: boolean | undefined;
  /** Structural pointee chain, bounded and cycle-checked by the DWARF reader. */
  pointee?: DebugSignatureType | undefined;
}
export interface DebugSignature {
  returnType: DebugSignatureType;
  parameters: { name?: string | undefined; type: DebugSignatureType }[];
  variadic: boolean;
  callingConvention?: number | undefined;
  language?: number | undefined;
  nonReturning?: boolean | undefined;
  /** False denotes an old-style/unspecified parameter list, not a zero-argument contract. */
  prototyped: boolean;
  /** Concrete code ranges and no DW_AT_declaration; unlike a mere declaration. */
  definition?: boolean | undefined;
}

export interface DebugRange {
  start: bigint;
  end: bigint;
}
/** Symbolic storage only: these expressions are never executed against the host. */
export type DebugLocation =
  | { kind: 'address'; address: bigint }
  | { kind: 'register'; register: number }
  | { kind: 'register-offset'; register: number; offset: bigint }
  | { kind: 'frame-offset'; offset: bigint };
export interface DebugLocationEntry {
  ranges: DebugRange[];
  location: DebugLocation;
}
export interface DebugVariable {
  id: string;
  name: string;
  typeId?: string | undefined;
  functionAddress?: bigint | undefined;
  scopeId?: string | undefined;
  parameter: boolean;
  locations: DebugLocationEntry[];
  file?: string | undefined;
  line?: number | undefined;
}
export interface DebugInlineScope {
  id: string;
  name: string;
  functionAddress: bigint;
  ranges: DebugRange[];
  parentId?: string | undefined;
  callFile?: string | undefined;
  callLine?: number | undefined;
}

export interface DebugFunction {
  id: string;
  address: bigint;
  size?: bigint | undefined;
  name: string;
  prototype?: string | undefined;
  signature?: DebugSignature | undefined;
  /** Discontiguous half-open code ranges, never the gaps between them. */
  ranges?: DebugRange[] | undefined;
  frameBase?: DebugLocationEntry[] | undefined;
}
export interface DebugType {
  id: string;
  name: string;
  kind: string;
  byteSize?: number | undefined;
  detail: string;
  encoding?: number | undefined;
  alignment?: number | undefined;
  targetTypeId?: string | undefined;
  members?:
    | {
        name: string;
        typeId?: string | undefined;
        byteOffset?: number | undefined;
        bitSize?: number | undefined;
        bitOffset?: number | undefined;
      }[]
    | undefined;
  elementCount?: number | undefined;
  /** Outer-to-inner array bounds; null means not established by DWARF. */
  dimensions?: readonly (bigint | null)[] | undefined;
}
export interface DebugLine {
  address: bigint;
  file: string;
  line: number;
  column?: number | undefined;
  /** Half-open row interval; absent for rows with no known successor. */
  endAddress?: bigint | undefined;
  endSequence?: boolean | undefined;
}
export interface DebugSymbols {
  uuid: string;
  functions: DebugFunction[];
  types: DebugType[];
  lines: DebugLine[];
  diagnostics: string[];
  variables?: DebugVariable[] | undefined;
  inlineScopes?: DebugInlineScope[] | undefined;
}
