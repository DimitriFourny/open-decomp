import type { OperationContext, RegisterDescriptor } from '../../core/index.js';
import { bitWidth, expressionOperands, successors, type Expression, type Instruction, type RegisterBinding, type SSAForm, type Value } from '../../ir/index.js';
import type { NativeInterface } from './native-worklist.js';

/** SSA-backed prefix observations available even when optional stack/type
 * refinement stops. This is deliberately incomplete: it never closes arity or
 * promotes entry-SP-relative bytes into guessed source parameters. Private
 * register preservation is not an observation. All unknown call effects remain
 * in the original IR, independently of these input constraints. */
export function nativeEntryRegisters(
  ir: SSAForm,
  candidates: readonly RegisterDescriptor[],
  interfaces: ReadonlyMap<string, NativeInterface>,
  returned: readonly RegisterDescriptor[],
  context: OperationContext,
): readonly RegisterDescriptor[] {
  const states = new Map(ir.register_states.map((state) => [state.block, state]));
  const entry = new Map((states.get(ir.entry)?.entry ?? []).map((binding) => [binding.value.id, binding.register]));
  const expressions = new Map<string, Expression>(), sources = new Map<string, Value[]>();
  const blocks = new Map(ir.blocks.map((block) => [block.id, block]));
  const roots: { readonly value: Value; readonly width: number; readonly offset: number }[] = [];
  const stores: Extract<Instruction, { kind: 'store' }>[] = [];
  const observeBindings = (bindings: readonly RegisterBinding[], registers: readonly RegisterDescriptor[]): void => {
    for (const register of registers)
      for (const binding of bindings) {
        context.checkpoint(1);
        if (binding.register.root !== register.root) continue;
        const low = Math.max(binding.register.offset_bits, register.offset_bits),
          high = Math.min(binding.register.offset_bits + binding.register.width_bits,
            register.offset_bits + register.width_bits);
        if (low < high) roots.push({ value: binding.value,
          offset: low - binding.register.offset_bits, width: high - low });
      }
  };
  for (const block of ir.blocks) {
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (node.kind === 'assign') expressions.set(node.result.id, node.expression);
      else if (node.kind === 'load') roots.push({ value: node.address, offset: 0, width: bitWidth(node.address.type) });
      else if (node.kind === 'store') stores.push(node);
      else if (node.kind === 'call') {
        for (const value of node.arguments) roots.push({ value, offset: 0, width: bitWidth(value.type) });
        if (node.target.kind === 'indirect') roots.push({ value: node.target.value, offset: 0, width: bitWidth(node.target.value.type) });
        observeBindings(node.register_inputs, interfaces.get(node.id)?.parameters ?? []);
      }
    }
    const control = block.terminator;
    const value = control.kind === 'branch' ? control.condition : control.kind === 'switch' ? control.value
      : control.kind === 'indirect' ? control.target : null;
    if (value) roots.push({ value, offset: 0, width: bitWidth(value.type) });
    if (control.kind === 'return') {
      for (const value of control.values) roots.push({ value, offset: 0, width: bitWidth(value.type) });
      observeBindings(states.get(block.id)?.exit ?? [], returned);
    } else if (control.kind === 'indirect' && control.tail_call)
      observeBindings(states.get(block.id)?.exit ?? [], interfaces.get(control.id)?.parameters ?? []);
    for (const edge of successors(control))
      for (const [index, source] of edge.arguments.entries()) {
        context.checkpoint(1);
        const destination = blocks.get(edge.target)?.parameters[index];
        if (!destination) continue;
        const known = sources.get(destination.id) ?? [];
        known.push(source); sources.set(destination.id, known);
      }
  }
  for (const store of stores) {
    const pending = [store.address], visited = new Set<string>();
    let stack = false, other = false;
    while (pending.length) {
      context.checkpoint(1);
      const value = pending.pop()!;
      if (visited.has(value.id)) continue;
      visited.add(value.id);
      const register = entry.get(value.id);
      if (register) {
        if (register.role === 'stack_pointer') stack = true;
        else other = true;
        continue;
      }
      const expression = expressions.get(value.id);
      if (expression)
        for (const operand of expressionOperands(expression)) pending.push(operand);
      else {
        const incoming = sources.get(value.id);
        if (!incoming?.length) other = true;
        else for (const source of incoming) pending.push(source);
      }
    }
    roots.push({ value: store.address, offset: 0, width: bitWidth(store.address.type) });
    if (!stack || other) roots.push({ value: store.value, offset: 0, width: bitWidth(store.value.type) });
  }
  const observed = new Map<string, number>(), seen = new Set<string>();
  for (let index = 0; index < roots.length; index++) {
    context.checkpoint(1);
    const { value, width, offset } = roots[index]!, key = `${value.id}:${offset}:${width}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const incoming = entry.get(value.id);
    if (incoming) observed.set(incoming.root, Math.max(observed.get(incoming.root) ?? 0,
      incoming.offset_bits + offset + width));
    const expression = expressions.get(value.id);
    if (expression?.kind === 'extract') roots.push({ value: expression.value, width, offset: offset + expression.offset });
    else if (expression?.kind === 'cast' && (expression.op === 'truncate' || expression.op === 'bitcast' ||
      expression.op === 'zero_extend' || expression.op === 'sign_extend')) {
      const available = bitWidth(expression.value.type);
      if (offset < available) roots.push({ value: expression.value, offset, width: Math.min(width, available - offset) });
    } else if (expression)
      for (const value of expressionOperands(expression)) {
        context.checkpoint(1);
        roots.push({ value, offset: 0, width: bitWidth(value.type) });
      }
    for (const source of sources.get(value.id) ?? []) roots.push({ value: source, offset, width });
  }
  return candidates.flatMap((register) => {
    const width = observed.get(register.root);
    return width ? [{ ...register, width_bits: Math.min(width, register.width_bits) }] : [];
  });
}
