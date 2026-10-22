import type { OperationContext } from '../../core/index.js';
import type { CallAnalysisResult } from '../../analysis/calls/index.js';
import {
  bitWidth,
  type Expression,
  type RegisterBinding,
  type SSAForm,
  type Value,
} from '../../ir/index.js';
import { sourceStackArgumentParts } from '../../reconstruction/source-stack-arguments.js';
import type { NativeInterface } from './native-worklist.js';

/** What `nativeArgumentValues` reads of one IR, built once per caller loop:
 * assignments, stores and loads by id, register inputs of each call, the exit
 * row of each terminator's block, and concatenations by operand tuple. */
export interface NativeArgumentIndex {
  readonly ir: SSAForm;
  readonly expressions: ReadonlyMap<string, Expression>;
  readonly stores: ReadonlyMap<string, Value>;
  readonly loads: ReadonlyMap<string, Value>;
  readonly calls: ReadonlyMap<string, readonly RegisterBinding[]>;
  readonly exits: ReadonlyMap<string, readonly RegisterBinding[]>;
  /** Concatenation results by `operandKey` of their operands, in IR order. */
  readonly concats: ReadonlyMap<string, readonly Value[]>;
}

const operandKey = (values: readonly Value[]): string =>
  values.map((value) => value.id).join('\u0000');

/** One scan of `ir` (identities are unique, so every map holds one entry per node). */
export function nativeArgumentIndex(ir: SSAForm, context: OperationContext): NativeArgumentIndex {
  const expressions = new Map<string, Expression>();
  const stores = new Map<string, Value>();
  const loads = new Map<string, Value>();
  const calls = new Map<string, readonly RegisterBinding[]>();
  const exits = new Map<string, readonly RegisterBinding[]>();
  const concats = new Map<string, Value[]>();
  const rows = new Map<string, readonly RegisterBinding[]>();
  for (const state of ir.register_states)
    if (!rows.has(state.block)) rows.set(state.block, state.exit);
  for (const block of ir.blocks) {
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (node.kind === 'assign') {
        expressions.set(node.result.id, node.expression);
        if (node.expression.kind !== 'concat') continue;
        const key = operandKey(node.expression.values),
          list = concats.get(key);
        if (list) list.push(node.result);
        else concats.set(key, [node.result]);
      } else if (node.kind === 'store') stores.set(node.id, node.value);
      else if (node.kind === 'load') loads.set(node.id, node.result);
      else if (node.kind === 'call') calls.set(node.id, node.register_inputs);
    }
    exits.set(block.terminator.id, rows.get(block.id) ?? []);
  }
  return { ir, expressions, stores, loads, calls, exits, concats };
}

/** Associate observed physical parameters with existing whole SSA actuals.
 * Split roots are joined only through an existing exact extract/concat owner;
 * a synthetic value must never become a catalogued caller memory-shape base.
 * `boundary` is the IR id (entry arguments), a call id or a tail terminator id. */
export function nativeArgumentValues(
  indexed: NativeArgumentIndex,
  analysis: CallAnalysisResult | null,
  boundary: string,
  observed: NativeInterface,
  context: OperationContext,
): ReadonlyMap<number, Value> {
  const { ir, expressions } = indexed;
  const bindings: readonly RegisterBinding[] =
    boundary === ir.id
      ? (ir.register_states.find((state) => state.block === ir.entry)?.entry ?? [])
      : (indexed.calls.get(boundary) ?? indexed.exits.get(boundary) ?? []);
  const result = new Map<number, Value>();
  for (const [index, register] of observed.parameters.entries()) {
    const cells = bindings
      .filter(
        (binding) =>
          binding.register.root === register.root &&
          binding.register.offset_bits >= register.offset_bits &&
          binding.register.offset_bits < register.offset_bits + register.width_bits,
      )
      .sort((left, right) => left.register.offset_bits - right.register.offset_bits);
    if (
      cells.length === 1 &&
      cells[0]!.register.offset_bits === register.offset_bits &&
      bitWidth(cells[0]!.value.type) === register.width_bits
    ) {
      result.set(index, cells[0]!.value);
      continue;
    }
    let cursor = register.offset_bits,
      whole: Value | null = null,
      exact = true;
    for (const cell of cells) {
      context.checkpoint(1);
      const expression = expressions.get(cell.value.id);
      if (
        cell.register.offset_bits !== cursor ||
        expression?.kind !== 'extract' ||
        expression.offset !== cursor - register.offset_bits ||
        (whole && whole.id !== expression.value.id)
      ) {
        exact = false;
        break;
      }
      whole = expression.value;
      cursor += cell.register.width_bits;
    }
    if (
      exact &&
      whole &&
      cursor === register.offset_bits + register.width_bits &&
      bitWidth(whole.type) === register.width_bits
    ) {
      result.set(index, whole);
      continue;
    }
    context.checkpoint(1);
    const concat = indexed.concats
      .get(operandKey(cells.map((cell) => cell.value)))
      ?.find((value) => bitWidth(value.type) === register.width_bits);
    if (concat) result.set(index, concat);
  }
  if (analysis)
    for (const [index, parameter] of (observed.stack_parameters ?? []).entries()) {
      if (boundary === ir.id) {
        for (const access of analysis.stack.accesses) {
          context.checkpoint(1);
          if (
            access.kind !== 'read' ||
            access.region !== 'incoming_candidate' ||
            access.offset !== parameter.offset ||
            access.size * 8n !== BigInt(parameter.width_bits)
          )
            continue;
          const load = indexed.loads.get(access.node_id);
          if (load) result.set(observed.parameters.length + index, load);
        }
        continue;
      }
      const parts = sourceStackArgumentParts(
        analysis.stack,
        indexed.stores,
        boundary,
        parameter.offset,
        parameter.width_bits,
        context,
      );
      if (
        parts?.length === 1 &&
        parts[0]!.value_offset_bits === 0 &&
        parts[0]!.width_bits === bitWidth(parts[0]!.value.type)
      )
        result.set(observed.parameters.length + index, parts[0]!.value);
    }
  return result;
}
