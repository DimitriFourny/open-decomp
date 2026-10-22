import {
  OperationError,
  type Diagnostic,
  type OperationContext,
  type PresentationView,
  type RegisterDescriptor,
} from '../core/index.js';
import type { EmissionInput } from '../emitters/model.js';
import {
  expressionOperands,
  type Instruction,
  type Origin,
  type RegisterBinding,
  type Value,
  bitWidth,
} from '../ir/index.js';
import type { BlockRegion, Control, ParallelTransfer, Region } from '../presentation/index.js';
import { boundaryProjector } from './boundaries.js';
import { foldExpressions, identityOperand } from './expressions.js';
import type {
  Assignment,
  BoundaryProjection,
  ExitScratchSlice,
  MemoryView,
  Reconstruction,
  TailProjection,
} from './model.js';
import { planSource } from './source-planner.js';
import { planSourceStack } from './source-stack.js';
import { planVariadicStackArguments } from './source-variadic.js';
import { projectSourceConstants } from './source-data.js';
import { recombineSourceCells } from './source-cells.js';
import {
  normalizeSourceExpressions,
  sourceExpressionDemand,
  type SourceExpressionDemand,
} from './source-expressions.js';
import { normalizeSourceRanges } from './source-ranges.js';
import { constantRotationOperands } from './source-shifts.js';
import { projectLikelyTypes } from './source-likely.js';
import { projectSourceTypes } from './source-types.js';
import {
  permitsVoidSourceSignature,
  projectSourceFloating,
  projectSourceSignature,
} from './source-signature.js';
import { LocalValidationSession } from './local-validation.js';
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
 * snapshots and conservative source projections. No CFG is structured twice.
 * The `source` view additionally applies proof-carrying presentation rewrites
 * (frame save elision, ABI-scratch exit slices); `checked` applies none.
 * Source view (S9): a declared signature with stack, variadic or hidden-result
 * parameters is planned first; when the stack plan does not confirm every
 * declared part, the function is reconstructed again without them. */
export function reconstruct(
  input: EmissionInput,
  context: OperationContext,
  view: PresentationView = 'checked',
): Reconstruction {
  return (
    (view === 'source' ? reconstructView(input, context, view, true) : null) ??
    reconstructView(input, context, view, false)!
  );
}

/** Null only when `extended` declared parts were planned but not confirmed. */
function reconstructView(
  input: EmissionInput,
  context: OperationContext,
  view: PresentationView,
  extended: boolean,
): Reconstruction | null {
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
  const localValidation = new LocalValidationSession(context, view === 'source', input.function.id);
  const constantLoads =
    view === 'source' && input.source
      ? projectSourceConstants(
          blocks,
          expressions,
          assignments,
          input.source.addresses,
          context,
          localValidation,
        )
      : new Set<string>();
  const sourcePlan = input.source
    ? planSource(
        input,
        blocks,
        values,
        expressions,
        owner,
        context,
        view,
        localValidation,
        extended,
      )
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
        sourcePlan.make,
        context,
        sourcePlan.incomingStack,
        sourcePlan.entryStack,
        sourcePlan.incomingObject,
        localValidation,
        view,
        sourcePlan.presentation.requirements,
        sourcePlan.variadic,
      )
    : null;
  // S9: a declared `...` needs the `va_start` footprint it names.
  const declaredExtension = sourcePlan?.declaredExtension ?? null;
  if (declaredExtension && (declaredExtension.variadic !== null) !== Boolean(sourceStack?.variadic))
    return null;
  // Source view: indirect exits proven to be tail calls become target-value tails.
  if (sourcePlan && sourceStack?.indirectTails.size)
    for (const block of blocks.values()) {
      if (!sourceStack.indirectTails.has(block.control.id)) continue;
      const tail = sourcePlan.indirectTail(block);
      if (tail) sourcePlan.tails.set(block.control.id, tail);
    }
  const cellTransfers =
    sourcePlan && view === 'source'
      ? recombineSourceCells(
          blocks,
          allTransfers,
          expressions,
          parameterSources,
          sourcePlan,
          localValidation,
          context,
        )
      : new Map<ParallelTransfer, ParallelTransfer['copies']>();
  if (sourcePlan)
    for (const [id, tail] of sourcePlan.tails)
      if (
        tail.boundary.argument_list_complete &&
        !localValidation.presentation(
          'arity_closure',
          id,
          'complete tail-call argument list: complete native reads or an established library contract prove the observed register-only interface, with no incoming stack or escaping incoming-stack address',
          [id],
        )
      )
        sourcePlan.tails.set(id, {
          ...tail,
          boundary: { ...tail.boundary, argument_list_complete: false },
        });
  if (sourcePlan && view === 'source')
    for (const callee of input.source?.source_callees ?? [])
      if (
        (callee.argument_list_closure === 'library_contract' ||
          callee.argument_list_closure === 'objc_selector') &&
        sourcePlan.tails.get(callee.call_id)?.boundary.argument_list_complete
      )
        localValidation.requireAbi(
          'arity_closure',
          [callee.call_id],
          callee.argument_list_closure === 'objc_selector'
            ? 'Objective-C selector tail closure assumes the receiver implements a non-variadic method for the selector with its image type-encoding argument classes; unresolved selectors retain their physical interface.'
            : 'Library-tail closure and its native propagation assume the established imported contract and ABI-conforming register arguments and results; unresolved or variadic targets retain their physical interface.',
        );
  // Source view only: Darwin variadic outgoing stores become trailing arguments
  // of the one call that consumes them (store id -> call id).
  const variadicStores =
    sourcePlan && sourceStack && view === 'source'
      ? planVariadicStackArguments(
          input,
          blocks,
          sourcePlan.calls,
          (id) =>
            sourceStack.hidden.has(id) ||
            sourceStack.locals.has(id) ||
            sourceStack.saves.stores.has(id),
          localValidation,
          context,
        )
      : new Map<string, string>();
  let normalizationDemand: SourceExpressionDemand | undefined;
  if (sourcePlan) {
    // These roots deliberately overapproximate the liveness roots below, before
    // identities/snapshots are reduced. No effect or original definition is
    // removed: only source-undemanded pure normalization/aliasing is avoided.
    const roots: Value[] = [...sourcePlan.parameters];
    let complete = true;
    const boundaryRoots = (boundary: BoundaryProjection): void => {
      roots.push(...boundary.arguments, ...boundary.results);
      for (const binding of boundary.inputs) roots.push(binding.value);
      for (const binding of boundary.outputs) roots.push(binding.value);
    };
    if (sourceStack?.entryStorage) roots.push(sourceStack.entryStorage);
    if (sourceStack?.incomingFormal) roots.push(sourceStack.incomingFormal);
    for (const block of blocks.values()) {
      for (const node of block.statements) {
        context.checkpoint(1);
        switch (node.kind) {
          case 'assign':
            break;
          case 'read_register':
            roots.push(node.result);
            break;
          case 'write_register':
            roots.push(node.value);
            break;
          case 'load':
            // Include even promoted/hidden loads: storage planning is fixed,
            // but normalization must not assume an unused read has no effect.
            roots.push(node.address, node.result);
            break;
          case 'store':
            roots.push(node.address, node.value);
            break;
          case 'call': {
            const boundary = sourcePlan.calls.get(node.id);
            if (boundary) boundaryRoots(boundary);
            else complete = false;
            roots.push(...node.arguments, ...node.results);
            if (node.target.kind === 'indirect') roots.push(node.target.value);
            break;
          }
          case 'unknown_effect':
            for (const binding of node.register_inputs) roots.push(binding.value);
            for (const binding of node.register_outputs) roots.push(binding.value);
            break;
          case 'memory_fence':
            break;
          default:
            complete = false;
        }
      }
      const control = block.control;
      context.checkpoint(1);
      switch (control.kind) {
        case 'jump':
          break;
        case 'if':
          roots.push(control.condition);
          break;
        case 'switch':
          roots.push(control.value);
          break;
        case 'return': {
          const boundary = sourcePlan.returns.get(control.id);
          if (boundary) boundaryRoots(boundary);
          else complete = false;
          roots.push(...control.values);
          break;
        }
        case 'indirect':
          roots.push(control.target);
          // Do not predict the eventual identity-reduced exit snapshot.
          for (const binding of block.register_exit) roots.push(binding.value);
          break;
        case 'unknown':
        case 'trap':
          for (const binding of block.register_exit) roots.push(binding.value);
          break;
        default:
          complete = false;
      }
      const tail = sourcePlan.tails.get(control.id);
      if (tail) boundaryRoots(tail.boundary);
    }
    // Missing/unrecognized consumers conservatively retain full normalization.
    if (complete)
      normalizationDemand = sourceExpressionDemand(roots, expressions, parameterSources, context);
  }
  const sourceExpressions = sourcePlan
    ? normalizeSourceExpressions(
        values,
        expressions,
        owner,
        sourcePlan.make,
        context,
        localValidation,
        normalizationDemand,
        view === 'source',
      )
    : null;

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
      if (normalizationDemand && !normalizationDemand.values.has(id)) continue;
      if (identity && id !== identity && values.has(identity)) {
        const value = values.get(id)!,
          previous = expressions.get(id),
          unchanged = previous && identityOperand(value.type, previous)?.id === identity;
        sourcePlan.alias(value, {
          kind: 'cast',
          op: 'bitcast',
          value: values.get(identity)!,
        });
        // alias() also marks forced-inline source views. Replacing an already
        // identical bitcast changes that presentation flag, not normalization.
        if (!unchanged) sourceExpressions!.changed(id);
      }
    }
  sourceExpressions?.run();
  const initial = new Map(
    entryBindings.map((binding) => [
      binding.register.id,
      identities.get(binding.value.id) ?? binding.value.id,
    ]),
  );
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
  const tails = sourcePlan?.tails ?? new Map<string, TailProjection>();
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
        sourcePlan && (!(control.kind === 'indirect' && control.tail_call) || tails.has(control.id))
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
  // Source-only exit overlays are not result claims. Unprojected call clobbers
  // and untouched entry values are ABI scratch; locally computed slices may
  // also move out of line under an explicit, evidence-gated ABI assumption.
  if (sourcePlan && view === 'source') {
    const evidence = input.source!;
    const resultType = returns.values().next().value?.results[0]?.type;
    const primary = evidence.abi.classifyCall({
      returns:
        resultType?.kind === 'float'
          ? resultType
          : resultType?.kind === 'vector'
            ? {
                kind: 'vector',
                element: resultType.element.kind,
                element_bits: bitWidth(resultType.element),
                lanes: resultType.lanes,
              }
            : { kind: 'pointer' },
      parameters: [],
      variadic: false,
      fixed_parameter_count: 0,
    }).returns;
    const primaryRegisters = primary.flatMap((location) =>
      location.kind === 'register'
        ? [{ ...location.register, width_bits: location.width_bits }]
        : [],
    );
    // A primary-result rejection retracts native written-result storage as evidence.
    const observedReturns = sourcePlan.presentation.observed_result_rejected
      ? undefined
      : evidence.function_returns;
    const resultEvidence = [
      ...(evidence.function_return_demands ?? []),
      ...(observedReturns?.registers ?? []),
    ];
    const declaredContract = input.types?.signatures.some(
      (signature) => signature.subject_id === input.function.id,
    );
    const overlaps = (a: RegisterDescriptor, b: RegisterDescriptor): boolean =>
      a.root === b.root &&
      a.offset_bits < b.offset_bits + b.width_bits &&
      b.offset_bits < a.offset_bits + a.width_bits;
    // A single established integer/FP/vector primary permits an ABI-scratch
    // interpretation outside its classified storage, never an invented tuple.
    const establishedPrimary =
      primaryRegisters.length === 1 &&
      [...returns.values()].every(
        (projection) =>
          projection.results.length === 1 &&
          projection.results[0]!.type.kind === resultType?.kind &&
          bitWidth(projection.results[0]!.type) <= primaryRegisters[0]!.width_bits,
      ) &&
      resultEvidence.every(
        (register) =>
          register.root === primaryRegisters[0]!.root &&
          register.offset_bits >= primaryRegisters[0]!.offset_bits &&
          register.offset_bits + register.width_bits <=
            primaryRegisters[0]!.offset_bits + primaryRegisters[0]!.width_bits,
      ) &&
      (observedReturns?.types ?? []).every(
        (type) =>
          type.kind === resultType?.kind && bitWidth(type) <= primaryRegisters[0]!.width_bits,
      );
    const clobbers = new Map<string, string>(),
      resultCells = new Set<string>();
    for (const block of blocks.values())
      for (const node of block.statements) {
        context.checkpoint(1);
        if (node.kind !== 'call') continue;
        for (const binding of node.register_outputs) clobbers.set(binding.value.id, node.id);
        for (const value of calls.get(node.id)?.results ?? []) {
          resultCells.add(value.id);
          for (const origin of sourcePlan.presentation.value_origins?.get(value.id) ?? [])
            resultCells.add(origin);
        }
      }
    const entryRoots = new Map(
      entryBindings.map((binding) => [binding.value.id, binding.register]),
    );
    // Sources of one exit slice, or null when any path computes it here.
    const scratch = (
      root: string,
      start: Value,
    ): { readonly sources: Set<string>; entry: boolean } | null => {
      const result = { sources: new Set<string>(), entry: false };
      const pending = [start],
        seen = new Set<string>();
      while (pending.length) {
        context.checkpoint(1);
        const value = pending.pop()!;
        if (seen.has(value.id)) continue;
        seen.add(value.id);
        if (seen.size > 4096) return null;
        const register = entryRoots.get(value.id);
        if (register) {
          if (register.root !== root) return null;
          result.entry = true;
          continue;
        }
        const call = clobbers.get(value.id);
        if (call !== undefined) {
          if (resultCells.has(value.id)) return null;
          result.sources.add(call);
          continue;
        }
        const expression = expressions.get(value.id);
        if (expression) {
          if (
            (expression.kind === 'cast' &&
              expression.op === 'bitcast' &&
              bitWidth(expression.value.type) === bitWidth(value.type)) ||
            expression.kind === 'extract'
          )
            pending.push(expression.value);
          else if (expression.kind === 'concat') pending.push(...expression.values);
          else return null;
          continue;
        }
        const sources = parameterSources.get(value.id);
        if (!sources?.length) return null;
        pending.push(...sources);
      }
      return result;
    };
    const voidPrimaryRegisters = [
      ...primaryRegisters,
      ...evidence.abi
        .classifyCall({
          returns: { kind: 'float', bits: 64 },
          parameters: [],
          variadic: false,
          fixed_parameter_count: 0,
        })
        .returns.flatMap((location) =>
          location.kind === 'register'
            ? [{ ...location.register, width_bits: location.width_bits }]
            : [],
        ),
    ];
    // Missing FP typing is not evidence for void: even an integer-typed write
    // to the low FP carrier must remain explicit until its result is resolved.
    // A `void_like_result` rule makes every primary slice scratch of the
    // void-like interface: `incidental_result` established the integer primary
    // on no exit path and found the FP carrier unchanged or undefined on every
    // exit; under `indirect_result` the aggregate returns through memory.
    const voidLike = sourcePlan.presentation.void_like_result;
    // A tail into a known callee may forward its result; the runtime target of
    // an indirect tail is no result evidence, like the unresolved exit it was.
    const voidPrimary =
      permitsVoidSourceSignature(
        input,
        sourcePlan.presentation,
        returns,
        [...tails.values()].some((tail) => tail.target !== null),
      ) &&
      [...returns.values()].every((projection) =>
        projection.outputs.every(
          (binding) =>
            voidLike !== undefined ||
            !voidPrimaryRegisters.some((register) => overlaps(register, binding.register)) ||
            scratch(binding.register.root, binding.value) !== null,
        ),
      );
    for (const [id, projection] of returns) {
      if (projection.kind !== 'inferred' || !projection.outputs.length || declaredContract)
        continue;
      const outputs: BoundaryProjection['outputs'][number][] = [],
        exitScratch: ExitScratchSlice[] = [];
      for (const binding of projection.outputs) {
        if (resultEvidence.some((register) => overlaps(register, binding.register))) {
          outputs.push(binding);
          continue;
        }
        const found = scratch(binding.register.root, binding.value);
        if (found)
          exitScratch.push({
            register: binding.register,
            value: binding.value,
            sources: [...found.sources],
            entry: found.entry,
          });
        else if (
          voidPrimary ||
          (establishedPrimary &&
            (!primaryRegisters.some((register) => overlaps(register, binding.register)) ||
              (resultType?.kind === 'integer' &&
                primaryRegisters.some(
                  (register) =>
                    register.root === binding.register.root &&
                    binding.register.offset_bits >= register.offset_bits + bitWidth(resultType) &&
                    binding.register.offset_bits + binding.register.width_bits <=
                      register.offset_bits + register.width_bits,
                ))))
        )
          exitScratch.push({
            register: binding.register,
            value: binding.value,
            sources: [binding.value.id],
            entry: false,
            computed: true,
          });
        else outputs.push(binding);
      }
      if (
        !exitScratch.length ||
        !localValidation.presentation(
          'exit_scratch',
          id,
          'possible-return slices not established as results; unprojected call clobbers/entry values, undemanded slices outside an established primary or above its narrow integer width, or a signature-approved void-like exit without result evidence; not liveness roots',
          [id, ...new Set(exitScratch.flatMap((slice) => slice.sources))].slice(0, 64),
          exitScratch
            .map(
              ({ register, value, sources, entry, computed }) =>
                `${register.root}[${register.offset_bits}:${register.width_bits}] = ${value.id} <- ${[...sources.slice(0, 2), ...(sources.length > 2 ? [`and ${sources.length - 2} more recorded sources`] : []), ...(entry ? ['entry'] : [])].join(', ')}${computed ? '; no result-use evidence gathered; callers not scanned' : ''}`,
            )
            .join('; '),
        )
      )
        continue;
      localValidation.requireAbi(
        'exit_scratch',
        [id],
        `Moving these exit slices out of line assumes ABI conformance: ${voidPrimary ? `the signature layer agrees to a void-like interface with no ${voidLike ? `primary result (${voidLike})` : 'written primary'} or positive result-use evidence, and callers consume no result` : 'callers read only the established return storage, and other caller-saved slices hold no additional result'}. No result-use evidence gathered for the moved slices; callers not scanned. Exact slice values and sources remain in the exit metadata and checked view; this is not proof of non-consumption.`,
      );
      returns.set(id, { ...projection, outputs, exit_scratch: exitScratch });
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
  const semanticRoots: Value[] = [],
    overlayOutputs: Value[] = [];
  const deferredReloads: {
    node: Extract<Instruction, { kind: 'load' }>;
    block: string;
    table: boolean;
  }[] = [];
  // Source view: reads of proven jump-table bytes in their switch block are in
  // bounds under the dominating guard, immutable and relocation-free.
  const tableLoads = new Set<string>();
  if (view === 'source')
    for (const block of blocks.values()) {
      const control = block.control;
      if (control.kind !== 'switch' || !control.jump_table) continue;
      for (const node of block.statements)
        if (
          node.kind === 'load' &&
          node.provenance.instruction_ids.includes(control.jump_table.load_instruction)
        )
          tableLoads.add(node.id);
    }
  for (const block of blocks.values()) {
    for (const node of block.statements) {
      context.checkpoint(1);
      if (
        node.kind === 'assign' ||
        constantLoads.has(node.id) ||
        sourceStack?.hidden.has(node.id) ||
        variadicStores.has(node.id) ||
        (node.kind === 'load' && sourceStack?.returnAddressLoads.has(node.result.id))
      )
        continue;
      if (node.kind === 'load' && sourceStack?.deadReloadCandidates.has(node.id)) {
        deferredReloads.push({ node, block: block.id, table: false });
        continue;
      }
      if (node.kind === 'load' && tableLoads.has(node.id)) {
        deferredReloads.push({ node, block: block.id, table: true });
        continue;
      }
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
      semanticRoots.push(...operands);
    }
    const control = block.control,
      operands: Value[] = [];
    // Source view (S7): the dropped `al` guard of a SysV va_start prints nothing.
    if (control.kind === 'if') {
      const variadic = sourceStack?.variadic;
      if (variadic?.kind !== 'va_list' || variadic.guard !== control.id)
        operands.push(control.condition);
    } else if (control.kind === 'switch') operands.push(control.value);
    else if (control.kind === 'indirect') operands.push(control.target);
    const tail = tails.get(control.id);
    if (tail) operands.push(...tail.boundary.arguments);
    let overlay: Value[] = [];
    if (control.kind === 'return') {
      const projection = returns.get(control.id)!;
      operands.push(...projection.results);
      overlay = projection.outputs.map((binding) => binding.value);
      if (!sourcePlan || projection.kind !== 'inferred') semanticRoots.push(...overlay);
      else overlayOutputs.push(...overlay);
      operands.push(...overlay);
    } else operands.push(...(physical_exits.get(control.id) ?? []).map((binding) => binding.value));
    roots.set(control.id, operands);
    for (const value of operands) use(value, block.id);
    semanticRoots.push(...operands.slice(0, operands.length - overlay.length));
  }
  // Incoming phi sources are demanded only when their destination is live.
  const incomingUses = new Map<string, { source: Value; block: string }[]>();
  for (const { transfer, block } of allTransfers)
    for (const copy of cellTransfers.get(transfer) ?? transfer.copies) {
      context.checkpoint(1);
      const list = incomingUses.get(copy.destination.id) ?? [];
      list.push({ source: copy.source, block: block.id });
      incomingUses.set(copy.destination.id, list);
    }
  let liveCursor = 0;
  const propagate = (): void => {
    for (; liveCursor < liveQueue.length; liveCursor++) {
      context.checkpoint(1);
      const value = liveQueue[liveCursor]!,
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
        if (sourceStack.incomingFormal && sourceStack.requiresIncoming(value.id))
          use(sourceStack.incomingFormal, owner.get(value.id)!);
        continue;
      }
      if (expression)
        for (const operand of expressionOperands(expression)) use(operand, owner.get(value.id)!);
      if (!sourcePlan || !expression || !identityOperand(value.type, expression))
        for (const incoming of incomingUses.get(value.id) ?? [])
          use(incoming.source, incoming.block);
    }
  };
  propagate();
  // Source view: a dead non-volatile frame load dominated by a store covering
  // its bytes cannot fault, so it is dropped; a live one is retained as usual.
  if (deferredReloads.length) {
    const restore = ({ node, block }: (typeof deferredReloads)[number]): void => {
      retained.add(node.id);
      const operands = sourceStack?.locals.has(node.id) ? [] : [node.address];
      roots.set(node.id, operands);
      for (const value of operands) use(value, block);
      semanticRoots.push(...operands);
    };
    let pending = deferredReloads;
    for (let changed = true; changed;) {
      context.checkpoint(pending.length);
      const live_ = pending.filter((item) => live.has(item.node.result.id));
      changed = live_.length > 0;
      live_.forEach(restore);
      pending = pending.filter(
        (item) => !live.has(item.node.result.id) && !retained.has(item.node.id),
      );
      propagate();
    }
    const frame = pending.filter((item) => !item.table),
      table = pending.filter((item) => item.table);
    if (
      frame.length &&
      !localValidation.presentation(
        'dead_frame_reload',
        input.function.id,
        'dead non-volatile frame loads, each dominated by a store covering its bytes (so it cannot fault), are not printed',
        frame.map((item) => item.node.id).slice(0, 64),
      )
    ) {
      frame.forEach(restore);
      propagate();
    }
    if (
      table.length &&
      !localValidation.presentation(
        'dead_jump_table_load',
        input.function.id,
        'dead reads of a proven jump table in its switch block: the dominating unsigned guard bounds the index, so every read addresses immutable, file-backed, relocation-free table bytes, cannot fault and observes only constants; they are not printed',
        table.map((item) => item.node.id).slice(0, 64),
      )
    ) {
      table.forEach(restore);
      propagate();
    }
  }
  // An uncertain return overlay preserves machine state; reaching an ABI input
  // register only through it is not evidence that the register is a source input.
  if (sourcePlan && overlayOutputs.length) {
    const demanded = new Set<string>(),
      pending: Value[] = [];
    const reach = (value: Value): void => {
      context.checkpoint(1);
      if (demanded.has(value.id)) return;
      demanded.add(value.id);
      pending.push(value);
    };
    semanticRoots.forEach(reach);
    for (let cursor = 0; cursor < pending.length; cursor++) {
      context.checkpoint(1);
      const value = pending[cursor]!,
        expression = expressions.get(value.id);
      const returnAddress = sourceStack?.returnAddressLoads.get(value.id);
      if (returnAddress) reach(returnAddress.node.address);
      if (sourceStack?.addresses.has(value.id)) {
        if (sourceStack.entryStorage && sourceStack.requiresEntry(value.id))
          reach(sourceStack.entryStorage);
        if (sourceStack.incomingFormal && sourceStack.requiresIncoming(value.id))
          reach(sourceStack.incomingFormal);
        continue;
      }
      if (expression) for (const operand of expressionOperands(expression)) reach(operand);
      if (!expression || !identityOperand(value.type, expression))
        for (const incoming of incomingUses.get(value.id) ?? []) reach(incoming.source);
    }
    sourcePlan.demoteOverlayInputs(live, demanded);
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
    const copies = (cellTransfers.get(transfer) ?? transfer.copies).filter((copy) => {
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
  // Source view: a constant rotation of a variable prints as two shifts that
  // read it twice, so its operand is a variable, never an inlined expression.
  const rotated = sourcePlan ? constantRotationOperands(expressions) : new Set<string>();
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
          !rotated.has(item.id) &&
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
        // A consumed variadic store is printed as its call's trailing argument.
        origins.get(variadicStores.get(node.id) ?? block.control.id)!.push(node);
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
  const entryStorageLive =
    entryStorage !== null && entryStorage !== undefined && live.has(entryStorage.id);
  // A declared `...` (S9) keeps its signature beside the `va` area that stands
  // in for the entry SP; any other live entry-SP form still drops it.
  const declaredArea =
    declaredExtension !== null &&
    sourceStack?.variadic?.kind === 'area' &&
    sourceStack.variadic.area.id === entryStorage?.id;
  const entrySpLive = entryStorageLive && !declaredArea;
  if (entrySpLive) signature = null;
  // S9: every declared part is confirmed once no incoming byte still needs
  // the entry SP: each declared stack slot read is its formal (S1) or the
  // declared aggregate's object (S4), the `va_start` footprint matched the
  // declared named formals (S6/S7), and the hidden result bound its register.
  if (
    declaredExtension &&
    (entrySpLive ||
      !localValidation.presentation(
        'declared_signature',
        input.function.id,
        'declared signature with stack, variadic or hidden-result parameters: every register parameter and the hidden-result pointer bind their ABI registers at entry and every result its ABI register at every exit; every read of a declared stack slot is that formal (incoming_formal) or the declared aggregate (incoming_object); a declared ... has exactly the va_start footprint of its named formals (va_start); no incoming byte is addressed through the entry SP',
        [
          input.function.id,
          ...(declaredExtension.hidden ? [declaredExtension.hidden.id] : []),
          ...[...declaredExtension.stack.values()].map((value) => value.id),
          ...(declaredExtension.aggregate ? [declaredExtension.aggregate.value.id] : []),
        ].slice(0, 64),
      ))
  )
    return null;
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
        if (
          conflicting.has(shape.id) ||
          conflicting.has(shape.type_id) ||
          conflicting.has(field.id) ||
          (shape.base.kind === 'value' && conflicting.has(shape.base.value_id))
        )
          continue;
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
  const unavailable = (origin: Origin, message: string, details?: Diagnostic['details']): void => {
    context.checkpoint(1);
    diagnostics.push({
      code: 'unavailable_semantics',
      severity: 'warning',
      message,
      entity_id: origin.id,
      evidence_ids: origin.provenance.evidence_ids,
      ...(details === undefined ? {} : { details }),
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
      else if (
        node.kind === 'call' &&
        (calls.get(node.id)?.kind === 'physical' ||
          calls.get(node.id)?.argument_list_complete === false)
      )
        unavailable(
          node,
          sourcePlan
            ? 'The source call interface is unresolved; unknown call effects remain explicit.'
            : 'The source call interface is unresolved; physical arguments and effects remain explicit.',
          { kind: 'call_interface' },
        );
    }
    if (sourcePlan && block.control.kind === 'return') {
      const projection = returns.get(block.control.id);
      const storage = [...(projection?.outputs ?? []), ...(projection?.exit_scratch ?? [])].map(
        ({ register }) => `${register.root}[${register.offset_bits}:${register.width_bits}]`,
      );
      if (projection?.kind === 'inferred' && storage.length)
        unavailable(
          block.control,
          'The source return list is unresolved; changed possible ABI return storage is preserved as an uncertain physical overlay, not inferred aggregate fields: ' +
            storage.join(', '),
          { kind: 'return_storage', storage },
        );
    }
    if (block.control.kind === 'unknown' || block.control.kind === 'indirect')
      unavailable(
        block.control,
        block.control.kind === 'indirect' && block.control.tail_call
          ? tails.has(block.control.id)
            ? 'The observed native tail-call prefix and result storage are retained; trailing source arity and unknown effects remain explicit.'
            : 'The tail-call target is preserved, but its source arguments, calling convention and result interface are unresolved.'
          : tails.get(block.control.id)?.target === null
            ? 'The indirect branch is a tail call of its runtime target; the observed argument prefix is retained, and the target, its trailing source arity, results and effects remain unresolved.'
            : 'A control boundary remains unresolved; no target or trap is invented.',
      );
  }
  const source =
    sourcePlan && sourceStack
      ? {
          ...sourcePlan.presentation,
          inferred: sourcePlan.presentation.inferred || entrySpLive,
          locals: sourceStack.locals,
          stack: sourceStack.frame(retained, live),
          ...(view === 'source'
            ? { incoming_object: sourceStack.incomingStorage(retained, live) }
            : {}),
          stack_addresses: sourceStack.addresses,
          forwarded_reloads: sourceStack.forwardedReloads,
          ...(view === 'source' ? { frame_saves: sourceStack.saves } : {}),
          ...(sourceStack.variadic ? { variadic: sourceStack.variadic } : {}),
        }
      : undefined;
  const program: Reconstruction = {
    function: input.function,
    view,
    blocks,
    values,
    expressions,
    inline,
    live,
    use_counts: new Map([...uses].map(([id, row]) => [id, row.count])),
    retained,
    transfers,
    origins,
    parameters,
    parameter_registers,
    signature,
    calls,
    returns,
    tails,
    physical_inputs,
    physical_exits,
    memory,
    local_validation: localValidation.records,
    local_validation_session: localValidation,
    diagnostics,
    ...(source
      ? {
          source: {
            ...source,
            ...projectSourceTypes(
              input.types,
              source,
              values,
              expressions,
              returns,
              memory,
              input.source!.abi.layout,
              context,
            ),
          },
        }
      : {}),
  };
  if (!program.source || view !== 'source') return program;
  // FP memory accesses decide formal pointee kinds, so they project first.
  const floating = projectSourceFloating(program, input, context);
  const { returns: signatureReturns, ...signatureTypes } = projectSourceSignature(
    program,
    input,
    context,
    floating.float_accesses,
  );
  const typed: Reconstruction = {
    ...program,
    returns: signatureReturns ?? program.returns,
    source: {
      ...program.source,
      ...signatureTypes,
      ...floating,
    },
  };
  // Likely mode only; fills formals and a result that every proven rule left integer.
  const likely = projectLikelyTypes(typed, input, context);
  return likely ? { ...typed, source: { ...typed.source!, ...likely } } : typed;
}
