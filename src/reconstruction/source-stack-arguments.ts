import type { OperationContext } from '../core/index.js';
import type { StackFact, StackRecoveryResult } from '../analysis/stack/index.js';
import type { Value } from '../ir/index.js';

export interface StackArgumentPart {
  readonly value: Value;
  readonly value_offset_bits: number;
  readonly offset_bits: number;
  readonly width_bits: number;
}

/** Recover existing stored SSA values, never add an observable memory load or
 * choose a dependency ID merely because it appears in a fact's provenance set.
 * Byte facts retain their exact owning store across snapshot copies. A merged,
 * aliased or absent byte without that proof keeps the argument unresolved. */
export function sourceStackArgumentParts(
  stack: StackRecoveryResult,
  stores: ReadonlyMap<string, Value>,
  boundary: string,
  offset: bigint,
  width: number,
  context: OperationContext,
): readonly StackArgumentPart[] | null {
  if (width <= 0 || width % 8 !== 0 || width > 2048) return null;
  const snapshot = stack.snapshots.get(boundary),
    sp = snapshot?.stack_pointer.value;
  if (!snapshot || sp?.kind !== 'stack') return null;
  const owners = new Map<StackFact, Value>();
  for (const access of stack.accesses) {
    context.checkpoint(1);
    if (access.kind !== 'write') continue;
    const value = stores.get(access.node_id);
    if (value) owners.set(access.value, value);
  }
  const parts: StackArgumentPart[] = [];
  for (let byte = 0; byte < width / 8; byte++) {
    context.checkpoint(1);
    const cell = snapshot.memory.get(sp.offset + offset + BigInt(byte));
    if (!cell) return null;
    const value = owners.get(cell.fact);
    if (!value || cell.fact.initialization === 'uninitialized') return null;
    const previous = parts.at(-1);
    if (
      previous &&
      previous.value.id === value.id &&
      previous.value_offset_bits + previous.width_bits === cell.value_offset_bits
    ) {
      parts[parts.length - 1] = { ...previous, width_bits: previous.width_bits + 8 };
    } else
      parts.push({
        value,
        value_offset_bits: cell.value_offset_bits,
        offset_bits: byte * 8,
        width_bits: 8,
      });
  }
  return parts;
}
