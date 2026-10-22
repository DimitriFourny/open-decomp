import { LIKELY_GATE, type LikelyHeuristic, type OperationContext } from '../core/index.js';
import { bitWidth, type Expression, type Value } from '../ir/index.js';
import type { EmissionInput } from '../emitters/model.js';
import type { Reconstruction } from './model.js';
import {
  stackEntry,
  type LikelyTypeGuess,
  type LikelyTypePresentation,
  type SourcePresentation,
} from './source-model.js';

/** How a formal is used inside this body, through unchanged copies of its bits. */
interface FormalUses {
  /** Passed to a call, stored, or returned: the word is carried, not computed with. */
  opaque: number;
  /** Computed with as an integer: arithmetic, masks, narrowing, ordered comparison, a
   * switch selector, or an argument the callee declares integer. */
  integer: boolean;
  /** The value, or a constant step from it, is a load/store address (proven pointer). */
  address: boolean;
  /** Target of an indirect call or tail transfer. */
  target: boolean;
  /** Compared with zero. */
  nullTested: boolean;
  /** Spilled to a frame slot that is not promoted: later uses are reloads this scan cannot
   * attribute to the formal, so no conclusion about its uses holds. */
  spilled: boolean;
}

/** Use summaries of the formals' unchanged-bits closures: edge copies, same-width
 * bitcasts and low extracts, selects, and promoted frame slots. */
function formalUses(
  program: Reconstruction,
  definitions: ReadonlyMap<string, { readonly definition: { readonly kind: string } }>,
  pointerBits: number,
  context: OperationContext,
): (value: Value) => FormalUses {
  const source = program.source!;
  const expressions = program.expressions;
  const forward = new Map<string, Value[]>();
  const link = (from: Value, to: Value): void => {
    const list = forward.get(from.id) ?? [];
    list.push(to);
    forward.set(from.id, list);
  };
  for (const copies of program.transfers.values())
    for (const copy of copies) link(copy.source, copy.destination);
  const slotStores = new Map<string, Value[]>();
  const slotLoads = new Map<string, Value[]>();
  const calls = new Map<string, number>();
  const stored = new Set<string>();
  const spilled = new Set<string>();
  const addresses = new Set<string>();
  const returned = new Set<string>();
  const targets = new Set<string>();
  const switched = new Set<string>();
  const declaredInteger = new Set<string>();
  const note = (id: string): void => {
    calls.set(id, (calls.get(id) ?? 0) + 1);
  };
  for (const block of program.blocks.values()) {
    const control = block.control;
    if (control.kind === 'switch') switched.add(control.value.id);
    if (control.kind === 'indirect' && control.tail_call) targets.add(control.target.id);
    for (const node of block.statements) {
      context.checkpoint(1);
      if (!program.retained.has(node.id)) continue;
      if (node.kind === 'call') {
        if (node.target.kind === 'indirect') targets.add(node.target.value.id);
        const boundary = program.calls.get(node.id);
        const arguments_ = boundary
          ? [...boundary.arguments, ...boundary.inputs.map((binding) => binding.value)]
          : [...node.arguments, ...node.register_inputs.map((binding) => binding.value)];
        for (const value of arguments_) note(value.id);
        // A value narrower than the register is an `int` argument.
        for (const binding of boundary?.inputs ?? node.register_inputs)
          if (bitWidth(binding.value.type) < pointerBits) declaredInteger.add(binding.value.id);
        boundary?.signature?.signature.parameters.forEach((parameter, index) => {
          const kind = definitions.get(parameter.type_id)?.definition.kind;
          const value = boundary.arguments[index];
          if (value && kind !== undefined && kind !== 'pointer') declaredInteger.add(value.id);
        });
        continue;
      }
      if (node.kind !== 'load' && node.kind !== 'store') continue;
      const slot = source.locals.get(node.id)?.id;
      if (slot) {
        if (node.kind === 'store')
          slotStores.set(slot, [...(slotStores.get(slot) ?? []), node.value]);
        else slotLoads.set(slot, [...(slotLoads.get(slot) ?? []), node.result]);
        continue;
      }
      addresses.add(node.address.id);
      if (node.kind === 'store') {
        if (source.stack_addresses.has(node.address.id)) spilled.add(node.value.id);
        else stored.add(node.value.id);
      }
    }
  }
  for (const [slot, values] of slotStores)
    for (const value of values) for (const load of slotLoads.get(slot) ?? []) link(value, load);
  for (const boundary of program.returns.values())
    for (const value of boundary.results) returned.add(value.id);
  const users = new Map<string, { result: Value; expression: Expression }[]>();
  for (const [id, expression] of expressions) {
    if (!program.live.has(id)) continue;
    const result = program.values.get(id);
    if (!result) continue;
    const operands =
      expression.kind === 'integer' || expression.kind === 'compare'
        ? [expression.left, expression.right]
        : expression.kind === 'select'
          ? [expression.when_true, expression.when_false]
          : 'value' in expression
            ? [expression.value]
            : [];
    for (const operand of operands) {
      const list = users.get(operand.id) ?? [];
      list.push({ result, expression });
      users.set(operand.id, list);
    }
  }
  const constant = (value: Value): boolean => expressions.get(value.id)?.kind === 'constant';
  return (root: Value): FormalUses => {
    const uses: FormalUses = {
      opaque: 0,
      integer: false,
      address: false,
      target: false,
      nullTested: false,
      spilled: false,
    };
    const width = bitWidth(root.type);
    const seen = new Set<string>();
    const pending = [root];
    while (pending.length) {
      context.checkpoint(1);
      const value = pending.pop()!;
      if (seen.has(value.id)) continue;
      seen.add(value.id);
      if (addresses.has(value.id)) uses.address = true;
      if (targets.has(value.id)) uses.target = true;
      if (spilled.has(value.id)) uses.spilled = true;
      if (switched.has(value.id) || declaredInteger.has(value.id)) uses.integer = true;
      if (stored.has(value.id) || returned.has(value.id)) uses.opaque++;
      uses.opaque += calls.get(value.id) ?? 0;
      for (const next of forward.get(value.id) ?? []) pending.push(next);
      for (const { result, expression } of users.get(value.id) ?? []) {
        const copy =
          (expression.kind === 'cast' && expression.op === 'bitcast') ||
          (expression.kind === 'extract' && expression.offset === 0) ||
          expression.kind === 'select';
        if (copy && bitWidth(result.type) === width) pending.push(result);
        else if (
          expression.kind === 'compare' &&
          (expression.op === 'eq' || expression.op === 'ne')
        ) {
          // A null test or a comparison with another address says nothing; a comparison with
          // a nonzero literal is a value test.
          const other = expression.left.id === value.id ? expression.right : expression.left;
          const literal = expressions.get(other.id);
          if (literal?.kind === 'constant' && literal.bits !== 0n) uses.integer = true;
          else if (literal?.kind === 'constant') uses.nullTested = true;
        } else if (
          expression.kind === 'integer' &&
          (expression.op === 'add' || expression.op === 'sub') &&
          (constant(expression.left) || constant(expression.right)) &&
          addresses.has(result.id)
        )
          uses.address = true;
        else uses.integer = true;
      }
    }
    return uses;
  };
}

/** `likely` inference mode, source view: give the integer formals and the result that the
 * evidence of `source.likely_types` names the pointer type, where proven analysis left them
 * integer. A formal or result any proven rule already typed (a pointer, a declared or
 * narrowed integer, a float) or that a supplied signature declares is never touched, so a
 * guess only fills an unknown. Every guess that finds its subject open is reported;
 * only an `applied` one (all firing heuristics passed their precision gate) changes the
 * projected types, as a `likely` view the renderer marks. */
export function projectLikelyTypes(
  program: Reconstruction,
  input: EmissionInput,
  context: OperationContext,
): Pick<SourcePresentation, 'value_types' | 'return_source_type' | 'likely_types'> | undefined {
  const guesses = input.source?.likely_types;
  const source = program.source;
  if (!guesses || !source || program.view !== 'source' || program.signature) return undefined;
  const types = input.types;
  if (types?.state !== 'complete') return undefined;
  const conflicts = new Set(types.conflicts.map((conflict) => conflict.subject_id));
  const definitions = new Map(types.types.map((record) => [record.id, record]));
  /** Unsigned machine-width integer analysis candidate: the value's own storage. */
  const plain = (typeId: string, bits: number): boolean => {
    const record = definitions.get(typeId);
    return (
      record?.source === 'analysis' &&
      record.definition.kind === 'integer' &&
      !record.definition.signed &&
      record.definition.bits === bits
    );
  };
  const projected = new Map(source.value_types ?? []);
  const firstRoot = input
    .source!.abi.classifyCall({
      returns: { kind: 'void' },
      parameters: [{ kind: 'pointer' }],
      variadic: false,
      fixed_parameter_count: 1,
    })
    .parameters[0]?.locations.flatMap((location) =>
      location.kind === 'register' ? [location.register.root] : [],
    )[0];
  const uses = formalUses(program, definitions, input.source!.abi.layout.pointer_bits, context);
  const parameters = new Map<string, LikelyTypeGuess>();
  for (const value of program.parameters) {
    context.checkpoint(1);
    const register = program.parameter_registers.get(value.id);
    const view = projected.get(value.id);
    if (
      !register ||
      register.role === 'stack_pointer' ||
      register.offset_bits !== 0 ||
      value.type.kind !== 'integer' ||
      bitWidth(value.type) !== register.width_bits ||
      stackEntry(source.stack)?.id === value.id ||
      source.formal_types?.has(value.id) ||
      source.float_values?.has(value.id) ||
      conflicts.has(value.id) ||
      (source.value_origins?.get(value.id) ?? []).some((id) => conflicts.has(id)) ||
      (view && !plain(view.type_id, bitWidth(value.type)))
    )
      continue;
    const heuristics = new Set<LikelyHeuristic>(guesses.parameters.get(register.root)?.heuristics);
    const own = uses(value);
    // A value that is dereferenced is a proven pointer, not a guess; only the rest is guessed.
    if (!own.address) {
      if (own.target) heuristics.add('indirect_call_target');
      else if (!own.spilled && !own.integer && own.opaque > 0) {
        heuristics.add('opaque_word_formal');
        // The context handle: a formal in the first argument register, or one tested
        // against null, that is only carried on is far more often an address than a count.
        if (own.nullTested || register.root === firstRoot) heuristics.add('carried_word_formal');
      }
    }
    if (!heuristics.size) continue;
    const guess: LikelyTypeGuess = {
      heuristics: [...heuristics].sort(),
      applied: [...heuristics].some((name) => LIKELY_GATE[name]),
      ...(guesses.parameters.get(register.root)?.sites === undefined
        ? {}
        : { sites: guesses.parameters.get(register.root)!.sites! }),
    };
    parameters.set(value.id, guess);
    if (guess.applied)
      projected.set(value.id, {
        type_id: guesses.pointer_type_id,
        likely: true,
        association_ids: [],
        subject_ids: [value.id],
        evidence_ids: [],
      });
  }
  let result: LikelyTypeGuess | undefined;
  let resultType: string | undefined;
  const guess = guesses.result;
  const returned = [...program.returns.values()];
  if (
    guess &&
    !program.tails.size &&
    returned.length &&
    source.return_type?.kind === 'integer' &&
    source.return_type.bits === 64 &&
    !source.return_pointer &&
    !source.return_scalar &&
    !source.return_float &&
    !source.return_types?.length &&
    (!source.return_source_type || plain(source.return_source_type, 64)) &&
    returned.every(
      (boundary) =>
        boundary.results.length === 1 &&
        boundary.results[0]!.type.kind === 'integer' &&
        bitWidth(boundary.results[0]!.type) === 64 &&
        !conflicts.has(boundary.results[0]!.id) &&
        !source.float_values?.has(boundary.results[0]!.id) &&
        !source.formal_types?.has(boundary.results[0]!.id) &&
        (!projected.has(boundary.results[0]!.id) ||
          plain(projected.get(boundary.results[0]!.id)!.type_id, 64)),
    )
  ) {
    result = {
      heuristics: guess.heuristics,
      applied: guess.heuristics.some((name) => LIKELY_GATE[name]),
      sites: guess.sites,
    };
    if (result.applied) resultType = guesses.pointer_type_id;
  }
  if (!parameters.size && !result) return undefined;
  const likely: LikelyTypePresentation = { parameters, ...(result ? { result } : {}) };
  return {
    value_types: projected,
    likely_types: likely,
    ...(resultType === undefined ? {} : { return_source_type: resultType }),
  };
}
