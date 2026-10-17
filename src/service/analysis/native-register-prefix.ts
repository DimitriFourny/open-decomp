import type { OperationContext, RegisterDescriptor } from '../../core/index.js';
import { bitWidth, expressionOperands, type Expression, type RegisterIR, type Value } from '../../ir/index.js';
import type { NativeInterface } from './native-worklist.js';

/** Useful entry-path observations before optional SSA preparation finishes.
 * Only register reads before their first write/clobber can be incoming values.
 * Read-register snapshots/RET capacity reads are not semantic observations; a
 * prefix requires an actual address/control/explicit argument use. Other blocks,
 * stack arguments, return guarantees and full source arity remain unresolved. */
export function nativeRegisterPrefix(
  ir: RegisterIR,
  candidates: readonly RegisterDescriptor[],
  context: OperationContext,
): NativeInterface {
  const entry = ir.blocks.find((block) => block.id === ir.entry);
  if (!entry) return { parameters: [], returns: [], parameter_state: 'ambiguous', argument_list_complete: false };
  const written = new Set<string>(), incoming = new Map<string, RegisterDescriptor>();
  const expressions = new Map<string, Expression>(), roots: Value[] = [];
  for (const node of entry.instructions) {
    context.checkpoint(1);
    if (node.kind === 'read_register' && !written.has(node.register.root)) incoming.set(node.result.id, node.register);
    else if (node.kind === 'write_register') written.add(node.register.root);
    else if (node.kind === 'assign') expressions.set(node.result.id, node.expression);
    else if (node.kind === 'load') roots.push(node.address);
    else if (node.kind === 'store') roots.push(node.address);
    else if (node.kind === 'call') {
      roots.push(...node.arguments);
      if (node.target.kind === 'indirect') roots.push(node.target.value);
      break;
    } else if (node.kind === 'unknown_effect') break;
  }
  const control = entry.terminator;
  if (control.kind === 'branch') roots.push(control.condition);
  else if (control.kind === 'switch') roots.push(control.value);
  else if (control.kind === 'indirect') roots.push(control.target);
  const observed = new Map<string, number>(), seen = new Set<string>();
  for (let index = 0; index < roots.length; index++) {
    context.checkpoint(1);
    const value = roots[index]!;
    if (seen.has(value.id)) continue;
    seen.add(value.id);
    const register = incoming.get(value.id);
    if (register) observed.set(register.root, Math.max(observed.get(register.root) ?? 0,
      register.offset_bits + Math.min(register.width_bits, bitWidth(value.type))));
    const expression = expressions.get(value.id);
    if (expression) for (const operand of expressionOperands(expression)) roots.push(operand);
  }
  const parameters = candidates.flatMap((register) => {
    const width = observed.get(register.root);
    return width ? [{ ...register, width_bits: Math.min(width, register.width_bits) }] : [];
  });
  return { parameters, parameter_types: parameters.map((register) => ({ kind: 'integer', bits: register.width_bits })),
    returns: [], parameter_state: 'ambiguous', argument_list_complete: false };
}
