import { fingerprint, type OperationContext, type PresentationView } from '../core/index.js';
import type { EmissionInput } from '../emitters/model.js';
import { classifyStackRegion } from '../analysis/stack/index.js';
import {
  bitWidth,
  expressionOperands,
  sameType,
  type DataType,
  type Expression,
  type Instruction,
  type RegisterBinding,
  type Value,
} from '../ir/index.js';
import type { BlockRegion, ParallelTransfer } from '../presentation/index.js';
import type { BoundaryProjection } from './model.js';
import type { FrameSaves, SourceLocal, SourceStackStorage } from './source-model.js';
import type { Requirement } from '../core/inference.js';
import { LocalValidationSession } from './local-validation.js';
import { validateStackPromotion } from './local-storage-validation.js';
import { sourceRequirementPredicates } from './source-requirements.js';

type MemoryNode = Extract<Instruction, { kind: 'load' | 'store' }>;
/** Exact private slots only. Escapes and overlapping access intervals retain one
 * shared frame; promoting a slot never changes an observable memory operation. */
export function planSourceStack(
  input: EmissionInput,
  blocks: ReadonlyMap<string, BlockRegion>,
  expressions: Map<string, Expression>,
  transfers: readonly { transfer: ParallelTransfer; block: BlockRegion }[],
  calls: Map<string, BoundaryProjection>,
  returns: ReadonlyMap<string, BoundaryProjection>,
  alias: (value: Value, expression: Expression) => void,
  context: OperationContext,
  incomingStack: (offset: bigint, type: DataType, contributors: readonly Value[]) => Value | null,
  entryStack: () => Value,
  validation = new LocalValidationSession(context),
  view: PresentationView = 'checked',
  requirements?: readonly Requirement[],
) {
  const addresses = new Map<string, bigint>(),
    facts = input.types?.calls?.stack;
  if (facts?.state === 'complete')
    for (const [id, fact] of facts.values)
      if (fact.value.kind === 'stack') addresses.set(id, fact.value.offset);
  const entry = blocks.get(input.function.entry)!;
  for (const binding of entry.register_entry)
    if (
      binding.register.root === input.source!.abi.stack_pointer.root &&
      binding.register.width_bits === input.source!.abi.stack_pointer.width_bits
    )
      addresses.set(binding.value.id, 0n);
  // A bounded monotone affine pass also supports synthetic source callers that
  // do not carry the native stack analysis. Conflicting phis never get an offset.
  const incoming = new Map<string, Value[]>();
  for (const { transfer } of transfers)
    for (const copy of transfer.copies) {
      const row = incoming.get(copy.destination.id) ?? [];
      row.push(copy.source);
      incoming.set(copy.destination.id, row);
    }
  // The value whose low-to-high extracts `parts` tile exactly, or null.
  const recombined = (parts: readonly Value[]): Value | null => {
    let base: Value | null = null,
      width = 0;
    for (const part of parts) {
      const expression = expressions.get(part.id);
      if (
        expression?.kind !== 'extract' ||
        expression.offset !== width ||
        (base !== null && base.id !== expression.value.id)
      )
        return null;
      base = expression.value;
      width += bitWidth(part.type);
    }
    return base && width === bitWidth(base.type) ? base : null;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, expression] of expressions) {
      context.checkpoint(1);
      if (addresses.has(id)) continue;
      let offset: bigint | undefined;
      if (expression.kind === 'cast' && expression.op === 'bitcast')
        offset = addresses.get(expression.value.id);
      else if (expression.kind === 'concat') {
        // Register-cell halves of one value, recombined in order, are that value.
        const whole = recombined(expression.values);
        if (whole) offset = addresses.get(whole.id);
      } else if (
        expression.kind === 'integer' &&
        (expression.op === 'add' || expression.op === 'sub')
      ) {
        const base = addresses.get(expression.left.id),
          constant = expressions.get(expression.right.id);
        if (base !== undefined && constant?.kind === 'constant')
          offset =
            base +
            (expression.op === 'add' ? 1n : -1n) *
              BigInt.asIntN(bitWidth(expression.right.type), constant.bits);
      }
      if (offset !== undefined) {
        addresses.set(id, offset);
        changed = true;
      }
    }
    for (const [id, sources] of incoming) {
      context.checkpoint(1);
      if (addresses.has(id) || !sources.length) continue;
      const offset = addresses.get(sources[0]!.id);
      if (offset !== undefined && sources.every((value) => addresses.get(value.id) === offset)) {
        addresses.set(id, offset);
        changed = true;
      }
    }
  }
  const tainted = new Set(addresses.keys());
  const memory = [...blocks.values()].flatMap((block) =>
    block.statements.filter(
      (node): node is MemoryNode => node.kind === 'load' || node.kind === 'store',
    ),
  );
  // Index the bounded access widths, not every store against every load.
  // Byte membership preserves partial overlaps and differently sized accesses.
  const storesByByte = new Map<bigint, Extract<MemoryNode, { kind: 'store' }>[]>();
  for (const node of memory) {
    context.checkpoint(1);
    if (node.kind !== 'store') continue;
    const offset = addresses.get(node.address.id);
    if (offset === undefined) continue;
    const end = offset + BigInt(Math.ceil(bitWidth(node.value.type) / 8));
    for (let byte = offset; byte < end; byte++) {
      context.checkpoint(1);
      const row = storesByByte.get(byte) ?? [];
      row.push(node);
      storesByByte.set(byte, row);
    }
  }
  const memoryDependencies = new Map<string, Value[]>(),
    dependenciesByRange = new Map<string, Value[]>();
  for (const load of memory) {
    context.checkpoint(1);
    if (load.kind !== 'load') continue;
    const offset = addresses.get(load.address.id);
    if (offset === undefined) continue;
    const end = offset + BigInt(Math.ceil(bitWidth(load.result.type) / 8)),
      key = `${offset}:${end}`;
    let sources = dependenciesByRange.get(key);
    if (!sources) {
      const stores = new Set<Extract<MemoryNode, { kind: 'store' }>>();
      for (let byte = offset; byte < end; byte++) {
        context.checkpoint(1);
        for (const store of storesByByte.get(byte) ?? []) {
          context.checkpoint(1);
          stores.add(store);
        }
      }
      sources = [];
      for (const store of stores) {
        context.checkpoint(1);
        sources.push(store.value);
      }
      dependenciesByRange.set(key, sources);
    }
    memoryDependencies.set(load.result.id, sources);
  }
  changed = true;
  while (changed) {
    changed = false;
    for (const [id, expression] of expressions) {
      context.checkpoint(1);
      if (
        !tainted.has(id) &&
        expressionOperands(expression).some((value) => tainted.has(value.id))
      ) {
        tainted.add(id);
        changed = true;
      }
    }
    for (const [id, sources] of incoming)
      if (!tainted.has(id) && sources.some((value) => tainted.has(value.id))) {
        tainted.add(id);
        changed = true;
      }
    for (const [id, sources] of memoryDependencies)
      if (!tainted.has(id) && sources.some((value) => tainted.has(value.id))) {
        context.checkpoint(1);
        tainted.add(id);
        changed = true;
      }
  }
  let escaped = false,
    unknownCallStorage = false,
    // Frame saves rest on ABI conformance: an unresolved callee reads only
    // argument registers/stack and never writes its caller's frame. Any stack
    // address in possible argument/result storage escapes private promotion
    // (`saveEscaped`). For frame saves only an address of unknown offset exposes
    // the whole frame (`frameExposed`); an escaped address of known offset
    // designates its own object, never a compiler-owned save slot elsewhere.
    saveEscaped = view !== 'source',
    frameExposed = saveEscaped;
  const exposedOffsets = new Set<bigint>();
  // Known frame offsets of every address a tainted value is derived from (cell
  // halves, indexed/phi'd pointers, pointers spilled to the frame and reloaded),
  // or null when some tainted leaf has no known origin.
  const baseOffsets = (start: Value): bigint[] | null => {
    const bases = new Set<bigint>(),
      seen = new Set<string>(),
      pending = [start];
    while (pending.length) {
      context.checkpoint(1);
      const value = pending.pop()!;
      if (seen.has(value.id) || !tainted.has(value.id)) continue;
      seen.add(value.id);
      const offset = addresses.get(value.id);
      if (offset !== undefined) {
        bases.add(offset);
        continue;
      }
      const expression = expressions.get(value.id);
      if (expression) pending.push(...expressionOperands(expression));
      else {
        const sources = incoming.get(value.id) ?? memoryDependencies.get(value.id);
        if (!sources?.length) return null;
        pending.push(...sources);
      }
    }
    return [...bases];
  };
  const expose = (value: Value): void => {
    if (!tainted.has(value.id)) return;
    saveEscaped = true;
    const bases = baseOffsets(value);
    if (bases) for (const offset of bases) exposedOffsets.add(offset);
    else frameExposed = true;
  };
  const abi = input.source!.abi;
  const preservedRoot = (root: string): boolean =>
    abi.preserved.some((register) => register.root === root);
  // Condition flags are never argument or result storage under any supported
  // ABI; flags computed from frame arithmetic do not hand a callee an address.
  const argumentBindings = (bindings: readonly RegisterBinding[]): RegisterBinding[] =>
    bindings.filter(
      (binding) =>
        binding.register.root !== abi.stack_pointer.root &&
        binding.register.bank !== 'flags' &&
        !preservedRoot(binding.register.root) &&
        tainted.has(binding.value.id),
    );
  // Validate closure before classifying outgoing storage: a fully analyzed
  // register-only callee cannot observe private spills merely because the caller
  // wrote them. Refused presentation records keep the conservative open area.
  if (view === 'source')
    for (const block of blocks.values())
      for (const node of block.statements) {
        if (node.kind !== 'call') continue;
        const projection = calls.get(node.id)!;
        const closure = input.source?.source_callees?.find(
          (callee) => callee.call_id === node.id,
        )?.argument_list_closure;
        if (
          projection.kind === 'inferred' &&
          projection.argument_list_complete === true &&
          !validation.presentation(
            'arity_closure',
            node.id,
            closure === 'library_contract'
              ? 'library_contract: complete native reads propagated through established import-tail contracts prove a register-only interface; caller frame writes cannot supply additional arguments'
              : closure === 'objc_selector'
                ? 'objc_selector: the statically resolved selector fixes the keyword argument count; argument classes follow its unique image type encoding or integer/pointer class, and the caller prepares no further argument register'
                : 'callee_reads: complete nonrecursive native summary reads only the observed register prefix, no incoming stack and no escaping incoming-stack address; caller frame writes cannot supply additional arguments',
            [node.id],
          )
        )
          calls.set(node.id, { ...projection, argument_list_complete: false });
        if (closure === 'library_contract' && calls.get(node.id)!.argument_list_complete === true)
          validation.requireAbi(
            'arity_closure',
            [node.id],
            'Native closure through imported tail contracts assumes the established library interface and ABI-conforming arguments and results; incomplete dependencies and unresolved targets stay open.',
          );
        if (closure === 'objc_selector' && calls.get(node.id)!.argument_list_complete === true)
          validation.requireAbi(
            'arity_closure',
            [node.id],
            'Objective-C selector closure assumes the receiver implements a non-variadic method for the selector with the assumed argument classes; known variadic selectors and unresolved selectors stay open.',
          );
      }
  const openArguments = (projection: BoundaryProjection): boolean =>
    projection.kind !== 'source' &&
    !(view === 'source' && projection.argument_list_complete === true);
  const callNodes: Extract<Instruction, { kind: 'call' }>[] = [];
  const accesses: { node: MemoryNode; block: string; offset: bigint; end: bigint; key: string }[] =
    [];
  // Source view: as in the source signature, an FP-environment guard's failure
  // arm is not executed under its recorded fp_environment requirement, and its
  // unknown exit ends modeled execution. Its unknown effect is no frame escape.
  const fpFailureArms = new Set<string>();
  if (view === 'source') {
    const predicates = sourceRequirementPredicates(requirements),
      entries = new Map<string, number>();
    for (const { transfer } of transfers)
      entries.set(transfer.target, (entries.get(transfer.target) ?? 0) + 1);
    for (const block of blocks.values()) {
      context.checkpoint(1);
      const control = block.control,
        predicate = control.kind === 'if' ? predicates.get(control.id) : undefined;
      if (control.kind !== 'if' || predicate?.requirement.kind !== 'fp_environment') continue;
      const failure = (
        predicate.site.supported_predicate_value ? control.when_false : control.when_true
      ).transfer.target;
      if (entries.get(failure) === 1 && blocks.get(failure)?.control.kind === 'unknown')
        fpFailureArms.add(failure);
    }
  }
  const guardEffects = new Set<string>();
  for (const block of blocks.values()) {
    for (const node of block.statements) {
      context.checkpoint(1);
      if (node.kind === 'call') {
        callNodes.push(node);
        const projection = calls.get(node.id)!;
        for (const value of projection.arguments) expose(value);
        if (openArguments(projection))
          for (const binding of argumentBindings(node.register_inputs)) expose(binding.value);
      }
      if (node.kind === 'call' && openArguments(calls.get(node.id)!)) unknownCallStorage = true;
      if (
        node.kind === 'call' &&
        (calls.get(node.id)!.kind === 'physical' ||
          calls.get(node.id)!.arguments.some((value) => tainted.has(value.id)))
      )
        escaped = true;
      if (node.kind === 'unknown_effect') {
        escaped = true;
        if (fpFailureArms.has(block.id)) guardEffects.add(block.id);
        else saveEscaped = frameExposed = true;
      }
      if (node.kind !== 'load' && node.kind !== 'store') continue;
      const offset = addresses.get(node.address.id),
        width = bitWidth(node.kind === 'load' ? node.result.type : node.value.type);
      if (
        node.kind === 'store' &&
        tainted.has(node.value.id) &&
        (offset === undefined || offset >= 0n)
      ) {
        escaped = true;
        expose(node.value);
      }
      if (offset === undefined && tainted.has(node.address.id)) {
        escaped = true;
        expose(node.address);
      }
      if (offset === undefined || width % 8) continue;
      const end = offset + BigInt(width / 8);
      accesses.push({ node, block: block.id, offset, end, key: `${offset}:${end}` });
    }
    if (
      block.control.kind === 'return' &&
      returns.get(block.control.id)!.results.some((value) => tainted.has(value.id))
    ) {
      escaped = true;
      for (const value of returns.get(block.control.id)!.results) expose(value);
    }
    // Like private promotion, unmodeled exits do not observe frame-private
    // bytes; an indirect target may still receive a stack address as argument.
    if (block.control.kind === 'indirect')
      for (const binding of argumentBindings(block.register_exit)) expose(binding.value);
  }
  for (const id of frameExposed ? [] : guardEffects)
    if (
      !validation.presentation(
        'fp_guard_frame',
        id,
        'FP-environment guard failure arm, unexecuted under its recorded fp_environment requirement and ending in an unknown exit; its unknown effect is not a frame address escape',
        [id],
      )
    )
      saveEscaped = frameExposed = true;
  // Established ABI stack locations are outgoing argument storage at a call,
  // even when their entry-SP offsets are negative. They are not private spills.
  const outgoingRanges = (input.types?.calls?.calls ?? []).flatMap((call) =>
    call.contracts
      .filter((contract) => contract.status === 'established')
      .flatMap((contract) =>
        contract.parameters.flatMap((parameter) =>
          parameter.locations.flatMap((observation) =>
            observation.location.kind === 'stack' && observation.stack_offset !== null
              ? [
                  {
                    start: observation.stack_offset,
                    end: observation.stack_offset + observation.location.size,
                  },
                ]
              : [],
          ),
        ),
      ),
  );
  const groups = new Map<string, typeof accesses>();
  for (const access of accesses) {
    const group = groups.get(access.key) ?? [];
    group.push(access);
    groups.set(access.key, group);
  }
  const aliased =
    facts?.frame.aliased === true ||
    memory.some((node) => node.kind === 'store' && !addresses.has(node.address.id));
  // Source view: on an ABI whose call pushes the return address, the bytes at
  // the callee-entry SP are by definition that return address. The last store
  // before the call (only pure assignments between) writing exactly those bytes
  // with a code address, originating from the call's own instruction, is the
  // call's push. When no other access touches those bytes and no frame address
  // escapes, only the callee's return consumes it: call mechanics, not a
  // source local. The checked view retains every store.
  const returnAddressPushes = new Set<string>();
  if (view === 'source' && !saveEscaped && abi.stack_return_address_bytes > 0n) {
    const pushes: (typeof accesses)[number][] = [];
    const byStore = new Map(accesses.map((access) => [access.node.id, access]));
    for (const block of blocks.values())
      for (let index = 0; index < block.statements.length; index++) {
        context.checkpoint(1);
        const call = block.statements[index]!;
        if (call.kind !== 'call') continue;
        let previous = index - 1;
        while (previous >= 0 && block.statements[previous]!.kind === 'assign') previous--;
        const push = previous >= 0 ? byStore.get(block.statements[previous]!.id) : undefined,
          stack = call.register_inputs.find(
            (binding) =>
              binding.register.root === abi.stack_pointer.root &&
              binding.register.width_bits === abi.stack_pointer.width_bits,
          ),
          value = push?.node.kind === 'store' ? expressions.get(push.node.value.id) : undefined;
        if (
          !push ||
          push.node.kind !== 'store' ||
          push.node.access.volatile ||
          !stack ||
          addresses.get(stack.value.id) !== push.offset ||
          push.end - push.offset !== abi.stack_return_address_bytes ||
          value?.kind !== 'address' ||
          !push.node.provenance.instruction_ids.length ||
          push.node.provenance.instruction_ids.some(
            (id) => !call.provenance.instruction_ids.includes(id),
          )
        )
          continue;
        pushes.push(push);
      }
    const pushIds = new Set(pushes.map((push) => push.node.id));
    for (const push of pushes) {
      context.checkpoint(accesses.length);
      if (
        accesses.some(
          (access) =>
            !pushIds.has(access.node.id) && access.offset < push.end && access.end > push.offset,
        ) ||
        !validation.presentation(
          'call_return_address',
          push.node.id,
          `call instruction's own push of its fall-through address at callee-entry SP ${push.offset}; no other frame access overlaps; no frame address escapes`,
          [push.node.id],
        )
      )
        continue;
      returnAddressPushes.add(push.node.id);
    }
    if (returnAddressPushes.size)
      validation.requireAbi(
        'call_return_address',
        [...returnAddressPushes].slice(0, 64),
        'Hiding a call’s return-address push assumes ABI conformance: the callee consumes the pushed fall-through address only to return and it is not argument storage. Each store remains in the checked view and the original mappings.',
      );
  }
  // An open argument list describes an unbounded caller-SP-relative area.
  // Do not infer its end from observed registers or written bytes. A slot used
  // only after the last such call, however, cannot supply that call's arguments.
  const openCallPositions = new Map<string, number>(),
    reachesOpenCall = new Set<string>(),
    openCallSuccessors = new Set<string>();
  if (view === 'source' && unknownCallStorage) {
    for (const block of blocks.values())
      for (let position = 0; position < block.statements.length; position++) {
        const node = block.statements[position]!;
        if (node.kind === 'call' && openArguments(calls.get(node.id)!)) {
          openCallPositions.set(block.id, position);
          reachesOpenCall.add(block.id);
        }
      }
    for (let changed = true; changed;) {
      changed = false;
      for (const { transfer, block } of transfers) {
        context.checkpoint(1);
        if (!reachesOpenCall.has(transfer.target)) continue;
        openCallSuccessors.add(block.id);
        if (!reachesOpenCall.has(block.id)) {
          reachesOpenCall.add(block.id);
          changed = true;
        }
      }
    }
  }
  // Under activation-private storage ownership an external pointer cannot name
  // this activation's negative entry-SP offsets until a frame address escapes.
  // The original alias facts stay intact; source promotion records this ABI
  // premise and the independent byte validator receives the exact disjoint set.
  const disjointStores =
    view === 'source' && !saveEscaped
      ? new Set(
          memory
            .filter((node) => node.kind === 'store' && !addresses.has(node.address.id))
            .map((node) => node.id),
        )
      : undefined;
  const eligible = new Set<string>(),
    // Source view: narrower loads wholly inside a promoted integer slot, keyed
    // by that slot; each reads its endian-determined bits of the slot value.
    slotParts = new Map<string, typeof accesses>(),
    partSlot = new Map<string, string>();
  if (view === 'source' ? !saveEscaped : !escaped && !unknownCallStorage && !aliased)
    for (const [key, group] of groups) {
      const first = group[0]!;
      context.checkpoint(accesses.length);
      const overlapping = accesses.filter(
        (access) => access.key !== key && access.offset < first.end && access.end > first.offset,
      );
      if (
        returnAddressPushes.has(first.node.id) ||
        first.offset >= 0n ||
        first.end > 0n ||
        group.some((access) => access.node.access.volatile) ||
        (view === 'source' &&
          [...group, ...overlapping].some(
            (access) =>
              openCallSuccessors.has(access.block) ||
              blocks.get(access.block)!.statements.indexOf(access.node) <
                (openCallPositions.get(access.block) ?? -1),
          )) ||
        outgoingRanges.some((range) => range.start < first.end && range.end > first.offset)
      )
        continue;
      if (
        overlapping.length &&
        !(
          view === 'source' &&
          (first.node.kind === 'load' ? first.node.result.type : first.node.value.type).kind ===
            'integer' &&
          overlapping.every(
            (part) =>
              part.node.kind === 'load' &&
              part.node.result.type.kind === 'integer' &&
              !part.node.access.volatile &&
              part.node.access.endian === first.node.access.endian &&
              part.offset >= first.offset &&
              part.end <= first.end,
          )
        )
      )
        continue;
      if (
        group.some(
          (access) =>
            access.node.access.endian !== first.node.access.endian ||
            !sameType(
              access.node.kind === 'load' ? access.node.result.type : access.node.value.type,
              first.node.kind === 'load' ? first.node.result.type : first.node.value.type,
            ),
        )
      )
        continue;
      eligible.add(key);
      if (overlapping.length) {
        slotParts.set(key, overlapping);
        for (const part of overlapping) partSlot.set(part.node.id, key);
      }
    }
  // Source view: frame-private save/restore of an entry register. A slot is a
  // save when (i) its only store writes the entry value of a preserved register
  // or the link register, (ii) every return/tail exit restores that register
  // from a dominated load of exactly this slot and no other access overlaps it,
  // (iii) no stack address escapes and (iv) it is not established outgoing
  // argument storage. Under ABI conformance callees never write it, so each
  // reload equals the saved value and neither access is source-observable.
  const saveStores = new Set<string>(),
    saveReloads = new Set<string>(),
    saveBytes = new Set<bigint>();
  const exits = [...blocks.values()].filter(
    (block) =>
      block.control.kind === 'return' ||
      (block.control.kind === 'indirect' && block.control.tail_call === true),
  );
  const positions = new Map<string, number>();
  for (const block of blocks.values())
    for (let index = 0; index < block.statements.length; index++) {
      context.checkpoint(1);
      positions.set(block.statements[index]!.id, index);
    }
  const dominates = (
    first: (typeof accesses)[number],
    second: (typeof accesses)[number],
  ): boolean => {
    if (first.block === second.block)
      return positions.get(first.node.id)! < positions.get(second.node.id)!;
    for (
      let id = blocks.get(second.block)!.dominator;
      id !== null;
      id = blocks.get(id)?.dominator ?? null
    ) {
      context.checkpoint(1);
      if (id === first.block) return true;
    }
    return false;
  };
  if (!frameExposed && exits.length) {
    const entryCells = new Map(
      entry.register_entry.map((binding) => [binding.value.id, binding.register]),
    );
    const loadsByResult = new Map<string, string>();
    for (const access of accesses)
      if (access.node.kind === 'load') loadsByResult.set(access.node.result.id, access.node.id);
    type Bits = { readonly root: string; readonly low: number; readonly width: number };
    // Exact entry bits through bitcasts, extracts and ordered concatenation only.
    const entryBits = (value: Value, depth = 0): Bits | null => {
      context.checkpoint(1);
      const cell = entryCells.get(value.id);
      if (cell) return { root: cell.root, low: cell.offset_bits, width: cell.width_bits };
      const expression = depth < 16 ? expressions.get(value.id) : undefined;
      const width = bitWidth(value.type);
      if (expression?.kind === 'cast' && expression.op === 'bitcast')
        return bitWidth(expression.value.type) === width
          ? entryBits(expression.value, depth + 1)
          : null;
      if (expression?.kind === 'extract') {
        const inner = entryBits(expression.value, depth + 1);
        return inner && expression.offset + width <= inner.width
          ? { root: inner.root, low: inner.low + expression.offset, width }
          : null;
      }
      if (expression?.kind === 'concat') {
        let result: Bits | null = null;
        for (const part of expression.values) {
          const bits = entryBits(part, depth + 1);
          if (!bits) return null;
          if (!result) result = bits;
          else if (bits.root === result.root && bits.low === result.low + result.width)
            result = { root: result.root, low: result.low, width: result.width + bits.width };
          else return null;
        }
        return result;
      }
      return null;
    };
    // Bit offset within a reload of `members` on every incoming path, or null.
    // An unmodified entry value of the saved register equals the reload at the
    // same bit position (the slot holds exactly the saved entry bits), so a
    // shrink-wrapped save that some path never executes still restores.
    const reloadBits = (
      value: Value,
      members: ReadonlySet<string>,
      active: Set<string>,
      saved: Bits,
      depth = 0,
    ): number | null => {
      context.checkpoint(1);
      const load = loadsByResult.get(value.id);
      if (load !== undefined) return members.has(load) ? 0 : null;
      const unmodified = entryBits(value);
      if (unmodified)
        return unmodified.root === saved.root &&
          unmodified.low >= saved.low &&
          unmodified.low + unmodified.width <= saved.low + saved.width
          ? unmodified.low - saved.low
          : null;
      if (depth >= 32 || active.has(value.id)) return null;
      const expression = expressions.get(value.id);
      if (expression?.kind === 'cast' && expression.op === 'bitcast')
        return bitWidth(expression.value.type) === bitWidth(value.type)
          ? reloadBits(expression.value, members, active, saved, depth + 1)
          : null;
      if (expression?.kind === 'extract') {
        const inner = reloadBits(expression.value, members, active, saved, depth + 1);
        return inner === null ? null : inner + expression.offset;
      }
      if (expression?.kind === 'concat') {
        let start: number | null = null,
          width = 0;
        for (const part of expression.values) {
          const offset = reloadBits(part, members, active, saved, depth + 1);
          if (offset === null) return null;
          if (start === null) start = offset;
          else if (offset !== start + width) return null;
          width += bitWidth(part.type);
        }
        return width === bitWidth(value.type) ? start : null;
      }
      const sources = expression ? undefined : incoming.get(value.id);
      if (!sources?.length) return null;
      active.add(value.id);
      let result: number | null | undefined;
      for (const source of sources) {
        const bits = reloadBits(source, members, active, saved, depth + 1);
        if (bits === null || (result !== undefined && result !== bits)) {
          result = null;
          break;
        }
        result = bits;
      }
      active.delete(value.id);
      return result ?? null;
    };
    for (const [key, group] of groups) {
      context.checkpoint(group.length);
      const first = group[0]!;
      const stores = group.filter((access) => access.node.kind === 'store'),
        loads = group.filter((access) => access.node.kind === 'load');
      const save = stores[0],
        saved = save?.node.kind === 'store' ? save.node : null;
      if (
        !save ||
        !saved ||
        stores.length !== 1 ||
        !loads.length ||
        first.offset >= 0n ||
        first.end > 0n ||
        group.some(
          (access) =>
            access.node.access.volatile ||
            access.node.access.endian !== saved.access.endian ||
            (access.node.kind === 'load' && !sameType(access.node.result.type, saved.value.type)),
        ) ||
        accesses.some(
          (access) => access.key !== key && access.offset < first.end && access.end > first.offset,
        ) ||
        [...exposedOffsets].some((offset) => offset >= first.offset && offset < first.end) ||
        outgoingRanges.some((range) => range.start < first.end && range.end > first.offset)
      )
        continue;
      const bits = entryBits(saved.value);
      if (
        !bits ||
        bits.width !== bitWidth(saved.value.type) ||
        !(
          abi.link_register?.root === bits.root ||
          abi.preserved.some(
            (register) =>
              register.root === bits.root &&
              register.offset_bits <= bits.low &&
              register.offset_bits + register.width_bits >= bits.low + bits.width,
          )
        ) ||
        loads.some((load) => !dominates(save, load))
      )
        continue;
      const members = new Set(loads.map((load) => load.node.id));
      const restored = exits.every((exit) => {
        let covered = 0;
        for (const binding of exit.register_exit) {
          const register = binding.register;
          if (
            register.root !== bits.root ||
            register.offset_bits + register.width_bits <= bits.low ||
            register.offset_bits >= bits.low + bits.width
          )
            continue;
          if (
            register.offset_bits < bits.low ||
            register.offset_bits + register.width_bits > bits.low + bits.width ||
            reloadBits(binding.value, members, new Set(), bits) !== register.offset_bits - bits.low
          )
            return false;
          covered += register.width_bits;
        }
        return covered === bits.width;
      });
      if (
        !restored ||
        !validation.presentation(
          'frame_save',
          `stack:${key}`,
          `frame-private save of ${bits.root}[${bits.low}:${bits.width}] at entry SP ${first.offset}; restored from this exact slot on every return/tail exit; nonescaping, nonoverlapping, not established outgoing argument storage`,
          [save.node.id, ...members].slice(0, 64),
        )
      )
        continue;
      // A proven save is machine bookkeeping, not a scalar source local.
      // Classify it before promotion even in leaf functions without calls.
      eligible.delete(key);
      saveStores.add(save.node.id);
      for (let byte = first.offset; byte < first.end; byte++) saveBytes.add(byte);
      for (const load of loads) {
        saveReloads.add(load.node.id);
        if (load.node.kind === 'load')
          alias(load.node.result, { kind: 'cast', op: 'bitcast', value: saved.value });
      }
    }
    if (saveStores.size)
      validation.requireAbi(
        'frame_save',
        [exits[0]!.control.id, ...saveStores],
        'Frame save/restore elision assumes ABI conformance: callees preserve callee-saved registers and never write their caller’s frame outside outgoing argument storage, the saved slots are not stack arguments, and a frame address handed to a callee (or indexed from) designates its own object, never a save slot. Each hidden store and reload remains in the checked view and the original mappings.',
      );
  }
  // Source view: a non-volatile frame load dominated by a store covering its
  // bytes cannot fault. If its result is dead, reconstruct() may drop it.
  const deadReloadCandidates = new Set<string>();
  const byNode = new Map(accesses.map((access) => [access.node.id, access]));
  if (view === 'source')
    for (const load of accesses) {
      if (load.node.kind !== 'load' || load.node.access.volatile || saveReloads.has(load.node.id))
        continue;
      // A covering store must cover the first byte; filter only that bucket.
      // Valid IR memory accesses are byte-width, so every indexed store is an access.
      for (const node of storesByByte.get(load.offset) ?? []) {
        context.checkpoint(1);
        const store = byNode.get(node.id)!;
        if (store.end >= load.end && dominates(store, load)) {
          deadReloadCandidates.add(load.node.id);
          break;
        }
      }
    }
  // Register observations establish a prefix, not the absence of further
  // stack arguments. Written bytes may also be saves or locals: retain the
  // uncertainty instead of inventing an argument count from their extent.
  // Proven frame saves are not possible stack arguments. A source-view closure
  // validated above is callee-proven register-only and is not reopened.
  for (const node of callNodes) {
    context.checkpoint(1);
    const projection = calls.get(node.id)!;
    if (projection.kind !== 'inferred' || projection.argument_list_complete === true) continue;
    const snapshot = facts?.snapshots.get(node.id);
    let writtenStack = false;
    if (snapshot)
      for (const offset of snapshot.memory.keys()) {
        context.checkpoint(1);
        if (!saveBytes.has(offset)) {
          writtenStack = true;
          break;
        }
      }
    else
      writtenStack = memory.some(
        (access) =>
          access.kind === 'store' && addresses.has(access.address.id) && !saveStores.has(access.id),
      );
    if (writtenStack) {
      // Caller-written outgoing stack bytes may be arguments (or the variadic tail):
      // no heuristic may close the list over them.
      const { likely: _guess, ...kept } = projection;
      calls.set(node.id, { ...kept, argument_list_complete: false });
    }
  }
  const predecessors = new Map<string, string[]>();
  for (const { transfer, block } of transfers) {
    const row = predecessors.get(transfer.target) ?? [];
    row.push(block.id);
    predecessors.set(transfer.target, row);
  }
  // State is exact reaching value / definitely initialized but differing values /
  // uninitialized. Unvisited predecessors are ignored until reached, then joins
  // can only lose precision, so backedges converge without inventing assignment.
  type Cell = Value | null | undefined;
  const outgoing = new Map<string, Map<string, Cell>>(),
    before = new Map<string, Cell>();
  changed = true;
  const indegree = new Map([...blocks.keys()].map((id) => [id, 0])),
    successors = new Map<string, string[]>();
  for (const { transfer, block } of transfers) {
    indegree.set(transfer.target, (indegree.get(transfer.target) ?? 0) + 1);
    const row = successors.get(block.id) ?? [];
    row.push(transfer.target);
    successors.set(block.id, row);
  }
  const acyclicQueue = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
  for (let cursor = 0; cursor < acyclicQueue.length; cursor++)
    for (const target of successors.get(acyclicQueue[cursor]!) ?? []) {
      context.checkpoint(1);
      const count = indegree.get(target)! - 1;
      indegree.set(target, count);
      if (count === 0) acyclicQueue.push(target);
    }
  const acyclic = acyclicQueue.length === blocks.size;
  while (changed) {
    changed = false;
    for (const block of blocks.values()) {
      context.checkpoint(1);
      const parents = (predecessors.get(block.id) ?? [])
        .map((id) => outgoing.get(id))
        .filter((state): state is Map<string, Cell> => state !== undefined);
      if (block.id !== input.function.entry && !parents.length) continue;
      const state = new Map<string, Cell>();
      for (const key of eligible) {
        let cell: Cell = block.id === input.function.entry ? undefined : parents[0]?.get(key);
        for (const parent of parents) {
          const other = parent.get(key);
          cell =
            cell === undefined || other === undefined
              ? undefined
              : cell === null || other === null || cell.id !== other.id
                ? null
                : cell;
        }
        state.set(key, cell);
      }
      for (const node of block.statements) {
        context.checkpoint(1);
        const access = byNode.get(node.id);
        const key = access && (partSlot.get(node.id) ?? access.key);
        if (!access || !key || !eligible.has(key)) continue;
        if (access.node.kind === 'load') before.set(node.id, state.get(key));
        else state.set(key, access.node.value);
      }
      const old = outgoing.get(block.id);
      if (
        !old ||
        [...state].some(
          ([key, value]) =>
            old.get(key)?.id !== value?.id || (old.get(key) === null) !== (value === null),
        )
      ) {
        outgoing.set(block.id, state);
        changed = true;
      }
    }
  }
  const hidden = new Set<string>([...saveStores, ...saveReloads, ...returnAddressPushes]),
    privateLoads = new Set<string>(),
    locals = new Map<string, SourceLocal>();
  const saves: FrameSaves = { stores: saveStores, reloads: saveReloads, bytes: saveBytes };
  // An unchanged incoming slot is entry storage supplied by the caller, not a
  // byte array allocated by this function. Bind only exact, nonescaping accesses
  // to proven ABI scalar slots; partial/overlapping or modified storage retains
  // its ordered memory representation until a richer storage model is available.
  if (!escaped && facts?.state === 'complete')
    for (const group of groups.values()) {
      const first = group[0]!;
      if (
        classifyStackRegion(input.source!.abi, first.offset, first.end - first.offset) !==
          'incoming_candidate' ||
        group.some((access) => access.node.kind !== 'load' || access.node.access.volatile) ||
        accesses.some(
          (access) =>
            access.key !== first.key && access.offset < first.end && access.end > first.offset,
        ) ||
        memory.some((node) => node.kind === 'store' && !addresses.has(node.address.id))
      )
        continue;
      const loads = group.map((access) => access.node as Extract<Instruction, { kind: 'load' }>);
      if (
        loads.some(
          (node) =>
            !sameType(node.result.type, loads[0]!.result.type) ||
            node.access.endian !== input.source!.abi.layout.endian ||
            facts?.snapshots.get(node.id)?.aliased ||
            facts?.snapshots.get(node.id)?.escaped,
        )
      )
        continue;
      const value = incomingStack(
        first.offset,
        loads[0]!.result.type,
        loads.map((node) => node.result),
      );
      if (!value) continue;
      for (const node of loads) {
        hidden.add(node.id);
        alias(node.result, { kind: 'cast', op: 'bitcast', value });
      }
    }
  for (const key of eligible) {
    const group = groups.get(key)!,
      parts = slotParts.get(key) ?? [],
      members = parts.length ? [...group, ...parts] : group,
      loads = members.filter((access) => access.node.kind === 'load');
    if (loads.some((access) => before.get(access.node.id) === undefined)) continue;
    const forwarded =
      loads.every((access) => before.get(access.node.id) !== null) &&
      (acyclic ||
        members.every((access) => access.block === group[0]!.block) ||
        (view === 'source' &&
          !predecessors.get(input.function.entry)?.length &&
          members.every(
            (access) => access.node.kind !== 'store' || access.block === input.function.entry,
          )));
    // A part reads bits of the reaching whole-slot value; no scalar local
    // spelling exists for a part of an unforwarded slot.
    if (parts.length && !forwarded) continue;
    const first = group[0]!;
    // Byte significance of each part's low byte within the slot value.
    const shifts = new Map(
      parts.map((part) => [
        part.node.id,
        Number(
          part.node.access.endian === 'big' ? first.end - part.end : part.offset - first.offset,
        ),
      ]),
    );
    const subjects = [first.node.id];
    const checked = validation.check(
      'stack-promotion',
      `stack:${key}`,
      'private stack promotion',
      () => {
        const ids = new Set<string>(),
          proposed = new Map<string, Value>();
        for (const access of members) {
          validation.allowance.charge();
          ids.add(access.node.id);
          if (subjects.length < 64 && access.node.id !== subjects[0]) subjects.push(access.node.id);
          if (forwarded && access.node.kind === 'load')
            proposed.set(access.node.id, before.get(access.node.id)!);
        }
        return validateStackPromotion(
          `stack:${key}`,
          input.function.entry,
          blocks,
          transfers,
          addresses,
          ids,
          forwarded ? proposed : null,
          expressions,
          validation.allowance,
          disjointStores,
          shifts,
        );
      },
      subjects,
    );
    if (checked.status === 'rejected') continue;
    if (
      view === 'source' &&
      !(parts.length
        ? validation.presentation(
            'wide_slot_parts',
            `stack:${key}`,
            'exact nonvolatile negative entry-SP integer slot written only by whole-slot stores; every other overlapping access is a narrower integer load wholly inside it, forwarded as its endian-determined bit range of the reaching slot value; no frame address escapes; definitely initialized reads; no established outgoing argument overlap or access preceding an open-arity call',
            subjects,
          )
        : validation.presentation(
            'private_stack_promotion',
            `stack:${key}`,
            'exact nonvolatile nonoverlapping negative entry-SP slot; no frame address escapes; definitely initialized reads; no established outgoing argument overlap or access preceding an open-arity call',
            subjects,
          ))
    )
      continue;
    if (view === 'source' && (disjointStores?.size || callNodes.length))
      validation.requireAbi(
        'frame_private_to_activation',
        subjects,
        'Nonescaping frame-private storage belongs to this activation: pointers supplied by callers, globals, external loads and call results cannot alias it. Callees observe only declared argument storage; open-arity calls precede every access to this promoted slot. Original memory effects and alias facts remain in the checked view.',
      );
    if (forwarded) {
      for (const access of members) {
        hidden.add(access.node.id);
        if (access.node.kind !== 'load') continue;
        const shift = shifts.get(access.node.id);
        alias(
          access.node.result,
          shift === undefined
            ? { kind: 'cast', op: 'bitcast', value: before.get(access.node.id)! }
            : { kind: 'extract', value: before.get(access.node.id)!, offset: shift * 8 },
        );
      }
    } else {
      const local: SourceLocal = {
        id: `entity_${fingerprint(['source-local', input.function.id, key])}`,
        type: first.node.kind === 'load' ? first.node.result.type : first.node.value.type,
        ...(view === 'source' ? { stack_offset: first.offset } : {}),
      };
      for (const access of group) {
        locals.set(access.node.id, local);
        if (access.node.kind === 'load') privateLoads.add(access.node.id);
      }
    }
  }
  const dynamicStorage = memory.some(
    (node) => tainted.has(node.address.id) && !addresses.has(node.address.id),
  );
  const sharedEntry = escaped || aliased || dynamicStorage;
  const entryAddresses = new Set(
    accesses
      .filter(
        (access) =>
          !hidden.has(access.node.id) &&
          classifyStackRegion(input.source!.abi, access.offset, access.end - access.offset) !==
            'local_candidate',
      )
      .map((access) => access.node.address.id),
  );
  const entryStorage = sharedEntry || entryAddresses.size ? entryStack() : null;
  const requiresEntry = (id: string): boolean => sharedEntry || entryAddresses.has(id);
  if (entryStorage)
    for (const binding of entry.register_entry)
      if (
        binding.register.root === input.source!.abi.stack_pointer.root &&
        sameType(binding.value.type, entryStorage.type)
      )
        alias(binding.value, { kind: 'cast', op: 'bitcast', value: entryStorage });
  const returnAddressLoads = new Map<
    string,
    { node: Extract<Instruction, { kind: 'load' }>; block: string }
  >();
  for (const access of accesses)
    if (
      access.node.kind === 'load' &&
      !access.node.access.volatile &&
      access.offset === 0n &&
      access.end <= input.source!.abi.stack_return_address_bytes
    )
      returnAddressLoads.set(access.node.result.id, { node: access.node, block: access.block });
  const frame = (
    retained: ReadonlySet<string>,
    live: ReadonlySet<string>,
  ): SourceStackStorage | null => {
    const remaining = accesses.filter(
      (access) =>
        retained.has(access.node.id) && !hidden.has(access.node.id) && !locals.has(access.node.id),
    );
    let minimum = 0n,
      maximum = 0n;
    for (const access of remaining) {
      if (access.offset < minimum) minimum = access.offset;
      if (access.end > maximum) maximum = access.end;
    }
    // A pointer remains representable even after its private memory traffic dies.
    let addressLive = false;
    for (const [id, offset] of addresses)
      if (live.has(id)) {
        addressLive = true;
        if (offset < minimum) minimum = offset;
        if (offset >= maximum) maximum = offset + 1n;
      }
    return remaining.length || addressLive
      ? {
          ...(entryStorage && live.has(entryStorage.id)
            ? { kind: 'entry' as const, base: entryStorage, dynamic: dynamicStorage }
            : { kind: 'private' as const }),
          minimum_offset: minimum,
          size: maximum - minimum,
          alignment: input.source!.abi.layout.stack_alignment,
        }
      : null;
  };
  return {
    hidden,
    privateLoads,
    locals,
    addresses,
    returnAddressLoads,
    frame,
    entryStorage,
    requiresEntry,
    saves,
    deadReloadCandidates,
  };
}
