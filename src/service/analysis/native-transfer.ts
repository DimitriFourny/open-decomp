import type { AbiProfile, OperationContext, RegisterDescriptor } from '../../core/index.js';
import type { CallAnalysisResult } from '../../analysis/calls/index.js';
import {
  classifyStackRegion,
  inspectRegister,
  inspectStackMemory,
  type StackFact,
} from '../../analysis/stack/index.js';
import {
  bitWidth,
  sameType,
  type DataType,
  type Edge,
  type RegisterBinding,
  type SSAForm,
  type Value,
} from '../../ir/index.js';
import {
  registerTypeSlices,
  registerTypes,
  unchangedStorage,
  type RegisterTypeSlice,
} from '../../reconstruction/source-register-types.js';
import { createSlotTyper, type SlotTyper } from '../../reconstruction/source-slot-types.js';
import {
  selectSourcePrimaryResult,
  type ResultBlock,
  type ResultControl,
} from '../../reconstruction/source-results.js';
import { createNativeInterfaceIndex, type NativeInterfaceIndex } from './native-entry.js';
import { parameterRegisters } from './native-abi.js';
import type { NativeInterface } from './native-worklist.js';

/** Seed physical cells with independently observed scalar/vector lane types.
 * A 64-bit float split into two 32-bit SSA cells keeps offsets 0 and 32; it is
 * never widened to the architectural vector root capacity. */
export function nativeTypeSlices(
  ir: SSAForm,
  interfaces: ReadonlyMap<string, NativeInterface>,
  context: OperationContext,
  index?: NativeInterfaceIndex,
): readonly (readonly [Value, RegisterTypeSlice])[] {
  const result: (readonly [Value, RegisterTypeSlice])[] = [];
  const note = (
    bindings: readonly RegisterBinding[],
    registers: readonly RegisterDescriptor[],
    types: readonly DataType[] | undefined,
    written: boolean,
  ): void => {
    for (const [index, register] of registers.entries()) {
      const type = types?.[index];
      if (!type || type.kind === 'integer') continue;
      for (const binding of bindings) {
        context.checkpoint(1);
        const offset = binding.register.offset_bits - register.offset_bits;
        if (binding.register.root !== register.root || offset < 0 || offset >= bitWidth(type))
          continue;
        result.push([binding.value, { type, offset, written }]);
      }
    }
  };
  const prepared = index?.preparation(ir, context);
  const noteCall = (node: {
    readonly id: string;
    readonly register_inputs: readonly RegisterBinding[];
    readonly register_outputs: readonly RegisterBinding[];
  }): void => {
    const observed = interfaces.get(node.id);
    if (!observed) return;
    note(node.register_inputs, observed.parameters, observed.parameter_types, false);
    note(node.register_outputs, observed.returns, observed.return_types, true);
  };
  if (prepared) {
    for (const call of prepared.calls) {
      context.checkpoint(1);
      noteCall(call);
    }
    for (const block of prepared.tails) {
      const tail = interfaces.get(block.terminator.id);
      if (tail)
        note(
          prepared.states.get(block.id)?.exit ?? [],
          tail.parameters,
          tail.parameter_types,
          false,
        );
    }
  } else {
    const states = new Map(ir.register_states.map((state) => [state.block, state]));
    for (const block of ir.blocks) {
      for (const node of block.instructions) {
        context.checkpoint(1);
        if (node.kind === 'call') noteCall(node);
      }
      const tail = interfaces.get(block.terminator.id);
      if (block.terminator.kind === 'indirect' && block.terminator.tail_call && tail)
        note(states.get(block.id)?.exit ?? [], tail.parameters, tail.parameter_types, false);
    }
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
      if (sp.kind === 'stack')
        result.push(
          inspectStackMemory(
            snapshot,
            sp.offset + parameter.offset,
            BigInt(Math.ceil(parameter.width_bits / 8)),
          ),
        );
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
  index?: NativeInterfaceIndex,
): NonNullable<NativeInterface['stack_parameters']> {
  const loads =
    index?.preparation(ir, context).loads ??
    new Map(
      ir.blocks.flatMap((block) =>
        block.instructions.flatMap((node) =>
          node.kind === 'load' ? [[node.id, node] as const] : [],
        ),
      ),
    );
  const parameters = new Map<string, NonNullable<NativeInterface['stack_parameters']>[number]>();
  for (const access of analysis.stack.accesses) {
    context.checkpoint(1);
    if (
      access.kind !== 'read' ||
      access.region !== 'incoming_candidate' ||
      access.offset === null ||
      access.before.initialization === 'initialized'
    )
      continue;
    const node = loads.get(access.node_id);
    if (!node) continue;
    const width = bitWidth(node.result.type),
      key = `${access.offset}:${width}`;
    parameters.set(key, { offset: access.offset, width_bits: width, type: node.result.type });
  }
  return [...parameters.values()].sort((left, right) =>
    left.offset < right.offset
      ? -1
      : left.offset > right.offset
        ? 1
        : left.width_bits - right.width_bits,
  );
}

/** An exact pointer into this body's own incoming argument area that leaves it
 * (an integer ABI argument register at a call or tail call, or a stored value)
 * lets another body read caller-written stack bytes: the shape of an escaping
 * `va_list` after `va_start`. Direct incoming reads are stack parameters
 * instead. Partial stack recovery or inexact offsets never establish it. */
export function nativeIncomingStackEscapes(
  ir: SSAForm,
  abi: AbiProfile,
  analysis: CallAnalysisResult,
  context: OperationContext,
): boolean {
  if (analysis.stack.state !== 'complete') return false;
  const incoming = (fact: StackFact | undefined): boolean =>
    fact?.value.kind === 'stack' &&
    classifyStackRegion(abi, fact.value.offset, 1n) === 'incoming_candidate';
  const roots = new Set(
    parameterRegisters(abi)
      .filter((register) => register.bank === 'integer')
      .map((register) => register.root),
  );
  const passes = (id: string): boolean =>
    analysis.stack.snapshots
      .get(id)
      ?.registers.some((row) => roots.has(row.register.root) && incoming(row.fact)) ?? false;
  for (const block of ir.blocks) {
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (node.kind === 'store' && incoming(analysis.stack.values.get(node.value.id))) return true;
      if (node.kind === 'call' && passes(node.id)) return true;
    }
    const terminator = block.terminator;
    if (terminator.kind === 'indirect' && terminator.tail_call && passes(terminator.id))
      return true;
  }
  return false;
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
  index?: NativeInterfaceIndex,
  /** Accept an FP/vector exit whose proven write has no IEEE type of its own (a
   * literal zero) as storage of the root, typed by the root's other exits. This
   * classifies the storage of the whole body for context units; at least one
   * exit must still type the root, and every typed exit must agree. */
  untypedFloatWrites = false,
): Pick<NativeInterface, 'returns' | 'return_types' | 'written_result'> {
  const prepared = index ?? createNativeInterfaceIndex(ir, abi, context);
  const {
    states,
    entry,
    entry_assignments,
    expressions,
    values,
    sources,
    copies,
    outputs,
    loaded_values: loads,
    load_addresses,
    load_nodes,
    store_values,
    exits,
    tails,
    primary: primaryLocations,
    aggregate,
    type_graph,
  } = prepared.preparation(ir, context, abi);
  const assumed = assumedEntry ? entry_assignments : undefined;
  const typed = registerTypeSlices(
    values,
    expressions,
    copies,
    [],
    context,
    nativeTypeSlices(ir, interfaces, context, prepared),
    type_graph,
  );
  const primary = [...primaryLocations];
  for (const location of aggregate) {
    if (primary.some((item) => item.register.root === location.register.root)) continue;
    if (demandedReturns.some((register) => register.root === location.register.root))
      primary.push(location);
  }
  if (!exits.length && !tails.length) return { returns: [], return_types: [] };
  const proven = (value: Value, start: number, width: number, allowEntry: boolean): boolean => {
    const pending = [{ value, start, width }],
      seen = new Set<string>();
    let authored = false;
    while (pending.length) {
      context.checkpoint(1);
      const item = pending.pop()!,
        key = `${item.value.id}:${item.start}:${item.width}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Prologue constants are assumptions about entry storage, not native
      // writes. They cannot seed recursive write/extension guarantees.
      if (assumed?.has(item.value.id)) {
        if (!allowEntry) return false;
        authored = true;
        continue;
      }
      const output = outputs.get(item.value.id);
      if (output) {
        const low = output.binding.register.offset_bits + item.start,
          high = low + item.width;
        const contract = interfaces.get(output.call);
        if (
          !contract?.written_result?.registers.some(
            (register) =>
              register.root === output.binding.register.root &&
              register.offset_bits <= low &&
              register.offset_bits + register.width_bits >= high,
          )
        )
          return false;
        authored = true;
        continue;
      }
      const expression = expressions.get(item.value.id);
      if (expression?.kind === 'extract')
        pending.push({
          value: expression.value,
          start: expression.offset + item.start,
          width: item.width,
        });
      else if (
        expression?.kind === 'cast' &&
        (expression.op === 'bitcast' ||
          expression.op === 'truncate' ||
          expression.op === 'zero_extend' ||
          expression.op === 'sign_extend')
      ) {
        const inputWidth = bitWidth(expression.value.type);
        if (item.start < inputWidth)
          pending.push({
            value: expression.value,
            start: item.start,
            width: Math.min(item.width, inputWidth - item.start),
          });
        else authored = true;
      } else if (expression?.kind === 'concat') {
        let cursor = 0;
        for (const part of expression.values) {
          const end = cursor + bitWidth(part.type),
            low = Math.max(cursor, item.start),
            high = Math.min(end, item.start + item.width);
          if (low < high) pending.push({ value: part, start: low - cursor, width: high - low });
          cursor = end;
        }
      } else if (expression?.kind === 'insert') {
        const low = expression.offset,
          high = low + bitWidth(expression.value.type),
          end = item.start + item.width;
        if (item.start < low)
          pending.push({
            value: expression.base,
            start: item.start,
            width: Math.min(end, low) - item.start,
          });
        if (end > high)
          pending.push({
            value: expression.base,
            start: Math.max(item.start, high),
            width: end - Math.max(item.start, high),
          });
        if (item.start < high && end > low)
          pending.push({
            value: expression.value,
            start: Math.max(item.start, low) - low,
            width: Math.min(end, high) - Math.max(item.start, low),
          });
      } else if (expression?.kind === 'indeterminate') return false;
      else if (expression) authored = true;
      else {
        const incoming = sources.get(item.value.id);
        if (!incoming?.length) {
          // Loads are actual writes, unlike otherwise undefined entry cells.
          const fact = analysis?.stack.values.get(item.value.id);
          const incoming = entry.some((binding) => binding.value.id === item.value.id);
          if (
            fact?.initialization === 'uninitialized' ||
            (incoming && !allowEntry) ||
            (!incoming && !loads.has(item.value.id))
          )
            return false;
          authored = true;
        } else
          for (const source of incoming) {
            context.checkpoint(1);
            pending.push({ ...item, value: source });
          }
      }
    }
    return authored;
  };
  let slotTyper: SlotTyper | undefined;
  // The IEEE type of the low `bits` of `start` when every leaf is a load of an
  // exact private local slot (through lossless transport, phis and lane
  // projections) and the stores to that slot are typed alike. A load that a
  // frame address may have reached a call or unresolved memory before is not
  // private: effects the stack recovery does not record may have written it.
  const reloadedSlotType = (start: Value, bits: number): DataType | undefined => {
    const stack = analysis?.stack;
    if (!stack || stack.state !== 'complete') return undefined;
    slotTyper ??= createSlotTyper({
      loads: load_addresses,
      stores: store_values,
      expressions,
      typed,
      stack,
      exposed: (load) => {
        const snapshot = stack.snapshots.get(load_nodes.get(load.id) ?? '');
        return !snapshot || snapshot.escaped;
      },
      context,
    });
    const pending = [{ value: start, offset: 0, width: bits }],
      seen = new Set<string>();
    let result: DataType | undefined;
    while (pending.length) {
      context.checkpoint(1);
      const item = pending.pop()!,
        key = `${item.value.id}:${item.offset}:${item.width}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const address = load_addresses.get(item.value.id);
      if (address) {
        const slot = stack.values.get(address.id)?.value;
        if (
          item.offset !== 0 ||
          bitWidth(item.value.type) !== item.width ||
          slot?.kind !== 'stack' ||
          slot.offset >= 0n
        )
          return undefined;
        const slotType = slotTyper(item.value);
        if (!slotType || (result && !sameType(result, slotType))) return undefined;
        result = slotType;
        continue;
      }
      const expression = expressions.get(item.value.id);
      if (!expression) {
        const incoming = sources.get(item.value.id);
        if (!incoming?.length) return undefined;
        for (const source of incoming) pending.push({ ...item, value: source });
      } else if (expression.kind === 'extract')
        pending.push({
          value: expression.value,
          offset: item.offset + expression.offset,
          width: item.width,
        });
      else if (
        expression.kind === 'cast' &&
        (expression.op === 'bitcast' ||
          expression.op === 'zero_extend' ||
          expression.op === 'truncate') &&
        item.offset + item.width <= bitWidth(expression.value.type)
      )
        pending.push({ ...item, value: expression.value });
      else if (expression.kind === 'insert') {
        const low = expression.offset,
          high = low + bitWidth(expression.value.type);
        if (item.offset >= low && item.offset + item.width <= high)
          pending.push({ value: expression.value, offset: item.offset - low, width: item.width });
        else if (item.offset + item.width <= low || item.offset >= high)
          pending.push({ ...item, value: expression.base });
        else return undefined;
      } else if (expression.kind === 'concat') {
        let cursor = 0,
          part: Value | undefined;
        for (const candidate of expression.values) {
          const end = cursor + bitWidth(candidate.type);
          if (item.offset >= cursor && item.offset + item.width <= end) {
            part = candidate;
            break;
          }
          cursor = end;
        }
        if (!part) return undefined;
        pending.push({ value: part, offset: item.offset - cursor, width: item.width });
      } else return undefined;
    }
    return result;
  };
  const returns: RegisterDescriptor[] = [],
    types: DataType[] = [];
  for (const location of primary) {
    if (returns.some((register) => register.root === location.register.root)) continue;
    const resultEnds = new Set<number>();
    for (const observed of interfaces.values())
      for (const register of observed.returns) {
        context.checkpoint(1);
        if (register.root === location.register.root)
          resultEnds.add(register.offset_bits + register.width_bits);
      }
    const observations: { readonly register: RegisterDescriptor; readonly type?: DataType }[] = [];
    for (const exit of exits) {
      const bindings = states.get(exit.id)?.exit ?? [];
      const cells = bindings
        .filter((binding) => binding.register.root === location.register.root)
        .sort((left, right) => left.register.offset_bits - right.register.offset_bits);
      let width = 0;
      for (const binding of cells) {
        context.checkpoint(1);
        if (binding.register.offset_bits !== width) break;
        const incoming = entry.find((item) => item.register.id === binding.register.id);
        const unchanged = unchangedStorage(
          binding.value,
          incoming?.value.id,
          expressions,
          sources,
          context,
        );
        const demand = demandedReturns.find((register) => register.root === location.register.root);
        const available = unchanged
          ? Math.min(
              binding.register.width_bits,
              (demand?.width_bits ?? 0) - binding.register.offset_bits,
            )
          : binding.register.width_bits;
        let meaningful =
          available > 0 && proven(binding.value, 0, available, unchanged) ? available : 0;
        if (!meaningful && !unchanged) {
          const consumed = Math.min(
            available,
            (demand?.width_bits ?? 0) - binding.register.offset_bits,
          );
          if (consumed > 0 && consumed < available && proven(binding.value, 0, consumed, false))
            meaningful = consumed;
          for (const end of resultEnds) {
            const candidate = Math.min(available, end - binding.register.offset_bits);
            if (
              candidate > meaningful &&
              candidate < available &&
              proven(binding.value, 0, candidate, false)
            )
              meaningful = candidate;
          }
        }
        if (meaningful <= 0) break;
        width += meaningful;
        if (meaningful !== binding.register.width_bits) break;
      }
      const floating = location.register.bank === 'float' || location.register.bank === 'vector';
      let type = floating
        ? registerTypes(
            bindings,
            location.register.root,
            location.register.offset_bits,
            typed,
            context,
            true,
          )[0]
        : undefined;
      if (floating && !type) {
        for (const binding of cells) {
          const output = outputs.get(binding.value.id);
          const contract = output && interfaces.get(output.call);
          const index = contract?.written_result?.registers.findIndex(
            (register) => register.root === location.register.root,
          );
          if (contract?.written_result && index !== undefined && index >= 0) {
            type = contract.written_result.types[index];
            break;
          }
        }
      }
      // An unoptimized result is a reload of a frame slot; its type is the
      // type of the values stored there.
      if (floating && !type && cells[0]?.register.offset_bits === 0) {
        for (const bits of [64, 32]) {
          type = reloadedSlotType(cells[0].value, bits);
          if (type) break;
        }
        // The write must cover the typed width.
        if (type && width < bitWidth(type)) type = undefined;
      }
      if (floating && !type && (!untypedFloatWrites || !width)) continue;
      if (type) width = Math.min(width, bitWidth(type));
      if (width)
        observations.push({
          register: { ...location.register, width_bits: width },
          ...(type || !floating ? { type: type ?? { kind: 'integer', bits: width } } : {}),
        });
    }
    for (const tail of tails) {
      context.checkpoint(1);
      const contract = interfaces.get(tail.terminator.id);
      const index = contract?.written_result?.registers.findIndex(
        (register) => register.root === location.register.root,
      );
      if (!contract?.written_result || index === undefined || index < 0) continue;
      const register = contract.written_result.registers[index]!;
      observations.push({
        register,
        type: contract.written_result.types[index] ?? {
          kind: 'integer',
          bits: register.width_bits,
        },
      });
    }
    if (!observations.length || (!seed && observations.length !== exits.length + tails.length))
      continue;
    const first = observations.find((item) => item.type);
    const firstType = first?.type;
    if (!first || !firstType) continue;
    const width = Math.min(...observations.map((item) => item.register.width_bits));
    if (
      firstType.kind !== 'integer' &&
      observations.some((item) =>
        item.type
          ? !sameType(item.type, firstType)
          : item.register.width_bits < bitWidth(firstType),
      )
    )
      continue;
    returns.push({ ...first.register, width_bits: width });
    types.push(firstType.kind === 'integer' ? { kind: 'integer', bits: width } : firstType);
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

/** A context unit keeps its callee's result storage. `generic` is the baseline
 * body's result with `untypedFloatWrites` (`prepareNativeContext`); it covers
 * every baseline exit, and the context's exits are a subset of them. When both
 * results are non-empty but name different roots (a literal-zero FP exit has
 * no IEEE type of its own, so the context alone falls back to an integer
 * root), the generic roots hold here as well. Widths and types on a root the
 * context proves too stay the context's; an empty context result (a context
 * that writes no result) never acquires one. */
export function inheritGenericResult<T extends NativeInterface>(
  observed: T,
  generic: Pick<NativeInterface, 'returns' | 'return_types'> | undefined,
): T {
  if (!generic?.returns.length || !observed.returns.length) return observed;
  const roots = new Set(observed.returns.map((register) => register.root));
  if (
    generic.returns.length === roots.size &&
    generic.returns.every((register) => roots.has(register.root))
  )
    return observed;
  const returns: RegisterDescriptor[] = [],
    types: DataType[] = [];
  for (const [index, register] of generic.returns.entries()) {
    const local = observed.returns.findIndex((item) => item.root === register.root);
    const result = local >= 0 ? observed.returns[local]! : register;
    returns.push(result);
    types.push(
      (local >= 0 ? observed.return_types?.[local] : generic.return_types?.[index]) ?? {
        kind: 'integer',
        bits: result.width_bits,
      },
    );
  }
  return {
    ...observed,
    returns,
    return_types: types,
    written_result: { registers: returns, types },
  };
}

/** Reason the integer result register of a native body is incidental on every exit
 * path, or undefined: the `incidental_result` classes of the source view
 * (`selectSourcePrimaryResult`) evaluated over native SSA. `demands` is semantic
 * caller demand only; a caller that forwards the result to its own exit is not
 * evidence of use (it is the circular demand of a self-call). Every tail transfer
 * must forward no result (a void contract, or `voidLike`), a final call into a
 * `voidLike` callee establishes nothing, and the FP result register must be
 * unchanged or undefined on every exit. Lane types are not consulted: an FP exit
 * write without them is untyped and keeps the body from qualifying. A body with no
 * return exit qualifies when it has tail transfers and all of them forward no result. */
export function nativeIncidentalResult(
  ir: SSAForm,
  abi: AbiProfile,
  analysis: CallAnalysisResult,
  interfaces: ReadonlyMap<string, NativeInterface>,
  own: Pick<NativeInterface, 'parameters' | 'returns'>,
  demands: readonly RegisterDescriptor[],
  voidLike: (call: string) => boolean,
  context: OperationContext,
  index?: NativeInterfaceIndex,
): string | undefined {
  const classify = (returns: { kind: 'pointer' } | { kind: 'float'; bits: 64 }) =>
    abi.classifyCall({ returns, parameters: [], variadic: false, fixed_parameter_count: 0 })
      .returns[0];
  const integer = classify({ kind: 'pointer' }),
    floating = classify({ kind: 'float', bits: 64 });
  if (integer?.kind !== 'register' || floating?.kind !== 'register') return undefined;
  if (demands.some((register) => register.root === integer.register.root)) return undefined;
  const { states, entry, expressions, sources, calls, exits, tails } = (
    index ?? createNativeInterfaceIndex(ir, abi, context)
  ).preparation(ir, context, abi);
  const voidTails = new Set<string>();
  for (const tail of tails) {
    context.checkpoint(1);
    const id = tail.terminator.id,
      callee = interfaces.get(id);
    if (
      callee?.parameter_state === 'ambiguous' ||
      !((callee?.returns_void && !callee.returns.length) || voidLike(id))
    )
      return undefined;
    voidTails.add(id);
  }
  if (!exits.length) return tails.length ? 'every tail transfer forwards no result' : undefined;
  const parametersOf = new Map(ir.blocks.map((block) => [block.id, block.parameters]));
  let reentered = false;
  const transfer = (edge: Edge) => {
    if (edge.target === ir.entry) reentered = true;
    const destinations = parametersOf.get(edge.target) ?? [];
    return {
      target: edge.target,
      copies: edge.arguments.flatMap((source, position) =>
        destinations[position] ? [{ destination: destinations[position], source }] : [],
      ),
    };
  };
  const blocks = new Map<string, ResultBlock>();
  for (const block of ir.blocks) {
    context.checkpoint(1);
    const terminator = block.terminator;
    // Control continuing at an unresolved jump target may still return a result.
    // An unknown exit (an FP-environment guard arm under its recorded requirement)
    // returns nothing, as in the source view; the caller admits only bodies whose
    // own graph is resolved.
    if (terminator.kind === 'indirect' && !terminator.tail_call) return undefined;
    const control: ResultControl =
      terminator.kind === 'jump'
        ? { kind: 'jump', id: terminator.id, transfer: transfer(terminator.edge) }
        : terminator.kind === 'branch'
          ? {
              kind: 'if',
              id: terminator.id,
              condition: terminator.condition,
              when_true: { transfer: transfer(terminator.when_true) },
              when_false: { transfer: transfer(terminator.when_false) },
            }
          : terminator.kind === 'switch'
            ? {
                kind: 'switch',
                id: terminator.id,
                value: terminator.value,
                cases: terminator.cases.map((item) => ({ arm: { transfer: transfer(item.edge) } })),
                otherwise: { transfer: transfer(terminator.otherwise) },
              }
            : terminator;
    const state = states.get(block.id);
    blocks.set(block.id, {
      id: block.id,
      // Entry cells are ABI parameters or unknown, as in the source view.
      parameters: block.id === ir.entry ? [] : block.parameters,
      register_entry: state?.entry ?? [],
      register_exit: state?.exit ?? [],
      statements: block.instructions,
      control,
    });
  }
  // A loop back into the entry block would merge the entry values with others.
  if (reentered) return undefined;
  const roots = new Set(own.parameters.map((register) => register.root));
  const parameterValues = new Map(
    entry
      .filter((binding) => roots.has(binding.register.root))
      .map((binding) => [binding.value.id, binding.register]),
  );
  // Outputs inside the callee's written result storage are its projected results;
  // other outputs are unprojected clobbers.
  const callResults = new Map<string, Value[]>();
  for (const node of calls) {
    context.checkpoint(1);
    const contract = interfaces.get(node.id);
    const written = contract?.written_result?.registers ?? contract?.returns ?? [];
    const values = node.register_outputs
      .filter((binding) =>
        written.some(
          (register) =>
            register.root === binding.register.root &&
            register.offset_bits <= binding.register.offset_bits &&
            register.offset_bits + register.width_bits >=
              binding.register.offset_bits + binding.register.width_bits,
        ),
      )
      .map((binding) => binding.value);
    if (values.length) callResults.set(node.id, values);
  }
  const selected = selectSourcePrimaryResult({
    blocks,
    entry: blocks.get(ir.entry)!,
    expressions,
    sources,
    typed: new Map(),
    parameters: parameterValues,
    callResults,
    stack: analysis.stack,
    integer,
    floating,
    argumentRoots: new Set(parameterRegisters(abi).map((register) => register.root)),
    demands,
    observed: [],
    context,
    voidTails,
    incidentalCall: voidLike,
  });
  if (selected?.kind !== 'none' || selected.incidental_floating !== undefined) return undefined;
  if (selected.void_like === 'incidental_result') return selected.reason;
  // No result defined on some exit, and no proven written result storage: the
  // source view presents no result either (the `primary_result` none rule).
  return !selected.void_like &&
    selected.integer_undefined &&
    selected.floating_inert &&
    !own.returns.some((register) => register.root === integer.register.root)
    ? selected.reason
    : undefined;
}
