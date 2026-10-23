import type { OperationContext } from '../core/index.js';
import type { StackFact, StackRecoveryResult } from '../analysis/stack/index.js';
import { bitWidth, type Value } from '../ir/index.js';
import type { BlockRegion } from '../presentation/index.js';
import { identityOperand } from './expressions.js';

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
  /** The operand an identity assignment (a register move) copies unchanged. */
  readonly alias: (value: Value) => Value | undefined;
  /** The bits of a value defined as a constant (rematerialized constants are
   * distinct SSA values with equal bits). */
  readonly constant: (value: Value) => bigint | undefined;
}

/** The block-join facts of a source body's regions: each statement's block,
 * every block's incoming edges with their parameter copies, and the concat,
 * identity-move and constant definitions of its assignments. The entry block
 * has no join. */
export function createStackArgumentJoins(
  blocks: ReadonlyMap<string, BlockRegion>,
  entry: string,
): StackArgumentJoins {
  const statementBlocks = new Map<string, string>(),
    concats = new Map<string, readonly Value[]>(),
    aliases = new Map<string, Value>(),
    constants = new Map<string, bigint>(),
    incomingEdges = new Map<
      string,
      { exit: string; copies: readonly { destination: Value; source: Value }[] }[]
    >();
  for (const block of blocks.values()) {
    for (const node of block.statements) {
      statementBlocks.set(node.id, block.id);
      if (node.kind !== 'assign') continue;
      if (node.expression.kind === 'constant') constants.set(node.result.id, node.expression.bits);
      if (node.expression.kind === 'concat') concats.set(node.result.id, node.expression.values);
      const alias = identityOperand(node.result.type, node.expression);
      if (alias) aliases.set(node.result.id, alias);
    }
    const control = block.control;
    const outgoing =
      control.kind === 'jump'
        ? [control.transfer]
        : control.kind === 'if'
          ? [control.when_true.transfer, control.when_false.transfer]
          : control.kind === 'switch'
            ? [...control.cases.map((item) => item.arm.transfer), control.otherwise.transfer]
            : [];
    for (const transfer of outgoing) {
      const edges = incomingEdges.get(transfer.target) ?? [];
      edges.push({ exit: control.id, copies: transfer.copies });
      incomingEdges.set(transfer.target, edges);
    }
  }
  return {
    block(boundary) {
      const block = blocks.get(statementBlocks.get(boundary) ?? '');
      if (!block || block.id === entry) return undefined;
      const index = block.statements.findIndex((node) => node.id === boundary);
      return {
        statements: block.statements.slice(0, index + 1).map((node) => ({
          id: node.id,
          pure: node.kind !== 'store' && node.kind !== 'call' && node.kind !== 'unknown_effect',
        })),
        incoming: incomingEdges.get(block.id) ?? [],
      };
    },
    concat: (value) => concats.get(value.id),
    alias: (value) => aliases.get(value.id),
    constant: (value) => constants.get(value.id),
  };
}

/** Recover existing stored SSA values, never add an observable memory load or
 * choose a dependency ID merely because it appears in a fact's provenance set.
 * Byte facts retain their exact owning store across snapshot copies. A byte
 * merged at the boundary's block entry (unchanged up to the boundary) resolves
 * when, on every incoming edge, the byte's exact owning store wrote either the
 * same value (or concat component) at the same bit offset — a single SSA
 * definition reaching every predecessor dominates the join — or a value that
 * the edge copies into one shared block parameter at the same bit offset. A
 * merged, aliased or absent byte without that proof keeps the argument
 * unresolved. */
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
  // The value an identity-move chain copies unchanged.
  const unaliased = (value: Value): Value => {
    let current = value;
    for (let depth = 0; depth < 8; depth++) {
      context.checkpoint(1);
      const alias = joins?.alias(current);
      if (!alias) break;
      current = alias;
    }
    return current;
  };
  // The component of `value` holding bit `bit`, with its bit offset, through
  // identity moves and concats.
  const component = (value: Value, bit: number): { value: Value; offset: number } => {
    let current = { value: unaliased(value), offset: bit };
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
      current = { value: unaliased(next), offset: current.offset - base };
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
    let destination: Value | undefined,
      bit: number | undefined,
      shared: { value: Value; offset: number } | null | undefined,
      carried = true;
    for (const edge of block.incoming) {
      context.checkpoint(1);
      const cell = stack.snapshots.get(edge.exit)?.memory.get(address);
      const stored = cell && owners.get(cell.fact);
      if (!cell || !stored || cell.fact.initialization === 'uninitialized') return null;
      const source = component(stored, cell.value_offset_bits);
      shared =
        shared === undefined ||
        (shared && shared.value.id === source.value.id && shared.offset === source.offset)
          ? source
          : null;
      // A carrier copies the stored value itself or an equal rematerialized
      // constant of the same width (only `shared` needs one dominating value).
      const bits = joins?.constant(source.value);
      const copies = edge.copies.filter((copy) => {
        const carried = unaliased(copy.source);
        return (
          (carried.id === source.value.id ||
            (bits !== undefined &&
              joins?.constant(carried) === bits &&
              bitWidth(carried.type) === bitWidth(source.value.type))) &&
          (destination === undefined || copy.destination.id === destination.id)
        );
      });
      if (copies.length !== 1 || (bit !== undefined && bit !== source.offset)) carried = false;
      else {
        destination = copies[0]!.destination;
        bit = source.offset;
      }
      if (!shared && !carried) return null;
    }
    if (shared) return { value: shared.value, value_offset_bits: shared.offset };
    return carried && destination && bit !== undefined
      ? { value: destination, value_offset_bits: bit }
      : null;
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
