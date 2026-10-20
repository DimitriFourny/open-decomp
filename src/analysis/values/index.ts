import type { EntityId } from '../../core/index.js';
import {
  bitWidth,
  computeDominance,
  evaluateExpression,
  expressionOperands,
  mergeProvenanceSources,
  sameType,
  successors,
} from '../../ir/index.js';
import type {
  BasicBlock,
  Edge,
  Expression,
  Instruction,
  IntegerPredicate,
  Provenance,
  RegisterBinding,
  SSAForm,
  Terminator,
  Value,
} from '../../ir/index.js';
import {
  instructionOperands,
  instructionResults,
  mapExpression,
  terminatorOperands,
} from '../effects/index.js';
import { AnalysisBudget } from '../ssa/budget.js';
import { foldValueRule, type ValueRuleScope } from './rules.js';
import type { AnalysisOptions, AnalysisResult } from '../ssa/budget.js';

export type ValueFact =
  { readonly kind: 'constant'; readonly bits: bigint } | { readonly kind: 'varying' };
export interface ValueAnalysis {
  /** Missing facts are bottom. Partial results clear facts: unconverged constants are not proofs. */
  readonly facts: ReadonlyMap<EntityId, ValueFact>;
  readonly reachable_blocks: ReadonlySet<EntityId>;
  readonly executable_edges: ReadonlySet<Edge>;
}
const varying: ValueFact = Object.freeze({ kind: 'varying' });

/** Conditional propagation with a monotone finite-height lattice, including loop backedges. */
export function analyzeValues(
  input: SSAForm,
  options: AnalysisOptions = {},
): AnalysisResult<ValueAnalysis> {
  const budget = new AnalysisBudget(options);
  const analysis = {
    facts: new Map<EntityId, ValueFact>(),
    reachable_blocks: new Set<EntityId>(),
    executable_edges: new Set<Edge>(),
  };
  try {
    propagate(input, budget, analysis);
    return budget.result(analysis);
  } catch (error) {
    analysis.facts.clear();
    return budget.result(analysis, error);
  }
}

function propagate(
  input: SSAForm,
  budget: AnalysisBudget,
  analysis: {
    facts: Map<EntityId, ValueFact>;
    reachable_blocks: Set<EntityId>;
    executable_edges: Set<Edge>;
  },
): void {
  const { facts, reachable_blocks: reachable, executable_edges: edges } = analysis;
  const blocks = new Map(input.blocks.map((block) => [block.id, block]));
  const users = new Map<EntityId, Set<EntityId>>();
  const phiUsers = new Map<EntityId, { edge: Edge; index: number }[]>();
  const operands = new Map<EntityId, readonly Value[]>();
  const home = new Map<EntityId, EntityId>();
  const connect = (index: Map<EntityId, Set<EntityId>>, value: Value, block: EntityId): void => {
    budget.charge();
    const row = index.get(value.id) ?? new Set<EntityId>();
    row.add(block);
    index.set(value.id, row);
  };
  for (const block of input.blocks) {
    budget.charge();
    for (const node of block.instructions) {
      budget.charge();
      for (const result of instructionResults(node)) home.set(result.id, block.id);
      if (node.kind !== 'assign') continue;
      const values = expressionOperands(node.expression);
      operands.set(node.id, values);
      for (const value of values) connect(users, value, block.id);
    }
    if (block.terminator.kind === 'branch') connect(users, block.terminator.condition, block.id);
    else if (block.terminator.kind === 'switch') connect(users, block.terminator.value, block.id);
  }
  const queue: BasicBlock[] = [],
    queued = new Set<EntityId>();
  const enqueue = (id: EntityId): void => {
    if (queued.has(id)) return;
    queued.add(id);
    queue.push(blocks.get(id)!);
  };
  let active: EntityId | null = null;
  const notifications: EntityId[] = [];
  const change = (value: Value, fact: ValueFact | undefined): boolean => {
    if (!fact) return false;
    const previous = facts.get(value.id);
    if (
      previous?.kind === 'varying' ||
      (previous?.kind === 'constant' && fact.kind === 'constant' && previous.bits === fact.bits)
    )
      return false;
    facts.set(value.id, previous ? varying : fact);
    notifications.push(value.id);
    return true;
  };
  const flush = (): void => {
    for (let cursor = 0; cursor < notifications.length; cursor++) {
      budget.charge();
      const id = notifications[cursor]!;
      for (const block of users.get(id) ?? []) {
        budget.charge();
        // Uses of the active block's own definitions follow them in order.
        // Dominating definitions changed by loop delivery reschedule users,
        // and phi delivery below also schedules the active block itself.
        if (block !== active || home.get(id) !== active) enqueue(block);
      }
      for (const { edge, index } of phiUsers.get(id) ?? []) {
        budget.charge();
        if (change(blocks.get(edge.target)!.parameters[index]!, facts.get(id)))
          enqueue(edge.target);
      }
    }
    notifications.length = 0;
  };
  const update = (value: Value, fact: ValueFact | undefined): void => {
    change(value, fact);
    flush();
  };
  reachable.add(input.entry);
  for (const parameter of blocks.get(input.entry)!.parameters) facts.set(parameter.id, varying);
  enqueue(input.entry);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    budget.charge();
    const block = queue[cursor]!;
    queued.delete(block.id);
    if (!reachable.has(block.id)) continue;
    active = block.id;
    // Each executable incoming edge contributes monotonically on activation
    // and whenever its source fact changes. No full phi-vector rescan is needed.
    for (const node of block.instructions) {
      budget.charge();
      if (node.kind !== 'assign') {
        for (const result of instructionResults(node)) update(result, varying);
        continue;
      }
      const expression = node.expression;
      if (expression.kind === 'select') {
        const condition = facts.get(expression.condition.id);
        if (condition?.kind === 'constant') {
          update(
            node.result,
            facts.get((condition.bits === 0n ? expression.when_false : expression.when_true).id),
          );
          continue;
        }
      }
      const inputs = operands.get(node.id)!.map((value) => facts.get(value.id));
      if (inputs.some((fact) => fact?.kind === 'varying') || expression.kind === 'indeterminate') {
        update(node.result, varying);
        continue;
      }
      if (inputs.some((fact) => !fact)) continue;
      const result = evaluateExpression(node.result.type, expression, (value) => {
        const fact = facts.get(value.id)!;
        return fact.kind === 'constant'
          ? { kind: 'bits', bits: fact.bits }
          : { kind: 'unknown', reason: 'Nonconstant analysis operand' };
      });
      update(
        node.result,
        result.kind === 'bits' ? { kind: 'constant', bits: result.bits } : varying,
      );
    }
    const terminator = block.terminator;
    let selected: readonly Edge[];
    if (terminator.kind === 'branch') {
      const condition = facts.get(terminator.condition.id);
      selected =
        condition?.kind === 'constant'
          ? [condition.bits === 0n ? terminator.when_false : terminator.when_true]
          : condition
            ? successors(terminator)
            : [];
    } else if (terminator.kind === 'switch') {
      const selector = facts.get(terminator.value.id);
      selected =
        selector?.kind === 'constant'
          ? [
              terminator.cases.find((item) => item.bits === selector.bits)?.edge ??
                terminator.otherwise,
            ]
          : selector
            ? successors(terminator)
            : [];
    } else selected = successors(terminator);
    for (const edge of selected) {
      budget.charge();
      if (edges.has(edge)) continue;
      edges.add(edge);
      const newlyReachable = !reachable.has(edge.target);
      reachable.add(edge.target);
      let changed = false;
      edge.arguments.forEach((argument, index) => {
        budget.charge();
        // Subscription and initial contribution share this executable-edge
        // visit. Sources changed before activation contribute their latest fact;
        // later changes notify only consumers that can actually execute.
        const row = phiUsers.get(argument.id) ?? [];
        row.push({ edge, index });
        phiUsers.set(argument.id, row);
        changed =
          change(blocks.get(edge.target)!.parameters[index]!, facts.get(argument.id)) || changed;
      });
      flush();
      if (changed || newlyReachable) enqueue(edge.target);
    }
  }
}

type Assignment = Extract<Instruction, { kind: 'assign' }>;

const complements: Record<IntegerPredicate, IntegerPredicate> = {
  eq: 'ne',
  ne: 'eq',
  ult: 'uge',
  ule: 'ugt',
  ugt: 'ule',
  uge: 'ult',
  slt: 'sge',
  sle: 'sgt',
  sgt: 'sle',
  sge: 'slt',
};
const relations: Record<IntegerPredicate, { mask: number; signed: boolean | null }> = {
  eq: { mask: 2, signed: null },
  ne: { mask: 5, signed: null },
  ult: { mask: 1, signed: false },
  ule: { mask: 3, signed: false },
  ugt: { mask: 4, signed: false },
  uge: { mask: 6, signed: false },
  slt: { mask: 1, signed: true },
  sle: { mask: 3, signed: true },
  sgt: { mask: 4, signed: true },
  sge: { mask: 6, signed: true },
};

/** Recover subtraction-based comparisons from typed flags, never architecture spellings. */
export function recoverComparison(
  expression: Expression,
  definitions: ReadonlyMap<EntityId, Assignment>,
  facts: ReadonlyMap<EntityId, ValueFact>,
): Expression {
  const resolve = (value: Value): Expression | undefined => {
    let node = definitions.get(value.id);
    const seen = new Set<EntityId>();
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      if (
        node.expression.kind === 'cast' &&
        node.expression.op === 'bitcast' &&
        bitWidth(node.expression.value.type) === bitWidth(node.result.type)
      )
        node = definitions.get(node.expression.value.id);
      else return node.expression;
    }
    return undefined;
  };
  const zeroCarry = (flag: Extract<Expression, { kind: 'flag' }>): boolean => {
    const carry = facts.get(flag.carry.id);
    const definition = resolve(flag.carry);
    return (
      (carry?.kind === 'constant' && carry.bits === 0n) ||
      (definition?.kind === 'constant' && definition.bits === 0n)
    );
  };
  if (expression.kind === 'flag' && expression.op === 'sub' && zeroCarry(expression)) {
    const predicates: Partial<Record<typeof expression.flag, IntegerPredicate>> = {
      zero: 'eq',
      carry: 'uge',
      borrow: 'ult',
    };
    const op = predicates[expression.flag];
    if (op) return { kind: 'compare', op, left: expression.left, right: expression.right };
  }
  if (
    expression.kind === 'integer' &&
    expression.op === 'xor' &&
    bitWidth(expression.left.type) === 1
  ) {
    const left = resolve(expression.left),
      right = resolve(expression.right);
    if (
      left?.kind === 'flag' &&
      right?.kind === 'flag' &&
      left.op === 'sub' &&
      right.op === 'sub' &&
      left.left.id === right.left.id &&
      left.right.id === right.right.id &&
      left.carry.id === right.carry.id &&
      ((left.flag === 'negative' && right.flag === 'overflow') ||
        (right.flag === 'negative' && left.flag === 'overflow')) &&
      zeroCarry(left)
    ) {
      return { kind: 'compare', op: 'slt', left: left.left, right: left.right };
    }
  }
  if (expression.kind === 'integer' && bitWidth(expression.left.type) === 1) {
    const left = resolve(expression.left),
      right = resolve(expression.right);
    if (expression.op === 'xor') {
      if (left?.kind === 'compare' && right?.kind === 'constant' && right.bits === 1n)
        return { ...left, op: complements[left.op] };
      if (right?.kind === 'compare' && left?.kind === 'constant' && left.bits === 1n)
        return { ...right, op: complements[right.op] };
    }
    if (
      (expression.op === 'or' || expression.op === 'and') &&
      left?.kind === 'compare' &&
      right?.kind === 'compare' &&
      left.left.id === right.left.id &&
      left.right.id === right.right.id
    ) {
      const a = relations[left.op],
        b = relations[right.op];
      if (a.signed === null || b.signed === null || a.signed === b.signed) {
        const mask = expression.op === 'or' ? a.mask | b.mask : a.mask & b.mask;
        const signed = a.signed ?? b.signed;
        for (const op of Object.keys(relations) as IntegerPredicate[]) {
          const relation = relations[op];
          if (relation.mask === mask && (relation.signed === null || relation.signed === signed))
            return { kind: 'compare', op, left: left.left, right: left.right };
        }
      }
    }
  }
  if (
    expression.kind === 'integer_unary' &&
    expression.op === 'not' &&
    bitWidth(expression.value.type) === 1
  ) {
    const value = resolve(expression.value);
    if (value?.kind === 'compare') return { ...value, op: complements[value.op] };
  }
  if (
    expression.kind === 'compare' &&
    (expression.op === 'eq' || expression.op === 'ne') &&
    bitWidth(expression.left.type) === 1
  ) {
    const left = resolve(expression.left),
      right = resolve(expression.right);
    const comparison =
      left?.kind === 'compare' ? left : right?.kind === 'compare' ? right : undefined;
    const constant =
      left?.kind === 'constant' ? left : right?.kind === 'constant' ? right : undefined;
    if (comparison && constant) {
      const invert = (expression.op === 'eq') === (constant.bits === 0n);
      return invert ? { ...comparison, op: complements[comparison.op] } : comparison;
    }
  }
  return expression;
}

/**
 * Conservative optimizer. Folding uses the trusted bit-vector/FP primitives;
 * unknown/undefined values are never treated as algebraic numbers. Loads, stores,
 * calls and unknown effects are retained even with dead results. No alias guess
 * or signature inference occurs. Block parameters whose incoming values are all
 * one dominating value (or the parameter itself) are replaced by that value;
 * their architectural entry bindings remain. On interruption the last complete
 * graph is returned.
 */
export function simplifySSA(
  input: SSAForm,
  options: AnalysisOptions = {},
): AnalysisResult<SSAForm> {
  const budget = new AnalysisBudget(options);
  let current = input;
  try {
    let changed = true,
      first = true;
    while (changed) {
      budget.charge();
      const analysis = {
        facts: new Map<EntityId, ValueFact>(),
        reachable_blocks: new Set<EntityId>(),
        executable_edges: new Set<Edge>(),
      };
      propagate(current, budget, analysis);
      const rewritten = rewrite(current, analysis, budget);
      const copies = propagateCopies(rewritten.value, budget);
      // Parameters become trivial only when edges or values change.
      const trivial =
        first || rewritten.changed || copies.changed
          ? eliminateTrivialParameters(copies.value, budget)
          : { value: copies.value, changed: false };
      first = false;
      changed = rewritten.changed || copies.changed || trivial.changed;
      current = trivial.value;
    }
    return budget.result(current);
  } catch (error) {
    return budget.result(current, error);
  }
}

function rewrite(
  input: SSAForm,
  analysis: ValueAnalysis,
  budget: AnalysisBudget,
): { value: SSAForm; changed: boolean } {
  let changed = false;
  const definitions = new Map<EntityId, Assignment>();
  for (const block of input.blocks)
    for (const node of block.instructions)
      if (node.kind === 'assign') definitions.set(node.result.id, node);
  const states = new Map(input.register_states.map((state) => [state.block, state]));
  // Block parameter -> incoming edge values, for the value rules' determinacy scan.
  const parameters = new Map<EntityId, Value[]>();
  const byBlock = new Map(input.blocks.map((block) => [block.id, block]));
  for (const block of input.blocks)
    for (const edge of successors(block.terminator)) {
      budget.charge();
      const target = byBlock.get(edge.target);
      target?.parameters.forEach((parameter, index) => {
        const argument = edge.arguments[index];
        if (!argument) return;
        const list = parameters.get(parameter.id) ?? [];
        list.push(argument);
        parameters.set(parameter.id, list);
      });
    }
  const scope: ValueRuleScope = {
    definition: (id) => definitions.get(id)?.expression,
    constant: (id) => {
      const fact = analysis.facts.get(id);
      return fact?.kind === 'constant' ? fact.bits : undefined;
    },
    incoming: (id) => parameters.get(id) ?? [],
    charge: (work) => budget.charge(work),
  };
  const rewritten: { block: BasicBlock; nodes: Instruction[]; terminator: Terminator }[] = [];
  for (const block of input.blocks) {
    budget.charge();
    if (!analysis.reachable_blocks.has(block.id)) {
      changed = true;
      continue;
    }
    const nodes: Instruction[] = [];
    for (const node of block.instructions) {
      budget.charge();
      if (node.kind !== 'assign') {
        nodes.push(node);
        continue;
      }
      let expression = recoverComparison(node.expression, definitions, analysis.facts);
      const fact = analysis.facts.get(node.result.id);
      if (
        fact?.kind === 'constant' &&
        expression.kind !== 'constant' &&
        expression.kind !== 'address'
      )
        expression = { kind: 'constant', bits: fact.bits };
      else if (expression.kind === 'select') {
        const condition = analysis.facts.get(expression.condition.id);
        if (condition?.kind === 'constant')
          expression = {
            kind: 'cast',
            op: 'bitcast',
            value: condition.bits === 0n ? expression.when_false : expression.when_true,
          };
      } else if (expression.kind === 'integer') {
        const right = analysis.facts.get(expression.right.id);
        // These identities preserve unknown/undefined state; x-x and x*0 deliberately do not.
        if (
          right?.kind === 'constant' &&
          ((right.bits === 0n &&
            ['add', 'sub', 'or', 'xor', 'shl', 'lshr', 'ashr', 'rol', 'ror'].includes(
              expression.op,
            )) ||
            (right.bits === 1n &&
              (['mul', 'udiv'].includes(expression.op) ||
                (expression.op === 'sdiv' && bitWidth(node.result.type) > 1))) ||
            (right.bits === (1n << BigInt(bitWidth(node.result.type))) - 1n &&
              expression.op === 'and'))
        ) {
          expression = { kind: 'cast', op: 'bitcast', value: expression.left };
        }
      }
      expression = foldValueRule(node.result.type, expression, scope) ?? expression;
      if (expression !== node.expression) {
        changed = true;
        const origins = expressionOperands(node.expression).flatMap((value) => {
          const definition = definitions.get(value.id);
          return definition ? [definition.provenance] : [];
        });
        const replacement: Assignment = {
          ...node,
          expression,
          provenance: mergeProvenanceSources([node.provenance, ...origins], (work) =>
            budget.charge(work),
          ),
        };
        nodes.push(replacement);
        definitions.set(node.result.id, replacement);
      } else nodes.push(node);
    }
    let terminator = block.terminator;
    if (terminator.kind === 'branch') {
      const condition = analysis.facts.get(terminator.condition.id);
      if (condition?.kind === 'constant') {
        const definition = definitions.get(terminator.condition.id);
        terminator = {
          kind: 'jump',
          id: terminator.id,
          provenance: mergeProvenanceSources(
            [terminator.provenance, ...(definition ? [definition.provenance] : [])],
            (work) => budget.charge(work),
          ),
          effect: terminator.effect,
          edge: condition.bits === 0n ? terminator.when_false : terminator.when_true,
        };
        changed = true;
      }
    } else if (terminator.kind === 'switch') {
      const selector = analysis.facts.get(terminator.value.id);
      if (selector?.kind === 'constant') {
        const definition = definitions.get(terminator.value.id);
        terminator = {
          kind: 'jump',
          id: terminator.id,
          provenance: mergeProvenanceSources(
            [terminator.provenance, ...(definition ? [definition.provenance] : [])],
            (work) => budget.charge(work),
          ),
          effect: terminator.effect,
          edge:
            terminator.cases.find((item) => item.bits === selector.bits)?.edge ??
            terminator.otherwise,
        };
        changed = true;
      }
    }
    rewritten.push({ block, nodes, terminator });
  }
  // Global liveness: effects, control, edges and architectural rows are roots;
  // values may be used in any block their definition dominates.
  const live = new Set<EntityId>();
  const pending: Value[] = [];
  const use = (value: Value): void => {
    if (live.has(value.id)) return;
    live.add(value.id);
    pending.push(value);
  };
  for (const { block, nodes, terminator } of rewritten) {
    budget.charge(1 + nodes.length);
    for (const node of nodes) if (node.kind !== 'assign') instructionOperands(node).forEach(use);
    terminatorOperands(terminator).forEach(use);
    const state = states.get(block.id);
    for (const binding of state?.entry ?? []) use(binding.value);
    for (const binding of state?.exit ?? []) use(binding.value);
  }
  while (pending.length) {
    const definition = definitions.get(pending.pop()!.id);
    if (!definition) continue;
    budget.charge();
    expressionOperands(definition.expression).forEach(use);
  }
  // A block parameter used anywhere except its own block's terminator keeps
  // that block on every path; edge threading must not bypass it.
  const owners = new Map<EntityId, EntityId>();
  for (const { block } of rewritten)
    for (const parameter of block.parameters) owners.set(parameter.id, block.id);
  const pinned = new Set<EntityId>();
  const pin = (value: Value, terminatorOf?: EntityId): void => {
    const owner = owners.get(value.id);
    if (owner !== undefined && owner !== terminatorOf) pinned.add(owner);
  };
  const blocks: BasicBlock[] = [];
  for (const { block, nodes, terminator } of rewritten) {
    const kept: Instruction[] = [];
    const removed: Provenance[] = [];
    for (let i = nodes.length - 1; i >= 0; i--) {
      budget.charge();
      const node = nodes[i]!;
      if (node.kind === 'assign' && !live.has(node.result.id)) {
        changed = true;
        removed.push(node.provenance);
        continue;
      }
      kept.push(node);
      for (const value of instructionOperands(node)) pin(value);
    }
    kept.reverse();
    for (const value of terminatorOperands(terminator)) pin(value, block.id);
    const state = states.get(block.id);
    for (const binding of [...(state?.entry ?? []), ...(state?.exit ?? [])]) pin(binding.value);
    // One ordered union per block (same order as successive pairwise merges).
    const provenance =
      removed.length === 0
        ? block.provenance
        : mergeProvenanceSources([block.provenance, ...removed], (work) => budget.charge(work));
    blocks.push({ ...block, provenance, instructions: kept, terminator });
  }
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const threaded = blocks.map((block) => {
    let provenance = block.terminator.provenance;
    const thread = (initial: Edge, known?: { value: Value; truth: boolean }): Edge => {
      let edge = initial;
      const visited = new Set<EntityId>([block.id]);
      while (!visited.has(edge.target)) {
        budget.charge();
        visited.add(edge.target);
        const target = byId.get(edge.target);
        const row = states.get(edge.target);
        // Only an empty pass-through block whose parameters feed nothing but
        // its own terminator, and which records no architectural state, is
        // bypassed; dominated users and derived state stay unchanged.
        if (
          !target ||
          target.instructions.length !== 0 ||
          target.id === input.entry ||
          pinned.has(target.id) ||
          row?.entry.length ||
          row?.exit.length
        )
          break;
        const substitution = new Map(
          target.parameters.map((parameter, index) => [parameter.id, edge.arguments[index]!]),
        );
        const term = target.terminator;
        let next: Edge;
        if (term.kind === 'jump') next = term.edge;
        else if (term.kind === 'branch') {
          const condition = substitution.get(term.condition.id) ?? term.condition;
          const fact = analysis.facts.get(condition.id);
          if (fact?.kind === 'constant') next = fact.bits === 0n ? term.when_false : term.when_true;
          else if (known && condition.id === known.value.id)
            next = known.truth ? term.when_true : term.when_false;
          else break;
        } else break;
        // Never rotate an effect-free cycle's parameter permutation on successive passes.
        if (visited.has(next.target)) return initial;
        edge = {
          target: next.target,
          arguments: next.arguments.map((value) => substitution.get(value.id) ?? value),
          effect: initial.effect,
        };
        provenance = mergeProvenanceSources(
          [provenance, target.provenance, term.provenance],
          (work) => budget.charge(work),
        );
      }
      if (
        edge.target !== initial.target ||
        edge.arguments.some((value, index) => value.id !== initial.arguments[index]?.id)
      ) {
        changed = true;
        return edge;
      }
      return initial;
    };
    let terminator: Terminator = block.terminator;
    switch (terminator.kind) {
      case 'jump':
        terminator = { ...terminator, edge: thread(terminator.edge) };
        break;
      case 'branch':
        terminator = {
          ...terminator,
          when_true: thread(terminator.when_true, { value: terminator.condition, truth: true }),
          when_false: thread(terminator.when_false, { value: terminator.condition, truth: false }),
        };
        break;
      case 'switch':
        terminator = {
          ...terminator,
          cases: terminator.cases.map((item) => ({ ...item, edge: thread(item.edge) })),
          otherwise: thread(terminator.otherwise),
        };
        break;
    }
    return { ...block, terminator: { ...terminator, provenance } };
  });
  return {
    value: {
      ...input,
      blocks: threaded,
      register_states: input.register_states.filter((state) => byId.has(state.block)),
    },
    changed,
  };
}

/** Rewrites every data reference; definitions, effects and identities are unchanged. */
function mapInstruction(node: Instruction, map: (value: Value) => Value): Instruction {
  const bindings = (rows: readonly RegisterBinding[]): RegisterBinding[] =>
    rows.map((binding) => ({ ...binding, value: map(binding.value) }));
  switch (node.kind) {
    case 'assign':
      return { ...node, expression: mapExpression(node.expression, map) };
    case 'load':
      return {
        ...node,
        address: map(node.address),
        register_inputs: bindings(node.register_inputs),
      };
    case 'store':
      return {
        ...node,
        address: map(node.address),
        value: map(node.value),
        register_inputs: bindings(node.register_inputs),
      };
    case 'write_register':
      return { ...node, value: map(node.value) };
    case 'call':
      return {
        ...node,
        target:
          node.target.kind === 'indirect'
            ? { ...node.target, value: map(node.target.value) }
            : node.target,
        arguments: node.arguments.map(map),
        register_inputs: bindings(node.register_inputs),
      };
    case 'unknown_effect':
      return { ...node, register_inputs: bindings(node.register_inputs) };
    default:
      return node;
  }
}

function mapTerminator(
  terminator: Terminator,
  map: (value: Value) => Value,
  edge: (edge: Edge) => Edge,
): Terminator {
  switch (terminator.kind) {
    case 'return':
      return { ...terminator, values: terminator.values.map(map) };
    case 'indirect':
      return { ...terminator, target: map(terminator.target) };
    case 'jump':
      return { ...terminator, edge: edge(terminator.edge) };
    case 'branch':
      return {
        ...terminator,
        condition: map(terminator.condition),
        when_true: edge(terminator.when_true),
        when_false: edge(terminator.when_false),
      };
    case 'switch':
      return {
        ...terminator,
        value: map(terminator.value),
        cases: terminator.cases.map((item) => ({ ...item, edge: edge(item.edge) })),
        otherwise: edge(terminator.otherwise),
      };
    default:
      return terminator;
  }
}

function mapStates(
  states: SSAForm['register_states'],
  map: (value: Value) => Value,
  budget: AnalysisBudget,
): SSAForm['register_states'] {
  return states.map((state) => {
    budget.charge();
    return {
      ...state,
      entry: state.entry.map((binding) => ({ ...binding, value: map(binding.value) })),
      exit: state.exit.map((binding) => ({ ...binding, value: map(binding.value) })),
    };
  });
}

/**
 * Same-type bitcasts alias their operand everywhere it is referenced. A removed
 * copy's origin (e.g. the register write it records) joins its own block and
 * same-block consumers; dominated blocks reference the value, not the write.
 */
function propagateCopies(
  input: SSAForm,
  budget: AnalysisBudget,
): { value: SSAForm; changed: boolean } {
  const copies = new Map<EntityId, { node: Assignment; source: Value; block: EntityId }>();
  for (const block of input.blocks)
    for (const node of block.instructions) {
      budget.charge();
      if (
        node.kind === 'assign' &&
        node.expression.kind === 'cast' &&
        node.expression.op === 'bitcast' &&
        sameType(node.result.type, node.expression.value.type)
      )
        copies.set(node.result.id, { node, source: node.expression.value, block: block.id });
    }
  if (copies.size === 0) return { value: input, changed: false };
  // Final value and the origin of the copy chain prefix within the copy's block.
  const resolved = new Map<EntityId, { value: Value; origin: Provenance }>();
  const resolve = (value: Value): { value: Value; origin: Provenance } | undefined => {
    const chain: { node: Assignment; source: Value; block: EntityId }[] = [];
    let id = value.id;
    for (let copy = copies.get(id); copy && !resolved.has(id); copy = copies.get(id)) {
      budget.charge();
      chain.push(copy);
      id = copy.source.id;
    }
    let tail = resolved.get(id),
      tailBlock = copies.get(id)?.block;
    for (let i = chain.length - 1; i >= 0; i--) {
      const { node, source, block } = chain[i]!;
      tail = {
        value: tail?.value ?? source,
        origin:
          tail && tailBlock === block
            ? mergeProvenanceSources([node.provenance, tail.origin], (work) => budget.charge(work))
            : node.provenance,
      };
      tailBlock = block;
      resolved.set(node.result.id, tail);
    }
    return tail;
  };
  const map = (value: Value): Value => resolve(value)?.value ?? value;
  const rewrite = (
    values: readonly Value[],
    block: EntityId,
  ): { aliased: boolean; sources: Provenance[] } => {
    let aliased = false;
    const sources: Provenance[] = [];
    for (const value of values) {
      const copy = copies.get(value.id);
      if (!copy) continue;
      aliased = true;
      const origin = resolve(value)!.origin;
      if (copy.block === block) sources.push(origin);
    }
    return { aliased, sources };
  };
  const blocks = input.blocks.map((block) => {
    const nodes: Instruction[] = [];
    const removed: Provenance[] = [];
    for (const node of block.instructions) {
      budget.charge();
      if (node.kind === 'assign' && copies.has(node.result.id)) {
        removed.push(resolve(node.result)!.origin);
        continue;
      }
      const { aliased, sources } = rewrite(instructionOperands(node), block.id);
      nodes.push(
        !aliased
          ? node
          : {
              ...mapInstruction(node, map),
              provenance:
                sources.length === 0
                  ? node.provenance
                  : mergeProvenanceSources([node.provenance, ...sources], (work) =>
                      budget.charge(work),
                    ),
            },
      );
    }
    const terminator = block.terminator;
    const { aliased, sources } = rewrite(terminatorOperands(terminator), block.id);
    return {
      ...block,
      provenance:
        removed.length === 0
          ? block.provenance
          : mergeProvenanceSources([block.provenance, ...removed], (work) => budget.charge(work)),
      instructions: nodes,
      terminator: !aliased
        ? terminator
        : {
            ...mapTerminator(terminator, map, (edge) => ({
              ...edge,
              arguments: edge.arguments.map(map),
            })),
            provenance:
              sources.length === 0
                ? terminator.provenance
                : mergeProvenanceSources([terminator.provenance, ...sources], (work) =>
                    budget.charge(work),
                  ),
          },
    };
  });
  return {
    value: { ...input, blocks, register_states: mapStates(input.register_states, map, budget) },
    changed: true,
  };
}

/**
 * A non-root block parameter whose incoming edge values are one value v or the
 * parameter itself is v: the first entry along every path carries v from a
 * non-dominated predecessor, so v's definition dominates the block. Its
 * parameter/edge slots disappear; architectural entry bindings now name v.
 */
function eliminateTrivialParameters(
  input: SSAForm,
  budget: AnalysisBudget,
): { value: SSAForm; changed: boolean } {
  const dominance = computeDominance(input, (work) => budget.charge(work));
  const byId = new Map(input.blocks.map((block) => [block.id, block]));
  const incoming = new Map<EntityId, Value[]>();
  for (const block of input.blocks)
    if (dominance.idom(block.id) !== null)
      for (const parameter of block.parameters) {
        budget.charge();
        incoming.set(parameter.id, []);
      }
  const users = new Map<EntityId, EntityId[]>();
  for (const block of input.blocks)
    for (const edge of successors(block.terminator)) {
      const target = byId.get(edge.target);
      for (const [index, argument] of edge.arguments.entries()) {
        budget.charge();
        const parameter = target?.parameters[index];
        const sources = parameter && incoming.get(parameter.id);
        if (!sources) continue;
        sources.push(argument);
        const list = users.get(argument.id) ?? [];
        list.push(parameter.id);
        users.set(argument.id, list);
      }
    }
  const replacement = new Map<EntityId, Value>();
  const find = (value: Value): Value => {
    let current = value;
    for (let next = replacement.get(current.id); next; next = replacement.get(current.id)) {
      budget.charge();
      current = next;
    }
    return current;
  };
  const pending = [...incoming.keys()];
  while (pending.length) {
    budget.charge();
    const id = pending.pop()!;
    if (replacement.has(id)) continue;
    let unique: Value | undefined,
      trivial = true;
    for (const argument of incoming.get(id)!) {
      budget.charge();
      const value = find(argument);
      if (value.id === id || value.id === unique?.id) continue;
      if (unique) {
        trivial = false;
        break;
      }
      unique = value;
    }
    if (!trivial || !unique) continue;
    replacement.set(id, unique);
    // Parameters fed by this one may now be trivial too, including after a
    // later replacement of `unique` itself.
    const dependents = users.get(id) ?? [];
    pending.push(...dependents);
    users.set(unique.id, [...(users.get(unique.id) ?? []), ...dependents]);
  }
  if (replacement.size === 0) return { value: input, changed: false };
  const kept = new Map(
    input.blocks.map((block) => [
      block.id,
      block.parameters.map((parameter) => !replacement.has(parameter.id)),
    ]),
  );
  const edge = (value: Edge): Edge => {
    const slots = kept.get(value.target);
    budget.charge(value.arguments.length);
    return {
      ...value,
      arguments: value.arguments.filter((_, index) => slots?.[index] ?? true).map(find),
    };
  };
  const blocks = input.blocks.map((block) => {
    budget.charge(block.instructions.length + 1);
    return {
      ...block,
      parameters: block.parameters.filter((parameter) => !replacement.has(parameter.id)),
      instructions: block.instructions.map((node) => mapInstruction(node, find)),
      terminator: mapTerminator(block.terminator, find, edge),
    };
  });
  return {
    value: { ...input, blocks, register_states: mapStates(input.register_states, find, budget) },
    changed: true,
  };
}
