import {
  entityIdentity,
  fingerprint,
  type AbiProfile,
  type AbiSignature,
  type AbiType,
  type Address,
  type Diagnostic,
  type Evidence,
  type LoadedImage,
  type OperationContext,
  type RecoveredType,
  type Signature,
} from '../../core/index.js';
import {
  catalog,
  identifiesLibrary,
  type ArgumentMemory,
  type CatalogEntry,
  type TypeSpec,
} from './catalog.js';
export type { ArgumentMemory } from './catalog.js';

export interface LibraryType {
  readonly id: string;
  readonly name: string;
  readonly definition: RecoveredType;
  readonly abi_type: AbiType;
  readonly evidence_ids: readonly string[];
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

/** Match exact native import names AND nominal library identity. No local symbol,
 * demangled text, ordinal guess, weak binding or nonzero import addend establishes
 * a contract. The declaration remains conditional on that library implementation;
 * it is not an authenticity check. Imported pointer storage is never a callable
 * entry. Aliased entries/slots retain incompatible alternatives and their evidence.
 * Global memory effects remain conservative even for an empty argument footprint.
 * Swift runtime declarations retain unknown calling convention instead of silently
 * borrowing C preservation rules. ABI-specific long/size_t/wchar widths are explicit.
 */
export function recoverLibraryContracts(
  input: {
    readonly image: LoadedImage;
    readonly abi: AbiProfile;
    readonly revision: number;
    readonly max_contracts?: number;
  },
  context: OperationContext,
): LibraryContracts {
  const { image, abi, revision } = input,
    limit = input.max_contracts ?? 256;
  if (abi.id !== image.target.abi || abi.architecture !== image.target.architecture)
    throw new TypeError('Library contract ABI does not match the loaded target');
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit > 1000
  )
    throw new RangeError('Invalid library contract bounds');
  context.checkpoint(0);
  const contracts: LibraryContract[] = [],
    evidence: Evidence[] = [],
    diagnostics: Diagnostic[] = [],
    types = new Map<string, LibraryType>();
  const nonzero = new Set<string>(),
    groups = new Map<string, number[]>(),
    semantics: string[] = [];
  const adjustedSlots = new Set<bigint>(),
    adjustedNames = new Set<string>();
  let partial = false;
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
  function resolve(spec: TypeSpec, proof: string): LibraryType {
    context.checkpoint(1);
    let definition: RecoveredType,
      abi_type: AbiType,
      name: string,
      birth: string | readonly string[];
    if (typeof spec !== 'string') {
      if (spec.kind === 'pointer') {
        const target = resolve(spec.to, proof);
        definition = { kind: 'pointer', to: target.id, bits: 64 };
        abi_type = { kind: 'pointer' };
        name = `pointer to ${target.name}`;
        birth = ['pointer', target.id];
      } else {
        definition = { kind: 'unknown', size: null };
        abi_type = { kind: 'unknown', size: null };
        name = spec.name;
        birth = ['opaque', name];
      }
    } else if (spec === 'void') {
      name = spec;
      birth = spec;
      definition = { kind: 'void' };
      abi_type = { kind: 'void' };
    } else {
      const bits =
        spec === 'char'
          ? abi.layout.char_bits
          : spec === 'wchar'
            ? abi.id === 'windows-x64'
              ? 16
              : 32
            : spec === 'long' || spec === 'ulong'
              ? abi.layout.long_bits
              : spec === 'size_t' || spec === 'ssize_t'
                ? abi.layout.pointer_bits
                : abi.layout.int_bits;
      const signed =
        spec !== 'uint' &&
        spec !== 'ulong' &&
        spec !== 'size_t' &&
        !(spec === 'wchar' && abi.id === 'windows-x64');
      definition = { kind: 'integer', bits, signed };
      abi_type = definition;
      name = spec === 'wchar' ? 'wchar_t' : spec;
      birth = spec;
    }
    const id = entityIdentity(image.selected_slice_id, 'library-type', [abi.id, birth]),
      prior = types.get(id);
    if (prior) {
      if (!prior.evidence_ids.includes(proof))
        types.set(id, { ...prior, evidence_ids: [...prior.evidence_ids, proof] });
      return prior;
    }
    const value: LibraryType = { id, name, definition, abi_type, evidence_ids: [proof] };
    types.set(id, value);
    return value;
  }
  for (const imported of image.imports) {
    context.checkpoint(1);
    if (imported.original_name === null || imported.library === null) continue;
    const name =
      image.target.format === 'macho' && imported.original_name.startsWith('_')
        ? imported.original_name.slice(1)
        : imported.original_name;
    const declaration = Object.hasOwn(catalog, name) ? catalog[name] : undefined;
    if (!declaration || !identifiesLibrary(imported.library, declaration, image.target.format))
      continue;
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
    if (contracts.length >= limit) {
      partial = true;
      diagnostics.push({
        code: 'resource_limit',
        severity: 'warning',
        message: 'Library contract bound reached',
        evidence_ids: [],
      });
      break;
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
