import type { OperationContext } from '../core/index.js';
import type { TypeRecoveryResult } from '../analysis/types/index.js';
import { bitWidth, expressionOperands, type Value } from '../ir/index.js';
import type { ParallelTransfer, Region } from '../presentation/index.js';
import type { Reconstruction } from './model.js';

type Role = 'address' | 'callback' | 'count' | 'index' | 'accumulator' | 'shift_count' | 'limit';
const roleBits: Record<Role, number> = {
  address: 1,
  callback: 2,
  count: 4,
  index: 8,
  accumulator: 16,
  shift_count: 32,
  limit: 64,
};
const roleNames = new Map<number, Role>(
  (Object.keys(roleBits) as Role[]).map((role): [number, Role] => [roleBits[role], role]),
);
/** Every identifier stem a role can print as, and the generic stems a value
 * takes from its definition alone; a role outranks a generic name. */
export const sourceRoleStems: ReadonlySet<string> = new Set([
  ...Object.keys(roleBits),
  'remaining',
]);
export const sourceGenericStems: ReadonlySet<string> = new Set([
  'condition',
  'call_result',
  'element',
  'result',
]);
const reservedWord =
  /^(?:auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|restrict|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while|_Alignas|_Alignof|_Atomic|_Bool|_Complex|_Generic|_Imaginary|_Noreturn|_Static_assert|_Thread_local|False|None|True|and|as|assert|async|await|class|def|del|elif|except|finally|from|global|import|in|is|lambda|nonlocal|not|or|pass|raise|try|with|yield|bool|memory|label|pointer|address_of|field_view|stack_slot|stack_storage|data_address|read_memory|write_memory|uint\d+|int\d+|uint\d+_t|int\d+_t|bits\d+_t|ieee\d+_t)$/;
const reservedRuntimeName =
  /^(?:entry_sp|stack_frame|true|false|NULL|U?INT\d+_(?:MAX|MIN|C)|extract_bits|insert_bits|concat_low_first|signed_value|wrap|read_register|write_register|image_address|boundary|explicit_values)$/;
const reservedRuntimePrefix =
  /^(?:__|bv_|fp_|cast_|vector_|flag_|memory_|unknown_|physical_|source_|type_|transfer_|requirement_)/;

export interface SourceNamePlan {
  /** Preferred name per value or local; null where independent roles conflict. */
  readonly names: ReadonlyMap<string, string | null>;
  /** Source view: every loop header phi. A header phi is a loop-carried variable
   * of its own; it shares a role only when its own loop analysis proves it. */
  readonly carried: ReadonlySet<string>;
  /** Source view: value copied into a loop header phi on entry to its loop ->
   * that header phi. Printed as the same variable, it is the initial value. */
  readonly initial: ReadonlyMap<string, string>;
}

/** Presentation-only suggestions: no source intent, type, identity or expression
 * is inferred from an identifier. Conflicting independent roles stay neutral.
 * `refined` (the source view) additionally recognizes loop-carried phi webs and
 * promoted-slot recurrences; the checked view keeps the direct-copy rule only. */
export function planSourceNames(
  program: Reconstruction,
  supplied: ReadonlyMap<string, string | null>,
  types: TypeRecoveryResult | undefined,
  context: OperationContext,
  refined: boolean,
): SourceNamePlan {
  const carried = new Set<string>(),
    initial = new Map<string, string>();
  if (!program.source) return { names: new Map(), carried, initial };
  const parameters = new Set(program.parameters.map((value) => value.id));
  const links = new Map<string, { value: Value; sameWidth: boolean }[]>();
  const storageLinks = new Map<string, string[]>();
  const roles = new Map<string, number>();
  const queue: { value: Value; role: Role }[] = [];
  const decreasing = new Set<string>();
  const generic = new Map<string, string>();
  const loaded = new Map<string, Value>();
  const link = (left: Value, right: Value, storage: boolean): void => {
    for (const [from, to] of [
      [left, right],
      [right, left],
    ] as const) {
      const row = links.get(from.id) ?? [];
      row.push({ value: to, sameWidth: bitWidth(from.type) === bitWidth(to.type) });
      links.set(from.id, row);
      if (storage) {
        const aliases = storageLinks.get(from.id) ?? [];
        aliases.push(to.id);
        storageLinks.set(from.id, aliases);
      }
    }
  };
  const canonical = (input: Value, numeric: boolean): Value => {
    const seen = new Set<string>();
    let value = input;
    while (!seen.has(value.id)) {
      context.checkpoint(1);
      seen.add(value.id);
      const expression = program.expressions.get(value.id);
      const source =
        expression?.kind === 'cast' &&
        ['bitcast', 'truncate', 'zero_extend', 'sign_extend'].includes(expression.op)
          ? expression.value
          : expression?.kind === 'extract' && expression.offset === 0
            ? expression.value
            : null;
      if (!source || (!numeric && bitWidth(source.type) !== bitWidth(value.type))) break;
      value = source;
    }
    return value;
  };
  /** `spread` hands the role to every copy and cast linked to `value`. Loop roles
   * in the source view never spread: a copy of a counter is not the counter. */
  const mark = (value: Value, role: Role, spread = true): void => {
    const expression = program.expressions.get(value.id);
    if (expression?.kind === 'constant' || expression?.kind === 'address') return;
    const before = roles.get(value.id) ?? 0;
    if (before & roleBits[role]) return;
    roles.set(value.id, before | roleBits[role]);
    if (spread) queue.push({ value, role });
  };
  let cursor = 0;
  const propagate = (): void => {
    while (cursor < queue.length) {
      context.checkpoint(1);
      const { value, role } = queue[cursor++]!;
      for (const next of links.get(value.id) ?? [])
        if (next.sameWidth || (role !== 'address' && role !== 'callback')) mark(next.value, role);
    }
  };
  for (const [id, expression] of program.expressions) {
    context.checkpoint(1);
    const value = program.values.get(id)!;
    if (
      expression.kind === 'cast' &&
      ['bitcast', 'truncate', 'zero_extend', 'sign_extend'].includes(expression.op)
    )
      link(value, expression.value, true);
    else if (expression.kind === 'extract' && expression.offset === 0)
      link(value, expression.value, true);
    if (!program.live.has(id)) continue;
    if (expression.kind === 'compare' || expression.kind === 'float_compare')
      generic.set(id, 'condition');
    if (
      expression.kind === 'integer' &&
      ['shl', 'lshr', 'ashr', 'rol', 'ror'].includes(expression.op)
    ) {
      let count = canonical(expression.right, true);
      const mask = program.expressions.get(count.id);
      if (mask?.kind === 'integer' && mask.op === 'and') {
        const left = program.expressions.get(mask.left.id),
          right = program.expressions.get(mask.right.id);
        if (right?.kind === 'constant') count = mask.left;
        else if (left?.kind === 'constant') count = mask.right;
      }
      mark(count, 'shift_count');
    }
  }
  const sources = new Map<ParallelTransfer, string>(),
    successors = new Map<string, string[]>();
  for (const block of program.blocks.values()) {
    const control = block.control;
    const transfers =
      control.kind === 'jump'
        ? [control.transfer]
        : control.kind === 'if'
          ? [control.when_true.transfer, control.when_false.transfer]
          : control.kind === 'switch'
            ? [...control.cases.map((item) => item.arm.transfer), control.otherwise.transfer]
            : [];
    for (const transfer of transfers) sources.set(transfer, block.id);
    successors.set(
      block.id,
      transfers.map((transfer) => transfer.target),
    );
    for (const node of block.statements) {
      context.checkpoint(1);
      if (!program.retained.has(node.id)) continue;
      if (node.kind === 'load' || node.kind === 'store') {
        let address = canonical(node.address, false);
        mark(address, 'address');
        const seen = new Set<string>();
        while (!seen.has(address.id)) {
          seen.add(address.id);
          const expression = program.expressions.get(address.id);
          if (
            expression?.kind !== 'integer' ||
            !['add', 'sub'].includes(expression.op) ||
            program.expressions.get(expression.right.id)?.kind !== 'constant'
          )
            break;
          address = canonical(expression.left, false);
          mark(address, 'address');
        }
        if (node.kind === 'load') loaded.set(canonical(node.result, true).id, node.result);
      }
      if (node.kind === 'call') {
        if (node.target.kind === 'indirect') mark(node.target.value, 'callback');
        for (const result of program.calls.get(node.id)?.results ?? [])
          generic.set(result.id, 'call_result');
      }
    }
    if (control.kind === 'indirect' && control.tail_call) mark(control.target, 'callback');
  }
  for (const copies of program.transfers.values())
    for (const copy of copies) link(copy.destination, copy.source, false);
  // Source pointer interpretations are established by the shared type projection,
  // not by register spelling, architectural width or an author's guessed name.
  for (const [id, view] of program.source.value_types ?? [])
    if (
      (program.live.has(id) || parameters.has(id)) &&
      types?.types.some(
        (record) => record.id === view.type_id && record.definition.kind === 'pointer',
      )
    ) {
      const value = program.values.get(id);
      if (value) mark(value, 'address');
    }
  propagate();

  const loops = new Map<string, Set<string>>();
  const pending: { region: Region; active: readonly string[] }[] = [
    { region: program.function.body, active: [] },
  ];
  while (pending.length) {
    context.checkpoint(1);
    const { region, active } = pending.pop()!;
    if (region.kind === 'block') {
      for (const header of active) loops.get(header)!.add(region.id);
      const control = region.control;
      const arms =
        control.kind === 'if'
          ? [control.when_true, control.when_false]
          : control.kind === 'switch'
            ? [...control.cases.map((item) => item.arm), control.otherwise]
            : [];
      for (const arm of arms) if (arm.body) pending.push({ region: arm.body, active });
    } else if (region.kind === 'sequence') {
      for (const child of region.regions) pending.push({ region: child, active });
    } else {
      loops.set(region.header, new Set());
      pending.push({ region: region.body, active: [...active, region.header] });
    }
  }
  const dependsOn = (root: Value, targets: ReadonlySet<string>): boolean => {
    const todo = [root],
      seen = new Set<string>();
    while (todo.length) {
      context.checkpoint(1);
      const value = todo.pop()!;
      if (targets.has(value.id)) return true;
      if (seen.has(value.id)) continue;
      seen.add(value.id);
      const expression = program.expressions.get(value.id);
      if (expression) todo.push(...expressionOperands(expression));
    }
    return false;
  };
  const loopTests = new Map<string, Map<string, Value[]>>();
  for (const [header, members] of loops) {
    const tests = new Map<string, Value[]>();
    for (const id of members) {
      context.checkpoint(1);
      const control = program.blocks.get(id)!.control;
      if (
        control.kind !== 'if' ||
        members.has(control.when_true.transfer.target) ===
          members.has(control.when_false.transfer.target)
      )
        continue;
      const condition = program.expressions.get(canonical(control.condition, true).id);
      if (condition?.kind !== 'compare') continue;
      const left = canonical(condition.left, true),
        right = canonical(condition.right, true);
      for (const [value, bound] of [
        [left, right],
        [right, left],
      ] as const) {
        const row = tests.get(value.id) ?? [];
        row.push(bound);
        tests.set(value.id, row);
      }
    }
    loopTests.set(header, tests);
  }
  /** Name of each promoted slot from its loop analyses; null when they disagree. */
  const slotNames = new Map<string, string | null>();
  if (refined) {
    // Loop-carried variables. A variable is either a phi web (header phi plus the
    // merge phis/selects that feed its back edge) or a promoted stack slot (all of
    // its loads, whose stores in the loop are the updates). Roles come only from
    // the shape of the update: constant step, or an associative integer/IEEE
    // operation whose other operand is not itself a function of the variable.
    const incoming = new Map<string, Value[]>(),
      definedIn = new Map<string, string>();
    for (const [transfer, copies] of program.transfers)
      for (const copy of copies) {
        context.checkpoint(1);
        const destination = canonical(copy.destination, true);
        const row = incoming.get(destination.id) ?? [];
        row.push(canonical(copy.source, true));
        incoming.set(destination.id, row);
        definedIn.set(destination.id, transfer.target);
      }
    for (const block of program.blocks.values())
      for (const node of block.statements) {
        if (node.kind === 'assign' || node.kind === 'load')
          definedIn.set(canonical(node.result, true).id, block.id);
        else if (node.kind === 'call')
          for (const result of node.results) definedIn.set(canonical(result, true).id, block.id);
      }
    const slotLoads = new Map<string, Value[]>(),
      slotStores = new Map<string, { block: string; value: Value }[]>();
    for (const block of program.blocks.values())
      for (const node of block.statements) {
        const local = program.source.locals.get(node.id);
        if (!local || !program.retained.has(node.id)) continue;
        if (node.kind === 'load') {
          const row = slotLoads.get(local.id) ?? [];
          row.push(canonical(node.result, true));
          slotLoads.set(local.id, row);
        } else if (node.kind === 'store') {
          const row = slotStores.get(local.id) ?? [];
          row.push({ block: block.id, value: canonical(node.value, true) });
          slotStores.set(local.id, row);
        }
      }
    const slotOf = new Map<string, string>();
    for (const [id, loads] of slotLoads) for (const load of loads) slotOf.set(load.id, id);
    /** True when `root` is the same on every iteration of the loop with `members`:
     * parameters, values defined outside it, pure expressions of such values and
     * reloads of slots the loop never stores to. */
    const invariant = (root: Value, members: ReadonlySet<string>): boolean => {
      const todo = [root],
        seen = new Set<string>();
      while (todo.length) {
        context.checkpoint(1);
        const value = todo.pop()!;
        if (seen.has(value.id)) continue;
        seen.add(value.id);
        const slot = slotOf.get(value.id);
        if (slot !== undefined) {
          if ((slotStores.get(slot) ?? []).some((store) => members.has(store.block))) return false;
          continue;
        }
        const block = definedIn.get(value.id);
        if (block === undefined || !members.has(block)) continue;
        const expression = program.expressions.get(value.id);
        if (!expression || incoming.has(value.id)) return false;
        todo.push(...expressionOperands(expression));
      }
      return true;
    };
    type Update =
      | { kind: 'step'; step: bigint }
      | { kind: 'fold'; other: Value; chain: readonly Value[] }
      | { kind: 'opaque' };
    const foldOps: Record<string, true> = { add: true, mul: true, and: true, or: true, xor: true };
    /** Classifies `update` as a recurrence on the `web` members, or opaque. An
     * unrolled fold is a chain `t1 = web ⊕ a; t2 = t1 ⊕ b; update = t2 ⊕ c` of one
     * associative operation family whose other operands do not depend on the web;
     * every link of the chain is a running value of the same fold. */
    const classify = (update: Value, web: ReadonlySet<string>): Update => {
      const chain: Value[] = [];
      let current = update,
        family: string | undefined;
      for (;;) {
        context.checkpoint(1);
        const expression = program.expressions.get(current.id);
        if (expression?.kind !== 'integer' && expression?.kind !== 'float')
          return { kind: 'opaque' };
        const left = canonical(expression.left, true),
          right = canonical(expression.right, true);
        const selfLeft = web.has(left.id),
          selfRight = web.has(right.id);
        if (selfLeft && selfRight) return { kind: 'opaque' };
        if (expression.op === 'sub' ? !selfLeft && !dependsOn(left, web) : !foldOps[expression.op])
          return { kind: 'opaque' };
        const kind = `${expression.kind}:${expression.op === 'sub' ? 'add' : expression.op}`;
        if (family !== undefined && family !== kind) return { kind: 'opaque' };
        family = kind;
        chain.push(current);
        if (!selfLeft && !selfRight) {
          // Step into the operand carrying the recurrence; the other must be free of it.
          const inLeft = dependsOn(left, web),
            inRight = dependsOn(right, web);
          if (inLeft === inRight || (expression.op === 'sub' && !inLeft)) return { kind: 'opaque' };
          current = inLeft ? left : right;
          continue;
        }
        if (expression.op === 'sub' && !selfLeft) return { kind: 'opaque' };
        const other = selfLeft ? right : left,
          constant = program.expressions.get(other.id);
        if (constant?.kind === 'constant') {
          if (
            chain.length > 1 ||
            expression.kind !== 'integer' ||
            (expression.op !== 'add' && expression.op !== 'sub')
          )
            return { kind: 'opaque' };
          const width = bitWidth(update.type);
          const step = BigInt.asIntN(
            width,
            expression.op === 'sub' ? -constant.bits : constant.bits,
          );
          return step === 0n ? { kind: 'opaque' } : { kind: 'step', step };
        }
        return dependsOn(other, web) ? { kind: 'opaque' } : { kind: 'fold', other, chain };
      }
    };
    /** Values an address is computed from: every operand, through any arithmetic,
     * of a retained load or store address. */
    const subscripts = new Set<string>();
    for (const block of program.blocks.values())
      for (const node of block.statements) {
        if ((node.kind !== 'load' && node.kind !== 'store') || !program.retained.has(node.id))
          continue;
        const todo = [node.address];
        while (todo.length) {
          context.checkpoint(1);
          const value = todo.pop()!;
          if (subscripts.has(value.id)) continue;
          subscripts.add(value.id);
          const expression = program.expressions.get(value.id);
          if (expression) todo.push(...expressionOperands(expression));
        }
      }
    /** True when every path from `header` back to it inside the loop passes
     * through one of `blocks`. */
    const everyIteration = (header: string, blocks: ReadonlySet<string>): boolean => {
      const members = loops.get(header)!,
        todo = [header],
        seen = new Set<string>();
      while (todo.length) {
        context.checkpoint(1);
        const id = todo.pop()!;
        if (seen.has(id) || blocks.has(id)) continue;
        seen.add(id);
        for (const next of successors.get(id) ?? []) {
          if (next === header) return false;
          if (members.has(next)) todo.push(next);
        }
      }
      return true;
    };
    const pendingBounds: { bound: Value; role: Role }[] = [];
    /** `id` and every same-width cast or extract linked to it: a reinterpretation
     * prints the same value under another type; it is not a copy. */
    const reinterpretations = (id: string): string[] => {
      const width = bitWidth(program.values.get(id)!.type),
        found = [id],
        seen = new Set(found);
      for (let at = 0; at < found.length; at++)
        for (const next of storageLinks.get(found[at]!) ?? []) {
          context.checkpoint(1);
          if (seen.has(next) || bitWidth(program.values.get(next)!.type) !== width) continue;
          seen.add(next);
          found.push(next);
        }
      return found;
    };
    /** Classifies one loop-carried variable. A phi web is `seed` = the header phi
     * with its back-edge values `starts` and entry values `entries`; a promoted
     * slot is `seed` = its loads and `slot` = its local, whose stores in the loop
     * are `starts`. Definitions:
     * - index / count: every update is the same nonzero constant step and runs on
     *   every iteration (no path from the header to a back edge leaves the
     *   variable unchanged); a decreasing count prints as `remaining`. The
     *   invariant bound of an index is its count (unit step) or limit, and a
     *   parameter a unit countdown starts from is the count.
     * - accumulator: every update is one associative operation with an operand
     *   free of the variable, possibly guarded, and no running value is part of an
     *   address or compared with a varying bound in a loop test.
     * A path resetting the variable to a constant, an opaque update, or an
     * address/callback use leaves it neutral. Only the variable itself (its phi
     * web and the update values its back edges carry, with their same-width
     * reinterpretations, or the slot) is named: the intermediate running values
     * of an unrolled chain and copies stay neutral. */
    const analyze = (
      header: string,
      seed: ReadonlySet<string>,
      starts: readonly Value[],
      slot?: string,
      entries: readonly Value[] = [],
    ): void => {
      const members = loops.get(header)!;
      const web = new Set(seed),
        leaves: Value[] = [],
        seen = new Set<string>(),
        todo = [...starts];
      let unchanged = false;
      while (todo.length) {
        context.checkpoint(1);
        const value = todo.pop()!;
        if (seed.has(value.id)) unchanged = true;
        if (seen.has(value.id)) continue;
        seen.add(value.id);
        if (web.has(value.id)) continue;
        const sources = incoming.get(value.id),
          expression = program.expressions.get(value.id);
        if (sources) {
          web.add(value.id);
          todo.push(...sources);
        } else if (expression?.kind === 'select') {
          web.add(value.id);
          todo.push(canonical(expression.when_true, true), canonical(expression.when_false, true));
        } else if (expression?.kind === 'constant') return;
        else leaves.push(value);
      }
      if (slot !== undefined) {
        const stores = (slotStores.get(slot) ?? []).filter((store) => members.has(store.block));
        if (!everyIteration(header, new Set(stores.map((store) => store.block)))) unchanged = true;
      }
      const updates = leaves.map((leaf) => classify(leaf, web));
      if (!updates.length || updates.some((update) => update.kind === 'opaque')) return;
      for (const id of web)
        if ((roles.get(id) ?? 0) & (roleBits.address | roleBits.callback)) return;
      const steps = updates.flatMap((update) => (update.kind === 'step' ? [update.step] : []));
      const running = [
        ...web,
        ...leaves.map((leaf) => leaf.id),
        ...updates.flatMap((update) =>
          update.kind === 'fold' ? update.chain.map((value) => value.id) : [],
        ),
      ];
      const bounds: Value[] = [];
      const tests = loopTests.get(header)!;
      for (const id of running) bounds.push(...(tests.get(id) ?? []));
      let role: Role,
        step = 0n;
      if (steps.length === updates.length) {
        if (unchanged || steps.some((value) => value !== steps[0])) return;
        step = steps[0]!;
        role = step > 0n ? 'index' : 'count';
        // A step other than one with no loop test is as likely a pointer-sized
        // stride as an index, so only a unit step stands without a test.
        if (!bounds.length && step !== 1n && step !== -1n) return;
        // Stepping down from zero counts negated iterations, not what remains.
        if (
          role === 'count' &&
          entries.some((entry) => {
            const expression = program.expressions.get(entry.id);
            return expression?.kind === 'constant' && expression.bits === 0n;
          })
        )
          return;
      } else {
        role = 'accumulator';
        if (
          running.some((id) => subscripts.has(id)) ||
          bounds.some((bound) => program.expressions.get(bound.id)?.kind !== 'constant')
        )
          return;
      }
      if (role === 'index') {
        const bound = bounds.find(
          (candidate) =>
            program.expressions.get(candidate.id)?.kind !== 'constant' &&
            invariant(candidate, members),
        );
        if (bound) pendingBounds.push({ bound, role: step === 1n ? 'count' : 'limit' });
      } else if (step === -1n)
        // A parameter a unit countdown starts from is the number of iterations.
        for (const entry of entries)
          if (parameters.has(entry.id)) pendingBounds.push({ bound: entry, role: 'count' });
      if (slot !== undefined) {
        const name = role === 'count' ? 'remaining' : role,
          previous = slotNames.get(slot);
        slotNames.set(slot, previous === undefined || previous === name ? name : null);
      } else
        for (const id of [...web, ...leaves.map((leaf) => leaf.id)])
          for (const same of reinterpretations(id)) {
            const value = program.values.get(same);
            if (value) mark(value, role, false);
            if (role === 'count') decreasing.add(same);
          }
      if (role === 'accumulator')
        for (const update of updates)
          if (update.kind === 'fold') {
            // A reload of a promoted slot is another variable, not an element.
            const operand = canonical(update.other, true),
              element = loaded.get(operand.id);
            if (element && !slotOf.has(operand.id)) generic.set(element.id, 'element');
          }
    };
    const headers = new Map<
      string,
      { header: string; head: Value; starts: Value[]; entries: Value[]; initials: Value[] }
    >();
    for (const [transfer, copies] of program.transfers) {
      const members = loops.get(transfer.target),
        source = sources.get(transfer);
      if (!members || !source) continue;
      for (const copy of copies) {
        const head = canonical(copy.destination, true),
          key = `${transfer.target}\0${head.id}`;
        const row = headers.get(key) ?? {
          header: transfer.target,
          head,
          starts: [],
          entries: [],
          initials: [],
        };
        if (members.has(source)) row.starts.push(canonical(copy.source, true));
        else {
          row.entries.push(canonical(copy.source, true));
          row.initials.push(copy.source);
        }
        headers.set(key, row);
      }
    }
    for (const { header, head, starts, entries, initials } of headers.values()) {
      if (!starts.length) continue;
      carried.add(head.id);
      for (const value of initials) initial.set(value.id, head.id);
      analyze(header, new Set([head.id]), starts, undefined, entries);
    }
    for (const [header, members] of loops)
      for (const [slot, stores] of slotStores) {
        const inside = stores.filter((store) => members.has(store.block));
        if (!inside.length) continue;
        analyze(
          header,
          new Set((slotLoads.get(slot) ?? []).map((load) => load.id)),
          inside.map((store) => store.value),
          slot,
        );
      }
    for (const { bound, role } of pendingBounds) if (!roles.get(bound.id)) mark(bound, role, false);
  } else {
    for (const [transfer, copies] of program.transfers) {
      const members = loops.get(transfer.target),
        source = sources.get(transfer);
      if (!members || !source || !members.has(source)) continue;
      for (const copy of copies) {
        context.checkpoint(1);
        const destination = canonical(copy.destination, true),
          updated = canonical(copy.source, true);
        const expression = program.expressions.get(updated.id);
        if (
          expression?.kind !== 'integer' ||
          !['add', 'sub'].includes(expression.op) ||
          (roles.get(destination.id) ?? 0) & roleBits.address
        )
          continue;
        const left = canonical(expression.left, true),
          right = canonical(expression.right, true);
        const selfLeft = left.id === destination.id,
          selfRight = right.id === destination.id;
        if (!selfLeft && !(selfRight && expression.op === 'add')) continue;
        const other = selfLeft ? right : left,
          constant = program.expressions.get(other.id);
        const tests = loopTests.get(transfer.target)!;
        const bounds = [...(tests.get(destination.id) ?? []), ...(tests.get(updated.id) ?? [])];
        if (constant?.kind === 'constant') {
          if (constant.bits !== 1n || bounds.length === 0) continue;
          if (expression.op === 'sub') {
            mark(destination, 'count');
            mark(updated, 'count');
            decreasing.add(destination.id);
            decreasing.add(updated.id);
          } else {
            mark(destination, 'index');
            mark(updated, 'index');
            const bound = bounds.find(
              (candidate) => program.expressions.get(candidate.id)?.kind !== 'constant',
            );
            if (bound) mark(bound, 'count');
          }
        } else if (!dependsOn(other, new Set([destination.id]))) {
          mark(destination, 'accumulator');
          mark(updated, 'accumulator');
          const element = loaded.get(canonical(other, true).id);
          if (element) generic.set(element.id, 'element');
        }
      }
    }
  }
  propagate();
  for (const boundary of program.returns.values())
    for (const value of boundary.results) {
      const result = canonical(value, true);
      if (!parameters.has(result.id) && !generic.has(result.id)) generic.set(result.id, 'result');
    }

  const declaredFields = new Map<string, string | null>();
  for (const record of types?.types ?? []) {
    if (
      (record.status !== 'established' && record.status !== 'asserted') ||
      record.definition.kind !== 'structure'
    )
      continue;
    for (const field of record.definition.fields) {
      if (!field.name) continue;
      const previous = declaredFields.get(field.id);
      declaredFields.set(
        field.id,
        previous === undefined || previous === field.name ? field.name : null,
      );
    }
  }
  const fields = new Map<string, string | null>();
  for (const block of program.blocks.values())
    for (const node of block.statements) {
      if (node.kind !== 'load') continue;
      const candidates = new Set<string>(),
        subjects = program.source.field_subjects?.get(node.id) ?? [];
      let conflict = false;
      for (const subject of subjects) {
        const name = supplied.has(subject) ? supplied.get(subject) : declaredFields.get(subject);
        if (name === null) conflict = true;
        else if (name) candidates.add(name);
      }
      if (conflict || candidates.size > 1) fields.set(node.result.id, null);
      else if (candidates.size === 1) fields.set(node.result.id, [...candidates][0]!);
    }
  // Resolve each unchanged-storage display-name component once. Rewalking a
  // long cast chain independently for every live value would be quadratic.
  for (const parameter of program.parameters)
    for (const origin of program.source.value_origins?.get(parameter.id) ?? []) {
      const forward = storageLinks.get(parameter.id) ?? [],
        reverse = storageLinks.get(origin) ?? [];
      forward.push(origin);
      reverse.push(parameter.id);
      storageLinks.set(parameter.id, forward);
      storageLinks.set(origin, reverse);
    }
  const resolvedNames = new Map<string, string | null>(),
    visitedNames = new Set<string>();
  for (const root of supplied.keys()) {
    if (visitedNames.has(root)) continue;
    const pending = [root],
      component: string[] = [],
      candidates = new Set<string>();
    let conflict = false;
    while (pending.length) {
      context.checkpoint(1);
      const id = pending.pop()!;
      if (visitedNames.has(id)) continue;
      visitedNames.add(id);
      component.push(id);
      const name = supplied.get(id);
      if (name === null) conflict = true;
      else if (name !== undefined) candidates.add(name);
      pending.push(...(storageLinks.get(id) ?? []));
    }
    const name = conflict || candidates.size > 1 ? null : candidates.values().next().value;
    if (name !== undefined) for (const id of component) resolvedNames.set(id, name);
  }
  const preferred = new Map<string, string | null>();
  for (const value of program.values.values()) {
    if (!program.live.has(value.id) && !parameters.has(value.id)) continue;
    context.checkpoint(1);
    if (
      (program.source.stack?.kind === 'entry' && program.source.stack.base.id === value.id) ||
      program.parameter_registers.get(value.id)?.role === 'stack_pointer'
    ) {
      preferred.set(value.id, 'entry_sp');
      continue;
    }
    if (supplied.has(value.id)) {
      preferred.set(value.id, supplied.get(value.id)!);
      continue;
    }
    if (resolvedNames.has(value.id)) {
      preferred.set(value.id, resolvedNames.get(value.id)!);
      continue;
    }
    const parameterName = program.source.parameter_names.get(value.id);
    if (parameterName && (!program.source.inferred || !/^arg\d+$/.test(parameterName))) {
      preferred.set(value.id, parameterName);
      continue;
    }
    if (fields.has(value.id)) {
      preferred.set(value.id, fields.get(value.id)!);
      continue;
    }
    const bits = roles.get(value.id) ?? 0;
    if (bits && bits & (bits - 1)) {
      preferred.set(value.id, null);
      continue;
    }
    const role = roleNames.get(bits);
    if (role)
      preferred.set(
        value.id,
        role === 'count' && !parameters.has(value.id) && decreasing.has(value.id)
          ? 'remaining'
          : role,
      );
    else if (!parameters.has(value.id) && generic.has(value.id))
      preferred.set(value.id, generic.get(value.id)!);
  }
  const localNames = new Map<string, Set<string>>(),
    conflictingLocals = new Set<string>();
  for (const block of program.blocks.values())
    for (const node of block.statements) {
      if (node.kind !== 'load') continue;
      const local = program.source.locals.get(node.id);
      if (!local) continue;
      if (supplied.has(local.id)) {
        preferred.set(local.id, supplied.get(local.id)!);
        continue;
      }
      const name = preferred.get(node.result.id);
      if (name === null) conflictingLocals.add(local.id);
      else if (name !== undefined) {
        const row = localNames.get(local.id) ?? new Set<string>();
        row.add(name);
        localNames.set(local.id, row);
      }
    }
  for (const [id, names] of localNames)
    if (!supplied.has(id))
      preferred.set(
        id,
        conflictingLocals.has(id) || names.size !== 1 ? null : names.values().next().value!,
      );
  // A promoted slot is named by its own loop analysis. Reloads materialized as
  // temporaries are copies and keep their own neutral or generic names; a role a
  // reload carries from its uses must agree with the slot's.
  for (const [id, name] of slotNames)
    if (!supplied.has(id))
      preferred.set(
        id,
        name === null ||
          conflictingLocals.has(id) ||
          [...(localNames.get(id) ?? [])].some(
            (other) => sourceRoleStems.has(other) && other !== name,
          )
          ? null
          : name,
      );
  for (const id of conflictingLocals) if (!supplied.has(id)) preferred.set(id, null);
  return { names: preferred, carried, initial };
}

/** One allocator namespace serves source identifiers in both dialects. Helpers
 * and language keywords are not valid preferred variable names. */
export function sourceIdentifierStem(preferred: string): string {
  let stem = preferred.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64);
  if (!/^[A-Za-z_]/.test(stem)) stem = `value_${stem}`;
  if (reservedWord.test(stem) || reservedRuntimeName.test(stem) || reservedRuntimePrefix.test(stem))
    stem = `value_${stem}`;
  return stem;
}
