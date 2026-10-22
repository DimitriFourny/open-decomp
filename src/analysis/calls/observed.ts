import type {
  AbiProfile,
  AbiCallLayout,
  OperationContext,
  RegisterDescriptor,
} from '../../core/index.js';
import {
  integer,
  type DataType,
  type Instruction,
  type RegisterBinding,
  type SSAForm,
  type Terminator,
  type Value,
} from '../../ir/index.js';
import type { CallAnalysisResult } from './index.js';
import { observeCallResultDemands, type CallResultDemandIndex } from './result-demands.js';
import { preparedCallArguments, type PreparedCallArgument } from './argument-preparation.js';

export interface ObservedCall {
  readonly call_id: string;
  readonly parameter_state: 'observed';
  readonly parameters: readonly RegisterDescriptor[];
  readonly parameter_types: readonly DataType[];
  readonly returns: readonly RegisterDescriptor[];
  readonly return_types: readonly DataType[];
  readonly argument_list_complete: false;
  readonly evidence_ids: readonly string[];
}

/** Recover caller-authored physical input prefixes, not callback prototypes.
 * Explicit load/constant/computation setup and different incoming-value
 * forwarding witness slot preparation, not a source type or every value bit.
 * Once witnessed, the whole physical carrier survives, including unknown upper
 * cells. Merely live/initialized snapshots alone are not preparation. Untouched
 * trailing slots and outgoing stack bytes remain unresolved.
 * Result widths describe consumed storage bits, never an upper-bit contract.
 * Physical snapshots are not semantic demand roots. Work is charged to the
 * enclosing selected-function operation; no callee discovery occurs here. */
export function observePreparedCallInterfaces(
  ir: SSAForm,
  abi: AbiProfile,
  analysis: CallAnalysisResult | null,
  context: OperationContext,
  demandIndex?: CallResultDemandIndex,
): readonly ObservedCall[] {
  if (!analysis || analysis.state !== 'complete') return [];
  const facts = new Map(analysis.calls.map((call) => [call.node_id, call]));
  const calls: Extract<Instruction, { kind: 'call' }>[] = [];
  for (const block of ir.blocks)
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (node.kind !== 'call') continue;
      const fact = facts.get(node.id);
      if (
        fact?.status === 'conflicting' ||
        fact?.contracts.some((contract) => contract.status === 'established')
      )
        continue;
      calls.push(node);
    }
  if (!calls.length) return [];
  const layout = observationLayout(abi);
  const primary = layout.layout.returns.find((location) => location.kind === 'register');
  const prepared = preparedCallArguments(ir, context, demandIndex?.preparation(ir, abi, context));
  const prefixes = new Map<string, RegisterDescriptor[]>();
  const roots: Value[] = [];
  for (const call of calls)
    prefixes.set(
      call.id,
      preparedPrefix(call, call.register_inputs, layout, prepared, context, roots),
    );
  const demanded = observeCallResultDemands(ir, abi, context, roots, demandIndex).all;
  return calls.map((call): ObservedCall => {
    context.checkpoint(1);
    const parameters = prefixes.get(call.id)!;
    const returns = (demanded.get(call.id) ?? []).filter(
      (register) => primary?.kind === 'register' && register.root === primary.register.root,
    );
    return {
      call_id: call.id,
      parameter_state: 'observed',
      parameters,
      parameter_types: parameters.map((register) => integer(register.width_bits)),
      returns,
      return_types: returns.map((register) => integer(register.width_bits)),
      argument_list_complete: false,
      evidence_ids: call.provenance.evidence_ids,
    };
  });
}

/** Source view only: the caller-authored argument-register prefix at each
 * unresolved indirect exit (an `indirect` terminator without `tail_call`),
 * observed from its exit register state exactly like an indirect call's
 * inputs. A prefix, never a closed list; no result is observed. These records
 * are not native call interfaces and never enter callee summaries. */
export function observePreparedTailInterfaces(
  ir: SSAForm,
  abi: AbiProfile,
  context: OperationContext,
  demandIndex?: CallResultDemandIndex,
): readonly ObservedCall[] {
  const exits: {
    readonly block: string;
    readonly exit: Extract<Terminator, { kind: 'indirect' }>;
  }[] = [];
  for (const block of ir.blocks)
    if (block.terminator.kind === 'indirect' && !block.terminator.tail_call)
      exits.push({ block: block.id, exit: block.terminator });
  if (!exits.length) return [];
  const layout = observationLayout(abi);
  const prepared = preparedCallArguments(ir, context, demandIndex?.preparation(ir, abi, context));
  const states = new Map(ir.register_states.map((row) => [row.block, row.exit]));
  return exits.map(({ block, exit }): ObservedCall => {
    const parameters = preparedPrefix(
      { id: exit.id, target: { kind: 'indirect', value: exit.target } },
      states.get(block) ?? [],
      layout,
      prepared,
      context,
    );
    return {
      call_id: exit.id,
      parameter_state: 'observed',
      parameters,
      parameter_types: parameters.map((register) => integer(register.width_bits)),
      returns: [],
      return_types: [],
      argument_list_complete: false,
      evidence_ids: exit.provenance.evidence_ids,
    };
  });
}

/** A 16-pointer-argument call layout and its argument register roots. */
interface ObservationLayout {
  readonly layout: AbiCallLayout;
  readonly argumentRoots: ReadonlySet<string>;
}

function observationLayout(abi: AbiProfile): ObservationLayout {
  const pointer = { kind: 'pointer' as const };
  const layout = abi.classifyCall({
    returns: pointer,
    parameters: Array.from({ length: 16 }, () => pointer),
    variadic: false,
    fixed_parameter_count: 16,
  });
  const argumentRoots = new Set<string>();
  for (const parameter of layout.parameters)
    for (const location of parameter.locations)
      if (location.kind === 'register') argumentRoots.add(location.register.root);
  return { layout, argumentRoots };
}

/** The ABI argument registers of `bindings`, in order, while each is a whole
 * witnessed (`prepared`) slot; the values of the prefix are appended to `roots`. */
function preparedPrefix(
  site: Parameters<PreparedCallArgument>[0],
  bindings: readonly RegisterBinding[],
  { layout, argumentRoots }: ObservationLayout,
  prepared: PreparedCallArgument,
  context: OperationContext,
  roots?: Value[],
): RegisterDescriptor[] {
  const byRoot = new Map<string, RegisterBinding[]>();
  for (const binding of bindings) {
    context.checkpoint(1);
    if (!argumentRoots.has(binding.register.root)) continue;
    const list = byRoot.get(binding.register.root) ?? [];
    list.push(binding);
    byRoot.set(binding.register.root, list);
  }
  const prefix: RegisterDescriptor[] = [];
  for (const parameter of layout.parameters) {
    context.checkpoint(1);
    if (parameter.locations.length !== 1 || parameter.locations[0]!.kind !== 'register') break;
    const location = parameter.locations[0]!,
      register = location.register;
    let width = 0,
      witnessed = false;
    const values: Value[] = [];
    const cells = (byRoot.get(register.root) ?? []).sort(
      (left, right) => left.register.offset_bits - right.register.offset_bits,
    );
    for (const binding of cells) {
      context.checkpoint(1);
      if (
        binding.register.offset_bits < register.offset_bits ||
        binding.register.offset_bits >= register.offset_bits + location.width_bits
      )
        continue;
      if (binding.register.offset_bits !== register.offset_bits + width) break;
      width += Math.min(binding.register.width_bits, location.width_bits - width);
      witnessed ||= prepared(site, binding);
      values.push(binding.value);
    }
    if (!witnessed || width !== location.width_bits) break;
    // Preparation identifies the ABI slot, not a scalar source prototype.
    // Keep its entire carrier: a preserving partial write does not zero or
    // discard untouched high cells, including unknown ones.
    prefix.push({ ...register, width_bits: location.width_bits });
    roots?.push(...values);
  }
  return prefix;
}
