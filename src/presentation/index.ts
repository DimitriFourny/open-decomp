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

/** A loop and its (extended) body; `follow` is its chosen lexical continuation. */
type LoopScope = { header: EntityId; members: ReadonlySet<EntityId> };

/** Mutable layout under construction; converted to immutable regions at the end. */
type Payload = Leaf | Seq | LoopPayload;
interface Leaf {
  readonly kind: 'leaf';
  readonly id: EntityId;
  /** The sequence holding this block, or the arm whose body it is; null at a node root. */
  parent: Seq | ArmRef | null;
}
interface Seq {
  readonly kind: 'seq';
  readonly items: Payload[];
  /** The arm whose body this sequence is; null at a node root. */
  parent: ArmRef | null;
}
interface LoopPayload {
  readonly kind: 'loop';
  readonly header: EntityId;
  readonly body: Payload;
  parent: Seq | ArmRef | null;
}
interface ArmRef {
  readonly kind: 'arm';
  readonly block: EntityId;
  readonly slot: number;
}
/** A labeled transfer (or a loop exit to a target other than the loop's
 * follow) into a node's entry. The target is placed only after its source. */
interface Pending {
  readonly block: EntityId;
  /** The node holding `block` when the transfer was recorded. */
  readonly source: CollapseNode;
}

/** A structured edge between collapse nodes. Every structured out-edge of a
 * node is in tail position: placed right after the node, its target is the
 * lexical destination of the transfer. */
interface CollapseEdge {
  readonly key: string;
  readonly block: EntityId;
  readonly slot: number;
  from: CollapseNode;
  to: CollapseNode;
  /** A bodiless if/switch arm of a block directly in this scope: may own its target. */
  readonly arm: boolean;
  /** A jump of a block directly in this scope. */
  readonly jump: boolean;
  /** The source block sits inside an arm body of its node. */
  nested: boolean;
  /** Region layer of the source block below the node root (root = 1). */
  level: number;
}
interface CollapseNode {
  readonly entry: EntityId;
  readonly rpo: number;
  outs: CollapseEdge[];
  ins: CollapseEdge[];
  root: Payload;
  /** The root is a sequence (sequences flatten into each other). */
  seq: boolean;
  /** Exact region depth of `root`. */
  depth: number;
  alive: boolean;
  /** The node that absorbed this one. */
  into: CollapseNode | null;
  /** Labeled transfers into the entry; shared with simulation copies. */
  readonly gotos: Pending[];
}
type Rule =
  | { readonly kind: 'sequence'; readonly target: CollapseNode }
  | { readonly kind: 'arm'; readonly edge: CollapseEdge }
  | { readonly kind: 'append'; readonly edge: CollapseEdge };

/** One collapse state: the real layout, or a disposable copy (`simulated`)
 * that only counts the collapses a labeled edge group would enable. */
interface Graph {
  readonly nodes: CollapseNode[];
  readonly entry: CollapseNode;
  /** Nesting depth of the scope's region. */
  readonly base: number;
  readonly simulated: boolean;
  /** The scope is a loop body entered at its header. */
  readonly loop: boolean;
  /** Simulation copies of the real graph's nodes. */
  readonly twins: ReadonlyMap<CollapseNode, CollapseNode> | null;
  /** Loop payloads of this scope by the blocks of their bodies. */
  readonly loops: ReadonlyMap<EntityId, LoopPayload>;
  alive: number;
  /** Nodes by the priority of their best rule (see classify). */
  readonly buckets: Set<CollapseNode>[];
  /** Nodes no structured edge enters, other than the entry. */
  readonly orphans: Set<CollapseNode>;
  /** Nodes without structured exits. */
  readonly sinks: Set<CollapseNode>;
}

/** Slot numbers: -1 is a jump; if arms are 0 (true) and 1 (false); switch
 * arms are case indices, `cases.length` being `otherwise`. */
const edgeKey = (block: EntityId, slot: number): string => `${block}:${slot}`;

/** Lexicographic `a < b` over equally long keys. */
const before = (a: readonly number[], b: readonly number[]): boolean => {
  for (let index = 0; index < a.length; index++)
    if (a[index] !== b[index]) return a[index]! < b[index]!;
  return false;
};

/**
 * Structures validated immutable region SSA without reconstructing source types.
 *
 * Loops: a cyclic strongly connected component becomes a loop headed by its
 * unique entry. A component with several entries (irreducible) is headed by
 * the entry first in reverse postorder; edges entering it elsewhere stay
 * labeled transfers into the loop body. Removing header backedges exposes
 * nested loops. A loop chooses one exit as its lexical follow (fewest labeled
 * exits; then not a small tail, then a single bottom test's exit, then the
 * header's, then a latch's exit), and its body is extended by acyclic blocks
 * entered only from the body, so their edges to the follow become breaks.
 *
 * Inside the function and every loop body, acyclic regions collapse
 * iteratively over the whole graph: a node whose structured successors are
 * one node entered only from it becomes a sequence; a successor entered by a
 * single arm becomes that arm's owned body (if-then, if-else, short-circuit
 * operand chains and switch cases; terminal successors first, then those
 * flowing into the other arms' targets); a single-entry successor of a nested
 * jump extends the arm body holding that jump. Nodes all of whose incoming
 * edges are labeled follow a node that does not fall through. When no rule
 * applies, the edge group whose removal enables the most collapses becomes a
 * labeled transfer, and collapsing continues.
 *
 * Every block label is addressable, including labels nested in arms. A sequence is
 * lexical order, NOT implicit fallthrough: its transfers still determine execution.
 * Loop bodies start at the header, repeat only on explicit continue, and leave only
 * on their actual transfers/terminal boundaries. Conditions are evaluated after
 * their block's statements, including on every iteration; nothing is hoisted.
 * Break/continue identify their loop AND exact destination/copies. A renderer must
 * retain labels when a transfer cannot be expressed by its structured syntax.
 * Switches are only those already established in IR.
 *
 * Statements retain identity, provenance, effect tokens and boundary snapshots;
 * function-exit register rows remain observable even for empty returns, and
 * every block records its immediate dominator for derived register state.
 * Coverage includes unreachable blocks. No untouched CFG is embedded in the
 * output. Work bounds cover graph traversal, copies, edge selection and region
 * construction; depth is capped at 64. Exhaustion or cancellation returns null
 * transactionally, never a truncated presentation.
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
    let edgeCount = 0;
    for (const block of input.blocks) {
      budget.charge(1 + block.parameters.length + block.instructions.length);
      blocks.set(block.id, block);
      predecessors.set(block.id, []);
    }
    for (const block of input.blocks) {
      budget.charge(block.terminator.kind === 'switch' ? block.terminator.cases.length + 1 : 1);
      const outgoing = successors(block.terminator);
      edges.set(block.id, outgoing);
      edgeCount += outgoing.length;
      for (const edge of outgoing) {
        budget.charge(1 + edge.arguments.length);
        predecessors.get(edge.target)!.push(block.id);
      }
    }
    // Sparse register rows derive full block state along immediate dominators.
    const dominance = computeDominance(input, (work) => budget.charge(work));
    // Reverse postorder from the entry orders choices deterministically;
    // unreachable blocks follow in input order.
    const rpo = new Map<EntityId, number>();
    {
      const order: EntityId[] = [],
        seen = new Set<EntityId>([input.entry]),
        stack = [{ id: input.entry, index: 0 }];
      while (stack.length) {
        budget.charge();
        const top = stack[stack.length - 1]!,
          next = edges.get(top.id)![top.index++];
        if (next === undefined) {
          order.push(top.id);
          stack.pop();
        } else if (!seen.has(next.target)) {
          seen.add(next.target);
          stack.push({ id: next.target, index: 0 });
        }
      }
      order.reverse().forEach((id, index) => rpo.set(id, index));
      for (const block of input.blocks)
        if (!rpo.has(block.id)) rpo.set(block.id, rpo.size + input.blocks.length);
    }
    const slotKind = (id: EntityId): 'jump' | 'arm' | null => {
      const kind = blocks.get(id)!.terminator.kind;
      return kind === 'jump' ? 'jump' : kind === 'branch' || kind === 'switch' ? 'arm' : null;
    };
    /** A short block chain ending the function within three jumps (at most four
     * stores/calls per block): an exit into it is a small tail that labeled
     * transfers and source-view copies resolve. Edge selection asks for the
     * same blocks repeatedly; the CFG never changes, so each answer is kept. */
    const tailAnswers = new Map<string, boolean>();
    const tailBlock = (id: EntityId, hops: number): boolean => {
      const key = `${hops}:${id}`,
        known = tailAnswers.get(key);
      budget.charge();
      if (known !== undefined) return known;
      budget.charge(blocks.get(id)!.instructions.length);
      const block = blocks.get(id)!,
        term = block.terminator;
      const effects = block.instructions.filter(
        (node) => node.kind === 'store' || node.kind === 'call' || node.kind === 'unknown_effect',
      ).length;
      const result =
        effects <= 4 &&
        (term.kind === 'return' ||
          term.kind === 'trap' ||
          term.kind === 'unknown' ||
          term.kind === 'indirect' ||
          (term.kind === 'jump' &&
            hops < 3 &&
            term.edge.target !== id &&
            tailBlock(term.edge.target, hops + 1)));
      tailAnswers.set(key, result);
      return result;
    };
    /** Outgoing slots of a block: slot number and target. */
    const slots = (id: EntityId): { slot: number; target: EntityId }[] => {
      const outgoing = edges.get(id)!;
      return slotKind(id) === 'jump'
        ? [{ slot: -1, target: outgoing[0]!.target }]
        : outgoing.map((edge, slot) => ({ slot, target: edge.target }));
    };

    // Layout decisions consumed when the regions are built.
    const armBodies = new Map<EntityId, Map<number, Payload>>();
    const leaves = new Map<EntityId, Leaf>();
    const chains = new Map<EntityId, readonly LoopScope[]>();
    /** Structured edges that stay labeled transfers. */
    const labeled = new Set<string>();
    // Edge selection is bounded separately; past it, the remaining nodes of a
    // scope are laid out in dependency order without further search.
    let selection = 64 * (blocks.size + edgeCount) + 20_000;

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

    const flatten = (payload: Payload): Payload[] =>
      payload.kind === 'seq' ? payload.items : [payload];
    const adopt = (items: readonly Payload[], parent: Seq | ArmRef): void => {
      for (const item of items) {
        budget.charge();
        if (item.kind !== 'seq') item.parent = parent;
      }
    };
    const detach = (edge: CollapseEdge): void => {
      budget.charge(edge.from.outs.length + edge.to.ins.length);
      edge.from.outs = edge.from.outs.filter((item) => item !== edge);
      edge.to.ins = edge.to.ins.filter((item) => item !== edge);
    };

    /** Lays out one scope (the function or a loop body) entered at `entry`. */
    const buildScope = (
      ids: ReadonlySet<EntityId>,
      entry: EntityId,
      scopes: readonly LoopScope[],
      base: number,
    ): { root: Payload; depth: number } => {
      const loopScope = scopes.length > 0;
      const loops = base + 2 < maxDepth;
      const groups = loops
        ? components(ids, scopes)
        : [...ids].map((id) => {
            budget.charge();
            return [id];
          });
      const groupOf = new Map<EntityId, number>();
      groups.forEach((group, index) => {
        for (const id of group) groupOf.set(id, index);
      });
      const suppressed = new Set(scopes.map((scope) => scope.header));
      const cyclic = (group: readonly EntityId[]): boolean =>
        group.length > 1 ||
        edges.get(group[0]!)!.some((edge) => {
          budget.charge();
          return edge.target === group[0] && !suppressed.has(edge.target);
        });
      type LoopGroup = { index: number; header: EntityId; members: Set<EntityId> };
      const loopGroups: LoopGroup[] = [];
      for (let index = 0; index < groups.length; index++) {
        const group = groups[index]!;
        if (!loops || !cyclic(group)) continue;
        const members = new Set(group);
        const entries: EntityId[] = [];
        for (const id of group) {
          budget.charge();
          if (
            id === input.entry ||
            predecessors.get(id)!.some((previous) => !members.has(previous))
          )
            entries.push(id);
        }
        // Unreachable cycles stay explicit labeled blocks.
        if (!entries.length) continue;
        entries.sort((a, b) => rpo.get(a)! - rpo.get(b)!);
        loopGroups.push({ index, header: entries[0]!, members });
      }
      loopGroups.sort((a, b) => rpo.get(a.header)! - rpo.get(b.header)!);
      const loopIndices = new Set(loopGroups.map((group) => group.index));
      const claimed = new Set<number>();
      // A loop's follow and its body extension: acyclic groups whose every
      // predecessor is already in the body (never the follow, the scope entry
      // or another loop) join it. `joins` counts absorbed blocks where exit
      // paths leaving the loop from different blocks meet: inside the body
      // they merge after the loop's own code, which a labeled transfer pays.
      const extend = (
        members: ReadonlySet<EntityId>,
        follow: EntityId | undefined,
      ): { body: Set<EntityId>; added: number[]; exits: Set<EntityId>; joins: number } => {
        const body = new Set(members),
          added: number[] = [],
          pending: EntityId[] = [];
        // The loop block every path into an absorbed block leaves from; null
        // where paths from several meet.
        const origin = new Map<EntityId, EntityId | null>();
        let joins = 0;
        const visit = (id: EntityId): void => {
          for (const edge of edges.get(id)!) {
            budget.charge();
            if (ids.has(edge.target) && !body.has(edge.target)) pending.push(edge.target);
          }
        };
        members.forEach(visit);
        const tried = new Set<EntityId>();
        while (pending.length) {
          const id = pending.pop()!;
          budget.charge();
          const index = groupOf.get(id)!;
          if (
            body.has(id) ||
            id === follow ||
            id === entry ||
            suppressed.has(id) ||
            loopIndices.has(index) ||
            claimed.has(index) ||
            groups[index]!.length !== 1 ||
            cyclic(groups[index]!) ||
            !predecessors.get(id)!.every((previous) => body.has(previous))
          ) {
            tried.add(id);
            continue;
          }
          body.add(id);
          added.push(index);
          let from: EntityId | null | undefined;
          for (const previous of predecessors.get(id)!) {
            budget.charge();
            const token = members.has(previous) ? previous : origin.get(previous)!;
            if (from === undefined) from = token;
            else if (from !== token) from = null;
          }
          // Small tails meeting cost nothing: labeled edges into them get copies.
          if (
            from === null &&
            predecessors.get(id)!.some((previous) => origin.get(previous) !== null) &&
            !tailBlock(id, 0)
          )
            joins++;
          origin.set(id, from ?? null);
          visit(id);
          // A block refused earlier may now have every predecessor inside.
          for (const edge of edges.get(id)!)
            if (tried.delete(edge.target)) pending.push(edge.target);
        }
        const exits = new Set<EntityId>();
        for (const id of body)
          for (const edge of edges.get(id)!) {
            budget.charge();
            if (ids.has(edge.target) && !body.has(edge.target) && edge.target !== entry)
              exits.add(edge.target);
          }
        return { body, added, exits, joins };
      };
      const loopBodies = new Map<number, { body: Set<EntityId>; follow: EntityId | undefined }>();
      for (const group of loopGroups) {
        if (claimed.has(group.index)) continue;
        const direct = new Map<EntityId, number>();
        const headerExits = new Set<EntityId>(),
          latchExits = new Set<EntityId>();
        let repeats = 0;
        for (const id of group.members) {
          const latch = edges.get(id)!.some((edge) => edge.target === group.header);
          for (const edge of edges.get(id)!) {
            budget.charge();
            if (edge.target === group.header) repeats++;
            if (!ids.has(edge.target) || group.members.has(edge.target) || edge.target === entry)
              continue;
            direct.set(edge.target, (direct.get(edge.target) ?? 0) + 1);
            if (id === group.header) headerExits.add(edge.target);
            if (latch) latchExits.add(edge.target);
          }
        }
        let best:
            { follow: EntityId | undefined; body: Set<EntityId>; added: number[] } | undefined,
          bestKey: number[] = [];
        for (const follow of direct.keys()) {
          const result = extend(group.members, follow);
          const others = [...result.exits].filter((id) => id !== follow);
          const tails = others.filter((id) => tailBlock(id, 0)).length;
          // Another exit flowing into a block the follow also flows into: only
          // one of the two can fall into it after the loop.
          const after = new Set<EntityId>();
          for (const edge of edges.get(follow)!) {
            budget.charge();
            if (ids.has(edge.target) && edge.target !== entry && !tailBlock(edge.target, 0))
              after.add(edge.target);
          }
          let rejoins = 0;
          for (const other of others)
            if (
              edges.get(other)!.some((edge) => {
                budget.charge();
                return after.has(edge.target);
              })
            )
              rejoins++;
          const tail = tailBlock(follow, 0);
          // A bottom test's exit continues the loop's code (a do-while) when
          // the loop alone enters it and it is code, not a small tail (exits
          // into small tails share one copy as breaks).
          const bottom =
            !tail &&
            repeats === 1 &&
            latchExits.has(follow) &&
            predecessors.get(follow)!.every((previous) => result.body.has(previous));
          // Fewest labeled exits (non-tail exits, meeting exit paths, rejoins);
          // then a follow that is not a small tail (a tail exit is resolved
          // by a copy, while the code after the loop would be absorbed);
          // then a bottom test's exit (do-while, code after the loop follows
          // it), fewer tails, the header's exit, a latch's exit.
          const key = [
            others.length - tails + result.joins + rejoins,
            tail ? 1 : 0,
            bottom ? 0 : 1,
            tails,
            headerExits.has(follow) ? 0 : 1,
            latchExits.has(follow) ? 0 : 1,
            -direct.get(follow)!,
            rpo.get(follow)!,
          ];
          if (!best || before(key, bestKey)) {
            best = { follow, body: result.body, added: result.added };
            bestKey = key;
          }
        }
        if (!best) best = { follow: undefined, ...extend(group.members, undefined) };
        for (const index of best.added) claimed.add(index);
        claimed.add(group.index);
        loopBodies.set(group.index, { body: best.body, follow: best.follow });
      }

      const inners = loopGroups.map((group) => {
        const loop = loopBodies.get(group.index)!;
        const inner = buildScope(
          loop.body,
          group.header,
          [...scopes, { header: group.header, members: loop.body }],
          base + 1,
        );
        return { group, loop, inner };
      });
      // Collapse nodes: loops, then the blocks directly in this scope.
      const owner = new Map<EntityId, CollapseNode>();
      const nodes: CollapseNode[] = [];
      const loopNodes: {
        node: CollapseNode;
        body: ReadonlySet<EntityId>;
        follow?: EntityId;
      }[] = [];
      for (const { group, loop, inner } of inners) {
        const node: CollapseNode = {
          entry: group.header,
          rpo: rpo.get(group.header)!,
          outs: [],
          ins: [],
          root: { kind: 'loop', header: group.header, body: inner.root, parent: null },
          seq: false,
          depth: inner.depth + 1,
          alive: true,
          into: null,
          gotos: [],
        };
        nodes.push(node);
        for (const id of loop.body) owner.set(id, node);
        loopNodes.push({
          node,
          body: loop.body,
          ...(loop.follow === undefined ? {} : { follow: loop.follow }),
        });
      }
      for (const id of ids) {
        budget.charge();
        if (owner.has(id)) continue;
        const leaf: Leaf = { kind: 'leaf', id, parent: null };
        leaves.set(id, leaf);
        armBodies.delete(id);
        chains.set(id, scopes);
        const node: CollapseNode = {
          entry: id,
          rpo: rpo.get(id)!,
          outs: [],
          ins: [],
          root: leaf,
          seq: false,
          depth: 1,
          alive: true,
          into: null,
          gotos: [],
        };
        nodes.push(node);
        owner.set(id, node);
      }
      const link = (
        from: CollapseNode,
        block: EntityId,
        slot: number,
        target: EntityId,
        kind: 'jump' | 'arm' | null,
      ): void => {
        budget.charge();
        const to = owner.get(target)!;
        const edge: CollapseEdge = {
          key: edgeKey(block, slot),
          block,
          slot,
          from,
          to,
          arm: kind === 'arm',
          jump: kind === 'jump',
          nested: false,
          level: 1,
        };
        from.outs.push(edge);
        to.ins.push(edge);
      };
      for (const node of nodes) {
        if (node.root.kind !== 'leaf') continue;
        const id = node.entry;
        for (const { slot, target } of slots(id)) {
          budget.charge();
          if (!ids.has(target) || (loopScope && target === entry)) continue;
          const to = owner.get(target)!;
          // Into a loop body past its header, or back into this block.
          if (to === node || to.entry !== target) labeled.add(edgeKey(id, slot));
          else link(node, id, slot, target, slotKind(id));
        }
      }
      // A loop's edges to its follow are its breaks: they land after the
      // loop. Its other exits are labeled transfers into this scope.
      const loopPayloads = new Map<EntityId, LoopPayload>();
      for (const loop of loopNodes) {
        const follow =
          loop.follow !== undefined && owner.get(loop.follow)!.entry === loop.follow
            ? loop.follow
            : undefined;
        for (const id of loop.body) {
          loopPayloads.set(id, loop.node.root as LoopPayload);
          for (const { slot, target } of slots(id)) {
            budget.charge();
            if (target === follow) link(loop.node, id, slot, target, null);
            else if (
              ids.has(target) &&
              !loop.body.has(target) &&
              !(loopScope && target === entry) &&
              owner.get(target)!.entry === target
            )
              owner.get(target)!.gotos.push({ block: id, source: loop.node });
          }
        }
      }
      const entryNode = owner.get(entry)!;
      collapse(nodes, entryNode, base, loopScope, loopPayloads);
      return { root: entryNode.root, depth: entryNode.depth };
    };

    const targetsOf = (node: CollapseNode): Set<CollapseNode> => {
      const result = new Set<CollapseNode>();
      for (const edge of node.outs) if (edge.to !== node) result.add(edge.to);
      budget.charge(1 + node.outs.length);
      return result;
    };
    /** The live node holding `node` in `graph` (simulations start from copies). */
    const resolve = (graph: Graph, node: CollapseNode): CollapseNode => {
      for (let pass = 0; pass < 2; pass++) {
        while (node.into) {
          budget.charge();
          node = node.into;
        }
        const twin = graph.twins?.get(node);
        if (!twin) break;
        node = twin;
      }
      return node;
    };
    /** Lexical position of a payload below its node root: sequence indices
     * (>= 0) and, below a block, 0 for its own code and -(slot + 1) for an
     * arm body; `owners` holds the block of each arm step. */
    const pathOf = (
      item: Payload,
    ): { root: Payload; steps: number[]; owners: (EntityId | undefined)[] } => {
      const steps: number[] = [],
        owners: (EntityId | undefined)[] = [];
      for (;;) {
        budget.charge();
        const parent: Seq | ArmRef | null = item.parent;
        if (parent === null) break;
        if (parent.kind === 'seq') {
          steps.push(parent.items.indexOf(item));
          owners.push(undefined);
          item = parent;
        } else {
          steps.push(-(parent.slot + 1));
          owners.push(parent.block);
          item = leaves.get(parent.block)!;
        }
      }
      return { root: item, steps: steps.reverse(), owners: owners.reverse() };
    };
    /** `a` is printed before `b`. Switch arms are unordered (cases group).
     * The printer puts the arm of an `if` that a goto leaves before the arm
     * holding its label (gotos between two arms only ever go one way: a
     * target is absorbed after all its sources). */
    const precedes = (
      a: readonly number[],
      b: readonly number[],
      owners: readonly (EntityId | undefined)[],
    ): boolean => {
      for (let index = 0; index < Math.min(a.length, b.length); index++) {
        const x = a[index]!,
          y = b[index]!;
        if (x === y) continue;
        if (x < 0 && y < 0) {
          const owner = owners[index];
          return owner !== undefined && blocks.get(owner)!.terminator.kind === 'branch';
        }
        return x >= 0 && y >= 0 ? x < y : x === 0;
      }
      return false;
    };
    /** Every labeled transfer into `target` comes from inside `host`, and
     * (in the real layout) before position `at` of `host`. */
    const forward = (
      graph: Graph,
      target: CollapseNode,
      host: CollapseNode,
      at?: () => number[],
    ): boolean => {
      let position: number[] | undefined;
      for (const pending of target.gotos) {
        if (resolve(graph, pending.source) !== host) return false;
        if (!at || graph.simulated) continue;
        const source = pathOf(graph.loops.get(pending.block) ?? leaves.get(pending.block)!);
        position ??= at();
        if (source.root !== host.root || !precedes([...source.steps, 0], position, source.owners))
          return false;
      }
      return true;
    };
    const classify = (
      graph: Graph,
      node: CollapseNode,
    ): { priority: number; rule: Rule } | undefined => {
      budget.charge(1 + node.outs.length);
      if (!node.alive) return undefined;
      const outs = node.outs;
      let best: { priority: number; rule: Rule } | undefined, exit: Rule | undefined;
      if (outs.length) {
        const target = outs[0]!.to;
        // A switch's last remaining case target stays its arm (a `default:`
        // or case body), not the statement after the switch.
        const lastCase =
          outs.length === 1 &&
          outs[0]!.arm &&
          blocks.get(outs[0]!.block)!.terminator.kind === 'switch';
        if (
          !lastCase &&
          target !== node &&
          target !== graph.entry &&
          outs.every((edge) => edge.to === target) &&
          target.ins.every((edge) => edge.from === node) &&
          forward(graph, target, node)
        ) {
          const rule: Rule = { kind: 'sequence', target };
          // In a loop body, a branch whose other arm repeats the loop owns a
          // terminal successor (an exit path) as its arm, so the repeat edge
          // stays the lexical end of the body (`if (c) { ...; break; }`).
          if (
            !graph.loop ||
            outs.length !== 1 ||
            !outs[0]!.arm ||
            target.outs.length ||
            !slots(outs[0]!.block).some((slot) => slot.target === graph.entry.entry)
          )
            return { priority: 0, rule };
          exit = rule;
        }
      }
      const targets = targetsOf(node);
      for (const edge of outs) {
        const target = edge.to;
        budget.charge(1 + target.ins.length);
        if (target === node || target === graph.entry || !(edge.arm || (edge.jump && edge.nested)))
          continue;
        const single = target.ins.length === 1;
        // A switch whose several case arms alone enter one target: the first owns it.
        const shared =
          !single &&
          edge.arm &&
          target.ins.every((item) => item.block === edge.block && item.slot >= edge.slot) &&
          blocks.get(edge.block)!.terminator.kind === 'switch';
        if (!single && !shared) continue;
        // A labeled transfer into the target must stay a forward jump.
        const at = (): number[] => {
          const leaf = leaves.get(edge.block)!,
            steps = pathOf(leaf).steps;
          if (edge.arm) return [...steps, -(edge.slot + 1)];
          return leaf.parent?.kind === 'seq'
            ? [...steps.slice(0, -1), steps.at(-1)! + 1]
            : [...steps, 1];
        };
        if (!forward(graph, target, node, at)) continue;
        // Simulations ignore nesting bounds; the real layout never exceeds them.
        if (!graph.simulated) {
          let depth: number;
          if (edge.arm) depth = Math.max(node.depth, edge.level + target.depth);
          else {
            const leaf = leaves.get(edge.block)!,
              parent = leaf.parent;
            if (parent === null) continue;
            if (parent.kind === 'seq') {
              if (parent.items[parent.items.length - 1] !== leaf) continue;
              depth = Math.max(node.depth, target.depth + edge.level - (target.seq ? 2 : 1));
            } else
              depth = Math.max(
                node.depth,
                edge.level + 1,
                target.depth + edge.level - (target.seq ? 1 : 0),
              );
          }
          if (graph.base + depth >= maxDepth) continue;
        }
        // 1: no structured exit (if-no-exit). 2: every other successor is the
        // target's sole exit J or a clause owned by this node leaving only for
        // J (proper if, if/else, switch cases). 3: short-circuit operand
        // sharing one exit with this node. 4 (last resort): any other owned
        // successor.
        const own = targetsOf(target),
          others = [...targets].filter((item) => item !== target);
        const join = own.size === 1 ? own.values().next().value! : undefined;
        let priority: number;
        if (!own.size) priority = 1;
        else if (
          join !== undefined &&
          others.every(
            (item) =>
              item === join ||
              (item.ins.length === 1 &&
                item.ins[0]!.from === node &&
                [...targetsOf(item)].every((next) => next === join)),
          )
        )
          priority = 2;
        else if (
          edge.arm &&
          others.length === 1 &&
          own.size === 2 &&
          own.has(others[0]!) &&
          !own.has(node)
        )
          priority = 3;
        else priority = 4;
        if (!best || priority < best.priority)
          best = { priority, rule: { kind: edge.arm ? 'arm' : 'append', edge } };
      }
      // Past the nesting bound the exit path follows the branch instead.
      if (exit && (!best || best.priority > 1)) return { priority: 0, rule: exit };
      return best;
    };
    const refresh = (graph: Graph, node: CollapseNode): void => {
      for (const bucket of graph.buckets) bucket.delete(node);
      graph.orphans.delete(node);
      graph.sinks.delete(node);
      if (!node.alive) return;
      if (node !== graph.entry && !node.ins.length) graph.orphans.add(node);
      if (!node.outs.length) graph.sinks.add(node);
      const found = classify(graph, node);
      if (found) graph.buckets[found.priority]!.add(node);
    };
    const touched = (graph: Graph, node: CollapseNode): void => {
      const dirty = new Set<CollapseNode>([node]);
      for (const edge of node.ins) dirty.add(edge.from);
      for (const edge of node.outs) {
        dirty.add(edge.to);
        for (const other of edge.to.ins) {
          budget.charge();
          dirty.add(other.from);
        }
      }
      for (const item of dirty) refresh(graph, item);
    };
    /** `node` absorbed `other`: take its out-edges; edges back into `node` become labels. */
    const absorb = (
      graph: Graph,
      node: CollapseNode,
      other: CollapseNode,
      shift: number,
      nested: boolean,
    ): void => {
      for (const edge of other.outs) {
        budget.charge();
        edge.from = node;
        edge.level += shift;
        if (nested) edge.nested = true;
        node.outs.push(edge);
      }
      other.outs = [];
      for (const edge of [...node.outs])
        if (edge.to === node) {
          if (!graph.simulated) labeled.add(edge.key);
          detach(edge);
        }
      other.alive = false;
      other.into = node;
      graph.alive--;
      refresh(graph, other);
    };
    const sequence = (graph: Graph, node: CollapseNode, other: CollapseNode): void => {
      for (const edge of [...node.outs]) detach(edge);
      if (!node.seq) node.depth += 1;
      if (!graph.simulated) {
        if (node.root.kind !== 'seq') {
          const root: Seq = { kind: 'seq', items: [node.root], parent: null };
          adopt(root.items, root);
          node.root = root;
        }
        const seq = node.root as Seq,
          items = flatten(other.root);
        seq.items.push(...items);
        adopt(items, seq);
      }
      const shift = other.seq ? 0 : 1;
      node.depth = Math.max(node.depth, other.depth + shift);
      node.seq = true;
      absorb(graph, node, other, shift, false);
      touched(graph, node);
    };
    const apply = (graph: Graph, node: CollapseNode, rule: Rule): void => {
      if (rule.kind === 'sequence') return sequence(graph, node, rule.target);
      const edge = rule.edge,
        target = edge.to;
      for (const item of [...target.ins]) detach(item);
      if (rule.kind === 'arm') {
        if (!graph.simulated) {
          let arms = armBodies.get(edge.block);
          if (!arms) armBodies.set(edge.block, (arms = new Map()));
          arms.set(edge.slot, target.root);
          target.root.parent = { kind: 'arm', block: edge.block, slot: edge.slot };
        }
        node.depth = Math.max(node.depth, edge.level + target.depth);
        absorb(graph, node, target, edge.level, true);
      } else {
        let shift = edge.level - (target.seq ? 2 : 1);
        if (!graph.simulated) {
          const leaf = leaves.get(edge.block)!,
            parent = leaf.parent!,
            items = flatten(target.root);
          if (parent.kind === 'seq') {
            parent.items.push(...items);
            adopt(items, parent);
          } else {
            const seq: Seq = { kind: 'seq', items: [leaf, ...items], parent };
            armBodies.get(parent.block)!.set(parent.slot, seq);
            adopt(seq.items, seq);
            shift = edge.level - (target.seq ? 1 : 0);
            node.depth = Math.max(node.depth, edge.level + 1);
          }
        }
        node.depth = Math.max(node.depth, target.depth + shift);
        absorb(graph, node, target, shift, true);
      }
      touched(graph, node);
    };
    /** The node and rule of the most preferred applicable collapse up to `limit`. */
    const pick = (graph: Graph, limit: number): { node: CollapseNode; rule: Rule } | undefined => {
      for (let moved = true; moved;) {
        moved = false;
        for (let priority = 0; priority <= limit; priority++)
          for (const node of graph.buckets[priority]!) {
            const found = classify(graph, node);
            graph.buckets[priority]!.delete(node);
            if (!found) continue;
            graph.buckets[found.priority]!.add(node);
            if (found.priority === priority) return { node, rule: found.rule };
            moved = true;
          }
      }
      return undefined;
    };
    const graphOf = (
      nodes: CollapseNode[],
      entry: CollapseNode,
      base: number,
      loop: boolean,
      twins: ReadonlyMap<CollapseNode, CollapseNode> | null,
      loops: ReadonlyMap<EntityId, LoopPayload>,
    ): Graph => {
      const graph: Graph = {
        nodes,
        entry,
        base,
        simulated: twins !== null,
        loop,
        twins,
        loops,
        alive: nodes.filter((node) => node.alive).length,
        buckets: [0, 1, 2, 3, 4].map(() => new Set<CollapseNode>()),
        orphans: new Set(),
        sinks: new Set(),
      };
      for (const node of nodes) refresh(graph, node);
      return graph;
    };
    /** Structural collapses (never the last-resort class) that labeling
     * `group` enables, counted by collapsing a copy until it is stuck again,
     * and whether its target then becomes an owned arm body: a label into a
     * nested position, rather than to a later statement. */
    const unblocked = (
      graph: Graph,
      group: readonly CollapseEdge[],
    ): { readonly count: number; readonly nested: boolean } => {
      const copies = new Map<CollapseNode, CollapseNode>();
      for (const node of graph.nodes)
        if (node.alive) copies.set(node, { ...node, outs: [], ins: [], gotos: [...node.gotos] });
      for (const [node, copy] of copies)
        for (const edge of node.outs) {
          budget.charge();
          if (group.includes(edge)) continue;
          const twin: CollapseEdge = { ...edge, from: copy, to: copies.get(edge.to)! };
          copy.outs.push(twin);
          twin.to.ins.push(twin);
        }
      const target = copies.get(group[0]!.to)!;
      for (const edge of group)
        target.gotos.push({ block: edge.block, source: copies.get(edge.from)! });
      const copy = graphOf(
        [...copies.values()],
        copies.get(graph.entry)!,
        graph.base,
        graph.loop,
        copies,
        graph.loops,
      );
      let count = 0,
        nested = false;
      for (let found = pick(copy, 3); found && count < 256; found = pick(copy, 3)) {
        if (found.rule.kind !== 'sequence' && found.rule.edge.to === target) nested = true;
        apply(copy, found.node, found.rule);
        count++;
      }
      selection -= copies.size + count;
      return { count, nested };
    };
    type Candidate = { readonly group: CollapseEdge[]; readonly key: readonly number[] };
    /** Edge groups (all edges between two nodes) ranked by a one-step
     * lookahead, best first; `tails` restricts targets to small function
     * tails. Undefined without candidates or past the selection allowance. */
    const rank = (graph: Graph, tails: boolean): Candidate[] | undefined => {
      const groups = new Map<string, CollapseEdge[]>();
      let cost = 0;
      for (const node of graph.nodes) {
        if (!node.alive) continue;
        for (const edge of node.outs) {
          cost++;
          if (tails && !tailBlock(edge.to.entry, 0)) continue;
          const key = `${node.entry}\u0000${edge.to.entry}`;
          const list = groups.get(key);
          if (list) list.push(edge);
          else groups.set(key, [edge]);
        }
      }
      budget.charge(cost + graph.nodes.length);
      selection -= cost + graph.nodes.length;
      if (!groups.size || selection < 0) return undefined;
      const ranked = [...groups.values()].map((group) => {
        const source = group[0]!.from,
          target = group[0]!.to,
          outs = source.outs,
          ins = target.ins;
        // One step: rules enabled at the source, its predecessors and the
        // target's remaining predecessors; orphaning the target is no collapse.
        source.outs = outs.filter((edge) => !group.includes(edge));
        target.ins = ins.filter((edge) => !group.includes(edge));
        const near = new Set<CollapseNode>([source]);
        for (const edge of source.ins) near.add(edge.from);
        for (const edge of target.ins) near.add(edge.from);
        const orphan = !target.ins.length;
        let enabled = 0;
        for (const node of near) if ((classify(graph, node)?.priority ?? 4) < 4) enabled++;
        source.outs = outs;
        target.ins = ins;
        selection -= near.size + 1;
        const sources = new Set(ins.map((edge) => edge.from)).size;
        return {
          group,
          key: [
            tailBlock(target.entry, 0) ? 0 : 1,
            // A node left without structured entry waits for a host holding
            // all its sources, so its other edges often become labels too.
            orphan ? 1 : 0,
            -enabled,
            group.length,
            -sources,
            -target.rpo,
            // The edge from a join's latest predecessor stays its fallthrough.
            source.rpo,
          ],
        };
      });
      ranked.sort((a, b) => (before(a.key, b.key) ? -1 : before(b.key, a.key) ? 1 : 0));
      return ranked;
    };
    const label = (graph: Graph, group: readonly CollapseEdge[]): void => {
      const source = group[0]!.from,
        target = group[0]!.to;
      for (const edge of group) {
        if (!graph.simulated) labeled.add(edge.key);
        target.gotos.push({ block: edge.block, source });
        detach(edge);
      }
      touched(graph, source);
      touched(graph, target);
    };
    /** Labels the edge group whose removal unblocks the most collapses (see
     * rank and unblocked): the best eight are simulated while the selection
     * allowance lasts. */
    const select = (graph: Graph, tails: boolean): boolean => {
      const ranked = rank(graph, tails);
      if (!ranked) return false;
      let best = ranked[0]!,
        bestKey: number[] | undefined;
      for (const candidate of ranked.slice(0, 8)) {
        if (selection < 0) break;
        const outcome = unblocked(graph, candidate.group);
        // Collapses enabled count before whether the target becomes nested:
        // with labeled targets kept after their sources, a nested target
        // no longer means a jump back into an arm.
        const key = [
          ...candidate.key.slice(0, 2),
          -outcome.count,
          outcome.nested ? 1 : 0,
          ...candidate.key.slice(2),
        ];
        if (!bestKey || before(key, bestKey)) {
          best = candidate;
          bestKey = key;
        }
      }
      label(graph, best.group);
      return true;
    };
    /** Past the selection allowance: dependency order (structured and labeled
     * transfers), each node after the last. */
    const linearize = (graph: Graph): void => {
      const rest = graph.nodes.filter((node) => node.alive);
      const indegree = new Map<CollapseNode, number>(rest.map((node) => [node, 0]));
      const later = new Map<CollapseNode, CollapseNode[]>(rest.map((node) => [node, []]));
      for (const node of rest) {
        for (const edge of node.outs) {
          budget.charge();
          if (edge.to !== node) later.get(node)!.push(edge.to);
        }
        for (const pending of node.gotos) {
          const source = resolve(graph, pending.source);
          if (source !== node && later.has(source)) later.get(source)!.push(node);
        }
      }
      for (const targets of later.values())
        for (const target of targets) indegree.set(target, indegree.get(target)! + 1);
      const order: CollapseNode[] = [],
        done = new Set<CollapseNode>();
      const byRpo = [...rest].sort((a, b) => a.rpo - b.rpo);
      const ready = [graph.entry];
      while (order.length < rest.length) {
        budget.charge();
        let next = ready.pop();
        if (next === undefined || done.has(next)) {
          if (next !== undefined) continue;
          next = byRpo.find((node) => !done.has(node))!;
        }
        done.add(next);
        order.push(next);
        const fresh: CollapseNode[] = [];
        for (const target of later.get(next)!) {
          const count = indegree.get(target)! - 1;
          indegree.set(target, count);
          if (count === 0 && !done.has(target)) fresh.push(target);
        }
        fresh.sort((a, b) => b.rpo - a.rpo);
        ready.push(...fresh);
      }
      for (const node of order.slice(1)) {
        // Remaining structured edges stay transfers; lexical position decides.
        for (const edge of [...node.ins]) detach(edge);
        for (const edge of [...graph.entry.outs]) detach(edge);
        sequence(graph, graph.entry, node);
      }
    };
    /** A node entered only by labeled edges follows a node that does not
     * fall through and holds all their sources: the closest one before it,
     * else the first after it. */
    const placeOrphan = (graph: Graph): boolean => {
      for (const orphan of [...graph.orphans].sort((a, b) => a.rpo - b.rpo)) {
        const order = (node: CollapseNode): number[] =>
          node.rpo < orphan.rpo ? [0, -node.rpo] : [1, node.rpo];
        let host: CollapseNode | undefined;
        for (const sink of graph.sinks) {
          budget.charge();
          if (
            sink !== orphan &&
            (!host || before(order(sink), order(host))) &&
            forward(graph, orphan, sink)
          )
            host = sink;
        }
        if (!host) continue;
        sequence(graph, host, orphan);
        return true;
      }
      return false;
    };
    const collapse = (
      nodes: CollapseNode[],
      entry: CollapseNode,
      base: number,
      loop: boolean,
      loops: ReadonlyMap<EntityId, LoopPayload>,
    ): void => {
      const graph = graphOf(nodes, entry, base, loop, null, loops);
      while (graph.alive > 1) {
        budget.charge();
        const found = pick(graph, 3);
        if (found) {
          apply(graph, found.node, found.rule);
          continue;
        }
        if (placeOrphan(graph) || select(graph, true) || select(graph, false)) continue;
        const late = pick(graph, 4);
        if (late) apply(graph, late.node, late.rule);
        else linearize(graph);
      }
    };

    const transfer = (
      edge: Edge,
      block: EntityId,
      slot: number,
      scopes: readonly LoopScope[],
    ): ParallelTransfer => {
      const target = blocks.get(edge.target)!;
      let mode: ParallelTransfer['mode'] = labeled.has(edgeKey(block, slot)) ? 'goto' : 'next',
        loop: EntityId | undefined;
      for (let i = scopes.length - 1; i >= 0; i--) {
        budget.charge();
        const scope = scopes[i]!;
        if (edge.target === scope.header) {
          mode = 'continue';
          loop = scope.header;
          break;
        }
        if (scope.members.has(edge.target)) break;
        mode = 'break';
        loop = scope.header;
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
    const region = (payload: Payload): Region => {
      budget.charge();
      if (payload.kind === 'seq')
        return payload.items.length === 1
          ? region(payload.items[0]!)
          : { kind: 'sequence', regions: payload.items.map(region) };
      if (payload.kind === 'loop')
        return { kind: 'loop', header: payload.header, body: region(payload.body) };
      return leaf(payload.id);
    };
    const leaf = (id: EntityId): BlockRegion => {
      budget.charge();
      const block = blocks.get(id)!,
        term = block.terminator,
        state = states.get(id)!,
        scopes = chains.get(id)!,
        bodies = armBodies.get(id);
      const origin = { id: term.id, provenance: term.provenance, effect: term.effect };
      const arm = (edge: Edge, slot: number): ControlArm => {
        const body = bodies?.get(slot);
        const value = transfer(edge, id, slot, scopes);
        return body
          ? { transfer: { ...value, mode: 'next' }, body: region(body) }
          : { transfer: value };
      };
      let control: Control;
      switch (term.kind) {
        case 'jump':
          control = { ...origin, kind: 'jump', transfer: transfer(term.edge, id, -1, scopes) };
          break;
        case 'branch':
          control = {
            ...origin,
            kind: 'if',
            condition: term.condition,
            when_true: arm(term.when_true, 0),
            when_false: arm(term.when_false, 1),
          };
          break;
        case 'switch':
          control = {
            ...origin,
            kind: 'switch',
            value: term.value,
            cases: term.cases.map((item, index) => ({
              bits: item.bits,
              arm: arm(item.edge, index),
            })),
            otherwise: arm(term.otherwise, term.cases.length),
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
    const body = region(buildScope(new Set(blocks.keys()), input.entry, [], 0).root);
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
