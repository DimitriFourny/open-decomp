import type { EntityId } from '../../core/index.js';
import {
  bitWidth,
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
  const incoming = new Map<EntityId, Edge[]>();
  for (const block of input.blocks) {
    budget.charge();
    for (const edge of successors(block.terminator)) {
      const list = incoming.get(edge.target) ?? [];
      list.push(edge);
      incoming.set(edge.target, list);
    }
  }
  reachable.add(input.entry);
  for (const parameter of blocks.get(input.entry)!.parameters) facts.set(parameter.id, varying);
  let changed = true;
  const update = (value: Value, fact: ValueFact | undefined): void => {
    if (!fact) return;
    const previous = facts.get(value.id);
    if (
      previous?.kind === 'varying' ||
      (previous?.kind === 'constant' && fact.kind === 'constant' && previous.bits === fact.bits)
    )
      return;
    facts.set(value.id, previous ? varying : fact);
    changed = true;
  };
  while (changed) {
    changed = false;
    for (const block of input.blocks) {
      budget.charge();
      if (!reachable.has(block.id)) continue;
      if (block.id !== input.entry)
        for (const edge of incoming.get(block.id) ?? []) {
          budget.charge();
          if (!edges.has(edge)) continue;
          block.parameters.forEach((parameter, index) => {
            budget.charge();
            update(parameter, facts.get(edge.arguments[index]!.id));
          });
        }
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
        const operands = expressionOperands(expression).map((value) => facts.get(value.id));
        if (
          operands.some((fact) => fact?.kind === 'varying') ||
          expression.kind === 'indeterminate'
        ) {
          update(node.result, varying);
          continue;
        }
        if (operands.some((fact) => !fact)) continue;
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
        if (!edges.has(edge)) {
          edges.add(edge);
          reachable.add(edge.target);
          changed = true;
        }
      }
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
 * or signature inference occurs. On interruption the last complete graph is returned.
 */
export function simplifySSA(
  input: SSAForm,
  options: AnalysisOptions = {},
): AnalysisResult<SSAForm> {
  const budget = new AnalysisBudget(options);
  let current = input;
  try {
    let changed = true;
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
      changed = rewritten.changed || copies.changed;
      current = copies.value;
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
  const blocks: BasicBlock[] = [];
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
    const live = new Set(
      [
        ...terminatorOperands(terminator),
        ...(states.get(block.id)?.exit ?? []).map((binding) => binding.value),
      ].map((value) => value.id),
    );
    const kept: Instruction[] = [];
    let provenance = block.provenance;
    for (let i = nodes.length - 1; i >= 0; i--) {
      budget.charge();
      const node = nodes[i]!;
      if (node.kind === 'assign' && !live.has(node.result.id)) {
        changed = true;
        provenance = mergeProvenanceSources([provenance, node.provenance], (work) =>
          budget.charge(work),
        );
        continue;
      }
      kept.push(node);
      for (const value of instructionOperands(node)) live.add(value.id);
    }
    kept.reverse();
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
        if (!target || target.instructions.length !== 0 || target.id === input.entry) break;
        const substitution = new Map(
          target.parameters.map((parameter, index) => [parameter.id, edge.arguments[index]!]),
        );
        const term = target.terminator;
        let next: Edge;
        if (term.kind === 'jump') next = term.edge;
        else if (term.kind === 'branch') {
          const condition = substitution.get(term.condition.id);
          if (!condition) break;
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
          arguments: next.arguments.map((value) => substitution.get(value.id)!),
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

function propagateCopies(
  input: SSAForm,
  budget: AnalysisBudget,
): { value: SSAForm; changed: boolean } {
  let changed = false;
  const states = new Map(input.register_states.map((state) => [state.block, state]));
  const blocks = input.blocks.map((block) => {
    const aliases = new Map<EntityId, Value>();
    const origins = new Map<EntityId, Assignment['provenance']>();
    const map = (value: Value): Value => aliases.get(value.id) ?? value;
    const nodes: Instruction[] = [];
    let provenance = block.provenance;
    for (const original of block.instructions) {
      budget.charge();
      let node = original;
      const operands = instructionOperands(node);
      if (operands.some((value) => aliases.has(value.id))) {
        const source = mergeProvenanceSources(
          [
            node.provenance,
            ...operands.flatMap((value) => {
              const origin = origins.get(value.id);
              return origin ? [origin] : [];
            }),
          ],
          (work) => budget.charge(work),
        );
        switch (node.kind) {
          case 'assign':
            node = { ...node, provenance: source, expression: mapExpression(node.expression, map) };
            break;
          case 'load':
            node = {
              ...node,
              provenance: source,
              address: map(node.address),
              register_inputs: node.register_inputs.map((binding) => ({
                ...binding,
                value: map(binding.value),
              })),
            };
            break;
          case 'store':
            node = {
              ...node,
              provenance: source,
              address: map(node.address),
              value: map(node.value),
              register_inputs: node.register_inputs.map((binding) => ({
                ...binding,
                value: map(binding.value),
              })),
            };
            break;
          case 'write_register':
            node = { ...node, provenance: source, value: map(node.value) };
            break;
          case 'call':
            node = {
              ...node,
              provenance: source,
              target:
                node.target.kind === 'indirect'
                  ? { ...node.target, value: map(node.target.value) }
                  : node.target,
              arguments: node.arguments.map(map),
              register_inputs: node.register_inputs.map((binding) => ({
                ...binding,
                value: map(binding.value),
              })),
            };
            break;
          case 'unknown_effect':
            node = {
              ...node,
              provenance: source,
              register_inputs: node.register_inputs.map((binding) => ({
                ...binding,
                value: map(binding.value),
              })),
            };
            break;
        }
      }
      if (
        node.kind === 'assign' &&
        node.expression.kind === 'cast' &&
        node.expression.op === 'bitcast' &&
        sameType(node.result.type, node.expression.value.type)
      ) {
        aliases.set(node.result.id, node.expression.value);
        origins.set(node.result.id, node.provenance);
        provenance = mergeProvenanceSources([provenance, node.provenance], (work) =>
          budget.charge(work),
        );
        changed = true;
      } else nodes.push(node);
    }
    const edge = (value: Edge): Edge => ({ ...value, arguments: value.arguments.map(map) });
    let terminator = block.terminator;
    const source = mergeProvenanceSources(
      [
        terminator.provenance,
        ...terminatorOperands(terminator).flatMap((value) => {
          const origin = origins.get(value.id);
          return origin ? [origin] : [];
        }),
      ],
      (work) => budget.charge(work),
    );
    switch (terminator.kind) {
      case 'return':
        terminator = { ...terminator, values: terminator.values.map(map) };
        break;
      case 'indirect':
        terminator = { ...terminator, target: map(terminator.target) };
        break;
      case 'jump':
        terminator = { ...terminator, edge: edge(terminator.edge) };
        break;
      case 'branch':
        terminator = {
          ...terminator,
          condition: map(terminator.condition),
          when_true: edge(terminator.when_true),
          when_false: edge(terminator.when_false),
        };
        break;
      case 'switch':
        terminator = {
          ...terminator,
          value: map(terminator.value),
          cases: terminator.cases.map((item) => ({ ...item, edge: edge(item.edge) })),
          otherwise: edge(terminator.otherwise),
        };
        break;
    }
    const state = states.get(block.id);
    if (state)
      states.set(block.id, {
        ...state,
        exit: state.exit.map((binding) => ({ ...binding, value: map(binding.value) })),
      });
    return {
      ...block,
      provenance,
      instructions: nodes,
      terminator: { ...terminator, provenance: source },
    };
  });
  return { value: { ...input, blocks, register_states: [...states.values()] }, changed };
}
