import type { OperationContext } from '../core/index.js';
import {
  bitWidth,
  integer,
  type DataType,
  type Expression,
  type RegisterBinding,
  type Value,
} from '../ir/index.js';
import type { BlockRegion, ParallelTransfer } from '../presentation/index.js';
import { identityOperand } from './expressions.js';
import type { LocalValidationSession } from './local-validation.js';

type Copies = ParallelTransfer['copies'];

interface CellPlan {
  make(
    key: string,
    type: DataType,
    block: string,
    expression?: Expression,
    contributors?: readonly Value[],
  ): Value;
  alias(value: Value, expression: Expression): void;
}

/** Transport one whole bitvector instead of its independently allocated SSA
 * cells. The machine SSA and original transfer objects remain immutable. */
export function recombineSourceCells(
  blocks: Map<string, BlockRegion>,
  transfers: readonly { transfer: ParallelTransfer; block: BlockRegion }[],
  expressions: ReadonlyMap<string, Expression>,
  incoming: Map<string, Value[]>,
  plan: CellPlan,
  validation: LocalValidationSession,
  context: OperationContext,
): ReadonlyMap<ParallelTransfer, Copies> {
  const replacements = new Map<ParallelTransfer, Copies>();
  const edges = new Map<string, ParallelTransfer[]>();
  for (const { transfer } of transfers) {
    context.checkpoint(1);
    for (const destination of new Set(transfer.copies.map((copy) => copy.destination.id))) {
      const list = edges.get(destination) ?? [];
      list.push(transfer);
      edges.set(destination, list);
    }
  }
  // Follow only exact integer identity/extraction views. In particular, do not
  // infer a whole value from two independently computed arithmetic halves.
  const slice = (original: Value): { value: Value; offset: number } => {
    let value = original,
      offset = 0;
    const seen = new Set<string>();
    while (!seen.has(value.id)) {
      context.checkpoint(1);
      seen.add(value.id);
      const expression = expressions.get(value.id);
      if (!expression) break;
      const alias = identityOperand(value.type, expression);
      if (alias) value = alias;
      else if (expression.kind === 'extract') {
        offset += expression.offset;
        value = expression.value;
      } else if (expression.kind === 'cast' && expression.op === 'truncate') {
        value = expression.value;
      } else break;
    }
    return { value, offset };
  };
  for (const block of blocks.values()) {
    const parameters = new Set(block.parameters.map((value) => value.id));
    const roots = new Map<string, RegisterBinding[]>();
    for (const binding of block.register_entry) {
      context.checkpoint(1);
      if (!parameters.has(binding.value.id) || expressions.has(binding.value.id)) continue;
      const list = roots.get(binding.register.root) ?? [];
      list.push(binding);
      roots.set(binding.register.root, list);
    }
    const added: Value[] = [];
    for (const [root, bindings] of roots) {
      if (bindings.length < 2) continue;
      bindings.sort((left, right) => left.register.offset_bits - right.register.offset_bits);
      const width = bindings[0]!.register.root_width_bits;
      let end = 0;
      const complete = bindings.every(({ register, value }) => {
        context.checkpoint(1);
        if (
          register.offset_bits !== end ||
          register.root_width_bits !== width ||
          value.type.kind !== 'integer' ||
          bitWidth(value.type) !== register.width_bits
        )
          return false;
        end += register.width_bits;
        return true;
      });
      if (!complete || end !== width) continue;
      const predecessors = edges.get(bindings[0]!.value.id) ?? [];
      if (!predecessors.length) continue;
      const sources: { transfer: ParallelTransfer; value: Value }[] = [];
      for (const transfer of predecessors) {
        context.checkpoint(1);
        const copies = replacements.get(transfer) ?? transfer.copies;
        let whole: Value | undefined;
        for (const binding of bindings) {
          const matches = copies.filter((copy) => copy.destination.id === binding.value.id);
          context.checkpoint(copies.length);
          if (matches.length !== 1) {
            whole = undefined;
            break;
          }
          const part = slice(matches[0]!.source);
          if (
            part.offset !== binding.register.offset_bits ||
            part.value.type.kind !== 'integer' ||
            bitWidth(part.value.type) !== width ||
            (whole && whole.id !== part.value.id)
          ) {
            whole = undefined;
            break;
          }
          whole = part.value;
        }
        if (!whole) break;
        sources.push({ transfer, value: whole });
      }
      if (
        sources.length !== predecessors.length ||
        bindings.some(({ value }) => {
          const incomingEdges = edges.get(value.id) ?? [];
          return (
            incomingEdges.length !== predecessors.length ||
            incomingEdges.some((edge) => !predecessors.includes(edge))
          );
        }) ||
        !validation.presentation(
          'register_cell_recombination',
          bindings[0]!.value.id,
          'complete contiguous integer root cells; every incoming edge supplies corresponding slices of one identical whole value, preserving simultaneous transfers and full-width carries',
          bindings.map(({ value }) => value.id),
        )
      )
        continue;
      const whole = plan.make(
        `cell-phi:${block.id}:${root}`,
        integer(width),
        block.id,
        undefined,
        bindings.map(({ value }) => value),
      );
      added.push(whole);
      incoming.set(
        whole.id,
        sources.map(({ value }) => value),
      );
      const replaced = new Set(bindings.map(({ value }) => value.id));
      for (const { transfer, value } of sources) {
        const copies = replacements.get(transfer) ?? transfer.copies;
        replacements.set(transfer, [
          ...copies.filter((copy) => !replaced.has(copy.destination.id)),
          { destination: whole, source: value },
        ]);
      }
      for (const binding of bindings) {
        incoming.delete(binding.value.id);
        plan.alias(binding.value, {
          kind: 'extract',
          value: whole,
          offset: binding.register.offset_bits,
        });
      }
    }
    if (added.length)
      blocks.set(block.id, { ...block, parameters: [...block.parameters, ...added] });
  }
  return replacements;
}
