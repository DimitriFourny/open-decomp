import { OperationError, type OperationContext } from '../core/index.js';
import { bitWidth, expressionOperands, type Origin, type Value } from '../ir/index.js';
import type {
  ControlArm,
  ParallelTransfer,
  Region,
  StructuredFunction,
} from '../presentation/index.js';
import type { Reconstruction } from './model.js';
import { stackEntry } from './source-model.js';
import { validateEmittedUses } from './validate-uses.js';
import {
  crossSilently,
  jumpBlocks,
  type EmittedEdge,
  type EmittedLoopExits,
} from './local-control-validation.js';

function invalid(origin: Origin, message: string): never {
  throw new OperationError({
    code: 'unavailable_semantics',
    severity: 'error',
    message: `Reconstruction invariant failed: ${message}`,
    entity_id: origin.id,
    ...(origin.provenance.ranges[0] ? { address: origin.provenance.ranges[0].start } : {}),
    evidence_ids: origin.provenance.evidence_ids,
  });
}

function transfers(program: Reconstruction, id: string): readonly ParallelTransfer[] {
  const control = program.blocks.get(id)!.control;
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

/** A recombined whole register parameter that the edge carries unchanged: the target's
 * parameters aliased to its slices cover every bit, and the original edge copies each of
 * them to itself (the whole's own identity copy is not printed). */
function carriedWhole(
  program: Reconstruction,
  parameters: readonly Value[],
  transfer: ParallelTransfer,
  whole: Value,
  context: OperationContext,
): boolean {
  let covered = 0n;
  for (const cell of parameters) {
    context.checkpoint(1);
    const expression = program.expressions.get(cell.id);
    if (expression?.kind !== 'extract' || expression.value.id !== whole.id) continue;
    if (transfer.copies.find((copy) => copy.destination.id === cell.id)?.source.id !== cell.id)
      return false;
    covered |= ((1n << BigInt(bitWidth(cell.type))) - 1n) << BigInt(expression.offset);
  }
  return covered === (1n << BigInt(bitWidth(whole.type))) - 1n;
}

/** Check the published projection, not merely the verified input SSA. Unknown
 * values are legitimate expressions; missing definitions and result bits are not. */
export function validateReconstruction(program: Reconstruction, context: OperationContext): void {
  const reachable = new Set<string>();
  const pending = [program.function.entry];
  while (pending.length) {
    context.checkpoint(1);
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    if (!program.blocks.has(id))
      invalid(program.function, 'a reachable CFG target has no owned block');
    reachable.add(id);
    for (const transfer of transfers(program, id)) pending.push(transfer.target);
  }
  const definitions = new Set(program.parameters.map((value) => value.id));
  const coverage = new Map(program.function.coverage.map((item) => [item.block_id, item]));
  const checkValue = (value: Value): void => {
    context.checkpoint(1);
    const known = program.values.get(value.id);
    if (!known || bitWidth(known.type) !== bitWidth(value.type))
      invalid(program.function, 'a projected use has no compatible value definition');
  };
  const storage = program.source?.stack;
  for (const id of reachable) {
    const block = program.blocks.get(id)!;
    const row = coverage.get(id);
    if (
      !row ||
      row.terminator_id !== block.control.id ||
      row.statement_ids.length !== block.statements.length
    )
      invalid(block, 'reachable structured ownership disagrees with source CFG coverage');
    const statements = new Set(block.statements.map((node) => node.id));
    for (const statement of row.statement_ids) {
      context.checkpoint(1);
      if (!statements.has(statement)) invalid(block, 'a reachable source statement lost its owner');
    }
    for (const parameter of block.parameters) definitions.add(parameter.id);
    for (const node of block.statements) {
      context.checkpoint(1);
      if (
        (storage?.kind === 'private' || storage?.kind === 'object') &&
        program.retained.has(node.id) &&
        (node.kind === 'load' || node.kind === 'store')
      ) {
        const offset = program.source!.stack_addresses.get(node.address.id);
        const bytes = BigInt(
          Math.ceil(bitWidth(node.kind === 'load' ? node.result.type : node.value.type) / 8),
        );
        // Beside a frame object, bytes at or above the live entry SP stay
        // entry-SP memory; no access spans the entry SP.
        if (
          offset !== undefined &&
          offset + bytes > 0n &&
          (storage.kind !== 'object' || !storage.entry || offset < 0n)
        )
          invalid(
            node,
            'callee-entry incoming bytes were projected as newly allocated private storage',
          );
        if (
          storage.kind === 'object' &&
          offset !== undefined &&
          offset < storage.minimum_offset &&
          !program.source!.locals.has(node.id)
        )
          invalid(node, 'a frame access lies below its frame object');
      }
      if (program.retained.has(node.id)) {
        if ('result' in node) definitions.add(node.result.id);
        if (node.kind === 'call') {
          for (const result of program.calls.get(node.id)?.results ?? node.results)
            definitions.add(result.id);
        }
        if ('register_outputs' in node)
          for (const binding of node.register_outputs) definitions.add(binding.value.id);
      }
      for (const definition of program.source?.definitions?.get(node.id) ?? [])
        definitions.add(definition.result.id);
    }
    for (const definition of program.source?.definitions?.get(block.control.id) ?? [])
      definitions.add(definition.result.id);
    for (const transfer of transfers(program, id)) {
      const target = program.blocks.get(transfer.target)!;
      const destinations = new Set<string>();
      for (const copy of program.transfers.get(transfer) ?? []) {
        context.checkpoint(1);
        if (
          destinations.has(copy.destination.id) ||
          program.inline.has(copy.destination.id) ||
          !target.parameters.some((parameter) => parameter.id === copy.destination.id) ||
          bitWidth(copy.destination.type) !== bitWidth(copy.source.type)
        )
          invalid(block.control, 'a parallel edge copy has an invalid destination or width');
        destinations.add(copy.destination.id);
        checkValue(copy.source);
      }
      for (const parameter of target.parameters) {
        context.checkpoint(1);
        if (!program.live.has(parameter.id) || program.inline.has(parameter.id)) continue;
        const original = transfer.copies.find((copy) => copy.destination.id === parameter.id);
        if (
          !destinations.has(parameter.id) &&
          original?.source.id !== parameter.id &&
          !carriedWhole(program, target.parameters, transfer, parameter, context)
        )
          invalid(block.control, 'a live successor value has no edge-specific assignment');
      }
    }
    if (block.control.kind === 'return') {
      const result = program.returns.get(block.control.id);
      if (!result) invalid(block.control, 'a reachable return has no result projection');
      for (const value of result.results) checkValue(value);
      const type = program.source?.return_type;
      if (
        type &&
        (result.results.length !== 1 ||
          bitWidth(result.results[0]!.type) !== bitWidth(type) ||
          result.results[0]!.type.kind !== type.kind)
      )
        invalid(
          block.control,
          'a source return loses its declared storage width or register-bank interpretation',
        );
    }
  }
  for (const id of program.live) {
    context.checkpoint(1);
    const value = program.values.get(id);
    if (!value) invalid(program.function, 'a live synthesized value is absent');
    if (program.source?.stack_addresses.has(id)) continue;
    const expression = program.expressions.get(id);
    if (program.inline.has(id) && !expression)
      invalid(program.function, 'an expanded synthesized value has no expression');
    if (!program.inline.has(id) && !definitions.has(id))
      invalid(program.function, 'a synthesized local is used without an emitted definition');
    if (expression) for (const operand of expressionOperands(expression)) checkValue(operand);
  }
  const entry = stackEntry(storage);
  if (
    entry &&
    (!program.parameters.some((value) => value.id === entry.id) || !program.live.has(entry.id))
  )
    invalid(program.function, 'entry-backed storage has no live explicit incoming base');
  if (storage?.kind === 'object') {
    let end = storage.minimum_offset;
    for (const member of storage.members) {
      context.checkpoint(1);
      if (member.size <= 0n || member.offset < end)
        invalid(program.function, 'frame object members overlap or are out of order');
      end = member.offset + member.size;
    }
    if (end > 0n || storage.minimum_offset + storage.size !== 0n)
      invalid(program.function, 'a frame object does not end at the entry SP');
  }
  // Retained frame accesses of private and object storage are checked in the
  // statement scan above.
  const locals = program.source?.locals;
  if (locals?.size) {
    const predecessors = new Map<string, string[]>();
    for (const id of reachable)
      for (const transfer of transfers(program, id)) {
        const list = predecessors.get(transfer.target) ?? [];
        list.push(id);
        predecessors.set(transfer.target, list);
      }
    const outgoing = new Map<string, ReadonlySet<string>>();
    const queue = [program.function.entry],
      queued = new Set(queue);
    const incoming = (id: string): Set<string> | null => {
      if (id === program.function.entry) return new Set();
      let result: Set<string> | null = null;
      for (const parent of predecessors.get(id) ?? []) {
        const state = outgoing.get(parent);
        if (!state) continue;
        if (result === null) result = new Set(state);
        else
          for (const local of result) {
            context.checkpoint(1);
            if (!state.has(local)) result.delete(local);
          }
      }
      return result;
    };
    for (let cursor = 0; cursor < queue.length; cursor++) {
      context.checkpoint(1);
      const id = queue[cursor]!;
      queued.delete(id);
      const state = incoming(id);
      if (!state) continue;
      const block = program.blocks.get(id)!;
      for (const node of block.statements) {
        context.checkpoint(1);
        const local = locals.get(node.id);
        if (local && node.kind === 'store' && program.retained.has(node.id)) state.add(local.id);
      }
      const previous = outgoing.get(id);
      if (
        previous &&
        previous.size === state.size &&
        [...state].every((local) => previous.has(local))
      )
        continue;
      outgoing.set(id, state);
      for (const transfer of transfers(program, id))
        if (!queued.has(transfer.target)) {
          queued.add(transfer.target);
          queue.push(transfer.target);
        }
    }
    for (const id of reachable) {
      const state = incoming(id)!;
      for (const node of program.blocks.get(id)!.statements) {
        context.checkpoint(1);
        if (!program.retained.has(node.id)) continue;
        const local = locals.get(node.id);
        if (!local) continue;
        if (node.kind === 'load' && !state.has(local.id))
          invalid(node, 'a promoted local is read without initialization on every incoming path');
        if (node.kind === 'store') state.add(local.id);
      }
    }
  }
  const checked = new Set<string>();
  const expanding = new Set<string>();
  const visit = (id: string, depth: number): void => {
    context.checkpoint(1);
    if (!program.inline.has(id) || program.source?.stack_addresses.has(id) || checked.has(id))
      return;
    if (depth > 128)
      invalid(program.function, 'expanded expression depth exceeds the supported rendering bound');
    if (expanding.has(id))
      invalid(program.function, 'expanded expressions contain a def-use cycle');
    expanding.add(id);
    for (const operand of expressionOperands(program.expressions.get(id)!))
      visit(operand.id, depth + 1);
    expanding.delete(id);
    checked.add(id);
  };
  for (const id of program.live) visit(id, 0);
  validateEmittedUses(program, reachable, (id) => transfers(program, id), context);
}

type Nest =
  | {
      readonly kind: 'loop';
      readonly header: string;
      readonly follow: string | null;
      /** do-while: only its test may `continue` (elsewhere it reaches the test). */
      readonly test?: string;
    }
  | { readonly kind: 'switch'; readonly id: string; readonly follow: string | null };

/** Independently derive the executable edge represented by each chosen syntax.
 * This is a publication check, not another structuring/rewrite algorithm. In
 * particular two exits from one loop cannot both mean its lexical successor.
 * `fallthrough` transfers print nothing and so reach their lexical follow. */
export function validateRenderedTransfers(
  fn: StructuredFunction,
  gotos: ReadonlySet<ParallelTransfer>,
  language: 'c-like' | 'python-like',
  context: OperationContext,
  fallthrough: ReadonlySet<ParallelTransfer> = new Set(),
  emitted?: ReadonlyMap<ParallelTransfer, EmittedEdge>,
  exits?: EmittedLoopExits,
): void {
  const jumps = emitted ? jumpBlocks(fn.body) : new Map<string, ParallelTransfer>();
  const entry = (region: Region, fallback: string | null): string | null => {
    for (;;) {
      context.checkpoint(1);
      if (region.kind === 'block') return region.id;
      if (region.kind === 'loop') return region.header;
      const first = region.regions[0];
      if (!first) return fallback;
      region = first;
    }
  };
  /** `shared`: entry of the shared arm body an operand of the chain being
   * walked may enter (`shared-arm`); null off an operand chain. */
  const edge = (
    transfer: ParallelTransfer,
    follow: string | null,
    nesting: readonly Nest[],
    origin: Origin,
    shared: string | null = null,
  ): void => {
    context.checkpoint(1);
    const action = emitted?.get(transfer);
    const mode = action?.kind ?? transfer.mode;
    let actual = follow;
    if (action?.kind === 'goto' || (!action && gotos.has(transfer)))
      actual = action?.kind === 'goto' ? action.target : transfer.target;
    else if (action?.kind === 'fallthrough')
      actual = crossSilently(follow, action.through, jumps, emitted!);
    else if (mode === 'fallthrough' || (!action && fallthrough.has(transfer))) actual = follow;
    else if (mode === 'shared-arm') actual = shared;
    else if (mode === 'continue') {
      actual = null;
      for (let i = nesting.length - 1; i >= 0; i--) {
        const scope = nesting[i]!;
        if (scope.kind === 'loop') {
          if (scope.test === undefined || scope.test === origin.id) actual = scope.header;
          break;
        }
      }
    } else if (action?.kind === 'break')
      actual = crossSilently(nesting.at(-1)?.follow ?? null, action.through, jumps, emitted!);
    else if (mode === 'break') actual = nesting.at(-1)?.follow ?? null;
    else if (action?.kind === 'loop-exit') {
      const outer = nesting.findIndex(
        (scope) => scope.kind === 'loop' && scope.header === action.loop,
      );
      const through = outer < 0 ? [] : nesting.slice(outer).reverse();
      actual =
        through.length > 1 &&
        through.length === action.through.length &&
        through.every(
          (scope, index) =>
            (scope.kind === 'loop' ? scope.header : scope.id) === action.through[index],
        ) &&
        exits?.initialized.has(action.loop) &&
        through
          .slice(0, -1)
          .every((scope) =>
            exits.guards.get(scope.kind === 'loop' ? scope.header : scope.id)?.has(action.loop),
          )
          ? nesting[outer]!.follow
          : null;
    }
    if (actual !== transfer.target)
      invalid(
        origin,
        `rendered ${mode} reaches ${actual ?? 'no block'} instead of CFG target ${transfer.target}`,
      );
  };
  const arm = (
    value: ControlArm,
    follow: string | null,
    nesting: readonly Nest[],
    origin: Origin,
    shared: string | null = null,
    chain: string | null = null,
  ): void => {
    edge(value.transfer, value.body ? entry(value.body, follow) : follow, nesting, origin, shared);
    if (value.body) walk(value.body, follow, nesting, chain);
  };
  /** `chain`: the region is an operand chain position of a shared-arm head
   * (jumps then the next operand); its operands may enter that arm. */
  const walk = (
    region: Region,
    follow: string | null,
    nesting: readonly Nest[],
    chain: string | null = null,
  ): void => {
    context.checkpoint(1);
    if (region.kind === 'sequence') {
      for (let i = 0; i < region.regions.length; i++) {
        let next = follow;
        for (let j = i + 1; j < region.regions.length; j++) {
          const candidate = entry(region.regions[j]!, null);
          if (candidate !== null) {
            next = candidate;
            break;
          }
        }
        const link =
          i === region.regions.length - 1 &&
          region.regions
            .slice(0, -1)
            .every((item) => item.kind === 'block' && item.control.kind === 'jump');
        walk(region.regions[i]!, next, nesting, link ? chain : null);
      }
      return;
    }
    if (region.kind === 'loop') {
      // Falling off a do-while body reaches its test, never the header directly.
      const test = region.form?.kind === 'do_while' ? region.form.test : undefined;
      walk(region.body, test === undefined ? region.header : null, [
        ...nesting,
        {
          kind: 'loop',
          header: region.header,
          follow,
          ...(test === undefined ? {} : { test }),
        },
      ]);
      return;
    }
    const control = region.control;
    if (control.kind === 'jump') edge(control.transfer, follow, nesting, control);
    else if (control.kind === 'if') {
      const head = [control.when_true, control.when_false].find((item) => item.shared);
      const operand = control.when_true.joins || control.when_false.joins ? chain : null;
      for (const item of [control.when_true, control.when_false])
        arm(
          item,
          follow,
          nesting,
          control,
          item.joins ? operand : null,
          head && item !== head ? entry(head.body!, null) : item.shared ? null : operand,
        );
    } else if (control.kind === 'switch') {
      const scopes: readonly Nest[] =
        language === 'c-like' ? [...nesting, { kind: 'switch', id: control.id, follow }] : nesting;
      for (const item of control.cases) arm(item.arm, follow, scopes, control);
      arm(control.otherwise, follow, scopes, control);
    }
  };
  walk(fn.body, null, []);
}
