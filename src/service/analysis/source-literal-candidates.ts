import type {
  Address,
  LoadedImage,
  OperationContext,
  RegisterDescriptor,
} from '../../core/index.js';
import { U64_LIMIT } from '../../core/index.js';
import { bitWidth, type Edge, type Expression, type SSAForm, type Value } from '../../ir/index.js';

/** Most values one register or phi contributes: the same bound as `constantCandidates`. */
const MAX_VALUES = 8;

type Options = (value: Value) => readonly bigint[] | null;

/** Constants a pointer-width integer value can hold: a computed constant, else
 * the bounded value set of `constantCandidates`; null when either is unknown. */
function optionsOf(
  constant: (value: Value) => bigint | undefined,
  candidates: (value: Value) => readonly bigint[] | null,
): Options {
  return (value) => {
    const fixed = constant(value);
    return fixed !== undefined ? [fixed] : candidates(value);
  };
}

/** Every pointer-width cell product of `parts`; null above the bound. */
function combine(
  parts: readonly { readonly width: number; readonly values: readonly bigint[] }[],
): bigint[] | null {
  let wholes: bigint[] = [0n],
    offset = 0n;
  for (const part of parts) {
    const next: bigint[] = [];
    for (const prefix of wholes)
      for (const value of part.values)
        next.push(prefix | (BigInt.asUintN(part.width, value) << offset));
    wholes = [...new Set(next)];
    if (wholes.length > MAX_VALUES) return null;
    offset += BigInt(part.width);
  }
  return wholes;
}

/**
 * Addresses that pointer-width constants of one function can name, beyond the
 * constants every assignment already holds: a candidate only lets a string or
 * data fact exist, it never prints anything by itself.
 *
 * - A pointer-width concat of register cells, one of them a block parameter,
 *   holds one whole constant per incoming edge whose cells are all constant;
 *   edges with an unknown cell contribute nothing.
 * - Every incoming edge of a pointer-width block parameter that passes a
 *   constant or a bounded constant set contributes its members.
 * - The register cells at each `indirect` exit (a tail call) and at each call
 *   tile whole pointer-width registers whose cells have bounded constant sets.
 * - Every pointer-width concat with a bounded constant set contributes it.
 */
export function registerConstantCandidates(input: {
  readonly ir: SSAForm;
  readonly image: LoadedImage;
  readonly expressions: ReadonlyMap<string, Expression>;
  readonly constant: (value: Value) => bigint | undefined;
  readonly candidates: (value: Value) => readonly bigint[] | null;
  readonly context: OperationContext;
}): readonly Address[] {
  const { ir, image, expressions, context } = input;
  const bits = image.target.address_bits;
  const options = optionsOf(input.constant, input.candidates);
  const found = new Map<bigint, Address>();
  const add = (value: bigint): void => {
    if (value >= 0n && value < U64_LIMIT && !found.has(value))
      found.set(value, { image_id: image.id, space: 'va', value });
  };
  const addAll = (values: readonly bigint[] | null): void => {
    for (const value of values ?? []) add(value);
  };
  const pointer = (value: Value): boolean =>
    value.type.kind === 'integer' && value.type.bits === bits;

  const edgesInto = new Map<string, Edge[]>();
  for (const block of ir.blocks) {
    const { terminator } = block;
    const outgoing =
      terminator.kind === 'jump'
        ? [terminator.edge]
        : terminator.kind === 'branch'
          ? [terminator.when_true, terminator.when_false]
          : terminator.kind === 'switch'
            ? [...terminator.cases.map(({ edge }) => edge), terminator.otherwise]
            : [];
    for (const edge of outgoing) {
      const list = edgesInto.get(edge.target) ?? [];
      list.push(edge);
      edgesInto.set(edge.target, list);
    }
  }
  const parameterSlots = new Map<string, { block: string; index: number }>();
  for (const block of ir.blocks)
    for (const [index, value] of block.parameters.entries()) {
      context.checkpoint(1);
      parameterSlots.set(value.id, { block: block.id, index });
      if (!pointer(value)) continue;
      for (const edge of edgesInto.get(block.id) ?? []) {
        context.checkpoint(1);
        const argument = edge.arguments[index];
        if (argument) addAll(options(argument));
      }
    }

  // The whole constants of cells laid out lowest first. A cell with a bounded
  // value set is the same on every edge; cells that are parameters of one block
  // are read per incoming edge, and an edge with an unknown cell is skipped.
  const wholes = (cells: readonly { width: number; value: Value }[]): bigint[] => {
    let block: string | undefined;
    const parts: { width: number; edges: (readonly bigint[] | null)[] }[] = [];
    for (const { width, value } of cells) {
      const fixed = options(value);
      if (fixed) {
        parts.push({ width, edges: [fixed] });
        continue;
      }
      const slot = parameterSlots.get(value.id);
      const incoming = slot && edgesInto.get(slot.block);
      if (!slot || !incoming?.length || (block !== undefined && block !== slot.block)) return [];
      block = slot.block;
      parts.push({
        width,
        edges: incoming.map((edge) => {
          const argument = edge.arguments[slot.index];
          return argument ? options(argument) : null;
        }),
      });
    }
    const result: bigint[] = [];
    for (let edge = 0; edge < (block === undefined ? 1 : edgesInto.get(block)!.length); edge++) {
      context.checkpoint(parts.length);
      const values = parts.map((part) => part.edges[part.edges.length === 1 ? 0 : edge]);
      if (values.every((set) => set))
        result.push(
          ...(combine(
            parts.map((part, index) => ({ width: part.width, values: values[index]! })),
          ) ?? []),
        );
    }
    return result;
  };
  for (const expression of expressions.values()) {
    context.checkpoint(1);
    if (
      expression.kind === 'concat' &&
      expression.values.reduce((sum, part) => sum + bitWidth(part.type), 0) === bits
    )
      addAll(wholes(expression.values.map((value) => ({ width: bitWidth(value.type), value }))));
  }

  // Register cells at a tail exit or a call: disjoint slices that tile a whole
  // pointer-width register hold the product of their value sets.
  const tile = (bindings: readonly { register: RegisterDescriptor; value: Value }[]): void => {
    const roots = new Map<string, { register: RegisterDescriptor; value: Value }[]>();
    for (const binding of bindings) {
      context.checkpoint(1);
      if (binding.value.type.kind !== 'integer') continue;
      const row = roots.get(binding.register.root) ?? [];
      row.push(binding);
      roots.set(binding.register.root, row);
    }
    for (const row of roots.values()) {
      row.sort((left, right) => left.register.offset_bits - right.register.offset_bits);
      let cursor = 0;
      for (const { register } of row) {
        if (register.offset_bits !== cursor) break;
        cursor += register.width_bits;
      }
      if (cursor === bits)
        addAll(wholes(row.map(({ register, value }) => ({ width: register.width_bits, value }))));
    }
  };
  const rows = new Map(ir.register_states.map((state) => [state.block, state] as const));
  for (const block of ir.blocks) {
    context.checkpoint(1);
    for (const node of block.instructions)
      if (node.kind === 'assign' && node.expression.kind === 'concat' && pointer(node.result))
        addAll(input.candidates(node.result));
    if (block.terminator.kind === 'indirect') tile(rows.get(block.id)?.exit ?? []);
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (node.kind === 'call') tile(node.register_inputs);
    }
  }
  return [...found.values()];
}
