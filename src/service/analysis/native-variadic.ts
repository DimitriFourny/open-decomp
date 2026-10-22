import {
  OperationError,
  type AbiProfile,
  type OperationContext,
  type RegisterDescriptor,
} from '../../core/index.js';
import type { CallAnalysisResult } from '../../analysis/calls/index.js';
import type { TypeRecoveryResult } from '../../analysis/types/index.js';
import { expressionOperands, type Expression, type SSAForm, type Value } from '../../ir/index.js';
import { structureControlFlow } from '../../presentation/index.js';
import { reconstruct } from '../../reconstruction/index.js';
import type { InferredCallee } from '../../reconstruction/source-model.js';
import { parameterRegisters } from './native-abi.js';
import { nativeIncomingStackEscapes } from './native-transfer.js';

/** A callee's `va_start` footprint as the source view classifies it (S6/S7),
 * kept with its prepared unit: the named argument registers in position order
 * (null on Darwin arm64, whose classification leaves them to the observed
 * register prefix: no anonymous argument occupies a register there) and the
 * bytes of named stack arguments before the first anonymous one. */
export interface NativeVariadicFootprint {
  readonly named: readonly RegisterDescriptor[] | null;
  readonly named_stack_bytes: bigint;
}

/** The footprint as callers see it (`NativeInterface.variadic`, S8). */
export type NativeVariadic = NonNullable<InferredCallee['variadic']>;

/** Publish a footprint over its named registers (Darwin: `observed`, the
 * body's observed register prefix). */
export function nativeVariadicInterface(
  footprint: NativeVariadicFootprint,
  observed: readonly RegisterDescriptor[],
): NativeVariadic {
  const named = footprint.named ?? observed;
  return {
    named_integer: named.filter((register) => register.bank === 'integer').length,
    named_vector: named.filter((register) => register.bank !== 'integer').length,
    named_stack_bytes: footprint.named_stack_bytes,
    named,
  };
}

/** Cheap necessary condition of the S6/S7 classifiers on the SSA body: an
 * incoming-stack address escapes (every SysV `va_start` stores
 * `overflow_arg_area`), or (Darwin arm64, Win64) an exact address at or above
 * the lowest possible first anonymous slot is stored, passed in an integer
 * argument register, or the base of a memory access at a non-constant offset. */
function variadicCandidate(
  ir: SSAForm,
  abi: AbiProfile,
  analysis: CallAnalysisResult,
  context: OperationContext,
): boolean {
  if (analysis.stack.state !== 'complete') return false;
  if (nativeIncomingStackEscapes(ir, abi, analysis, context)) return true;
  if (abi.id !== 'darwin-arm64' && abi.id !== 'windows-x64') return false;
  // Win64's home area is no `incoming_candidate` region, so its addresses
  // escape unseen by the shared check.
  const floor = abi.id === 'windows-x64' ? 16n : 0n;
  const anonymous = (id: string): boolean => {
    const fact = analysis.stack.values.get(id)?.value;
    return fact?.kind === 'stack' && fact.offset >= floor;
  };
  const integers = new Set(
    parameterRegisters(abi)
      .filter((register) => register.bank === 'integer')
      .map((register) => register.root),
  );
  const definitions = new Map<string, Expression>(),
    sources = new Map<string, Value[]>(),
    byId = new Map(ir.blocks.map((block) => [block.id, block]));
  for (const block of ir.blocks) {
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (node.kind === 'assign') definitions.set(node.result.id, node.expression);
      else if (node.kind === 'store' && anonymous(node.value.id)) return true;
      else if (
        node.kind === 'call' &&
        node.register_inputs.some(
          (binding) => integers.has(binding.register.root) && anonymous(binding.value.id),
        )
      )
        return true;
    }
    const control = block.terminator;
    const edges =
      control.kind === 'jump'
        ? [control.edge]
        : control.kind === 'branch'
          ? [control.when_true, control.when_false]
          : control.kind === 'switch'
            ? [...control.cases.map((item) => item.edge), control.otherwise]
            : [];
    for (const edge of edges) {
      const target = byId.get(edge.target);
      for (const [index, value] of edge.arguments.entries()) {
        const parameter = target?.parameters[index];
        if (!parameter) continue;
        const list = sources.get(parameter.id) ?? [];
        list.push(value);
        sources.set(parameter.id, list);
      }
    }
  }
  const incomingBased = (start: Value): boolean => {
    const pending = [start],
      seen = new Set<string>();
    while (pending.length && seen.size <= 64) {
      context.checkpoint(1);
      const value = pending.pop()!;
      if (seen.has(value.id)) continue;
      seen.add(value.id);
      const fact = analysis.stack.values.get(value.id)?.value;
      if (fact?.kind === 'stack') {
        if (fact.offset >= floor) return true;
        continue;
      }
      const expression = definitions.get(value.id);
      if (expression) pending.push(...expressionOperands(expression));
      else pending.push(...(sources.get(value.id) ?? []));
    }
    return false;
  };
  for (const block of ir.blocks)
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (
        (node.kind === 'load' || node.kind === 'store') &&
        analysis.stack.values.get(node.address.id)?.value.kind === 'dynamic_stack' &&
        incomingBased(node.address)
      )
        return true;
    }
  return false;
}

/** The callee's `va_start` footprint, from the same source-view classification
 * (`classifyVariadicArea` / `classifySysvVaStart` through `reconstruct`) that
 * prints its `...`. Its calls stay physical here, so every argument register
 * they may receive counts as a use: the classification is at most as
 * permissive as the function's own source view. Null: no footprint. A work
 * limit or cancellation that cuts structuring short is thrown, never turned
 * into "no footprint": the caller must know the result depends on its limits. */
export function nativeVariadicFootprint(
  ir: SSAForm,
  types: TypeRecoveryResult | null,
  abi: AbiProfile,
  analysis: CallAnalysisResult | null,
  context: OperationContext,
): NativeVariadicFootprint | null {
  if (!types?.calls || !analysis || types.state !== 'complete') return null;
  if (!variadicCandidate(ir, abi, analysis, context)) return null;
  const structured = structureControlFlow(ir, context, {
    // The context's own limits bound structuring.
    max_work: context.remainingWork?.() ?? Number.MAX_SAFE_INTEGER,
    search: false,
  });
  const cut = structured.diagnostics.find(
    (diagnostic) => diagnostic.code === 'resource_limit' || diagnostic.code === 'cancelled',
  );
  if (cut) throw new OperationError(cut);
  if (structured.state !== 'complete' || !structured.value) return null;
  const program = reconstruct(
    { function: structured.value, types, source: { abi, callees: [], addresses: [] } },
    context,
    'source',
  );
  const variadic = program.source?.variadic;
  if (!variadic) return null;
  // Darwin: the area starts after the named stack formals; the named
  // registers stay the observed prefix (`nativeVariadicInterface`).
  if (variadic.kind === 'area' && abi.id === 'darwin-arm64')
    return { named: null, named_stack_bytes: variadic.offset };
  // SysV and Win64: the named registers are the formals `va_start`'s
  // classification bound (gp/fp offsets, Win64's area offset). SysV lists
  // every integer register before the vector ones (`parameterRegisters`);
  // Win64 positions share one sequence, so a register's place is its index
  // within its own class.
  const candidates = parameterRegisters(abi);
  const order = (register: RegisterDescriptor): number =>
    abi.id === 'windows-x64'
      ? candidates
          .filter((candidate) => candidate.bank === register.bank)
          .findIndex((candidate) => candidate.root === register.root)
      : candidates.findIndex((candidate) => candidate.root === register.root);
  const named = program.parameters
    .flatMap((formal) => {
      const register = program.parameter_registers.get(formal.id);
      return register && candidates.some((candidate) => candidate.root === register.root)
        ? [register]
        : [];
    })
    .sort((left, right) => order(left) - order(right));
  // Win64's area lies in the home area (no named stack bytes); SysV's named
  // stack formals tile [8, overflow_arg_area).
  let stackEnd = abi.stack_return_address_bytes;
  if (variadic.kind === 'va_list')
    for (const offset of program.source?.formal_stack_offsets?.values() ?? [])
      if (offset + 8n > stackEnd) stackEnd = offset + 8n;
  return { named, named_stack_bytes: stackEnd - abi.stack_return_address_bytes };
}
