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

/** Associate observed physical parameters with existing whole SSA actuals.
 * Split roots are joined only through an existing exact extract/concat owner;
 * a synthetic value must never become a catalogued caller memory-shape base. */
export function nativeArgumentValues(
  ir: SSAForm,
  analysis: CallAnalysisResult | null,
  boundary: string,
  observed: NativeInterface,
  context: OperationContext,
): ReadonlyMap<number, Value> {
  const expressions = new Map<string, { readonly value: Value; readonly expression: Expression }>();
  const stores = new Map<string, Value>();
  let bindings: readonly RegisterBinding[] =
    boundary === ir.id
      ? (ir.register_states.find((state) => state.block === ir.entry)?.entry ?? [])
      : [];
  for (const block of ir.blocks) {
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (node.kind === 'assign')
        expressions.set(node.result.id, { value: node.result, expression: node.expression });
      else if (node.kind === 'store') stores.set(node.id, node.value);
      else if (node.kind === 'call' && node.id === boundary) bindings = node.register_inputs;
    }
    if (block.terminator.id === boundary)
      bindings = ir.register_states.find((state) => state.block === block.id)?.exit ?? [];
  }
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
      const expression = expressions.get(cell.value.id)?.expression;
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
    for (const candidate of expressions.values()) {
      context.checkpoint(1);
      if (
        candidate.expression.kind !== 'concat' ||
        bitWidth(candidate.value.type) !== register.width_bits ||
        candidate.expression.values.length !== cells.length
      )
        continue;
      if (candidate.expression.values.every((value, i) => value.id === cells[i]!.value.id)) {
        result.set(index, candidate.value);
        break;
      }
    }
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
          for (const block of ir.blocks)
            for (const node of block.instructions)
              if (node.kind === 'load' && node.id === access.node_id)
                result.set(observed.parameters.length + index, node.result);
        }
        continue;
      }
      const parts = sourceStackArgumentParts(
        analysis.stack,
        stores,
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
