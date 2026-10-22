import type { AbiProfile, OperationContext, RegisterDescriptor } from '../../core/index.js';
import {
  bitWidth,
  expressionOperands,
  successors,
  type Expression,
  type RegisterBinding,
  type SSAForm,
  type Value,
} from '../../ir/index.js';

/** Read-only access to private stage structure, never shared witness results. */
export interface CallPreparationIndex {
  assertStage(ir: SSAForm, context: OperationContext): void;
  entry(id: string): RegisterDescriptor | undefined;
  expression(id: string): Expression | undefined;
  isLoad(id: string): boolean;
  appendSources(id: string, target: Value[]): boolean;
}

/** Per-call result demand. `all` includes values whose only consumer is this
 * function's own return-exit snapshot (forwarded); `semantic` keeps only demand
 * reached from loads, stores, call arguments, control transfers, explicit
 * return values and supplied roots. A value reached from both is semantic. */
export interface CallResultDemands {
  readonly all: ReadonlyMap<string, readonly RegisterDescriptor[]>;
  readonly semantic: ReadonlyMap<string, readonly RegisterDescriptor[]>;
}

/** Structural facts for one unchanged SSA stage. Demand results are never cached. */
export interface CallResultDemandIndex {
  preparation(ir: SSAForm, abi: AbiProfile, context: OperationContext): CallPreparationIndex;
  query(
    ir: SSAForm,
    abi: AbiProfile,
    context: OperationContext,
    additionalRoots?: readonly Value[],
  ): CallResultDemands;
}

export function observeCallResultDemands(
  ir: SSAForm,
  abi: AbiProfile,
  context: OperationContext,
  additionalRoots: readonly Value[] = [],
  index?: CallResultDemandIndex,
): CallResultDemands {
  return (index ?? createCallResultDemandIndex(ir, abi, context)).query(
    ir,
    abi,
    context,
    additionalRoots,
  );
}

/** Semantic result consumption, independent of a callee's return guarantee.
 * Snapshot liveness does not demand every caller-saved output. Slices survive
 * extracts/truncation so consuming W0 never establishes unknown X0 high bits. */
export function createCallResultDemandIndex(
  ir: SSAForm,
  abi: AbiProfile,
  context: OperationContext,
): CallResultDemandIndex {
  const primary = abi
    .classifyCall({
      returns: { kind: 'pointer' },
      parameters: [],
      variadic: false,
      fixed_parameter_count: 0,
    })
    .returns.find((location) => location.kind === 'register');
  const expressions = new Map<string, Expression>(),
    incoming = new Map<string, Value[]>();
  const outputs = new Map<string, { readonly call: string; readonly binding: RegisterBinding }>();
  const loads = new Set<string>();
  const blocks = new Map(ir.blocks.map((block) => [block.id, block]));
  const states = new Map(ir.register_states.map((state) => [state.block, state]));
  const entry = new Map(
    (states.get(ir.entry)?.entry ?? []).map((binding) => [binding.register.id, binding.value.id]),
  );
  const roots: Value[] = [],
    forwarded: Value[] = [];
  for (const block of ir.blocks) {
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (node.kind === 'assign') expressions.set(node.result.id, node.expression);
      else if (node.kind === 'load') {
        loads.add(node.result.id);
        roots.push(node.address);
      } else if (node.kind === 'store') roots.push(node.address, node.value);
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
          if (
            binding.register.root === primary.register.root &&
            entry.get(binding.register.id) !== binding.value.id
          )
            forwarded.push(binding.value);
        }
    }
    for (const edge of successors(control)) {
      const target = blocks.get(edge.target);
      if (!target) continue;
      for (let index = 0; index < target.parameters.length; index++) {
        context.checkpoint(1);
        const destination = target.parameters[index]!.id,
          sources = incoming.get(destination) ?? [];
        sources.push(edge.arguments[index]!);
        incoming.set(destination, sources);
      }
    }
  }
  let preparation: CallPreparationIndex | undefined;
  return Object.freeze({
    preparation(
      input: SSAForm,
      profile: AbiProfile,
      queryContext: OperationContext,
    ): CallPreparationIndex {
      queryContext.checkpoint(0);
      if (input !== ir || profile !== abi)
        throw new TypeError('Call preparation index belongs to a different SSA or ABI stage');
      if (!preparation) {
        const entryByValue = new Map<string, RegisterDescriptor>();
        for (const binding of states.get(ir.entry)?.entry ?? []) {
          queryContext.checkpoint(1);
          entryByValue.set(binding.value.id, binding.register);
        }
        preparation = Object.freeze({
          assertStage(input: SSAForm, queryContext: OperationContext): void {
            queryContext.checkpoint(0);
            if (input !== ir)
              throw new TypeError('Call preparation index belongs to a different SSA stage');
          },
          entry: (id: string) => entryByValue.get(id),
          expression: (id: string) => expressions.get(id),
          isLoad: (id: string) => loads.has(id),
          appendSources(id: string, target: Value[]): boolean {
            const sources = incoming.get(id);
            if (!sources?.length) return false;
            for (const source of sources) target.push(source);
            return true;
          },
        });
      }
      return preparation;
    },
    query(
      input: SSAForm,
      profile: AbiProfile,
      queryContext: OperationContext,
      additionalRoots: readonly Value[] = [],
    ): CallResultDemands {
      queryContext.checkpoint(0);
      if (input !== ir || profile !== abi)
        throw new TypeError('Call result demand index belongs to a different SSA or ABI stage');
      const all = new Map<string, Map<string, RegisterDescriptor>>(),
        semantic = new Map<string, Map<string, RegisterDescriptor>>();
      const pending: { value: Value; offset: number; width: number; semantic: boolean }[] = [];
      const seen = new Set<string>();
      let index = 0;
      // Forwarded roots enter only after the semantic closure is complete, so a
      // slice reached from both is visited (and recorded) as semantic.
      for (const [phase, semanticPhase] of [
        [additionalRoots, true],
        [roots, true],
        [forwarded, false],
      ] as const) {
        for (const value of phase)
          pending.push({ value, offset: 0, width: bitWidth(value.type), semantic: semanticPhase });
        for (; index < pending.length; index++) {
          queryContext.checkpoint(1);
          const item = pending[index]!,
            { value, offset, width } = item,
            key = `${value.id}:${offset}:${width}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const output = outputs.get(value.id);
          if (output) {
            const register = output.binding.register,
              high = register.offset_bits + offset + width;
            for (const demanded of item.semantic ? [all, semantic] : [all]) {
              const registers = demanded.get(output.call) ?? new Map<string, RegisterDescriptor>();
              const previous = registers.get(register.root);
              registers.set(register.root, {
                ...register,
                offset_bits: 0,
                width_bits: Math.max(previous?.width_bits ?? 0, high),
              });
              demanded.set(output.call, registers);
            }
          }
          const expression = expressions.get(value.id);
          if (expression?.kind === 'extract')
            pending.push({
              value: expression.value,
              offset: expression.offset + offset,
              width,
              semantic: item.semantic,
            });
          else if (
            expression?.kind === 'cast' &&
            (expression.op === 'truncate' ||
              expression.op === 'zero_extend' ||
              expression.op === 'sign_extend' ||
              expression.op === 'bitcast')
          ) {
            const available = bitWidth(expression.value.type);
            if (offset < available)
              pending.push({
                value: expression.value,
                offset,
                width: Math.min(width, available - offset),
                semantic: item.semantic,
              });
            if (expression.op === 'sign_extend' && offset + width > available)
              pending.push({
                value: expression.value,
                offset: available - 1,
                width: 1,
                semantic: item.semantic,
              });
          } else if (expression?.kind === 'concat') {
            let cursor = 0;
            for (const part of expression.values) {
              const end = cursor + bitWidth(part.type),
                low = Math.max(cursor, offset),
                high = Math.min(end, offset + width);
              if (low < high)
                pending.push({
                  value: part,
                  offset: low - cursor,
                  width: high - low,
                  semantic: item.semantic,
                });
              cursor = end;
            }
          } else if (expression)
            for (const operand of expressionOperands(expression)) {
              queryContext.checkpoint(1);
              pending.push({
                value: operand,
                offset: 0,
                width: bitWidth(operand.type),
                semantic: item.semantic,
              });
            }
          for (const source of incoming.get(value.id) ?? []) {
            queryContext.checkpoint(1);
            pending.push({ value: source, offset, width, semantic: item.semantic });
          }
        }
      }
      const freeze = (demanded: Map<string, Map<string, RegisterDescriptor>>) =>
        new Map([...demanded].map(([call, registers]) => [call, [...registers.values()]]));
      return { all: freeze(all), semantic: freeze(semantic) };
    },
  });
}
