import type { AbiType, OperationContext } from '../core/index.js';
import type { EmissionInput } from '../emitters/model.js';
import { bitWidth, expressionOperands, type Instruction, type Value } from '../ir/index.js';
import type { BoundaryProjection, Reconstruction } from './model.js';
import type { SourceFormalType, SourcePresentation } from './source-model.js';
import { validateBitvectorCandidate } from './local-validation.js';
import { sourceRequirementPredicates } from './source-requirements.js';

/** Agree to a void-like interface only in the absence of any positive result
 * evidence. Native written-result storage is no such evidence once a
 * `void_like_result` rule (`incidental_result`, `indirect_result`) rejected
 * it. The caller still records the ABI assumption before hiding slices. */
export function permitsVoidSourceSignature(
  input: EmissionInput,
  source: SourcePresentation,
  returns: ReadonlyMap<string, BoundaryProjection>,
  hasTail: boolean,
): boolean {
  return (
    !hasTail &&
    returns.size > 0 &&
    source.return_type === null &&
    !source.return_types?.length &&
    !source.return_pointer &&
    !source.return_source_type &&
    !input.source?.function_return_demands?.length &&
    (source.void_like_result !== undefined ||
      (!input.source?.function_returns?.registers.length &&
        !input.source?.function_returns?.types.length)) &&
    !input.types?.signatures.some((signature) => signature.subject_id === input.function.id) &&
    [...returns.values()].every(
      (boundary) => boundary.kind === 'inferred' && boundary.results.length === 0,
    )
  );
}

/** Native FP spelling requires typed IEEE evidence. Integer carriers qualify
 * only as closed whole-bit transports: an integer consumer keeps the entire
 * carrier component explicit, rather than silently adding numeric conversions.
 * An ordinary same-width memory read joins such a component only by consumer
 * evidence (an IEEE reinterpretation or a transport into a carrier); an
 * ordinary store of a component member is a whole-bit FP write. Both then
 * read/write through a native float/double lvalue (`float_accesses`).
 * A promoted frame-private slot is storage between its stores and reloads, like
 * a phi: it is an FP local (`float_locals`) exactly when every stored value and
 * every reload belongs to the component. An incoming-stack formal reads like a
 * memory read: only its consumers (same-width IEEE reinterpretations) type it,
 * and only where the target ABI passes an IEEE value in its position through
 * the same stack slot. FP-bank register formals are IEEE-typed by the planner. */
export function projectSourceFloating(
  program: Reconstruction,
  input: EmissionInput,
  context: OperationContext,
  memory = true,
  slotsEnabled = true,
): Pick<SourcePresentation, 'float_values' | 'return_float' | 'float_accesses' | 'float_locals'> {
  const validation = program.local_validation_session;
  if (
    program.view !== 'source' ||
    !program.source ||
    !input.source ||
    !validation ||
    program.signature ||
    input.types?.signatures.some((signature) => signature.subject_id === program.function.id) ||
    input.types?.conflicts.some((conflict) => conflict.subject_id === program.function.id)
  )
    return {};
  const conflicts = new Set(input.types?.conflicts.map((item) => item.subject_id));
  const conflicting = (value: Value): boolean => {
    if (
      [value.id, ...(program.source?.value_origins?.get(value.id) ?? [])].some((id) =>
        conflicts.has(id),
      )
    )
      return true;
    const projected = program.source?.value_types?.get(value.id);
    if (
      !projected ||
      !input.types?.associations.some(
        (association) =>
          projected.association_ids.includes(association.id) && association.source !== 'analysis',
      )
    )
      return false;
    const declared = input.types.types.find((type) => type.id === projected.type_id)?.definition;
    return declared?.kind !== 'float' || declared.bits !== bitWidth(value.type);
  };
  const incoming = new Map<string, Value[]>();
  for (const copies of program.transfers.values())
    for (const copy of copies) {
      const row = incoming.get(copy.destination.id) ?? [];
      row.push(copy.source);
      incoming.set(copy.destination.id, row);
    }
  const parents = (value: Value): readonly Value[] => {
    const expression = program.expressions.get(value.id);
    if (expression?.kind === 'cast' && expression.op === 'bitcast') return [expression.value];
    if (expression?.kind === 'select') return [expression.when_true, expression.when_false];
    return incoming.get(value.id) ?? [];
  };
  // Ordinary storage views only: little-endian, non-volatile, IR alignment 1,
  // outside promoted and hidden frame-save slots.
  const frameSaves = program.source.frame_saves;
  const plain = (node: Extract<Instruction, { kind: 'load' | 'store' }>): boolean => {
    const bits = bitWidth(node.kind === 'load' ? node.result.type : node.value.type);
    return (
      memory &&
      (bits === 32 || bits === 64) &&
      program.retained.has(node.id) &&
      !program.source!.locals.has(node.id) &&
      !frameSaves?.stores.has(node.id) &&
      !frameSaves?.reloads.has(node.id) &&
      node.access.endian === 'little' &&
      !node.access.volatile &&
      node.access.alignment === 1
    );
  };
  const accesses: Extract<Instruction, { kind: 'load' | 'store' }>[] = [];
  const loads = new Map<string, Value>();
  // An incoming-stack word is the formal analogue of an ordinary memory read.
  // Retyping it must not move it: classify the presented interface with this
  // formal as IEEE and require its original stack slot (Win64 assigns slots by
  // position; SysV/AAPCS64 only once the FP argument registers are exhausted).
  // Only an interface of scalar formals (float/double, integers of at most a
  // machine word) is classified here.
  const presented = program.parameters.map((formal): AbiType | undefined =>
    formal.type.kind === 'float' && (formal.type.bits === 32 || formal.type.bits === 64)
      ? { kind: 'float', bits: formal.type.bits }
      : formal.type.kind === 'integer' && formal.type.bits <= 64
        ? { kind: 'integer', bits: formal.type.bits, signed: false }
        : undefined,
  );
  const scalars = presented.filter((type): type is AbiType => type !== undefined);
  if (scalars.length === presented.length)
    program.parameters.forEach((formal, index) => {
      const offset = program.source!.formal_stack_offsets?.get(formal.id);
      const bits = bitWidth(formal.type);
      if (
        offset === undefined ||
        formal.type.kind !== 'integer' ||
        (bits !== 32 && bits !== 64) ||
        !program.live.has(formal.id) ||
        conflicting(formal)
      )
        return;
      const location = input.source!.abi.classifyCall({
        returns: { kind: 'void' },
        parameters: scalars.map((type, position) =>
          position === index ? { kind: 'float', bits } : type,
        ),
        variadic: false,
        fixed_parameter_count: scalars.length,
      }).parameters[index]?.locations;
      if (location?.length === 1 && location[0]!.kind === 'stack' && location[0]!.offset === offset)
        loads.set(formal.id, formal);
    });
  // Promoted slots: private storage whose reloads read exactly the stored values.
  const slots = new Map<
    string,
    { bits: 32 | 64; stores: Value[]; loads: Value[]; nodes: string[] }
  >();
  const unslotted = new Set<string>();
  if (slotsEnabled)
    for (const block of program.blocks.values())
      for (const node of block.statements) {
        context.checkpoint(1);
        if ((node.kind !== 'load' && node.kind !== 'store') || !program.retained.has(node.id))
          continue;
        const local = program.source.locals.get(node.id);
        if (!local || unslotted.has(local.id)) continue;
        const value = node.kind === 'load' ? node.result : node.value;
        const bits = bitWidth(value.type);
        if (
          local.type.kind !== 'integer' ||
          value.type.kind !== 'integer' ||
          (bits !== 32 && bits !== 64) ||
          conflicting(value) ||
          (slots.get(local.id) && slots.get(local.id)!.bits !== bits)
        ) {
          unslotted.add(local.id);
          slots.delete(local.id);
          continue;
        }
        const slot = slots.get(local.id) ?? { bits, stores: [], loads: [], nodes: [] };
        slots.set(local.id, slot);
        slot.nodes.push(node.id);
        if (node.kind === 'store') slot.stores.push(node.value);
        else if (program.live.has(node.result.id)) slot.loads.push(node.result);
      }
  for (const slot of slots.values())
    for (const load of slot.loads)
      incoming.set(load.id, [...(incoming.get(load.id) ?? []), ...slot.stores]);
  const slotted = new Set([...slots.values()].flatMap((slot) => slot.nodes));
  for (const block of program.blocks.values())
    for (const node of block.statements) {
      context.checkpoint(1);
      if ((node.kind !== 'load' && node.kind !== 'store') || !plain(node)) continue;
      accesses.push(node);
      if (
        node.kind === 'load' &&
        node.result.type.kind === 'integer' &&
        program.live.has(node.result.id) &&
        !conflicting(node.result)
      )
        loads.set(node.result.id, node.result);
    }
  const floating = new Map<string, 32 | 64>();
  const carriers = new Set<string>();
  for (const value of program.values.values()) {
    context.checkpoint(1);
    if (!program.live.has(value.id) || conflicting(value)) continue;
    const bits = bitWidth(value.type);
    if (bits !== 32 && bits !== 64) continue;
    if (value.type.kind === 'float') {
      floating.set(value.id, bits);
      continue;
    }
    if (value.type.kind !== 'integer') continue;
    const pending = [value],
      seen = new Set<string>();
    let valid = true,
      evidence = false;
    while (pending.length && valid) {
      context.checkpoint(1);
      const current = pending.pop()!;
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      if (seen.size > 64 || bitWidth(current.type) !== bits || conflicting(current)) {
        valid = false;
        break;
      }
      if (current.type.kind === 'float') {
        evidence = true;
        continue;
      }
      // Literal bits and ordinary memory reads can join an established FP
      // transport, but cannot establish its interpretation alone. Rendering
      // retains literal bit patterns; reads need their own evidence below.
      if (program.expressions.get(current.id)?.kind === 'constant' || loads.has(current.id))
        continue;
      const sources = parents(current);
      if (!sources.length) valid = false;
      else pending.push(...sources);
    }
    if (valid && evidence) {
      floating.set(value.id, bits);
      carriers.add(value.id);
    }
  }
  // Consumer evidence for a memory read: a same-width IEEE reinterpretation
  // of it, or its transport into an established carrier. Any other consumer
  // invalidates it (and its connected carriers) below.
  const evidenced = new Set<string>();
  for (const id of carriers)
    for (const parent of parents(program.values.get(id)!)) evidenced.add(parent.id);
  for (const [id, expression] of program.expressions)
    if (
      program.live.has(id) &&
      expression.kind === 'cast' &&
      expression.op === 'bitcast' &&
      loads.has(expression.value.id) &&
      floating.get(id) === bitWidth(expression.value.type)
    )
      evidenced.add(expression.value.id);
  for (const [id, value] of loads)
    if (evidenced.has(id)) {
      floating.set(id, bitWidth(value.type) as 32 | 64);
      carriers.add(id);
    }
  const invalid = new Set<string>();
  const neighbors = new Map<string, Set<string>>();
  const connect = (a: string, b: string): void => {
    const row = neighbors.get(a) ?? new Set<string>();
    row.add(b);
    neighbors.set(a, row);
  };
  for (const id of carriers) {
    context.checkpoint(1);
    for (const parent of parents(program.values.get(id)!)) {
      if (!floating.has(parent.id) && program.expressions.get(parent.id)?.kind !== 'constant')
        invalid.add(id);
      if (carriers.has(parent.id)) {
        connect(id, parent.id);
        connect(parent.id, id);
      }
    }
  }
  for (const [id, expression] of program.expressions) {
    context.checkpoint(1);
    if (!program.live.has(id)) continue;
    for (const operand of expressionOperands(expression)) {
      if (!carriers.has(operand.id)) continue;
      const transport =
        (expression.kind === 'cast' && expression.op === 'bitcast') ||
        (expression.kind === 'select' && operand.id !== expression.condition.id);
      if (!transport || floating.get(id) !== floating.get(operand.id)) invalid.add(operand.id);
    }
  }
  const direct = (value: Value): void => {
    context.checkpoint(1);
    if (carriers.has(value.id)) invalid.add(value.id);
  };
  for (const boundary of [
    ...program.calls.values(),
    ...program.returns.values(),
    ...[...program.tails.values()].map((tail) => tail.boundary),
  ]) {
    for (const value of [...boundary.arguments, ...boundary.results]) direct(value);
    for (const binding of [...boundary.inputs, ...boundary.outputs]) direct(binding.value);
  }
  for (const bindings of [...program.physical_inputs.values(), ...program.physical_exits.values()])
    for (const binding of bindings) direct(binding.value);
  for (const copies of program.transfers.values())
    for (const copy of copies) if (!floating.has(copy.destination.id)) direct(copy.source);
  // A slot is FP storage only if every reload is in the component; otherwise the
  // stores that feed it are integer writes of those bits.
  for (const slot of slots.values())
    if (!slot.loads.length || slot.loads.some((load) => floating.get(load.id) !== slot.bits))
      for (const store of slot.stores) direct(store);
  for (const block of program.blocks.values()) {
    const control = block.control;
    if (control.kind === 'if') direct(control.condition);
    if (control.kind === 'switch') direct(control.value);
    if (control.kind === 'indirect') direct(control.target);
    for (const node of block.statements) {
      context.checkpoint(1);
      if (!program.retained.has(node.id)) continue;
      if (node.kind === 'load' || node.kind === 'store') direct(node.address);
      // An ordinary store writes the whole carrier bits through a float/double lvalue.
      if (
        (node.kind === 'store' && !plain(node) && !slotted.has(node.id)) ||
        node.kind === 'write_register'
      )
        direct(node.value);
    }
  }
  const rejected = [...invalid];
  for (let i = 0; i < rejected.length; i++)
    for (const neighbor of neighbors.get(rejected[i]!) ?? [])
      if (!invalid.has(neighbor)) {
        invalid.add(neighbor);
        rejected.push(neighbor);
      }
  for (const id of invalid) floating.delete(id);
  const returned = program.source.return_type;
  const primary =
    returned?.kind === 'float'
      ? input.source.abi.classifyCall({
          returns: returned,
          parameters: [],
          variadic: false,
          fixed_parameter_count: 0,
        }).returns
      : [];
  const returnFloat =
    returned?.kind === 'float' &&
    primary.length === 1 &&
    primary[0]!.kind === 'register' &&
    program.returns.size > 0 &&
    [...program.returns.values()].every(
      (boundary) =>
        boundary.results.length === 1 &&
        boundary.results[0]!.type.kind === 'float' &&
        floating.get(boundary.results[0]!.id) === returned.bits,
    )
      ? returned.bits
      : undefined;
  const floatAccesses = new Set(
    accesses
      .filter((node) => floating.has((node.kind === 'load' ? node.result : node.value).id))
      .map((node) => node.id),
  );
  if (
    floatAccesses.size &&
    !validation.presentation(
      'fp_memory_access',
      program.function.id,
      'ordinary little-endian, non-volatile, IR-alignment-1 32/64-bit memory accesses outside frame slots whose loaded value is consumed only as a same-width IEEE reinterpretation or closed FP carrier, or whose stored value is a member of such a carrier component; presented as a float/double lvalue of the same bytes',
      [...floatAccesses].slice(0, 64),
      `${floatAccesses.size} accesses read or write exactly the original bytes; a mixed integer/FP use keeps the explicit integer access and bit reinterpretation`,
    )
  )
    return projectSourceFloating(program, input, context, false, slotsEnabled);
  if (
    !floating.size ||
    !validation.presentation(
      'fp_source_types',
      program.function.id,
      'typed IEEE FP32/FP64 values and closed, same-width bitcast/phi/select carriers with no integer consumers; FP primary return classified by the target ABI',
      [...floating.keys()].slice(0, 64),
      `${floating.size} source values retain their exact IEEE bit patterns; this type projection does not change arithmetic or control, whose independent environment and payload gates govern native presentation`,
    )
  )
    return {};
  validation.requireAbi(
    'fp_source_types',
    [program.function.id],
    'Source float/double denote the target IEEE binary32/binary64 representation in the established ABI FP carriers; whole-bit transport is not a numeric integer/FP conversion. Existing FP-environment requirements still apply.',
  );
  const floatLocals = new Map<string, 32 | 64>();
  for (const [id, slot] of slots)
    if (
      slot.loads.length &&
      slot.loads.every((load) => floating.get(load.id) === slot.bits) &&
      slot.stores.every(
        (store) =>
          floating.get(store.id) === slot.bits ||
          program.expressions.get(store.id)?.kind === 'constant',
      )
    )
      floatLocals.set(id, slot.bits);
  // Invalidation reaches every carrier stored into a slot that stays integer.
  for (const [id, slot] of slots)
    if (
      !floatLocals.has(id) &&
      slot.stores.some((store) => carriers.has(store.id) && floating.has(store.id))
    )
      return projectSourceFloating(program, input, context, memory, false);
  if (floatLocals.size) {
    const subjects = [...floatLocals.keys()].flatMap((id) => slots.get(id)!.nodes);
    if (
      !validation.presentation(
        'fp_slot_type',
        program.function.id,
        'exact nonvolatile frame-private promoted slot (private_stack_promotion) whose every stored value is a same-width IEEE value, closed FP carrier member or literal and whose every reload is a member of that carrier component; declared float/double, stores and reloads print without reinterpretation; a mixed integer/FP use keeps the integer slot',
        subjects.slice(0, 64),
        `${floatLocals.size} promoted slots hold exactly the bits their float/double local holds; stores and reloads are plain assignments of equal bit patterns`,
      )
    )
      return projectSourceFloating(program, input, context, memory, false);
    validation.requireAbi(
      'fp_slot_type',
      subjects.slice(0, 64),
      'A float/double local holds and returns exactly the IEEE binary32/binary64 bits assigned to it (no excess precision, no signaling-NaN quieting on assignment); the slot remains private to this activation under the recorded frame_private_to_activation premise. Existing FP-environment requirements still apply.',
    );
  }
  if (floatAccesses.size)
    validation.requireAbi(
      'fp_memory_access',
      [program.function.id],
      'A float/double lvalue accesses the same little-endian IEEE binary32/binary64 bytes as the original same-width integer access, with the storage-view convention of plain integer dereferences; IR alignment 1 states that the target permits the unaligned access without a fault.',
    );
  return {
    float_values: floating,
    ...(floatAccesses.size ? { float_accesses: floatAccesses } : {}),
    ...(floatLocals.size ? { float_locals: floatLocals } : {}),
    ...(returnFloat ? { return_float: returnFloat } : {}),
  };
}

/** Infer a presentation interface from observed uses, retaining every machine
 * value. Narrow carriers are interpreted only under the native C ABI. An
 * approved `fp_memory_access` is a float element access of its width. */
export function projectSourceSignature(
  program: Reconstruction,
  input: EmissionInput,
  context: OperationContext,
  floatAccesses: ReadonlySet<string> = new Set(),
): Pick<SourcePresentation, 'formal_types' | 'local_types' | 'return_scalar'> & {
  readonly returns?: ReadonlyMap<string, BoundaryProjection>;
} {
  const formalTypes = new Map<string, SourceFormalType>();
  const validation = program.local_validation_session;
  if (
    program.view !== 'source' ||
    !program.source ||
    !input.source ||
    !validation ||
    program.signature
  )
    return {};
  const expressions = program.expressions;
  const incoming = new Map<string, Value[]>();
  for (const copies of program.transfers.values())
    for (const copy of copies) {
      const row = incoming.get(copy.destination.id) ?? [];
      row.push(copy.source);
      incoming.set(copy.destination.id, row);
    }
  const conflicts = new Set(input.types?.conflicts.map((item) => item.subject_id));
  const conflicting = (value: Value): boolean =>
    [value.id, ...(program.source?.value_origins?.get(value.id) ?? [])].some((id) =>
      conflicts.has(id),
    );
  const constant = (value: Value): bigint | undefined => {
    const expression = expressions.get(value.id);
    return expression?.kind === 'constant' ? expression.bits : undefined;
  };
  const transport = (value: Value): readonly Value[] => {
    const expression = expressions.get(value.id);
    if (expression?.kind === 'cast' && expression.op === 'bitcast') return [expression.value];
    return incoming.get(value.id) ?? [];
  };
  // Promoted frame-private slots carry every stored value to each load of the
  // slot, like an edge copy, so O0 argument spills do not hide formal uses.
  const slotStores = new Map<string, Value[]>(),
    slotLoads = new Map<string, Value[]>();
  for (const block of program.blocks.values())
    for (const node of block.statements) {
      context.checkpoint(1);
      const slot = program.source.locals.get(node.id)?.id;
      if (!slot || !program.retained.has(node.id)) continue;
      if (node.kind === 'store')
        slotStores.set(slot, [...(slotStores.get(slot) ?? []), node.value]);
      else if (node.kind === 'load')
        slotLoads.set(slot, [...(slotLoads.get(slot) ?? []), node.result]);
    }
  const spilled = new Map<string, readonly Value[]>(),
    reloaded = new Map<string, Value[]>();
  for (const [slot, loads] of slotLoads) {
    const stores = slotStores.get(slot) ?? [];
    for (const load of loads) spilled.set(load.id, stores);
    for (const value of stores)
      reloaded.set(value.id, [...(reloaded.get(value.id) ?? []), ...loads]);
  }
  // An index term is a scaled or extended (narrower-than-address) addend.
  const indexTerm = (value: Value): boolean => {
    const expression = expressions.get(value.id);
    return (
      (expression?.kind === 'cast' &&
        (expression.op === 'zero_extend' || expression.op === 'sign_extend')) ||
      (expression?.kind === 'integer' &&
        (expression.op === 'shl' || expression.op === 'mul') &&
        constant(expression.right) !== undefined) ||
      (expression?.kind === 'integer' &&
        expression.op === 'mul' &&
        constant(expression.left) !== undefined)
    );
  };
  // Pointer lineage follows only unchanged whole bits, constant byte steps,
  // index terms, edge copies and promoted slots. A load through a scalar
  // derived by masking/multiplication does not establish a pointer formal.
  const pointerParents = (value: Value): readonly Value[] => {
    const expression = expressions.get(value.id);
    if (expression?.kind === 'integer' && ['add', 'sub'].includes(expression.op)) {
      if (constant(expression.right) !== undefined) return [expression.left];
      if (expression.op === 'add' && constant(expression.left) !== undefined)
        return [expression.right];
      if (indexTerm(expression.right) && !indexTerm(expression.left)) return [expression.left];
      if (expression.op === 'add' && indexTerm(expression.left) && !indexTerm(expression.right))
        return [expression.right];
    }
    return [...transport(value), ...(spilled.get(value.id) ?? [])];
  };
  const parameterRoots = (value: Value, wholePointers = true): Set<string> => {
    const roots = new Set<string>(),
      seen = new Set<string>(),
      pending = [value];
    while (pending.length) {
      context.checkpoint(1);
      const current = pending.pop()!;
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      if (program.parameters.some((parameter) => parameter.id === current.id))
        roots.add(current.id);
      else {
        const expression = expressions.get(current.id);
        pending.push(
          ...(wholePointers
            ? pointerParents(current)
            : expression
              ? expressionOperands(expression)
              : [...(incoming.get(current.id) ?? []), ...(spilled.get(current.id) ?? [])]),
        );
      }
    }
    return roots;
  };
  // Element kinds reached through each formal's pointer lineage, with their sites.
  const accesses = new Map<string, { elements: Set<string>; sites: string[] }>();
  const written = new Set<string>(),
    escaped = new Set<string>(),
    // Values a preserved register carried into an open-arity call; no native
    // C ABI passes an argument there, so they never make the callee a writer.
    preservedInputRoots = new Set<string>();
  // The stack pointer, link register and callee-saved registers are never
  // argument carriers of a native call.
  const abi = input.source.abi,
    nonArgumentRoots = new Set([
      abi.stack_pointer.root,
      ...(abi.link_register ? [abi.link_register.root] : []),
      ...abi.preserved.map((register) => register.root),
    ]);
  let writingCall = false;
  let mayWrite = false;
  for (const block of program.blocks.values())
    for (const node of block.statements) {
      context.checkpoint(1);
      if (node.kind === 'unknown_effect') mayWrite = true;
      if (node.kind === 'call' && node.clobbers.memory === 'unknown_read_write') {
        writingCall = true;
        const boundary = program.calls.get(node.id);
        const arguments_ = boundary
          ? [...boundary.arguments, ...boundary.inputs.map((binding) => binding.value)]
          : [...node.arguments, ...node.register_inputs.map((binding) => binding.value)];
        if (boundary?.argument_list_complete === false)
          for (const binding of node.register_inputs) {
            if (nonArgumentRoots.has(binding.register.root)) {
              for (const root of parameterRoots(binding.value, false))
                preservedInputRoots.add(root);
            } else arguments_.push(binding.value);
          }
        for (const argument of arguments_)
          for (const root of parameterRoots(argument, false)) written.add(root);
      }
      // Hidden stack traffic and promoted slots are not memory uses of a formal.
      if (
        (node.kind !== 'load' && node.kind !== 'store') ||
        !program.retained.has(node.id) ||
        program.source.locals.has(node.id)
      )
        continue;
      if (node.kind === 'store') {
        for (const root of parameterRoots(node.address, false)) written.add(root);
        for (const root of parameterRoots(node.value, false)) escaped.add(root);
      }
      const value = node.kind === 'load' ? node.result : node.value;
      const kind = floatAccesses.has(node.id) ? 'float' : value.type.kind;
      const element =
        kind === 'integer' || kind === 'float' ? `${kind}:${bitWidth(value.type)}` : 'other';
      for (const root of parameterRoots(node.address)) {
        const row = accesses.get(root) ?? { elements: new Set<string>(), sites: [] };
        row.elements.add(element);
        row.sites.push(node.id);
        accesses.set(root, row);
      }
    }
  if (writingCall) for (const root of escaped) written.add(root);
  const users = new Map<string, Value[]>();
  for (const [id, expression] of expressions) {
    if (!program.live.has(id)) continue;
    const value = program.values.get(id);
    if (!value) continue;
    for (const operand of expressionOperands(expression)) {
      const row = users.get(operand.id) ?? [];
      row.push(value);
      users.set(operand.id, row);
    }
  }
  // Whole-value observers. Edge copies and promoted-slot stores instead pass
  // their value on to the copy destination or the slot's reloads.
  const direct = new Set<string>();
  const copied = new Map<string, Value[]>();
  for (const copies of program.transfers.values())
    for (const copy of copies)
      copied.set(copy.source.id, [...(copied.get(copy.source.id) ?? []), copy.destination]);
  for (const boundary of [
    ...program.calls.values(),
    ...program.returns.values(),
    ...[...program.tails.values()].map((tail) => tail.boundary),
  ]) {
    for (const value of [...boundary.arguments, ...boundary.results]) direct.add(value.id);
    for (const binding of [...boundary.inputs, ...boundary.outputs]) direct.add(binding.value.id);
  }
  for (const bindings of [...program.physical_inputs.values(), ...program.physical_exits.values()])
    for (const binding of bindings) direct.add(binding.value.id);
  const predicates = sourceRequirementPredicates(program.source.requirements);
  const entries = new Map<string, number>(),
    failures: string[] = [];
  for (const block of program.blocks.values()) {
    const control = block.control;
    const arms =
      control.kind === 'jump'
        ? [control]
        : control.kind === 'if'
          ? [control.when_true, control.when_false]
          : control.kind === 'switch'
            ? [...control.cases.map((item) => item.arm), control.otherwise]
            : [];
    for (const arm of arms)
      entries.set(arm.transfer.target, (entries.get(arm.transfer.target) ?? 0) + 1);
    const requirement = control.kind === 'if' ? predicates.get(control.id) : undefined;
    if (control.kind === 'if' && requirement)
      failures.push(
        (requirement.site.supported_predicate_value ? control.when_false : control.when_true)
          .transfer.target,
      );
  }
  const assumedUnreachable = new Set(failures.filter((id) => entries.get(id) === 1));
  for (const block of program.blocks.values()) {
    if (block.control.kind === 'if') direct.add(block.control.condition.id);
    if (block.control.kind === 'switch') direct.add(block.control.value.id);
    if (block.control.kind === 'indirect') direct.add(block.control.target.id);
    if (block.control.kind === 'indirect' || block.control.kind === 'unknown') mayWrite = true;
    // An unresolved exit may observe every register cell; cells it does not
    // rebind still hold their entry bits, so no formal may drop upper bits.
    // Exits reachable only under a failed recorded requirement are excluded
    // by that requirement's assumption.
    const tail = program.tails.get(block.control.id)?.boundary;
    if (
      (block.control.kind === 'indirect' || block.control.kind === 'unknown') &&
      (!tail || tail.kind === 'physical' || tail.argument_list_complete === false) &&
      !assumedUnreachable.has(block.id)
    )
      for (const value of program.parameters) direct.add(value.id);
    for (const node of block.statements) {
      if (node.kind === 'call') {
        // Physical or open-arity interfaces may read any register input.
        const boundary = program.calls.get(node.id);
        if (!boundary || boundary.kind === 'physical' || boundary.argument_list_complete === false)
          for (const binding of node.register_inputs) direct.add(binding.value.id);
      }
      if (!program.retained.has(node.id)) continue;
      if ((node.kind === 'load' || node.kind === 'store') && !program.source.locals.has(node.id))
        direct.add(node.address.id);
      if (
        (node.kind === 'store' && !program.source.locals.has(node.id)) ||
        node.kind === 'write_register'
      )
        direct.add(node.value.id);
      if (node.kind === 'unknown_effect')
        for (const binding of node.register_inputs) direct.add(binding.value.id);
    }
  }
  const signedConsumer = (slice: Value): boolean =>
    (users.get(slice.id) ?? []).some((consumer) => {
      const operation = expressions.get(consumer.id);
      return (
        (operation?.kind === 'compare' && operation.op.startsWith('s')) ||
        (operation?.kind === 'cast' && operation.op === 'sign_extend') ||
        (operation?.kind === 'integer' &&
          ['sdiv', 'srem', 'ashr'].includes(operation.op) &&
          (operation.op !== 'ashr' || operation.left.id === slice.id))
      );
    });
  for (const parameter of program.parameters) {
    context.checkpoint(1);
    if (parameter.type.kind !== 'integer' || conflicting(parameter)) continue;
    // Independent supplied declarations and projected pointer layouts win.
    const projected = program.source.value_types?.get(parameter.id);
    if (
      projected &&
      input.types?.associations.some(
        (association) =>
          projected.association_ids.includes(association.id) && association.source !== 'analysis',
      )
    )
      continue;
    const origins = program.source.value_origins?.get(parameter.id) ?? [];
    const access = accesses.get(parameter.id);
    const [element] = access?.elements.size === 1 ? access.elements : [];
    const [kind, bits] = element?.split(':') ?? [];
    const pointee = Number(bits);
    if (
      ((kind === 'integer' && [8, 16, 32, 64].includes(pointee)) ||
        (kind === 'float' && [32, 64].includes(pointee))) &&
      bitWidth(parameter.type) === input.source.abi.layout.pointer_bits
    ) {
      const readOnly = !mayWrite && !written.has(parameter.id);
      if (
        validation.presentation(
          'formal_pointer',
          parameter.id,
          `whole-value pointer lineage (copies, promoted slots, constant byte steps, index terms) reaches only ${pointee}-bit ${kind} accesses; ${readOnly ? 'read-only formal: no writes through it or escape to a potentially writing call, and no unknown effects' : 'write-capable formal: write, call escape or unknown effects prevent const qualification'}`,
          [...origins, ...access!.sites.slice(0, 16)],
        )
      ) {
        formalTypes.set(parameter.id, {
          kind: 'pointer',
          bits: bitWidth(parameter.type),
          pointee: kind === 'float' ? 'float' : 'integer',
          pointee_bits: pointee,
          const: readOnly,
        });
        validation.requireAbi(
          'formal_pointer',
          [program.function.id],
          'Present an observed scalar-address argument as a native C pointer with unchanged target address bits.',
        );
        if (readOnly && preservedInputRoots.has(parameter.id))
          validation.requireAbi(
            'formal_pointer',
            [program.function.id],
            'A call with an open argument list receives its arguments only in argument registers and stack slots; the stack pointer, link register and callee-saved registers carry no arguments, so a formal held there across the call is not passed to it.',
          );
      }
      continue;
    }
    // Every live use, through copies, promoted slots and bitcasts, must read
    // only the low slice: a truncation, an extract inside it or a mask whose
    // set bits lie in it. Only signed consumers of an unchanged low slice of
    // the presented width establish a signed interpretation.
    const pending = [parameter],
      seen = new Set<string>(),
      sites: string[] = [],
      signedSlices = new Set<number>();
    let valid = true,
      width = 0;
    while (pending.length && valid) {
      const value = pending.pop()!;
      if (seen.has(value.id)) continue;
      seen.add(value.id);
      if (direct.has(value.id)) {
        valid = false;
        break;
      }
      pending.push(...(copied.get(value.id) ?? []), ...(reloaded.get(value.id) ?? []));
      for (const user of users.get(value.id) ?? []) {
        context.checkpoint(1);
        const expression = expressions.get(user.id)!;
        const mask =
          expression.kind === 'integer' && expression.op === 'and'
            ? (constant(expression.right) ?? constant(expression.left))
            : undefined;
        if (expression.kind === 'cast' && expression.op === 'bitcast') pending.push(user);
        else if (
          expression.kind === 'extract' ||
          (expression.kind === 'cast' && expression.op === 'truncate')
        ) {
          const bits = bitWidth(user.type),
            offset = expression.kind === 'extract' ? expression.offset : 0;
          width = Math.max(width, offset + bits);
          if (offset === 0 && signedConsumer(user)) signedSlices.add(bits);
          sites.push(user.id);
        } else if (mask !== undefined && mask <= 0xffffffffn) {
          width = Math.max(width, mask.toString(2).length);
          sites.push(user.id);
        } else {
          valid = false;
          break;
        }
      }
    }
    const presented = width <= 8 ? 8 : width <= 16 ? 16 : 32;
    const signed = signedSlices.has(presented);
    if (
      valid &&
      width > 0 &&
      width <= 32 &&
      bitWidth(parameter.type) > presented &&
      validation.presentation(
        'formal_low_slice',
        parameter.id,
        `every live use, through copies, promoted slots and bitcasts, reads only the low ${presented} bits (truncation, an extract inside them or a mask within them); ${signed ? 'an unchanged low slice of that width has a signed comparison, extension, division, remainder or arithmetic shift' : 'no signed consumer of that slice: unsigned interpretation'}`,
        [...origins, ...sites.slice(0, 16)],
      )
    ) {
      formalTypes.set(parameter.id, { kind: 'integer', bits: presented, signed });
      validation.requireAbi(
        'formal_low_slice',
        [program.function.id],
        'Only the low argument bits are consumed; native C ABI upper argument carrier bits are not part of the presented narrow parameter.',
      );
    }
  }
  // A promoted slot whose every stored value is the address lineage of one
  // pointer formal kind (the formal, a reload of such a slot, or a constant
  // whole-element step of one) takes that kind; reloads share it. Any other
  // store keeps the integer slot. Optimistic start, then a shrinking fixpoint.
  const reloadSlot = new Map<string, string>();
  for (const [slot, loads] of slotLoads) for (const load of loads) reloadSlot.set(load.id, slot);
  const sameKind = (left: SourceFormalType, right: SourceFormalType): boolean =>
    left.kind === 'pointer' &&
    right.kind === 'pointer' &&
    left.pointee === right.pointee &&
    left.pointee_bits === right.pointee_bits;
  const pointerKind = (
    value: Value,
    typed: ReadonlyMap<string, SourceFormalType>,
    depth = 0,
  ): SourceFormalType | undefined => {
    context.checkpoint(1);
    if (depth > 16) return undefined;
    const formal = formalTypes.get(value.id);
    if (formal?.kind === 'pointer') return formal;
    const slot = reloadSlot.get(value.id);
    if (slot) return typed.get(slot);
    const expression = expressions.get(value.id);
    if (expression?.kind === 'cast' && expression.op === 'bitcast')
      return bitWidth(expression.value.type) === bitWidth(value.type)
        ? pointerKind(expression.value, typed, depth + 1)
        : undefined;
    if (expression?.kind !== 'integer' || (expression.op !== 'add' && expression.op !== 'sub'))
      return undefined;
    const [base, step] =
      constant(expression.right) !== undefined
        ? [expression.left, constant(expression.right)!]
        : expression.op === 'add' && constant(expression.left) !== undefined
          ? [expression.right, constant(expression.left)!]
          : [undefined, 0n];
    const kind = base && pointerKind(base, typed, depth + 1);
    return kind?.kind === 'pointer' &&
      BigInt.asIntN(bitWidth(value.type), step) % BigInt(kind.pointee_bits / 8) === 0n
      ? kind
      : undefined;
  };
  const slotTypes = new Map<string, SourceFormalType>();
  for (const [slot, stores] of slotStores) {
    const kinds = stores.map((value) => pointerKind(value, slotTypes));
    const kind = kinds.find((item) => item !== undefined);
    if (kind?.kind === 'pointer' && stores.every((value) => bitWidth(value.type) === kind.bits))
      slotTypes.set(slot, kind);
  }
  for (let changed = slotTypes.size > 0; changed;) {
    changed = false;
    for (const [slot, kind] of slotTypes) {
      const kinds = (slotStores.get(slot) ?? []).map((value) => pointerKind(value, slotTypes));
      if (kinds.every((item) => item && sameKind(item, kind))) {
        const readOnly = kinds.every((item) => item?.kind === 'pointer' && item.const);
        if (kind.kind === 'pointer' && kind.const !== readOnly) {
          slotTypes.set(slot, { ...kind, const: readOnly });
          changed = true;
        }
        continue;
      }
      slotTypes.delete(slot);
      changed = true;
    }
  }
  const localTypes = new Map<string, SourceFormalType>();
  for (const [slot, kind] of slotTypes) {
    const loads = slotLoads.get(slot) ?? [];
    if (
      !validation.presentation(
        'slot_pointer_type',
        slot,
        'every value stored to this promoted frame-private slot is a pointer formal of one element kind, a reload of such a slot, or a whole-element constant step of one; reloads share the type and address bits are unchanged',
        [...(slotStores.get(slot) ?? []), ...loads].map((value) => value.id).slice(0, 32),
      )
    )
      continue;
    localTypes.set(slot, kind);
    for (const load of loads) formalTypes.set(load.id, kind);
  }
  const result = { formal_types: formalTypes, local_types: localTypes };
  const suppliedReturn = input.types?.types.some(
    (record) =>
      record.id === program.source?.return_source_type &&
      (record.source !== 'analysis' || record.definition.kind !== 'integer'),
  );
  if (
    suppliedReturn ||
    program.source.return_pointer ||
    program.tails.size ||
    !program.returns.size ||
    (program.source.return_type && bitWidth(program.source.return_type) < 32)
  )
    return result;
  if (
    input.source.function_return_demands?.some(
      (register) => register.offset_bits + register.width_bits > 32,
    )
  )
    return result;
  const returned = [...program.returns.values()];
  const zeroExtension = (value: Value): boolean => {
    const literal = constant(value);
    if (literal !== undefined) return literal === 0n;
    const expression = expressions.get(value.id);
    return (
      expression !== undefined &&
      !validation.skipExhaustedBitvector(value.id) &&
      validation.check(
        'bitvector',
        value.id,
        'high result slice is exactly the zero extension of a low word',
        () =>
          validateBitvectorCandidate(
            value,
            expression,
            { kind: 'constant', bits: 0n },
            expressions,
            validation.allowance,
          ),
      ).status === 'verified'
    );
  };
  const hasHighOutputs = returned.some((boundary) => boundary.outputs.length > 0);
  const primary = hasHighOutputs
    ? input.source.abi.classifyCall({
        returns: { kind: 'integer', bits: 32, signed: false },
        parameters: [],
        variadic: false,
        fixed_parameter_count: 0,
      }).returns[0]
    : undefined;
  const extensionOutput = (boundary: BoundaryProjection): boolean =>
    primary?.kind === 'register' &&
    bitWidth(boundary.results[0]!.type) === 32 &&
    boundary.outputs.every(
      ({ register, value }) =>
        register.root === primary.register.root &&
        register.offset_bits >= primary.register.offset_bits + 32 &&
        register.offset_bits + register.width_bits <= primary.register.root_width_bits &&
        zeroExtension(value),
    );
  if (
    returned.some(
      (boundary) =>
        boundary.results.length !== 1 ||
        boundary.results[0]!.type.kind !== 'integer' ||
        conflicting(boundary.results[0]!) ||
        (boundary.outputs.length > 0 && !extensionOutput(boundary)),
    )
  )
    return result;
  // Width proof: every nonconstant leaf is already a word or is an explicit
  // extension of one. Constants may join that width but cannot establish it.
  const narrow = (value: Value, active = new Set<string>()): number | null => {
    context.checkpoint(1);
    if (active.has(value.id) || active.size >= 64) return null;
    active.add(value.id);
    const expression = expressions.get(value.id);
    let width: number | null;
    if (bitWidth(value.type) <= 32) width = 32;
    else if (expression?.kind === 'constant')
      width = expression.bits >= 0n && expression.bits <= 0xffffffffn ? 0 : null;
    else if (
      expression?.kind === 'cast' &&
      ['zero_extend', 'sign_extend', 'bitcast'].includes(expression.op)
    )
      width = narrow(expression.value, active);
    else {
      const sources =
        expression?.kind === 'select'
          ? [expression.when_true, expression.when_false]
          : transport(value);
      const widths = sources.map((source) => narrow(source, active));
      width =
        widths.length && widths.every((bits) => bits !== null)
          ? Math.max(...(widths as number[]))
          : null;
    }
    active.delete(value.id);
    return width;
  };
  const widths = returned.map((boundary) => narrow(boundary.results[0]!));
  if (widths.some((width) => width === null) || !widths.includes(32)) return result;
  // Byte subtraction is signed evidence because both operands are proved in
  // [0,255], making the mathematical difference fit in signed 32 bits.
  const byte = (value: Value, active = new Set<string>()): boolean => {
    context.checkpoint(1);
    if (active.has(value.id) || active.size >= 64) return false;
    if (bitWidth(value.type) <= 8) return true;
    const literal = constant(value);
    if (literal !== undefined) return literal >= 0n && literal <= 255n;
    active.add(value.id);
    const expression = expressions.get(value.id);
    const sources =
      expression?.kind === 'cast' && ['zero_extend', 'bitcast'].includes(expression.op)
        ? [expression.value]
        : transport(value);
    const valid = sources.length > 0 && sources.every((source) => byte(source, active));
    active.delete(value.id);
    return valid;
  };
  let signedEvidence = false;
  const signedResult = (value: Value, active = new Set<string>()): boolean => {
    context.checkpoint(1);
    if (active.has(value.id) || active.size >= 64) return false;
    active.add(value.id);
    const expression = expressions.get(value.id);
    const comparison =
      expression?.kind === 'select' ? expressions.get(expression.condition.id) : undefined;
    const signedSelection =
      expression?.kind === 'select' &&
      comparison?.kind === 'compare' &&
      comparison.op.startsWith('s') &&
      ((expression.when_true.id === comparison.left.id &&
        expression.when_false.id === comparison.right.id) ||
        (expression.when_true.id === comparison.right.id &&
          expression.when_false.id === comparison.left.id));
    let valid = false;
    if (expression?.kind === 'constant') valid = true;
    else if (byte(value)) valid = true;
    else if (
      (bitWidth(value.type) === 32 && signedSelection) ||
      (expression?.kind === 'integer' &&
        ['sdiv', 'srem', 'ashr'].includes(expression.op) &&
        (bitWidth(value.type) === 32 ||
          [expression.left, ...(expression.op === 'ashr' ? [] : [expression.right])].every(
            (operand) => {
              const extended = expressions.get(operand.id);
              return (
                extended?.kind === 'cast' &&
                extended.op === 'sign_extend' &&
                bitWidth(extended.value.type) === 32
              );
            },
          )))
    ) {
      signedEvidence = true;
      valid = true;
    } else if (
      expression?.kind === 'cast' &&
      expression.op === 'sign_extend' &&
      bitWidth(expression.value.type) === 32
    ) {
      signedEvidence = true;
      valid = true;
    } else if (
      expression?.kind === 'integer' &&
      expression.op === 'sub' &&
      byte(expression.left) &&
      byte(expression.right)
    ) {
      signedEvidence = true;
      valid = true;
    } else {
      const sources =
        (expression?.kind === 'cast' &&
          ['zero_extend', 'sign_extend', 'bitcast', 'truncate'].includes(expression.op)) ||
        (expression?.kind === 'extract' && expression.offset === 0)
          ? [expression.value]
          : expression?.kind === 'select'
            ? [expression.when_true, expression.when_false]
            : transport(value);
      valid = sources.length > 0 && sources.every((source) => signedResult(source, active));
    }
    active.delete(value.id);
    return valid;
  };
  const signed = returned.every((boundary) => signedResult(boundary.results[0]!)) && signedEvidence;
  const anchors = [...program.returns.keys()];
  if (
    !validation.presentation(
      'return_low_word',
      program.function.id,
      `every return is an explicit low-word value or extension; no observed caller demands high bits; ${signed ? 'explicit signed operations or byte differences with compatible constants/bytes' : 'unsigned interpretation retained'}`,
      anchors,
    )
  )
    return result;
  validation.requireAbi(
    'return_low_word',
    anchors,
    'Present the low 32-bit C ABI result; upper result-register bits of a narrow return are unspecified to ABI-conforming callers.',
  );
  return {
    ...result,
    return_scalar: { bits: 32, signed },
    ...(hasHighOutputs
      ? {
          returns: new Map(
            [...program.returns].map(([id, boundary]) => [
              id,
              boundary.outputs.length ? { ...boundary, outputs: [] } : boundary,
            ]),
          ),
        }
      : {}),
  };
}
