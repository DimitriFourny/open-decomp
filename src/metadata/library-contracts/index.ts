import { libraryLookupName } from '../symbols/c-names.js';
import {
  entityIdentity,
  fingerprint,
  type AbiProfile,
  type AbiSignature,
  type AbiType,
  type Address,
  type CanonicalValue,
  type Diagnostic,
  type Evidence,
  type LoadedImage,
  type OperationContext,
  type RecoveredType,
  type Signature,
} from '../../core/index.js';
import {
  ABI_TYPEDEFS,
  findDeclaration,
  type ArgumentMemory,
  type CatalogEntry,
  type TypeSpec,
} from './catalog.js';
import { abiTypedefColumn, isAbiTypedef, libraryScalar, type PlainScalar } from './variables.js';
export type { ArgumentMemory } from './catalog.js';

interface TypeSpecResolution {
  readonly definition: RecoveredType;
  readonly abi_type: AbiType;
  readonly name: string;
  readonly birth: CanonicalValue;
}
/** Code pointers are opaque: the pointee is never spelled and never callable evidence. */
const FUNCTION_POINTER: TypeSpec = {
  kind: 'pointer',
  to: { kind: 'opaque', name: 'function', spelled: false },
};

export interface LibraryType {
  readonly id: string;
  readonly name: string;
  readonly definition: RecoveredType;
  readonly abi_type: AbiType;
  readonly evidence_ids: readonly string[];
  /** Declared C name of an opaque or handle type, printed instead of an anonymous name. */
  readonly spelling?: string;
}
export interface LibraryContract {
  readonly id: string;
  readonly import_id: string;
  readonly library: string;
  readonly linkage_name: string;
  readonly slot: Address | null;
  readonly callable_entry: Address | null;
  readonly abi_state: 'supported' | 'unsupported';
  readonly abi_signature: AbiSignature;
  readonly signature: Signature | null;
  readonly noreturn: boolean;
  readonly effects: {
    readonly memory: 'unknown_read_write';
    readonly arguments: readonly ArgumentMemory[] | null;
    readonly captures: readonly number[] | null;
    readonly returns_argument: number | null;
    /** Arguments whose product sizes the fresh object the result points to (or null). */
    readonly allocates: readonly number[] | null;
  };
  readonly variadic_rule: CatalogEntry['variadic_rule'] | null;
  readonly source: string;
  readonly evidence_ids: readonly string[];
  readonly conflicts_with: readonly string[];
}
export interface LibraryContracts {
  readonly state: 'complete' | 'partial';
  readonly contracts: readonly LibraryContract[];
  readonly types: readonly LibraryType[];
  readonly evidence: readonly Evidence[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Imports bound through a nonzero relocation addend (by symbol or slot): their
 * nominal library identity does not establish the callable contract. */
function adjustedImports(image: LoadedImage, context: OperationContext): ReadonlySet<string> {
  const nonzero = new Set<string>(),
    adjustedSlots = new Set<bigint>(),
    adjustedNames = new Set<string>();
  for (const relocation of image.relocations) {
    context.checkpoint(1);
    if (relocation.symbol_id !== null && relocation.addend !== 0n) {
      nonzero.add(relocation.symbol_id);
      const slot = image.address_map.translate(relocation.address, 'va');
      if (slot.kind === 'mapped') adjustedSlots.add(slot.address.value);
    }
  }
  for (const imported of image.imports) {
    context.checkpoint(1);
    const slot = imported.slot === null ? null : image.address_map.translate(imported.slot, 'va');
    if (
      nonzero.has(imported.id) ||
      (slot?.kind === 'mapped' && adjustedSlots.has(slot.address.value))
    ) {
      adjustedNames.add(fingerprint([imported.library, imported.original_name]));
    }
  }
  return adjustedNames;
}

/** Callable import entries (virtual addresses) whose library declaration is
 * noreturn, with the import binding evidence: the same identity rules as
 * `recoverLibraryContracts` (no weak, adjusted or Swift-runtime import), and an
 * entry shared by declarations that disagree on noreturn is excluded. */
export function libraryNoreturnCalls(
  image: LoadedImage,
  context: OperationContext,
): ReadonlyMap<bigint, readonly string[]> {
  const adjusted = adjustedImports(image, context);
  const entries = new Map<bigint, { noreturn: boolean; evidence_ids: string[] }>();
  for (const imported of image.imports) {
    context.checkpoint(1);
    if (
      imported.original_name === null ||
      imported.library === null ||
      imported.callable_entry === null ||
      imported.weak ||
      adjusted.has(fingerprint([imported.library, imported.original_name]))
    )
      continue;
    const declaration = findDeclaration(
      libraryLookupName(image.target.format, imported.original_name),
      imported.library,
      image.target.format,
    );
    if (
      !declaration ||
      declaration.library === 'swift-core' ||
      declaration.library === 'swift-concurrency'
    )
      continue;
    const entry = image.address_map.translate(imported.callable_entry, 'va');
    if (entry.kind !== 'mapped') continue;
    const prior = entries.get(entry.address.value);
    entries.set(entry.address.value, {
      noreturn: (prior?.noreturn ?? true) && declaration.noreturn === true,
      evidence_ids: [...(prior?.evidence_ids ?? []), ...imported.evidence_ids],
    });
  }
  return new Map(
    [...entries].flatMap(([address, entry]) =>
      entry.noreturn ? [[address, [...new Set(entry.evidence_ids)]] as const] : [],
    ),
  );
}

/** Match exact native import names AND nominal library identity. No local symbol,
 * demangled text, ordinal guess, weak binding or nonzero import addend establishes
 * a contract. The declaration remains conditional on that library implementation;
 * it is not an authenticity check. Imported pointer storage is never a callable
 * entry. Aliased entries/slots retain incompatible alternatives and their evidence.
 * Global memory effects remain conservative even for an empty argument footprint.
 * Swift runtime declarations retain unknown calling convention instead of silently
 * borrowing C preservation rules. ABI-specific long/size_t/wchar widths are explicit.
 * One contract per declared import: the loader-bounded import table bounds the work,
 * and every import is charged to the operation budget (no separate count cap that
 * would fail images with many declared imports).
 */
export function recoverLibraryContracts(
  input: {
    readonly image: LoadedImage;
    readonly abi: AbiProfile;
    readonly revision: number;
  },
  context: OperationContext,
): LibraryContracts {
  const { image, abi, revision } = input;
  if (abi.id !== image.target.abi || abi.architecture !== image.target.architecture)
    throw new TypeError('Library contract ABI does not match the loaded target');
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new RangeError('Invalid library contract bounds');
  context.checkpoint(0);
  // ABI-dependent typedefs (`mode_t`, `time_t`...) pick their column by target ABI.
  const abiColumn = abiTypedefColumn(abi);
  const contracts: LibraryContract[] = [],
    evidence: Evidence[] = [],
    diagnostics: Diagnostic[] = [],
    types = new Map<string, LibraryType>();
  const groups = new Map<string, number[]>(),
    semantics: string[] = [];
  const adjustedNames = adjustedImports(image, context);
  let partial = false;
  const integer = (bits: number, signed: boolean, name: string): TypeSpecResolution => ({
    definition: { kind: 'integer', bits, signed },
    abi_type: { kind: 'integer', bits, signed },
    name,
    birth: ['integer', bits, signed],
  });
  const float = (bits: 32 | 64 | 80 | 128, name: string): TypeSpecResolution => ({
    definition: { kind: 'float', bits },
    abi_type: { kind: 'float', bits },
    name,
    birth: ['float', bits],
  });
  const scalar = (spec: PlainScalar): TypeSpecResolution => {
    const shape = libraryScalar(spec, abi);
    if (shape.kind === 'void')
      return { definition: { kind: 'void' }, abi_type: { kind: 'void' }, name: spec, birth: spec };
    return shape.kind === 'integer'
      ? integer(shape.bits, shape.signed, shape.name)
      : float(shape.bits, shape.name);
  };
  function resolve(spec: TypeSpec, proof: string): LibraryType {
    context.checkpoint(1);
    let resolved: TypeSpecResolution, spelling: string | undefined;
    if (typeof spec === 'string') {
      if (isAbiTypedef(spec)) return resolve(ABI_TYPEDEFS[spec][abiColumn], proof);
      if (spec === 'fnptr') return resolve(FUNCTION_POINTER, proof);
      if (spec === 'va_list') return resolve({ kind: 'pointer', to: 'void' }, proof);
      resolved = scalar(spec);
    } else if (spec.kind === 'pointer') {
      const target = resolve(spec.to, proof);
      resolved = {
        definition: { kind: 'pointer', to: target.id, bits: 64 },
        abi_type: { kind: 'pointer' },
        name: `pointer to ${target.name}`,
        birth: ['pointer', target.id],
      };
    } else if (spec.kind === 'opaque') {
      resolved = {
        definition: { kind: 'unknown', size: null },
        abi_type: { kind: 'unknown', size: null },
        name: spec.name,
        birth: ['opaque', spec.name],
      };
      if (spec.spelled !== false) spelling = spec.name;
    } else {
      const target = resolve(spec.to, proof);
      resolved = {
        definition: { kind: 'pointer', to: target.id, bits: 64 },
        abi_type: { kind: 'pointer' },
        name: spec.name,
        birth: ['handle', spec.name, target.id],
      };
      spelling = spec.name;
    }
    const { definition, abi_type, name, birth } = resolved;
    const id = entityIdentity(image.selected_slice_id, 'library-type', [abi.id, birth]),
      prior = types.get(id);
    if (prior) {
      if (!prior.evidence_ids.includes(proof))
        types.set(id, { ...prior, evidence_ids: [...prior.evidence_ids, proof] });
      return prior;
    }
    const value: LibraryType = {
      id,
      name,
      definition,
      abi_type,
      evidence_ids: [proof],
      ...(spelling === undefined ? {} : { spelling }),
    };
    types.set(id, value);
    return value;
  }
  for (const imported of image.imports) {
    context.checkpoint(1);
    if (imported.original_name === null || imported.library === null) continue;
    const name = libraryLookupName(image.target.format, imported.original_name);
    const declaration = findDeclaration(name, imported.library, image.target.format);
    if (!declaration) continue;
    if (
      imported.weak ||
      adjustedNames.has(fingerprint([imported.library, imported.original_name]))
    ) {
      partial = true;
      if (diagnostics.length < 256)
        diagnostics.push({
          code: 'unavailable_semantics',
          severity: 'info',
          message:
            'Weak or adjusted import does not establish the nominal library callable contract',
          entity_id: imported.id,
          evidence_ids: [...imported.evidence_ids],
        });
      continue;
    }
    const id = entityIdentity(image.selected_slice_id, 'library-contract', [
      imported.id,
      name,
      '2',
    ]);
    const proof = `evidence_${fingerprint([id, revision, 'library-declaration-v2'])}`;
    const returns = resolve(declaration.returns, proof),
      parameters = declaration.parameters.map(([parameter, type], index) => ({
        id: entityIdentity(image.selected_slice_id, 'library-parameter', [id, index]),
        name: parameter,
        type: resolve(type, proof),
      }));
    const unsupported =
      declaration.library === 'swift-core' || declaration.library === 'swift-concurrency';
    const abi_signature: AbiSignature = {
      returns: returns.abi_type,
      parameters: parameters.map((parameter) => parameter.type.abi_type),
      variadic: declaration.variadic === true,
      fixed_parameter_count: parameters.length,
      argument_list_complete: declaration.variadic !== true,
      calling_convention: unsupported ? 'unknown' : 'default',
    };
    const signature: Signature | null = unsupported
      ? null
      : {
          abi: abi.id,
          return_type: returns.id,
          parameters: parameters.map((parameter) => ({
            id: parameter.id,
            name: parameter.name,
            type_id: parameter.type.id,
          })),
          variadic: declaration.variadic === true,
          noreturn: declaration.noreturn === true,
          evidence_ids: [proof],
        };
    const contract: LibraryContract = {
      id,
      import_id: imported.id,
      library: imported.library,
      linkage_name: imported.original_name,
      slot: imported.slot,
      callable_entry: imported.callable_entry,
      abi_state: unsupported ? 'unsupported' : 'supported',
      abi_signature,
      signature,
      noreturn: declaration.noreturn === true,
      effects: {
        memory: 'unknown_read_write',
        arguments: declaration.memory ?? null,
        captures: declaration.captures ?? null,
        returns_argument: declaration.returns_argument ?? null,
        allocates: declaration.allocates ?? null,
      },
      variadic_rule: declaration.variadic_rule ?? null,
      source: declaration.source,
      evidence_ids: [proof],
      conflicts_with: [],
    };
    const index = contracts.length;
    contracts.push(contract);
    semantics.push(
      fingerprint([
        name,
        abi.id,
        declaration.library,
        declaration.noreturn === true,
        declaration.variadic === true,
        declaration.allocates ?? null,
      ]),
    );
    evidence.push({
      id: proof,
      origin: { kind: 'library', library: imported.library, contract: name, version: '2' },
      claim:
        'Conditional library declaration from native import identity; no implementation authentication or argument initialization asserted',
      derived_from: [...imported.evidence_ids],
      conflicts_with: [],
      revision,
    });
    for (const [role, address] of [
      ['slot', imported.slot],
      ['callable', imported.callable_entry],
    ] as const) {
      if (address === null) continue;
      const normalized = image.address_map.translate(address, 'va');
      if (normalized.kind !== 'mapped') continue;
      const key = `${role}:${normalized.address.value}`;
      const members = groups.get(key);
      if (members) members.push(index);
      else groups.set(key, [index]);
    }
    if (unsupported) {
      partial = true;
      if (diagnostics.length < 256)
        diagnostics.push({
          code: 'unavailable_semantics',
          severity: 'info',
          message:
            'Swift runtime declaration retained without a supported Swift calling-convention profile',
          entity_id: imported.id,
          evidence_ids: [proof],
        });
    }
  }
  const conflicts = new Map<number, Set<number>>();
  for (const group of groups.values())
    for (const left of group)
      for (const right of group) {
        context.checkpoint(1);
        if (left === right || semantics[left] === semantics[right]) continue;
        let peers = conflicts.get(left);
        if (!peers) {
          peers = new Set();
          conflicts.set(left, peers);
        }
        peers.add(right);
      }
  for (const [index, peers] of conflicts) {
    partial = true;
    contracts[index] = {
      ...contracts[index]!,
      conflicts_with: [...peers].map((peer) => contracts[peer]!.id).sort(),
    };
    evidence[index] = {
      ...evidence[index]!,
      conflicts_with: [...peers].map((peer) => evidence[peer]!.id).sort(),
    };
    if (diagnostics.length < 256)
      diagnostics.push({
        code: 'conflicting_evidence',
        severity: 'warning',
        message: 'Different library callable contracts share an entry or pointer slot',
        entity_id: contracts[index]!.import_id,
        evidence_ids: [evidence[index]!.id, ...evidence[index]!.conflicts_with],
      });
  }
  return {
    state: partial ? 'partial' : 'complete',
    contracts,
    types: [...types.values()],
    evidence,
    diagnostics,
  };
}
