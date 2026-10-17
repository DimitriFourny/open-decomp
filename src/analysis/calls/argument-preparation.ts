import type { OperationContext, RegisterDescriptor } from '../../core/index.js';
import { successors, type Expression, type Instruction, type RegisterBinding, type SSAForm, type Value } from '../../ir/index.js';

type CallNode = Extract<Instruction, { kind: 'call' }>;
export type PreparedCallArgument = (call: CallNode, binding: RegisterBinding) => boolean;

/** Evidence for an authored physical ABI-slot value, not a recovered prototype.
 * Untouched entry state and unknown call clobbers are not preparation. Copies
 * and phis must lead to preparation/forwarding on every path. A callable target
 * is not itself evidence that the same value is a first source argument. */
export function preparedCallArguments(ir: SSAForm, context: OperationContext): PreparedCallArgument {
  const entry = new Map<string, RegisterDescriptor>((ir.register_states.find((row) => row.block === ir.entry)?.entry ?? [])
    .map((binding) => [binding.value.id, binding.register]));
  const definitions = new Map<string, Extract<Instruction, { kind: 'assign' | 'load' }>>();
  const sources = new Map<string, Value[]>();
  const blocks = new Map(ir.blocks.map((block) => [block.id, block]));
  for (const block of ir.blocks) {
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (node.kind === 'assign' || node.kind === 'load') definitions.set(node.result.id, node);
    }
    for (const edge of successors(block.terminator))
      for (const [index, source] of edge.arguments.entries()) {
        context.checkpoint(1);
        const destination = blocks.get(edge.target)?.parameters[index];
        if (!destination) continue;
        const operands = sources.get(destination.id) ?? [];
        operands.push(source);
        sources.set(destination.id, operands);
      }
  }
  const storageOperands = (expression: Expression | undefined): readonly Value[] | null => {
    if (expression?.kind === 'cast' && ['bitcast', 'truncate', 'zero_extend', 'sign_extend'].includes(expression.op))
      return [expression.value];
    if (expression?.kind === 'extract') return [expression.value];
    if (expression?.kind === 'concat') return expression.values;
    return null;
  };
  const targets = new Map<string, ReadonlySet<string>>();
  const results = new Map<string, boolean>();
  return (call, binding): boolean => {
    const key = `${call.id}:${binding.register.root}:${binding.value.id}`;
    const cached = results.get(key);
    if (cached !== undefined) { context.checkpoint(0); return cached; }
    let target = targets.get(call.id);
    if (!target) {
      const aliases = new Set<string>();
      const pending = call.target.kind === 'indirect' ? [call.target.value] : [];
      while (pending.length) {
        context.checkpoint(1);
        const value = pending.pop()!;
        if (aliases.has(value.id)) continue;
        aliases.add(value.id);
        const definition = definitions.get(value.id);
        const operands = storageOperands(definition?.kind === 'assign' ? definition.expression : undefined)
          ?? sources.get(value.id);
        if (operands) pending.push(...operands);
      }
      targets.set(call.id, aliases);
      target = aliases;
    }
    const pending = [binding.value], seen = new Set<string>();
    let reached = false, prepared = true;
    while (pending.length) {
      context.checkpoint(1);
      const value = pending.pop()!;
      if (seen.has(value.id)) continue;
      seen.add(value.id);
      if (target.has(value.id)) { prepared = false; break; }
      const incoming = entry.get(value.id);
      if (incoming) {
        if (incoming.root === binding.register.root || incoming.role !== 'general' ||
            (incoming.bank !== 'integer' && incoming.bank !== 'float' && incoming.bank !== 'vector')) {
          prepared = false;
          break;
        }
        reached = true;
        continue;
      }
      const definition = definitions.get(value.id);
      if (definition?.kind === 'load') { reached = true; continue; }
      const expression = definition?.expression;
      const operands = storageOperands(expression) ?? sources.get(value.id);
      if (operands?.length) pending.push(...operands);
      else if (expression && expression.kind !== 'indeterminate') reached = true;
      else { prepared = false; break; }
    }
    const result = prepared && reached;
    results.set(key, result);
    return result;
  };
}
