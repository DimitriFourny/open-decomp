import type { OperationContext } from '../core/index.js';
import type { StackRecoveryResult } from '../analysis/stack/index.js';
import { bitWidth, sameType, type DataType, type Expression, type Value } from '../ir/index.js';
import type { RegisterTypeSlice } from './source-register-types.js';

export interface SlotTypeInput {
  /** Address of every load, by loaded value. */
  readonly loads: ReadonlyMap<string, Value>;
  /** Stored value of every store, by store node. */
  readonly stores: ReadonlyMap<string, Value>;
  readonly expressions: ReadonlyMap<string, Expression>;
  readonly typed: ReadonlyMap<string, readonly RegisterTypeSlice[]>;
  readonly stack: StackRecoveryResult | undefined;
  /** A load that may observe bytes written by effects the stack recovery does
   * not record (the frame address reached a call or unresolved memory on a path
   * to it) has no slot typing. Absent: every load is taken as private. */
  readonly exposed?: (load: Value) => boolean;
  readonly context: OperationContext;
}

const scalarFloat = (type: DataType): boolean =>
  type.kind === 'float' && (type.bits === 32 || type.bits === 64);

/** `DataType` of the stored values of the slot a load reads; `null` when they
 * constrain nothing, `undefined` when the slot contents are unknown. */
export type SlotTyper = (load: Value) => DataType | null | undefined;

/** The IEEE type of an exact stack slot loaded by `load`, as a fact about the
 * stored values: every direct store to the slot is typed FP of the slot width,
 * literal bits, or a reload of an exact slot (an unoptimized copy between frame
 * slots, possibly through same-width bitcasts) that carries that slot's type.
 * Partially overlapping or dynamic stack writes leave the contents unknown.
 * A slot already being resolved adds no other value: its contents are those of
 * the stores resolved around the cycle. `null` means no constraint (only
 * literals or cycle back-references); unknown slot contents are `undefined`.
 * The width of a slot is never a type. */
export function createSlotTyper(input: SlotTypeInput): SlotTyper {
  const { loads, stores, expressions, typed, stack, exposed, context } = input;
  // Values of every direct store to the exact loaded stack slot.
  const slotStores = (load: Value): Value[] | undefined => {
    const address = loads.get(load.id);
    const fact = address && stack?.state === 'complete' ? stack.values.get(address.id) : undefined;
    if (fact?.value.kind !== 'stack' || bitWidth(load.type) % 8 || exposed?.(load))
      return undefined;
    const offset = fact.value.offset,
      size = BigInt(bitWidth(load.type) / 8);
    const stored: Value[] = [];
    for (const access of stack!.accesses) {
      context.checkpoint(1);
      if (access.kind !== 'write') continue;
      if (access.offset === null) return undefined;
      if (access.offset >= offset + size || access.offset + access.size <= offset) continue;
      const value = stores.get(access.node_id);
      if (access.offset !== offset || access.size !== size || !value) return undefined;
      stored.push(value);
    }
    return stored;
  };
  const reloaded = (value: Value): Value | undefined => {
    let current = value;
    for (let depth = 0; depth < 16; depth++) {
      if (loads.has(current.id)) return current;
      const expression = expressions.get(current.id);
      if (
        expression?.kind !== 'cast' ||
        expression.op !== 'bitcast' ||
        bitWidth(expression.value.type) !== bitWidth(current.type)
      )
        return undefined;
      current = expression.value;
    }
    return undefined;
  };
  const slotType = (
    load: Value,
    active: Set<string>,
    visits: { count: number },
  ): DataType | null | undefined => {
    if (active.has(load.id)) return null;
    const slots = ++visits.count <= 64 ? slotStores(load) : undefined;
    if (!slots) return undefined;
    active.add(load.id);
    let type: DataType | null | undefined = null;
    for (const stored of slots) {
      if (expressions.get(stored.id)?.kind === 'constant') continue;
      const reload = reloaded(stored);
      const slice =
        typed
          .get(stored.id)
          ?.find(
            (candidate) =>
              candidate.offset === 0 &&
              scalarFloat(candidate.type) &&
              bitWidth(candidate.type) === bitWidth(load.type),
          )?.type ??
        (reload && bitWidth(reload.type) === bitWidth(load.type)
          ? slotType(reload, active, visits)
          : undefined);
      if (slice === null) continue;
      if (!slice || (type && !sameType(type, slice))) {
        type = undefined;
        break;
      }
      type = slice;
    }
    active.delete(load.id);
    return type;
  };
  return (load) => slotType(load, new Set(), { count: 0 });
}
