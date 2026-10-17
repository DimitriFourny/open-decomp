import {
  OperationError,
  type Diagnostic,
  type OperationContext,
  type RegisterDescriptor,
} from '../core/index.js';
import type { EmissionInput } from '../emitters/model.js';
import {
  expressionOperands,
  type Origin,
  type RegisterBinding,
  type Value,
  bitWidth,
} from '../ir/index.js';
import type { BlockRegion, Control, ParallelTransfer, Region } from '../presentation/index.js';
import { boundaryProjector } from './boundaries.js';
import { foldExpressions, identityOperand } from './expressions.js';
import type { Assignment, BoundaryProjection, MemoryView, Reconstruction } from './model.js';
import { planSource } from './source-planner.js';
import { planSourceStack } from './source-stack.js';
import { normalizeSourceExpressions } from './source-expressions.js';
import { projectSourceTypes } from './source-types.js';
import { normalizeSourceRanges } from './source-ranges.js';
export type * from './model.js';

function controlTransfers(control: Control): readonly ParallelTransfer[] {
  switch (control.kind) {
    case 'jump':
      return [control.transfer];
    case 'if':
      return [control.when_true.transfer, control.when_false.transfer];
    case 'switch':
      return [...control.cases.map((item) => item.arm.transfer), control.otherwise.transfer];
    default:
      return [];
  }
}
/** The original structured SSA remains immutable. Reconstruction is a bounded
 * view: pure expression folding, demand-driven live phi copies, exact physical
 * snapshots and conservative source projections. No CFG is structured twice. */
export function reconstruct(input: EmissionInput, context: OperationContext): Reconstruction {
  context.checkpoint(0);
  const blocks = new Map<string, BlockRegion>(),
    values = new Map<string, Value>();
  const assignments = new Map<string, Assignment>();
  const owner = new Map<string, string>(),
    parameterSources = new Map<string, Value[]>();
  const allTransfers: { transfer: ParallelTransfer; block: BlockRegion }[] = [];
  const pending: Region[] = [input.function.body];
  let statementCount = 0;
  while (pending.length) {
    context.checkpoint(1);
    const region = pending.pop()!;
    if (region.kind === 'sequence') {
      context.checkpoint(region.regions.length);
      for (let i = region.regions.length - 1; i >= 0; i--) pending.push(region.regions[i]!);
      continue;
    }
    if (region.kind === 'loop') {
      pending.push(region.body);
      continue;
    }
    if (blocks.has(region.id))
      throw new OperationError({
        code: 'invalid_input',
        severity: 'error',
        message: 'Structured block is owned more than once',
        evidence_ids: [],
      });
    if (blocks.size >= context.budget.blocks)
      throw new OperationError({
        code: 'resource_limit',
        severity: 'error',
        message: 'Reconstruction block budget exceeded',
        evidence_ids: [],
      });
    blocks.set(region.id, region);
    for (const value of region.parameters) {
      context.checkpoint(1);
      values.set(value.id, value);
      owner.set(value.id, region.id);
      parameterSources.set(value.id, []);
    }
    statementCount += region.statements.length;
    if (statementCount > context.budget.ir_nodes)
      throw new OperationError({
        code: 'resource_limit',
        severity: 'error',
        message: 'Reconstruction statement budget exceeded',
        evidence_ids: [],
      });
    for (const node of region.statements) {
      context.checkpoint(1);
      const results = [
        ...('result' in node ? [node.result] : []),
        ...(node.kind === 'call' ? node.results : []),
        ...('register_outputs' in node
          ? node.register_outputs.map((binding) => binding.value)
          : []),
      ];
      for (const value of results) {
        context.checkpoint(1);
        values.set(value.id, value);
        owner.set(value.id, region.id);
      }
      if (node.kind === 'assign') assignments.set(node.result.id, node);
    }
    if (values.size > context.budget.ir_nodes)
      throw new OperationError({
        code: 'resource_limit',
        severity: 'error',
        message: 'Reconstruction value budget exceeded',
        evidence_ids: [],
      });
    const control = region.control;
    for (const transfer of controlTransfers(control)) {
      context.checkpoint(transfer.copies.length + 1);
      allTransfers.push({ transfer, block: region });
    }
    if (control.kind === 'if') {
      if (control.when_false.body) pending.push(control.when_false.body);
      if (control.when_true.body) pending.push(control.when_true.body);
    } else if (control.kind === 'switch') {
      if (control.otherwise.body) pending.push(control.otherwise.body);
      for (let i = control.cases.length - 1; i >= 0; i--) {
        const body = control.cases[i]!.arm.body;
        if (body) pending.push(body);
      }
    }
  }
  for (const { transfer } of allTransfers)
    for (const copy of transfer.copies) {
      context.checkpoint(1);
      const sources = parameterSources.get(copy.destination.id);
      if (sources) sources.push(copy.source);
    }
  const expressions = foldExpressions(assignments, context);
  if (input.source)
    normalizeSourceRanges(input.function.entry, blocks, expressions, parameterSources, context);
  const entry = blocks.get(input.function.entry);
  const entryBindings = entry?.register_entry ?? [];
  const entryParameters = new Set(entry?.parameters.map((value) => value.id));
  const sourcePlan = input.source
    ? planSource(input, blocks, values, expressions, owner, context)
    : null;
  const sourceStack = sourcePlan
    ? planSourceStack(
        input,
        blocks,
        expressions,
        allTransfers,
        sourcePlan.calls,
        sourcePlan.returns,
        sourcePlan.alias,
        context,
        sourcePlan.incomingStack,
        sourcePlan.entryStack,
      )
    : null;
  if (sourcePlan) normalizeSourceExpressions(values, expressions, owner, sourcePlan.make, context);

  // A three-level identity lattice (unreached / exact identity / conflicting).
  // Ignoring unreached backedges discovers unchanged loop-carried registers;
  // any nonidentity incoming path monotonically invalidates that conclusion.
  const identities = new Map<string, string | null>(),
    identityUsers = new Map<string, string[]>();
  const dependencies = new Map<string, readonly Value[]>();
  for (const [id, value] of values) {
    context.checkpoint(1);
    const expression = expressions.get(id),
      alias = expression ? identityOperand(value.type, expression) : null;
    const sources = alias ? [alias] : parameterSources.get(id);
    if (sources) {
      dependencies.set(id, sources);
      for (const source of sources) {
        context.checkpoint(1);
        const list = identityUsers.get(source.id) ?? [];
        list.push(id);
        identityUsers.set(source.id, list);
      }
      if ((entryParameters.has(id) && (!sourcePlan || !alias)) || sources.length === 0)
        identities.set(id, id);
    } else identities.set(id, id);
  }
  const identityQueue = [...values.keys()],
    identityQueued = new Set(identityQueue);
  for (let cursor = 0; cursor < identityQueue.length; cursor++) {
    context.checkpoint(1);
    const id = identityQueue[cursor]!;
    identityQueued.delete(id);
    let result = identities.get(id);
    for (const source of dependencies.get(id) ?? []) {
      context.checkpoint(1);
      const incoming = identities.get(source.id);
      if (incoming === undefined) continue;
      result = result === undefined ? incoming : result === incoming ? result : null;
    }
    if (result === undefined || identities.get(id) === result) continue;
    identities.set(id, result);
    for (const user of identityUsers.get(id) ?? [])
      if (!identityQueued.has(user)) {
        identityQueued.add(user);
        identityQueue.push(user);
      }
  }
  if (sourcePlan)
    for (const [id, identity] of identities) {
      context.checkpoint(1);
      if (identity && id !== identity && values.has(identity))
        sourcePlan.alias(values.get(id)!, {
          kind: 'cast',
          op: 'bitcast',
          value: values.get(identity)!,
        });
    }
  if (sourcePlan) normalizeSourceExpressions(values, expressions, owner, sourcePlan.make, context);
  const initial = new Map(entryBindings.map((binding) => [binding.register.id, binding.value.id]));
  const snapshot = (bindings: readonly RegisterBinding[]): readonly RegisterBinding[] =>
    bindings.filter((binding) => {
      context.checkpoint(1);
      const identity = identities.get(binding.value.id);
      return (
        identity === undefined || identity === null || initial.get(binding.register.id) !== identity
      );
    });
  const project = boundaryProjector(input.types, context);
  const calls = new Map<string, BoundaryProjection>(),
    returns = new Map<string, BoundaryProjection>();
  const physical_inputs = new Map<string, readonly RegisterBinding[]>(),
    physical_exits = new Map<string, readonly RegisterBinding[]>();
  let functionProjection: BoundaryProjection | null = null;
  for (const block of blocks.values()) {
    context.checkpoint(1);
    for (const node of block.statements) {
      context.checkpoint(1);
      if ('register_inputs' in node)
        physical_inputs.set(node.id, sourcePlan ? [] : snapshot(node.register_inputs));
      if (node.kind === 'call') {
        const projection =
          sourcePlan?.calls.get(node.id) ??
          project(
            node.id,
            node.register_inputs,
            node.register_outputs,
            node.arguments,
            node.results,
          );
        calls.set(
          node.id,
          projection.kind === 'physical'
            ? { ...projection, inputs: physical_inputs.get(node.id)! }
            : projection,
        );
      }
    }
    const control = block.control;
    if (
      control.kind === 'return' ||
      control.kind === 'trap' ||
      control.kind === 'unknown' ||
      control.kind === 'indirect'
    )
      physical_exits.set(
        control.id,
        sourcePlan && !(control.kind === 'indirect' && control.tail_call)
          ? []
          : snapshot(block.register_exit),
      );
    if (control.kind === 'return') {
      if (sourcePlan) {
        returns.set(control.id, sourcePlan.returns.get(control.id)!);
        continue;
      }
      const projection = project(
        input.function.id,
        entryBindings,
        block.register_exit,
        [],
        control.values,
        true,
      );
      if (projection.kind === 'source') {
        returns.set(control.id, {
          ...projection,
          arguments: [],
          inputs: [],
          outputs: snapshot(projection.outputs).filter(
            (binding) => !projection.results.some((value) => value.id === binding.value.id),
          ),
        });
      } else
        returns.set(control.id, {
          kind: 'physical',
          signature: null,
          arguments: [],
          results: control.values,
          inputs: [],
          outputs: snapshot(block.register_exit),
        });
      if (functionProjection === null) functionProjection = projection;
      else if (
        functionProjection.kind !== 'source' ||
        projection.kind !== 'source' ||
        functionProjection.signature?.id !== projection.signature?.id
      )
        functionProjection = { ...projection, kind: 'physical', signature: null };
    }
  }

  const live = new Set<string>(),
    retained = new Set<string>();
  const uses = new Map<string, { count: number; blocks: Set<string> }>();
  const liveQueue: Value[] = [];
  const use = (value: Value, block: string): void => {
    context.checkpoint(1);
    const row = uses.get(value.id) ?? { count: 0, blocks: new Set<string>() };
    row.count++;
    row.blocks.add(block);
    uses.set(value.id, row);
    if (!live.has(value.id)) {
      live.add(value.id);
      liveQueue.push(value);
    }
  };
  const roots = new Map<string, Value[]>();
  for (const block of blocks.values()) {
    for (const node of block.statements) {
      context.checkpoint(1);
      if (
        node.kind === 'assign' ||
        sourceStack?.hidden.has(node.id) ||
        (node.kind === 'load' && sourceStack?.returnAddressLoads.has(node.result.id))
      )
        continue;
      retained.add(node.id);
      const operands: Value[] = [];
      if (node.kind === 'write_register') operands.push(node.value);
      if (node.kind === 'load' || node.kind === 'store') {
        if (!sourceStack?.locals.has(node.id)) operands.push(node.address);
        if (node.kind === 'store') operands.push(node.value);
      }
      if (node.kind === 'call') {
        const projection = calls.get(node.id)!;
        operands.push(
          ...projection.arguments,
          ...projection.inputs.map((binding) => binding.value),
        );
        if (node.target.kind === 'indirect') operands.push(node.target.value);
      } else if ('register_inputs' in node)
        operands.push(...(physical_inputs.get(node.id) ?? []).map((binding) => binding.value));
      roots.set(node.id, operands);
      for (const value of operands) use(value, block.id);
    }
    const control = block.control,
      operands: Value[] = [];
    if (control.kind === 'if') operands.push(control.condition);
    else if (control.kind === 'switch') operands.push(control.value);
    else if (control.kind === 'indirect') operands.push(control.target);
    if (control.kind === 'return') {
      const projection = returns.get(control.id)!;
      operands.push(...projection.results, ...projection.outputs.map((binding) => binding.value));
    } else operands.push(...(physical_exits.get(control.id) ?? []).map((binding) => binding.value));
    roots.set(control.id, operands);
    for (const value of operands) use(value, block.id);
  }
  // Incoming phi sources are demanded only when their destination is live.
  const incomingUses = new Map<string, { source: Value; block: string }[]>();
  for (const { transfer, block } of allTransfers)
    for (const copy of transfer.copies) {
      context.checkpoint(1);
      const list = incomingUses.get(copy.destination.id) ?? [];
      list.push({ source: copy.source, block: block.id });
      incomingUses.set(copy.destination.id, list);
    }
  for (let cursor = 0; cursor < liveQueue.length; cursor++) {
    context.checkpoint(1);
    const value = liveQueue[cursor]!,
      expression = expressions.get(value.id);
    const returnAddress = sourceStack?.returnAddressLoads.get(value.id);
    if (returnAddress) {
      retained.add(returnAddress.node.id);
      roots.set(returnAddress.node.id, [returnAddress.node.address]);
      use(returnAddress.node.address, returnAddress.block);
    }
    if (sourceStack?.addresses.has(value.id)) {
      if (sourceStack.entryStorage && sourceStack.requiresEntry(value.id))
        use(sourceStack.entryStorage, owner.get(value.id)!);
      continue;
    }
    if (expression)
      for (const operand of expressionOperands(expression)) use(operand, owner.get(value.id)!);
    if (!sourcePlan || !expression || !identityOperand(value.type, expression))
      for (const incoming of incomingUses.get(value.id) ?? []) use(incoming.source, incoming.block);
  }
  if (sourcePlan)
    for (const [id, projection] of calls)
      calls.set(id, {
        ...projection,
        outputs: projection.outputs.filter((binding) => {
          context.checkpoint(1);
          return live.has(binding.value.id) && !expressions.has(binding.value.id);
        }),
      });
  const transfers = new Map<
    ParallelTransfer,
    readonly { readonly destination: Value; readonly source: Value }[]
  >();
  for (const { transfer, block } of allTransfers) {
    const copies = transfer.copies.filter((copy) => {
      context.checkpoint(1);
      return (
        live.has(copy.destination.id) &&
        copy.destination.id !== copy.source.id &&
        // Source aliases are immutable expressions, including aliases normalized
        // to constants. They are not phi storage assigned by an edge transfer.
        !sourcePlan?.forcedInline.has(copy.destination.id)
      );
    });
    transfers.set(transfer, copies);
    roots.get(block.control.id)!.push(...copies.map((copy) => copy.source));
  }

  // Only same-block single-use expressions move. A local depending on a block
  // parameter must never be expanded after a successor transfer rebinds it.
  // Constants are the sole freely shared expressions. Sizes account for every
  // operand occurrence, bounding a repeated-operand DAG before rendering.
  const inline = new Set<string>(sourcePlan?.forcedInline),
    expansion = new Map<string, { size: number; depth: number }>();
  if (sourceStack) for (const id of sourceStack.addresses.keys()) inline.add(id);
  const visiting = new Set<string>();
  for (const id of assignments.keys()) {
    if (!live.has(id) || inline.has(id) || expansion.has(id)) continue;
    const work: { id: string; exit: boolean }[] = [{ id, exit: false }];
    while (work.length) {
      context.checkpoint(1);
      const item = work.pop()!,
        node = assignments.get(item.id);
      if (!node || expansion.has(item.id)) continue;
      const expression = expressions.get(item.id)!,
        row = uses.get(item.id);
      const eligible =
        expression.kind === 'constant' ||
        expression.kind === 'address' ||
        (expression.kind !== 'indeterminate' &&
          row?.count === 1 &&
          row.blocks.size === 1 &&
          row.blocks.has(owner.get(item.id)!));
      if (!eligible) {
        expansion.set(item.id, { size: 1, depth: 0 });
        continue;
      }
      if (!item.exit) {
        if (visiting.has(item.id)) {
          expansion.set(item.id, { size: 1, depth: 0 });
          continue;
        }
        visiting.add(item.id);
        work.push({ id: item.id, exit: true });
        for (const operand of expressionOperands(expression))
          if (assignments.has(operand.id) && !expansion.has(operand.id))
            work.push({ id: operand.id, exit: false });
        continue;
      }
      visiting.delete(item.id);
      let size = 1,
        depth = 1;
      for (const operand of expressionOperands(expression)) {
        context.checkpoint(1);
        const nested = expansion.get(operand.id);
        size += nested?.size ?? 1;
        depth = Math.max(depth, (nested?.depth ?? 0) + 1);
      }
      if (size <= 48 && depth <= 10) {
        inline.add(item.id);
        expansion.set(item.id, { size, depth });
      } else expansion.set(item.id, { size: 1, depth: 0 });
    }
  }
  for (const [id, node] of assignments)
    if (live.has(id) && !inline.has(id)) {
      retained.add(node.id);
      roots.set(node.id, [...expressionOperands(expressions.get(id)!)]);
    }
  sourcePlan?.materialize(live, inline);

  // Every original statement gets a real output owner, including dead annotated
  // subjects. Inline/folded dependencies follow their consumer; otherwise the
  // original block's control is the nearest surviving ordered anchor.
  const origins = new Map<string, Origin[]>(),
    mapped = new Set<string>();
  for (const block of blocks.values()) {
    for (const consumer of [
      ...block.statements.filter((node) => retained.has(node.id)),
      block.control,
    ]) {
      context.checkpoint(1);
      const list: Origin[] = [consumer];
      mapped.add(consumer.id);
      const stack = [...(roots.get(consumer.id) ?? [])],
        seen = new Set<string>();
      if (consumer.kind === 'assign') stack.push(...expressionOperands(consumer.expression));
      while (stack.length) {
        context.checkpoint(1);
        const value = stack.pop()!;
        if (seen.has(value.id)) continue;
        seen.add(value.id);
        const definition = assignments.get(value.id);
        if (!definition || retained.has(definition.id)) continue;
        if (!mapped.has(definition.id)) {
          list.push(definition);
          mapped.add(definition.id);
        }
        stack.push(...expressionOperands(definition.expression));
      }
      origins.set(consumer.id, list);
    }
  }
  for (const block of blocks.values())
    for (const node of block.statements)
      if (!mapped.has(node.id)) {
        context.checkpoint(1);
        origins.get(block.control.id)!.push(node);
        mapped.add(node.id);
      }

  const physicalParameters = (entry?.parameters ?? []).filter((value) => live.has(value.id));
  let signature = functionProjection?.kind === 'source' ? functionProjection.signature : null;
  if (
    signature &&
    physicalParameters.some(
      (value) => !functionProjection!.arguments.some((parameter) => parameter.id === value.id),
    )
  )
    signature = null;
  if (sourcePlan) signature = sourcePlan.signature;
  const entryStorage = sourceStack?.entryStorage;
  const entryStorageLive = entryStorage !== null && entryStorage !== undefined && live.has(entryStorage.id);
  if (entryStorageLive) signature = null;
  // A source return without a fully expressible function interface still retains
  // its proven result binding; physical outputs are never dropped by this choice.
  const parameters = sourcePlan
    ? sourcePlan.finalize(live)
    : signature
      ? functionProjection!.arguments
      : physicalParameters;
  const parameter_registers = new Map<string, RegisterDescriptor>();
  for (const binding of entryBindings) {
    context.checkpoint(1);
    parameter_registers.set(binding.value.id, binding.register);
  }
  if (sourcePlan)
    for (const [id, register] of sourcePlan.parameterRegisters)
      parameter_registers.set(id, register);
  const memory = new Map<string, MemoryView>(),
    ambiguous = new Set<string>();
  const conflicting = new Set(input.types?.conflicts.map((item) => item.subject_id) ?? []);
  if (input.types?.state === 'complete')
    for (const shape of input.types.shapes)
      for (const field of shape.fields) {
        context.checkpoint(1);
        if (conflicting.has(shape.id) || conflicting.has(shape.type_id) || conflicting.has(field.id) ||
          (shape.base.kind === 'value' && conflicting.has(shape.base.value_id))) continue;
        for (const id of field.node_ids) {
          context.checkpoint(1);
          if (ambiguous.has(id) || conflicting.has(id)) continue;
          if (memory.has(id)) {
            memory.delete(id);
            ambiguous.add(id);
            continue;
          }
          memory.set(id, { shape, field, scalar: false });
        }
      }
  for (const block of blocks.values())
    for (const node of block.statements) {
      const view = memory.get(node.id);
      if (!view) continue;
      context.checkpoint(1);
      if (
        (node.kind !== 'load' && node.kind !== 'store') ||
        view.field.width_bits !==
          bitWidth(node.kind === 'load' ? node.result.type : node.value.type)
      )
        memory.delete(node.id);
    }
  const diagnostics: Diagnostic[] = [];
  const unavailable = (origin: Origin, message: string): void => {
    context.checkpoint(1);
    diagnostics.push({
      code: 'unavailable_semantics',
      severity: 'warning',
      message,
      entity_id: origin.id,
      evidence_ids: origin.provenance.evidence_ids,
    });
  };
  for (const block of blocks.values()) {
    for (const node of block.statements) {
      context.checkpoint(1);
      if (node.kind === 'assign' && live.has(node.result.id)) {
        const expression = expressions.get(node.result.id)!;
        if (expression.kind === 'indeterminate' && expression.state === 'unknown')
          unavailable(node, 'An unknown machine value remains explicit.');
      } else if (node.kind === 'unknown_effect')
        unavailable(node, 'Unknown instruction effects remain ordered and explicit.');
      else if (node.kind === 'call' &&
        (calls.get(node.id)?.kind === 'physical' || calls.get(node.id)?.argument_list_complete === false))
        unavailable(
          node,
          sourcePlan
            ? 'The source call interface is unresolved; unknown call effects remain explicit.'
            : 'The source call interface is unresolved; physical arguments and effects remain explicit.',
        );
    }
    if (block.control.kind === 'unknown' || block.control.kind === 'indirect')
      unavailable(
        block.control,
        block.control.kind === 'indirect' && block.control.tail_call
          ? 'The tail-call target is preserved, but its source arguments, calling convention and result interface are unresolved.'
          : 'A control boundary remains unresolved; no target or trap is invented.',
      );
  }
  const source =
    sourcePlan && sourceStack
      ? {
          ...sourcePlan.presentation,
          inferred: sourcePlan.presentation.inferred || entryStorageLive,
          locals: sourceStack.locals,
          stack: sourceStack.frame(retained, live),
          stack_addresses: sourceStack.addresses,
        }
      : undefined;
  return {
    function: input.function,
    blocks,
    values,
    expressions,
    inline,
    live,
    retained,
    transfers,
    origins,
    parameters,
    parameter_registers,
    signature,
    calls,
    returns,
    physical_inputs,
    physical_exits,
    memory,
    diagnostics,
    ...(source ? { source: { ...source,
      ...projectSourceTypes(input.types, source, values, expressions, returns, memory,
        input.source!.abi.layout, context),
    } } : {}),
  };
}
