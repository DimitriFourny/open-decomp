import type { OperationContext } from '../core/index.js';
import type { StackFact, StackRecoveryResult } from '../analysis/stack/index.js';
import { bitWidth, type Value } from '../ir/index.js';

export interface StackArgumentPart {
  readonly value: Value;
  readonly value_offset_bits: number;
  readonly offset_bits: number;
  readonly width_bits: number;
}

/** Block-join facts for a boundary whose stack bytes merge several stores. */
export interface StackArgumentJoins {
  /** The boundary's block: its statements up to and including the boundary
   * (`pure` statements write no memory) and every incoming edge with the edge's
   * exit-state identity and its simultaneous parameter copies. */
  readonly block: (boundary: string) =>
    | {
        readonly statements: readonly { readonly id: string; readonly pure: boolean }[];
        readonly incoming: readonly {
          readonly exit: string;
          readonly copies: readonly { readonly destination: Value; readonly source: Value }[];
        }[];
      }
    | undefined;
  /** Low-bits-first components of a value defined by `concat`. */
  readonly concat: (value: Value) => readonly Value[] | undefined;
}

/** Recover existing stored SSA values, never add an observable memory load or
 * choose a dependency ID merely because it appears in a fact's provenance set.
 * Byte facts retain their exact owning store across snapshot copies. A byte
 * merged at the boundary's block entry (unchanged up to the boundary) resolves
 * to that block's parameter only when, on every incoming edge, the byte's
 * exact owning store wrote a value (or concat component) that the edge copies
 * into that same parameter at the same bit offset. A merged, aliased or absent
 * byte without that proof keeps the argument unresolved. */
export function sourceStackArgumentParts(
  stack: StackRecoveryResult,
  stores: ReadonlyMap<string, Value>,
  boundary: string,
  offset: bigint,
  width: number,
  context: OperationContext,
  joins?: StackArgumentJoins,
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
  // The component of `value` holding bit `bit`, with its bit offset.
  const component = (value: Value, bit: number): { value: Value; offset: number } => {
    let current = { value, offset: bit };
    for (let depth = 0; depth < 8; depth++) {
      context.checkpoint(1);
      const parts = joins?.concat(current.value);
      if (!parts) return current;
      let base = 0;
      const next = parts.find((part) => {
        const width = bitWidth(part.type);
        if (current.offset < base + width) return true;
        base += width;
        return false;
      });
      if (!next) return current;
      current = { value: next, offset: current.offset - base };
    }
    return current;
  };
  const merged = (address: bigint): { value: Value; value_offset_bits: number } | null => {
    const block = joins?.block(boundary);
    if (!block?.incoming.length) return null;
    // Block-entry memory: the first statement with a pre-effect snapshot, after
    // only pure statements, whose byte fact reaches the boundary unchanged.
    let first: string | undefined;
    for (const statement of block.statements) {
      if (stack.snapshots.has(statement.id)) {
        first = statement.id;
        break;
      }
      if (!statement.pure) return null;
    }
    const entry = first === undefined ? undefined : stack.snapshots.get(first)?.memory.get(address);
    if (!entry || entry.fact !== snapshot.memory.get(address)?.fact) return null;
    let destination: Value | undefined, bit: number | undefined;
    for (const edge of block.incoming) {
      context.checkpoint(1);
      const cell = stack.snapshots.get(edge.exit)?.memory.get(address);
      const stored = cell && owners.get(cell.fact);
      if (!cell || !stored || cell.fact.initialization === 'uninitialized') return null;
      const source = component(stored, cell.value_offset_bits);
      const copies = edge.copies.filter(
        (copy) =>
          copy.source.id === source.value.id &&
          (destination === undefined || copy.destination.id === destination.id),
      );
      if (copies.length !== 1 || (bit !== undefined && bit !== source.offset)) return null;
      destination = copies[0]!.destination;
      bit = source.offset;
    }
    return destination && bit !== undefined ? { value: destination, value_offset_bits: bit } : null;
  };
  const parts: StackArgumentPart[] = [];
  for (let byte = 0; byte < width / 8; byte++) {
    context.checkpoint(1);
    const address = sp.offset + offset + BigInt(byte);
    const cell = snapshot.memory.get(address);
    if (!cell) return null;
    const owner = owners.get(cell.fact);
    const resolved =
      owner && cell.fact.initialization !== 'uninitialized'
        ? { value: owner, value_offset_bits: cell.value_offset_bits }
        : merged(address);
    if (!resolved) return null;
    const { value } = resolved;
    const previous = parts.at(-1);
    if (
      previous &&
      previous.value.id === value.id &&
      previous.value_offset_bits + previous.width_bits === resolved.value_offset_bits
    ) {
      parts[parts.length - 1] = { ...previous, width_bits: previous.width_bits + 8 };
    } else
      parts.push({
        value,
        value_offset_bits: resolved.value_offset_bits,
        offset_bits: byte * 8,
        width_bits: 8,
      });
  }
  return parts;
}
