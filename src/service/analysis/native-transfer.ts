import type { AbiProfile, OperationContext, RegisterDescriptor } from '../../core/index.js';
import type { CallAnalysisResult } from '../../analysis/calls/index.js';
import { inspectRegister, inspectStackMemory, type StackFact } from '../../analysis/stack/index.js';
import { bitWidth, sameType, successors, type DataType, type Expression, type RegisterBinding, type SSAForm, type Value } from '../../ir/index.js';
import { registerTypeSlices, registerTypes, unchangedStorage, type RegisterTypeSlice, type StorageCopy } from '../../reconstruction/source-register-types.js';
import type { NativeInterface } from './native-worklist.js';

/** Seed physical cells with independently observed scalar/vector lane types.
 * A 64-bit float split into two 32-bit SSA cells keeps offsets 0 and 32; it is
 * never widened to the architectural vector root capacity. */
export function nativeTypeSlices(
  ir: SSAForm,
  interfaces: ReadonlyMap<string, NativeInterface>,
  context: OperationContext,
): readonly (readonly [Value, RegisterTypeSlice])[] {
  const result: (readonly [Value, RegisterTypeSlice])[] = [];
  const note = (bindings: readonly RegisterBinding[], registers: readonly RegisterDescriptor[],
    types: readonly DataType[] | undefined, written: boolean): void => {
    for (const [index, register] of registers.entries()) {
      const type = types?.[index];
      if (!type || type.kind === 'integer') continue;
      for (const binding of bindings) {
        context.checkpoint(1);
        const offset = binding.register.offset_bits - register.offset_bits;
        if (binding.register.root !== register.root || offset < 0 || offset >= bitWidth(type)) continue;
        result.push([binding.value, { type, offset, written }]);
      }
    }
  };
  const states = new Map(ir.register_states.map((state) => [state.block, state]));
  for (const block of ir.blocks) {
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (node.kind !== 'call') continue;
      const observed = interfaces.get(node.id);
      if (!observed) continue;
      note(node.register_inputs, observed.parameters, observed.parameter_types, false);
      note(node.register_outputs, observed.returns, observed.return_types, true);
    }
    const tail = interfaces.get(block.terminator.id);
    if (block.terminator.kind === 'indirect' && block.terminator.tail_call && tail)
      note(states.get(block.id)?.exit ?? [], tail.parameters, tail.parameter_types, false);
  }
  return result;
}

/** Physical observations transferred through a call, never a supplied prototype.
 * Stack offsets use callee-entry SP coordinates exactly as call analysis does. */
export function nativeCallInputs(
  analysis: CallAnalysisResult,
  interfaces: ReadonlyMap<string, NativeInterface>,
  context: OperationContext,
): readonly StackFact[] {
  const result: StackFact[] = [];
  for (const [id, observed] of interfaces) {
    context.checkpoint(1);
    const snapshot = analysis.stack.snapshots.get(id);
    if (!snapshot) continue;
    for (const parameter of observed.parameters) {
      context.checkpoint(1);
      result.push(inspectRegister(snapshot, parameter));
    }
    for (const parameter of observed.stack_parameters ?? []) {
      context.checkpoint(1);
      const sp = snapshot.stack_pointer.value;
      if (sp.kind === 'stack') result.push(inspectStackMemory(snapshot,
        sp.offset + parameter.offset, BigInt(Math.ceil(parameter.width_bits / 8))));
    }
  }
  return result;
}

/** Only entry-backed reads establish stack parameters. A private spill or a
 * write-before-read never becomes an incoming argument; gaps stay explicit. */
export function nativeStackParameters(
  ir: SSAForm,
  analysis: CallAnalysisResult,
  context: OperationContext,
): NonNullable<NativeInterface['stack_parameters']> {
  const loads = new Map(ir.blocks.flatMap((block) => block.instructions.flatMap((node) =>
    node.kind === 'load' ? [[node.id, node] as const] : [])));
  const parameters = new Map<string, NonNullable<NativeInterface['stack_parameters']>[number]>();
  for (const access of analysis.stack.accesses) {
    context.checkpoint(1);
    if (access.kind !== 'read' || access.region !== 'incoming_candidate' || access.offset === null ||
        access.before.initialization === 'initialized') continue;
    const node = loads.get(access.node_id);
    if (!node) continue;
    const width = bitWidth(node.result.type), key = `${access.offset}:${width}`;
    parameters.set(key, { offset: access.offset, width_bits: width, type: node.result.type });
  }
  return [...parameters.values()].sort((left, right) =>
    left.offset < right.offset ? -1 : left.offset > right.offset ? 1 : left.width_bits - right.width_bits);
}

/** Return contracts concern meaningful written storage, not the capacity of a
 * caller-saved root. In particular an unknown call clobber is not a 64-bit value.
 * Local writes include architectural zero/sign extension; every returned bit
 * must be covered on every normal exit. No graph or call analysis is repeated. */
export function nativeReturnInterface(
  ir: SSAForm,
  abi: AbiProfile,
  analysis: CallAnalysisResult | null,
  interfaces: ReadonlyMap<string, NativeInterface>,
  context: OperationContext,
  /** Seed only locally authored exits, so recursive SCCs can acquire a candidate
   * from a base case without treating an unknown call clobber as that candidate. */
  seed = false,
  demandedReturns: readonly RegisterDescriptor[] = [],
  assumedEntry = false,
): Pick<NativeInterface, 'returns' | 'return_types' | 'written_result'> {
  const states = new Map(ir.register_states.map((state) => [state.block, state]));
  const entry = states.get(ir.entry)?.entry ?? [];
  const assumed = new Set(assumedEntry ? ir.blocks.find((block) => block.id === ir.entry)!.instructions
    .flatMap((node) => node.kind === 'assign' ? [node.result.id] : []) : []);
  const expressions = new Map<string, Expression>(), values = new Map<string, Value>();
  const sources = new Map<string, Value[]>(), copies: StorageCopy[] = [];
  const blocks = new Map(ir.blocks.map((block) => [block.id, block]));
  const outputs = new Map<string, { readonly call: string; readonly binding: RegisterBinding }>();
  const loads = new Set<string>();
  for (const state of ir.register_states)
    for (const binding of [...state.entry, ...state.exit]) values.set(binding.value.id, binding.value);
  for (const block of ir.blocks) {
    for (const parameter of block.parameters) values.set(parameter.id, parameter);
    for (const node of block.instructions) {
      context.checkpoint(1);
      if ('result' in node) values.set(node.result.id, node.result);
      if (node.kind === 'assign') expressions.set(node.result.id, node.expression);
      if (node.kind === 'load') loads.add(node.result.id);
      if (node.kind === 'call')
        for (const binding of node.register_outputs) {
          values.set(binding.value.id, binding.value);
          outputs.set(binding.value.id, { call: node.id, binding });
        }
    }
    for (const edge of successors(block.terminator))
      for (const [index, source] of edge.arguments.entries()) {
        context.checkpoint(1);
        const destination = blocks.get(edge.target)?.parameters[index];
        if (!destination) continue;
        const known = sources.get(destination.id) ?? [];
        known.push(source);
        sources.set(destination.id, known);
        copies.push({ source, destination });
      }
  }
  const typed = registerTypeSlices(values, expressions, copies, [], context, nativeTypeSlices(ir, interfaces, context));
  const primary = [
    abi.classifyCall({ returns: { kind: 'pointer' }, parameters: [], variadic: false, fixed_parameter_count: 0 }),
    abi.classifyCall({ returns: { kind: 'float', bits: 64 }, parameters: [], variadic: false, fixed_parameter_count: 0 }),
  ].flatMap((layout) => layout.returns.filter((location) => location.kind === 'register'));
  const word = abi.layout.pointer_bits, bytes = BigInt(word / 8);
  const aggregate = abi.classifyCall({ returns: { kind: 'aggregate', size: bytes * 2n, alignment: Number(bytes),
    fields: [{ offset: 0n, type: { kind: 'integer', bits: word, signed: false } },
      { offset: bytes, type: { kind: 'integer', bits: word, signed: false } }] },
    parameters: [], variadic: false, fixed_parameter_count: 0 });
  for (const location of aggregate.returns) {
    if (location.kind !== 'register' || primary.some((item) => item.register.root === location.register.root)) continue;
    if (demandedReturns.some((register) => register.root === location.register.root)) primary.push(location);
  }
  const exits = ir.blocks.filter((block) => block.terminator.kind === 'return');
  const tails = ir.blocks.filter((block) => block.terminator.kind === 'indirect' && block.terminator.tail_call);
  if (!exits.length && !tails.length) return { returns: [], return_types: [] };
  const proven = (value: Value, start: number, width: number, allowEntry: boolean): boolean => {
    const pending = [{ value, start, width }], seen = new Set<string>();
    let authored = false;
    while (pending.length) {
      context.checkpoint(1);
      const item = pending.pop()!, key = `${item.value.id}:${item.start}:${item.width}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Prologue constants are assumptions about entry storage, not native
      // writes. They cannot seed recursive write/extension guarantees.
      if (assumed.has(item.value.id)) {
        if (!allowEntry) return false;
        authored = true;
        continue;
      }
      const output = outputs.get(item.value.id);
      if (output) {
        const low = output.binding.register.offset_bits + item.start, high = low + item.width;
        const contract = interfaces.get(output.call);
        if (!contract?.written_result?.registers.some((register) => register.root === output.binding.register.root &&
          register.offset_bits <= low && register.offset_bits + register.width_bits >= high)) return false;
        authored = true;
        continue;
      }
      const expression = expressions.get(item.value.id);
      if (expression?.kind === 'extract') pending.push({ value: expression.value,
        start: expression.offset + item.start, width: item.width });
      else if (expression?.kind === 'cast' && (expression.op === 'bitcast' || expression.op === 'truncate' ||
        expression.op === 'zero_extend' || expression.op === 'sign_extend')) {
        const inputWidth = bitWidth(expression.value.type);
        if (item.start < inputWidth) pending.push({ value: expression.value, start: item.start,
          width: Math.min(item.width, inputWidth - item.start) });
        else authored = true;
      } else if (expression?.kind === 'concat') {
        let cursor = 0;
        for (const part of expression.values) {
          const end = cursor + bitWidth(part.type), low = Math.max(cursor, item.start),
            high = Math.min(end, item.start + item.width);
          if (low < high) pending.push({ value: part, start: low - cursor, width: high - low });
          cursor = end;
        }
      } else if (expression?.kind === 'insert') {
        const low = expression.offset, high = low + bitWidth(expression.value.type), end = item.start + item.width;
        if (item.start < low) pending.push({ value: expression.base, start: item.start,
          width: Math.min(end, low) - item.start });
        if (end > high) pending.push({ value: expression.base, start: Math.max(item.start, high),
          width: end - Math.max(item.start, high) });
        if (item.start < high && end > low) pending.push({ value: expression.value,
          start: Math.max(item.start, low) - low, width: Math.min(end, high) - Math.max(item.start, low) });
      } else if (expression?.kind === 'indeterminate') return false;
      else if (expression) authored = true;
      else {
        const incoming = sources.get(item.value.id);
        if (!incoming?.length) {
          // Loads are actual writes, unlike otherwise undefined entry cells.
          const fact = analysis?.stack.values.get(item.value.id);
          const incoming = entry.some((binding) => binding.value.id === item.value.id);
          if (fact?.initialization === 'uninitialized' || (incoming && !allowEntry) ||
            (!incoming && !loads.has(item.value.id))) return false;
          authored = true;
        } else for (const source of incoming) {
          context.checkpoint(1);
          pending.push({ ...item, value: source });
        }
      }
    }
    return authored;
  };
  const returns: RegisterDescriptor[] = [], types: DataType[] = [];
  for (const location of primary) {
    if (returns.some((register) => register.root === location.register.root)) continue;
    const resultEnds = new Set<number>();
    for (const observed of interfaces.values())
      for (const register of observed.returns) {
        context.checkpoint(1);
        if (register.root === location.register.root) resultEnds.add(register.offset_bits + register.width_bits);
      }
    const observations: { readonly register: RegisterDescriptor; readonly type: DataType }[] = [];
    for (const exit of exits) {
      const bindings = states.get(exit.id)?.exit ?? [];
      const cells = bindings.filter((binding) => binding.register.root === location.register.root)
        .sort((left, right) => left.register.offset_bits - right.register.offset_bits);
      let width = 0;
      for (const binding of cells) {
        context.checkpoint(1);
        if (binding.register.offset_bits !== width) break;
        const incoming = entry.find((item) => item.register.id === binding.register.id);
        const unchanged = unchangedStorage(binding.value, incoming?.value.id, expressions, sources, context);
        const demand = demandedReturns.find((register) => register.root === location.register.root);
        const available = unchanged ? Math.min(binding.register.width_bits,
          (demand?.width_bits ?? 0) - binding.register.offset_bits) : binding.register.width_bits;
        let meaningful = available > 0 && proven(binding.value, 0, available, unchanged) ? available : 0;
        if (!meaningful && !unchanged) {
          const consumed = Math.min(available, (demand?.width_bits ?? 0) - binding.register.offset_bits);
          if (consumed > 0 && consumed < available && proven(binding.value, 0, consumed, false)) meaningful = consumed;
          for (const end of resultEnds) {
            const candidate = Math.min(available, end - binding.register.offset_bits);
            if (candidate > meaningful && candidate < available && proven(binding.value, 0, candidate, false))
              meaningful = candidate;
          }
        }
        if (meaningful <= 0) break;
        width += meaningful;
        if (meaningful !== binding.register.width_bits) break;
      }
      const floating = location.register.bank === 'float' || location.register.bank === 'vector';
      let type = floating ? registerTypes(bindings, location.register.root, location.register.offset_bits,
        typed, context, true)[0] : undefined;
      if (floating && !type) {
        for (const binding of cells) {
          const output = outputs.get(binding.value.id);
          const contract = output && interfaces.get(output.call);
          const index = contract?.written_result?.registers.findIndex((register) => register.root === location.register.root);
          if (contract?.written_result && index !== undefined && index >= 0) { type = contract.written_result.types[index]; break; }
        }
      }
      if (floating && !type) continue;
      if (type) width = Math.min(width, bitWidth(type));
      if (width) observations.push({ register: { ...location.register, width_bits: width },
        type: type ?? { kind: 'integer', bits: width } });
    }
    for (const tail of tails) {
      context.checkpoint(1);
      const contract = interfaces.get(tail.terminator.id);
      const index = contract?.written_result?.registers.findIndex((register) => register.root === location.register.root);
      if (!contract?.written_result || index === undefined || index < 0) continue;
      const register = contract.written_result.registers[index]!;
      observations.push({ register, type: contract.written_result.types[index] ??
        { kind: 'integer', bits: register.width_bits } });
    }
    if (!observations.length || (!seed && observations.length !== exits.length + tails.length)) continue;
    const width = Math.min(...observations.map((item) => item.register.width_bits));
    const first = observations[0]!;
    if (first.type.kind !== 'integer' && observations.some((item) => !sameType(item.type, first.type))) continue;
    returns.push({ ...first.register, width_bits: width });
    types.push(first.type.kind === 'integer' ? { kind: 'integer', bits: width } : first.type);
  }
  // The independently typed primary FP/vector view takes precedence over an
  // integer root demanded only by a conservative physical return snapshot.
  // In particular, an untouched X0 is not a second result of a vector function.
  const typedResult = types.findIndex((type) => type.kind === 'float' || type.kind === 'vector');
  if (typedResult >= 0) {
    returns[0] = returns[typedResult]!;
    types[0] = types[typedResult]!;
    returns.length = 1;
    types.length = 1;
  }
  return { returns, return_types: types, written_result: { registers: returns, types } };
}
