import type { AbiProfile, OperationContext } from '../core/index.js';
import type { EmissionInput } from '../emitters/model.js';
import { bitWidth, type Expression, type Instruction, type Value } from '../ir/index.js';
import type { BlockRegion, ControlArm, ParallelTransfer, Region } from '../presentation/index.js';
import type { FrameAccess } from './source-stack.js';

type Load = Extract<Instruction, { kind: 'load' }>;

/** The library declaration whose call ends a stack-protector failure path. */
export const STACK_PROTECTOR_CHECKER = '__stack_chk_fail';

export const STACK_PROTECTOR_PREMISE =
  'Omitting the stack protector assumes the program never writes or reads its frame outside the objects it addresses (out-of-bounds accesses are undefined behavior) and that the guard word does not change during the activation: the canary slot then holds the guard value at every check, so every check passes and its failure path, a call of the noreturn __stack_chk_fail, never executes. The canary store, the guard and canary loads, the checks and the failure paths remain in the checked view and the original mappings.';

/** Source view: a proven stack-protector canary of one frame slot. */
export interface StackProtector {
  /** Entry-SP offset of the canary slot. */
  readonly offset: bigint;
  /** The prologue store of the guard value into the slot. */
  readonly store: string;
  /** The guard loads, the canary reloads and the loads of their guard
   * addresses: the only readers of these values are the store and the checks. */
  readonly loads: ReadonlySet<string>;
  /** Check controls (`if`) -> the block entered when the canary is intact. */
  readonly guards: ReadonlyMap<string, string>;
  /** Failure blocks and the unexecuted blocks entered only from them. */
  readonly omitted: ReadonlySet<string>;
}

/** Value of `value` seen through same-width bitcasts and the ordered
 * concatenation of extracts that tile one value (register-cell halves). */
function whole(value: Value, expressions: ReadonlyMap<string, Expression>, depth = 0): Value {
  if (depth >= 8) return value;
  const expression = expressions.get(value.id);
  if (
    expression?.kind === 'cast' &&
    expression.op === 'bitcast' &&
    bitWidth(expression.value.type) === bitWidth(value.type)
  )
    return whole(expression.value, expressions, depth + 1);
  if (expression?.kind === 'concat') {
    let base: Value | null = null,
      width = 0;
    for (const part of expression.values) {
      const piece = expressions.get(part.id);
      if (
        piece?.kind !== 'extract' ||
        piece.offset !== width ||
        (base !== null && base.id !== piece.value.id)
      )
        return value;
      base = piece.value;
      width += bitWidth(part.type);
    }
    return base && width === bitWidth(base.type) && width === bitWidth(value.type)
      ? whole(base, expressions, depth + 1)
      : value;
  }
  return value;
}

const constantBits = (
  value: Value,
  expressions: ReadonlyMap<string, Expression>,
): bigint | undefined => {
  const expression = expressions.get(value.id);
  return expression?.kind === 'constant'
    ? BigInt.asUintN(bitWidth(value.type), expression.bits)
    : undefined;
};

/** A one-bit condition that is exactly `left != right` (`differ`) or
 * `left == right`, through comparisons with zero of their difference or
 * exclusive or, the zero flag of their subtraction, logical negations and
 * one-bit flag words assembled by `insert` (an AArch64 NZCV value). */
export function equalityTest(
  condition: Value,
  expressions: ReadonlyMap<string, Expression>,
  context: OperationContext,
): { differ: boolean; left: Value; right: Value } | null {
  const flip = (test: ReturnType<typeof equalityTest>): ReturnType<typeof equalityTest> =>
    test && { ...test, differ: !test.differ };
  // Bit `offset` of `value`, resolved through inserts and same-width bitcasts.
  const bit = (value: Value, offset: number, depth: number): ReturnType<typeof equalityTest> => {
    context.checkpoint(1);
    if (depth >= 32) return null;
    const expression = expressions.get(value.id);
    if (bitWidth(value.type) === 1 && offset === 0) return test(value, depth + 1);
    if (
      expression?.kind === 'cast' &&
      expression.op === 'bitcast' &&
      bitWidth(expression.value.type) === bitWidth(value.type)
    )
      return bit(expression.value, offset, depth + 1);
    if (expression?.kind === 'insert') {
      const width = bitWidth(expression.value.type);
      if (offset >= expression.offset && offset < expression.offset + width)
        return bit(expression.value, offset - expression.offset, depth + 1);
      return bit(expression.base, offset, depth + 1);
    }
    if (expression?.kind === 'extract')
      return bit(expression.value, offset + expression.offset, depth + 1);
    return null;
  };
  // Operands whose difference is zero exactly when they are equal.
  const pair = (value: Value): { left: Value; right: Value } | null => {
    const expression = expressions.get(value.id);
    return expression?.kind === 'integer' && (expression.op === 'sub' || expression.op === 'xor')
      ? { left: expression.left, right: expression.right }
      : null;
  };
  const test = (value: Value, depth: number): ReturnType<typeof equalityTest> => {
    context.checkpoint(1);
    if (depth >= 32 || bitWidth(value.type) !== 1) return null;
    const expression = expressions.get(value.id);
    if (!expression) return null;
    switch (expression.kind) {
      case 'cast':
        return expression.op === 'bitcast' && bitWidth(expression.value.type) === 1
          ? test(expression.value, depth + 1)
          : null;
      case 'integer_unary':
        return expression.op === 'not' ? flip(test(expression.value, depth + 1)) : null;
      case 'integer':
        if (expression.op !== 'xor') return null;
        if (constantBits(expression.right, expressions) === 1n)
          return flip(test(expression.left, depth + 1));
        if (constantBits(expression.left, expressions) === 1n)
          return flip(test(expression.right, depth + 1));
        return null;
      case 'extract':
        return bit(expression.value, expression.offset, depth + 1);
      case 'flag':
        return expression.op === 'sub' &&
          expression.flag === 'zero' &&
          constantBits(expression.carry, expressions) === 0n
          ? { differ: false, left: expression.left, right: expression.right }
          : null;
      case 'compare': {
        if (expression.op !== 'eq' && expression.op !== 'ne') return null;
        const differ = expression.op === 'ne';
        for (const [operand, other] of [
          [expression.left, expression.right],
          [expression.right, expression.left],
        ] as const) {
          const constant = constantBits(other, expressions);
          if (constant === undefined) continue;
          if (bitWidth(operand.type) === 1 && (constant === 0n || constant === 1n)) {
            const inner = test(operand, depth + 1);
            // `b == 0` and `b != 1` negate `b`.
            return (constant === 0n) === differ ? inner : flip(inner);
          }
          if (constant === 0n) {
            const found = pair(operand);
            if (found) return { differ, ...found };
          }
        }
        return { differ, left: expression.left, right: expression.right };
      }
      default:
        return null;
    }
  };
  return test(condition, 0);
}

/** Source view: stack-protector canaries (`-fstack-protector*`). A frame slot
 * qualifies when (i) its only store writes the whole value of a load of a
 * guard word (ELF `fs:0x28`, Darwin `___stack_chk_guard`) and that store
 * dominates every other access, (ii) every other access is an exact reload of
 * the slot whose block ends in a check, an `if` whose condition is exactly the
 * equality of that reload with a second load of the same guard address
 * (the same address value, the same constant offset from one base, or a
 * load of one loader-bound import slot), (iii) the arm taken when they differ
 * is a block entered only from the check that executes nothing observable
 * before a call of the established noreturn library declaration
 * `__stack_chk_fail` (only pure assignments and hidden return-address pushes),
 * and every block after it is entered only from such blocks, (iv) no other
 * access overlaps the slot, no frame address of unknown offset exists, no
 * escaped base designates it and it is no established argument storage. */
export function classifyStackProtector(
  facts: {
    readonly input: EmissionInput;
    readonly blocks: ReadonlyMap<string, BlockRegion>;
    readonly expressions: ReadonlyMap<string, Expression>;
    readonly transfers: readonly { transfer: ParallelTransfer; block: BlockRegion }[];
    readonly accesses: readonly FrameAccess[];
    readonly groups: ReadonlyMap<string, readonly FrameAccess[]>;
    /** Entry-SP offsets of the address values that have one. */
    readonly addresses: ReadonlyMap<string, bigint>;
    readonly exposedOffsets: ReadonlySet<bigint>;
    readonly outgoingRanges: readonly { readonly start: bigint; readonly end: bigint }[];
    /** Return-address pushes hidden as call mechanics. */
    readonly pushes: ReadonlySet<string>;
    readonly dominates: (first: FrameAccess, second: FrameAccess) => boolean;
    readonly abi: AbiProfile;
  },
  context: OperationContext,
): StackProtector[] {
  const { input, blocks, expressions, addresses, abi } = facts;
  const pointerBytes = BigInt(abi.layout.pointer_bits / 8);
  const loads = new Map<string, { node: Load; block: string }>();
  for (const block of blocks.values())
    for (const node of block.statements)
      if (node.kind === 'load') loads.set(node.result.id, { node, block: block.id });
  // Loader-bound import slots (written by the dynamic linker alone).
  const importSlots = new Set<bigint>();
  for (const item of input.source?.addresses ?? [])
    if (item.import) importSlots.add(item.address.value);
  // Import-slot loads `same` matched for the slot being examined.
  let guardLoads = new Set<string>();
  // The same address on every execution: one value, one constant offset from
  // one base, or a pointer-width load of one loader-bound import slot.
  const same = (first: Value, second: Value, depth = 0): boolean => {
    context.checkpoint(1);
    const left = whole(first, expressions),
      right = whole(second, expressions);
    if (left.id === right.id) return true;
    if (depth >= 8 || bitWidth(left.type) !== bitWidth(right.type)) return false;
    const a = expressions.get(left.id),
      b = expressions.get(right.id);
    if (a?.kind === 'constant' && b?.kind === 'constant')
      return constantBits(left, expressions) === constantBits(right, expressions);
    if (a?.kind === 'address' && b?.kind === 'address')
      return a.address.image_id === b.address.image_id && a.address.value === b.address.value;
    if (a?.kind === 'integer' && b?.kind === 'integer' && a.op === 'add' && b.op === 'add') {
      const offset = (expression: typeof a) =>
        constantBits(expression.right, expressions) ?? constantBits(expression.left, expressions);
      const base = (expression: typeof a) =>
        constantBits(expression.right, expressions) !== undefined
          ? expression.left
          : expression.right;
      const first = offset(a),
        second = offset(b);
      return first !== undefined && first === second && same(base(a), base(b), depth + 1);
    }
    const x = loads.get(left.id),
      y = loads.get(right.id);
    if (!x || !y || x.node.access.volatile || y.node.access.volatile) return false;
    const slot = constantBits(x.node.address, expressions);
    if (
      slot === undefined ||
      !importSlots.has(slot) ||
      bitWidth(left.type) !== abi.layout.pointer_bits ||
      constantBits(y.node.address, expressions) !== slot
    )
      return false;
    guardLoads.add(x.node.id);
    guardLoads.add(y.node.id);
    return true;
  };
  // Calls of the established noreturn `__stack_chk_fail` declaration.
  const evidence = new Map((input.types?.evidence ?? []).map((record) => [record.id, record]));
  const checkers = new Set<string>();
  for (const call of input.types?.calls?.calls ?? [])
    if (
      call.noreturn === 'yes' &&
      call.status === 'established' &&
      call.contracts.length &&
      call.contracts.every(
        (observation) =>
          observation.status === 'established' &&
          observation.contract.noreturn === true &&
          observation.contract.evidence_ids.some((id) => {
            const origin = evidence.get(id)?.origin;
            return origin?.kind === 'library' && origin.contract === STACK_PROTECTOR_CHECKER;
          }),
      )
    )
      checkers.add(call.node_id);
  const predecessors = new Map<string, string[]>(),
    successors = new Map<string, string[]>();
  for (const { transfer, block } of facts.transfers) {
    predecessors.set(transfer.target, [...(predecessors.get(transfer.target) ?? []), block.id]);
    successors.set(block.id, [...(successors.get(block.id) ?? []), transfer.target]);
  }
  // A failure block: entered only from `guard`, nothing observable before the
  // checker call (pure assignments and hidden return-address pushes).
  const failure = (id: string, guard: string): boolean => {
    const block = blocks.get(id),
      entered = predecessors.get(id) ?? [];
    if (!block || id === input.function.entry || entered.length !== 1 || entered[0] !== guard)
      return false;
    for (const node of block.statements) {
      context.checkpoint(1);
      if (node.kind === 'call') return checkers.has(node.id);
      if (node.kind !== 'assign' && !facts.pushes.has(node.id)) return false;
    }
    return false;
  };
  const found: StackProtector[] = [];
  if (!checkers.size) return found;
  const claimed = new Set<string>();
  for (const [key, group] of facts.groups) {
    context.checkpoint(group.length);
    const first = group[0]!;
    const stores = group.filter((access) => access.node.kind === 'store'),
      reloads = group.filter((access) => access.node.kind === 'load');
    const save = stores[0];
    if (
      stores.length !== 1 ||
      !reloads.length ||
      !save ||
      save.node.kind !== 'store' ||
      first.offset >= 0n ||
      first.end > 0n ||
      first.end - first.offset !== pointerBytes ||
      facts.pushes.has(save.node.id) ||
      group.some((access) => access.node.access.volatile) ||
      facts.accesses.some(
        (access) => access.key !== key && access.offset < first.end && access.end > first.offset,
      ) ||
      [...facts.exposedOffsets].some((offset) => offset >= first.offset && offset < first.end) ||
      facts.outgoingRanges.some((range) => range.start < first.end && range.end > first.offset)
    )
      continue;
    const guard = loads.get(whole(save.node.value, expressions).id);
    if (
      !guard ||
      guard.node.access.volatile ||
      addresses.has(guard.node.address.id) ||
      bitWidth(guard.node.result.type) !== abi.layout.pointer_bits
    )
      continue;
    guardLoads = new Set<string>();
    const hidden = new Set<string>([guard.node.id]),
      guards = new Map<string, string>(),
      failures: string[] = [];
    let valid = true;
    for (const reload of reloads) {
      const block = blocks.get(reload.block)!,
        control = block.control;
      const test =
        control.kind === 'if' ? equalityTest(control.condition, expressions, context) : null;
      if (
        !facts.dominates(save, reload) ||
        !test ||
        control.kind !== 'if' ||
        guards.has(control.id)
      ) {
        valid = false;
        break;
      }
      const reloaded = (reload.node as Load).result.id;
      const left = whole(test.left, expressions),
        right = whole(test.right, expressions);
      const other = left.id === reloaded ? right : right.id === reloaded ? left : null;
      const second = other && loads.get(other.id);
      if (
        !second ||
        second.node.access.volatile ||
        bitWidth(second.node.result.type) !== abi.layout.pointer_bits ||
        !same(guard.node.address, second.node.address)
      ) {
        valid = false;
        break;
      }
      // `differ` true: the condition holds when the canary changed.
      const [failing, kept]: [ControlArm, ControlArm] = test.differ
        ? [control.when_true, control.when_false]
        : [control.when_false, control.when_true];
      if (!failure(failing.transfer.target, block.id)) {
        valid = false;
        break;
      }
      hidden.add(reload.node.id);
      hidden.add(second.node.id);
      guards.set(control.id, kept.transfer.target);
      failures.push(failing.transfer.target);
    }
    if (!valid) continue;
    // The failure blocks and every block entered only from omitted blocks;
    // no omitted block may lead anywhere else.
    const omitted = new Set(failures);
    for (let grown = true; grown;) {
      grown = false;
      for (const [id, entered] of predecessors) {
        context.checkpoint(1);
        if (
          !omitted.has(id) &&
          id !== input.function.entry &&
          entered.every((source) => omitted.has(source))
        ) {
          omitted.add(id);
          grown = true;
        }
      }
    }
    if (
      [...omitted].some(
        (id) => claimed.has(id) || (successors.get(id) ?? []).some((next) => !omitted.has(next)),
      )
    )
      continue;
    for (const id of omitted) claimed.add(id);
    found.push({
      offset: first.offset,
      store: save.node.id,
      loads: new Set([...hidden, ...guardLoads]),
      guards,
      omitted,
    });
  }
  return found;
}

/** The region tree without the omitted checks: each check becomes a jump to
 * its kept block, failure blocks print nothing. */
export function omitStackProtector(
  region: Region,
  guards: ReadonlyMap<string, string>,
  omitted: ReadonlySet<string>,
  context: OperationContext,
): Region {
  if (!guards.size) return region;
  const rewrite = (region: Region): Region => {
    context.checkpoint(1);
    if (region.kind === 'sequence') {
      const regions = region.regions
        .map(rewrite)
        .filter((child) => child.kind !== 'sequence' || child.regions.length > 0);
      return regions.length === 1 ? regions[0]! : { ...region, regions };
    }
    if (region.kind === 'loop') return { ...region, body: rewrite(region.body) };
    if (omitted.has(region.id)) return { kind: 'sequence', regions: [] };
    const control = region.control;
    const kept = control.kind === 'if' ? guards.get(control.id) : undefined;
    if (control.kind === 'if' && kept !== undefined) {
      const [yes, no] =
        control.when_true.transfer.target === kept
          ? [control.when_true, control.when_false]
          : [control.when_false, control.when_true];
      const block: Region = {
        ...region,
        control: {
          kind: 'jump',
          id: control.id,
          provenance: control.provenance,
          effect: control.effect,
          transfer: yes.transfer,
        },
      };
      // Blocks laid out after the failure block in its arm are entered by labels only.
      const regions = [
        block,
        ...[no.body, yes.body].flatMap((item) => (item ? [rewrite(item)] : [])),
      ].filter((child) => child.kind !== 'sequence' || child.regions.length > 0);
      return regions.length === 1 ? block : { kind: 'sequence', regions };
    }
    const arm = (item: ControlArm): ControlArm =>
      item.body ? { ...item, body: rewrite(item.body) } : item;
    return control.kind === 'if'
      ? {
          ...region,
          control: {
            ...control,
            when_true: arm(control.when_true),
            when_false: arm(control.when_false),
          },
        }
      : control.kind === 'switch'
        ? {
            ...region,
            control: {
              ...control,
              cases: control.cases.map((item) => ({ ...item, arm: arm(item.arm) })),
              otherwise: arm(control.otherwise),
            },
          }
        : region;
  };
  return rewrite(region);
}
