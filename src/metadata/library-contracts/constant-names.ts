import type { AbiProfile } from '../../core/index.js';
import { CONSTANT_ARGUMENTS, CONSTANT_SETS, type ConstantSet } from './constants.js';
import { libraryConstant } from './generated/types/index.js';

const popcount = (value: bigint): number => {
  let count = 0;
  for (let rest = value; rest; rest &= rest - 1n) count++;
  return count;
};

/** The curated constant set of argument `index` of the library function `name`. */
export function libraryConstantSet(name: string, index: number): ConstantSet | undefined {
  const set = CONSTANT_ARGUMENTS[name]?.[index];
  return set === undefined ? undefined : CONSTANT_SETS[set];
}

/** Source spelling of the `bits`-wide constant argument `value` of a library call under the
 * header values of `abi` (`O_WRONLY | O_CREAT | O_TRUNC`, `0644`), or undefined when the
 * value has no exact spelling: a `values` set needs an equal name, a `flags` set needs at
 * least one name and prints the bits no name covers as a hexadecimal remainder. An octal
 * mode is `0644` in C, `0o644` in Python (`octalPrefix`). */
export function libraryConstantText(
  abi: AbiProfile['id'],
  set: ConstantSet,
  value: bigint,
  bits: number,
  octalPrefix = '0',
): string | undefined {
  const mask = (1n << BigInt(bits)) - 1n;
  const word = value & mask;
  const of = (name: string): bigint | undefined => {
    const found = /^0x[0-9a-f]+$/i.test(name) ? BigInt(name) : libraryConstant(abi, name);
    return found === undefined ? undefined : found & mask;
  };
  if (set.kind === 'octal')
    return word > 7n && word <= 0o7777n ? `${octalPrefix}${word.toString(8)}` : undefined;
  if (set.kind === 'values') return set.names.find((name) => of(name) === word);
  const parts: string[] = [];
  let rest = word,
    named = false;
  // Names of a field whose mask the platform lacks are plain flags, still printed first.
  const flags = [...set.names];
  let fieldless = 0;
  for (const field of set.fields ?? []) {
    const fieldMask = of(field.mask);
    if (fieldMask === undefined) {
      flags.splice(fieldless, 0, ...field.names);
      fieldless += field.names.length;
      continue;
    }
    const part = rest & fieldMask;
    const name = field.names.find((item) => of(item) === part);
    if (name === undefined) continue;
    // A zero field value is spelled too: `O_RDONLY | O_CREAT`, `MB_OK | MB_ICONERROR`.
    parts.push(name);
    named = true;
    rest &= ~fieldMask;
  }
  const candidates = flags
    .map((name) => ({ name, bits: of(name) }))
    .filter((item): item is { name: string; bits: bigint } => item.bits !== undefined)
    .sort((a, b) => popcount(b.bits) - popcount(a.bits));
  if (word === 0n && !parts.length) return candidates.find((item) => item.bits === 0n)?.name;
  for (const item of candidates) {
    if (item.bits === 0n || (rest & item.bits) !== item.bits) continue;
    parts.push(item.name);
    rest &= ~item.bits;
    named = true;
  }
  if (!named) return undefined;
  if (rest) parts.push(`0x${rest.toString(16)}`);
  return parts.join(' | ');
}
