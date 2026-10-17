import type { AbiProfile, OperationContext, RegisterDescriptor } from '../../core/index.js';
import { integer, type DataType, type Instruction, type SSAForm, type Value } from '../../ir/index.js';
import type { CallAnalysisResult } from './index.js';
import { observeCallResultDemands } from './result-demands.js';

export interface ObservedIndirectCall {
  readonly call_id: string;
  readonly parameter_state: 'observed';
  readonly parameters: readonly RegisterDescriptor[];
  readonly parameter_types: readonly DataType[];
  readonly returns: readonly RegisterDescriptor[];
  readonly return_types: readonly DataType[];
  readonly argument_list_complete: false;
  readonly evidence_ids: readonly string[];
}

/** Recover observed incoming-value forwarding, not a callback prototype.
 * A changed ABI argument slot carrying a different incoming argument establishes
 * a prefix value (e.g. X1 -> X0), whereas merely live/initialized registers do
 * not. Untouched trailing slots and outgoing stack bytes remain unresolved.
 * Result widths describe consumed storage bits, never an upper-bit contract.
 * Physical snapshots are not semantic demand roots. Work is charged to the
 * enclosing selected-function operation; no callee discovery occurs here. */
export function observeIndirectCallInterfaces(
  ir: SSAForm,
  abi: AbiProfile,
  analysis: CallAnalysisResult | null,
  context: OperationContext,
): readonly ObservedIndirectCall[] {
  if (!analysis || analysis.state !== 'complete') return [];
  const facts = new Map(analysis.calls.map((call) => [call.node_id, call]));
  const calls: Extract<Instruction, { kind: 'call' }>[] = [];
  for (const block of ir.blocks)
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (node.kind !== 'call' || node.target.kind !== 'indirect') continue;
      const fact = facts.get(node.id);
      if (fact?.status === 'conflicting' || fact?.contracts.some((contract) => contract.status === 'established'))
        continue;
      calls.push(node);
    }
  if (!calls.length) return [];
  const pointer = { kind: 'pointer' as const };
  const layout = abi.classifyCall({
    returns: pointer, parameters: Array.from({ length: 16 }, () => pointer),
    variadic: false, fixed_parameter_count: 16,
  });
  const primary = layout.returns.find((location) => location.kind === 'register');
  const prefixes = new Map<string, RegisterDescriptor[]>();
  const roots: Value[] = [];
  for (const call of calls) {
    const prefix: RegisterDescriptor[] = [];
    for (const parameter of layout.parameters) {
      context.checkpoint(1);
      if (parameter.locations.length !== 1 || parameter.locations[0]!.kind !== 'register') break;
      const location = parameter.locations[0]!, register = location.register;
      let width = 0, low = false;
      const values: Value[] = [];
      for (const binding of call.register_inputs) {
        context.checkpoint(1);
        if (binding.register.root !== register.root || binding.register.offset_bits < register.offset_bits ||
            binding.register.offset_bits >= register.offset_bits + location.width_bits) continue;
        const incoming = analysis.stack.values.get(binding.value.id)?.incoming_registers ?? [];
        if (!incoming.length || !incoming.every((input) => input.root !== register.root && input.role === 'general'))
          continue;
        low ||= binding.register.offset_bits === register.offset_bits;
        width = Math.max(width, binding.register.offset_bits + binding.register.width_bits - register.offset_bits);
        values.push(binding.value);
      }
      if (!low || !width) break;
      prefix.push({ ...register, width_bits: width });
      roots.push(...values);
    }
    prefixes.set(call.id, prefix);
  }
  const demanded = observeCallResultDemands(ir, abi, context, roots);
  return calls.map((call): ObservedIndirectCall => {
    context.checkpoint(1);
    const parameters = prefixes.get(call.id)!;
    const returns = (demanded.get(call.id) ?? []).filter((register) =>
      primary?.kind === 'register' && register.root === primary.register.root);
    return {
      call_id: call.id, parameter_state: 'observed', parameters,
      parameter_types: parameters.map((register) => integer(register.width_bits)),
      returns, return_types: returns.map((register) => integer(register.width_bits)),
      argument_list_complete: false, evidence_ids: call.provenance.evidence_ids,
    };
  });
}
