import type {
  AbiProfile,
  Address,
  ImportRecord,
  LoadedImage,
  OperationContext,
} from '../../core/index.js';
import { findDeclaration } from '../library-contracts/catalog.js';
import { recoverLibraryContracts, type LibraryContracts } from '../library-contracts/index.js';
import { libraryLookupName } from '../symbols/c-names.js';

/** A function whose body a library signature matched (an asserted `library_match` annotation
 * with a contract): the declaration of `name` from the nominal import library `library`
 * applies at its entry. */
export interface MatchedLibraryFunction {
  readonly function_id: string;
  readonly entry: Address;
  readonly library: string;
  readonly name: string;
  readonly evidence_ids: readonly string[];
}

const CLAIM =
  'Conditional library declaration from a library signature match of the function body; no implementation authentication or argument initialization asserted';

/**
 * The library contracts of matched functions, built exactly as an import's: each match reads
 * as an import of `name` from `library` whose callable entry is the function entry (so calls of
 * the function get the contract, by address) and whose identity is the function's entity ID.
 * Their evidence says they come from a signature match, derived from the match's evidence.
 */
export function recoverMatchedContracts(
  input: {
    readonly image: LoadedImage;
    readonly abi: AbiProfile;
    readonly revision: number;
    readonly matches: readonly MatchedLibraryFunction[];
  },
  context: OperationContext,
): LibraryContracts {
  const imports: ImportRecord[] = input.matches.map((match) => ({
    id: match.function_id,
    original_name: match.name,
    display_name: match.name,
    library: match.library,
    ordinal: null,
    slot: null,
    callable_entry: match.entry,
    delayed: false,
    weak: false,
    evidence_ids: [...match.evidence_ids],
  }));
  const contracts = recoverLibraryContracts(
    {
      image: { ...input.image, imports, relocations: [] },
      abi: input.abi,
      revision: input.revision,
    },
    context,
  );
  return {
    ...contracts,
    evidence: contracts.evidence.map((proof) => ({ ...proof, claim: CLAIM })),
  };
}

/** The image's own library contracts with those of matched functions. */
export function withMatchedContracts(
  library: LibraryContracts,
  matched: LibraryContracts,
): LibraryContracts {
  if (!matched.contracts.length) return library;
  const types = new Map(library.types.map((type) => [type.id, type]));
  for (const type of matched.types) if (!types.has(type.id)) types.set(type.id, type);
  return {
    ...library,
    state: library.state === 'partial' || matched.state === 'partial' ? 'partial' : 'complete',
    ...(library.withheld_imports || matched.withheld_imports
      ? {
          withheld_imports: [
            ...(library.withheld_imports ?? []),
            ...(matched.withheld_imports ?? []),
          ].sort(),
        }
      : {}),
    contracts: [...library.contracts, ...matched.contracts],
    types: [...types.values()],
    evidence: [...library.evidence, ...matched.evidence],
    diagnostics: [...library.diagnostics, ...matched.diagnostics],
  };
}

/** The noreturn evidence of a matched function's declaration (`exit`, `abort`,
 * `__stack_chk_fail`), or undefined: calls of it end their block. */
export function matchedNoreturn(
  match: MatchedLibraryFunction,
  format: LoadedImage['target']['format'],
): readonly string[] | undefined {
  const declaration = findDeclaration(libraryLookupName(format, match.name), match.library, format);
  return declaration?.noreturn === true ? match.evidence_ids : undefined;
}
