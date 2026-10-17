import { fingerprint } from '../../core/index.js';
import type { EntityId, RegisterDescriptor } from '../../core/index.js';
import { bitWidth, integer, mergeProvenanceSources } from '../../ir/index.js';
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
 * Region SSA: every block receives architectural cells as explicit parameters.
 * All predecessor edges, including backedges and unreachable components, pass
 * their final cells simultaneously. No dominance guesses or register-name rules.
 * Cells split at every access boundary, retaining known unaffected slices across
 * partial writes/call clobbers. Entry/exit and call snapshots are semantic roots.
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
function observableCuts(mask: bigint, width: number, cuts: Set<number>, budget: AnalysisBudget): void {
  const full = (1n << BigInt(width)) - 1n;
  mask &= full;
  if (mask === full) return;
  let boundaries = mask ^ (mask << 1n), base = 0;
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

function build(input: RegisterIR, budget: AnalysisBudget,
  observableMasks?: ReadonlyMap<string, bigint>): SSAForm {
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
      observableCuts(observableMasks.get(descriptor.root) ?? 0n,
        descriptor.root_width_bits, root.cuts, budget);
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
          if (observableMasks === undefined || (observableMasks.get(descriptor.root) ?? 0n) !== 0n ||
            actualRoots!.has(descriptor.root))
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
      if (observableMasks !== undefined && !actualRoots!.has(root) &&
        ((observableMasks.get(root) ?? 0n) & (((1n << BigInt(width)) - 1n) << BigInt(offset))) === 0n)
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
  const entries = new Map<EntityId, readonly RegisterBinding[]>();
  for (const block of input.blocks) {
    capacity.block(block.parameters.length + cells.length);
    entries.set(
      block.id,
      cells.map((cell) => {
        budget.charge();
        return {
          register: cell,
          value: { id: identity(block.id, 'entry', key(cell)), type: integer(cell.width_bits) },
        };
      }),
    );
  }
  const states: SSAForm['register_states'][number][] = [];
  const blocks: BasicBlock[] = [];
  for (const block of input.blocks) {
    budget.charge();
    const entry = entries.get(block.id)!;
    const state = new Map(entry.map((binding) => [key(binding.register), binding.value]));
    const nodes: Instruction[] = [];
    let effect = block.effect_parameter;
    let sequence = 0;
    let source = block.provenance;
    const assign = (type: DataType, expression: Expression, provenance: Provenance): Value => {
      capacity.nodes();
      const id = identity(block.id, 'generated', sequence++);
      const value = { id: identity(id, 'value'), type };
      nodes.push({ kind: 'assign', id, result: value, expression, provenance });
      return value;
    };
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
    const snapshot = (): RegisterBinding[] =>
      cells.map((cell) => {
        budget.charge();
        return { register: cell, value: state.get(key(cell))! };
      });
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
        source = mergeProvenanceSources([source, node.provenance], (work) => budget.charge(work));
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
            state.set(
              key(cell),
              assign(value.type, { kind: 'cast', op: 'bitcast', value }, node.provenance),
            );
          } else if (descriptor.write_rule === 'zero_extend_root')
            state.set(
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
          state.set(key(cell), value);
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
    const exit = snapshot();
    const edge = (old: Edge): Edge => {
      budget.charge(1 + old.arguments.length + exit.length);
      return {
        ...old,
        arguments: [...old.arguments, ...exit.map((binding) => binding.value)],
        effect,
      };
    };
    let terminator: Terminator = {
      ...block.terminator,
      effect,
      provenance: mergeProvenanceSources([block.terminator.provenance, source], (work) =>
        budget.charge(work),
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
    blocks.push({
      ...block,
      parameters: [...block.parameters, ...entry.map((binding) => binding.value)],
      instructions: nodes,
      terminator,
    });
    states.push({ block: block.id, entry, exit });
  }
  return { ...input, form: 'ssa', blocks, register_states: states };
}
