import type { OperationContext } from '../core/index.js';
import type { TypeRecoveryResult } from '../analysis/types/index.js';
import { bitWidth, expressionOperands, type Value } from '../ir/index.js';
import type { ParallelTransfer, Region } from '../presentation/index.js';
import type { Reconstruction } from './model.js';

type Role = 'address' | 'callback' | 'count' | 'index' | 'accumulator' | 'shift_count';
const roleBits: Record<Role, number> = {
  address: 1, callback: 2, count: 4, index: 8, accumulator: 16, shift_count: 32,
};
const roleNames = new Map<number, Role>(
  (Object.keys(roleBits) as Role[]).map((role): [number, Role] => [roleBits[role], role]),
);
const reservedWord = /^(?:auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|restrict|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while|_Alignas|_Alignof|_Atomic|_Bool|_Complex|_Generic|_Imaginary|_Noreturn|_Static_assert|_Thread_local|False|None|True|and|as|assert|async|await|class|def|del|elif|except|finally|from|global|import|in|is|lambda|nonlocal|not|or|pass|raise|try|with|yield|bool|memory|label|pointer|address_of|field_view|stack_slot|stack_storage|data_address|read_memory|write_memory|uint\d+|int\d+|uint\d+_t|int\d+_t|bits\d+_t|ieee\d+_t)$/;
const reservedRuntimeName = /^(?:entry_sp|stack_frame|true|false|NULL|U?INT\d+_(?:MAX|MIN|C)|extract_bits|insert_bits|concat_low_first|signed_value|wrap|read_register|write_register|image_address|boundary|explicit_values)$/;
const reservedRuntimePrefix = /^(?:__|bv_|fp_|cast_|vector_|flag_|memory_|unknown_|physical_|source_|type_|transfer_|requirement_)/;

/** Presentation-only suggestions: no source intent, type, identity or expression
 * is inferred from an identifier. Conflicting independent roles stay neutral. */
export function planSourceNames(
  program: Reconstruction,
  supplied: ReadonlyMap<string, string | null>,
  types: TypeRecoveryResult | undefined,
  context: OperationContext,
): ReadonlyMap<string, string | null> {
  if (!program.source) return new Map();
  const parameters = new Set(program.parameters.map((value) => value.id));
  const links = new Map<string, { value: Value; sameWidth: boolean }[]>();
  const storageLinks = new Map<string, string[]>();
  const roles = new Map<string, number>();
  const queue: { value: Value; role: Role }[] = [];
  const decreasing = new Set<string>();
  const generic = new Map<string, string>();
  const loaded = new Map<string, Value>();
  const link = (left: Value, right: Value, storage: boolean): void => {
    for (const [from, to] of [[left, right], [right, left]] as const) {
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
      const source = expression?.kind === 'cast' &&
          ['bitcast', 'truncate', 'zero_extend', 'sign_extend'].includes(expression.op)
        ? expression.value
        : expression?.kind === 'extract' && expression.offset === 0 ? expression.value : null;
      if (!source || (!numeric && bitWidth(source.type) !== bitWidth(value.type))) break;
      value = source;
    }
    return value;
  };
  const mark = (value: Value, role: Role): void => {
    const expression = program.expressions.get(value.id);
    if (expression?.kind === 'constant' || expression?.kind === 'address') return;
    const before = roles.get(value.id) ?? 0;
    if (before & roleBits[role]) return;
    roles.set(value.id, before | roleBits[role]);
    queue.push({ value, role });
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
    if (expression.kind === 'cast' &&
        ['bitcast', 'truncate', 'zero_extend', 'sign_extend'].includes(expression.op))
      link(value, expression.value, true);
    else if (expression.kind === 'extract' && expression.offset === 0)
      link(value, expression.value, true);
    if (!program.live.has(id)) continue;
    if (expression.kind === 'compare' || expression.kind === 'float_compare') generic.set(id, 'condition');
    if (expression.kind === 'integer' && ['shl', 'lshr', 'ashr', 'rol', 'ror'].includes(expression.op)) {
      let count = canonical(expression.right, true);
      const mask = program.expressions.get(count.id);
      if (mask?.kind === 'integer' && mask.op === 'and') {
        const left = program.expressions.get(mask.left.id), right = program.expressions.get(mask.right.id);
        if (right?.kind === 'constant') count = mask.left;
        else if (left?.kind === 'constant') count = mask.right;
      }
      mark(count, 'shift_count');
    }
  }
  const sources = new Map<ParallelTransfer, string>();
  for (const block of program.blocks.values()) {
    const control = block.control;
    const transfers = control.kind === 'jump' ? [control.transfer]
      : control.kind === 'if' ? [control.when_true.transfer, control.when_false.transfer]
        : control.kind === 'switch' ? [...control.cases.map((item) => item.arm.transfer), control.otherwise.transfer] : [];
    for (const transfer of transfers) sources.set(transfer, block.id);
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
          if (expression?.kind !== 'integer' || !['add', 'sub'].includes(expression.op) ||
              program.expressions.get(expression.right.id)?.kind !== 'constant') break;
          address = canonical(expression.left, false);
          mark(address, 'address');
        }
        if (node.kind === 'load') loaded.set(canonical(node.result, true).id, node.result);
      }
      if (node.kind === 'call') {
        if (node.target.kind === 'indirect') mark(node.target.value, 'callback');
        for (const result of program.calls.get(node.id)?.results ?? []) generic.set(result.id, 'call_result');
      }
    }
    if (control.kind === 'indirect' && control.tail_call) mark(control.target, 'callback');
  }
  for (const copies of program.transfers.values())
    for (const copy of copies) link(copy.destination, copy.source, false);
  // Source pointer interpretations are established by the shared type projection,
  // not by register spelling, architectural width or an author's guessed name.
  for (const [id, view] of program.source.value_types ?? [])
    if ((program.live.has(id) || parameters.has(id)) &&
        types?.types.some((record) => record.id === view.type_id && record.definition.kind === 'pointer')) {
      const value = program.values.get(id);
      if (value) mark(value, 'address');
    }
  propagate();

  const loops = new Map<string, Set<string>>();
  const pending: { region: Region; active: readonly string[] }[] = [{ region: program.function.body, active: [] }];
  while (pending.length) {
    context.checkpoint(1);
    const { region, active } = pending.pop()!;
    if (region.kind === 'block') {
      for (const header of active) loops.get(header)!.add(region.id);
      const control = region.control;
      const arms = control.kind === 'if' ? [control.when_true, control.when_false]
        : control.kind === 'switch' ? [...control.cases.map((item) => item.arm), control.otherwise] : [];
      for (const arm of arms) if (arm.body) pending.push({ region: arm.body, active });
    } else if (region.kind === 'sequence') {
      for (const child of region.regions) pending.push({ region: child, active });
    } else {
      loops.set(region.header, new Set());
      pending.push({ region: region.body, active: [...active, region.header] });
    }
  }
  const depends = (root: Value, target: string): boolean => {
    const todo = [root], seen = new Set<string>();
    while (todo.length) {
      context.checkpoint(1);
      const value = todo.pop()!;
      if (value.id === target) return true;
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
      if (control.kind !== 'if' ||
          members.has(control.when_true.transfer.target) === members.has(control.when_false.transfer.target)) continue;
      const condition = program.expressions.get(canonical(control.condition, true).id);
      if (condition?.kind !== 'compare') continue;
      const left = canonical(condition.left, true), right = canonical(condition.right, true);
      for (const [value, bound] of [[left, right], [right, left]] as const) {
        const row = tests.get(value.id) ?? [];
        row.push(bound);
        tests.set(value.id, row);
      }
    }
    loopTests.set(header, tests);
  }
  for (const [transfer, copies] of program.transfers) {
    const members = loops.get(transfer.target), source = sources.get(transfer);
    if (!members || !source || !members.has(source)) continue;
    for (const copy of copies) {
      context.checkpoint(1);
      const destination = canonical(copy.destination, true), updated = canonical(copy.source, true);
      const expression = program.expressions.get(updated.id);
      if (expression?.kind !== 'integer' || !['add', 'sub'].includes(expression.op) ||
          ((roles.get(destination.id) ?? 0) & roleBits.address)) continue;
      const left = canonical(expression.left, true), right = canonical(expression.right, true);
      const selfLeft = left.id === destination.id, selfRight = right.id === destination.id;
      if (!selfLeft && !(selfRight && expression.op === 'add')) continue;
      const other = selfLeft ? right : left, constant = program.expressions.get(other.id);
      const tests = loopTests.get(transfer.target)!;
      const bounds = [...(tests.get(destination.id) ?? []), ...(tests.get(updated.id) ?? [])];
      if (constant?.kind === 'constant') {
        if (constant.bits !== 1n || bounds.length === 0) continue;
        if (expression.op === 'sub') {
          mark(destination, 'count'); mark(updated, 'count');
          decreasing.add(destination.id); decreasing.add(updated.id);
        } else {
          mark(destination, 'index'); mark(updated, 'index');
          const bound = bounds.find((candidate) => program.expressions.get(candidate.id)?.kind !== 'constant');
          if (bound) mark(bound, 'count');
        }
      } else if (!depends(other, destination.id)) {
        mark(destination, 'accumulator'); mark(updated, 'accumulator');
        const element = loaded.get(canonical(other, true).id);
        if (element) generic.set(element.id, 'element');
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
    if ((record.status !== 'established' && record.status !== 'asserted') || record.definition.kind !== 'structure') continue;
    for (const field of record.definition.fields) {
      if (!field.name) continue;
      const previous = declaredFields.get(field.id);
      declaredFields.set(field.id, previous === undefined || previous === field.name ? field.name : null);
    }
  }
  const fields = new Map<string, string | null>();
  for (const block of program.blocks.values())
    for (const node of block.statements) {
      if (node.kind !== 'load') continue;
      const candidates = new Set<string>(), subjects = program.source.field_subjects?.get(node.id) ?? [];
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
      const forward = storageLinks.get(parameter.id) ?? [], reverse = storageLinks.get(origin) ?? [];
      forward.push(origin); reverse.push(parameter.id);
      storageLinks.set(parameter.id, forward); storageLinks.set(origin, reverse);
    }
  const resolvedNames = new Map<string, string | null>(), visitedNames = new Set<string>();
  for (const root of new Set([...storageLinks.keys(), ...supplied.keys()])) {
    if (visitedNames.has(root)) continue;
    const pending = [root], component: string[] = [], candidates = new Set<string>();
    let conflict = false;
    while (pending.length) {
      context.checkpoint(1);
      const id = pending.pop()!;
      if (visitedNames.has(id)) continue;
      visitedNames.add(id); component.push(id);
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
    if ((program.source.stack?.kind === 'entry' && program.source.stack.base.id === value.id) ||
        program.parameter_registers.get(value.id)?.role === 'stack_pointer') {
      preferred.set(value.id, 'entry_sp'); continue;
    }
    if (supplied.has(value.id)) { preferred.set(value.id, supplied.get(value.id)!); continue; }
    if (resolvedNames.has(value.id)) { preferred.set(value.id, resolvedNames.get(value.id)!); continue; }
    const parameterName = program.source.parameter_names.get(value.id);
    if (parameterName && (!program.source.inferred || !/^arg\d+$/.test(parameterName))) {
      preferred.set(value.id, parameterName); continue;
    }
    if (fields.has(value.id)) { preferred.set(value.id, fields.get(value.id)!); continue; }
    const bits = roles.get(value.id) ?? 0;
    if (bits && (bits & (bits - 1))) { preferred.set(value.id, null); continue; }
    const role = roleNames.get(bits);
    if (role) preferred.set(value.id, role === 'count' && !parameters.has(value.id) && decreasing.has(value.id) ? 'remaining' : role);
    else if (!parameters.has(value.id) && generic.has(value.id)) preferred.set(value.id, generic.get(value.id)!);
  }
  const localNames = new Map<string, Set<string>>(), conflictingLocals = new Set<string>();
  for (const block of program.blocks.values())
    for (const node of block.statements) {
      if (node.kind !== 'load') continue;
      const local = program.source.locals.get(node.id);
      if (!local) continue;
      if (supplied.has(local.id)) { preferred.set(local.id, supplied.get(local.id)!); continue; }
      const name = preferred.get(node.result.id);
      if (name === null) conflictingLocals.add(local.id);
      else if (name !== undefined) {
        const row = localNames.get(local.id) ?? new Set<string>();
        row.add(name); localNames.set(local.id, row);
      }
    }
  for (const [id, names] of localNames)
    if (!supplied.has(id))
      preferred.set(id, conflictingLocals.has(id) || names.size !== 1 ? null : names.values().next().value!);
  for (const id of conflictingLocals) if (!supplied.has(id)) preferred.set(id, null);
  return preferred;
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
