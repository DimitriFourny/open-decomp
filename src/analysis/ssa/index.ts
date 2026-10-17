import { fingerprint } from '../../core/index.js';
import type { EntityId, RegisterDescriptor } from '../../core/index.js';
import {
  bitWidth,
  computeDominance,
  integer,
  mergeProvenanceSources,
  successors,
} from '../../ir/index.js';
import type {
  BasicBlock,
  DataType,
  Edge,
  Expression,
  Instruction,
  Provenance,
  RegisterBinding,
  RegisterIR,
  SSAConstruction,
  SSAForm,
  Terminator,
  Value,
} from '../../ir/index.js';
import { AnalysisBudget } from './budget.js';
import type { AnalysisOptions, AnalysisResult } from './budget.js';
import { IRConstructionBudget } from '../../ir/budget.js';
export * from './budget.js';

type Cell = RegisterDescriptor;
const key = (cell: Cell): string => `${cell.root}:${cell.offset_bits}:${cell.width_bits}`;

export interface SSAConstructionOptions extends AnalysisOptions {
  /** Source-view ABI storage masks, not a prototype. Every actual architectural
   * read/write root stays whole; omission retains the full machine view. */
  readonly observable_register_masks?: ReadonlyMap<string, bigint>;
}
/**
 * Minimal region SSA over architectural cells. A block receives a cell parameter
 * only where definitions of that cell meet (iterated dominance frontier); other
 * uses reference the dominating definition directly. The entry and every
 * unreachable-component root bind every cell. All predecessor edges, including
 * backedges and unreachable components, pass their merged cells simultaneously.
 * Cells split at every access boundary, retaining known unaffected slices across
 * partial writes/call clobbers. Entry/exit and call snapshots are semantic roots;
 * non-exit blocks record only the cells they rebind, so full per-block state is
 * derived along dominators (registerStateAt), never materialized per block.
 * Register effects disappear; memory/call/unknown effect order is unchanged.
 */
export function constructSSA(
  input: RegisterIR,
  options: SSAConstructionOptions = {},
): AnalysisResult<RegisterIR | SSAForm> {
  const budget = new AnalysisBudget(options);
  try {
    return budget.result(build(input, budget, options.observable_register_masks));
  } catch (error) {
    return budget.result(input, error);
  }
}

/** Implements the IR construction contract; callers needing partial results use constructSSA. */
export class RegisterSSAConstruction implements SSAConstruction {
  construct(input: RegisterIR, checkpoint: (work: number) => void): SSAForm {
    return build(input, new AnalysisBudget({ checkpoint }));
  }
}

/** Add run boundaries without visiting every bit of a wide architectural root. */
function observableCuts(
  mask: bigint,
  width: number,
  cuts: Set<number>,
  budget: AnalysisBudget,
): void {
  const full = (1n << BigInt(width)) - 1n;
  mask &= full;
  if (mask === full) return;
  let boundaries = mask ^ (mask << 1n),
    base = 0;
  while (boundaries !== 0n) {
    budget.charge();
    let word = Number(boundaries & 0xffffffffn);
    while (word !== 0) {
      budget.charge();
      const offset = base + 31 - Math.clz32(word & -word);
      if (offset > 0 && offset < width) cuts.add(offset);
      word &= word - 1;
    }
    boundaries >>= 32n;
    base += 32;
  }
}

function build(
  input: RegisterIR,
  budget: AnalysisBudget,
  observableMasks?: ReadonlyMap<string, bigint>,
): SSAForm {
  const capacity = new IRConstructionBudget({
    ...budget.options,
    checkpoint: (work) => budget.charge(work),
  });
  budget.charge(0);
  // Discover actual uses before filtering clobbers: a later access can require
  // an earlier clobber's slice boundary. The second pass retains original order.
  const actualRoots = observableMasks === undefined ? null : new Set<string>();
  if (actualRoots)
    for (const block of input.blocks) {
      budget.charge();
      for (const node of block.instructions) {
        budget.charge();
        if (node.kind === 'read_register' || node.kind === 'write_register')
          actualRoots.add(node.register.root);
      }
    }
  const roots = new Map<string, { descriptor: RegisterDescriptor; cuts: Set<number> }>();
  const register = (descriptor: RegisterDescriptor): void => {
    budget.charge();
    if (descriptor.role === 'zero') return;
    const known = roots.get(descriptor.root);
    const root = known ?? {
      descriptor,
      cuts: new Set([0, descriptor.root_width_bits]),
    };
    if (!known && observableMasks !== undefined && !actualRoots!.has(descriptor.root))
      observableCuts(
        observableMasks.get(descriptor.root) ?? 0n,
        descriptor.root_width_bits,
        root.cuts,
        budget,
      );
    if (root.descriptor.root_width_bits !== descriptor.root_width_bits)
      throw new TypeError('Inconsistent architectural register root width');
    // Preserve explicit architectural roles even when the first view was a general slice.
    if (root.descriptor.role === 'general' && descriptor.role !== 'general')
      root.descriptor = descriptor;
    for (let offset = 2048; offset < descriptor.root_width_bits; offset += 2048)
      root.cuts.add(offset);
    root.cuts.add(descriptor.offset_bits);
    root.cuts.add(descriptor.offset_bits + descriptor.width_bits);
    roots.set(descriptor.root, root);
  };
  for (const block of input.blocks) {
    budget.charge();
    for (const node of block.instructions) {
      budget.charge();
      if (node.kind === 'read_register' || node.kind === 'write_register') register(node.register);
      if (node.kind === 'call' || node.kind === 'unknown_effect')
        for (const descriptor of [...node.clobbers.registers, ...node.clobbers.flags]) {
          if (
            observableMasks === undefined ||
            (observableMasks.get(descriptor.root) ?? 0n) !== 0n ||
            actualRoots!.has(descriptor.root)
          )
            register(descriptor);
          else budget.charge(); // The original clobber metadata is still visited and retained.
        }
    }
  }
  const cells: Cell[] = [];
  const cellsByRoot = new Map<string, Cell[]>();
  for (const [root, { descriptor, cuts }] of roots) {
    const rootCells: Cell[] = [];
    cellsByRoot.set(root, rootCells);
    const ordered = [...cuts].sort((a, b) => a - b);
    for (let i = 1; i < ordered.length; i++) {
      const offset = ordered[i - 1]!,
        width = ordered[i]! - offset;
      budget.charge();
      if (
        observableMasks !== undefined &&
        !actualRoots!.has(root) &&
        ((observableMasks.get(root) ?? 0n) & (((1n << BigInt(width)) - 1n) << BigInt(offset))) ===
          0n
      )
        continue;
      const cell: Cell = Object.freeze({
        ...descriptor,
        id: `ssa:${fingerprint([root, offset, width]).slice(0, 32)}`,
        offset_bits: offset,
        width_bits: width,
        write_rule: 'preserve_other_bits',
      });
      budget.charge(); // Flat immutable descriptor publication enables local validation reuse.
      cells.push(cell);
      rootCells.push(cell);
    }
  }
  const identity = (...birth: readonly (string | number)[]): EntityId =>
    `entity_${fingerprint(['register-ssa', input.id, ...birth])}`;
  const cellIndex = new Map(cells.map((cell, index) => [key(cell), index]));
  const matching = (descriptor: RegisterDescriptor): Cell[] => {
    budget.charge();
    return (cellsByRoot.get(descriptor.root) ?? []).filter((cell) => {
      budget.charge();
      return (
        cell.offset_bits >= descriptor.offset_bits &&
        cell.offset_bits + cell.width_bits <= descriptor.offset_bits + descriptor.width_bits
      );
    });
  };
  // Cells each block may rebind: written slices, zero-extended roots and clobbers.
  const definitions = cells.map(() => new Set<number>());
  input.blocks.forEach((block, index) => {
    for (const node of block.instructions) {
      budget.charge();
      if (node.kind === 'write_register' && node.register.write_rule !== 'discard') {
        const { root, offset_bits: low, width_bits: width, write_rule: rule } = node.register;
        for (const cell of cellsByRoot.get(root) ?? []) {
          budget.charge();
          if (
            rule === 'zero_extend_root' ||
            (cell.offset_bits >= low && cell.offset_bits + cell.width_bits <= low + width)
          )
            definitions[cellIndex.get(key(cell))!]!.add(index);
        }
      } else if (node.kind === 'call' || node.kind === 'unknown_effect')
        for (const descriptor of [...node.clobbers.registers, ...node.clobbers.flags])
          for (const cell of matching(descriptor))
            definitions[cellIndex.get(key(cell))!]!.add(index);
    }
  });
  // Minimal SSA: a block receives a cell parameter only on the iterated
  // dominance frontier of that cell's definitions. Blocks without a dominator
  // (the entry and every unreachable-component root) bind every cell.
  const dominance = computeDominance(input, (work) => budget.charge(work));
  const slots = new Map(input.blocks.map((block, index) => [block.id, index]));
  const idoms = input.blocks.map((block) => {
    const parent = dominance.idom(block.id);
    return parent === null ? -1 : slots.get(parent)!;
  });
  const predecessors = input.blocks.map((): number[] => []);
  input.blocks.forEach((block, index) => {
    for (const edge of successors(block.terminator)) {
      budget.charge();
      const target = slots.get(edge.target);
      if (target !== undefined) predecessors[target]!.push(index);
    }
  });
  const frontier = input.blocks.map((): number[] => []);
  predecessors.forEach((incoming, index) => {
    if (incoming.length < 2 || idoms[index] === -1) return;
    for (const predecessor of incoming)
      for (
        let runner = predecessor;
        runner !== -1 && runner !== idoms[index];
        runner = idoms[runner]!
      ) {
        budget.charge();
        if (frontier[runner]!.at(-1) !== index) frontier[runner]!.push(index);
      }
  });
  const parameterCells = idoms.map((parent) => (parent === -1 ? cells.map((_, cell) => cell) : []));
  const unrooted = idoms.flatMap((parent, index) => (parent === -1 ? [index] : []));
  definitions.forEach((blocksDefining, cell) => {
    const pending = [...blocksDefining, ...unrooted],
      seen = new Set(pending),
      placed = new Set<number>();
    while (pending.length) {
      budget.charge();
      for (const join of frontier[pending.pop()!]!) {
        budget.charge();
        if (placed.has(join)) continue;
        placed.add(join);
        parameterCells[join]!.push(cell);
        if (!seen.has(join)) {
          seen.add(join);
          pending.push(join);
        }
      }
    }
  });
  // Rename along the dominator tree. Undo records restore the dominating state.
  const state = new Map<string, Value>();
  const undo: [string, Value | undefined][] = [];
  const set = (cell: string, value: Value): void => {
    undo.push([cell, state.get(cell)]);
    state.set(cell, value);
  };
  const snapshot = (): RegisterBinding[] =>
    cells.map((cell) => {
      budget.charge();
      return { register: cell, value: state.get(key(cell))! };
    });
  const blocks: BasicBlock[] = new Array(input.blocks.length);
  const states: SSAForm['register_states'][number][] = new Array(input.blocks.length);
  const visit = (index: number): void => {
    budget.charge();
    const block = input.blocks[index]!;
    capacity.block(block.parameters.length + parameterCells[index]!.length);
    const entry = parameterCells[index]!.map((slot): RegisterBinding => {
      budget.charge();
      const cell = cells[slot]!;
      const value = { id: identity(block.id, 'entry', key(cell)), type: integer(cell.width_bits) };
      set(key(cell), value);
      return { register: cell, value };
    });
    // Block-entry value of every cell rebound in this block.
    const rebound = new Map<string, Value | undefined>();
    const write = (cell: string, value: Value): void => {
      if (!rebound.has(cell)) rebound.set(cell, state.get(cell));
      set(cell, value);
    };
    const nodes: Instruction[] = [];
    let effect = block.effect_parameter;
    let sequence = 0;
    // Register writes disappear; their origins join the terminator once.
    const writes: Provenance[] = [];
    const assign = (type: DataType, expression: Expression, provenance: Provenance): Value => {
      capacity.nodes();
      const id = identity(block.id, 'generated', sequence++);
      const value = { id: identity(id, 'value'), type };
      nodes.push({ kind: 'assign', id, result: value, expression, provenance });
      return value;
    };
    for (const node of block.instructions) {
      budget.charge();
      if (node.kind === 'read_register') {
        const descriptor = node.register;
        let value: Value;
        if (descriptor.role === 'zero')
          value = assign(
            integer(descriptor.width_bits),
            { kind: 'constant', bits: 0n },
            node.provenance,
          );
        else {
          const parts = matching(descriptor);
          if (parts.length === 1) value = state.get(key(parts[0]!))!;
          else
            value = assign(
              integer(descriptor.width_bits),
              { kind: 'concat', values: parts.map((cell) => state.get(key(cell))!) },
              node.provenance,
            );
        }
        capacity.nodes();
        nodes.push({
          kind: 'assign',
          id: node.id,
          result: node.result,
          expression: { kind: 'cast', op: 'bitcast', value },
          provenance: node.provenance,
        });
      } else if (node.kind === 'write_register') {
        const descriptor = node.register;
        writes.push(node.provenance);
        if (descriptor.write_rule === 'discard') continue;
        const raw =
          node.value.type.kind === 'integer'
            ? node.value
            : assign(
                integer(bitWidth(node.value.type)),
                { kind: 'cast', op: 'bitcast', value: node.value },
                node.provenance,
              );
        for (const cell of cellsByRoot.get(descriptor.root) ?? []) {
          budget.charge();
          const inside =
            cell.offset_bits >= descriptor.offset_bits &&
            cell.offset_bits + cell.width_bits <= descriptor.offset_bits + descriptor.width_bits;
          if (inside) {
            const value =
              cell.width_bits === descriptor.width_bits
                ? raw
                : assign(
                    integer(cell.width_bits),
                    {
                      kind: 'extract',
                      value: raw,
                      offset: cell.offset_bits - descriptor.offset_bits,
                    },
                    node.provenance,
                  );
            // Keep the write's source even when its value was defined elsewhere.
            write(
              key(cell),
              assign(value.type, { kind: 'cast', op: 'bitcast', value }, node.provenance),
            );
          } else if (descriptor.write_rule === 'zero_extend_root')
            write(
              key(cell),
              assign(integer(cell.width_bits), { kind: 'constant', bits: 0n }, node.provenance),
            );
        }
      } else if (node.kind === 'call' || node.kind === 'unknown_effect') {
        const before = snapshot();
        const clobbered = new Set(
          [...node.clobbers.registers, ...node.clobbers.flags].flatMap((descriptor) =>
            matching(descriptor).map(key),
          ),
        );
        const outputs: RegisterBinding[] = [];
        for (const cell of cells) {
          budget.charge();
          if (!clobbered.has(key(cell))) continue;
          const value = {
            id: identity(node.id, 'clobber', key(cell)),
            type: integer(cell.width_bits),
          };
          outputs.push({ register: cell, value });
          write(key(cell), value);
        }
        capacity.nodes();
        nodes.push({
          ...node,
          effect_in: effect,
          register_inputs: before,
          register_outputs: outputs,
        });
        effect = node.effect_out;
      } else if (node.kind === 'load' || node.kind === 'store') {
        capacity.nodes();
        nodes.push({ ...node, effect_in: effect, register_inputs: snapshot() });
        effect = node.effect_out;
      } else if (node.kind === 'memory_fence') {
        capacity.nodes();
        nodes.push({ ...node, effect_in: effect });
        effect = node.effect_out;
      } else {
        capacity.nodes();
        nodes.push(node);
      }
    }
    // Function exits observe every cell; other blocks list only rebound cells.
    const exit =
      successors(block.terminator).length === 0
        ? snapshot()
        : [...rebound]
            .filter(([cell, initial]) => {
              budget.charge();
              return state.get(cell) !== initial;
            })
            .map(([cell]) => cellIndex.get(cell)!)
            .sort((a, b) => a - b)
            .map((slot): RegisterBinding => ({
              register: cells[slot]!,
              value: state.get(key(cells[slot]!))!,
            }));
    const edge = (old: Edge): Edge => {
      const target = parameterCells[slots.get(old.target) ?? -1] ?? [];
      budget.charge(1 + old.arguments.length + target.length);
      return {
        ...old,
        arguments: [...old.arguments, ...target.map((slot) => state.get(key(cells[slot]!))!)],
        effect,
      };
    };
    let terminator: Terminator = {
      ...block.terminator,
      effect,
      provenance: mergeProvenanceSources(
        [block.terminator.provenance, block.provenance, ...writes],
        (work) => budget.charge(work),
      ),
    };
    switch (terminator.kind) {
      case 'jump':
        terminator = { ...terminator, edge: edge(terminator.edge) };
        break;
      case 'branch':
        terminator = {
          ...terminator,
          when_true: edge(terminator.when_true),
          when_false: edge(terminator.when_false),
        };
        break;
      case 'switch':
        terminator = {
          ...terminator,
          cases: terminator.cases.map((item) => ({ ...item, edge: edge(item.edge) })),
          otherwise: edge(terminator.otherwise),
        };
        break;
    }
    blocks[index] = {
      ...block,
      parameters: [...block.parameters, ...entry.map((binding) => binding.value)],
      instructions: nodes,
      terminator,
    };
    states[index] = { block: block.id, entry, exit };
  };
  const children = input.blocks.map((): number[] => []);
  idoms.forEach((parent, index) => {
    if (parent !== -1) children[parent]!.push(index);
  });
  for (const start of unrooted) {
    const stack = [{ index: start, cursor: 0, marker: undo.length }];
    visit(start);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const child = children[frame.index]![frame.cursor++];
      if (child !== undefined) {
        stack.push({ index: child, cursor: 0, marker: undo.length });
        visit(child);
        continue;
      }
      stack.pop();
      while (undo.length > frame.marker) {
        budget.charge();
        const [cell, previous] = undo.pop()!;
        if (previous === undefined) state.delete(cell);
        else state.set(cell, previous);
      }
    }
  }
  return { ...input, form: 'ssa', blocks, register_states: states };
}
