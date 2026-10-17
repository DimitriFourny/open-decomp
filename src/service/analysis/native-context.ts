import { fingerprint, type CanonicalValue, type OperationContext, type RegisterDescriptor } from '../../core/index.js';
import { bitWidth, type Expression, type Instruction, type RegisterBinding, type SSAForm, type Value } from '../../ir/index.js';
import { simplifySSA } from '../../analysis/values/index.js';
import { sourceConstantValues } from '../../reconstruction/source-data.js';
import { boundIR, requirePass } from './passes.js';
import { mapExpression } from '../../analysis/effects/index.js';

/** Assumptions describe whole prepared ABI carriers, never a partial-bit guess.
 * Distinct alias classes remain may-alias; absence never proves disjointness. */
export interface NativeContext {
  readonly constants: readonly { readonly register: RegisterDescriptor; readonly bits: bigint }[];
  readonly aliases: readonly (readonly RegisterDescriptor[])[];
  readonly type_evidence_scope: string;
}
export function nativeContextKey(functionId: string, assumptions?: NativeContext): string {
  return assumptions ? `${functionId}@${fingerprint(assumptions as unknown as CanonicalValue)}` : functionId;
}

export function nativeCallContext(
  bindings: readonly RegisterBinding[],
  parameters: readonly RegisterDescriptor[],
  expressions: ReadonlyMap<string, Expression>,
  scope: string,
  context: OperationContext,
  imageId: string,
  knownConstants?: ReadonlyMap<string, bigint>,
): NativeContext | undefined {
  const constant = sourceConstantValues(expressions, context, imageId);
  const constants: NativeContext['constants'][number][] = [];
  const identities = new Map<string, RegisterDescriptor[]>();
  for (const register of parameters) {
    context.checkpoint(1);
    const cells = bindings.filter((binding) => binding.register.root === register.root &&
      binding.register.offset_bits >= register.offset_bits &&
      binding.register.offset_bits < register.offset_bits + register.width_bits)
      .sort((left, right) => left.register.offset_bits - right.register.offset_bits);
    let cursor = register.offset_bits, bits = 0n, known = true;
    for (const cell of cells) {
      context.checkpoint(1);
      if (cell.register.offset_bits !== cursor || bitWidth(cell.value.type) !== cell.register.width_bits) { known = false; break; }
      const value = knownConstants?.get(cell.value.id) ?? constant(cell.value);
      if (value === undefined) known = false;
      else bits |= BigInt.asUintN(cell.register.width_bits, value) << BigInt(cursor - register.offset_bits);
      cursor += cell.register.width_bits;
    }
    if (cursor !== register.offset_bits + register.width_bits) continue;
    if (known) constants.push({ register, bits });
    // Normalize exact transport, so a whole copy aliases the same pointer even
    // when one root was split into SSA cells and the other was reassembled.
    const fragments: { readonly id: string; readonly start: number; width: number; readonly offset: number }[] = [];
    const pending = cells.map((cell) => ({ value: cell.value, start: 0, width: cell.register.width_bits,
      offset: cell.register.offset_bits - register.offset_bits, depth: 0 }));
    while (pending.length) {
      context.checkpoint(1);
      const item = pending.pop()!, expression = expressions.get(item.value.id);
      if (item.depth < 64 && expression?.kind === 'extract') {
        pending.push({ ...item, value: expression.value, start: expression.offset + item.start, depth: item.depth + 1 });
      } else if (item.depth < 64 && expression?.kind === 'cast' &&
        (expression.op === 'bitcast' || expression.op === 'truncate') &&
        item.start + item.width <= bitWidth(expression.value.type)) {
        pending.push({ ...item, value: expression.value, depth: item.depth + 1 });
      } else if (item.depth < 64 && expression?.kind === 'integer' &&
        (expression.op === 'or' || expression.op === 'xor' || expression.op === 'add')) {
        const left = knownConstants?.get(expression.left.id) ?? constant(expression.left);
        const right = knownConstants?.get(expression.right.id) ?? constant(expression.right);
        const source = left === 0n ? expression.right : right === 0n ? expression.left : undefined;
        if (source) pending.push({ ...item, value: source, depth: item.depth + 1 });
        else fragments.push({ id: item.value.id, start: item.start, width: item.width, offset: item.offset });
      } else if (item.depth < 64 && expression?.kind === 'concat') {
        let cursor = 0;
        for (const value of expression.values) {
          const end = cursor + bitWidth(value.type), low = Math.max(cursor, item.start),
            high = Math.min(end, item.start + item.width);
          if (low < high) pending.push({ value, start: low - cursor, width: high - low,
            offset: item.offset + low - item.start, depth: item.depth + 1 });
          cursor = end;
        }
      } else fragments.push({ id: item.value.id, start: item.start, width: item.width, offset: item.offset });
    }
    fragments.sort((left, right) => left.offset - right.offset);
    const merged: typeof fragments = [];
    for (const fragment of fragments) {
      const prior = merged.at(-1);
      if (prior && prior.id === fragment.id && prior.start + prior.width === fragment.start &&
        prior.offset + prior.width === fragment.offset) prior.width += fragment.width;
      else merged.push({ ...fragment });
    }
    const identity = merged.map((fragment) => `${fragment.offset}:${fragment.id}:${fragment.start}:${fragment.width}`).join('|');
    const aliases = identities.get(identity) ?? [];
    aliases.push(register); identities.set(identity, aliases);
  }
  const aliases = [...identities.values()].filter((group) => group.length > 1);
  if (!constants.length && !aliases.length) return undefined;
  return { constants, aliases, type_evidence_scope: scope };
}

/** Construct a fresh SSA view: replace only assumed entry definitions, leaving
 * the immutable decoded/lifted baseline and its type evidence untouched. */
export function specializeNativeSSA(ir: SSAForm, assumptions: NativeContext, context: OperationContext): SSAForm {
  const entry = ir.blocks.find((block) => block.id === ir.entry)!;
  const bindings = ir.register_states.find((state) => state.block === ir.entry)?.entry ?? [];
  const replacements = new Map<string, { readonly value: Value; readonly expression: Expression }>();
  for (const { register, bits } of assumptions.constants)
    for (const binding of bindings) {
      context.checkpoint(1);
      const offset = binding.register.offset_bits - register.offset_bits;
      if (binding.register.root !== register.root || offset < 0 || offset + binding.register.width_bits > register.width_bits ||
        binding.value.type.kind !== 'integer') continue;
      replacements.set(binding.value.id, { value: binding.value, expression: { kind: 'constant',
        bits: BigInt.asUintN(binding.register.width_bits, bits >> BigInt(offset)) } });
    }
  for (const group of assumptions.aliases) {
    const first = group[0]!;
    const cells = bindings.filter((binding) => binding.register.root === first.root &&
      binding.register.offset_bits >= first.offset_bits &&
      binding.register.offset_bits < first.offset_bits + first.width_bits)
      .sort((left, right) => left.register.offset_bits - right.register.offset_bits);
    let cursor = first.offset_bits;
    for (const cell of cells) {
      context.checkpoint(1);
      if (cell.register.offset_bits !== cursor || cell.value.type.kind !== 'integer') break;
      cursor += cell.register.width_bits;
    }
    if (cursor !== first.offset_bits + first.width_bits) continue;
    let whole = cells[0]!.value;
    if (cells.length !== 1) {
      whole = { id: `entity_${fingerprint(['native-context-alias', ir.id, first.root])}`,
        type: { kind: 'integer', bits: first.width_bits } };
      replacements.set(whole.id, { value: whole, expression: { kind: 'concat', values: cells.map((cell) => cell.value) } });
    }
    for (const register of group.slice(1))
      for (const binding of bindings) {
        context.checkpoint(1);
        const offset = binding.register.offset_bits - register.offset_bits;
        if (binding.register.root !== register.root || replacements.has(binding.value.id) || offset < 0 ||
          offset + binding.register.width_bits > register.width_bits || binding.value.type.kind !== 'integer') continue;
        replacements.set(binding.value.id, { value: binding.value, expression:
          bitWidth(whole.type) === bitWidth(binding.value.type) && offset === 0
            ? { kind: 'cast', op: 'bitcast', value: whole }
            : { kind: 'extract', value: whole, offset } });
      }
  }
  if (!replacements.size) return ir;
  const identity = (...birth: readonly string[]): string => `entity_${fingerprint(['native-context', ir.id, ...birth])}`;
  const prologue = identity(ir.entry, 'entry');
  const effect = { ...entry.effect_parameter, id: identity(entry.effect_parameter.id, 'effect') };
  const incoming = new Map(entry.parameters.map((value) =>
    [value.id, { ...value, id: identity(value.id, 'input') }] as const));
  const actuals = new Map(incoming);
  const definitions: Instruction[] = [];
  for (const { value, expression } of replacements.values()) {
    const result = { ...value, id: identity(value.id, 'assumed') };
    const mapped = mapExpression(expression, (value) => actuals.get(value.id) ?? value);
    definitions.push({ kind: 'assign', id: identity(value.id, 'definition'),
      result, expression: mapped, provenance: entry.provenance });
    actuals.set(value.id, result);
  }
  const view: SSAForm = { ...ir, entry: prologue, blocks: [{
    id: prologue, parameters: [...incoming.values()], effect_parameter: effect,
    instructions: definitions, provenance: entry.provenance,
    terminator: { kind: 'jump', id: identity(prologue, 'jump'), provenance: entry.provenance, effect,
      edge: { target: entry.id, arguments: entry.parameters.map((value) => actuals.get(value.id)!), effect } },
  }, ...ir.blocks], register_states: [{
    block: prologue,
    entry: bindings.map((binding) => ({ ...binding, value: incoming.get(binding.value.id) ?? binding.value })),
    exit: bindings.map((binding) => ({ ...binding, value: actuals.get(binding.value.id) ?? binding.value })),
  }, ...ir.register_states] };
  boundIR(view, context);
  const simplified = simplifySSA(view, { max_work: context.remainingWork?.() ?? context.budget.work,
    max_ir_nodes: context.budget.ir_nodes, max_blocks: context.budget.blocks,
    checkpoint: (work) => context.checkpoint(work) });
  requirePass(simplified.state, simplified.diagnostics, context);
  return simplified.value;
}
