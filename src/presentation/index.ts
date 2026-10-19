import type { EntityId, OperationContext } from '../core/index.js';
import { AnalysisBudget } from '../analysis/ssa/budget.js';
import { computeDominance, successors } from '../ir/index.js';
import type { BasicBlock, Edge, SSAForm } from '../ir/index.js';
import type {
  BlockRegion,
  Control,
  ControlArm,
  ParallelTransfer,
  Region,
  StructuredFunction,
  StructuringOptions,
  StructuringResult,
} from './model.js';
export * from './model.js';

type LoopScope = { header: EntityId; members: ReadonlySet<EntityId> };
type Atom = {
  entry: EntityId;
  members: Set<EntityId>;
  region: Region;
  tail: BlockRegion | undefined;
  depth: number;
};

/**
 * Structures validated immutable region SSA without reconstructing source types.
 * Single-entry cyclic SCCs become generic loops; removing header backedges exposes
 * nested loops. Unique-entry successors become sequences or owned if/switch arms.
 * Shared joins, irreducible cycles, unreachable cycles and depth-limited shapes
 * retain real labeled transfers. Switches are only those already established in IR.
 *
 * Every block label is addressable, including labels nested in arms. A sequence is
 * lexical order, NOT implicit fallthrough: its transfers still determine execution.
 * Loop bodies start at the header, repeat only on explicit continue, and leave only
 * on their actual transfers/terminal boundaries. Conditions are evaluated after
 * their block's statements, including on every iteration; nothing is hoisted.
 * Break/continue identify their loop AND exact destination/copies. A renderer must
 * retain labels when a transfer cannot be expressed by its structured syntax.
 *
 * Statements retain identity, provenance, effect tokens and boundary snapshots;
 * function-exit register rows remain observable even for empty returns, and
 * every block records its immediate dominator for derived register state.
 * Coverage includes
 * unreachable blocks. No untouched CFG is embedded in the output. Work bounds cover
 * graph traversal, copies and region construction; depth is capped at 64. Exhaustion
 * or cancellation returns null transactionally, never a truncated presentation.
 */
export function structureControlFlow(
  input: SSAForm,
  context: OperationContext,
  options: StructuringOptions = {},
): StructuringResult {
  const maxDepth = options.max_depth ?? 32;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 64)
    throw new RangeError('Structuring depth must be 1..64');
  const budget = new AnalysisBudget({
    ...(options.max_work === undefined ? {} : { max_work: options.max_work }),
    checkpoint: (work) => context.checkpoint(work),
  });
  try {
    budget.charge(0);
    const blocks = new Map<EntityId, BasicBlock>();
    const edges = new Map<EntityId, readonly Edge[]>();
    const predecessors = new Map<EntityId, EntityId[]>();
    const states = new Map(
      input.register_states.map((state) => {
        budget.charge();
        return [state.block, state] as const;
      }),
    );
    for (const block of input.blocks) {
      budget.charge(1 + block.parameters.length + block.instructions.length);
      blocks.set(block.id, block);
      predecessors.set(block.id, []);
    }
    for (const block of input.blocks) {
      budget.charge(block.terminator.kind === 'switch' ? block.terminator.cases.length + 1 : 1);
      const outgoing = successors(block.terminator);
      edges.set(block.id, outgoing);
      for (const edge of outgoing) {
        budget.charge(1 + edge.arguments.length);
        predecessors.get(edge.target)!.push(block.id);
      }
    }
    // Sparse register rows derive full block state along immediate dominators.
    const dominance = computeDominance(input, (work) => budget.charge(work));
    const transfer = (edge: Edge, scopes: readonly LoopScope[]): ParallelTransfer => {
      const target = blocks.get(edge.target)!;
      let mode: ParallelTransfer['mode'] = 'goto',
        loop: EntityId | undefined;
      for (let i = scopes.length - 1; i >= 0; i--) {
        budget.charge();
        const scope = scopes[i]!;
        if (edge.target === scope.header) {
          mode = 'continue';
          loop = scope.header;
          break;
        }
        if (!scope.members.has(edge.target)) {
          mode = 'break';
          loop = scope.header;
        }
      }
      return {
        kind: 'transfer',
        target: edge.target,
        mode,
        ...(loop === undefined ? {} : { loop }),
        copies: edge.arguments.map((source, index) => {
          budget.charge();
          return { destination: target.parameters[index]!, source };
        }),
        effect: { destination: target.effect_parameter, source: edge.effect },
      };
    };
    const leaf = (id: EntityId, scopes: readonly LoopScope[]): BlockRegion => {
      budget.charge();
      const block = blocks.get(id)!,
        term = block.terminator,
        state = states.get(id)!;
      const origin = { id: term.id, provenance: term.provenance, effect: term.effect };
      let control: Control;
      switch (term.kind) {
        case 'jump':
          control = { ...origin, kind: 'jump', transfer: transfer(term.edge, scopes) };
          break;
        case 'branch':
          control = {
            ...origin,
            kind: 'if',
            condition: term.condition,
            when_true: { transfer: transfer(term.when_true, scopes) },
            when_false: { transfer: transfer(term.when_false, scopes) },
          };
          break;
        case 'switch':
          control = {
            ...origin,
            kind: 'switch',
            value: term.value,
            cases: term.cases.map((item) => ({
              bits: item.bits,
              arm: { transfer: transfer(item.edge, scopes) },
            })),
            otherwise: { transfer: transfer(term.otherwise, scopes) },
            ...(term.jump_table ? { jump_table: term.jump_table } : {}),
          };
          break;
        default:
          control = term;
      }
      return {
        kind: 'block',
        id,
        provenance: block.provenance,
        parameters: block.parameters,
        effect_parameter: block.effect_parameter,
        dominator: dominance.idom(id),
        register_entry: state.entry,
        register_exit: state.exit,
        statements: block.instructions,
        control,
      };
    };
    // Iterative Kosaraju avoids call-stack dependence on adversarial CFG size.
    const components = (ids: ReadonlySet<EntityId>, scopes: readonly LoopScope[]): EntityId[][] => {
      const suppressed = new Set(scopes.map((scope) => scope.header));
      const adjacent = new Map<EntityId, EntityId[]>(),
        reverse = new Map<EntityId, EntityId[]>();
      for (const id of ids) {
        budget.charge();
        adjacent.set(id, []);
        reverse.set(id, []);
      }
      for (const id of ids)
        for (const edge of edges.get(id)!) {
          budget.charge();
          if (ids.has(edge.target) && !suppressed.has(edge.target)) {
            adjacent.get(id)!.push(edge.target);
            reverse.get(edge.target)!.push(id);
          }
        }
      const seen = new Set<EntityId>(),
        ordered: EntityId[] = [];
      for (const start of ids) {
        budget.charge();
        if (seen.has(start)) continue;
        seen.add(start);
        const stack = [{ id: start, index: 0 }];
        while (stack.length) {
          budget.charge();
          const top = stack[stack.length - 1]!,
            next = adjacent.get(top.id)![top.index++];
          if (next === undefined) {
            ordered.push(top.id);
            stack.pop();
          } else if (!seen.has(next)) {
            seen.add(next);
            stack.push({ id: next, index: 0 });
          }
        }
      }
      seen.clear();
      const result: EntityId[][] = [];
      for (let i = ordered.length - 1; i >= 0; i--) {
        const start = ordered[i]!;
        budget.charge();
        if (seen.has(start)) continue;
        const component: EntityId[] = [],
          stack = [start];
        seen.add(start);
        while (stack.length) {
          const id = stack.pop()!;
          budget.charge();
          component.push(id);
          for (const previous of reverse.get(id)!) {
            budget.charge();
            if (!seen.has(previous)) {
              seen.add(previous);
              stack.push(previous);
            }
          }
        }
        result.push(component);
      }
      return result;
    };
    const build = (
      ids: Set<EntityId>,
      entry: EntityId,
      scopes: readonly LoopScope[],
      depth: number,
    ): Region => {
      const atoms = new Map<EntityId, Atom>(),
        owner = new Map<EntityId, Atom>();
      const groups =
        depth + 2 < maxDepth
          ? components(ids, scopes)
          : [...ids].map((id) => {
              budget.charge();
              return [id];
            });
      // Reduce successors before owners; early arm absorption strands its continuation.
      for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex--) {
        const group = groups[groupIndex]!;
        budget.charge(group.length);
        const members = new Set(group),
          entries = new Set<EntityId>();
        for (const id of group) {
          if (id === input.entry) entries.add(id);
          for (const previous of predecessors.get(id)!) {
            budget.charge();
            if (!members.has(previous)) entries.add(id);
          }
        }
        const cyclic =
          group.length > 1 ||
          edges.get(group[0]!)!.some((edge) => {
            budget.charge();
            return (
              edge.target === group[0] && !scopes.some((scope) => scope.header === edge.target)
            );
          });
        if (depth + 2 < maxDepth && cyclic && entries.size === 1) {
          const header = entries.values().next().value!;
          const body = build(members, header, [...scopes, { header, members }], depth + 2);
          const atom: Atom = {
            entry: header,
            members,
            region: { kind: 'loop', header, body },
            tail: undefined,
            depth: regionDepth(body) + 1,
          };
          atoms.set(header, atom);
          for (const id of group) owner.set(id, atom);
        } else
          for (const id of group) {
            budget.charge();
            const block = leaf(id, scopes),
              atom: Atom = {
                entry: id,
                members: new Set([id]),
                region: block,
                tail: block,
                depth: 1,
              };
            atoms.set(id, atom);
            owner.set(id, atom);
          }
      }
      const replaceTail = (atom: Atom, block: BlockRegion): void => {
        if (atom.region.kind === 'sequence') {
          budget.charge(atom.region.regions.length);
          atom.region = { kind: 'sequence', regions: [...atom.region.regions.slice(0, -1), block] };
        } else atom.region = block;
        atom.tail = block;
      };
      const absorb = (source: Atom, target: Atom): void => {
        for (const id of target.members) {
          budget.charge();
          source.members.add(id);
          owner.set(id, source);
        }
        atoms.delete(target.entry);
      };
      let changed = true;
      while (changed) {
        changed = false;
        for (const atom of atoms.values()) {
          budget.charge();
          if (!atom.tail) continue;
          const control = atom.tail.control;
          const arms: ControlArm[] =
            control.kind === 'if'
              ? [control.when_true, control.when_false]
              : control.kind === 'switch'
                ? [...control.cases.map((item) => item.arm), control.otherwise]
                : control.kind === 'jump'
                  ? [{ transfer: control.transfer }]
                  : [];
          for (const arm of arms) {
            budget.charge();
            if (arm.body || arm.transfer.mode !== 'goto') continue;
            const target = owner.get(arm.transfer.target);
            if (
              !target ||
              target === atom ||
              target.entry !== arm.transfer.target ||
              target.members.has(entry)
            )
              continue;
            let incoming = 0;
            for (const id of target.members)
              for (const previous of predecessors.get(id)!) {
                budget.charge();
                if (!target.members.has(previous)) incoming++;
              }
            if (incoming !== 1) continue;
            const nextDepth =
              control.kind === 'jump'
                ? Math.max(
                    atom.region.kind === 'sequence' ? atom.depth - 1 : atom.depth,
                    target.region.kind === 'sequence' ? target.depth - 1 : target.depth,
                  ) + 1
                : Math.max(atom.depth, target.depth + (atom.region.kind === 'sequence' ? 2 : 1));
            if (depth + nextDepth >= maxDepth) continue;
            const nextTransfer: ParallelTransfer = { ...arm.transfer, mode: 'next' };
            if (control.kind === 'jump') {
              replaceTail(atom, { ...atom.tail, control: { ...control, transfer: nextTransfer } });
              const left = atom.region.kind === 'sequence' ? atom.region.regions : [atom.region];
              const right =
                target.region.kind === 'sequence' ? target.region.regions : [target.region];
              budget.charge(left.length + right.length);
              atom.region = { kind: 'sequence', regions: [...left, ...right] };
              atom.tail = target.tail;
            } else if (control.kind === 'if' || control.kind === 'switch') {
              const replacement: ControlArm = { transfer: nextTransfer, body: target.region };
              const updated: Control =
                control.kind === 'if'
                  ? {
                      ...control,
                      when_true: arm === control.when_true ? replacement : control.when_true,
                      when_false: arm === control.when_false ? replacement : control.when_false,
                    }
                  : {
                      ...control,
                      cases: control.cases.map((item) => {
                        budget.charge();
                        return item.arm === arm ? { ...item, arm: replacement } : item;
                      }),
                      otherwise: arm === control.otherwise ? replacement : control.otherwise,
                    };
              replaceTail(atom, { ...atom.tail, control: updated });
            }
            atom.depth = nextDepth;
            absorb(atom, target);
            changed = true;
            // Re-read the changed control on the next pass, rather than using stale arms.
            break;
          }
        }
      }
      const ordered: Region[] = [],
        first = owner.get(entry)!;
      ordered.push(first.region);
      for (const atom of atoms.values()) {
        budget.charge();
        if (atom !== first) ordered.push(atom.region);
      }
      return ordered.length === 1 ? ordered[0]! : { kind: 'sequence', regions: ordered };
    };
    const regionDepth = (region: Region): number => {
      budget.charge();
      if (region.kind === 'loop') return 1 + regionDepth(region.body);
      if (region.kind === 'sequence') {
        let depth = 0;
        for (const child of region.regions) depth = Math.max(depth, regionDepth(child));
        return depth + 1;
      }
      const control = region.control;
      const arms =
        control.kind === 'if'
          ? [control.when_true, control.when_false]
          : control.kind === 'switch'
            ? [...control.cases.map((item) => item.arm), control.otherwise]
            : [];
      let depth = 1;
      for (const arm of arms) {
        budget.charge();
        if (arm.body) depth = Math.max(depth, 1 + regionDepth(arm.body));
      }
      return depth;
    };
    const body = build(new Set(blocks.keys()), input.entry, [], 0);
    const coverage = input.blocks.map((block) => {
      budget.charge(1 + block.instructions.length);
      return {
        block_id: block.id,
        statement_ids: block.instructions.map((node) => node.id),
        terminator_id: block.terminator.id,
      };
    });
    const value: StructuredFunction = {
      kind: 'structured_function',
      id: input.id,
      provenance: input.provenance,
      entry: input.entry,
      returns: input.returns,
      body,
      coverage,
    };
    return { state: 'complete', value, diagnostics: [], work: budget.work };
  } catch (error) {
    const result = budget.result(null, error);
    return { state: 'partial', value: null, diagnostics: result.diagnostics, work: result.work };
  }
}
