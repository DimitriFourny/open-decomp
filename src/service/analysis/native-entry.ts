import type { AbiProfile, OperationContext, RegisterDescriptor } from '../../core/index.js';
import {
  bitWidth,
  expressionOperands,
  successors,
  type Expression,
  type Instruction,
  type RegisterBinding,
  type SSAForm,
  type Value,
} from '../../ir/index.js';
import {
  createRegisterTypeGraph,
  type RegisterTypeGraph,
  type StorageCopy,
} from '../../reconstruction/source-register-types.js';
import type { NativeInterface } from './native-worklist.js';

type NativeRoot = { readonly value: Value; readonly width: number; readonly offset: number };

interface NativeInterfaceStructure {
  readonly states: ReadonlyMap<string, SSAForm['register_states'][number]>;
  readonly entry: readonly RegisterBinding[];
  readonly entry_registers: ReadonlyMap<string, RegisterDescriptor>;
  readonly entry_assignments: ReadonlySet<string>;
  readonly expressions: ReadonlyMap<string, Expression>;
  readonly values: ReadonlyMap<string, Value>;
  readonly sources: ReadonlyMap<string, readonly Value[]>;
  readonly copies: readonly StorageCopy[];
  readonly type_graph: RegisterTypeGraph;
  readonly outputs: ReadonlyMap<
    string,
    { readonly call: string; readonly binding: RegisterBinding }
  >;
  readonly loads: ReadonlyMap<string, Extract<Instruction, { kind: 'load' }>>;
  readonly loaded_values: ReadonlySet<string>;
  readonly calls: readonly Extract<Instruction, { kind: 'call' }>[];
  readonly exits: readonly SSAForm['blocks'][number][];
  readonly tails: readonly SSAForm['blocks'][number][];
  readonly primary: readonly { readonly register: RegisterDescriptor }[];
  readonly aggregate: readonly { readonly register: RegisterDescriptor }[];
}

/** Owned by one prepared, unchanged SSA stage. Neither interface refinements nor
 * context assumptions/demands are cached here. A specialized SSA needs its own
 * index even when its function/value identifiers match the baseline. */
export interface NativeInterfaceIndex {
  preparation(ir: SSAForm, context: OperationContext, abi?: AbiProfile): NativeInterfaceStructure;
  entryRoots(ir: SSAForm, context: OperationContext): readonly NativeRoot[];
}

export function createNativeInterfaceIndex(
  ir: SSAForm,
  abi: AbiProfile | undefined,
  context: OperationContext,
): NativeInterfaceIndex {
  context.checkpoint(0);
  let prepared: NativeInterfaceIndex | undefined;
  const get = (
    input: SSAForm,
    queryContext: OperationContext,
    profile?: AbiProfile,
  ): NativeInterfaceIndex => {
    queryContext.checkpoint(0);
    if (input !== ir || (profile !== undefined && profile !== abi))
      throw new TypeError('Native interface index belongs to a different SSA or ABI stage');
    // Build atomically on first use with the current operation's clock, never
    // the clock retained by a cached prepared unit from an earlier request.
    return (prepared ??= prepareNativeInterfaceIndex(ir, abi, queryContext));
  };
  return Object.freeze({
    preparation(
      input: SSAForm,
      queryContext: OperationContext,
      profile?: AbiProfile,
    ): NativeInterfaceStructure {
      return get(input, queryContext, profile).preparation(input, queryContext, profile);
    },
    entryRoots(input: SSAForm, queryContext: OperationContext): readonly NativeRoot[] {
      return get(input, queryContext).entryRoots(input, queryContext);
    },
  });
}

function prepareNativeInterfaceIndex(
  ir: SSAForm,
  abi: AbiProfile | undefined,
  context: OperationContext,
): NativeInterfaceIndex {
  const states = new Map(ir.register_states.map((state) => [state.block, state]));
  const entry = states.get(ir.entry)?.entry ?? [];
  const entryRegisters = new Map(entry.map((binding) => [binding.value.id, binding.register]));
  const entryAssignments = new Set<string>();
  const expressions = new Map<string, Expression>(),
    values = new Map<string, Value>();
  const sources = new Map<string, Value[]>(),
    copies: StorageCopy[] = [];
  const blocks = new Map(ir.blocks.map((block) => [block.id, block]));
  const outputs = new Map<string, { readonly call: string; readonly binding: RegisterBinding }>();
  const loads = new Map<string, Extract<Instruction, { kind: 'load' }>>(),
    loadedValues = new Set<string>();
  const calls: Extract<Instruction, { kind: 'call' }>[] = [],
    stores: Extract<Instruction, { kind: 'store' }>[] = [];
  const exits: SSAForm['blocks'][number][] = [],
    tails: SSAForm['blocks'][number][] = [];
  const roots: NativeRoot[] = [];
  const root = (value: Value): void => {
    roots.push({ value, offset: 0, width: bitWidth(value.type) });
  };
  for (const state of ir.register_states) {
    for (const binding of state.entry) values.set(binding.value.id, binding.value);
    for (const binding of state.exit) values.set(binding.value.id, binding.value);
  }
  for (const block of ir.blocks) {
    for (const parameter of block.parameters) values.set(parameter.id, parameter);
    for (const node of block.instructions) {
      context.checkpoint(1);
      if ('result' in node) values.set(node.result.id, node.result);
      if (node.kind === 'assign') {
        expressions.set(node.result.id, node.expression);
        if (block.id === ir.entry) entryAssignments.add(node.result.id);
      } else if (node.kind === 'load') {
        loads.set(node.id, node);
        loadedValues.add(node.result.id);
        root(node.address);
      } else if (node.kind === 'store') stores.push(node);
      else if (node.kind === 'call') {
        calls.push(node);
        for (const value of node.arguments) root(value);
        if (node.target.kind === 'indirect') root(node.target.value);
        for (const binding of node.register_outputs) {
          values.set(binding.value.id, binding.value);
          outputs.set(binding.value.id, { call: node.id, binding });
        }
      }
    }
    const control = block.terminator;
    const value =
      control.kind === 'branch'
        ? control.condition
        : control.kind === 'switch'
          ? control.value
          : control.kind === 'indirect'
            ? control.target
            : null;
    if (value) root(value);
    if (control.kind === 'return') {
      exits.push(block);
      for (const value of control.values) root(value);
    } else if (control.kind === 'indirect' && control.tail_call) tails.push(block);
    for (const edge of successors(control))
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
  const primary = abi
    ? [
        abi.classifyCall({
          returns: { kind: 'pointer' },
          parameters: [],
          variadic: false,
          fixed_parameter_count: 0,
        }),
        abi.classifyCall({
          returns: { kind: 'float', bits: 64 },
          parameters: [],
          variadic: false,
          fixed_parameter_count: 0,
        }),
      ].flatMap((layout) => layout.returns.filter((location) => location.kind === 'register'))
    : [];
  const word = abi?.layout.pointer_bits ?? 0,
    bytes = BigInt(word / 8);
  const aggregate =
    abi
      ?.classifyCall({
        returns: {
          kind: 'aggregate',
          size: bytes * 2n,
          alignment: Number(bytes),
          fields: [
            { offset: 0n, type: { kind: 'integer', bits: word, signed: false } },
            { offset: bytes, type: { kind: 'integer', bits: word, signed: false } },
          ],
        },
        parameters: [],
        variadic: false,
        fixed_parameter_count: 0,
      })
      .returns.filter((location) => location.kind === 'register') ?? [];
  const structure: NativeInterfaceStructure = Object.freeze({
    states,
    entry,
    entry_registers: entryRegisters,
    entry_assignments: entryAssignments,
    expressions,
    values,
    sources,
    copies,
    type_graph: createRegisterTypeGraph(values, expressions, copies),
    outputs,
    loads,
    loaded_values: loadedValues,
    calls,
    exits,
    tails,
    primary,
    aggregate,
  });
  let completeRoots: readonly NativeRoot[] | undefined;
  const assertStage = (input: SSAForm, queryContext: OperationContext): void => {
    queryContext.checkpoint(0);
    if (input !== ir)
      throw new TypeError('Native interface index belongs to a different SSA stage');
  };
  return Object.freeze({
    preparation(
      input: SSAForm,
      queryContext: OperationContext,
      profile?: AbiProfile,
    ): NativeInterfaceStructure {
      assertStage(input, queryContext);
      if (profile !== undefined && profile !== abi)
        throw new TypeError('Native interface index belongs to a different ABI stage');
      return structure;
    },
    entryRoots(input: SSAForm, queryContext: OperationContext): readonly NativeRoot[] {
      assertStage(input, queryContext);
      if (completeRoots) return completeRoots;
      const result = [...roots];
      // Classify complete ancestry, including cyclic phis, once per store. This
      // is purely structural: no call interface or demanded result participates.
      for (const store of stores) {
        const pending = [store.address],
          visited = new Set<string>();
        let stack = false,
          other = false;
        while (pending.length) {
          queryContext.checkpoint(1);
          const value = pending.pop()!;
          if (visited.has(value.id)) continue;
          visited.add(value.id);
          const register = entryRegisters.get(value.id);
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
        result.push({ value: store.address, offset: 0, width: bitWidth(store.address.type) });
        if (!stack || other)
          result.push({ value: store.value, offset: 0, width: bitWidth(store.value.type) });
      }
      completeRoots = result;
      return result;
    },
  });
}

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
  index?: NativeInterfaceIndex,
): readonly RegisterDescriptor[] {
  const prepared = index ?? createNativeInterfaceIndex(ir, undefined, context);
  const {
    states,
    entry_registers: entry,
    expressions,
    sources,
    calls,
    exits,
    tails,
  } = prepared.preparation(ir, context);
  const roots = [...prepared.entryRoots(ir, context)];
  const observeBindings = (
    bindings: readonly RegisterBinding[],
    registers: readonly RegisterDescriptor[],
  ): void => {
    for (const register of registers)
      for (const binding of bindings) {
        context.checkpoint(1);
        if (binding.register.root !== register.root) continue;
        const low = Math.max(binding.register.offset_bits, register.offset_bits),
          high = Math.min(
            binding.register.offset_bits + binding.register.width_bits,
            register.offset_bits + register.width_bits,
          );
        if (low < high)
          roots.push({
            value: binding.value,
            offset: low - binding.register.offset_bits,
            width: high - low,
          });
      }
  };
  for (const call of calls) {
    context.checkpoint(1);
    observeBindings(call.register_inputs, interfaces.get(call.id)?.parameters ?? []);
  }
  for (const block of exits) observeBindings(states.get(block.id)?.exit ?? [], returned);
  for (const block of tails)
    observeBindings(
      states.get(block.id)?.exit ?? [],
      interfaces.get(block.terminator.id)?.parameters ?? [],
    );
  const observed = new Map<string, number>(),
    seen = new Set<string>();
  for (let index = 0; index < roots.length; index++) {
    context.checkpoint(1);
    const { value, width, offset } = roots[index]!,
      key = `${value.id}:${offset}:${width}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const incoming = entry.get(value.id);
    if (incoming)
      observed.set(
        incoming.root,
        Math.max(observed.get(incoming.root) ?? 0, incoming.offset_bits + offset + width),
      );
    const expression = expressions.get(value.id);
    if (expression?.kind === 'extract')
      roots.push({ value: expression.value, width, offset: offset + expression.offset });
    else if (
      expression?.kind === 'cast' &&
      (expression.op === 'truncate' ||
        expression.op === 'bitcast' ||
        expression.op === 'zero_extend' ||
        expression.op === 'sign_extend')
    ) {
      const available = bitWidth(expression.value.type);
      if (offset < available)
        roots.push({ value: expression.value, offset, width: Math.min(width, available - offset) });
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
