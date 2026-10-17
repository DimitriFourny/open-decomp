import type { AbiProfile, OperationContext, RegisterDescriptor } from '../../core/index.js';
import { bitWidth, expressionOperands, successors, type Expression, type RegisterBinding, type SSAForm, type Value } from '../../ir/index.js';

/** Structural facts for one unchanged SSA stage. Demand results are never cached. */
export interface CallResultDemandIndex {
  query(
    ir: SSAForm, abi: AbiProfile, context: OperationContext,
    additionalRoots?: readonly Value[],
  ): ReadonlyMap<string, readonly RegisterDescriptor[]>;
}

export function observeCallResultDemands(
  ir: SSAForm, abi: AbiProfile, context: OperationContext,
  additionalRoots: readonly Value[] = [],
  index?: CallResultDemandIndex,
): ReadonlyMap<string, readonly RegisterDescriptor[]> {
  return (index ?? createCallResultDemandIndex(ir, abi, context)).query(ir, abi, context, additionalRoots);
}

/** Semantic result consumption, independent of a callee's return guarantee.
 * Snapshot liveness does not demand every caller-saved output. Slices survive
 * extracts/truncation so consuming W0 never establishes unknown X0 high bits. */
export function createCallResultDemandIndex(
  ir: SSAForm,
  abi: AbiProfile,
  context: OperationContext,
): CallResultDemandIndex {
  const primary = abi.classifyCall({ returns: { kind: 'pointer' }, parameters: [],
    variadic: false, fixed_parameter_count: 0 }).returns.find((location) => location.kind === 'register');
  const expressions = new Map<string, Expression>(), incoming = new Map<string, Value[]>();
  const outputs = new Map<string, { readonly call: string; readonly binding: RegisterBinding }>();
  const blocks = new Map(ir.blocks.map((block) => [block.id, block]));
  const states = new Map(ir.register_states.map((state) => [state.block, state]));
  const entry = new Map((states.get(ir.entry)?.entry ?? []).map((binding) => [binding.register.id, binding.value.id]));
  const roots: Value[] = [];
  for (const block of ir.blocks) {
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (node.kind === 'assign') expressions.set(node.result.id, node.expression);
      else if (node.kind === 'load') roots.push(node.address);
      else if (node.kind === 'store') roots.push(node.address, node.value);
      else if (node.kind === 'call') {
        roots.push(...node.arguments);
        if (node.target.kind === 'indirect') roots.push(node.target.value);
        for (const binding of node.register_outputs) {
          context.checkpoint(1);
          outputs.set(binding.value.id, { call: node.id, binding });
        }
      }
    }
    const control = block.terminator;
    if (control.kind === 'branch') roots.push(control.condition);
    else if (control.kind === 'switch') roots.push(control.value);
    else if (control.kind === 'indirect') roots.push(control.target);
    else if (control.kind === 'return') {
      roots.push(...control.values);
      if (!control.values.length && primary?.kind === 'register')
        for (const binding of states.get(block.id)?.exit ?? []) {
          context.checkpoint(1);
          if (binding.register.root === primary.register.root && entry.get(binding.register.id) !== binding.value.id)
            roots.push(binding.value);
        }
    }
    for (const edge of successors(control)) {
      const target = blocks.get(edge.target);
      if (!target) continue;
      for (let index = 0; index < target.parameters.length; index++) {
        context.checkpoint(1);
        const destination = target.parameters[index]!.id, sources = incoming.get(destination) ?? [];
        sources.push(edge.arguments[index]!);
        incoming.set(destination, sources);
      }
    }
  }
  return Object.freeze({
    query(
      input: SSAForm, profile: AbiProfile, queryContext: OperationContext,
      additionalRoots: readonly Value[] = [],
    ): ReadonlyMap<string, readonly RegisterDescriptor[]> {
      queryContext.checkpoint(0);
      if (input !== ir || profile !== abi)
        throw new TypeError('Call result demand index belongs to a different SSA or ABI stage');
      const demanded = new Map<string, Map<string, RegisterDescriptor>>();
      const pending = additionalRoots.map((value) =>
        ({ value, offset: 0, width: bitWidth(value.type) }));
      for (const value of roots) pending.push({ value, offset: 0, width: bitWidth(value.type) });
      const seen = new Set<string>();
      for (let index = 0; index < pending.length; index++) {
        queryContext.checkpoint(1);
        const { value, offset, width } = pending[index]!, key = `${value.id}:${offset}:${width}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const output = outputs.get(value.id);
        if (output) {
          const registers = demanded.get(output.call) ?? new Map<string, RegisterDescriptor>();
          const register = output.binding.register, high = register.offset_bits + offset + width;
          const previous = registers.get(register.root);
          registers.set(register.root, { ...register, offset_bits: 0,
            width_bits: Math.max(previous?.width_bits ?? 0, high) });
          demanded.set(output.call, registers);
        }
        const expression = expressions.get(value.id);
        if (expression?.kind === 'extract') pending.push({ value: expression.value,
          offset: expression.offset + offset, width });
        else if (expression?.kind === 'cast' && (expression.op === 'truncate' ||
          expression.op === 'zero_extend' || expression.op === 'sign_extend' || expression.op === 'bitcast')) {
          const available = bitWidth(expression.value.type);
          if (offset < available) pending.push({ value: expression.value, offset, width: Math.min(width, available - offset) });
          if (expression.op === 'sign_extend' && offset + width > available)
            pending.push({ value: expression.value, offset: available - 1, width: 1 });
        } else if (expression?.kind === 'concat') {
          let cursor = 0;
          for (const part of expression.values) {
            const end = cursor + bitWidth(part.type), low = Math.max(cursor, offset), high = Math.min(end, offset + width);
            if (low < high) pending.push({ value: part, offset: low - cursor, width: high - low });
            cursor = end;
          }
        } else if (expression)
          for (const operand of expressionOperands(expression)) {
            queryContext.checkpoint(1);
            pending.push({ value: operand, offset: 0, width: bitWidth(operand.type) });
          }
        for (const source of incoming.get(value.id) ?? []) {
          queryContext.checkpoint(1);
          pending.push({ value: source, offset, width });
        }
      }
      return new Map([...demanded].map(([call, registers]) => [call, [...registers.values()]]));
    },
  });
}
