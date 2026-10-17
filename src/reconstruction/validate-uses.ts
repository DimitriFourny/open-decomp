import { OperationError, type OperationContext } from '../core/index.js';
import { expressionOperands, type Origin, type Value } from '../ir/index.js';
import type { ParallelTransfer } from '../presentation/index.js';
import type { Reconstruction } from './model.js';

/** Region SSA is block-local, but source rewrites may introduce shared locals.
 * Check their actual emission sites, not just membership in the SSA value map. */
export function validateEmittedUses(
  program: Reconstruction,
  reachable: ReadonlySet<string>,
  edges: (id: string) => readonly ParallelTransfer[],
  context: OperationContext,
): void {
  const formal = new Set(program.parameters.map((value) => value.id));
  const definitions = new Map<string, { block: string; order: number }>();
  const define = (value: Value, block: string, order: number): void => {
    if (!program.inline.has(value.id)) definitions.set(value.id, { block, order });
  };
  for (const id of reachable) {
    const block = program.blocks.get(id)!;
    for (const parameter of block.parameters) define(parameter, id, -1);
    for (let index = 0; index < block.statements.length; index++) {
      const node = block.statements[index]!,
        order = index * 2;
      context.checkpoint(1);
      if (program.retained.has(node.id)) {
        if ('result' in node) define(node.result, id, order);
        if (node.kind === 'call')
          for (const result of program.calls.get(node.id)?.results ?? node.results)
            define(result, id, order);
        if ('register_outputs' in node)
          for (const binding of node.register_outputs) define(binding.value, id, order);
      }
      for (const definition of program.source?.definitions?.get(node.id) ?? [])
        define(definition.result, id, order + 1);
    }
    for (const definition of program.source?.definitions?.get(block.control.id) ?? [])
      define(definition.result, id, block.statements.length * 2);
  }
  // Compute only the dominance questions source rewriting actually introduces.
  // A cached reachable-without-definition set avoids a block × value lattice.
  const withoutDefinition = new Map<string, ReadonlySet<string>>();
  const dominates = (definition: string, use: string): boolean => {
    if (definition === program.function.entry) return true;
    let reachableWithout = withoutDefinition.get(definition);
    if (!reachableWithout) {
      const seen = new Set<string>(),
        pending = [program.function.entry];
      while (pending.length) {
        context.checkpoint(1);
        const id = pending.pop()!;
        if (id === definition || seen.has(id)) continue;
        seen.add(id);
        for (const transfer of edges(id)) pending.push(transfer.target);
      }
      reachableWithout = seen;
      withoutDefinition.set(definition, seen);
    }
    return !reachableWithout.has(use);
  };
  const fail = (origin: Origin): never => {
    throw new OperationError({
      code: 'unavailable_semantics',
      severity: 'error',
      message:
        'Reconstruction invariant failed: an emitted value is used before its definition on a reachable path',
      entity_id: origin.id,
      evidence_ids: origin.provenance.evidence_ids,
      ...(origin.provenance.ranges[0] ? { address: origin.provenance.ranges[0].start } : {}),
    });
  };
  const use = (value: Value, block: string, order: number, origin: Origin): void => {
    const pending = [value],
      seen = new Set<string>();
    while (pending.length) {
      context.checkpoint(1);
      const current = pending.pop()!;
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      if (program.source?.stack_addresses.has(current.id)) continue;
      if (program.inline.has(current.id)) {
        const expression = program.expressions.get(current.id);
        if (!expression) return fail(origin);
        pending.push(...expressionOperands(expression));
        continue;
      }
      if (formal.has(current.id)) continue;
      const definition = definitions.get(current.id);
      if (
        !definition ||
        (definition.block === block
          ? definition.order >= order
          : !dominates(definition.block, block))
      )
        fail(origin);
    }
  };
  for (const id of reachable) {
    const block = program.blocks.get(id)!;
    for (let index = 0; index < block.statements.length; index++) {
      const node = block.statements[index]!,
        order = index * 2;
      if (program.retained.has(node.id)) {
        if (node.kind === 'assign') {
          const expression = program.expressions.get(node.result.id) ?? node.expression;
          for (const operand of expressionOperands(expression)) use(operand, id, order, node);
        } else if (node.kind === 'write_register') use(node.value, id, order, node);
        else if (node.kind === 'load' || node.kind === 'store') {
          if (!program.source?.locals.has(node.id)) use(node.address, id, order, node);
          if (node.kind === 'store') use(node.value, id, order, node);
        }
        if (node.kind === 'call') {
          const projection = program.calls.get(node.id)!;
          for (const argument of projection.arguments) use(argument, id, order, node);
          for (const binding of projection.inputs) use(binding.value, id, order, node);
          if (node.target.kind === 'indirect') use(node.target.value, id, order, node);
        } else if ('register_inputs' in node)
          for (const binding of program.physical_inputs.get(node.id) ?? [])
            use(binding.value, id, order, node);
      }
      for (const definition of program.source?.definitions?.get(node.id) ?? [])
        for (const operand of expressionOperands(definition.expression))
          use(operand, id, order + 1, definition);
    }
    const control = block.control,
      order = block.statements.length * 2 + 1;
    for (const definition of program.source?.definitions?.get(control.id) ?? [])
      for (const operand of expressionOperands(definition.expression))
        use(operand, id, order - 1, definition);
    if (control.kind === 'if') use(control.condition, id, order, control);
    else if (control.kind === 'switch') use(control.value, id, order, control);
    else if (control.kind === 'indirect') use(control.target, id, order, control);
    if (control.kind === 'return') {
      const projection = program.returns.get(control.id)!;
      for (const result of projection.results) use(result, id, order, control);
      for (const binding of projection.outputs) use(binding.value, id, order, control);
    } else
      for (const binding of program.physical_exits.get(control.id) ?? [])
        use(binding.value, id, order, control);
    for (const transfer of edges(id))
      for (const copy of program.transfers.get(transfer) ?? [])
        use(copy.source, id, order, control);
  }
}
