import type { OperationContext, RegisterDescriptor } from '../../core/index.js';
import {
  successors,
  type Expression,
  type Instruction,
  type RegisterBinding,
  type SSAForm,
  type Value,
} from '../../ir/index.js';
import type { CallPreparationIndex } from './result-demands.js';

/** A call, or an indirect exit seen as a call of its target. */
type CallNode = Pick<Extract<Instruction, { kind: 'call' }>, 'id' | 'target'>;
export type PreparedCallArgument = (call: CallNode, binding: RegisterBinding) => boolean;

/** Evidence for an authored physical ABI-slot value, not a recovered prototype.
 * Untouched entry state and unknown call clobbers are not preparation. Copies
 * and phis must lead to preparation/forwarding on every path. A callable target
 * is not itself evidence that the same value is a first source argument. */
export function preparedCallArguments(
  ir: SSAForm,
  context: OperationContext,
  index?: CallPreparationIndex,
): PreparedCallArgument {
  index?.assertStage(ir, context);
  const entry = index
    ? undefined
    : new Map<string, RegisterDescriptor>(
        (ir.register_states.find((row) => row.block === ir.entry)?.entry ?? []).map((binding) => [
          binding.value.id,
          binding.register,
        ]),
      );
  const definitions = index
    ? undefined
    : new Map<string, Extract<Instruction, { kind: 'assign' | 'load' }>>();
  const sources = index ? undefined : new Map<string, Value[]>();
  if (!index) {
    const blocks = new Map(ir.blocks.map((block) => [block.id, block]));
    for (const block of ir.blocks) {
      for (const node of block.instructions) {
        context.checkpoint(1);
        if (node.kind === 'assign' || node.kind === 'load') definitions!.set(node.result.id, node);
      }
      for (const edge of successors(block.terminator))
        for (const [slot, source] of edge.arguments.entries()) {
          context.checkpoint(1);
          const destination = blocks.get(edge.target)?.parameters[slot];
          if (!destination) continue;
          const operands = sources!.get(destination.id) ?? [];
          operands.push(source);
          sources!.set(destination.id, operands);
        }
    }
  }
  const appendSources = (id: string, target: Value[]): boolean => {
    if (index) return index.appendSources(id, target);
    const operands = sources!.get(id);
    if (!operands?.length) return false;
    for (const operand of operands) target.push(operand);
    return true;
  };
  const storageOperands = (expression: Expression | undefined): readonly Value[] | null => {
    if (
      expression?.kind === 'cast' &&
      ['bitcast', 'truncate', 'zero_extend', 'sign_extend'].includes(expression.op)
    )
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
    if (cached !== undefined) {
      context.checkpoint(0);
      return cached;
    }
    let target = targets.get(call.id);
    if (!target) {
      const aliases = new Set<string>();
      const pending = call.target.kind === 'indirect' ? [call.target.value] : [];
      while (pending.length) {
        context.checkpoint(1);
        const value = pending.pop()!;
        if (aliases.has(value.id)) continue;
        aliases.add(value.id);
        const definition = definitions?.get(value.id);
        const expression = index
          ? index.expression(value.id)
          : definition?.kind === 'assign'
            ? definition.expression
            : undefined;
        const operands = storageOperands(expression);
        if (operands) pending.push(...operands);
        else appendSources(value.id, pending);
      }
      targets.set(call.id, aliases);
      target = aliases;
    }
    const pending = [binding.value],
      seen = new Set<string>();
    let reached = false,
      prepared = true;
    while (pending.length) {
      context.checkpoint(1);
      const value = pending.pop()!;
      if (seen.has(value.id)) continue;
      seen.add(value.id);
      if (target.has(value.id)) {
        prepared = false;
        break;
      }
      const incoming = index ? index.entry(value.id) : entry!.get(value.id);
      if (incoming) {
        if (
          incoming.root === binding.register.root ||
          incoming.role !== 'general' ||
          (incoming.bank !== 'integer' && incoming.bank !== 'float' && incoming.bank !== 'vector')
        ) {
          prepared = false;
          break;
        }
        reached = true;
        continue;
      }
      const definition = definitions?.get(value.id);
      if (index ? index.isLoad(value.id) : definition?.kind === 'load') {
        reached = true;
        continue;
      }
      const expression = index
        ? index.expression(value.id)
        : definition?.kind === 'assign'
          ? definition.expression
          : undefined;
      const operands = storageOperands(expression);
      let followed = false;
      if (operands?.length) {
        pending.push(...operands);
        followed = true;
      } else if (operands === null) followed = appendSources(value.id, pending);
      if (!followed) {
        if (expression && expression.kind !== 'indeterminate') reached = true;
        else {
          prepared = false;
          break;
        }
      }
    }
    const result = prepared && reached;
    results.set(key, result);
    return result;
  };
}
