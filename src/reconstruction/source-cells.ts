import type { OperationContext } from '../core/index.js';
import {
  bitWidth,
  integer,
  type DataType,
  type Expression,
  type RegisterBinding,
  type Value,
} from '../ir/index.js';
import type { BlockRegion, ParallelTransfer } from '../presentation/index.js';
import { identityOperand } from './expressions.js';
import { validateConstantCells, type LocalValidationSession } from './local-validation.js';
type Copies = ParallelTransfer['copies'];

interface CellPlan {
  make(
    key: string,
    type: DataType,
    block: string,
    expression?: Expression,
    contributors?: readonly Value[],
  ): Value;
  alias(value: Value, expression: Expression): void;
}

/** How one incoming edge writes every cell of a phi group at once. */
type EdgeSource =
  /** Corresponding slices of one value (`bits` is the covered low width). */
  | { readonly kind: 'value' | 'zero_extend'; readonly value: Value; readonly bits: number }
  | { readonly kind: 'constant'; readonly bits: bigint }
  /** The unchanged cells of another (or the same) candidate phi group. */
  | { readonly kind: 'group'; readonly group: CellGroup }
  /** Every cell is an unknown (unavailable) value of the same reason. */
  | { readonly kind: 'unknown'; readonly reason: string };

interface CellGroup {
  readonly block: BlockRegion;
  readonly root: string;
  readonly bindings: readonly RegisterBinding[];
  readonly width: number;
  /** Only corresponding slices of one value of exactly this width qualify. */
  readonly exact: boolean;
  /** Some cell is a parameter that range analysis folded to a constant: the
   * group is recombined only when every edge writes one whole constant. */
  readonly folded: boolean;
  readonly edges: { readonly transfer: ParallelTransfer; readonly source: EdgeSource }[];
  recorded?: boolean;
}

/** Transport one whole bitvector instead of its independently allocated SSA
 * cells. The machine SSA and original transfer objects remain immutable. */
export function recombineSourceCells(
  blocks: Map<string, BlockRegion>,
  transfers: readonly { transfer: ParallelTransfer; block: BlockRegion }[],
  expressions: ReadonlyMap<string, Expression>,
  incoming: Map<string, Value[]>,
  plan: CellPlan,
  validation: LocalValidationSession,
  context: OperationContext,
): Map<ParallelTransfer, Copies> {
  const replacements = new Map<ParallelTransfer, Copies>();
  const edges = new Map<string, ParallelTransfer[]>();
  for (const { transfer } of transfers) {
    context.checkpoint(1);
    for (const destination of new Set(transfer.copies.map((copy) => copy.destination.id))) {
      const list = edges.get(destination) ?? [];
      list.push(transfer);
      edges.set(destination, list);
    }
  }
  // Follow only exact integer identity/extraction views. In particular, do not
  // infer a whole value from two independently computed arithmetic halves.
  const slice = (original: Value): { value: Value; offset: number } => {
    let value = original,
      offset = 0;
    const seen = new Set<string>();
    while (!seen.has(value.id)) {
      context.checkpoint(1);
      seen.add(value.id);
      const expression = expressions.get(value.id);
      if (!expression) break;
      const alias = identityOperand(value.type, expression);
      if (alias) value = alias;
      else if (expression.kind === 'extract') {
        offset += expression.offset;
        value = expression.value;
      } else if (expression.kind === 'cast' && expression.op === 'truncate') {
        value = expression.value;
      } else break;
    }
    return { value, offset };
  };
  const constantBits = (piece: Value): bigint | null => {
    const { value, offset } = slice(piece);
    const expression = expressions.get(value.id);
    return expression?.kind === 'constant' && piece.type.kind === 'integer'
      ? BigInt.asUintN(bitWidth(piece.type), expression.bits >> BigInt(offset))
      : null;
  };
  // Phi cells carried unchanged from one block to another hold one source
  // variable; group them into webs. A concat of adjacent cells is a joint read
  // of the upper cell with the cell below it, anywhere in that cell's web.
  // `cellRegisters` also holds the parameters range analysis already folded to a
  // constant (every incoming copy is still there): `value7 = 1` on every edge
  // must not keep `value6` from its other half, so such a cell may join a group
  // but never forms a web.
  const phiCells = new Map<string, RegisterBinding['register']>();
  const cellRegisters = new Map<string, RegisterBinding['register']>();
  for (const block of blocks.values()) {
    const parameters = new Set(block.parameters.map((value) => value.id));
    for (const binding of block.register_entry) {
      context.checkpoint(1);
      if (!parameters.has(binding.value.id)) continue;
      const expression = expressions.get(binding.value.id);
      if (!expression) phiCells.set(binding.value.id, binding.register);
      if (!expression || expression.kind === 'constant')
        cellRegisters.set(binding.value.id, binding.register);
    }
  }
  const webs = new Map<string, string>();
  const web = (id: string): string => {
    let root = id;
    for (let next = webs.get(root); next !== undefined && next !== root; next = webs.get(root)) {
      context.checkpoint(1);
      root = next;
    }
    webs.set(id, root);
    return root;
  };
  for (const { transfer } of transfers)
    for (const { destination, source } of transfer.copies) {
      context.checkpoint(1);
      const to = phiCells.get(destination.id),
        from = phiCells.get(source.id);
      if (
        to &&
        from &&
        to.root === from.root &&
        to.offset_bits === from.offset_bits &&
        to.width_bits === from.width_bits
      )
        webs.set(web(destination.id), web(source.id));
    }
  const joined = new Set<string>();
  for (const expression of expressions.values()) {
    context.checkpoint(1);
    if (expression.kind !== 'concat') continue;
    for (let index = 1; index < expression.values.length; index++) {
      const lower = cellRegisters.get(expression.values[index - 1]!.id),
        upper = cellRegisters.get(expression.values[index]!.id);
      if (
        lower &&
        upper &&
        lower.root === upper.root &&
        lower.offset_bits + lower.width_bits === upper.offset_bits
      )
        joined.add(web(expression.values[index]!.id));
    }
  }
  const groups: CellGroup[] = [];
  const byCells = new Map<string, CellGroup>();
  for (const block of blocks.values()) {
    // Only this block's own phis: its entry bindings may also list values
    // that are another block's parameters, whose edges never reach it.
    const parameters = new Set(block.parameters.map((value) => value.id));
    const roots = new Map<string, RegisterBinding[]>();
    for (const binding of block.register_entry) {
      context.checkpoint(1);
      if (!parameters.has(binding.value.id) || !cellRegisters.has(binding.value.id)) continue;
      const list = roots.get(binding.register.root) ?? [];
      list.push(binding);
      roots.set(binding.register.root, list);
    }
    for (const [root, cells] of roots) {
      if (cells.length < 2) continue;
      cells.sort((left, right) => left.register.offset_bits - right.register.offset_bits);
      const { root_width_bits: rootWidth, bank } = cells[0]!.register;
      let end = 0;
      const complete = cells.every(({ register, value }) => {
        context.checkpoint(1);
        if (
          register.offset_bits !== end ||
          register.root_width_bits !== rootWidth ||
          register.bank !== bank ||
          value.type.kind !== 'integer' ||
          bitWidth(value.type) !== register.width_bits
        )
          return false;
        end += register.width_bits;
        return true;
      });
      if (!complete || end !== rootWidth) continue;
      // General-purpose cells form one whole only as far as they are read
      // together: cells above the jointly read low run, and cells only ever
      // read as separate slices, keep their own phis. Other banks join only
      // complete roots carried as slices of one whole value.
      const exact = bank !== 'integer';
      let count = 1;
      while (!exact && count < cells.length && joined.has(web(cells[count]!.value.id))) count++;
      const bindings = exact ? cells : cells.slice(0, count);
      if (bindings.length < 2) continue;
      const last = bindings.at(-1)!.register,
        width = last.offset_bits + last.width_bits;
      const predecessors = edges.get(bindings[0]!.value.id) ?? [];
      if (
        !predecessors.length ||
        bindings.some(({ value }) => {
          const incomingEdges = edges.get(value.id) ?? [];
          return (
            incomingEdges.length !== predecessors.length ||
            incomingEdges.some((edge) => !predecessors.includes(edge))
          );
        })
      )
        continue;
      const folded = bindings.some(({ value }) => expressions.has(value.id));
      const group: CellGroup = { block, root, bindings, width, exact, folded, edges: [] };
      groups.push(group);
      byCells.set(bindings.map(({ value }) => value.id).join(','), group);
    }
  }
  const jointSource = (group: CellGroup, pieces: readonly Value[]): EdgeSource | null => {
    const { bindings, width, exact } = group;
    const carried = byCells.get(pieces.map(({ id }) => id).join(','));
    if (
      !exact &&
      carried &&
      carried.width === width &&
      carried.bindings.every(
        ({ register }, index) =>
          register.offset_bits === bindings[index]!.register.offset_bits &&
          register.width_bits === bindings[index]!.register.width_bits,
      )
    )
      return { kind: 'group', group: carried };
    const lanes = pieces.map(constantBits);
    if (!exact && lanes.every((lane) => lane !== null)) {
      let bits = 0n;
      for (const [index, lane] of lanes.entries())
        bits |= lane! << BigInt(bindings[index]!.register.offset_bits);
      return { kind: 'constant', bits };
    }
    // Cells that are each the same unavailable value are, jointly, that value.
    const unknown = pieces.map((piece) => expressions.get(piece.id));
    const first = unknown[0];
    if (
      first?.kind === 'indeterminate' &&
      first.state === 'unknown' &&
      unknown.every(
        (expression) =>
          expression?.kind === 'indeterminate' &&
          expression.state === 'unknown' &&
          expression.reason === first.reason,
      )
    )
      return { kind: 'unknown', reason: first.reason };
    // Longest low prefix of corresponding slices of one value. Low slices of v
    // are also the low slices of an extension of v, so upper cells that slice
    // sign_extend(v) or zero_extend(v) extend the same whole.
    let whole: Value | undefined,
      prefix = 0;
    for (const [index, piece] of pieces.entries()) {
      const { register } = bindings[index]!,
        part = slice(piece);
      if (
        part.offset !== register.offset_bits ||
        part.value.type.kind !== 'integer' ||
        bitWidth(part.value.type) < register.offset_bits + register.width_bits
      )
        break;
      if (whole && whole.id !== part.value.id) {
        // The extended operand must be the low bits of `whole` that already
        // contain every lower cell.
        const extension = expressions.get(part.value.id);
        const extended =
          extension?.kind === 'cast' &&
          (extension.op === 'sign_extend' || extension.op === 'zero_extend')
            ? extension.value
            : undefined;
        const operand = extended && slice(extended);
        if (
          exact ||
          !extended ||
          !operand ||
          operand.value.id !== whole.id ||
          operand.offset !== 0 ||
          bitWidth(extended.type) < register.offset_bits
        )
          break;
      }
      whole = part.value;
      prefix = index + 1;
    }
    if (prefix === pieces.length && (!exact || bitWidth(whole!.type) === width))
      return { kind: 'value', value: whole!, bits: width };
    if (!whole || exact) return null;
    // A partial write that clears every remaining upper cell is a zero extension
    // of its low slices.
    const last = bindings[prefix - 1]!.register;
    return lanes.slice(prefix).every((lane) => lane === 0n)
      ? { kind: 'zero_extend', value: whole, bits: last.offset_bits + last.width_bits }
      : null;
  };
  // Classify every incoming edge before any alias exists. A group whose cells
  // are not written jointly on some edge keeps its separate cells.
  const rejected = new Set<CellGroup>();
  for (const group of groups) {
    const { bindings } = group;
    for (const transfer of edges.get(bindings[0]!.value.id)!) {
      context.checkpoint(bindings.length);
      const pieces: Value[] = [];
      for (const binding of bindings) {
        const matches = transfer.copies.filter((copy) => copy.destination.id === binding.value.id);
        context.checkpoint(transfer.copies.length);
        if (matches.length !== 1) break;
        pieces.push(matches[0]!.source);
      }
      let source = pieces.length === bindings.length ? jointSource(group, pieces) : null;
      if (source && group.folded && source.kind !== 'constant') source = null;
      // Each recombined constant is proved on its own edge: the cells'
      // concatenation (low cell first) equals the whole constant.
      if (source?.kind === 'constant') {
        const subject = bindings[0]!.value.id,
          bits = source.bits;
        if (
          validation.check(
            'bitvector',
            subject,
            'register cells written as constants on one edge concatenate to the whole constant',
            () => validateConstantCells(subject, pieces, bits, expressions, context),
            pieces.map(({ id }) => id),
          ).status !== 'verified'
        )
          source = null;
      }
      if (!source) {
        rejected.add(group);
        break;
      }
      group.edges.push({ transfer, source });
    }
  }
  // Carried cells are joint only while the carrying group is recombined too.
  for (let changed = true; changed;) {
    changed = false;
    for (const group of groups) {
      context.checkpoint(group.edges.length + 1);
      if (
        !rejected.has(group) &&
        group.edges.some(({ source }) => source.kind === 'group' && rejected.has(source.group))
      ) {
        rejected.add(group);
        changed = true;
      }
    }
    if (changed) continue;
    for (const group of groups) {
      if (rejected.has(group) || group.recorded) continue;
      group.recorded = validation.presentation(
        'register_cell_recombination',
        group.bindings[0]!.value.id,
        'complete contiguous integer root cells written jointly on every incoming edge: corresponding slices of one identical whole value, a zero extension of low slices of one value, one constant, unknown cells of one reason, or the unchanged cells of another recombined phi; preserves simultaneous transfers and full-width carries',
        group.bindings.map(({ value }) => value.id),
      );
      if (!group.recorded) {
        rejected.add(group);
        changed = true;
      }
    }
  }
  const accepted = groups.filter((group) => !rejected.has(group));
  const key = (group: CellGroup): string => `cell-phi:${group.block.id}:${group.root}`;
  const wholes = new Map<CellGroup, Value>();
  for (const group of accepted)
    wholes.set(
      group,
      plan.make(
        key(group),
        integer(group.width),
        group.block.id,
        undefined,
        group.bindings.map(({ value }) => value),
      ),
    );
  const owners = new Map(transfers.map(({ transfer, block }) => [transfer, block.id]));
  const added = new Map<string, Value[]>();
  for (const group of accepted) {
    const whole = wholes.get(group)!;
    const sources = group.edges.map(({ transfer, source }, index): Value => {
      context.checkpoint(1);
      const block = owners.get(transfer)!,
        edge = `${key(group)}:edge:${index}`;
      switch (source.kind) {
        case 'group':
          return wholes.get(source.group)!;
        case 'unknown':
          return plan.make(edge, integer(group.width), block, {
            kind: 'indeterminate',
            state: 'unknown',
            reason: source.reason,
          });
        case 'constant':
          return plan.make(edge, integer(group.width), block, {
            kind: 'constant',
            bits: source.bits,
          });
        case 'value':
        case 'zero_extend': {
          const low =
            bitWidth(source.value.type) === source.bits
              ? source.value
              : plan.make(`${edge}:low`, integer(source.bits), block, {
                  kind: 'extract',
                  value: source.value,
                  offset: 0,
                });
          return source.bits === group.width
            ? low
            : plan.make(edge, integer(group.width), block, {
                kind: 'cast',
                op: 'zero_extend',
                value: low,
              });
        }
      }
    });
    incoming.set(whole.id, sources);
    const replaced = new Set(group.bindings.map(({ value }) => value.id));
    for (const [index, { transfer }] of group.edges.entries()) {
      const copies = replacements.get(transfer) ?? transfer.copies;
      replacements.set(transfer, [
        ...copies.filter((copy) => !replaced.has(copy.destination.id)),
        { destination: whole, source: sources[index]! },
      ]);
    }
    for (const binding of group.bindings) {
      incoming.delete(binding.value.id);
      plan.alias(binding.value, {
        kind: 'extract',
        value: whole,
        offset: binding.register.offset_bits,
      });
    }
    const list = added.get(group.block.id) ?? [];
    list.push(whole);
    added.set(group.block.id, list);
  }
  for (const [id, wholeValues] of added) {
    const block = blocks.get(id)!;
    blocks.set(id, { ...block, parameters: [...block.parameters, ...wholeValues] });
  }
  return replacements;
}
