import { fingerprint } from '../../core/index.js';
import type { EntityId } from '../../core/index.js';
import {
  bitWidth,
  computeDominance,
  effectType,
  expressionOperands,
  mergeProvenanceSources,
  registerStateAt,
  sameType,
  successors,
} from '../../ir/index.js';
import type {
  BasicBlock,
  Dominance,
  Edge,
  Expression,
  Instruction,
  IntegerPredicate,
  RegisterBinding,
  SSAForm,
  Terminator,
  Value,
} from '../../ir/index.js';
import { instructionOperands, instructionResults, mapExpression } from '../effects/index.js';
import type { AnalysisBudget } from '../ssa/budget.js';

type Assignment = Extract<Instruction, { kind: 'assign' }>;
type Branch = Extract<Terminator, { kind: 'branch' }>;
type Jump = Extract<Terminator, { kind: 'jump' }>;
type StateRow = SSAForm['register_states'][number];

export const complements: Readonly<Record<IntegerPredicate, IntegerPredicate>> = {
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

/** Nodes copied into one joined test; larger cones keep their duplicated tests. */
const CONE_LIMIT = 32;
/** Expansions of one edge check (the term over both cones). */
const TERM_LIMIT = 256;

/** How a branch block reaches one destination: its own edge, possibly into an
 * effect-free forwarding block (`through`) whose jump reaches the destination. */
interface Route {
  readonly destination: EntityId;
  readonly edge: Edge;
  readonly through?: BasicBlock;
}
/** A branch block read with a 1-bit `not` at its root removed: it goes to
 * `when_true` exactly when `condition` holds. */
interface Test {
  readonly block: BasicBlock;
  readonly condition: Value;
  readonly when_true: Route;
  readonly when_false: Route;
}
/** One planned join: both predecessors jump to `block`, which holds the test. */
interface Join {
  readonly first: BasicBlock;
  readonly second: BasicBlock;
  readonly block: BasicBlock;
  readonly row: StateRow;
  readonly arguments: readonly [readonly Value[], readonly Value[]];
  /** Constants each predecessor materializes for its edge into the joined block. */
  readonly materialized: readonly [readonly Assignment[], readonly Assignment[]];
  /** Entered forwarding blocks, with their new parameters and state rows. */
  readonly forwarded: readonly { readonly block: BasicBlock; readonly row?: StateRow }[];
}
interface Context {
  readonly local: (block: BasicBlock) => ReadonlyMap<EntityId, Assignment>;
  readonly rows: ReadonlyMap<EntityId, StateRow>;
  readonly dominance: Dominance;
  /** Defining block of every value. */
  readonly definitions: ReadonlyMap<EntityId, EntityId>;
  /** Constant and address definitions by value: the operator with its bits. */
  readonly constants: ReadonlyMap<EntityId, Assignment>;
  readonly budget: AnalysisBudget;
}

/**
 * Two branch blocks with the same two destinations (same or complemented
 * polarity) whose conditions are equal up to leaves that differ per block become
 * one joined block (Ghidra's ConditionalJoin, blockaction.cc:2073-2099, and
 * nodeJoinCreateBlock, funcdata_block.cc:798-834). Each differing leaf pair,
 * each differing destination edge argument and each architectural cell whose
 * state differs between the two block ends becomes one parameter of the joined
 * block; both blocks jump to it. Only pure assignments of each block's own
 * condition cone are matched and copied: loads, calls and unknown effects stay
 * where they are and enter as leaves. Distinct constants are different tests,
 * except where a destination edge or cell already carries that pair (a loop's
 * initial value against its next value).
 *
 * A destination one block reaches through an effect-free forwarding block that
 * only it enters (pure assignments and a jump, e.g. a loop preheader setting
 * constants) is shared: the joined block enters the forwarding block on both
 * sides, and each jump argument or state-row value the other side holds
 * differently becomes a parameter of the forwarding block. A rotated loop's
 * guard and bottom test thus become one header test.
 *
 * Each join is checked before it is applied: the joined test, with its
 * parameters replaced by one predecessor's edge arguments, expands to that
 * predecessor's own test (or its negation for swapped destinations).
 */
export function joinDuplicateTests(
  input: SSAForm,
  budget: AnalysisBudget,
): { value: SSAForm; changed: boolean } {
  const byId = new Map(input.blocks.map((block) => [block.id, block]));
  const locals = new Map<EntityId, Map<EntityId, Assignment>>();
  const local = (block: BasicBlock): Map<EntityId, Assignment> => {
    let map = locals.get(block.id);
    if (!map) {
      map = new Map();
      for (const node of block.instructions) {
        budget.charge();
        if (node.kind === 'assign') map.set(node.result.id, node);
      }
      locals.set(block.id, map);
    }
    return map;
  };
  const entries = new Map<EntityId, number>();
  for (const block of input.blocks)
    for (const edge of successors(block.terminator)) {
      budget.charge();
      entries.set(edge.target, (entries.get(edge.target) ?? 0) + 1);
    }
  const route = (from: BasicBlock, edge: Edge): Route[] => {
    const routes: Route[] = [{ destination: edge.target, edge }];
    const through = byId.get(edge.target);
    // Only `from` enters it, so it may take parameters for the other side.
    if (
      through &&
      through.id !== from.id &&
      through.id !== input.entry &&
      entries.get(through.id) === 1 &&
      through.parameters.length === 0 &&
      through.terminator.kind === 'jump' &&
      through.terminator.edge.target !== through.id &&
      through.instructions.every((node) => node.kind === 'assign')
    )
      routes.push({ destination: through.terminator.edge.target, edge, through });
    return routes;
  };
  // Branch blocks grouped by unordered pairs of distinct destinations.
  const groups = new Map<string, Test[]>();
  for (const block of input.blocks) {
    budget.charge();
    const t = block.terminator;
    if (t.kind !== 'branch' || t.when_true.target === t.when_false.target) continue;
    const root = local(block).get(t.condition.id)?.expression;
    const negated =
      root?.kind === 'integer_unary' && root.op === 'not' && bitWidth(root.value.type) === 1;
    for (const yes of route(block, t.when_true))
      for (const no of route(block, t.when_false)) {
        if (yes.destination === no.destination) continue;
        const test: Test = negated
          ? { block, condition: root.value, when_true: no, when_false: yes }
          : { block, condition: t.condition, when_true: yes, when_false: no };
        const key =
          yes.destination < no.destination
            ? `${yes.destination}|${no.destination}`
            : `${no.destination}|${yes.destination}`;
        const group = groups.get(key);
        if (group) group.push(test);
        else groups.set(key, [test]);
      }
  }
  if (![...groups.values()].some((group) => group.length > 1))
    return { value: input, changed: false };
  const definitions = new Map<EntityId, EntityId>();
  const constants = new Map<EntityId, Assignment>();
  for (const block of input.blocks) {
    budget.charge(1 + block.parameters.length);
    for (const parameter of block.parameters) definitions.set(parameter.id, block.id);
    for (const node of block.instructions) {
      budget.charge();
      for (const value of instructionResults(node)) definitions.set(value.id, block.id);
      if (
        node.kind === 'assign' &&
        (node.expression.kind === 'constant' || node.expression.kind === 'address')
      )
        constants.set(node.result.id, node);
    }
  }
  const context: Context = {
    local,
    rows: new Map(input.register_states.map((row) => [row.block, row])),
    dominance: computeDominance(input, (work) => budget.charge(work)),
    definitions,
    constants,
    budget,
  };
  const joins: Join[] = [];
  const used = new Set<EntityId>();
  for (const group of groups.values())
    for (let i = 0; i < group.length; i++) {
      const first = group[i]!;
      if (used.has(first.block.id)) continue;
      for (let j = i + 1; j < group.length; j++) {
        const second = group[j]!;
        if (used.has(second.block.id) || second.block.id === first.block.id) continue;
        budget.charge();
        const join = plan(first, second, context);
        if (!join) continue;
        joins.push(join);
        used.add(first.block.id);
        used.add(second.block.id);
        break;
      }
    }
  if (joins.length === 0) return { value: input, changed: false };
  const byBlock = new Map<EntityId, { join: Join; index: 0 | 1 }>();
  const replaced = new Map<EntityId, BasicBlock>();
  const rows = new Map<EntityId, StateRow>();
  for (const join of joins) {
    byBlock.set(join.first.id, { join, index: 0 });
    byBlock.set(join.second.id, { join, index: 1 });
    for (const { block, row } of join.forwarded) {
      replaced.set(block.id, block);
      if (row) rows.set(block.id, row);
    }
  }
  const placed = new Set<Join>();
  const blocks: BasicBlock[] = [];
  for (const block of input.blocks) {
    budget.charge();
    const entry = byBlock.get(block.id);
    if (!entry) {
      blocks.push(replaced.get(block.id) ?? block);
      continue;
    }
    const { join, index } = entry;
    const terminator = block.terminator as Branch;
    blocks.push({
      ...block,
      instructions: [...block.instructions, ...join.materialized[index]],
      terminator: {
        kind: 'jump',
        id: terminator.id,
        provenance: terminator.provenance,
        effect: terminator.effect,
        edge: {
          target: join.block.id,
          arguments: join.arguments[index],
          effect: terminator.effect,
        },
      },
    });
    // The joined block follows the first of its two predecessors in layout order.
    if (!placed.has(join)) {
      placed.add(join);
      blocks.push(join.block);
    }
  }
  return {
    value: {
      ...input,
      blocks,
      register_states: [
        ...input.register_states.map((row) => rows.get(row.block) ?? row),
        ...joins.map((join) => join.row),
      ],
    },
    changed: true,
  };
}

const typed = (_: string, item: unknown): unknown =>
  typeof item === 'bigint'
    ? item.toString()
    : item && typeof item === 'object' && 'id' in item && 'type' in item
      ? (item as Value).type
      : item;
/** Operator, attributes and operand types of one expression; operand identities omitted. */
const shape = (expression: Expression | Value['type']): string => JSON.stringify(expression, typed);
/** A constant or address definition by its bits and type, whatever its identity. */
const fixedKey = (node: Assignment): string =>
  `${shape(node.expression)}:${shape(node.result.type)}`;

function plan(first: Test, second: Test, context: Context): Join | null {
  const { budget, constants } = context;
  const complemented = first.when_true.destination !== second.when_true.destination;
  const pairs = [
    [first.when_true, complemented ? second.when_false : second.when_true],
    [first.when_false, complemented ? second.when_true : second.when_false],
  ] as const;
  // Entering two different forwarding blocks would be two different paths.
  if (pairs.some(([x, y]) => x.through && y.through)) return null;
  const localA = context.local(first.block),
    localB = context.local(second.block);
  const id = `entity_${fingerprint(['test-join', first.block.id, second.block.id])}`;
  const fresh = (...birth: string[]): EntityId => {
    budget.charge();
    return `entity_${fingerprint(['test-join', id, ...birth])}`;
  };
  const instructions: Assignment[] = [];
  const parameters: Value[] = [];
  const incoming: [Value[], Value[]] = [[], []];
  const materialized: [Assignment[], Assignment[]] = [[], []];
  // Constants materialized for an edge are constants too.
  const created = new Map<EntityId, Assignment>();
  const constantNode = (value: Value): Assignment | undefined =>
    constants.get(value.id) ?? created.get(value.id);
  const constant = (value: Value): string | undefined => {
    const node = constantNode(value);
    return node && fixedKey(node);
  };
  const pairKey = (x: Value, y: Value): string => `${constant(x) ?? x.id}|${constant(y) ?? y.id}`;
  /** Pair key -> joined-block parameter carrying that pair. */
  const carried = new Map<string, Value>();
  /** Pairs some destination edge or architectural cell carries. */
  const needed = new Set<string>();
  /** Pairs of distinct constants the cone parameterized: valid only when `needed`. */
  const constantLeaves = new Set<string>();
  /** Pair key -> joined cone node computing that pair. */
  const copied = new Map<string, Value>();
  const parameter = (x: Value, y: Value, carrier: boolean): Value => {
    const key = pairKey(x, y);
    if (carrier) needed.add(key);
    let value = carried.get(key);
    if (!value) {
      value = { id: fresh('parameter', key), type: x.type };
      carried.set(key, value);
      parameters.push(value);
      incoming[0].push(x);
      incoming[1].push(y);
    }
    return value;
  };
  const copy = (
    nodes: readonly Assignment[],
    expression: Expression,
    key: string,
    type: Value['type'],
  ): Value => {
    const node: Assignment = {
      kind: 'assign',
      id: fresh('node', key),
      provenance: mergeProvenanceSources(
        nodes.map((item) => item.provenance),
        (work) => budget.charge(work),
      ),
      result: { id: fresh('value', key), type },
      expression,
    };
    instructions.push(node);
    copied.set(key, node.result);
    return node.result;
  };
  const failed = Symbol('failed');
  /** The joined value equal to x after `first` and to y after `second`; a
   * `complement`ed root matches y's integer comparison with its predicate negated. */
  const join = (x: Value, y: Value, root = false, complement = false): Value => {
    budget.charge();
    if (x.id === y.id && !complement) return x;
    const key = pairKey(x, y);
    const known = copied.get(key) ?? (root ? undefined : carried.get(key));
    if (known) return known;
    if (!sameType(x.type, y.type)) throw failed;
    const nx = localA.get(x.id),
      ny = localB.get(y.id);
    const cx = constant(x),
      cy = constant(y);
    if (cx !== undefined || cy !== undefined) {
      if (root || complement) throw failed;
      // Equal constants are one leaf; distinct ones need a carrying edge.
      if (cx === cy) {
        const node = constantNode(x)!;
        return copy([node], node.expression, key, x.type);
      }
      constantLeaves.add(key);
      return parameter(x, y, false);
    }
    let other = ny?.expression;
    if (complement) {
      if (other?.kind !== 'compare') throw failed;
      other = { ...other, op: complements[other.op] };
    }
    if (
      !nx ||
      !other ||
      nx.expression.kind === 'indeterminate' ||
      shape(nx.expression) !== shape(other)
    ) {
      if (root) throw failed;
      return parameter(x, y, false);
    }
    if (instructions.length >= CONE_LIMIT) throw failed;
    const right = expressionOperands(other);
    const operands = expressionOperands(nx.expression).map((operand, index) =>
      join(operand, right[index]!),
    );
    let next = 0;
    return copy(
      [nx, ny!],
      mapExpression(nx.expression, () => operands[next++]!),
      key,
      x.type,
    );
  };
  try {
    const condition = join(first.condition, second.condition, true, complemented);
    const effect = { id: fresh('effect'), type: effectType } as const;
    // One value per (first, second) pair on an edge: the cone's node for it, a
    // copy of an equal constant, or a parameter.
    const carry = (a: Value, b: Value): Value => {
      if (a.id === b.id) return a;
      const key = pairKey(a, b);
      const known = copied.get(key);
      if (known) {
        needed.add(key);
        return known;
      }
      const ca = constant(a);
      if (ca !== undefined && ca === constant(b)) {
        const node = constantNode(a)!;
        return copy([node], node.expression, key, a.type);
      }
      return parameter(a, b, true);
    };
    const forwarded: { block: BasicBlock; row?: StateRow }[] = [];
    const edge = ([x, y]: readonly [Route, Route]): Edge => {
      if (!x.through && !y.through)
        return {
          target: x.edge.target,
          arguments: x.edge.arguments.map((a, index) => carry(a, y.edge.arguments[index]!)),
          effect,
        };
      const entered = enter(
        x.through ? 0 : 1,
        (x.through ?? y.through)!,
        x.through ? y.edge : x.edge,
      );
      return { target: entered.id, arguments: entered.passed, effect };
    };
    /**
     * The joined block enters forwarding block `through` on both sides. Side
     * `side` used to enter it; the other side's `direct` edge reached its jump
     * target. Each jump argument and state-row value the other side holds
     * differently becomes a parameter of the forwarding block; a constant the
     * forwarding block computes is materialized on `side` for its edge.
     */
    const enter = (
      side: 0 | 1,
      through: BasicBlock,
      direct: Edge,
    ): { id: EntityId; passed: Value[] } => {
      const own = context.local(through);
      const otherBlock = side === 0 ? second.block : first.block;
      // What the forwarding block still computes must be available on the other side.
      for (const node of through.instructions)
        for (const operand of instructionOperands(node)) {
          budget.charge();
          const home = context.definitions.get(operand.id);
          if (
            !own.has(operand.id) &&
            (home === undefined || !context.dominance.dominates(home, otherBlock.id))
          )
            throw failed;
        }
      const slots = new Map<string, Value>();
      const added: Value[] = [],
        passed: Value[] = [];
      const made = new Map<EntityId, Value>();
      const pass = (w: Value, v: Value): Value => {
        if (w.id === v.id) return w;
        let source = w;
        const node = own.get(w.id);
        if (node) {
          if (constant(w) === undefined) throw failed;
          source = made.get(w.id) ?? w;
          if (source === w) {
            const twin: Assignment = {
              ...node,
              id: fresh('materialize', node.id),
              result: { id: fresh('materialized', w.id), type: w.type },
            };
            materialized[side].push(twin);
            created.set(twin.result.id, twin);
            made.set(w.id, twin.result);
            source = twin.result;
          }
        }
        const key = pairKey(source, v);
        let slot = slots.get(key);
        if (!slot) {
          slot = { id: fresh('forward', through.id, key), type: w.type };
          slots.set(key, slot);
          added.push(slot);
          passed.push(side === 0 ? carry(source, v) : carry(v, source));
        }
        return slot;
      };
      const jump = through.terminator as Jump;
      const outgoing = jump.edge.arguments.map((w, index) => pass(w, direct.arguments[index]!));
      const accessor = stateAccessor(context);
      const rebind = (binding: RegisterBinding): RegisterBinding => {
        const state = registerStateAt(accessor, otherBlock.id, binding.register, 'exit', (work) =>
          budget.charge(work),
        );
        if (!state) throw failed;
        return { ...binding, value: pass(binding.value, state.value) };
      };
      const row = context.rows.get(through.id);
      forwarded.push({
        block: {
          ...through,
          parameters: added,
          terminator: { ...jump, edge: { ...jump.edge, arguments: outgoing } },
        },
        ...(row
          ? { row: { block: row.block, entry: row.entry.map(rebind), exit: row.exit.map(rebind) } }
          : {}),
      });
      return { id: through.id, passed };
    };
    const whenTrue = edge(pairs[0]),
      whenFalse = edge(pairs[1]);
    // Architectural state at the joined block's entry: cells that either
    // predecessor's dominator chain rebinds below their nearest common dominator.
    const entry = joinedState(first.block, second.block, context, (x, y) => parameter(x, y, true));
    if (!entry) return null;
    // Distinct constants are one test only where an edge or cell carries that pair.
    for (const key of constantLeaves) if (!needed.has(key)) return null;
    const provenance = mergeProvenanceSources(
      [first.block.terminator.provenance, second.block.terminator.provenance],
      (work) => budget.charge(work),
    );
    const block: BasicBlock = {
      id,
      provenance,
      parameters,
      effect_parameter: effect,
      instructions,
      terminator: {
        kind: 'branch',
        id: fresh('branch'),
        provenance,
        effect,
        condition,
        when_true: whenTrue,
        when_false: whenFalse,
      },
    };
    // Forwarding block -> the destination its jump reaches.
    const destinations = new Map<EntityId, EntityId>();
    for (const route of pairs.flat())
      if (route.through) destinations.set(route.through.id, route.destination);
    if (
      !sameTest(block, incoming[0], first.block, destinations, constant, context) ||
      !sameTest(block, incoming[1], second.block, destinations, constant, context)
    )
      return null;
    return {
      first: first.block,
      second: second.block,
      block,
      row: { block: id, entry, exit: [] },
      arguments: incoming,
      materialized,
      forwarded,
    };
  } catch (error) {
    if (error === failed) return null;
    throw error;
  }
}

function stateAccessor(context: Context): Parameters<typeof registerStateAt>[0] {
  return {
    idom: (block) => context.dominance.idom(block),
    entry: (block) => context.rows.get(block)?.entry ?? [],
    exit: (block) => context.rows.get(block)?.exit ?? [],
  };
}

/** Entry bindings of the joined block, or null when a cell's state is not derivable. */
function joinedState(
  first: BasicBlock,
  second: BasicBlock,
  context: Context,
  parameter: (x: Value, y: Value) => Value,
): RegisterBinding[] | null {
  const { budget, dominance, rows } = context;
  const ancestors = new Set<EntityId>();
  for (let block: EntityId | null = first.id; block !== null; block = dominance.idom(block)) {
    budget.charge();
    ancestors.add(block);
  }
  let common: EntityId | null = second.id;
  while (common !== null && !ancestors.has(common)) {
    budget.charge();
    common = dominance.idom(common);
  }
  if (common === null) return null;
  // First binding per cell walking up from the block end, below the common dominator.
  const chain = (start: EntityId): Map<string, RegisterBinding> => {
    const found = new Map<string, RegisterBinding>();
    for (let block: EntityId | null = start; block !== null && block !== common;) {
      const row = rows.get(block);
      for (const binding of [...(row?.exit ?? []), ...(row?.entry ?? [])]) {
        budget.charge();
        const { root, offset_bits, width_bits } = binding.register;
        const key = `${root}:${offset_bits}:${width_bits}`;
        if (!found.has(key)) found.set(key, binding);
      }
      block = dominance.idom(block);
    }
    return found;
  };
  const left = chain(first.id),
    right = chain(second.id);
  const accessor = stateAccessor(context);
  const entry: RegisterBinding[] = [];
  for (const [key, binding] of [...left, ...[...right].filter(([key]) => !left.has(key))]) {
    budget.charge();
    // A cell only one side rebinds holds the common dominator's exit value on the other.
    const above =
      left.has(key) && right.has(key)
        ? undefined
        : registerStateAt(accessor, common, binding.register, 'exit', (work) =>
            budget.charge(work),
          );
    const x = left.get(key) ?? above,
      y = right.get(key) ?? above;
    if (!x || !y) return null;
    entry.push({
      register: binding.register,
      value: x.value.id === y.value.id ? x.value : parameter(x.value, y.value),
    });
  }
  return entry;
}

/**
 * Local check of one incoming edge, re-derived from the built block and the
 * predecessor's original terminator: the joined condition, with the joined
 * block's parameters replaced by this predecessor's edge arguments, expands
 * through the pure assignments of both blocks to the same term as the
 * predecessor's own condition when the joined true edge leads where the
 * original true edge led, and to its negation (1-bit `not` removed, or the
 * complemented integer predicate) when the destinations are swapped. Constants
 * expand to their bits.
 */
function sameTest(
  block: BasicBlock,
  incoming: readonly Value[],
  predecessor: BasicBlock,
  destinations: ReadonlyMap<EntityId, EntityId>,
  constant: (value: Value) => string | undefined,
  context: Context,
): boolean {
  const original = predecessor.terminator as Branch;
  const joinedTest = block.terminator as Branch;
  const own = context.local(predecessor);
  const joined = new Map(
    block.instructions.map((node) => [(node as Assignment).result.id, node as Assignment]),
  );
  const substituted = new Map(
    block.parameters.map((parameter, index) => [parameter.id, incoming[index]!]),
  );
  // Destinations past a forwarding block the joined block enters.
  const reached = (edge: Edge): EntityId => destinations.get(edge.target) ?? edge.target;
  const yes = reached(joinedTest.when_true),
    no = reached(joinedTest.when_false);
  let negate: boolean;
  if (reached(original.when_true) === yes && reached(original.when_false) === no) negate = false;
  else if (reached(original.when_true) === no && reached(original.when_false) === yes)
    negate = true;
  else return false;
  let work = 0;
  const memo = new Map<string, string>();
  const term = (value: Value, space: 'joined' | 'own', op?: IntegerPredicate): string => {
    context.budget.charge();
    if (++work > TERM_LIMIT) throw new RangeError('joined test term too large');
    const memoKey = `${space}:${value.id}:${op ?? ''}`;
    const known = memo.get(memoKey);
    if (known !== undefined) return known;
    let result: string;
    const replaced = space === 'joined' ? substituted.get(value.id) : undefined;
    const node = space === 'joined' ? joined.get(value.id) : own.get(value.id);
    const bits = constant(value);
    if (replaced) result = term(replaced, 'own');
    else if (bits !== undefined) result = bits;
    else if (!node) result = space === 'joined' ? term(value, 'own') : value.id;
    else if (node.expression.kind === 'constant' || node.expression.kind === 'address')
      result = fixedKey(node);
    else {
      const expression =
        op && node.expression.kind === 'compare' ? { ...node.expression, op } : node.expression;
      result = `${shape(expression)}(${expressionOperands(expression)
        .map((operand) => term(operand, space))
        .join(',')})`;
    }
    memo.set(memoKey, result);
    return result;
  };
  try {
    let expected: string;
    if (!negate) expected = term(original.condition, 'own');
    else {
      const root = own.get(original.condition.id)?.expression;
      if (root?.kind === 'integer_unary' && root.op === 'not' && bitWidth(root.value.type) === 1)
        expected = term(root.value, 'own');
      else if (root?.kind === 'compare')
        expected = term(original.condition, 'own', complements[root.op]);
      else return false;
    }
    return term(joinedTest.condition, 'joined') === expected;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}
