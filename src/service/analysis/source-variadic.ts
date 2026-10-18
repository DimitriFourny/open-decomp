import type { AbiProfile, AbiSignature, AbiType, OperationContext } from '../../core/index.js';
import type { CallAnalysisResult } from '../../analysis/calls/index.js';
import type { LibraryContracts } from '../../metadata/library-contracts/index.js';
import type { SourceAddress } from '../../reconstruction/source-model.js';

/** Standard printf conversions only. Unsupported extensions, positional syntax,
 * malformed directives and long double retain an open argument list. */
export function printfArgumentTypes(format: string, abi: AbiProfile): readonly AbiType[] | null {
  const types: AbiType[] = [];
  const integer = (bits: number, signed = true): AbiType => ({ kind: 'integer', bits, signed });
  for (let cursor = 0; cursor < format.length; cursor++) {
    if (format[cursor] !== '%') continue;
    cursor++;
    if (format[cursor] === '%') continue;
    while (cursor < format.length && '-+ #0'.includes(format[cursor]!)) cursor++;
    if (format[cursor] === '*') {
      types.push(integer(32));
      cursor++;
    } else while (/[0-9]/.test(format[cursor] ?? '')) cursor++;
    if (format[cursor] === '.') {
      cursor++;
      if (format[cursor] === '*') {
        types.push(integer(32));
        cursor++;
      } else while (/[0-9]/.test(format[cursor] ?? '')) cursor++;
    }
    let length = '';
    if ('hljztL'.includes(format[cursor] ?? '\0')) {
      length = format[cursor++]!;
      if ((length === 'h' || length === 'l') && format[cursor] === length)
        length += format[cursor++]!;
    }
    const conversion = format[cursor];
    if (!conversion) return null;
    if ('diouxX'.includes(conversion) && length !== 'L') {
      const bits =
        length === 'll' || 'jzt'.includes(length || '\0')
          ? 64
          : length === 'l'
            ? abi.id === 'windows-x64'
              ? 32
              : 64
            : 32;
      types.push(integer(bits, conversion === 'd' || conversion === 'i'));
    } else if ('aAeEfFgG'.includes(conversion) && (length === '' || length === 'l'))
      types.push({ kind: 'float', bits: 64 });
    else if (conversion === 'c' && length === '') types.push(integer(32));
    else if ((conversion === 's' || conversion === 'p') && length === '')
      types.push({ kind: 'pointer' });
    else if (conversion === 'n' && length !== 'L') types.push({ kind: 'pointer' });
    else return null;
    if (types.length > 64) return null;
  }
  return types;
}

/** Literal bytes must have immutable, terminated image provenance. Never use a
 * nearby string, mutable storage, a guessed library name or a conflicting contract. */
export function formatArgumentSignatures(
  analysis: CallAnalysisResult | null,
  library: LibraryContracts,
  addresses: readonly SourceAddress[],
  abi: AbiProfile,
  context: OperationContext,
): ReadonlyMap<string, AbiSignature> {
  const result = new Map<string, AbiSignature>();
  for (const call of analysis?.calls ?? []) {
    context.checkpoint(1);
    if (call.status !== 'established') continue;
    const observations = call.contracts.filter((item) => item.status === 'established');
    if (!observations.length) continue;
    const observation = observations[0]!;
    const contract = library.contracts.find(
      (item) =>
        item.id === observation.contract.id || `${item.id}:entry` === observation.contract.id,
    );
    if (
      !contract ||
      contract.conflicts_with.length ||
      contract.variadic_rule?.kind !== 'format' ||
      !contract.abi_signature.parameters
    )
      continue;
    // Callable-entry and import resolutions can supply the same nominal contract
    // twice. They agree only when every established observation names that contract
    // and proves the identical format pointer.
    let address: bigint | undefined;
    let compatible = true;
    for (const observed of observations) {
      context.checkpoint(1);
      const locations = observed.parameters.find(
        (item) => item.index === contract.variadic_rule!.argument,
      )?.locations;
      const value = locations?.length === 1 ? locations[0]!.fact.value : undefined;
      const current =
        value?.kind === 'address'
          ? value.address.value
          : value?.kind === 'constant'
            ? value.bits
            : undefined;
      if (
        (observed.contract.id !== contract.id && observed.contract.id !== `${contract.id}:entry`) ||
        current === undefined ||
        (address !== undefined && address !== current)
      ) {
        compatible = false;
        break;
      }
      address = current;
    }
    if (!compatible || address === undefined) continue;
    const literal = addresses.find(
      (item) => item.address.value === address && item.string !== undefined,
    );
    if (literal?.string === undefined) continue;
    const additional = printfArgumentTypes(literal.string, abi);
    if (!additional) continue;
    result.set(call.node_id, {
      ...contract.abi_signature,
      parameters: [...contract.abi_signature.parameters, ...additional],
      argument_list_complete: true,
    });
  }
  return result;
}
